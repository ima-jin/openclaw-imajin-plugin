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
import { createNotificationInjector, type WsNotificationsConfig } from "./src/notification-injector.js";
import {
  createIdentityTool,
  createAttestTool,
  createTransactTool,
  createFairTool,
  createDiscoverTool,
  createMediaTool,
  createWarpTool,
  createInferTool,
  createChatTool,
} from "./src/tools.js";
import {
  createTurnUsageAttestationHandler,
  type TurnUsageAttestationConfig,
} from "./src/turn-usage-attestation.js";

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

/** approve -> allow-once (single-shot); reject -> deny. allow-always (standing
 * approval) is intentionally unreachable here — auto-approve-while-away is a
 * separate delegation-grant feature, explicitly out of scope for #1816. */
function toGatewayDecision(decision: GatewayApprovalDecision): "allow-once" | "deny" {
  return decision === "approve" ? "allow-once" : "deny";
}

export default definePluginEntry({
  id: "imajin",
  name: "Imajin Network",
  description:
    "Connect to the Imajin sovereign identity and settlement network. " +
    "Provides tools for identity lookup, attestations, .fair attribution, " +
    "MJNx/MJN settlement, and network discovery.",

  register(api: any) {
    const config = api.pluginConfig as {
      nodeUrl?: string;
      did?: string;
      keypairPath?: string;
      actAs?: string;
      wsNotifications?: WsNotificationsConfig;
      attestation?: TurnUsageAttestationConfig;
      approvalBridge?: ApprovalBridgeSettings;
    };

    if (!config?.nodeUrl) {
      console.warn(
        "[imajin-plugin] no nodeUrl configured. Set plugins.entries.imajin.config.nodeUrl",
      );
      return;
    }

    const client = new ImajinClient({
      nodeUrl: config.nodeUrl,
      did: config.did,
      keypairPath: config.keypairPath,
      actAs: config.actAs,
    });

    // Register primitive tools
    api.registerTool(createIdentityTool(client));
    api.registerTool(createAttestTool(client));
    api.registerTool(createTransactTool(client));
    api.registerTool(createFairTool(client));
    api.registerTool(createDiscoverTool(client));
    api.registerTool(createMediaTool(client));
    api.registerTool(createWarpTool(client));
    api.registerTool(createInferTool(client));

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

      // WS notification → agent session injection (#1672)
      const { inject: injector, dispose: disposeInjector } = createNotificationInjector(api, config.wsNotifications);

      // OpenClaw gateway approval bridge (#1816). Registered only when both a
      // signing identity (did + keypairPath, already required above for the WS
      // itself) and a pinned approver public key are configured — an install
      // with neither behaves exactly as before.
      let approvalBridge: ApprovalBridge | undefined;
      if (config.did && config.approvalBridge?.pinnedApproverPublicKeyHex) {
        approvalBridge = new ApprovalBridge(
          {
            did: config.did,
            keypairPath: config.keypairPath,
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

      wsService.onFrame((frame) => {
        if (frame.type === "notification") {
          const nf = frame as NotificationFrame;
          console.log(
            `[imajin-ws] notification: ${nf.scope} — ${nf.title}`,
          );
          // The WS socket callback runs outside any agent turn, so injection is
          // fire-and-forget: never let a rejected promise reach the socket.
          void injector(nf).catch((err: unknown) => {
            console.error(`[imajin-ws] injection failed for ${nf.scope}:`, err);
          });
        } else if (approvalBridge && isApprovalDecisionFrame(frame)) {
          void approvalBridge.handleFrame(frame).catch((err: unknown) => {
            console.error(`[imajin-approval] handleFrame failed for ${frame.requestId}:`, err);
          });
        } else {
          console.log(`[imajin-ws] frame: type=${frame.type}`, JSON.stringify(frame).slice(0, 200));
        }
      });

      api.registerService({
        id: "imajin-ws",
        start: async () => {
          console.log("[imajin-ws] service start called");
          try {
            await wsService.start();
            console.log("[imajin-ws] service started successfully");
          } catch (err) {
            console.error("[imajin-ws] service start failed:", err);
          }
        },
        stop: async () => {
          console.log("[imajin-ws] service stop called");
          wsService.stop();
          disposeInjector();
        },
      });
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
      api.on("agent_end", turnUsageHandler, { name: "turn-usage-attestation" });
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
