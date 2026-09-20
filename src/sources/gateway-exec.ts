/**
 * OpenClaw gateway-exec `ApprovalSource` (#38) — the third source on the
 * generic gateway-approvals bridge (#33/#34), after `system-agent` (#24) and
 * `skill-workshop` (#33). Kernel half: `ima-jin/imajin-ai#2221` (operator-
 * approval kind `exec.command`, built in parallel with this plugin half).
 *
 * ## Which hook: forwarded-channel payload vs. gateway event subscription?
 *
 * The issue asked us to pick between two ways to observe a pending OpenClaw
 * host-exec approval, and to document why. This source subscribes directly
 * to the plugin's OWN loopback OpenClaw Gateway operator connection for the
 * `exec.approval.requested` broadcast (verified against `docs.openclaw.ai`
 * "Exec approvals" / "Exec approvals — advanced" and the public
 * `openclaw/openclaw` source for `src/gateway/server-methods/exec-
 * approval.ts` + `exec-approval-manager.ts` — the real `openclaw` package is
 * not installed locally, see `src/types/openclaw-plugin-sdk.d.ts`'s module
 * doc for why), NOT the `approvals.exec.targets` forwarded-channel path.
 * Reasons, in order of weight:
 *
 *   1. **Full exact command.** `exec.approval.list`/the `exec.approval.
 *      requested` broadcast carry the Gateway's own internal
 *      `ExecApprovalRequestPayload` — `command` (already validated
 *      non-oversized and non-truncated at request time; the Gateway REJECTS
 *      an oversized command outright rather than truncating it, see
 *      `sanitizeExecApprovalDisplayTextWithStatus`'s `truncated`/`oversized`
 *      guard), plus `commandArgv`, `cwd`, `agentId`, and `sessionKey`. The
 *      `approvals.exec.targets` forwarded-channel path instead carries the
 *      `com.openclaw.approval` content built for a CHAT renderer (Matrix's
 *      structured-approval-metadata PR documents `commandText`/`cwd`/`host`/
 *      `nodeId`/`sessionKey` there too, but that shape exists to drive a
 *      chat bubble, not a kernel operator-approval record, and is a strictly
 *      narrower, display-oriented projection with no documented contract
 *      guaranteeing every field this kernel card needs). The Gateway's own
 *      internal record is the single source of truth either hook ultimately
 *      reads from — going straight to it avoids depending on a second,
 *      chat-shaped projection of the same data.
 *   2. **No new "become a channel" surface.** `approvals.exec.targets[].
 *      channel` addresses an OpenClaw outbound CHANNEL plugin (Telegram,
 *      Discord, Matrix, Slack, a custom plugin channel, ...) — receiving
 *      that forwarded payload would require this plugin to register and
 *      maintain a full outbound channel adapter (session/account routing,
 *      message rendering, `/approve` command handling) purely to unwrap one
 *      field. That is a large, out-of-scope lift the issue does not ask for.
 *   3. **Matches this codebase's own established pattern exactly.** #24's
 *      `system-agent` source already opens the plugin's own loopback Gateway
 *      operator connection (`createOperatorApprovalsGatewayClient`, scope
 *      `operator.approvals`) and listens for a `*.requested` event, then
 *      resolves via a dedicated `*.resolve` RPC. `exec.approval.requested` /
 *      `exec.approval.resolve` are the exact same shape one layer over for
 *      exec approvals, so this source needs no new connection-bootstrap
 *      code and no new scope beyond the `operator.approvals` the issue asks
 *      for ("request only that").
 *
 * ## Kernel `kind` is a deliberate exception to the `<source>:<subkind>` rule
 *
 * `types.ts`/`gateway-approvals-bridge.ts` document every OTHER source's
 * `kind` as namespaced `"<source>:<subkind>"` (`"system-agent:restart"`,
 * `"skill-workshop:update"`). This source's `kind` is the bare literal
 * `"exec.command"` instead, matching `ima-jin/imajin-ai#2221` verbatim — the
 * kernel-side card renderer built in that issue dispatches on this exact
 * string. The `source` field (`"gateway-exec"`, set by the bridge from this
 * source's `id`) still uniquely identifies which `ApprovalSource` published
 * it and is still covered by `contentHash`, so this does not create any
 * collision or tracking ambiguity at the bridge level — it only opts this
 * one kind out of the generic namespacing convention to match its parallel
 * kernel contract.
 *
 * ## `sourceRevision`: an identity pin, not a content-revision pin
 *
 * Unlike Skill Workshop proposals (which can be revised in place while
 * pending, hence `revisionHash`), an OpenClaw exec approval record is
 * IMMUTABLE from creation until it resolves or expires — there is no RPC
 * that mutates a pending exec approval's `command`/`cwd`/etc. So there is no
 * native "this content changed" pin to reuse the way `system-agent`/`skill-
 * workshop` do. `sourceRevision` here is `` `${id}:${expiresAtMs}` `` — a
 * stable identity fingerprint for the SAME immutable record, which is all
 * the #2084 two-stage drift check needs: if the record is no longer pending
 * (resolved/expired) `getCurrent` reports `pending: false` and the bridge
 * evicts it as a no-op *before* ever comparing `sourceRevision`, so this pin
 * only has to guard against the (bug-only) case of staged content and
 * refetched content silently diverging for the same still-pending id.
 *
 * ## Never `allow-always`
 *
 * `resolve()` below is an exhaustive switch over the bridge's own
 * `ApprovalDecision` (`"approve" | "reject"` — never source-specific, see
 * `types.ts`) that only ever produces `"allow-once"` or `"deny"`. There is
 * no code path in this source, or in `GatewayApprovalsBridge.
 * handleKernelDecision` (which already drops any wire `decision` outside
 * `approve`/`reject`/`withdrawn` before a source is ever touched), that can
 * reach `exec.approval.resolve` with `"allow-always"` — see
 * `gateway-exec.test.ts`'s exhaustiveness test.
 *
 * ## Expiry
 *
 * `detail.expiresAt` mirrors the OpenClaw record's own `expiresAtMs`
 * one-for-one (never a separately-computed value) so the /jin card shows
 * exactly when OpenClaw itself will stop honoring a decision. The bridge's
 * own `getCurrent`-based pending check (shared by every source) already
 * refuses to resolve an approval OpenClaw itself no longer considers
 * pending — including one that expired locally — before this source's
 * `resolve()` is ever called, so no separate expiry check is needed here.
 *
 * ## Outcome reporting (exit code / duration / output hash)
 *
 * `ima-jin/imajin-ai#2221` does not yet define the kernel endpoint for
 * attaching a post-execution outcome to an already-decided `exec.command`
 * approval. `createHttpKernelExecOutcomeClient` below implements the
 * CLIENT side against the same `POST /notify/api/send` mechanism every
 * other kernel write in this bridge already uses (scope
 * `operator.approval.exec.outcome`) so it is fully unit-tested now;
 * TODO(#2221): once the kernel PR lands, point this at whatever dedicated
 * endpoint it defines instead, if different. `wireGatewayExecOutcomeReporting`
 * wires it to the Gateway's exec-finished signal; TODO(#2221): the
 * `"exec.approval.finished"` event name/payload this listens for in the
 * live wiring below is a best-effort placeholder (no OpenClaw doc or public
 * source snippet confirms an exec-outcome broadcast at this SDK version) —
 * it is guarded narrowly enough to be a safe no-op if the real event never
 * arrives or has a different shape, and it never blocks or affects the
 * approve/deny path above.
 */
