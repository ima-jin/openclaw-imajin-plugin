/**
 * `imajin/default` is the only floating selector. Explicit imajin/<id> and
 * other providers never enter this hook. Host context fields verified against
 * openclaw@2026.10.4 prepare.runtime / before_model_resolve.
 */
import {
  IMAJIN_DEFAULT_MODEL_ID, IMAJIN_PROVIDER_ID, fetchImajinProxyHealthz, isDirectModelRef,
  type ImajinCatalogCache, type ImajinProxyHealthz, type ImajinCatalogCacheState,
} from "./imajin-provider.js";
import { isImajinModelAllowedByPolicy, isModelRefAllowedByPolicy } from "./sources/imajin-catalog.js";

export interface ImajinDefaultRoutingStatus {
  selector: "imajin/default";
  pickedModel: string | null;
  fallbackCount: number;
  lastReason: string | null;
  lastFallbackAt: string | null;
}

interface RoutingPolicy { allow?: string[]; breakGlassModel?: string }
interface RoutingContext { runId?: string; modelProviderId?: string; modelId?: string }
const followsDefault = (ctx: RoutingContext) =>
  ctx.modelProviderId === IMAJIN_PROVIDER_ID && ctx.modelId === IMAJIN_DEFAULT_MODEL_ID;

function readRoutingPolicy(getConfig: () => unknown): RoutingPolicy | undefined {
  const config = getConfig() as {
    agents?: { defaults?: { modelPolicy?: { allow?: string[] } } };
    plugins?: { entries?: { imajin?: { config?: { modelDiscovery?: { breakGlassModel?: string } } } } };
  } | undefined;
  if (!config || typeof config !== "object") return;
  const allow = config.agents?.defaults?.modelPolicy?.allow;
  if (allow !== undefined && (!Array.isArray(allow) || allow.some((ref) => typeof ref !== "string"))) return;
  return { allow, breakGlassModel: config.plugins?.entries?.imajin?.config?.modelDiscovery?.breakGlassModel };
}

function outageReason(health: ImajinProxyHealthz, state: ImajinCatalogCacheState): string | null {
  if (!health.ok && (health.status === undefined || [502, 503, 504].includes(health.status))) {
    return "passthrough_unreachable";
  }
  return state.outcome === "unreachable" ? "kernel_unreachable" : null;
}

function directOverride(policy: RoutingPolicy, reason: string | null) {
  const direct = policy.breakGlassModel;
  if (!reason || !isDirectModelRef(direct) || !isModelRefAllowedByPolicy(policy.allow, direct)) return;
  const slash = direct.indexOf("/");
  return { providerOverride: direct.slice(0, slash), modelOverride: direct.slice(slash + 1) };
}

export function createImajinDefaultRouter(deps: {
  cache: ImajinCatalogCache;
  baseUrl: string;
  getConfig: () => unknown;
  probe?: (baseUrl: string) => Promise<ImajinProxyHealthz>;
  now?: () => number;
}) {
  let fallbackCount = 0;
  let lastReason: string | null = null;
  let lastFallbackAt: string | null = null;
  // A hook exception is swallowed by host model resolution. The later blocking
  // gate must therefore remember failed admission, not let "default" reach a
  // kernel that may itself resolve an unknown id to its first available brain.
  const admissions = new Map<string, boolean>();
  function admit(ctx: RoutingContext, allowed: boolean): void {
    if (!ctx.runId) return;
    admissions.set(ctx.runId, allowed);
    if (admissions.size > 500) admissions.delete(admissions.keys().next().value!);
  }
  return {
    preserveExplicitOverride(ctx: RoutingContext = {}) {
      if (followsDefault(ctx)) admit(ctx, true);
    },
    status(): ImajinDefaultRoutingStatus {
      const picked = deps.cache.peek()?.models.find((model) => model.picked);
      return {
        selector: "imajin/default", pickedModel: picked ? `imajin/${picked.id}` : null,
        fallbackCount, lastReason, lastFallbackAt,
      };
    },
    beforeAgentRun(_event: unknown, ctx: RoutingContext = {}) {
      const allowed = ctx.runId ? admissions.get(ctx.runId) : undefined;
      if (allowed === false || (followsDefault(ctx) && allowed !== true)) {
        return { outcome: "block", reason: "Kernel default model unavailable or denied by live policy",
          message: "Kernel default model unavailable or denied by live policy; check imajin_status and the catalog approval card." };
      }
    },
    onAgentEnd(_event: unknown, ctx: RoutingContext = {}) {
      if (ctx.runId) admissions.delete(ctx.runId);
    },
    async beforeModelResolve(_event: unknown, ctx: RoutingContext = {}) {
      if (!followsDefault(ctx)) return;
      admit(ctx, false);
      let state = await deps.cache.get();
      const health = await (deps.probe ?? fetchImajinProxyHealthz)(deps.baseUrl);
      // Discovery transport failures can outlive an outage; recheck before spending directly.
      if (state.outcome === "unreachable") state = await deps.cache.refresh();
      state = deps.cache.peek() ?? state;
      // Re-read live policy after IO; never bypass a concurrent restriction.
      const policy = readRoutingPolicy(deps.getConfig);
      if (!policy) return;
      const reason = outageReason(health, state);
      const emergency = directOverride(policy, reason);
      if (emergency) {
        admit(ctx, true);
        fallbackCount++;
        lastReason = reason;
        lastFallbackAt = new Date((deps.now ?? Date.now)()).toISOString();
        return emergency;
      }
      const model = state.models.find((entry) => entry.picked);
      if (!model || !isImajinModelAllowedByPolicy(policy.allow, model.id)) return;
      admit(ctx, true);
      return { providerOverride: IMAJIN_PROVIDER_ID, modelOverride: model.id };
    },
  };
}
