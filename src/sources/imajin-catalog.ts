/**
 * Opt-in live catalog reconciliation (#105). One signed card lists exact
 * allow-list additions/removals. Only a verified operator decision writes
 * config; provider blocks and lane defaults are never changed.
 */
import { createHash, randomUUID } from "node:crypto";
import { ApprovalContentDriftError, type ApprovalDecision, type ApprovalSource,
  type ApprovalSourceCurrentState, type ApprovalSourceRequest } from "./types.js";
import { IMAJIN_PROVIDER_ID, type ImajinRuntimeModel } from "../imajin-provider.js";
import { createOperatorGatewayClient } from "../gateway-operator-client.js";

const PROPOSAL_PREFIX = "imajin-catalog:";

/** Builds the `imajin/<modelId>` ref this source proposes adding to the allow list. */
export function buildImajinModelRef(modelId: string): string {
  return `${IMAJIN_PROVIDER_ID}/${modelId}`;
}
/** Read-only status; unknown config must never be reported as an allow-any policy. */
export function buildImajinAllowListStatus(models: readonly ImajinRuntimeModel[], config: unknown) {
  const root = config as { agents?: { defaults?: { modelPolicy?: { allow?: unknown } } } } | undefined;
  const allow = root?.agents?.defaults?.modelPolicy?.allow;
  const readable = config !== null && typeof config === "object" &&
    (allow === undefined || (Array.isArray(allow) && allow.every((ref) => typeof ref === "string")));
  const refs = [...new Set(models.map((model) => buildImajinModelRef(model.id)))].sort();
  const configured = readable ? (allow ?? []) as string[] : null;
  return {
    configured,
    allowListed: configured === null ? null : refs.filter((ref) =>
      isImajinModelAllowedByPolicy(configured, ref.slice("imajin/".length))),
    discoveredButNotAllowed: configured === null ? null : refs.filter((ref) =>
      !isImajinModelAllowedByPolicy(configured, ref.slice("imajin/".length))),
  };
}

/**
 * `agents.defaults.modelPolicy.allow` matcher, mirroring OpenClaw's own
 * documented contract: omitted/empty allows any model; entries are exact
 * refs or trailing `provider/*`-style wildcards.
 */
