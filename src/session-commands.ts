/**
 * Session command executor (#51).
 *
 * Consumes signed, DID-addressed session commands delivered over the plugin's
 * EXISTING outbound kernel WebSocket (the per-principal agent endpoint,
 * ima-jin/imajin-ai#2251), executes them against the local OpenClaw gateway,
 * and attests every outcome — success AND rejection — back to the kernel as a
 * signed `loop.session.<verb>.completed|failed` event.
 *
 * ## Design rulings this implements
 *   - The kernel NEVER addresses a gateway. A command is addressed (`to`) to
 *     the agent DID, which is bound to a principal via `serviceOf`
 *     (RFC-31 v2, ima-jin/imajin-ai#2407, epic #1758).
 *   - Commands ride the existing outbound WS (no new listener, no inbound port).
 *   - Every command is countersigned per the wish-and-grant chain
 *     (ima-jin/imajin-ai#2084): the principal's wish (`countersignature`) and
 *     the kernel's grant (`signature`) both cover the same canonical body.
 *   - Generalizes the #2321 approval-echo path to sessions.
 *
 * ## Wire contract (command frame)
 * The kernel-side router (#2251) does not yet publish a typed schema for these
 * frames, so this is the plugin-side contract; `docs/session-commands.md`
 * documents it for the kernel half.
 *
 *   {
 *     type: "session.send" | "session.approve" | "session.deny" | "session.abort" | "session.spawn",
 *     commandId, to (agent DID), principal (DID the agent serves), issuer (kernel DID),
 *     issuedAt (ISO), expiresAt? (ISO; default issuedAt + 5 min), payload,
 *     signature:        { keyId, alg: "ed25519", sig },   // kernel grant
 *     countersignature: { keyId, alg: "ed25519", sig }    // principal wish
 *   }
 *   sig = Ed25519 over canonicalize({ type, commandId, to, principal, issuer, issuedAt, expiresAt|null, payload })
 *
 * ## Verification order (nothing executes until ALL pass)
 *   shape -> signature present -> addressed to this agent -> issuer + pinned
 *   kernel key -> signature valid -> time window -> replay -> principal is
 *   served by this agent (`serviceOf`, re-read per command, fail closed) ->
 *   principal countersignature -> payload shape -> gateway execution.
 * Rejection is never silent: each failure produces a signed `…failed`
 * attestation naming a machine-readable `reason`. The attestation carries a
 * `payloadHash` (sha256 of the canonical payload), never the payload itself —
 * message text and task bodies are not echoed back to the kernel.
 *
 * No top-level `openclaw` imports: unit-testable with plain fakes.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalize, signMessage, type SignedMessage } from "./approval-bridge.js";
import { sanitizeSummary } from "./loop-publisher.js";
import { parseOperatorSignature, type OperatorCountersignature } from "./operator-signature.js";
import type { SessionGateway, SessionApprovalKind } from "./session-command-gateway.js";

export const SESSION_COMMAND_TYPES = [
  "session.send",
  "session.approve",
  "session.deny",
  "session.abort",
  "session.spawn",
] as const;
export type SessionCommandType = (typeof SESSION_COMMAND_TYPES)[number];

const VERBS = {
  "session.send": "send",
  "session.approve": "approve",
  "session.deny": "deny",
  "session.abort": "abort",
  "session.spawn": "spawn",
} as const satisfies Record<SessionCommandType, string>;

export type SessionCommandEventType =
  `loop.session.${(typeof VERBS)[SessionCommandType]}.${"completed" | "failed"}`;

export type SessionCommandRejectionReason =
  | "malformed"
  | "unsigned"
  | "misaddressed"
  | "issuer_mismatch"
  | "invalid_signature"
  | "expired"
  | "not_yet_valid"
  | "replayed"
  | "principal_mismatch"
  | "not_service_of"
  | "service_binding_unverifiable"
  | "missing_countersignature"
  | "invalid_countersignature"
  | "invalid_payload";

export type SessionCommandFailureReason =
  | SessionCommandRejectionReason
  | "gateway_error"
  | "approval_not_found"
  | "nothing_to_abort";

export const DEFAULT_COMMAND_TTL_MS = 5 * 60_000;
export const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_SEEN_COMMANDS = 1024;
const MAX_FIELD_LENGTH = 256;
const MAX_TEXT_LENGTH = 64 * 1024;

export interface SessionCommandFrame {
  type: SessionCommandType;
  commandId: string;
  to: string;
  principal: string;
  issuer: string;
  issuedAt: string;
  expiresAt?: string | null;
  payload: unknown;
  signature?: unknown;
  countersignature?: unknown;
  [key: string]: unknown;
}

/** The exact fields both signatures cover. */
export interface SessionCommandBody {
  type: SessionCommandType;
  commandId: string;
  to: string;
  principal: string;
  issuer: string;
  issuedAt: string;
  expiresAt: string | null;
  payload: unknown;
}

