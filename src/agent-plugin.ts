import { ImajinChat } from "./chat.js";
import { AgentIdentities, AGENT_TOOL_NAMES, agentNotifications, resolveAgentSigner, type AgentIdentityConfig, type AgentIdentity } from "./agent-identities.js";
import { registerGatewayFeatures, type ApprovalBridgeSettings, type SessionCommandsSettings } from "./gateway-features.js";
import type { ApprovalsBridgePluginConfig } from "./gateway-approvals-bridge.js";
import { ImajinWsService, isNotificationFrame } from "./ws-service.js";
import { createNotificationInjector, WAKE_RUNTIME_HOOKS } from "./notification-injector.js";
import { createReachEventHandler, isReachFrame } from "./reach-events.js";
import { PluginServiceRuntime } from "./plugin-service-runtime.js";
import { registerImajinProvider } from "./imajin-provider.js";
import { resolveImajinMcpUrl } from "./kernel-mcp.js";
import { createWakeReportTool, type WakeDisclosureSender } from "./wake-report-tool.js";
import {
  createIdentityTool, createAttestTool, createTransactTool, createFairTool,
  createDiscoverTool, createMediaTool, createWarpTool, createInferTool,
  createUsageTool, createVaultTool, createCloudflareTool, createChatTool, createImajinStatusTool,
} from "./tools.js";

interface AgentToolContext {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
}

export interface GatewayAgentIdentity extends AgentIdentity {
  agentId: string;
  ws: ImajinWsService;
}

export interface AgentPluginRegistration {
  /** Active resolved gateway identity only; cleared on stop/replacement. */
  getGatewayIdentity: () => GatewayAgentIdentity | undefined;
}

/** Match trusted host hook context, never a tool argument or kernel payload. */
function ownsHook(agentId: string, event: any, ctx?: AgentToolContext): boolean {
  const sessionKey = ctx?.sessionKey ?? event?.sessionKey;
  if (ctx?.agentId && ctx.agentId !== agentId) return false;
  if (ctx?.agentId && sessionKey === undefined) return true;
  return typeof sessionKey === "string" && sessionKey.startsWith(`agent:${agentId}:`);
}

