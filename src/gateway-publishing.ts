import { join } from "node:path";
import type { GatewayAgentIdentity } from "./agent-plugin.js";
import { agentNotifications } from "./agent-identities.js";
import { registerLoopLifecycle, type LoopsConfig } from "./loop-hooks.js";
import { registerHorizonSync, type HorizonConfig } from "./horizon/sync.js";
import { createTurnUsageAttestationHandler, type TurnUsageAttestationConfig } from "./turn-usage-attestation.js";
import type { RegistrationLifecycle } from "./registration-lifecycle.js";
import type { RuntimeHookRegister } from "./plugin-service-runtime.js";

interface PublishingConfig {
  nodeUrl: string;
  loops?: LoopsConfig;
  horizon?: HorizonConfig;
  attestation?: TurnUsageAttestationConfig;
}

function ownsSession(agentId: string, value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`agent:${agentId}:`) && value.length > agentId.length + 7;
}
function ownsContext(agentId: string, ctx: any): boolean {
  return !ctx?.agentId || ctx.agentId === agentId;
}

function scopedCronContext(ctx: any, ownedJobs: ReadonlySet<string>) {
  return {
    ...ctx,
    getCron: () => ({
      list: async () => {
        const jobs = await ctx.getCron?.()?.list({ includeDisabled: true });
        return jobs?.filter((job: { id?: string }) => job.id && ownedJobs.has(job.id)) ?? [];
      },
    }),
  };
}

function scopeLoopHook(agentId: string, hook: string, event: any, ctx: any, ownedJobs: Set<string>) {
  if (!ownsContext(agentId, ctx)) return undefined;
  const subagent = hook.startsWith("subagent_");
  const key = subagent ? ctx?.childSessionKey ?? ctx?.sessionKey : ctx?.sessionKey;
  if (!ownsSession(agentId, key)) return undefined;
  if (ctx?.sessionKey !== undefined && !ownsSession(agentId, ctx.sessionKey)) return undefined;
  if (ctx?.requesterSessionKey !== undefined && !ownsSession(agentId, ctx.requesterSessionKey)) return undefined;
  if (hook === "cron_reconciled") {
    return { event: { ...event, reason: "scoped" }, ctx: scopedCronContext(ctx, ownedJobs) };
  }
  if (hook === "cron_changed") {
    const jobId = event?.jobId ?? event?.job?.id;
    if (typeof jobId === "string") ownedJobs.add(jobId);
  }
  return {
    event: { ...event, sessionKey: key, ...(subagent ? { childSessionKey: key, targetSessionKey: key } : {}) },
    ctx: { ...ctx, sessionKey: key, childSessionKey: key },
  };
}

/** All authority comes from the already-resolved gateway identity and host hook context. */
export function registerGatewayPublishing(
  identity: GatewayAgentIdentity,
  config: PublishingConfig,
  lifecycle: RegistrationLifecycle,
  on: RuntimeHookRegister,
) {
  const { agentId, signer, client } = identity;
  const { did, actAs } = identity.config;
  const ownedCronJobs = new Set<string>();
  const loops = registerLoopLifecycle({
    on: (hook, handler, options) => on(hook, (event, ctx) => {
      if (!lifecycle.active) return;
      const scoped = scopeLoopHook(agentId, hook, event, ctx, ownedCronJobs);
      return scoped ? handler(scoped.event, scoped.ctx) : undefined;
    }, options),
  }, { nodeUrl: config.nodeUrl, did, actAs, signer, client, signal: lifecycle.signal, config: config.loops });

  const usage = createTurnUsageAttestationHandler(did, { enabled: config.attestation?.enabled }, {
    nodeUrl: config.nodeUrl, signer, client, signal: lifecycle.signal,
  });
  if (usage) on("agent_end", (event, ctx) => {
    if (!lifecycle.active || !ownsSession(agentId, ctx?.sessionKey)) return;
    if (!ownsContext(agentId, ctx)) return;
    usage({ ...event, sessionKey: ctx.sessionKey });
  }, { name: "turn-usage-attestation" });

  let horizon: ReturnType<typeof registerHorizonSync>;
  lifecycle.add(() => horizon?.stop());
  if (config.horizon?.enabled !== true) return;
  if (!loops) {
    console.warn("[imajin-horizon] disabled: horizon requires loop lifecycle tracking");
    return;
  }
  // A configured loop id alone is not ownership evidence. Bind the file publisher
  // only after a trusted gateway session establishes that exact local loop.
  on("session_start", (_event, ctx) => {
    if (!lifecycle.active || horizon || !ownsSession(agentId, ctx?.sessionKey)) return;
    if (ctx?.agentId && ctx.agentId !== agentId) return;
    const target = loops.tracker.lookupSession(ctx.sessionKey);
    if (!target || target.loopId !== config.horizon?.loopId) return;
    if (!config.horizon.filePath) {
      console.warn("[imajin-horizon] disabled: map mode requires an explicit gateway horizon file");
      return;
    }
    horizon = registerHorizonSync({
      registerService: (service) => service.start(),
    }, {
      nodeUrl: config.nodeUrl, did, principal: actAs, signer, client, signal: lifecycle.signal,
      config: {
        ...config.horizon,
        stateDir: join(agentNotifications(agentId, identity.config).stateDir!, "horizon-sync"),
      },
    });
  }, { name: "imajin-gateway:horizon" });
  return {
    readOpenItems: async () => {
      if (!lifecycle.active || !horizon) throw new Error("Gateway horizon unavailable");
      return horizon.readOpenItems();
    },
  };
}