export function isSessionCommandFrame(frame: unknown): frame is { type: SessionCommandType; [k: string]: unknown } {
  return (
    !!frame &&
    typeof frame === "object" &&
    (SESSION_COMMAND_TYPES as readonly string[]).includes((frame as { type?: unknown }).type as string)
  );
}

export function buildSessionCommandBody(frame: SessionCommandFrame): SessionCommandBody {
  return {
    type: frame.type,
    commandId: frame.commandId,
    to: frame.to,
    principal: frame.principal,
    issuer: frame.issuer,
    issuedAt: frame.issuedAt,
    expiresAt: frame.expiresAt ?? null,
    payload: frame.payload,
  };
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalize(payload ?? null)).digest("hex");
}

// --- Ed25519 helpers ---

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error("invalid hex string");
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
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

/** Signs a command body (kernel grant / principal wish). Exported for tests and the kernel-side router's reference. */
export async function signSessionCommandBody(
  body: SessionCommandBody,
  privateKeyHex: string,
): Promise<OperatorCountersignature> {
  const ed = await loadEd25519();
  const sig = bytesToHex(
    await ed.signAsync(new TextEncoder().encode(canonicalize(body)), hexToBytes(privateKeyHex)),
  );
  const keyId = bytesToHex(await ed.getPublicKeyAsync(hexToBytes(privateKeyHex)));
  return { keyId, alg: "ed25519", sig };
}

/** True only when `signature` is well-formed, names exactly `expectedPublicKeyHex`, and verifies over `body`. */
async function verifyBodySignature(
  body: SessionCommandBody,
  signature: OperatorCountersignature,
  expectedPublicKeyHex: string,
): Promise<boolean> {
  if (signature.keyId.toLowerCase() !== expectedPublicKeyHex.toLowerCase()) return false;
  try {
    const ed = await loadEd25519();
    return await ed.verifyAsync(
      hexToBytes(signature.sig),
      new TextEncoder().encode(canonicalize(body)),
      hexToBytes(expectedPublicKeyHex),
    );
  } catch {
    return false;
  }
}

// --- Attestation ---

export interface SessionCommandAttestationPayload {
  eventType: SessionCommandEventType;
  commandId: string;
  command: SessionCommandType;
  outcome: "completed" | "failed";
  principal: string;
  issuer: string;
  payloadHash: string;
  at: string;
  reason?: SessionCommandFailureReason;
  detail?: string;
  sessionKey?: string;
  runId?: string;
  approvalId?: string;
  approvalKind?: SessionApprovalKind;
  [key: string]: unknown;
}

export type SessionCommandAttester = (
  eventType: SessionCommandEventType,
  payload: SessionCommandAttestationPayload,
) => Promise<void>;

/**
 * Builds the attester: signs each attestation with the agent's key
 * (`signMessage`, the same signed-envelope the approval frames use) and sends
 * it as a frame whose `type` IS the `loop.session.*` event type, over the
 * existing WS. The kernel's HTTP loops ingest only accepts the four
 * `loop.started|progress|blocked|finished` lifecycle types, so these typed
 * events travel on the socket instead.
 */