import type {
  ApprovalDecision,
  ApprovalSource,
  ApprovalSourceCurrentState,
  ApprovalSourceRequest,
  Unsubscribe,
} from "./types.js";

// --- Wire types (Gateway side, `exec.approval.*`) ---

/** The decision kinds `exec.approval.resolve` accepts. This source only ever sends `"allow-once"` or `"deny"` — see module doc. */
export type GatewayExecApprovalDecisionKind = "allow-once" | "allow-always" | "deny";

/** The subset of the Gateway's internal `ExecApprovalRequestPayload` this source reads. */
export interface GatewayExecApprovalRequestPayload {
  command: string;
  commandArgv?: string[];
  cwd?: string | null;
  host?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
  allowedDecisions?: readonly GatewayExecApprovalDecisionKind[];
  [key: string]: unknown;
}

/** One `exec.approval.list` entry / `exec.approval.requested` event payload. */
export interface GatewayExecApprovalRecord {
  id: string;
  request: GatewayExecApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
}

/** Posted to the kernel after the Gateway reports an approved exec finished. */
export interface GatewayExecOutcome {
  approvalId: string;
  exitCode: number | null;
  durationMs: number;
  /** `"sha256:" + sha256hex(...)` over the captured output, never the raw output itself. */
  outputHash: string;
}

