/**
 * OpenClaw Imajin Plugin
 *
 * Connects an OpenClaw agent to the Imajin network.
 * Registers tools for the five primitives: identity, attestation,
 * attribution (.fair), settlement, and discovery.
 *
 * Config (openclaw.json):
 *   "imajin": {
 *     "enabled": true,
 *     "config": {
 *       "nodeUrl": "https://jin.imajin.ai",
 *       "did": "did:imajin:...",
 *       "keypairPath": "/path/to/.jin-identity.json"
 *     }
 *   }
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ImajinChat } from "./src/chat.js";
import { ImajinClient } from "./src/client.js";
import { ImajinWsService, type NotificationFrame } from "./src/ws-service.js";
import { createNotificationInjector, WAKE_RUNTIME_HOOKS, type WsNotificationsConfig } from "./src/notification-injector.js";
import { createReachEventHandler, isReachFrame } from "./src/reach-events.js";
import {
  createIdentityTool,
  createAttestTool,
  createTransactTool,
  createFairTool,
  createDiscoverTool,
  createMediaTool,
  createWarpTool,
  createInferTool,
  createUsageTool,
  createChatTool,
  createImajinStatusTool,
  createVaultTool,
  createCloudflareTool,
  type WarpToolConfig,
} from "./src/tools.js";
import {
  createTurnUsageAttestationHandler,
  type AgentEndEvent,
  type TurnUsageAttestationConfig,
} from "./src/turn-usage-attestation.js";
import {
  registerImajinProvider,
  isImajinCatalogInvalidationScope,
  type RegisteredImajinProvider,
  type ImajinModelDiscoveryConfig,
} from "./src/imajin-provider.js";
import { registerLoopLifecycle, LOOP_LIFECYCLE_HOOKS, type LoopsConfig } from "./src/loop-hooks.js";
import { registerHorizonSync, type HorizonConfig } from "./src/horizon/sync.js";
import { resolveImajinMcpUrl } from "./src/kernel-mcp.js";
import { createLoopbackSessionGateway, type LoopbackSessionGateway } from "./src/session-command-gateway.js";
import { createSessionInventory, type SessionInventory } from "./src/session-inventory.js";
import { sessionInventoryStatePath } from "./src/session-inventory-state.js";
import { createWakeReportTool } from "./src/wake-report-tool.js";
import type { RegistrationLifecycle } from "./src/registration-lifecycle.js";
import { PluginServiceRuntime, type RuntimeHookRegister } from "./src/plugin-service-runtime.js";
import { createImajinDefaultRouter } from "./src/imajin-default-routing.js";
import type { WakeDisclosureSender } from "./src/wake-report-tool.js";
import { registerAgentPlugin } from "./src/agent-plugin.js";
import { registerGatewayFeatures, type ApprovalBridgeSettings, type SessionCommandsSettings } from "./src/gateway-features.js";
import type { ApprovalsBridgePluginConfig } from "./src/gateway-approvals-bridge.js";
import type { AgentIdentityConfig } from "./src/agent-identities.js";

interface PluginConfig {
  agents?: Record<string, AgentIdentityConfig>;
  gatewayAgent?: string;
  nodeUrl?: string;
  did?: string;
  keypairPath?: string;
  actAs?: string;
  warp?: WarpToolConfig;
  wsNotifications?: WsNotificationsConfig;
  attestation?: TurnUsageAttestationConfig;
  approvalBridge?: ApprovalBridgeSettings;
  approvals?: ApprovalsBridgePluginConfig;
  inferProxyBaseUrl?: string;
  modelDiscovery?: ImajinModelDiscoveryConfig;
  loops?: LoopsConfig;
  horizon?: HorizonConfig;
  sessionCommands?: SessionCommandsSettings;
  mcpUrl?: string;
}

async function startPluginRuntime(
  api: any,
  config: PluginConfig | undefined,
  client: ImajinClient | undefined,
  models: { provider: RegisteredImajinProvider; defaults: ReturnType<typeof createImajinDefaultRouter> },
  lifecycle: RegistrationLifecycle,
  on: RuntimeHookRegister,
  setWakeSender: (sender: WakeDisclosureSender) => void,
): Promise<void> {
  const { provider: imajinProvider, defaults: defaultRouter } = models;
  const discovery = imajinProvider.startDiscovery();
  lifecycle.add(() => discovery.stop());
  let wakeModelResolve: ((event: any, ctx?: any) => unknown) | undefined;
  on("before_model_resolve", async (event, ctx) => {
    const deliberate = await wakeModelResolve?.(event, ctx);
    if (deliberate) {
      defaultRouter.preserveExplicitOverride(ctx);
      return deliberate;
    }
    return defaultRouter.beforeModelResolve(event, ctx);
  }, { name: "imajin-default:model" });
  on("before_agent_run", defaultRouter.beforeAgentRun, { name: "imajin-default:gate" });
  on("agent_end", defaultRouter.onAgentEnd, { name: "imajin-default:end" });
  if (!config?.nodeUrl || !client) return;
  let startWs = async () => {};
  // Loop lifecycle → kernel loops rail (#46): signed loop.* events for
  // primary sessions, subagents, cron automations and keepers. Observe hooks
  // only; a publish failure is logged and dropped, never surfaced to the loop.
  const loopLifecycle = registerLoopLifecycle({ on }, {
    nodeUrl: config.nodeUrl,
    did: config.did,
    keypairPath: config.keypairPath,
    actAs: config.actAs,
    config: config.loops,
  });
  let inventory: SessionInventory | undefined;
  let sessionGateway: LoopbackSessionGateway | undefined;
  if (loopLifecycle) {
    sessionGateway = createLoopbackSessionGateway({
      getConfig: () => (api.runtime?.config?.current?.() ?? {}) as Record<string, unknown>,
      onConnected: () => inventory?.onConnected(),
      onEvent: (event) => inventory?.onEvent(event),
    });
    inventory = createSessionInventory({
      gateway: sessionGateway.gateway,
      tracker: loopLifecycle.tracker,
      sender: loopLifecycle.sender,
      warn: console.warn,
      statePath: sessionInventoryStatePath(
        config.wsNotifications?.stateDir, config.keypairPath,
        JSON.stringify([config.nodeUrl, config.did, config.actAs ?? config.did]),
      ),
    });
    const ownedGateway = sessionGateway;
    const ownedInventory = inventory;
    lifecycle.add(() => { ownedInventory.dispose(); ownedGateway.dispose(); });
    void sessionGateway.start().catch(() => console.warn("[imajin-sessions] Gateway inventory unavailable"));
  }

  registerHorizonSync({
    registerService: ({ start, stop }) => {
      lifecycle.add(() => { void stop(); });
      start();
    },
  }, {
    nodeUrl: config.nodeUrl,
    did: config.did,
    keypairPath: config.keypairPath,
    principal: config.actAs,
    config: config.horizon,
  });

  // Background WebSocket service for real-time notifications (#1653)
  console.log("[imajin-plugin] keypairPath:", config.keypairPath ? "configured" : "missing");
  if (config.keypairPath) {
    console.log("[imajin-plugin] registering imajin-ws service");
    const wsService = new ImajinWsService(
      {
        nodeUrl: config.nodeUrl,
        did: config.did,
        keypairPath: config.keypairPath,
        actAs: config.actAs,
      },
    );

    lifecycle.add(() => wsService.stop());

    // WS notification → agent session injection (#1672), acked after the
    // durable enqueue step (#26) via `wsService.send` bound below.
    const {
      inject: injector,
      dispose: disposeInjector,
      onAgentEnd: onWakeAgentEnd,
      runtimeHooks: wakeRuntimeHooks,
      reportWake,
    } = createNotificationInjector(api, config.wsNotifications, {
      sendFrame: (frame) => wsService.send(frame),
      keypairPath: config.keypairPath,
    });
    lifecycle.add(disposeInjector);
    for (const [hook, handler] of Object.entries(wakeRuntimeHooks)) {
      if (hook === "before_model_resolve") {
        wakeModelResolve = handler;
        continue;
      }
      on(hook, handler, { name: `imajin-wake:${hook}` });
    }
    setWakeSender(reportWake);
    const reachEvents = createReachEventHandler(api, config.wsNotifications?.reach, {
      principalDid: config.actAs ?? config.did,
      targetSession: config.wsNotifications?.targetSession,
      identityClient: client,
      directSend: config.wsNotifications?.directSend,
      stateDir: config.wsNotifications?.stateDir,
      keypairPath: config.keypairPath,
      sendFrame: (frame) => wsService.send(frame),
    });

    lifecycle.add(() => reachEvents.dispose());

    // Supervise every wake (#79), independently of optional reportTo (#47).
    // Completion observes local agent_end; the kernel never reads a transcript.
    if (onWakeAgentEnd) {
      on(
        "agent_end",
        (event: AgentEndEvent, ctx?: { sessionKey?: string }) => {
          void onWakeAgentEnd(event, ctx).catch(() => {
            console.error("[imajin-ws] wake outcome handling failed");
          });
        },
        { name: "wake-outcome" },
      );
    }

    const gatewayFeatures = registerGatewayFeatures(api, { ...config, nodeUrl: config.nodeUrl }, client, wsService, lifecycle, {
      loopLifecycle, sessionGateway, inventory,
      imajinCatalog: {
        listDiscoveredModels: () => imajinProvider.cache.peek()?.models ?? [],
        isDiscoveryReady: () => {
          const outcome = imajinProvider.cache.peek()?.outcome;
          return outcome === "ok" || outcome === "empty";
        },
      },
    });

    wsService.onFrame((frame) => {
      if (!lifecycle.active) return;
      // Consume before generic logging/injection; even invalid reach events
      // must never become trusted instructions or automatic Warp pings.
      if (isReachFrame(frame)) {
        void reachEvents.handle(frame);
        return;
      }
      if (frame.type === "notification") {
        const nf = frame as NotificationFrame;
        console.log(
          `[imajin-ws] notification: ${nf.scope} — ${nf.title}`,
        );
        // WS-driven catalog refresh (#36 item 2): a `connector.credential.
        // sealed` / `connector.credential.unsealed` / `connector.models.
        // changed` kernel notification (confirmed scopes, ima-jin/imajin-
        // ai#2219) invalidates the imajin provider's discovery cache so the
        // NEXT `catalog.run` call refetches immediately instead of waiting
        // out the 60s TTL. See `IMAJIN_CATALOG_INVALIDATION_SCOPES`.
        // Also refetches right away (#55) so a model added kernel-side
        // shows up without waiting for the next periodic refresh;
        // `refresh()` never rejects.
        if (isImajinCatalogInvalidationScope(nf.scope)) {
          console.log(`[imajin-plugin] invalidating imajin catalog cache (scope=${nf.scope})`);
          imajinProvider.cache.invalidate();
          void imajinProvider.cache.refresh();
        }
        // The WS socket callback runs outside any agent turn, so injection is
        // fire-and-forget: never let a rejected promise reach the socket.
        void injector(nf).catch((err: unknown) => {
          console.error(`[imajin-ws] injection failed for ${nf.scope}:`, err);
        });
      } else if (gatewayFeatures.handleFrame(frame)) {
        return;
      } else {
        console.log(`[imajin-ws] frame: type=${frame.type}`, JSON.stringify(frame).slice(0, 200));
      }
    });

    startWs = async () => {
      if (!lifecycle.active) return;
      console.log("[imajin-ws] service start called");
      try {
        await wsService.start();
        if (!lifecycle.active) {
          wsService.stop();
          return;
        }
        console.log("[imajin-ws] service started successfully");
      } catch (err) {
        console.error("[imajin-ws] service start failed:", err);
      }
    };
  }

  // agent_end → agent.turn.usage attestation (#1843). Self-signed, fire-
  // and-forget; never registered at all when unconfigured, so a plugin
  // install with no attestation config behaves exactly as before.
  const turnUsageHandler = createTurnUsageAttestationHandler(config.did, {
    serviceUrl: config.attestation?.serviceUrl ?? config.nodeUrl,
    internalApiKey: config.attestation?.internalApiKey,
    enabled: config.attestation?.enabled,
  });
  if (turnUsageHandler) {
    on("agent_end", turnUsageHandler, { name: "turn-usage-attestation" });
  }

  await startWs();
}

function registerRuntimeHooks(api: any, runtime: PluginServiceRuntime): void {
  for (const hook of LOOP_LIFECYCLE_HOOKS) runtime.registerHook(api, hook, `imajin-loops:${hook}`);
  for (const hook of WAKE_RUNTIME_HOOKS) {
    if (hook !== "before_model_resolve") runtime.registerHook(api, hook, `imajin-wake:${hook}`);
  }
  runtime.registerHook(api, "agent_end", "wake-outcome");
  runtime.registerHook(api, "agent_end", "turn-usage-attestation");
}

export default definePluginEntry({
  id: "imajin",
  name: "Imajin Network",
  description:
    "Connect to the Imajin sovereign identity and settlement network. " +
    "Provides tools for identity lookup, attestations, .fair attribution, " +
    "MJNx/MJN settlement, and network discovery.",

  register(api: any) {
    const config = api.pluginConfig as PluginConfig | undefined;
    if (config && Object.hasOwn(config, "agents")) {
      registerAgentPlugin(api, config);
      return;
    }

    // The one kernel client (agent DID challenge-response session) shared by
    // the primitive tools AND model discovery (#55). Built before the provider
    // is registered because discovery authenticates through it.
    const client = config?.nodeUrl
      ? new ImajinClient({
          nodeUrl: config.nodeUrl,
          did: config.did,
          keypairPath: config.keypairPath,
          actAs: config.actAs,
        })
      : undefined;

    // Imajin model provider (#36): registers `imajin` as an OpenClaw model
    // provider with a live kernel catalog. Completions use the local kernel
    // inference proxy (`inferProxyBaseUrl`, default loopback); the catalog is
    // discovered from the kernel's `GET /infer/v1/models/usable` with the
    // agent's DID session (#55). Without nodeUrl + keypairPath discovery
    // reports `unconfigured` rather than failing plugin start.
    const imajinProvider = registerImajinProvider(
      api,
      { inferProxyBaseUrl: config?.inferProxyBaseUrl, modelDiscovery: config?.modelDiscovery },
      {
        client: config?.keypairPath ? client : undefined,
        nodeUrl: config?.nodeUrl,
      },
    );
    const defaultRouter = createImajinDefaultRouter({
      cache: imajinProvider.cache,
      baseUrl: imajinProvider.baseUrl,
      getConfig: () => api.runtime?.config?.current?.(),
    });
    const runtime = new PluginServiceRuntime(api.registrationMode, (lifecycle, on) =>
      startPluginRuntime(api, config, client, { provider: imajinProvider, defaults: defaultRouter }, lifecycle, on,
        (sender) => runtime.setWakeSender(sender)),
    );
    runtime.defaultRoutingStatus = defaultRouter.status;
    // Lower priority than a deliberate wake/decision routing override.
    runtime.registerHook(api, "before_model_resolve", "imajin-default:model", -100);
    runtime.registerHook(api, "before_agent_run", "imajin-default:gate");
    runtime.registerHook(api, "agent_end", "imajin-default:end");
    api.registerTool(
      createImajinStatusTool({
        baseUrl: imajinProvider.baseUrl,
        cache: imajinProvider.cache,
        discovery: imajinProvider.discovery,
        // #50: kernel MCP tools arrive via OpenClaw's own `mcp.servers` entry
        // pointing at the local passthrough `/mcp` (no headers — the proxy mints
        // the token). The plugin only probes it and reads (never writes) config.
        mcpUrl: resolveImajinMcpUrl(config, imajinProvider.baseUrl),
        getConfig: () => api.runtime?.config?.current?.(),
        getDefaultRouting: () => (PluginServiceRuntime.owner() ?? runtime).defaultRoutingStatus?.(),
      }),
    );

    // Both host service IDs share one idempotent full-mode runtime start.
    api.registerService({ id: "imajin-model-discovery", start: runtime.start, stop: runtime.stop });

    if (!config?.nodeUrl || !client) {
      console.warn(
        "[imajin-plugin] no nodeUrl configured. Set plugins.entries.imajin.config.nodeUrl",
      );
      return;
    }

    // Register primitive tools
    api.registerTool(createIdentityTool(client));
    api.registerTool(createAttestTool(client));
    api.registerTool(createTransactTool(client));
    api.registerTool(createFairTool(client));
    api.registerTool(createDiscoverTool(client));
    api.registerTool(createMediaTool(client));
    api.registerTool(createWarpTool(client, config.warp));
    api.registerTool(createInferTool(client));
    api.registerTool(createUsageTool(client));
    api.registerTool(createVaultTool(client));
    api.registerTool(createCloudflareTool(client));

    // Chat — requires keypair for auth
    if (config.keypairPath) {
      try {
        const agentDid = config.did || "";
        const chat = new ImajinChat(client, agentDid);
        api.registerTool(createChatTool(chat));
      } catch (err) {
        console.error("[imajin-plugin] failed to register chat tool:", err);
      }
    }

    registerRuntimeHooks(api, runtime);
    if (config.keypairPath) {
      api.registerTool((ctx: { sessionKey?: string; runId?: string }) => createWakeReportTool(ctx, runtime.reportWake),
        { names: ["imajin_wake_report"] });
      api.registerService({ id: "imajin-ws", start: runtime.start, stop: runtime.stop });
    }

    // TODO: registerMemoryCorpusSupplement — agent's chain as searchable memory
    // TODO: registerHttpRoute — webhook receiver for Imajin events
    // TODO: registerChannel — Imajin chat as a full messaging channel (receive + send)
    // TODO(#1816 request leg): `approvalBridge.publishRequest(...)` above is only ever
    // called once something learns the OpenClaw gateway raised a new exec/plugin approval.
    // There is no generic, non-channel plugin hook for that (checked against the
    // `openclaw` 2026.8.1 plugin SDK: `PluginHookName` has no approval-request hook, and
    // `SessionApprovalEvent`/`SessionApprovalReplay` in `packages/gateway-protocol` are a
    // session-scoped UI opt-in stream, not a general delivery channel). The supported path
    // is registering imajin as a real `ChannelPlugin` (`api.registerChannel`) with an
    // `approvalCapability.nativeRuntime` built via `createChannelApprovalNativeRuntimeAdapter`
    // / `createLazyChannelApprovalNativeRuntimeAdapter` (`openclaw/plugin-sdk/approval-handler-runtime`
    // + `approval-handler-adapter-runtime`) — its `transport.deliverPending(...)` is where a
    // pending request would be signed and sent to /jin. That is the same, larger "Imajin chat
    // as a full messaging channel" lift as the `registerChannel` TODO above, so it is left as a
    // follow-up rather than bolted on here; the decision leg (verify + resolve) above does not
    // depend on it and is already real end-to-end.
  },
});
