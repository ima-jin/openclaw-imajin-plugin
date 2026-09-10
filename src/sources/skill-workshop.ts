/**
 * Skill Workshop `ApprovalSource` (#33) — the first new source added to the
 * generic gateway-approvals bridge, surfacing pending `skills.proposals.*`
 * proposals (created via `skill_workshop` / `/learn` / self-learning) on
 * /jin so they no longer pile up unseen in the OpenClaw Control UI's
 * Workshop tab.
 *
 * Every Gateway method name, scope, and param shape referenced here was
 * verified directly against the installed `openclaw@2026.9.3` package
 * (`node_modules/openclaw/dist/method-scopes-*.mjs` and
 * `node_modules/openclaw/dist/skills-*.mjs`), plus
 * `openclaw/docs/tools/skill-workshop.md` — not guessed:
 *
 *   - `skills.proposals.list` (scope `operator.read`) returns
 *     `{ proposals: [{id, kind: "create"|"update", status, title,
 *     description, skillName, skillKey, createdAt, updatedAt,
 *     scanState: "clean"|"failed", revisionHash}], installedSkills }`.
 *   - `skills.proposals.apply` / `skills.proposals.reject` (scope
 *     `operator.admin`) take `{proposalId, expectedRevisionHash,
 *     correlationId?, reason?}`. The Gateway itself throws a
 *     `SkillProposalRevisionChangedError`-shaped request error (surfaced as
 *     a `GatewayClientRequestError` with `details: {expectedRevisionHash,
 *     currentRevisionHash}`) when `expectedRevisionHash` no longer matches
 *     the live proposal — i.e. the fail-closed revision check on APPLY is
 *     already enforced server-side; this source only needs to detect and
 *     translate that specific error, not reimplement the check.
 *   - `skills.proposals.events.list` (scope `operator.read`) IS a real
 *     method, but it is scoped to one already-known `proposalId`'s own
 *     event/revision history (`{proposalId, afterSequence, limit}`) — it is
 *     not a cross-proposal "a new proposal appeared" feed, and no such feed
 *     is exposed anywhere in the SDK at this version. `subscribe()` below is
 *     therefore an honest interval poll of `skills.proposals.list` (the same
 *     method `list()` uses), diffing against proposal ids already seen in
 *     this process — not an invented push stream.
 *
 * `detail.diffSummary` is populated from the proposal's `description`
 * (bounded separately below): `skills.proposals.list`'s lightweight
 * projection carries no diff-only field distinct from the human
 * `description` — a real content diff would require `skills.proposals.
 * inspect`'s full draft body, which this lightweight polling list
 * deliberately avoids fetching for every pending proposal on every poll.
 * This is the same disclosed-heuristic posture as the system-agent source's
 * `keysTouched: []` (see `system-agent.ts`).
 */
import type { ApprovalDecision, ApprovalSource, ApprovalSourceCurrentState, ApprovalSourceRequest } from "./types.js";
import { ApprovalContentDriftError } from "./types.js";

// --- Wire types (Gateway side, `skills.proposals.*`) ---

export type SkillWorkshopProposalKind = "create" | "update";
export type SkillWorkshopScanState = "clean" | "failed";

/** One `skills.proposals.list` entry (`manifestEntryFromRecord` projection). */
export interface SkillWorkshopProposalSummary {
  id: string;
  kind: SkillWorkshopProposalKind;
  status: string;
  title?: string;
  description: string;
  skillName: string;
  skillKey?: string;
  scanState: SkillWorkshopScanState;
  revisionHash: string;
}

export interface SkillWorkshopListResult {
  proposals: SkillWorkshopProposalSummary[];
}

/** Abstracts the plugin's own Gateway connection for `skills.proposals.*` RPCs. */
export interface SkillWorkshopGatewayClient {
  list(): Promise<SkillWorkshopListResult>;
  apply(proposalId: string, expectedRevisionHash: string): Promise<{ applied?: boolean } | undefined>;
  reject(proposalId: string, expectedRevisionHash: string): Promise<unknown>;
}

const MAX_DETAIL_BYTES = 16 * 1024;
const MAX_DESCRIPTION_LENGTH = 2000;

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

/**
 * Bounds a `detail` object to `MAX_DETAIL_BYTES` (#2152's ≤16 KB cap) by
 * shrinking only `diffSummary` — `skillName`/`description` are never
 * truncated further here (already bounded at construction), per the issue's
 * "truncate the diff summary, never the identifiers" instruction.
 */
