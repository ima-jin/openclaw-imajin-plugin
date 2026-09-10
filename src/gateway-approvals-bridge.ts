/**
 * Generic gateway-approvals bridge (#33, generalizing #24's plugin half of
 * ima-jin/imajin-ai#2059).
 *
 * Drives zero or more `ApprovalSource`s (`./sources/types.ts`) — one per
 * `approvals.sources` config entry (default: `system-agent` and
 * `skill-workshop`, `./sources/system-agent.ts` / `./sources/skill-
 * workshop.ts`). For every source this bridge:
 *
 *   1. Observes pending items via that source's own `list()` (startup
 *      reconcile, so an item staged while the plugin was down is not
 *      missed) and `subscribe()` (live discovery).
 *   2. Publishes a kernel notification `operator.approval.requested`
 *      (`POST /notify/api/send`, see `KernelNotifyClient`) signed by this
 *      agent's existing DID keypair — the same one `client.ts`/`ws-
 *      service.ts` use for challenge-response — over the canonical JSON of
 *      exactly `{proposalId, kind, summary, keysTouched, contentHash}`.
 *      `source` and `detail` (#2152's open kind/source vocabulary) ride
 *      along on the outgoing payload as ADDITIONAL, UNSIGNED fields — see
 *      "Why `source`/`detail` are unsigned" below.
 *   3. Subscribes on the plugin's EXISTING kernel WebSocket
 *      (`ImajinWsService`) for the resulting `operator.approval.decided`
 *      bus event, verifies it, and only then calls the OWNING source's own
 *      `resolve()` — this bridge never bypasses a source's own backing
 *      store, it only relays the operator's decision to it.
 *
 * Why `source`/`detail` are unsigned in v1: the existing (#24) unit test
 * for `buildApprovalRequestedPayload` verifies the signature against
 * exactly the five original fields (`proposalId, kind, summary,
 * keysTouched, contentHash`) — the "zero behaviour change" bar for
 * system-agent requires that signature to stay byte-identical. Extending
 * the signed digest would also not gain anything real in v1 anyway: per the
 * original module doc (preserved below), the kernel does not verify this
 * signature at all yet, so an unsigned rider field carries exactly the same
 * (lack of) cryptographic guarantee either way. `source`/`detail` are
 * genuinely present on the wire payload the kernel receives and stores,
 * satisfying #2152's contract; they are simply outside the v1 signature's
 * scope, exactly like the pre-existing gap this module already documents
 * for the whole signature.
 *
 * `contentHash` remains each source's own NATIVE anti-tamper hash (the
 * Gateway's `proposalHash` for system-agent, Skill Workshop's
 * `revisionHash`) — never a hash this plugin computes over the outgoing
 * payload itself. This bridge verifies a decision against a fresh
 * `ApprovalSource.getCurrent()` (or, for Skill Workshop, the Gateway's own
 * `expectedRevisionHash` enforcement inside `resolve()`) re-fetched right
 * before ever resolving — the same honest, source-native tamper/replay
 * protection #24 originally used, generalized to every source.
 *
 * This module has NO top-level `openclaw` plugin-sdk imports outside the
 * "Live wiring" section at the bottom, so `GatewayApprovalsBridge` (and
 * every function above it) can be unit tested with plain fakes.
 */
import { readFile } from "node:fs/promises";
import { canonicalize } from "./approval-bridge.js";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  ApprovalContentDriftError,
  type ApprovalDecision,
  type ApprovalSource,
  type ApprovalSourceCurrentState,
  type ApprovalSourceRequest,
  type Unsubscribe,
} from "./sources/types.js";
import { createLiveGatewayApprovalsClient, createSystemAgentSource } from "./sources/system-agent.js";
import { createLiveSkillWorkshopConnection, createSkillWorkshopSource } from "./sources/skill-workshop.js";

// --- Wire types (kernel side, `docs/notify-operator-approvals-contract.md` in ima-jin/imajin-ai, generalized by #2152) ---