export function createSessionCommandAttester(opts: {
  did: string;
  keypairPath: string;
  send: (frame: unknown) => void;
}): SessionCommandAttester {
  let key: Promise<string> | undefined;
  const loadKey = (): Promise<string> => {
    key ??= readFile(opts.keypairPath, "utf-8")
      .then((raw) => {
        const parsed = JSON.parse(raw) as { privateKey?: string; keypair?: { privateKey?: string } };
        const privateKeyHex = parsed.privateKey || parsed.keypair?.privateKey || "";
        if (!privateKeyHex) throw new Error("keypair file has no private key");
        return privateKeyHex;
      })
      .catch((err: unknown) => {
        key = undefined;
        throw err;
      });
    return key;
  };

  return async (eventType, payload) => {
    const attestation: SignedMessage<SessionCommandAttestationPayload> = await signMessage(payload, {
      did: opts.did,
      type: "agent",
      privateKeyHex: await loadKey(),
    });
    opts.send({ type: eventType, attestation });
  };
}

// --- Executor ---

export interface SessionCommandLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface SessionCommandExecutorConfig {
  /** This agent's DID — commands must be addressed to exactly this. */
  agentDid: string;
  /** Pinned Ed25519 public key (hex) of the kernel's command-signing key. The only trusted grant signer. */
  kernelPublicKeyHex: string;
  /** When set, `issuer` must equal this DID. */
  kernelDid?: string;
  /** When set (the plugin's `actAs`), `principal` must equal this DID in addition to being in `serviceOf`. */
  allowedPrincipal?: string;
  /** Default true. false skips the principal countersignature (the kernel grant is still always required). */
  requirePrincipalCountersignature?: boolean;
}

export interface SessionCommandExecutorDeps {
  gateway: SessionGateway;
  attest: SessionCommandAttester;
  /** `serviceOf` for the agent DID; `null` = unverifiable (fail closed). */
  resolveServiceOf: (agentDid: string) => Promise<string[] | null>;
  /** Principal DID -> currently registered Ed25519 public key (hex), or null. */
  resolvePublicKey: (did: string) => Promise<string | null>;
  logger?: SessionCommandLogger;
  now?: () => number;
}

export type SessionCommandOutcome =
  | { ok: true; eventType: SessionCommandEventType }
  | { ok: false; eventType: SessionCommandEventType; reason: SessionCommandFailureReason };

class Rejection extends Error {
  constructor(
    readonly reason: SessionCommandFailureReason,
    readonly detail?: string,
  ) {
    super(reason);
  }
}

