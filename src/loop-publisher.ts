/**
 * Kernel loops rail publisher (#46, kernel side: ima-jin/imajin-ai#2295 / PR #2302).
 *
 * Signs and POSTs `loop.started | loop.progress | loop.blocked | loop.finished`
 * envelopes to the kernel's `POST /api/loops` ingest. The kernel never calls
 * into the gateway: this plugin is the translator, and the kernel's knowledge
 * of a loop is exactly the events published here — lifecycle metadata only
 * (ids, kind, state, a short redacted summary). No transcript content.
 *
 * ## Wire contract (copied exactly from the kernel, do not extend)
 *
 *   POST {nodeUrl}/api/loops
 *   { type, payload, publisherDid, signature: { keyId, alg: "ed25519", sig } }
 *
 *   payload = { loopId, kind, principal, parentLoopId, refs, state, summary, at }
 *   refs    = { issue?, pr?, runId?, sessionKey? }   (any other key => 400)
 *   sig     = Ed25519 over canonicalize({ type, payload })  (hex)
 *   keyId   = hex Ed25519 public key currently registered for publisherDid
 *
 * The kernel verifies the signature over the payload it *parsed*, which always
 * carries `parentLoopId` (null when absent) and `refs`. We therefore always
 * send both explicitly (`parentLoopId: null`, `refs: {}`) so the bytes we sign
 * are the bytes the kernel reconstructs. `canonicalize` renders a missing key
 * as nothing but an `undefined` value as the string `undefined`, so omitting
 * `refs` would make every refs-less event fail verification.
 *
 * ## Authorization
 * The kernel accepts a publisher DID that is the principal itself, or one
 * holding an active `loops:publish` delegation grant from the principal
 * (imajin-ai#2358). When `actAs` names a principal other than the agent DID,
 * that grant is an operator step.
 *
 * ## Failure posture
 * Publishing is fire-and-forget and strictly serial (so `loop.started` always
 * reaches the kernel before `loop.finished`). A failed POST is logged
 * (rate-limited, no payload) and dropped: never retried, never thrown, never
 * awaited by a hook.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalize } from "./approval-bridge.js";

export const LOOP_LIFECYCLE_TYPES = [
  "loop.started",
  "loop.progress",
  "loop.blocked",
  "loop.finished",
] as const;
export type LoopLifecycleType = (typeof LOOP_LIFECYCLE_TYPES)[number];

/** Loop kinds this plugin publishes (open vocabulary on the kernel side). */
export type LoopKind =
  | "openclaw.session"
  | "openclaw.subagent"
  | "openclaw.automation"
  | "openclaw.keeper";

/** The only ref keys the kernel accepts. */
export interface LoopRefs {
  issue?: string;
  pr?: string;
  runId?: string;
  sessionKey?: string;
}

/** A transition before the sender stamps principal + timestamp onto it. */
export interface LoopTransition {
  type: LoopLifecycleType;
  loopId: string;
  kind: LoopKind;
  parentLoopId: string | null;
  refs: LoopRefs;
  state: string;
  summary: string;
}

export interface LoopEnvelope {
  loopId: string;
  kind: string;
  principal: string;
  parentLoopId: string | null;
  refs: LoopRefs;
  state: string;
  summary: string;
  at: string;
}

export interface LoopIngestRequest {
  type: LoopLifecycleType;
  payload: LoopEnvelope;
  publisherDid: string;
  signature: { keyId: string; alg: "ed25519"; sig: string };
}

export const LOOPS_INGEST_PATH = "/api/loops";
/** The kernel rejects summaries over 2000 chars; we stay far below that. */
export const MAX_SUMMARY_LENGTH = 240;
const MAX_REF_LENGTH = 512;
const MAX_QUEUE_LENGTH = 256;
const POST_TIMEOUT_MS = 10_000;
const FAILURE_LOG_INTERVAL_MS = 60_000;

// --- Ids ---

/**
 * Deterministic loop id: `<kind>:<sha256(publisherDid, kind, ...parts)[0..32]>`.
 * Derived from the OpenClaw identifiers (sessionKey / sessionId / runId / job
 * id) but never equal to them — a session key is a gateway concept, not a
 * kernel one; it only appears in `refs.sessionKey`. The publisher DID is part
 * of the hash so two gateways that reuse a key (`agent:main:main`) cannot
 * collide on one kernel.
 */
export function deriveLoopId(publisherDid: string, kind: LoopKind, ...parts: string[]): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([publisherDid, kind, ...parts]));
  return `${kind}:${hash.digest("hex").slice(0, 32)}`;
}

// --- Redaction / size caps ---

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b(?:sk|pk|xox[a-z]|gh[pousr]|glpat|AKIA)[-_A-Za-z0-9]{12,}/g, "[redacted]"],
  [
    /\b((?:api[_-]?key|secret|token|password|passwd|authorization|private[_-]?key)\s*[=:]\s*)\S+/gi,
    "$1[redacted]",
  ],
  [/\b[A-Fa-f0-9]{40,}\b/g, "[redacted]"],
  [/\b[A-Za-z0-9+/_-]{48,}={0,2}/g, "[redacted]"],
];

/**
 * Redacts secret-shaped substrings, collapses whitespace, and caps length.
 * Always returns a non-empty string (the kernel rejects an empty summary).
 */