function boundDetail(detail: Record<string, unknown>): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(detail), "utf8") <= MAX_DETAIL_BYTES) return detail;
  const diffSummary = typeof detail.diffSummary === "string" ? detail.diffSummary : "";
  const rest = { ...detail };
  delete rest.diffSummary;
  let candidate = diffSummary;
  while (candidate.length > 0) {
    const attempt = { ...rest, diffSummary: candidate };
    if (Buffer.byteLength(JSON.stringify(attempt), "utf8") <= MAX_DETAIL_BYTES) return attempt;
    candidate = candidate.slice(0, Math.floor(candidate.length / 2));
  }
  return { ...rest, diffSummary: "" };
}

function toApprovalSourceRequest(proposal: SkillWorkshopProposalSummary): ApprovalSourceRequest {
  const description = truncate(proposal.description || proposal.title || proposal.id, MAX_DESCRIPTION_LENGTH);
  return {
    proposalId: proposal.id,
    kind: `skill-workshop:${proposal.kind}`,
    summary: description,
    sourceRevision: proposal.revisionHash,
    detail: boundDetail({
      skillName: proposal.skillName,
      kind: proposal.kind,
      scan: proposal.scanState,
      description,
      // See module doc: no richer diff is available from `list()`'s
      // lightweight projection, so the bounded description doubles as the
      // diff summary rather than inventing one from unavailable data.
      diffSummary: description,
    }),
  };
}

/** Narrow, disclosed shape-check for a Gateway RPC error carrying `SkillProposalRevisionChangedError`'s details (see module doc). */
function isRevisionChangedError(err: unknown): err is Error & { details?: { currentRevisionHash?: unknown } } {
  return (
    err instanceof Error &&
    err.name === "GatewayClientRequestError" &&
    typeof (err as { details?: unknown }).details === "object" &&
    (err as { details?: { currentRevisionHash?: unknown } }).details !== null &&
    "currentRevisionHash" in ((err as { details?: object }).details ?? {})
  );
}

async function currentPending(client: SkillWorkshopGatewayClient): Promise<SkillWorkshopProposalSummary[]> {
  const result = await client.list();
  return (result.proposals ?? []).filter((proposal) => proposal.status === "pending");
}

/**
 * Wraps a `SkillWorkshopGatewayClient` as a generic `ApprovalSource` (#33).
 * `onDriftPolicy` is `"restage"`: a proposal revised after the operator saw
 * it is never applied against its new content — it is evicted and
 * immediately re-listed so the operator sees a fresh card bound to the
 * current revision hash (see the module doc + `types.ts`).
 */