/** Abstracts the plugin's own loopback Gateway operator connection for `exec.approval.*` (#38, mirrors `system-agent.ts`'s `GatewayApprovalsClient`). */
export interface GatewayExecApprovalsClient {
  /** `exec.approval.list` — startup reconcile for approvals raised while the plugin was down. */
  list(): Promise<GatewayExecApprovalRecord[]>;
  /** `exec.approval.resolve` — decision is restricted to the two kinds this source ever sends (see module doc). */
  resolve(id: string, decision: Exclude<GatewayExecApprovalDecisionKind, "allow-always">): Promise<{ applied: boolean }>;
  /** Registers the live `exec.approval.requested` handler. */
  onRequested(handler: (record: GatewayExecApprovalRecord) => void): void;
  /** Registers a best-effort "this approved exec finished" handler (TODO(#2221) — see module doc). */
  onFinished(handler: (outcome: GatewayExecOutcome) => void): void;
}

/** Posts an exec outcome to the kernel. Client-side half of the module doc's "Outcome reporting" TODO(#2221). */
export interface KernelExecOutcomeClient {
  publishExecOutcome(outcome: GatewayExecOutcome): Promise<void>;
}

const MAX_SUMMARY_LENGTH = 2000;

/**
 * Literal kernel kind from `ima-jin/imajin-ai#2221`, NOT namespaced
 * `"gateway-exec:command"` — see module doc.
 */
export const GATEWAY_EXEC_KIND = "exec.command";

function truncateSummary(summary: string): string {
  return summary.length <= MAX_SUMMARY_LENGTH ? summary : summary.slice(0, MAX_SUMMARY_LENGTH);
}

/** Narrow, disclosed shape-check mirroring `system-agent.ts`'s/`skill-workshop.ts`'s own record filters. */
function isValidRecord(record: unknown): record is GatewayExecApprovalRecord {
  const r = record as Partial<GatewayExecApprovalRecord> | undefined;
  return (
    typeof r?.id === "string" &&
    r.id.length > 0 &&
    typeof r.request?.command === "string" &&
    typeof r.expiresAtMs === "number"
  );
}

/**
 * Builds the `ApprovalSourceRequest` for one exec approval record. `detail`
 * matches `ima-jin/imajin-ai#2221`'s schema verbatim: `{command, host, cwd,
 * agentId, sessionKey, requestedBy, approvalId, expiresAt}`. `command` is
 * NEVER truncated here (unlike Skill Workshop's `description`/`diffSummary`)
 * — the whole point of an exec approval is that the operator sees the EXACT
 * command; the Gateway itself already guarantees `request.command` fits the
 * wire budget by rejecting oversized commands at request time (see module
 * doc), so this source can safely assume it never needs to shrink it.
 */
function toApprovalSourceRequest(
  record: GatewayExecApprovalRecord,
  opts: { agentDid: string },
): ApprovalSourceRequest {
  const { command, host, cwd, agentId, sessionKey } = record.request;
  return {
    proposalId: record.id,
    kind: GATEWAY_EXEC_KIND,
    summary: truncateSummary(command),
    // Identity pin, not a content-revision pin — see module doc.
    sourceRevision: `${record.id}:${record.expiresAtMs}`,
    detail: {
      command,
      host: host ?? "gateway",
      cwd: cwd ?? null,
      agentId: agentId ?? null,
      sessionKey: sessionKey ?? null,
      requestedBy: opts.agentDid,
      approvalId: record.id,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
    },
  };
}

