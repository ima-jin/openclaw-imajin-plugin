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
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import {
  ApprovalBridge,
  isApprovalDecisionFrame,
  type GatewayApprovalDecision,
  type GatewayApprovalKind,
} from "./src/approval-bridge.js";
import { ImajinChat } from "./src/chat.js";
import { ImajinClient } from "./src/client.js";
import { ImajinWsService, type NotificationFrame } from "./src/ws-service.js";
import { createNotificationInjector, WAKE_RUNTIME_HOOKS, type WsNotificationsConfig } from "./src/notification-injector.js";
import { createReachEventHandler, isReachFrame } from "./src/reach-events.js";
import {
  startGatewayApprovalsBridge,
  type ApprovalsBridgePluginConfig,
} from "./src/gateway-approvals-bridge.js";
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
import { isImajinModelAllowedByPolicy } from "./src/sources/imajin-catalog.js";
import { registerLoopLifecycle, LOOP_LIFECYCLE_HOOKS, type LoopLifecycle, type LoopsConfig } from "./src/loop-hooks.js";
import { registerHorizonSync, type HorizonConfig } from "./src/horizon/sync.js";
import { resolveImajinMcpUrl } from "./src/kernel-mcp.js";
import { createIdentityClientOperatorKeyResolver } from "./src/operator-signature.js";
import {
  createSessionCommandAttester,
  createSessionCommandExecutor,
  isSessionCommandFrame,
  type SessionCommandExecutor,
} from "./src/session-commands.js";
import { createLoopbackSessionGateway, type LoopbackSessionGateway } from "./src/session-command-gateway.js";
import { createSessionInventory, type SessionInventory } from "./src/session-inventory.js";
import { ApprovalExecutionRegistry } from "./src/approval-execution.js";
import { createWakeReportTool } from "./src/wake-report-tool.js";
import type { RegistrationLifecycle } from "./src/registration-lifecycle.js";
import { PluginServiceRuntime, type RuntimeHookRegister } from "./src/plugin-service-runtime.js";
import type { WakeDisclosureSender } from "./src/wake-report-tool.js";

/** `plugins.entries.imajin.config.approvalBridge` (openclaw.json, #1816). */
interface ApprovalBridgeSettings {
  /**
   * Ed25519 public key (hex) pinned as the sole trusted approver for
   * `approval.decision` attestations. Channel-trust (the authenticated WS
   * session) is never sufficient on its own — every decision must carry a
   * valid signature from exactly this key.
   */
  pinnedApproverPublicKeyHex?: string;
}

/**
 * `plugins.entries.imajin.config.sessionCommands` (openclaw.json, #51).
 * Opt-in: a signed command can steer sessions and resolve approvals, so it is
 * never on by default.
 */
interface SessionCommandsSettings {
  enabled?: boolean;
  /** Ed25519 public key (hex) pinned as the only trusted kernel command signer. Required. */
  kernelPublicKeyHex?: string;
  /** When set, a command's `issuer` must equal this DID. */
  kernelDid?: string;
  /** Default true. false skips the principal countersignature (the kernel grant is always required). */
  requirePrincipalCountersignature?: boolean;
}

/** approve -> allow-once (single-shot); reject -> deny. allow-always (standing
 * approval) is intentionally unreachable here — auto-approve-while-away is a
 * separate delegation-grant feature, explicitly out of scope for #1816. */
function toGatewayDecision(decision: GatewayApprovalDecision): "allow-once" | "deny" {
  return decision === "approve" ? "allow-once" : "deny";
}

