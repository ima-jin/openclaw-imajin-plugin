/**
 * OpenClaw system-agent `ApprovalSource` (#33, refactored out of #24's
 * originally-hardwired `gateway-approvals-bridge.ts` with zero behaviour
 * change).
 *
 * Observes the plugin's OWN loopback Gateway operator connection (scoped
 * `operator.approvals` — never anything broader) for staged system-agent
 * proposals (gateway restart / config mutation) via `openclaw.approval.list`
 * / `openclaw.approval.requested`, and carries operator decisions back via
 * `approval.resolve`.
 *
 * `keysTouched` is always `[]` and `kind` is a disclosed heuristic over
 * `title`/`description`/`command` (`deriveProposalKind`) — the Gateway's
 * `SystemAgentApprovalRequestPayload` (`openclaw/src/infra/system-agent-
 * approvals.ts`) carries no structured kind or touched-keys list. See the
 * #24 investigation notes preserved from the original module doc.
 */
import type {
  ApprovalDecision,
  ApprovalSource,
  ApprovalSourceCurrentState,
  ApprovalSourceRequest,
} from "./types.js";

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

const MAX_SUMMARY_LENGTH = 2000;

/**
 * Disclosed heuristic: the Gateway's `SystemAgentApprovalRequestPayload`
 * carries no structured `kind` (only a human `title`/`description`/`command`
 * — see the #24 investigation comment and `openclaw/src/gateway/server-
 * methods/system-agent-approval.ts`, which always sets `title: "OpenClaw
 * change"`). This maps free text to one of two subkinds, defaulting to
 * `"other"` when neither a restart nor a config-mutation keyword is found —
 * never guessed more specifically than that. The bridge namespaces this as
 * `system-agent:<subkind>` for the kernel's open kind vocabulary (#2152).
 */
export function deriveProposalKind(
  request: Pick<SystemAgentApprovalRequestPayload, "title" | "description" | "command">,
): "restart" | "config-mutation" | "other" {
  const text = `${request.title ?? ""} ${request.description ?? ""} ${request.command ?? ""}`.toLowerCase();
  if (/\brestart(ing|ed)?\b/.test(text)) return "restart";
  if (/\bconfig(uration)?\b|\bmutat(e|ion|ing)\b|\bset\b/.test(text)) return "config-mutation";
  return "other";
}

function truncateSummary(summary: string): string {
  return summary.length <= MAX_SUMMARY_LENGTH ? summary : summary.slice(0, MAX_SUMMARY_LENGTH);
}

function toApprovalSourceRequest(record: SystemAgentApprovalRequestRecord): ApprovalSourceRequest {
  return {
    proposalId: record.id,
    kind: `system-agent:${deriveProposalKind(record.request)}`,
    summary: truncateSummary(record.request.description || record.request.title || record.id),
    contentHash: record.request.proposalHash,
  };
}

/**
 * Wraps a `GatewayApprovalsClient` as a generic `ApprovalSource` (#33).
 * `onDriftPolicy` is explicitly `"leave"`: a content-hash mismatch keeps the
 * proposal tracked with its stale hash exactly as #24 originally behaved —
 * required for this refactor's "zero behaviour change" acceptance bar.
 */
export function createSystemAgentSource(client: GatewayApprovalsClient): ApprovalSource {
  return {
    id: "system-agent",
    onDriftPolicy: "leave",

    async list(): Promise<ApprovalSourceRequest[]> {
      const records = await client.list();
      return records.map(toApprovalSourceRequest);
    },

    subscribe(onRequested) {
      client.onRequested((record) => onRequested(toApprovalSourceRequest(record)));
      // The underlying GatewayApprovalsClient has no `offRequested` — this
      // matches #24's original lifecycle, where the single live handler
      // lives for the process/connection's lifetime.
      return () => {};
    },

    async getCurrent(proposalId: string): Promise<ApprovalSourceCurrentState | null> {
      const snapshot = await client.get(proposalId);
      if (!snapshot) return null;
      return {
        pending: snapshot.status === "pending",
        contentHash: snapshot.presentation?.proposalHash ?? null,
      };
    },

    // `_expectedContentHash` is intentionally unused: system-agent's own
    // anti-tamper check already happened at the bridge level via `getCurrent`
    // (`approval.get`'s live `proposalHash`, #24's original check) before
    // `resolve` is ever called, and the Gateway's own `approval.resolve` has
    // no revision-binding parameter to forward it to.
    async resolve(
      proposalId: string,
      decision: ApprovalDecision,
      _expectedContentHash: string,
    ): Promise<{ applied: boolean }> {
      const gatewayDecision: SystemAgentApprovalDecisionKind = decision === "approve" ? "allow-once" : "deny";
      return client.resolve(proposalId, gatewayDecision);
    },
  };
}

// --- Live wiring (SDK/network — isolated from the pure adapter above) ---

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