function cap(value: unknown, max = MAX_FIELD_LENGTH): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function nonEmpty(value: unknown, max = MAX_FIELD_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function optional(value: unknown, max = MAX_FIELD_LENGTH): boolean {
  return value === undefined || nonEmpty(value, max);
}

function invalid(detail: string): never {
  throw new Rejection("invalid_payload", detail);
}

interface ExecutionResult {
  sessionKey?: string;
  runId?: string;
  approvalId?: string;
  approvalKind?: SessionApprovalKind;
}

export interface SessionCommandExecutor {
  /** Never throws. Always attests exactly once per frame. */
  handleFrame(frame: { type: SessionCommandType; [k: string]: unknown }): Promise<SessionCommandOutcome>;
}

export function createSessionCommandExecutor(
  config: SessionCommandExecutorConfig,
  deps: SessionCommandExecutorDeps,
): SessionCommandExecutor {
  const log: SessionCommandLogger = deps.logger ?? {
    info: (m) => console.log(`[imajin-session-commands] ${m}`),
    warn: (m) => console.warn(`[imajin-session-commands] ${m}`),
    error: (m) => console.error(`[imajin-session-commands] ${m}`),
  };
  const now = deps.now ?? Date.now;
  const requireCountersignature = config.requirePrincipalCountersignature !== false;
  const seen = new Map<string, number>();

  const remember = (commandId: string): void => {
    seen.set(commandId, now());
    if (seen.size > MAX_SEEN_COMMANDS) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
  };

  /** Everything up to (not including) execution. Throws {@link Rejection}. */
  async function verify(frame: Record<string, unknown>): Promise<SessionCommandFrame> {
    const f = frame as Partial<SessionCommandFrame>;
    if (
      !nonEmpty(f.commandId) ||
      !nonEmpty(f.to) ||
      !nonEmpty(f.principal) ||
      !nonEmpty(f.issuer) ||
      !nonEmpty(f.issuedAt) ||
      !(f.expiresAt === undefined || f.expiresAt === null || nonEmpty(f.expiresAt)) ||
      !("payload" in f)
    ) {
      throw new Rejection("malformed", "missing or oversized command envelope field");
    }
    const issuedAtMs = Date.parse(f.issuedAt);
    const expiresAtMs = f.expiresAt ? Date.parse(f.expiresAt) : issuedAtMs + DEFAULT_COMMAND_TTL_MS;
    if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
      throw new Rejection("malformed", "issuedAt/expiresAt are not valid timestamps");
    }

    // Unsigned frames never get as far as signature math.
    if (f.signature === undefined || f.signature === null) throw new Rejection("unsigned");
    const parsedSignature = parseOperatorSignature(f.signature);
    if (!parsedSignature.ok || !parsedSignature.value) {
      throw new Rejection("unsigned", "signature is not a well-formed ed25519 signature");
    }

    if (f.to !== config.agentDid) throw new Rejection("misaddressed", "command is not addressed to this agent DID");
    if (config.kernelDid && f.issuer !== config.kernelDid) {
      throw new Rejection("issuer_mismatch", "issuer is not the configured kernel DID");
    }

    const command = f as SessionCommandFrame;
    const body = buildSessionCommandBody(command);
    if (!(await verifyBodySignature(body, parsedSignature.value, config.kernelPublicKeyHex))) {
      throw new Rejection("invalid_signature", "signature does not verify against the pinned kernel key");
    }

    // Authenticated from here on; only now does the command consume replay state.
    const at = now();
    if (issuedAtMs > at + MAX_CLOCK_SKEW_MS) throw new Rejection("not_yet_valid");
    if (at >= expiresAtMs) throw new Rejection("expired");
    if (seen.has(command.commandId)) throw new Rejection("replayed");
    remember(command.commandId);

    if (config.allowedPrincipal && command.principal !== config.allowedPrincipal) {
      throw new Rejection("principal_mismatch", "principal is not the principal this agent acts for");
    }
    let serviceOf: string[] | null;
    try {
      serviceOf = await deps.resolveServiceOf(config.agentDid);
    } catch {
      serviceOf = null;
    }
    if (serviceOf === null) {
      throw new Rejection("service_binding_unverifiable", "could not resolve this agent's serviceOf binding");
    }
    if (!serviceOf.includes(command.principal)) {
      throw new Rejection("not_service_of", "principal is not in this agent's serviceOf");
    }

    if (requireCountersignature) {
      if (command.countersignature === undefined || command.countersignature === null) {
        throw new Rejection("missing_countersignature");
      }
      const parsedCounter = parseOperatorSignature(command.countersignature);
      if (!parsedCounter.ok || !parsedCounter.value) {
        throw new Rejection("invalid_countersignature", "countersignature is not well-formed");
      }
      let principalKey: string | null = null;
      try {
        principalKey = await deps.resolvePublicKey(command.principal);
      } catch {
        principalKey = null;
      }
      if (!principalKey || !(await verifyBodySignature(body, parsedCounter.value, principalKey))) {
        throw new Rejection("invalid_countersignature", "countersignature does not verify against the principal's key");
      }
    }
    return command;
  }

  async function execute(command: SessionCommandFrame): Promise<ExecutionResult> {
    const p = (command.payload && typeof command.payload === "object" ? command.payload : {}) as Record<string, unknown>;
    switch (command.type) {
      case "session.send": {
        if (!nonEmpty(p.sessionKey, 512)) invalid("sessionKey is required");
        if (!nonEmpty(p.message, MAX_TEXT_LENGTH)) invalid("message is required");
        if (!optional(p.agentId)) invalid("agentId must be a short string");
        const { runId } = await deps.gateway.send({
          sessionKey: p.sessionKey,
          message: p.message,
          agentId: p.agentId as string | undefined,
          idempotencyKey: command.commandId,
        });
        return { sessionKey: p.sessionKey, runId };
      }
      case "session.approve":
      case "session.deny": {
        if (!nonEmpty(p.approvalId)) invalid("approvalId is required");
        if (p.kind !== undefined && p.kind !== "exec" && p.kind !== "plugin") invalid("kind must be exec or plugin");
        const result = await deps.gateway.resolveApproval({
          id: p.approvalId,
          kind: p.kind as SessionApprovalKind | undefined,
          decision: command.type === "session.approve" ? "allow-once" : "deny",
        });
        if (!result.applied) {
          throw new Rejection("approval_not_found", "no pending approval with that id was resolved");
        }
        return { approvalId: p.approvalId, approvalKind: result.kind };
      }
      case "session.abort": {
        if (!nonEmpty(p.sessionKey, 512)) invalid("sessionKey is required");
        if (!optional(p.runId)) invalid("runId must be a short string");
        const { aborted } = await deps.gateway.abort({
          sessionKey: p.sessionKey,
          runId: p.runId as string | undefined,
        });
        if (!aborted) throw new Rejection("nothing_to_abort", "the session had no active run to abort");
        return { sessionKey: p.sessionKey, runId: p.runId as string | undefined };
      }
      case "session.spawn": {
        if (!nonEmpty(p.task, MAX_TEXT_LENGTH)) invalid("task is required");
        if (!optional(p.parentSessionKey, 512) || !optional(p.label) || !optional(p.agentId)) {
          invalid("parentSessionKey/label/agentId must be short strings");
        }
        const { sessionKey } = await deps.gateway.spawn({
          task: p.task,
          parentSessionKey: p.parentSessionKey as string | undefined,
          label: p.label as string | undefined,
          agentId: p.agentId as string | undefined,
          idempotencyKey: command.commandId,
        });
        return { sessionKey };
      }
    }
  }

  async function handleFrame(frame: { type: SessionCommandType; [k: string]: unknown }): Promise<SessionCommandOutcome> {
    const type = frame.type;
    const verb = VERBS[type];
    let result: ExecutionResult = {};
    let failure: { reason: SessionCommandFailureReason; detail?: string } | undefined;

    try {
      const command = await verify(frame);
      try {
        result = await execute(command);
      } catch (err) {
        if (err instanceof Rejection) throw err;
        throw new Rejection("gateway_error", err instanceof Error ? err.message : String(err));
      }
    } catch (err) {
      failure =
        err instanceof Rejection
          ? { reason: err.reason, detail: err.detail }
          : { reason: "gateway_error", detail: err instanceof Error ? err.message : String(err) };
    }

    const eventType = `loop.session.${verb}.${failure ? "failed" : "completed"}` as SessionCommandEventType;
    const payload: SessionCommandAttestationPayload = {
      eventType,
      commandId: cap(frame.commandId) || "unknown",
      command: type,
      outcome: failure ? "failed" : "completed",
      principal: cap(frame.principal),
      issuer: cap(frame.issuer),
      payloadHash: hashPayload(frame.payload),
      at: new Date(now()).toISOString(),
      ...(failure
        ? {
            reason: failure.reason,
            ...(failure.detail ? { detail: sanitizeSummary(failure.detail, failure.reason) } : {}),
          }
        : {}),
      ...result,
    };

    try {
      await deps.attest(eventType, payload);
    } catch (err) {
      // Nothing more can be done for the kernel, but the outcome is never silent locally.
      log.error(`could not attest ${eventType} for ${payload.commandId}: ${String(err)}`);
    }
    if (failure) {
      log.warn(`${type} ${payload.commandId} failed: ${failure.reason}`);
      return { ok: false, eventType, reason: failure.reason };
    }
    log.info(`${type} ${payload.commandId} completed`);
    return { ok: true, eventType };
  }

  return { handleFrame };
}