async function currentPending(client: GatewayExecApprovalsClient): Promise<GatewayExecApprovalRecord[]> {
  const records = await client.list();
  return records.filter(isValidRecord);
}

/**
 * Wraps a `GatewayExecApprovalsClient` as a generic `ApprovalSource` (#38).
 * `onDriftPolicy` is `"leave"` (system-agent parity): exec approval content
 * is immutable while pending (see module doc), so a mismatch here can only
 * be a bug, not a legitimate revision — there is nothing sensible to
 * re-stage.
 */
export function createGatewayExecSource(
  client: GatewayExecApprovalsClient,
  opts: { agentDid: string },
): ApprovalSource {
  return {
    id: "gateway-exec",
    onDriftPolicy: "leave",
    decisionLabels: { approve: "Allow once", reject: "Deny" },

    async list(): Promise<ApprovalSourceRequest[]> {
      const records = await currentPending(client);
      return records.map((record) => toApprovalSourceRequest(record, opts));
    },

    subscribe(onRequested): Unsubscribe {
      client.onRequested((record) => {
        if (!isValidRecord(record)) return;
        onRequested(toApprovalSourceRequest(record, opts));
      });
      // The underlying client has no `offRequested` — matches system-agent's
      // single-live-handler-for-the-connection's-lifetime posture.
      return () => {};
    },

    async getCurrent(proposalId: string): Promise<ApprovalSourceCurrentState | null> {
      const records = await currentPending(client);
      const match = records.find((record) => record.id === proposalId);
      if (!match) return { pending: false, sourceRevision: null };
      const { detail, sourceRevision } = toApprovalSourceRequest(match, opts);
      return { pending: true, sourceRevision, detail };
    },

    async resolve(
      proposalId: string,
      decision: ApprovalDecision,
      _expectedSourceRevision: string,
    ): Promise<{ applied: boolean }> {
      switch (decision) {
        case "approve":
          return client.resolve(proposalId, "allow-once");
        case "reject":
          return client.resolve(proposalId, "deny");
        default: {
          // Exhaustive per `ApprovalDecision` ("approve" | "reject" only) —
          // fails loudly rather than ever reaching `exec.approval.resolve`
          // with anything else, including "allow-always" (module doc).
          const exhaustive: never = decision;
          throw new Error(`gateway-exec: refusing to resolve unsupported decision "${String(exhaustive)}"`);
        }
      }
    },
  };
}

// --- Outcome reporting (client-side proven now; trigger is TODO(#2221), see module doc) ---

