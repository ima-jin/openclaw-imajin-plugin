/**
 * Gateway approvals bridge (#24, plugin half of ima-jin/imajin-ai#2059).
 *
 * When the OpenClaw system-agent stages a proposal (gateway restart / config
 * mutation) awaiting operator approval, this module:
 *
 *   1. Observes it on the plugin's OWN loopback Gateway operator connection
 *      (scoped `operator.approvals` — never anything broader), via the
 *      `openclaw.approval.requested` event and, at startup, a reconcile pass
 *      over `openclaw.approval.list` so a proposal staged while the plugin
 *      was down is not missed.
 *   2. Publishes a kernel notification `operator.approval.requested`
 *      (`POST /notify/api/send`, see `KernelNotifyClient`) signed by this
 *      agent's existing DID keypair — the same one `client.ts`/`ws-service.ts`
 *      use for challenge-response — over the canonical JSON of exactly
 *      `{proposalId, kind, summary, keysTouched, contentHash}`.
 *   3. Subscribes on the plugin's EXISTING kernel WS (`ImajinWsService`) for
 *      the resulting `operator.approval.decided` bus event, verifies it, and
 *      only then calls the Gateway's own `approval.resolve` — this bridge
 *      never bypasses the Gateway's approval store, it only relays the
 *      operator's decision to it.
 *
 * `keysTouched` is always `[]`: the Gateway's `SystemAgentApprovalRequestPayload`
 * (ima-jin/openclaw-imajin-plugin#24 investigation, `openclaw/src/infra/
 * system-agent-approvals.ts`) exposes only a human `description` string and a
 * `proposalHash` — there is no structured "touched config keys" list to
 * report. `kind` is a disclosed heuristic over `title`/`description`/`command`
 * for the same reason (see `deriveProposalKind`): the Gateway payload carries
 * no structured kind either.
 *
 * `contentHash` verification: the kernel's `operator.approval.decided` bus
 * event (`packages/bus/src/types.ts` in ima-jin/imajin-ai) carries only
 * `{proposalId, decision, decidedBy, decidedAt, reason?}` — it does NOT echo
 * back a `contentHash`. This bridge therefore verifies against its OWN
 * record of the `contentHash` it signed and published for that `proposalId`
 * (`published`, below), re-fetched against the Gateway's CURRENT
 * `approval.get` snapshot before ever calling `approval.resolve` — the same
 * tamper/replay protection the issue specifies, sourced honestly from what
 * the kernel wire contract actually carries.
 *
 * This module has NO top-level `openclaw` plugin-sdk imports, so the pure
 * `GatewayApprovalsBridge` class (and every function above it) can be unit
 * tested with plain fakes. `createLiveGatewayApprovalsClient` and
 * `createHttpKernelNotifyClient` — the only parts that need the real SDK/
 * network — are isolated at the bottom and wired up by `index.ts`.
 */
import { readFile } from "node:fs/promises";
import { canonicalize } from "./approval-bridge.js";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input-runtime";

// --- Wire types (Gateway side, `openclaw/src/infra/system-agent-approvals.ts`) ---

export type SystemAgentApprovalDecisionKind = "allow-once" | "deny";

export interface SystemAgentApprovalRequestPayload {
  title: string;
  description: string;
  command: string;
  proposalHash: string;
  allowedDecisions: readonly SystemAgentApprovalDecisionKind[];
  agentId?: string | null;
  sessionKey?: string | null;
  sessionId?: string;
  [key: string]: unknown;
}

/** One pending `openclaw.approval.list` entry / `openclaw.approval.requested` event payload. */
export interface SystemAgentApprovalRequestRecord {
  id: string;
  request: SystemAgentApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
}

export type GatewayApprovalStatus = "pending" | "allowed" | "denied" | "expired" | "cancelled";

/** The relevant projection of `approval.get`'s `ApprovalSnapshot` (gateway-protocol). */
export interface GatewayApprovalSnapshot {
  status: GatewayApprovalStatus;
  presentation?: { proposalHash?: string; [key: string]: unknown };
}

