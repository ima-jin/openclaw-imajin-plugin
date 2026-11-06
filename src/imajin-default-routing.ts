/**
 * `imajin/default` and unconfigured non-gateway agent defaults follow their
 * own kernel picks. Explicit selections stay pinned. Host context verified
 * against openclaw@2026.10.9 before_model_resolve.
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
interface RoutingContext { agentId?: string; runId?: string; modelProviderId?: string; modelId?: string }
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
  cacheForAgent?: (agentId: string) => Promise<ImajinCatalogCache>;
  hasIdentity?: (agentId: string) => boolean;
  gatewayAgent?: string;
  baseUrl: string;
  getConfig: () => unknown;
  probe?: (baseUrl: string) => Promise<ImajinProxyHealthz>;
}) {
  // A hook exception is swallowed by host model resolution. The later blocking
  // gate must therefore remember failed admission, not let "default" reach a
  // kernel that may itself resolve an unknown id to its first available brain.
  const admissions = new Map<string, boolean>();
  function tenantDefault(ctx: RoutingContext): boolean {
    if (!deps.cacheForAgent || !deps.gatewayAgent || !ctx.agentId || ctx.agentId === deps.gatewayAgent) return false;
    if (deps.hasIdentity && !deps.hasIdentity(ctx.agentId)) return false;
    if (ctx.modelProviderId?.startsWith("imajin")) return false;
    const config = deps.getConfig() as {
      agents?: { entries?: Record<string, { model?: unknown }>; list?: Array<{ id: string; model?: unknown }>;
        defaults?: { model?: string | { primary?: string } } };
    } | undefined;
    const own = config?.agents?.entries?.[ctx.agentId]
      ?? config?.agents?.list?.find((entry) => entry.id === ctx.agentId);
    if (own?.model) return false;
    const configured = config?.agents?.defaults?.model;
    const ref = typeof configured === "string" ? configured : configured?.primary;
    // A deliberate session/wake override is not an inherited default.
    return !ref || !ctx.modelProviderId || !ctx.modelId || ref === `${ctx.modelProviderId}/${ctx.modelId}`;
  }
  function admit(ctx: RoutingContext, allowed: boolean): void {
    if (!ctx.runId) return;
    admissions.set(ctx.runId, allowed);
    if (admissions.size > 500) admissions.delete(admissions.keys().next().value!);
  }
  function block(reason: string) {
    return { outcome: "block" as const, reason,
      message: `${reason}; check imajin_status and the catalog approval card.` };
  }
  function defaultAdmission(ctx: RoutingContext) {
    const allowed = ctx.runId ? admissions.get(ctx.runId) : undefined;
    if (allowed === false || ((followsDefault(ctx) || tenantDefault(ctx)) && allowed !== true)) {
      return block("Kernel default model unavailable or denied by live policy");
    }
  }
  async function identityAdmission(agentId: string, ctx: RoutingContext) {
    // Explicit model.primary, session and CLI selections can skip automatic
    // routing entirely. Admission must consult the caller's own discovery,
    // not a remembered routing success or the last-good models on a failure.
    const prefix = `Imajin agents.${agentId} kernel discovery`;
    try {
      if (!deps.cacheForAgent) return block(`${prefix} unavailable: agent catalog missing`);
      const state = await (await deps.cacheForAgent(agentId)).get();
      if (state.outcome !== "ok") {
        const status = state.httpStatus === undefined ? "" : ` HTTP ${state.httpStatus}`;
        return block(`${prefix} refused (${state.outcome}${status}): ${state.error ?? "no usable kernel route"}`);
      }
      return defaultAdmission(ctx);
    } catch {
      // Identity/secret-provider exceptions may contain private material.
      return block(`${prefix} unavailable: agent identity or discovery runtime unavailable`);
    }
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
      if (ctx.agentId && deps.hasIdentity?.(ctx.agentId)) return identityAdmission(ctx.agentId, ctx);
      return defaultAdmission(ctx);
    },
    onAgentEnd(_event: unknown, ctx: RoutingContext = {}) {
      if (ctx.runId) admissions.delete(ctx.runId);
    },
    async beforeModelResolve(_event: unknown, ctx: RoutingContext = {}) {
      const automatic = tenantDefault(ctx);
      if (!followsDefault(ctx) && !automatic) return;
      admit(ctx, false);
      const cache = deps.cacheForAgent
        ? await deps.cacheForAgent(ctx.agentId!) : deps.cache;
      let state = await cache.get();
      await (deps.probe ?? fetchImajinProxyHealthz)(deps.baseUrl);
      // Refresh stale discovery, but never spend through a direct-provider fallback (#150).
      if (state.outcome === "unreachable") state = await cache.refresh();
      state = cache.peek() ?? state;
      if (deps.cacheForAgent && state.outcome !== "ok" && state.outcome !== "empty") return;
      // Re-read live policy after IO; never bypass a concurrent restriction.
      const policy = readRoutingPolicy(deps.getConfig);
      if (!policy) return;
      const model = state.models.find((entry) => entry.picked);
      if (!model) {
        // A successful empty discovery means no Imajin route; retain the configured default.
        if (automatic && state.outcome === "empty") admit(ctx, true);
        return;
      }
      if (!isImajinModelAllowedByPolicy(policy.allow, model.id)) return;
      admit(ctx, true);
      return { providerOverride: IMAJIN_PROVIDER_ID, modelOverride: model.id };
    },
  };
}