/** Live `KernelExecOutcomeClient` over the same `POST /notify/api/send` mechanism every other kernel write in this bridge uses. */
export function createHttpKernelExecOutcomeClient(opts: {
  nodeUrl: string;
  webhookSecret: string;
  operatorDid: string;
}): KernelExecOutcomeClient {
  const baseUrl = opts.nodeUrl.replace(/\/$/, "");
  return {
    async publishExecOutcome(outcome: GatewayExecOutcome): Promise<void> {
      // TODO(#2221): switch to the dedicated outcome/follow-up endpoint the
      // kernel PR defines, if it differs from the generic notify mechanism.
      const res = await fetch(`${baseUrl}/notify/api/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-secret": opts.webhookSecret,
        },
        body: JSON.stringify({
          to: opts.operatorDid,
          scope: "operator.approval.exec.outcome",
          data: outcome,
        }),
      });
      if (!res.ok) {
        throw new Error(`kernel notify operator.approval.exec.outcome failed (${res.status}): ${await res.text()}`);
      }
    },
  };
}

/**
 * Wires a `GatewayExecApprovalsClient`'s best-effort finished-exec signal to
 * the kernel outcome client. Isolated from `createGatewayExecSource` since
 * outcome reporting is not part of the generic `ApprovalSource` contract
 * (no other source has a post-decision "how did it go" leg) — this is a
 * `gateway-exec`-specific side channel the bridge wires up alongside the
 * source itself. Errors are logged, never thrown — a failed outcome POST
 * must never affect the approve/deny path.
 */
export function wireGatewayExecOutcomeReporting(
  client: GatewayExecApprovalsClient,
  kernel: KernelExecOutcomeClient,
  logger: { error: (msg: string) => void } = console,
): Unsubscribe {
  client.onFinished((outcome) => {
    void kernel.publishExecOutcome(outcome).catch((err: unknown) => {
      logger.error(`[imajin-approvals-bridge] failed to publish exec outcome for ${outcome.approvalId}: ${String(err)}`);
    });
  });
  return () => {};
}

// --- Live wiring (SDK/network — isolated from the pure adapter above) ---

/**
 * Builds the live `GatewayExecApprovalsClient`. Reuses the SAME Gateway
 * connection factory `system-agent.ts`/`skill-workshop.ts` use
 * (`createOperatorApprovalsGatewayClient`, `openclaw/plugin-sdk/gateway-
 * runtime`) since it is the only plugin-SDK-exposed loopback-operator-
 * connection bootstrap at this SDK version, and its declared
 * `scopes: ["operator.approvals"]` is exactly the scope this source needs
 * (module doc: "request only that").
 */
export async function createLiveGatewayExecConnection(
  api: { runtime?: { config?: { current?: () => Record<string, unknown> } } },
  opts: { gatewayTokenOverride?: string; clientDisplayName: string },
): Promise<{ client: GatewayExecApprovalsClient; start: () => Promise<void>; stop: () => void }> {
  const { createOperatorApprovalsGatewayClient, startGatewayClientWhenEventLoopReady } = await import(
    "openclaw/plugin-sdk/gateway-runtime"
  );

  let requestedHandler: ((record: GatewayExecApprovalRecord) => void) | undefined;
  let finishedHandler: ((outcome: GatewayExecOutcome) => void) | undefined;

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
      if (evt.event === "exec.approval.requested") {
        const record = evt.payload as GatewayExecApprovalRecord | undefined;
        if (isValidRecord(record)) requestedHandler?.(record);
        return;
      }
      // TODO(#2221): best-effort/placeholder event name — see module doc.
      if (evt.event === "exec.approval.finished") {
        const outcome = evt.payload as Partial<GatewayExecOutcome> | undefined;
        if (
          typeof outcome?.approvalId === "string" &&
          typeof outcome.durationMs === "number" &&
          typeof outcome.outputHash === "string"
        ) {
          finishedHandler?.({
            approvalId: outcome.approvalId,
            exitCode: typeof outcome.exitCode === "number" ? outcome.exitCode : null,
            durationMs: outcome.durationMs,
            outputHash: outcome.outputHash,
          });
        }
      }
    },
    onConnectError: (err) => {
      console.error(`[imajin-approvals-bridge] gateway-exec connect error: ${String(err)}`);
    },
    onClose: (code, reason) => {
      console.warn(`[imajin-approvals-bridge] gateway-exec connection closed (${code}): ${reason ?? ""}`);
    },
  });

  const client: GatewayExecApprovalsClient = {
    async list() {
      const records = await gatewayClient.request<GatewayExecApprovalRecord[]>("exec.approval.list", {});
      return (records ?? []).filter(isValidRecord);
    },
    async resolve(id: string, decision: Exclude<GatewayExecApprovalDecisionKind, "allow-always">) {
      const result = await gatewayClient.request<{ applied: boolean }>("exec.approval.resolve", { id, decision });
      return { applied: result?.applied === true };
    },
    onRequested(handler) {
      requestedHandler = handler;
    },
    onFinished(handler) {
      finishedHandler = handler;
    },
  };

  return {
    client,
    start: async () => {
      const readiness = await startGatewayClientWhenEventLoopReady(gatewayClient, { clientOptions: {} });
      if (!readiness.ready) {
        throw new Error("gateway approvals bridge: gateway-exec client failed to start");
      }
    },
    stop: () => gatewayClient.stop(),
  };
}