/** Abstracts the plugin's own loopback Gateway operator connection (#24). */
export interface GatewayApprovalsClient {
  /** `openclaw.approval.list` — startup reconcile for proposals staged while the plugin was down. */
  list(): Promise<SystemAgentApprovalRequestRecord[]>;
  /** `approval.get` — the CURRENT staged proposal, used for the hash-mismatch check. */
  get(id: string): Promise<GatewayApprovalSnapshot | null>;
  /** `approval.resolve` with `kind: "system-agent"`. */
  resolve(id: string, decision: SystemAgentApprovalDecisionKind): Promise<{ applied: boolean }>;
  /** Registers the live `openclaw.approval.requested` handler. */
  onRequested(handler: (record: SystemAgentApprovalRequestRecord) => void): void;
}

// --- Wire types (kernel side, `docs/notify-operator-approvals-contract.md` in ima-jin/imajin-ai) ---

export type KernelApprovalProposalKind = "restart" | "config-mutation" | "other";

/** The `operator.approval.requested` notification `data` payload this bridge publishes. */
export interface KernelApprovalRequestedPayload {
  proposalId: string;
  kind: KernelApprovalProposalKind;
  summary: string;
  keysTouched: string[];
  /** The Gateway's `proposalHash`. */
  contentHash: string;
  /** Hex Ed25519 signature over `canonicalize({proposalId, kind, summary, keysTouched, contentHash})`. */
  signature: string;
  /** The agent DID that produced `signature` — the same keypair used for challenge-response. */
  signerDid: string;
}

/** Publishes to the kernel over `POST /notify/api/send` (the plugin's DID is never needed here — auth is the webhook secret). */
export interface KernelNotifyClient {
  publishApprovalRequested(payload: KernelApprovalRequestedPayload): Promise<void>;
  /**
   * Best-effort heads-up when a decision's contentHash no longer matches the
   * staged proposal. No kernel-side handler exists for this scope today (it
   * was not part of the merged #2059/PR #2078 contract) — it reaches the
   * operator via the generic notify channels (in-app/email), not as a
   * dedicated /jin card. See README "Gateway approvals bridge" → "What was
   * deliberately left".
   */
  publishMismatch(proposalId: string, reason: string): Promise<void>;
}