/** Agent map is an explicit mode switch. No top-level credentials cross this boundary. */
export function registerAgentPlugin(api: any, config: {
  nodeUrl?: string;
  agents?: Record<string, AgentIdentityConfig>;
  gatewayAgent?: string;
  approvals?: ApprovalsBridgePluginConfig;
  approvalBridge?: ApprovalBridgeSettings;
  sessionCommands?: SessionCommandsSettings;
  inferProxyBaseUrl?: string;
  mcpUrl?: string;
}): AgentPluginRegistration {
  const identities = new AgentIdentities();
  let gatewayIdentity: GatewayAgentIdentity | undefined;
  const senders = new Map<string, WakeDisclosureSender>();
  // A Gateway-wide provider cannot safely select an agent's catalog session.
  // Keep registration/health diagnostics, but never borrow main's credentials.
  const provider = registerImajinProvider(api, { inferProxyBaseUrl: config.inferProxyBaseUrl }, {});
  const runtime = new PluginServiceRuntime(api.registrationMode, async (lifecycle, on) => {
    lifecycle.add(() => { identities.clear(); senders.clear(); gatewayIdentity = undefined; });
    const warnGateway = () => console.warn("[imajin-plugin] gatewayAgent unavailable; approvals and session commands disabled");
    if (!config.nodeUrl || !config.agents || typeof config.agents !== "object" || Array.isArray(config.agents)) {
      warnGateway();
      return;
    }
    await identities.prepare(
      config.nodeUrl, config.agents, api.runtime?.config?.current?.() ?? api.config ?? {},
      resolveAgentSigner, () => lifecycle.active,
    );
    if (!lifecycle.active) return;
    const selected = typeof config.gatewayAgent === "string" ? identities.get(config.gatewayAgent) : undefined;
    if (!selected) warnGateway();
    const starts: Promise<void>[] = [];
    for (const [agentId, identity] of identities.entries()) {
      if (!lifecycle.active) return;
      const notifications = agentNotifications(agentId, identity.config);
      const ws = new ImajinWsService({
        nodeUrl: config.nodeUrl, did: identity.config.did, actAs: identity.config.actAs,
        authenticate: () => identity.client.authenticatedCookie(),
        invalidateAuthentication: () => identity.client.invalidateAuthentication(),
      });
      lifecycle.add(() => ws.stop());
      let gatewayFeatures: ReturnType<typeof registerGatewayFeatures> | undefined;
      if (identity === selected) {
        gatewayIdentity = { ...identity, agentId, ws };
        gatewayFeatures = registerGatewayFeatures(api, {
          nodeUrl: config.nodeUrl,
          did: identity.config.did, actAs: identity.config.actAs, signer: identity.signer,
          localAgentId: agentId, wsNotifications: notifications,
          approvals: config.approvals, approvalBridge: config.approvalBridge,
          sessionCommands: config.sessionCommands,
        }, identity.client, ws, lifecycle);
      }
      const injector = createNotificationInjector(api, notifications, {
        identityScope: agentId, sendFrame: (frame) => ws.send(frame),
      });
      lifecycle.add(injector.dispose);
      senders.set(agentId, injector.reportWake);
      const reach = createReachEventHandler(api, notifications.reach, {
        principalDid: identity.config.actAs ?? identity.config.did,
        targetSession: notifications.targetSession, identityClient: identity.client,
        directSend: notifications.directSend, stateDir: notifications.stateDir,
        sendFrame: (frame) => ws.send(frame),
      });
      lifecycle.add(() => reach.dispose());
      for (const [hook, handler] of Object.entries(injector.runtimeHooks)) {
        on(hook, (event, ctx) => ownsHook(agentId, event, ctx) ? handler(event, ctx) : undefined,
          { name: `imajin-agent:${agentId}:${hook}` });
      }
      on("agent_end", (event, ctx) => ownsHook(agentId, event, ctx) ? injector.onAgentEnd?.(event, ctx) : undefined,
        { name: `imajin-agent:${agentId}:agent_end` });
      ws.onFrame((frame) => {
        if (!lifecycle.active) return;
        if (gatewayFeatures?.handleFrame(frame)) return;
        if (isReachFrame(frame)) {
          void reach.handle(frame).catch(() => console.warn("[imajin-plugin] agent reach delivery failed"));
        } else if (isNotificationFrame(frame)) {
          void injector.inject(frame).catch(() => console.warn("[imajin-plugin] agent notification delivery failed"));
        }
        // Tenant sockets never reach gateway handlers, including malformed frames.
      });
      starts.push(ws.start().then(() => { if (!lifecycle.active) ws.stop(); }));
    }
    await Promise.all(starts);
  });
  runtime.agentTools = (ctx: AgentToolContext) => {
    const identity = identities.get(ctx.agentId);
    if (!identity) return null;
    const { client, config: agent } = identity;
    const tools = [
      createIdentityTool(client), createAttestTool(client), createTransactTool(client),
      createFairTool(client), createDiscoverTool(client), createMediaTool(client),
      createWarpTool(client, agent.warp), createInferTool(client), createUsageTool(client),
      createVaultTool(client), createCloudflareTool(client),
      createChatTool(new ImajinChat(client, agent.did)),
      createImajinStatusTool({
        baseUrl: provider.baseUrl, cache: provider.cache, discovery: provider.discovery,
        mcpUrl: resolveImajinMcpUrl(config, provider.baseUrl),
        getConfig: () => api.runtime?.config?.current?.(),
      }),
      createWakeReportTool(ctx, async (context, disclosure) => {
        const sender = senders.get(ctx.agentId!);
        if (!sender) throw new Error("Agent notification runtime unavailable");
        await sender(context, disclosure);
      }),
    ].filter((tool) => agent.tools === undefined || agent.tools.includes(tool.name));
    return tools.map((tool) => ({
      ...tool,
      execute: (...args: any[]) => {
        if (PluginServiceRuntime.owner() !== runtime || identities.get(ctx.agentId) !== identity) {
          throw new Error("Agent identity runtime is no longer active");
        }
        return (tool.execute as (...params: any[]) => unknown)(...args);
      },
    }));
  };
  api.registerTool((ctx: AgentToolContext) => PluginServiceRuntime.owner()?.agentTools?.(ctx) ?? null,
    { names: [...AGENT_TOOL_NAMES] });
  for (const agentId of Object.keys(config.agents ?? {})) {
    for (const hook of [...WAKE_RUNTIME_HOOKS, "agent_end"]) {
      runtime.registerHook(api, hook, `imajin-agent:${agentId}:${hook}`);
    }
  }
  api.registerService({ id: "imajin-ws", start: runtime.start, stop: runtime.stop });
  return { getGatewayIdentity: () => gatewayIdentity };
}
