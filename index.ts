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

/** `plugins.entries.imajin.config.wsNotifications` (openclaw.json). */
interface WsNotificationsConfig {
  /** Notification scopes that should wake the agent, e.g. `warp.run.completed`. */
  injectScopes?: string[];
  /** Exact session key to inject into, e.g. `agent:main:telegram:direct:8321865723`. */
  targetSession?: string;
}

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

// A queued notification is stale once the run it describes is old news; the
// host drops the record instead of prepending it to some much later turn.
const INJECTION_TTL_MS = 15 * 60_000;
// Hard cap on the injected block so a pathological `data` payload cannot eat
// the session's context window. The host also caps at 32KB and silently
// refuses anything larger, which would look like a lost notification.
const MAX_INJECTED_CHARS = 4_000;
const MAX_DATA_JSON_CHARS = 2_000;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

function buildNotificationText(nf: NotificationFrame): string {
  let dataJson = "(none)";
  if (nf.data) {
    try {
      dataJson = truncate(JSON.stringify(nf.data, null, 2), MAX_DATA_JSON_CHARS);
    } catch {
      dataJson = "(unserializable)";
    }
  }
  const text = [
    `[Warp Notification: ${nf.scope}]`,
    "",
    nf.title,
    nf.body ? `\n${nf.body}` : "",
    "",
    `Notification ID: ${nf.id}`,
    `Received: ${nf.createdAt}`,
    `Data:\n\`\`\`json\n${dataJson}\n\`\`\``,
    "",
    "Review this event and take appropriate action.",
  ]
    .filter(Boolean)
    .join("\n");
  return truncate(text, MAX_INJECTED_CHARS);
}

/**
 * Builds the WS-notification → agent-session injector (#1672).
 *
 * The returned function is called from the WebSocket frame callback, which runs
 * on the socket's event loop turn and **not** inside an agent turn. Every host
 * API it touches therefore has to be told which session to act on:
 *
 * - `api.session.workflow.enqueueNextTurnInjection({ sessionKey, text, … })` is
 *   the durable, session-keyed plugin seam. The host persists the record on the
 *   session entry and drains it while building the next turn's prompt, so it
 *   survives a gateway restart and `idempotencyKey` makes redelivery a no-op.
 * - `api.runtime.system.enqueueSystemEvent(text, { sessionKey })` is the
 *   in-memory fallback. Note the **two-argument** signature: the previous code
 *   passed a single `{ type, source, text }` object, so the host's `options`
 *   parameter was `undefined` and `requireSessionKey(options.sessionKey)` threw
 *   `Cannot read properties of undefined (reading 'sessionKey')`. The API was
 *   never session-scoped — it just needs the session key passed explicitly.
 * - `api.runtime.system.runHeartbeatOnce({ reason, heartbeat: { target: "last" } })`
 *   is what actually wakes the agent NOW: per plugins/sdk-runtime.md it "runs a
 *   single heartbeat cycle immediately, bypassing the normal coalesce timer".
 *   `requestHeartbeat(...)` — used until 2026-08-31 — only feeds the coalesce
 *   timer; `intent: "immediate"` is an ordinary hint string, not a bypass. On
 *   2026-08-31 eight warp.run.completed events were queued via system events
 *   but produced zero agent turns until the next user message 11+ minutes
 *   later, which is how this was caught.
 *   `heartbeat: { target: "last" }` routes the reply to the session's last
 *   active channel instead of the default `target: "none"` suppression.
 */