/** The subset of a kernel `bus_event` WS frame (`packages/bus/src/subscriptions.ts`) this bridge needs. */
export interface KernelBusEventFrame {
  type: "bus_event";
  eventType: string;
  issuer: string;
  subject: string;
  scope: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export function isKernelBusEventFrame(frame: unknown): frame is KernelBusEventFrame {
  if (!frame || typeof frame !== "object") return false;
  const f = frame as Record<string, unknown>;
  return (
    f.type === "bus_event" &&
    typeof f.eventType === "string" &&
    typeof f.issuer === "string" &&
    typeof f.subject === "string"
  );
}

interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

function defaultLogger(): Logger {
  return {
    info: (message, ...args) => console.log(`[imajin-approvals-bridge] ${message}`, ...args),
    warn: (message, ...args) => console.warn(`[imajin-approvals-bridge] ${message}`, ...args),
    error: (message, ...args) => console.error(`[imajin-approvals-bridge] ${message}`, ...args),
  };
}

const MAX_SUMMARY_LENGTH = 2000;

/**
 * Disclosed heuristic: the Gateway's `SystemAgentApprovalRequestPayload`
 * carries no structured `kind` (only a human `title`/`description`/`command`
 * — see the #24 investigation comment and `openclaw/src/gateway/server-
 * methods/system-agent-approval.ts`, which always sets `title: "OpenClaw
 * change"`). This maps free text to the kernel's fixed `ApprovalProposalKind`
 * enum, defaulting to `"other"` when neither a restart nor a config-mutation
 * keyword is found — never guessed more specifically than that.
 */
export function deriveProposalKind(
  request: Pick<SystemAgentApprovalRequestPayload, "title" | "description" | "command">,
): KernelApprovalProposalKind {
  const text = `${request.title ?? ""} ${request.description ?? ""} ${request.command ?? ""}`.toLowerCase();
  if (/\brestart(ing|ed)?\b/.test(text)) return "restart";
  if (/\bconfig(uration)?\b|\bmutat(e|ion|ing)\b|\bset\b/.test(text)) return "config-mutation";
  return "other";
}

function truncateSummary(summary: string): string {
  return summary.length <= MAX_SUMMARY_LENGTH ? summary : summary.slice(0, MAX_SUMMARY_LENGTH);
}

/**
 * Builds and signs the `operator.approval.requested` payload for one Gateway
 * proposal record. `keysTouched` is always `[]` (see module doc).
 */
export async function buildApprovalRequestedPayload(
  record: SystemAgentApprovalRequestRecord,
  signer: { did: string; privateKeyHex: string },
): Promise<KernelApprovalRequestedPayload> {
  const fields = {
    proposalId: record.id,
    kind: deriveProposalKind(record.request),
    summary: truncateSummary(record.request.description || record.request.title || record.id),
    keysTouched: [] as string[],
    contentHash: record.request.proposalHash,
  };
  const signature = await signCanonicalPayload(fields, signer.privateKeyHex);
  return { ...fields, signature, signerDid: signer.did };
}

// --- Signing (Ed25519 over the canonical JSON of the 5 signed fields) ---

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

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) {
    throw new Error("invalid hex string");
  }
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Signs `canonicalize(payload)` with the agent's Ed25519 private key.
 * `canonicalize` (imported from `./approval-bridge.js`) mirrors `@imajin/
 * auth`'s canonical JSON so the signature could, in principle, be verified
 * by the same routine the kernel uses — even though the kernel does not
 * verify it in v1 (see the module doc's contentHash section).
 */
export async function signCanonicalPayload(
  payload: Record<string, unknown>,
  privateKeyHex: string,
): Promise<string> {
  const ed = await loadEd25519();
  const bytes = new TextEncoder().encode(canonicalize(payload));
  const signature = await ed.signAsync(bytes, hexToBytes(privateKeyHex));
  return bytesToHex(signature);
}

// --- Config gate ---

export interface ApprovalsBridgePluginConfig {
  /** Off unless explicitly `true` — config is additive, existing operators unaffected. */
  enabled?: boolean;
  /** The operator DID the kernel notification is addressed `to` and the decided event must be signed `by`. */
  operatorDid?: string;
  /**
   * Optional explicit credential override for the plugin's own loopback
   * Gateway operator connection. Accepts a plain string or a SecretRef
   * (same style as `wsNotifications.hookToken`, #20) — never a literal in
   * config, never logged. When omitted, Gateway auth is resolved
   * automatically from the host's own `gateway` config (the same mechanism
   * the existing `approvalBridge` exec/plugin feature already relies on via
   * `resolveApprovalOverGateway`/`createOperatorApprovalsGatewayClient`) —
   * see README "Gateway approvals bridge" for why this is optional.
   */
  gatewayToken?: SecretInput;
  /**
   * Bearer value for the kernel's `POST /notify/api/send` `x-webhook-secret`
   * header (`NOTIFY_WEBHOOK_SECRET` on the kernel). SecretRef-capable, same
   * style as `wsNotifications.hookToken`. Falls back to the
   * `IMAJIN_NOTIFY_WEBHOOK_SECRET` env var when omitted. Required for the
   * bridge to publish anything — never a literal in config, never logged.
   */
  notifyWebhookSecret?: SecretInput;
}

/**
 * True only when the feature is explicitly enabled AND every value required
 * to run it safely is present. `enabled: false` (or omitted) means nothing
 * opens — config is additive and existing operators are unaffected.
 */
export function isApprovalsBridgeConfigured(
  config: ApprovalsBridgePluginConfig | undefined,
  agentDid: string | undefined,
): boolean {
  return Boolean(config?.enabled && config?.operatorDid?.trim() && agentDid?.trim());
}

// --- The bridge itself (pure logic + orchestration; fully unit-testable) ---

export interface GatewayApprovalsBridgeConfig {
  operatorDid: string;
  agentDid: string;
  agentPrivateKeyHex: string;
}

interface TrackedProposal {
  contentHash: string;
}

export class GatewayApprovalsBridge {
  private readonly published = new Map<string, TrackedProposal>();
  private readonly logger: Logger;

  constructor(
    private readonly config: GatewayApprovalsBridgeConfig,
    private readonly gateway: GatewayApprovalsClient,
    private readonly kernel: KernelNotifyClient,
    logger?: Logger,
  ) {
    this.logger = logger ?? defaultLogger();
    this.gateway.onRequested((record) => {
      void this.handleGatewayRequested(record).catch((err: unknown) => {
        this.logger.error(`failed to handle openclaw.approval.requested ${record.id}: ${String(err)}`);
      });
    });
  }

  /** True once this bridge has published (and is tracking) the given proposal id. */
  isPublished(proposalId: string): boolean {
    return this.published.has(proposalId);
  }

  /**
   * Startup reconcile (#24): a proposal staged while the plugin was down
   * would never fire a live `openclaw.approval.requested` event, so this
   * lists every currently-pending proposal and publishes only the ones this
   * bridge has not already published in this process lifetime.
   */
  async reconcile(): Promise<void> {
    let records: SystemAgentApprovalRequestRecord[];
    try {
      records = await this.gateway.list();
    } catch (err) {
      this.logger.error(`startup reconcile: openclaw.approval.list failed: ${String(err)}`);
      return;
    }
    for (const record of records) {
      if (this.published.has(record.id)) continue;
      await this.handleGatewayRequested(record);
    }
  }

  private async handleGatewayRequested(record: SystemAgentApprovalRequestRecord): Promise<void> {
    if (this.published.has(record.id)) {
      // Dedup by proposalId (#24): a reconnect/replay of the same event, or a
      // reconcile racing a live event for the same proposal, must never
      // re-publish.
      return;
    }
    let payload: KernelApprovalRequestedPayload;
    try {
      payload = await buildApprovalRequestedPayload(record, {
        did: this.config.agentDid,
        privateKeyHex: this.config.agentPrivateKeyHex,
      });
    } catch (err) {
      this.logger.error(`failed to sign operator.approval.requested for ${record.id}: ${String(err)}`);
      return;
    }
    // Reserve before the network call: a concurrent duplicate (live event +
    // reconcile racing) must never publish twice.
    this.published.set(record.id, { contentHash: payload.contentHash });
    try {
      await this.kernel.publishApprovalRequested(payload);
      this.logger.info(`published operator.approval.requested for ${record.id} (kind=${payload.kind})`);
    } catch (err) {
      this.published.delete(record.id);
      this.logger.error(`failed to publish operator.approval.requested for ${record.id}: ${String(err)}`);
    }
  }

  /**
   * Handles one inbound kernel `bus_event` frame. Only ever acts on
   * `operator.approval.decided`; every other event type is ignored.
   */
  async handleKernelDecision(frame: KernelBusEventFrame): Promise<void> {
    if (frame.eventType !== "operator.approval.decided") return;
    const payload = frame.payload as
      | Partial<{ proposalId: string; decision: string; decidedBy: string }>
      | undefined;
    const proposalId = payload?.proposalId;
    if (typeof proposalId !== "string" || proposalId.length === 0) {
      this.logger.warn("dropped malformed operator.approval.decided (missing proposalId)");
      return;
    }

    // Auth (load-bearing, #24): the decided event must be kernel-witnessed
    // (delivered over this agent's OWN authenticated, grant-scoped kernel WS
    // — see module doc) AND signed/attributed to exactly the configured
    // operator DID on every identity field the envelope carries. A decision
    // is never applied on channel-trust (an authenticated WS frame) alone —
    // the Gateway is never even contacted unless every check below passes.
    const operatorDid = this.config.operatorDid;
    const isOperator =
      frame.issuer === operatorDid && frame.subject === operatorDid && payload?.decidedBy === operatorDid;
    if (!isOperator) {
      this.logger.warn(
        `rejected operator.approval.decided for ${proposalId}: signer is not the configured operator`,
      );
      return;
    }

    if (payload?.decision === "withdrawn") {
      // No Gateway-side analog: `approval.resolve` has no "withdraw" decision
      // for a system-agent proposal already forwarded to it. Documented no-op.
      this.logger.info(
        `operator.approval.decided withdrawn for ${proposalId} — no Gateway action (unsupported by approval.resolve)`,
      );
      return;
    }
    if (payload?.decision !== "approve" && payload?.decision !== "deny") {
      this.logger.warn(
        `ignoring operator.approval.decided for ${proposalId}: unrecognized decision ${String(payload?.decision)}`,
      );
      return;
    }

    const tracked = this.published.get(proposalId);
    if (!tracked) {
      // Idempotent (#24): unknown to this bridge — either never published,
      // already resolved+evicted, or from a prior process lifetime that a
      // startup reconcile has not (yet) repopulated. No-op, one log line.
      this.logger.info(`operator.approval.decided for ${proposalId}: not tracked by this bridge — no-op`);
      return;
    }

    let snapshot: GatewayApprovalSnapshot | null;
    try {
      snapshot = await this.gateway.get(proposalId);
    } catch (err) {
      this.logger.error(`approval.get failed for ${proposalId}: ${String(err)}`);
      return;
    }
    if (!snapshot || snapshot.status !== "pending") {
      // Idempotent (#24): already resolved/expired/unknown on the Gateway.
      this.logger.info(
        `operator.approval.decided for ${proposalId}: no longer pending on the Gateway (status=${
          snapshot?.status ?? "unknown"
        }) — no-op`,
      );
      this.published.delete(proposalId);
      return;
    }

    const currentHash = snapshot.presentation?.proposalHash;
    if (!currentHash || currentHash !== tracked.contentHash) {
      this.logger.warn(`content hash mismatch for ${proposalId} — refusing to apply decision`);
      try {
        await this.kernel.publishMismatch(proposalId, "contentHash no longer matches the staged proposal");
      } catch (err) {
        this.logger.error(`failed to publish operator.approval.mismatch for ${proposalId}: ${String(err)}`);
      }
      return;
    }

    const gatewayDecision: SystemAgentApprovalDecisionKind = payload.decision === "approve" ? "allow-once" : "deny";
    try {
      await this.gateway.resolve(proposalId, gatewayDecision);
      this.logger.info(`applied ${gatewayDecision} for ${proposalId}`);
    } catch (err) {
      // The Gateway treats a repeat of the SAME decision as idempotent
      // success and errors cleanly on a genuine conflict (#24) — log, never
      // crash the bridge (and never the kernel WS session/notification
      // injector, which this bridge has no other coupling to).
      this.logger.warn(`approval.resolve failed for ${proposalId} (${gatewayDecision}): ${String(err)}`);
    } finally {
      this.published.delete(proposalId);
    }
  }
}

// --- Live wiring (SDK/network — isolated from the pure class above) ---

const NOTIFY_WEBHOOK_SECRET_ENV = "IMAJIN_NOTIFY_WEBHOOK_SECRET";

interface Keypair {
  did: string;
  privateKeyHex: string;
}

async function loadAgentKeypair(keypairPath: string): Promise<Keypair> {
  const raw = await readFile(keypairPath, "utf-8");
  const parsed = JSON.parse(raw) as {
    did?: string;
    privateKey?: string;
    keypair?: { privateKey?: string };
  };
  const did = parsed.did;
  const privateKeyHex = parsed.privateKey || parsed.keypair?.privateKey || "";
  if (!did || !privateKeyHex) {
    throw new Error("gateway approvals bridge: keypair file missing did/privateKey");
  }
  return { did, privateKeyHex };
}

type SecretSource = "secretRef" | "config" | "env" | "none";

/**
 * Resolves a SecretInput the same way `notification-injector.ts`'s
 * `resolveHookToken` does: config SecretRef -> config plain string -> env
 * fallback -> none. Only the SecretRef branch touches the plugin SDK (via a
 * dynamic import), so the plain-string/env/none paths never need it to
 * resolve on disk.
 */
async function resolveApprovalsSecret(
  api: unknown,
  raw: SecretInput | undefined,
  envVar: string,
): Promise<{ value: string | undefined; source: SecretSource }> {
  if (raw && typeof raw === "object") {
    try {
      const { isSecretRef } = await import("openclaw/plugin-sdk/secret-input-runtime");
      if (isSecretRef(raw)) {
        const { resolveSecretRefValues } = await import("openclaw/plugin-sdk/secret-ref-runtime");
        const config =
          (api as { runtime?: { config?: { current?: () => unknown } } })?.runtime?.config?.current?.() ?? {};
        const resolved = await resolveSecretRefValues([raw], { config, env: process.env });
        const value = resolved.values().next().value;
        const trimmed = typeof value === "string" ? value.trim() : "";
        if (trimmed) return { value: trimmed, source: "secretRef" };
      }
    } catch (err: unknown) {
      console.warn(
        `[imajin-approvals-bridge] SecretRef for ${envVar} failed to resolve: ${
          err instanceof Error ? err.message : String(err)
        } — falling back`,
      );
    }
  } else if (typeof raw === "string" && raw.trim()) {
    return { value: raw.trim(), source: "config" };
  }
  const envValue = process.env[envVar]?.trim();
  if (envValue) return { value: envValue, source: "env" };
  return { value: undefined, source: "none" };
}

/**
 * Builds the live `GatewayApprovalsClient` backed by the plugin's own
 * loopback Gateway operator connection. Uses `createOperatorApprovalsGatewayClient`
 * (`openclaw/plugin-sdk/gateway-runtime`) — the exact function the OpenClaw
 * CLI's own operator-approvals tooling uses (`operator-approvals-client.ts`)
 * — which resolves Gateway auth automatically from the host's own `gateway`
 * config. When `gatewayTokenOverride` is set, it is layered onto a shallow
 * copy of that config (never mutating the host's real config object) so an
 * operator can pin a dedicated credential without disturbing the Gateway's
 * own default auth.
 */
export async function createLiveGatewayApprovalsClient(
  api: { runtime?: { config?: { current?: () => Record<string, unknown> } } },
  opts: { gatewayTokenOverride?: string; clientDisplayName: string },
): Promise<{ client: GatewayApprovalsClient; start: () => Promise<void>; stop: () => void }> {
  const { createOperatorApprovalsGatewayClient, startGatewayClientWhenEventLoopReady } = await import(
    "openclaw/plugin-sdk/gateway-runtime"
  );

  let requestedHandler: ((record: SystemAgentApprovalRequestRecord) => void) | undefined;

  const baseConfig = (api.runtime?.config?.current?.() ?? {}) as Record<string, unknown> & {
    gateway?: Record<string, unknown> & { auth?: Record<string, unknown> };
  };
  const bootstrapConfig = opts.gatewayTokenOverride
    ? {
        ...baseConfig,
        gateway: {
          ...baseConfig.gateway,
          auth: { ...baseConfig.gateway?.auth, token: opts.gatewayTokenOverride },
        },
      }
    : baseConfig;

  const gatewayClient = await createOperatorApprovalsGatewayClient({
    config: bootstrapConfig,
    clientDisplayName: opts.clientDisplayName,
    onEvent: (evt) => {
      if (evt.event !== "openclaw.approval.requested") return;
      const record = evt.payload as SystemAgentApprovalRequestRecord | undefined;
      if (record && typeof record.id === "string" && record.request?.proposalHash) {
        requestedHandler?.(record);
      }
    },
    onConnectError: (err) => {
      console.error(`[imajin-approvals-bridge] gateway connect error: ${String(err)}`);
    },
    onClose: (code, reason) => {
      console.warn(`[imajin-approvals-bridge] gateway connection closed (${code}): ${reason ?? ""}`);
    },
  });

  const client: GatewayApprovalsClient = {
    async list() {
      const records = await gatewayClient.request<SystemAgentApprovalRequestRecord[]>(
        "openclaw.approval.list",
        {},
      );
      return (records ?? []).filter(
        (record) => typeof record?.id === "string" && Boolean(record.request?.proposalHash),
      );
    },
    async get(id: string) {
      const result = await gatewayClient.request<{ approval: GatewayApprovalSnapshot }>("approval.get", { id });
      return result?.approval ?? null;
    },
    async resolve(id: string, decision: SystemAgentApprovalDecisionKind) {
      const result = await gatewayClient.request<{ applied: boolean }>("approval.resolve", {
        id,
        kind: "system-agent",
        decision,
      });
      return { applied: result?.applied === true };
    },
    onRequested(handler) {
      requestedHandler = handler;
    },
  };

  return {
    client,
    start: async () => {
      const readiness = await startGatewayClientWhenEventLoopReady(gatewayClient, { clientOptions: {} });
      if (!readiness.ready) {
        throw new Error("gateway approvals bridge: gateway client failed to start");
      }
    },
    stop: () => gatewayClient.stop(),
  };
}

/** Live `KernelNotifyClient` over `POST /notify/api/send`. */
export function createHttpKernelNotifyClient(opts: {
  nodeUrl: string;
  webhookSecret: string;
  operatorDid: string;
}): KernelNotifyClient {
  const baseUrl = opts.nodeUrl.replace(/\/$/, "");

  async function send(scope: string, data: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${baseUrl}/notify/api/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": opts.webhookSecret,
      },
      body: JSON.stringify({ to: opts.operatorDid, scope, data }),
    });
    if (!res.ok) {
      throw new Error(`kernel notify ${scope} failed (${res.status}): ${await res.text()}`);
    }
  }

  return {
    publishApprovalRequested: (payload) =>
      send("operator.approval.requested", payload as unknown as Record<string, unknown>),
    publishMismatch: (proposalId, reason) => send("operator.approval.mismatch", { proposalId, reason }),
  };
}