export function sanitizeSummary(text: string, fallback = "loop transition"): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replaceAll(/\s+/g, " ").trim();
  if (out.length > MAX_SUMMARY_LENGTH) {
    out = `${out.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
  }
  return out.length > 0 ? out : fallback;
}

/** Caps and drops empty refs so the kernel's non-empty-string rule always holds. */
export function sanitizeRefs(refs: LoopRefs): LoopRefs {
  const out: LoopRefs = {};
  for (const key of ["issue", "pr", "runId", "sessionKey"] as const) {
    const value = refs[key];
    if (typeof value === "string" && value.length > 0) {
      out[key] = value.slice(0, MAX_REF_LENGTH);
    }
  }
  return out;
}

// --- Signing ---

interface SigningKey {
  privateKeyHex: string;
  publicKeyHex: string;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) {
    throw new Error("invalid hex string");
  }
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadEd25519() {
  const ed = await import("@noble/ed25519");
  const { sha512 } = await import("@noble/hashes/sha2.js");
  if ("hashes" in ed && ed.hashes) {
    (ed.hashes as { sha512?: typeof sha512 }).sha512 = sha512;
  } else {
    try {
      ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed.etc.concatBytes(...messages));
    } catch {
      // A host may have configured the hash implementation already.
    }
  }
  return ed;
}

/**
 * Loads the agent keypair and derives the public key from the private key, so
 * `signature.keyId` can never drift from the key that actually signs.
 */
async function loadSigningKey(keypairPath: string): Promise<SigningKey> {
  const raw = await readFile(keypairPath, "utf-8");
  const parsed = JSON.parse(raw) as { privateKey?: string; keypair?: { privateKey?: string } };
  const privateKeyHex = parsed.privateKey || parsed.keypair?.privateKey || "";
  if (!privateKeyHex) {
    throw new Error("keypair file has no private key");
  }
  const ed = await loadEd25519();
  const publicKeyHex = bytesToHex(await ed.getPublicKeyAsync(hexToBytes(privateKeyHex)));
  return { privateKeyHex, publicKeyHex };
}

/** Builds the signed ingest request for one envelope. */
export async function signLoopEvent(
  type: LoopLifecycleType,
  payload: LoopEnvelope,
  publisherDid: string,
  key: SigningKey,
): Promise<LoopIngestRequest> {
  const ed = await loadEd25519();
  const bytes = new TextEncoder().encode(canonicalize({ type, payload }));
  const sig = bytesToHex(await ed.signAsync(bytes, hexToBytes(key.privateKeyHex)));
  return {
    type,
    payload,
    publisherDid,
    signature: { keyId: key.publicKeyHex.toLowerCase(), alg: "ed25519", sig },
  };
}

// --- Sender ---

export interface LoopSenderLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface LoopSenderOptions {
  nodeUrl: string;
  /** Agent DID that signs (the publisherDid). */
  did: string;
  /** Principal the loops belong to (onBehalfOf). Defaults to `did`. */
  principal?: string;
  keypairPath: string;
  logger?: LoopSenderLogger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface LoopSender {
  /** Enqueues a transition. Never throws, never blocks, never rejects. */
  publish(transition: LoopTransition): void;
  /** Resolves when everything queued so far has settled (tests / shutdown). */
  idle(): Promise<void>;
}

export function createLoopSender(options: LoopSenderOptions): LoopSender {
  const log: LoopSenderLogger = options.logger ?? {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
  };
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const principal = options.principal ?? options.did;
  const url = `${options.nodeUrl.replace(/\/$/, "")}${LOOPS_INGEST_PATH}`;

  let key: Promise<SigningKey> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  let lastFailureLogAt = 0;

  const logFailure = (reason: string): void => {
    const at = now();
    if (at - lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return;
    lastFailureLogAt = at;
    log.warn(`[imajin-loops] publish dropped: ${reason}`);
  };

  const getKey = (): Promise<SigningKey> => {
    key ??= loadSigningKey(options.keypairPath).catch((err: unknown) => {
      key = undefined; // let a later transition retry once the keypair is readable
      throw err;
    });
    return key;
  };

  const send = async (transition: LoopTransition, at: string): Promise<void> => {
    try {
      const payload: LoopEnvelope = {
        loopId: transition.loopId,
        kind: transition.kind,
        principal,
        parentLoopId: transition.parentLoopId,
        refs: sanitizeRefs(transition.refs),
        state: transition.state,
        summary: sanitizeSummary(transition.summary),
        at,
      };
      const request = await signLoopEvent(transition.type, payload, options.did, await getKey());
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (!res.ok) {
        logFailure(`${transition.type} rejected by kernel (HTTP ${res.status})`);
      }
    } catch (err: unknown) {
      logFailure(`${transition.type} failed (${err instanceof Error ? err.name : "error"})`);
    }
  };

  return {
    publish(transition: LoopTransition): void {
      try {
        if (pending >= MAX_QUEUE_LENGTH) {
          logFailure("queue full");
          return;
        }
        pending += 1;
        const at = new Date(now()).toISOString();
        chain = chain.then(() => send(transition, at)).finally(() => {
          pending -= 1;
        });
      } catch {
        // publish() must never throw into a hook.
      }
    },
    idle: () => chain,
  };
}