function createNotificationInjector(
  api: any,
  wsNotifications: WsNotificationsConfig | undefined,
): (nf: NotificationFrame) => Promise<void> {
  const injectScopes = new Set(wsNotifications?.injectScopes ?? []);
  const targetSession = wsNotifications?.targetSession?.trim();

  // Prefer the grouped session facade; `api.enqueueNextTurnInjection` is the
  // deprecated flat alias kept for hosts that predate the `api.session` group.
  const enqueueNextTurnInjection:
    | ((injection: {
        sessionKey: string;
        text: string;
        idempotencyKey?: string;
        placement?: "prepend_context" | "append_context";
        ttlMs?: number;
      }) => Promise<{ enqueued: boolean; id: string; sessionKey: string }>)
    | undefined = api.session?.workflow?.enqueueNextTurnInjection ?? api.enqueueNextTurnInjection;
  const enqueueSystemEvent:
    | ((text: string, options: { sessionKey: string; contextKey?: string }) => boolean)
    | undefined = api.runtime?.system?.enqueueSystemEvent;
  const runHeartbeatOnce:
    | ((opts: {
        reason?: string;
        heartbeat?: { target?: string };
      }) => Promise<unknown>)
    | undefined = api.runtime?.system?.runHeartbeatOnce;

  console.log(
    `[imajin-ws] injection APIs: enqueueNextTurnInjection=${!!enqueueNextTurnInjection}, ` +
      `enqueueSystemEvent=${!!enqueueSystemEvent}, runHeartbeatOnce=${!!runHeartbeatOnce}`,
  );
  if (injectScopes.size === 0) {
    console.log("[imajin-ws] no wsNotifications.injectScopes configured — notifications are log-only");
  } else if (!targetSession) {
    console.warn(
      "[imajin-ws] wsNotifications.injectScopes is set but wsNotifications.targetSession is missing — " +
        "injection needs an explicit session key and will be skipped",
    );
  } else {
    console.log(
      `[imajin-ws] injecting [${[...injectScopes].join(", ")}] → session ${targetSession}`,
    );
  }

  return async (nf: NotificationFrame): Promise<void> => {
    if (!injectScopes.has(nf.scope) || !targetSession) {
      return;
    }

    const text = buildNotificationText(nf);
    let queuedVia: "next-turn-injection" | "system-event" | undefined;

    if (enqueueNextTurnInjection) {
      try {
        const result = await enqueueNextTurnInjection({
          sessionKey: targetSession,
          text,
          // The kernel notification id is already unique per event, so a
          // reconnect that replays the frame cannot double-inject.
          idempotencyKey: `imajin-ws:${nf.id}`,
          placement: "prepend_context",
          ttlMs: INJECTION_TTL_MS,
        });
        if (result?.enqueued) {
          queuedVia = "next-turn-injection";
        } else {
          // Reached when the session row does not exist yet, the queue is full,
          // or `hooks.allowPromptInjection` is false for this plugin.
          console.warn(
            `[imajin-ws] next-turn injection refused for ${nf.scope} (session ${targetSession}) — ` +
              "falling back to the system-event queue",
          );
        }
      } catch (err: any) {
        console.error(
          `[imajin-ws] enqueueNextTurnInjection failed for ${nf.scope}:`,
          err?.message ?? err,
        );
      }
    }

    if (!queuedVia && enqueueSystemEvent) {
      try {
        enqueueSystemEvent(text, {
          sessionKey: targetSession,
          contextKey: `imajin-ws:${nf.scope}`,
        });
        queuedVia = "system-event";
      } catch (err: any) {
        console.error(`[imajin-ws] enqueueSystemEvent failed for ${nf.scope}:`, err?.message ?? err);
      }
    }

    if (!queuedVia) {
      console.error(
        `[imajin-ws] dropped ${nf.scope} — no injection API accepted the payload for ${targetSession}`,
      );
      return;
    }

    if (!runHeartbeatOnce) {
      // The payload is queued and will be picked up by the session's next turn,
      // but nothing will start that turn on its own.
      console.warn(
        `[imajin-ws] queued ${nf.scope} via ${queuedVia} but runHeartbeatOnce is unavailable — ` +
          "the agent will only see it on its next turn",
      );
      return;
    }

    try {
      await runHeartbeatOnce({
        reason: "warp-notification-wake",
        heartbeat: { target: "last" },
      });
      console.log(
        `[imajin-ws] injected ${nf.scope} → ${targetSession} via ${queuedVia}, ran immediate heartbeat`,
      );
    } catch (err: any) {
      console.error(`[imajin-ws] runHeartbeatOnce failed for ${nf.scope}:`, err?.message ?? err);
    }
  };
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
      const injector = createNotificationInjector(api, config.wsNotifications);

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