interface PluginConfig {
  nodeUrl?: string;
  did?: string;
  keypairPath?: string;
  actAs?: string;
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

function createLegacyApprovalBridge(
  api: any,
  config: PluginConfig,
  wsService: ImajinWsService,
  approvalExecutions: ApprovalExecutionRegistry,
): ApprovalBridge | undefined {
  const keypairPath = config.keypairPath;
  if (!keypairPath) return undefined;
  let approvalBridge: ApprovalBridge | undefined;
  if (config.did && config.approvalBridge?.pinnedApproverPublicKeyHex) {
    approvalBridge = new ApprovalBridge(
      {
        did: config.did,
        keypairPath,
        pinnedApproverPublicKeyHex: config.approvalBridge.pinnedApproverPublicKeyHex,
      },
      (frame) => wsService.send(frame),
    );

    // Decision leg: only a signature-verified `approve`/`reject` ever
    // reaches here (ApprovalBridge.handleFrame already rejected + logged
    // anything expired, mismatched, or unsigned) — this is the one place
    // that actually resolves the OpenClaw gateway's pending approval.
    // No `reviewer` identity is passed: this bridge is not a registered
    // channel route for the request (see the registerChannel TODO below),
    // so custody checks that key off a channel/accountId/senderId triple
    // don't apply here; omitting all three is the documented no-reviewer form.
    approvalBridge.onResolved(async (requestId, decision, kind: GatewayApprovalKind) => {
      if (!approvalExecutions.claim(requestId)) return;
      try {
        const result = await resolveApprovalOverGateway({
          cfg: api.config,
          approvalId: requestId,
          approvalKind: kind,
          decision: toGatewayDecision(decision),
          clientDisplayName: "Imajin /jin approval",
        });
        console.log(
          `[imajin-approval] gateway resolve ${requestId} -> applied=${result.applied}, status=${result.approval.status}`,
        );
      } catch (err) {
        console.error(`[imajin-approval] gateway resolve failed for ${requestId}:`, err);
      }
    });
  } else if (config.approvalBridge?.pinnedApproverPublicKeyHex) {
    console.warn(
      "[imajin-plugin] approvalBridge.pinnedApproverPublicKeyHex is set but no agent `did` " +
        "is configured — the approval bridge will not be registered",
    );
  }

  return approvalBridge;
}

function createSessionCommands(
  config: PluginConfig,
  client: ImajinClient,
  loopLifecycle: LoopLifecycle | undefined,
  wsService: ImajinWsService,
  approvalExecutions: ApprovalExecutionRegistry,
  sessionGateway: LoopbackSessionGateway | undefined,
  inventory: SessionInventory | undefined,
): SessionCommandExecutor | undefined {
  const keypairPath = config.keypairPath;
  if (!keypairPath) return undefined;
  let sessionCommandExecutor: SessionCommandExecutor | undefined;
  if (config.sessionCommands?.enabled === true) {
    const settings = config.sessionCommands;
    if (!config.did || !settings.kernelPublicKeyHex || !loopLifecycle || !sessionGateway) {
      console.warn(
        "[imajin-plugin] sessionCommands.enabled needs an agent `did` and " +
          "sessionCommands.kernelPublicKeyHex with loop lifecycle tracking enabled — session commands will not be accepted",
      );
    } else {
      const keyResolver = createIdentityClientOperatorKeyResolver(client);
      sessionCommandExecutor = createSessionCommandExecutor(
        {
          agentDid: config.did,
          kernelPublicKeyHex: settings.kernelPublicKeyHex,
          kernelDid: settings.kernelDid,
          allowedPrincipal: config.actAs,
          requirePrincipalCountersignature: settings.requirePrincipalCountersignature,
        },
        {
          gateway: sessionGateway.gateway,
          publishHistory: inventory?.history,
          refreshInventory: inventory?.refresh,
          loopTracker: loopLifecycle?.tracker,
          executionRegistry: approvalExecutions,
          attest: createSessionCommandAttester({
            did: config.did,
            keypairPath,
            send: (frame) => wsService.send(frame),
          }),
          resolveServiceOf: (agentDid) => client.getServiceOf(agentDid),
          resolvePublicKey: (did) => keyResolver.resolveOperatorPublicKey(did),
        },
      );
      console.log("[imajin-plugin] session command executor enabled");
    }
  }

  return sessionCommandExecutor;
}

async function startPluginRuntime(
  api: any,
  config: PluginConfig | undefined,
  client: ImajinClient | undefined,
  imajinProvider: RegisteredImajinProvider,
  lifecycle: RegistrationLifecycle,
  on: RuntimeHookRegister,
  setWakeSender: (sender: WakeDisclosureSender) => void,
): Promise<void> {
  const discovery = imajinProvider.startDiscovery();
  lifecycle.add(() => discovery.stop());
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

    // OpenClaw gateway approval bridge (#1816). Registered only when both a
    // signing identity (did + keypairPath, already required above for the WS
    // itself) and a pinned approver public key are configured — an install
    // with neither behaves exactly as before.
    const approvalExecutions = new ApprovalExecutionRegistry();
    const approvalBridge = createLegacyApprovalBridge(api, config, wsService, approvalExecutions);

    // Session command executor (#51): signed, DID-addressed session commands
    // arrive over this same outbound WS, are verified, executed against the
    // local gateway, and attested back as signed `loop.session.*` frames.
    // Opt-in; needs the agent DID + a pinned kernel command-signing key.
    const sessionCommandExecutor = createSessionCommands(
      config, client, loopLifecycle, wsService, approvalExecutions,
      sessionGateway, inventory,
    );

    // Gateway approvals bridge (#24): publishes staged Gateway system-agent
    // proposals to the kernel and applies signed operator decisions back to
    // the Gateway. Off unless `approvals.enabled` + `approvals.operatorDid`
    // (+ the token/secret it needs) are configured — see
    // `src/gateway-approvals-bridge.ts` for the full trust chain. Started
    // fire-and-forget so a slow/unavailable Gateway loopback connection can
    // never delay the kernel WebSocket service start.
    let approvalsBridgeFrameHandler: ((frame: unknown) => void) | undefined;
    const approvalsBridgeReady = startGatewayApprovalsBridge(api, config.approvals, {
      signal: lifecycle.signal,
      did: config.did,
      keypairPath: config.keypairPath,
      nodeUrl: config.nodeUrl,
      // Reuses this plugin's EXISTING DID resolver (#44) to verify an
      // operator's countersignature on `operator.approval.decided`
      // against their registered public key — never a second resolver.
      identityClient: client,
      // #53: the same challenge-response session, reused for the
      // `operator:approvals` entitlement preflight + decided-event catch-up.
      kernelHttp: client,
      stateDir: config.wsNotifications?.stateDir,
      directSend: config.wsNotifications?.directSend,
      // #64: a pending approval blocks its owning loop on the loops rail.
      loopTracker: loopLifecycle?.tracker,
      executionRegistry: approvalExecutions,
      publishApprovalBinding: (attestation) => {
        wsService.send({ type: "loop.approval.bound", attestation });
        return Promise.resolve();
      },
      // Wires the opt-in "imajin-catalog" source (#36 item 3) so it can be
      // enabled via `approvals.sources` alongside system-agent/skill-
      // workshop. Reads the config's live `modelPolicy.allow` on every
      // check rather than a snapshot, so an operator edit takes effect
      // without a plugin restart.
      imajinCatalog: {
        listDiscoveredModels: () => imajinProvider.cache.peek()?.models ?? [],
        isModelAllowed: (modelId: string) => {
          const liveConfig = api.runtime?.config?.current?.() as
            | { agents?: { defaults?: { modelPolicy?: { allow?: string[] } } } }
            | undefined;
          return isImajinModelAllowedByPolicy(
            liveConfig?.agents?.defaults?.modelPolicy?.allow,
            modelId,
          );
        },
      },
    })
      .then((started) => {
        if (!lifecycle.active) {
          started?.dispose();
          return undefined;
        }
        if (started) lifecycle.add(() => started.dispose());
        approvalsBridgeFrameHandler = started?.onKernelFrame;
        return started;
      })
      .catch((err: unknown) => {
        console.error("[imajin-approvals-bridge] failed to start:", err);
        return undefined;
      });

    // #53: on EVERY (re)connect, after the kernel's auth-ok, re-verify the
    // agent still holds `operator:approvals` and replay any
    // `operator.approval.decided` the socket missed. Awaits bridge startup so
    // a connect that races registration is not dropped.
    wsService.onConnected(async () => {
      void inventory?.refresh().catch(() => console.warn("[imajin-sessions] kernel reconnect inventory unavailable"));
      const started = await approvalsBridgeReady;
      if (lifecycle.active) await started?.onKernelConnected();
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
      } else if (approvalBridge && isApprovalDecisionFrame(frame)) {
        void approvalBridge.handleFrame(frame).catch((err: unknown) => {
          console.error(`[imajin-approval] handleFrame failed for ${frame.requestId}:`, err);
        });
      } else if (sessionCommandExecutor && isSessionCommandFrame(frame)) {
        // handleFrame never throws and always attests; the catch is belt and braces.
        void sessionCommandExecutor.handleFrame(frame).catch((err: unknown) => {
          console.error(`[imajin-session-commands] handleFrame failed for ${frame.type}:`, err);
        });
      } else if (frame.type === "bus_event") {
        // Kernel bus-event fan-out (#1884) — currently only consumed by the
        // gateway approvals bridge's `operator.approval.decided` handler.
        approvalsBridgeFrameHandler?.(frame);
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
  for (const hook of WAKE_RUNTIME_HOOKS) runtime.registerHook(api, hook, `imajin-wake:${hook}`);
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
      }),
    );

    const runtime = new PluginServiceRuntime(api.registrationMode, (lifecycle, on) =>
      startPluginRuntime(api, config, client, imajinProvider, lifecycle, on,
        (sender) => runtime.setWakeSender(sender)),
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
    api.registerTool(createWarpTool(client));
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