export interface StartGatewayApprovalsBridgeDeps {
  did?: string;
  keypairPath?: string;
  nodeUrl: string;
}

/**
 * Orchestrates the whole bridge for `index.ts`: resolves secrets, opens the
 * Gateway loopback client, constructs the kernel HTTP client, runs the
 * startup reconcile, and returns a frame handler for the plugin's existing
 * kernel WS plus a `dispose()`. Returns `undefined` when the feature is not
 * fully configured — nothing opens in that case (see `isApprovalsBridgeConfigured`).
 */
export async function startGatewayApprovalsBridge(
  api: { runtime?: { config?: { current?: () => Record<string, unknown> } } },
  config: ApprovalsBridgePluginConfig | undefined,
  deps: StartGatewayApprovalsBridgeDeps,
): Promise<{ onKernelFrame: (frame: unknown) => void; dispose: () => void } | undefined> {
  if (!isApprovalsBridgeConfigured(config, deps.did)) {
    if (config?.enabled) {
      console.warn(
        "[imajin-approvals-bridge] approvals.enabled is true but approvals.operatorDid or the agent did/keypairPath is missing — bridge not started",
      );
    }
    return undefined;
  }

  const [gatewayTokenResult, notifySecretResult] = await Promise.all([
    resolveApprovalsSecret(api, config!.gatewayToken, "IMAJIN_APPROVALS_GATEWAY_TOKEN"),
    resolveApprovalsSecret(api, config!.notifyWebhookSecret, NOTIFY_WEBHOOK_SECRET_ENV),
  ]);

  if (!notifySecretResult.value) {
    console.warn(
      "[imajin-approvals-bridge] approvals.notifyWebhookSecret (or IMAJIN_NOTIFY_WEBHOOK_SECRET) is not configured — bridge not started",
    );
    return undefined;
  }

  let keypair: Keypair;
  try {
    keypair = await loadAgentKeypair(deps.keypairPath!);
  } catch (err) {
    console.error(`[imajin-approvals-bridge] failed to load agent keypair: ${String(err)}`);
    return undefined;
  }

  const kernel = createHttpKernelNotifyClient({
    nodeUrl: deps.nodeUrl,
    webhookSecret: notifySecretResult.value,
    operatorDid: config!.operatorDid!,
  });

  let live: Awaited<ReturnType<typeof createLiveGatewayApprovalsClient>>;
  try {
    live = await createLiveGatewayApprovalsClient(api, {
      gatewayTokenOverride: gatewayTokenResult.value,
      clientDisplayName: "Imajin Gateway approvals bridge",
    });
  } catch (err) {
    console.error(`[imajin-approvals-bridge] failed to create gateway client: ${String(err)}`);
    return undefined;
  }

  const bridge = new GatewayApprovalsBridge(
    { operatorDid: config!.operatorDid!, agentDid: deps.did!, agentPrivateKeyHex: keypair.privateKeyHex },
    live.client,
    kernel,
  );

  try {
    await live.start();
    await bridge.reconcile();
  } catch (err) {
    console.error(`[imajin-approvals-bridge] startup failed: ${String(err)}`);
    live.stop();
    return undefined;
  }

  return {
    onKernelFrame: (frame: unknown) => {
      if (!isKernelBusEventFrame(frame)) return;
      void bridge.handleKernelDecision(frame).catch((err: unknown) => {
        console.error(`[imajin-approvals-bridge] failed to handle kernel decision frame: ${String(err)}`);
      });
    },
    dispose: () => live.stop(),
  };
}
