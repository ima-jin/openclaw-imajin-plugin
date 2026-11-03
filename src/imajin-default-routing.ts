/**
 * `imajin/default` is the only floating selector. Explicit imajin/<id> and
 * other providers never enter this hook. Host context fields verified against
 * openclaw@2026.10.4 prepare.runtime / before_model_resolve.
 */
import {
  IMAJIN_DEFAULT_MODEL_ID, IMAJIN_PROVIDER_ID, fetchImajinProxyHealthz,
  type ImajinCatalogCache, type ImajinProxyHealthz,
} from "./imajin-provider.js";
import { isImajinModelAllowedByPolicy } from "./sources/imajin-catalog.js";

export interface ImajinDefaultRoutingStatus {
  selector: "imajin/default";
  pickedModel: string | null;
  fallbackCount: number;
  lastReason: string | null;
  lastFallbackAt: string | null;
}

interface RoutingPolicy { allow?: string[] }
interface RoutingContext { runId?: string; modelProviderId?: string; modelId?: string }
const followsDefault = (ctx: RoutingContext) =>
  ctx.modelProviderId === IMAJIN_PROVIDER_ID && ctx.modelId === IMAJIN_DEFAULT_MODEL_ID;

function readRoutingPolicy(getConfig: () => unknown): RoutingPolicy | undefined {
  const config = getConfig() as {
    agents?: { defaults?: { modelPolicy?: { allow?: string[] } } };
  } | undefined;
  if (!config || typeof config !== "object") return;
  const allow = config.agents?.defaults?.modelPolicy?.allow;
  if (allow !== undefined && (!Array.isArray(allow) || allow.some((ref) => typeof ref !== "string"))) return;
  return { allow };
}

export function createImajinDefaultRouter(deps: {
  cache: ImajinCatalogCache;
  baseUrl: string;
  getConfig: () => unknown;
  probe?: (baseUrl: string) => Promise<ImajinProxyHealthz>;
}) {
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
        fallbackCount: 0, lastReason: null, lastFallbackAt: null,
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
      await (deps.probe ?? fetchImajinProxyHealthz)(deps.baseUrl);
      // Refresh stale discovery, but never spend through a direct-provider fallback (#150).
      if (state.outcome === "unreachable") state = await deps.cache.refresh();
      state = deps.cache.peek() ?? state;
      // Re-read live policy after IO; never bypass a concurrent restriction.
      const policy = readRoutingPolicy(deps.getConfig);
      if (!policy) return;
      const model = state.models.find((entry) => entry.picked);
      if (!model || !isImajinModelAllowedByPolicy(policy.allow, model.id)) return;
      admit(ctx, true);
      return { providerOverride: IMAJIN_PROVIDER_ID, modelOverride: model.id };
    },
  };
}