export function createSkillWorkshopSource(
  client: SkillWorkshopGatewayClient,
  opts: { pollIntervalMs?: number } = {},
): ApprovalSource {
  const pollIntervalMs = opts.pollIntervalMs ?? 15_000;
  const known = new Set<string>();

  return {
    id: "skill-workshop",
    onDriftPolicy: "restage",
    decisionLabels: { approve: "Apply", reject: "Reject" },

    async list(): Promise<ApprovalSourceRequest[]> {
      const pending = await currentPending(client);
      for (const proposal of pending) known.add(proposal.id);
      return pending.map(toApprovalSourceRequest);
    },

    subscribe(onRequested) {
      const timer = setInterval(() => {
        void currentPending(client)
          .then((pending) => {
            for (const proposal of pending) {
              if (known.has(proposal.id)) continue;
              known.add(proposal.id);
              onRequested(toApprovalSourceRequest(proposal));
            }
          })
          .catch((err: unknown) => {
            console.error(`[imajin-approvals-bridge] skill-workshop poll failed: ${String(err)}`);
          });
      }, pollIntervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },

    async getCurrent(proposalId: string): Promise<ApprovalSourceCurrentState | null> {
      const pending = await currentPending(client);
      const match = pending.find((proposal) => proposal.id === proposalId);
      if (!match) return { pending: false, sourceRevision: null };
      // #2084: return the CURRENT `detail` too (built the same way `list()`
      // does) so the bridge can recompute its full `contentHash` digest and
      // catch a proposal whose detail changed after the operator decided,
      // even in the (Skill Workshop-unlikely, but not bridge-assumed) case
      // where `revisionHash` itself did not.
      const { detail } = toApprovalSourceRequest(match);
      return { pending: true, sourceRevision: match.revisionHash, detail };
    },

    async resolve(
      proposalId: string,
      decision: ApprovalDecision,
      expectedSourceRevision: string,
    ): Promise<{ applied: boolean }> {
      try {
        if (decision === "approve") {
          const result = await client.apply(proposalId, expectedSourceRevision);
          return { applied: result?.applied !== false };
        }
        await client.reject(proposalId, expectedSourceRevision);
        return { applied: true };
      } catch (err) {
        if (isRevisionChangedError(err)) {
          throw new ApprovalContentDriftError(
            proposalId,
            `skill-workshop proposal ${proposalId} revision changed before decision ` +
              `(expected ${expectedSourceRevision}, current ${String(err.details?.currentRevisionHash)})`,
          );
        }
        throw err;
      }
    },
  };
}

// --- Live wiring (SDK/network — isolated from the pure adapter above) ---

/**
 * Builds the live `SkillWorkshopGatewayClient`. Reuses the SAME Gateway
 * connection factory as the system-agent source
 * (`createOperatorApprovalsGatewayClient`, `openclaw/plugin-sdk/gateway-
 * runtime`) since it is the only plugin-SDK-exposed loopback-operator-
 * connection bootstrap at this SDK version — see the plan's "Research
 * findings" / this PR's description for the disclosed limitation: that
 * factory declares `scopes: ["operator.approvals"]`, while
 * `skills.proposals.list` needs `operator.read` and `skills.proposals.
 * apply`/`reject` need `operator.admin`. If a deployment's Gateway enforces
 * per-connection scope checks strictly, these calls will surface as a
 * logged, swallowed RPC error (same fail-safe posture as every other call
 * in this file) rather than crash the bridge; this is flagged as follow-up
 * work for the OpenClaw plugin SDK to expose a scope-parameterized (or
 * `operator.read`+`operator.admin`) connection factory.
 */
export function createLiveSkillWorkshopGatewayClient(gatewayClient: {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}): SkillWorkshopGatewayClient {
  return {
    async list() {
      const result = await gatewayClient.request<SkillWorkshopListResult>("skills.proposals.list", {});
      return { proposals: result?.proposals ?? [] };
    },
    async apply(proposalId: string, expectedRevisionHash: string) {
      return gatewayClient.request<{ applied?: boolean }>("skills.proposals.apply", {
        proposalId,
        expectedRevisionHash,
      });
    },
    async reject(proposalId: string, expectedRevisionHash: string) {
      return gatewayClient.request("skills.proposals.reject", { proposalId, expectedRevisionHash });
    },
  };
}

/**
 * Opens this source's OWN Gateway connection (independent of the
 * system-agent source's connection, so one source's Gateway hiccup never
 * takes the other down) via the same `createOperatorApprovalsGatewayClient`
 * bootstrap `system-agent.ts` uses — see `createLiveSkillWorkshopGatewayClient`'s
 * doc for the disclosed connection-scope limitation this implies.
 */
export async function createLiveSkillWorkshopConnection(
  api: { runtime?: { config?: { current?: () => Record<string, unknown> } } },
  opts: { gatewayTokenOverride?: string; clientDisplayName: string; pollIntervalMs?: number },
): Promise<{ client: SkillWorkshopGatewayClient; start: () => Promise<void>; stop: () => void }> {
  const { createOperatorApprovalsGatewayClient, startGatewayClientWhenEventLoopReady } = await import(
    "openclaw/plugin-sdk/gateway-runtime"
  );

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
    onConnectError: (err) => {
      console.error(`[imajin-approvals-bridge] skill-workshop gateway connect error: ${String(err)}`);
    },
    onClose: (code, reason) => {
      console.warn(`[imajin-approvals-bridge] skill-workshop gateway connection closed (${code}): ${reason ?? ""}`);
    },
  });

  return {
    client: createLiveSkillWorkshopGatewayClient(gatewayClient),
    start: async () => {
      const readiness = await startGatewayClientWhenEventLoopReady(gatewayClient, { clientOptions: {} });
      if (!readiness.ready) {
        throw new Error("gateway approvals bridge: skill-workshop gateway client failed to start");
      }
    },
    stop: () => gatewayClient.stop(),
  };
}