/** The `operator.approval.requested` notification `data` payload this bridge publishes. */
export interface KernelApprovalRequestedPayload {
  proposalId: string;
  /** Which `ApprovalSource` published this (#2152's open source vocabulary). Unsigned — see module doc. */
  source: string;
  /** Namespaced `"<source>:<subkind>"` (#2152), e.g. `"system-agent:restart"` or `"skill-workshop:update"`. */
  kind: string;
  summary: string;
  keysTouched: string[];
  /** The source's own native anti-tamper hash. */
  contentHash: string;
  /** Optional bounded structured payload for a per-kind /jin card renderer (#2152). Unsigned — see module doc. */
  detail?: Record<string, unknown>;
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

/**
 * Builds and signs the `operator.approval.requested` payload for one
 * source's pending item. The signature covers exactly the same five fields
 * #24 originally signed (`proposalId, kind, summary, keysTouched,
 * contentHash`) — see the module doc's "Why `source`/`detail` are unsigned".
 * `keysTouched` is always `[]`: no current source has a structured
 * touched-keys list to report (see each source's own module doc).
 */
export async function buildApprovalRequestedPayload(
  sourceId: string,
  request: ApprovalSourceRequest,
  signer: { did: string; privateKeyHex: string },
): Promise<KernelApprovalRequestedPayload> {
  const signedFields = {
    proposalId: request.proposalId,
    kind: request.kind,
    summary: request.summary,
    keysTouched: [] as string[],
    contentHash: request.contentHash,
  };
  const signature = await signCanonicalPayload(signedFields, signer.privateKeyHex);
  return {
    ...signedFields,
    source: sourceId,
    ...(request.detail ? { detail: request.detail } : {}),
    signature,
    signerDid: signer.did,
  };
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
 * verify it in v1 (see the module doc's signature section).
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
   * Which sources to drive (#33). Defaults to every known source
   * (`["system-agent", "skill-workshop"]`) when omitted. A source not in
   * this list neither lists nor subscribes — it is never constructed.
   */
  sources?: string[];
  /**
   * Optional explicit credential override for the plugin's own loopback
   * Gateway operator connection(s). Accepts a plain string or a SecretRef
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

export const KNOWN_APPROVAL_SOURCE_IDS = ["system-agent", "skill-workshop"] as const;
export type KnownApprovalSourceId = (typeof KNOWN_APPROVAL_SOURCE_IDS)[number];

/** Resolves `approvals.sources` to the set of source ids to drive, defaulting to every known source. */
export function resolveEnabledApprovalSourceIds(configured: string[] | undefined): Set<string> {
  if (!configured || configured.length === 0) return new Set(KNOWN_APPROVAL_SOURCE_IDS);
  return new Set(configured.filter((id) => (KNOWN_APPROVAL_SOURCE_IDS as readonly string[]).includes(id)));
}

// --- The bridge itself (pure logic + orchestration; fully unit-testable) ---

export interface GatewayApprovalsBridgeConfig {
  operatorDid: string;
  agentDid: string;
  agentPrivateKeyHex: string;
}

interface TrackedProposal {
  sourceId: string;
  contentHash: string;
}

export class GatewayApprovalsBridge {
  private readonly published = new Map<string, TrackedProposal>();
  private readonly logger: Logger;
  private readonly unsubscribes: Unsubscribe[] = [];

  constructor(
    private readonly config: GatewayApprovalsBridgeConfig,
    private readonly sources: Map<string, ApprovalSource>,
    private readonly kernel: KernelNotifyClient,
    logger?: Logger,
  ) {
    this.logger = logger ?? defaultLogger();
    for (const source of this.sources.values()) {
      const unsubscribe = source.subscribe((request) => {
        void this.handleSourceRequested(source.id, request).catch((err: unknown) => {
          this.logger.error(`failed to handle ${source.id} request ${request.proposalId}: ${String(err)}`);
        });
      });
      this.unsubscribes.push(unsubscribe);
    }
  }

  /** True once this bridge has published (and is tracking) the given proposal id. */
  isPublished(proposalId: string): boolean {
    return this.published.has(proposalId);
  }

  /** Stops observing every source. Does not evict already-tracked proposals. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
  }

  /**
   * Startup reconcile (#24, generalized by #33): an item staged while the
   * plugin was down would never fire a live `subscribe()` callback, so this
   * lists every currently-pending item from EVERY active source and
   * publishes only the ones this bridge has not already published in this
   * process lifetime.
   */
  async reconcile(): Promise<void> {
    for (const source of this.sources.values()) {
      await this.reconcileSource(source);
    }
  }

  private async reconcileSource(source: ApprovalSource): Promise<void> {
    let requests: ApprovalSourceRequest[];
    try {
      requests = await source.list();
    } catch (err) {
      this.logger.error(`startup reconcile: ${source.id}.list() failed: ${String(err)}`);
      return;
    }
    for (const request of requests) {
      if (this.published.has(request.proposalId)) continue;
      await this.handleSourceRequested(source.id, request);
    }
  }

  private async handleSourceRequested(sourceId: string, request: ApprovalSourceRequest): Promise<void> {
    if (this.published.has(request.proposalId)) {
      // Dedup by proposalId (#24): a reconnect/replay of the same event, or a
      // reconcile racing a live event for the same proposal, must never
      // re-publish.
      return;
    }
    let payload: KernelApprovalRequestedPayload;
    try {
      payload = await buildApprovalRequestedPayload(sourceId, request, {
        did: this.config.agentDid,
        privateKeyHex: this.config.agentPrivateKeyHex,
      });
    } catch (err) {
      this.logger.error(`failed to sign operator.approval.requested for ${request.proposalId}: ${String(err)}`);
      return;
    }
    // Reserve before the network call: a concurrent duplicate (live event +
    // reconcile racing) must never publish twice.
    this.published.set(request.proposalId, { sourceId, contentHash: request.contentHash });
    try {
      await this.kernel.publishApprovalRequested(payload);
      this.logger.info(
        `published operator.approval.requested for ${request.proposalId} (source=${sourceId}, kind=${payload.kind})`,
      );
    } catch (err) {
      this.published.delete(request.proposalId);
      this.logger.error(`failed to publish operator.approval.requested for ${request.proposalId}: ${String(err)}`);
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
    // no source is ever contacted unless every check below passes.
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
      // No generic source analog in v1: no active source exposes a
      // "withdraw" decision for an item already forwarded to it. Documented
      // no-op, preserved from #24.
      this.logger.info(
        `operator.approval.decided withdrawn for ${proposalId} — no source action (unsupported in v1)`,
      );
      return;
    }
    if (payload?.decision !== "approve" && payload?.decision !== "deny" && payload?.decision !== "reject") {
      this.logger.warn(
        `ignoring operator.approval.decided for ${proposalId}: unrecognized decision ${String(payload?.decision)}`,
      );
      return;
    }
    const decision: ApprovalDecision = payload.decision === "approve" ? "approve" : "reject";

    const tracked = this.published.get(proposalId);
    if (!tracked) {
      // Idempotent (#24): unknown to this bridge — either never published,
      // already resolved+evicted, or from a prior process lifetime that a
      // startup reconcile has not (yet) repopulated. No-op, one log line.
      this.logger.info(`operator.approval.decided for ${proposalId}: not tracked by this bridge — no-op`);
      return;
    }

    const source = this.sources.get(tracked.sourceId);
    if (!source) {
      // Config changed (source disabled) between publish and decision.
      this.logger.error(
        `operator.approval.decided for ${proposalId}: source "${tracked.sourceId}" is no longer active — no-op`,
      );
      return;
    }

    let current: ApprovalSourceCurrentState | null;
    try {
      current = await source.getCurrent(proposalId);
    } catch (err) {
      this.logger.error(`${tracked.sourceId}.getCurrent failed for ${proposalId}: ${String(err)}`);
      return;
    }
    if (!current || !current.pending) {
      // Idempotent (#24): already resolved/expired/unknown at the source.
      this.logger.info(
        `operator.approval.decided for ${proposalId}: no longer pending at ${tracked.sourceId} — no-op`,
      );
      this.published.delete(proposalId);
      return;
    }

    if (!current.contentHash || current.contentHash !== tracked.contentHash) {
      await this.handleDrift(source, tracked, proposalId, "contentHash no longer matches the staged proposal");
      return;
    }

    try {
      const result = await source.resolve(proposalId, decision, tracked.contentHash);
      this.logger.info(`applied ${decision} for ${proposalId} (source=${tracked.sourceId}, applied=${result.applied})`);
      this.published.delete(proposalId);
    } catch (err) {
      if (err instanceof ApprovalContentDriftError) {
        await this.handleDrift(source, tracked, proposalId, err.message);
        return;
      }
      // The Gateway/source treats a repeat of the SAME decision as
      // idempotent success and errors cleanly on a genuine conflict (#24) —
      // log, never crash the bridge.
      this.logger.warn(`approval.resolve failed for ${proposalId} (${decision}): ${String(err)}`);
      this.published.delete(proposalId);
    }
  }

  /**
   * Shared handling for a detected content-hash drift, whether caught
   * before ever calling `resolve` (pre-check) or via a thrown
   * `ApprovalContentDriftError` from `resolve` itself (race-window
   * fallback). Publishes the best-effort kernel mismatch notice, then
   * branches on the source's `onDriftPolicy`.
   */
  private async handleDrift(
    source: ApprovalSource,
    tracked: TrackedProposal,
    proposalId: string,
    reason: string,
  ): Promise<void> {
    this.logger.warn(`content hash mismatch for ${proposalId} (source=${tracked.sourceId}) — refusing to apply decision`);
    try {
      await this.kernel.publishMismatch(proposalId, reason);
    } catch (err) {
      this.logger.error(`failed to publish operator.approval.mismatch for ${proposalId}: ${String(err)}`);
    }
    if (source.onDriftPolicy === "restage") {
      this.published.delete(proposalId);
      await this.reconcileSource(source);
    }
    // "leave" (default, #24 parity): keep the stale entry tracked until a
    // full reconcile/reconnect naturally repopulates it.
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
 * Orchestrates the whole bridge for `index.ts`: resolves secrets, opens one
 * Gateway loopback connection per enabled source (#33's `approvals.sources`,
 * each behind its own try/catch so one source's Gateway hiccup never blocks
 * another), constructs the kernel HTTP client, runs the startup reconcile,
 * and returns a frame handler for the plugin's existing kernel WS plus a
 * `dispose()`. Returns `undefined` when the feature is not fully configured,
 * or when every enabled source failed to start (see
 * `isApprovalsBridgeConfigured`).
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

  const enabledSourceIds = resolveEnabledApprovalSourceIds(config!.sources);
  const sources = new Map<string, ApprovalSource>();
  const stoppers: Array<() => void> = [];

  if (enabledSourceIds.has("system-agent")) {
    try {
      const live = await createLiveGatewayApprovalsClient(api, {
        gatewayTokenOverride: gatewayTokenResult.value,
        clientDisplayName: "Imajin Gateway approvals bridge (system-agent)",
      });
      await live.start();
      sources.set("system-agent", createSystemAgentSource(live.client));
      stoppers.push(live.stop);
    } catch (err) {
      console.error(`[imajin-approvals-bridge] failed to start system-agent source: ${String(err)}`);
    }
  }

  if (enabledSourceIds.has("skill-workshop")) {
    try {
      const live = await createLiveSkillWorkshopConnection(api, {
        gatewayTokenOverride: gatewayTokenResult.value,
        clientDisplayName: "Imajin Gateway approvals bridge (skill-workshop)",
      });
      await live.start();
      sources.set("skill-workshop", createSkillWorkshopSource(live.client));
      stoppers.push(live.stop);
    } catch (err) {
      console.error(`[imajin-approvals-bridge] failed to start skill-workshop source: ${String(err)}`);
    }
  }

  if (sources.size === 0) {
    console.warn("[imajin-approvals-bridge] no approval sources could be started — bridge not started");
    return undefined;
  }

  const bridge = new GatewayApprovalsBridge(
    { operatorDid: config!.operatorDid!, agentDid: deps.did!, agentPrivateKeyHex: keypair.privateKeyHex },
    sources,
    kernel,
  );

  try {
    await bridge.reconcile();
  } catch (err) {
    console.error(`[imajin-approvals-bridge] startup reconcile failed: ${String(err)}`);
  }

  return {
    onKernelFrame: (frame: unknown) => {
      if (!isKernelBusEventFrame(frame)) return;
      void bridge.handleKernelDecision(frame).catch((err: unknown) => {
        console.error(`[imajin-approvals-bridge] failed to handle kernel decision frame: ${String(err)}`);
      });
    },
    dispose: () => {
      bridge.dispose();
      for (const stop of stoppers) stop();
    },
  };
}