export function isImajinModelAllowedByPolicy(
  allow: readonly string[] | undefined,
  modelId: string,
): boolean {
  if (!allow || allow.length === 0) return true;
  const ref = buildImajinModelRef(modelId);
  for (const rawEntry of allow) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (entry === ref) return true;
    if (entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      if (ref.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** Wildcards and aliases are standing operator policy, never retired. */
function isExactRef(ref: string, prefix: string): boolean {
  return ref.startsWith(prefix) && ref.length > prefix.length && !ref.includes("*");
}

export function buildImajinAllowListDelta(
  models: readonly ImajinRuntimeModel[], allow: readonly string[],
): { add: string[]; remove: string[] } {
  const discovered = new Set(models.map((model) => buildImajinModelRef(model.id)));
  const add = [...discovered].filter((ref) =>
    !isImajinModelAllowedByPolicy(allow, ref.slice("imajin/".length))).sort();
  const remove = [...new Set(allow)].filter((ref) => {
    if (isExactRef(ref, "imajin/")) return !discovered.has(ref);
    const prefix = ["imajin-openai/", "imajin-xai/"].find((p) => isExactRef(ref, p));
    if (!prefix) return false;
    const id = ref.slice(prefix.length);
    // First enable the replacement; only a subsequent card retires legacy.
    return discovered.has(buildImajinModelRef(id)) && isImajinModelAllowedByPolicy(allow, id);
  }).sort();
  return { add, remove };
}

export interface ImajinModelPolicyGatewayClient {
  getConfig(): Promise<{ hash: string; allow: string[] }>;
  patchModelPolicyAllow(nextAllow: string[], baseHash: string): Promise<void>;
}

export interface ImajinCatalogSourceDeps {
  listDiscoveredModels: () => readonly ImajinRuntimeModel[];
  /** Only a successful (including empty) discovery is authoritative. */
  isDiscoveryReady: () => boolean;
  gateway: ImajinModelPolicyGatewayClient;
}

/** Stored alongside the bridge's signed proposal/outcome history. */
export interface ImajinCatalogProposalState {
  revision: string | null;
  proposalId: string | null;
  dismissed: boolean;
}

/** Startup reconciliation and polling share a persisted identity per delta. */
export function createImajinCatalogSource(
  deps: ImajinCatalogSourceDeps,
  opts: {
    pollIntervalMs?: number;
    state?: ImajinCatalogProposalState;
    persistState?: () => Promise<void>;
  } = {},
): ApprovalSource {
  const pollIntervalMs = opts.pollIntervalMs ?? 15_000;
  const proposalState = opts.state ?? { revision: null, proposalId: null, dismissed: false };
  const known = new Map<string, number | undefined>();
  async function identify(sourceRevision: string | null): Promise<string | null> {
    if (proposalState.revision !== sourceRevision) {
      proposalState.revision = sourceRevision;
      proposalState.proposalId = sourceRevision === null ? null : `${PROPOSAL_PREFIX}${randomUUID()}`;
      proposalState.dismissed = false;
      await opts.persistState?.();
    }
    return proposalState.dismissed ? null : proposalState.proposalId;
  }

  async function pending() {
    if (!deps.isDiscoveryReady()) return null;
    const current = await deps.gateway.getConfig();
    // Discovery may have changed or failed while config.get was in flight.
    if (!deps.isDiscoveryReady()) return null;
    const delta = buildImajinAllowListDelta(deps.listDiscoveredModels(), current.allow);
    if (delta.add.length === 0 && delta.remove.length === 0) {
      await identify(null);
      return null;
    }
    const emptiesPolicy = delta.add.length === 0 && current.allow.every((ref) => delta.remove.includes(ref));
    const detail = {
      ...delta, path: "agents.defaults.modelPolicy.allow",
      ...(emptiesPolicy ? {
        warning: "Removing every allow-list entry makes OpenClaw allow any configured model. Reject to retain the restriction.",
      } : {}),
    };
    // Reserve room under the kernel's 16 KB cap for bridge metadata.
    if (Buffer.byteLength(JSON.stringify(detail)) > 14_000) {
      throw new Error("imajin-catalog reconciliation exceeds the approval detail limit");
    }
    const sourceRevision = createHash("sha256").update(JSON.stringify(detail)).digest("hex");
    const proposalId = await identify(sourceRevision);
    if (!proposalId) return null;
    const request: ApprovalSourceRequest = {
      proposalId, sourceRevision, detail,
      kind: "imajin-catalog:reconcile",
      summary: `Update Imajin allow-list: add ${delta.add.length}, remove ${delta.remove.length}?`,
    };
    return { ...current, request, delta };
  }

  return {
    id: "imajin-catalog",
    onDriftPolicy: "restage",
    decisionLabels: { approve: "Apply", reject: "Ignore" },
    async list(): Promise<ApprovalSourceRequest[]> {
      const state = await pending();
      if (!state) return [];
      if (!known.has(state.request.proposalId)) known.set(state.request.proposalId, undefined);
      return [state.request];
    },
    subscribe(onRequested) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout>;
      const poll = async (): Promise<void> => {
        try {
          const state = await pending();
          if (!stopped && state) {
            const { request } = state;
            const retryAt = known.get(request.proposalId);
            if (!known.has(request.proposalId) || (retryAt !== undefined && Date.now() > retryAt)) {
              known.set(request.proposalId, undefined);
              onRequested(request);
            }
          }
        } catch {
          console.warn("[imajin-approvals-bridge] imajin-catalog refresh unavailable; no policy changes applied");
        } finally {
          if (!stopped) schedule();
        }
      };
      const schedule = (): void => {
        timer = setTimeout(() => { void poll(); }, pollIntervalMs);
        timer.unref?.();
      };
      schedule();
      return () => { stopped = true; clearTimeout(timer); };
    },
    onPublishFailed(proposalId, failure) {
      if (failure) known.set(proposalId, failure.retryAtMs);
      else known.delete(proposalId);
    },
    async getCurrent(proposalId: string): Promise<ApprovalSourceCurrentState | null> {
      if (!proposalId.startsWith(PROPOSAL_PREFIX)) return null;
      const state = await pending();
      if (state?.request.proposalId !== proposalId) return { pending: false, sourceRevision: null };
      return { pending: true, sourceRevision: state.request.sourceRevision, detail: state.request.detail };
    },
    async resolve(proposalId: string, decision: ApprovalDecision, expectedSourceRevision: string) {
      if (!proposalId.startsWith(PROPOSAL_PREFIX)) return { applied: false };
      const state = await pending();
      if (state?.request.proposalId !== proposalId || state.request.sourceRevision !== expectedSourceRevision) {
        throw new ApprovalContentDriftError(proposalId, "imajin-catalog allow-list delta changed before decision");
      }
      if (decision === "reject") {
        proposalState.dismissed = true;
        await opts.persistState?.();
        return { applied: true };
      }
      await deps.gateway.patchModelPolicyAllow(
        [...state.allow.filter((ref) => !state.delta.remove.includes(ref)), ...state.delta.add], state.hash,
      );
      // A recurrence needs fresh consent, not a consumed replay-guard id.
      await identify(null);
      return { applied: true };
    },
  };
}

/** Config RPC errors fail closed; never fall back to editing local files. */
export function createLiveImajinModelPolicyGatewayClient(gatewayClient: {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}): ImajinModelPolicyGatewayClient {
  return {
    async getConfig() {
      const result = await gatewayClient.request<{
        hash?: string;
        config?: { agents?: { defaults?: { modelPolicy?: { allow?: string[] } } } };
      }>("config.get", {});
      const allow = result?.config?.agents?.defaults?.modelPolicy?.allow;
      if (!result?.hash || !result.config || (allow !== undefined &&
          (!Array.isArray(allow) || allow.some((ref) => typeof ref !== "string")))) {
        throw new Error("imajin-catalog received an invalid config snapshot");
      }
      return { hash: result.hash, allow: allow ?? [] };
    },
    async patchModelPolicyAllow(nextAllow, baseHash) {
      const raw = JSON.stringify({
        agents: { defaults: { modelPolicy: { allow: nextAllow } } },
      });
      await gatewayClient.request("config.patch", {
        raw,
        baseHash,
        // Replace exactly this array, preserving unrelated config.
        replacePaths: ["agents.defaults.modelPolicy.allow"],
      });
    },
  };
}

/**
 * Opens this source's OWN Gateway connection (independent of the other
 * sources' connections). Config RPCs need operator.admin; use the existing
 * scope-parameterized loopback helper only for this opt-in source.
 */
export async function createLiveImajinCatalogConnection(
  api: { runtime?: { config?: { current?: () => Record<string, unknown> } } },
  opts: { gatewayTokenOverride?: string; clientDisplayName: string },
): Promise<{ client: ImajinModelPolicyGatewayClient; start: () => Promise<void>; stop: () => void }> {
  const { startGatewayClientWhenEventLoopReady } = await import(
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

  const gatewayClient = await createOperatorGatewayClient({
    config: bootstrapConfig,
    scopes: ["operator.admin"],
    clientDisplayName: opts.clientDisplayName,
    onConnectError: (err) => {
      console.error(`[imajin-approvals-bridge] imajin-catalog gateway connect error: ${String(err)}`);
    },
    onClose: (code, reason) => {
      console.warn(
        `[imajin-approvals-bridge] imajin-catalog gateway connection closed (${code}): ${reason ?? ""}`,
      );
    },
  });

  return {
    client: createLiveImajinModelPolicyGatewayClient(gatewayClient),
    start: async () => {
      const readiness = await startGatewayClientWhenEventLoopReady(gatewayClient, { clientOptions: {} });
      if (!readiness.ready) {
        throw new Error("gateway approvals bridge: imajin-catalog gateway client failed to start");
      }
    },
    stop: () => gatewayClient.stop(),
  };
}
