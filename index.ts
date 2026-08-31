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
  /** Direct channel ping via the OpenClaw CLI — deterministic, no model turn. */
  directSend?: {
    /** Channel id, default `telegram`. */
    channel?: string;
    /** Chat/recipient target, e.g. `8321865723`. */
    target?: string;
    /** Absolute path to the openclaw CLI binary; default `openclaw` (PATH). */
    cliPath?: string;
  };
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

/** Compact human-facing line for the direct channel ping (no model in the loop). */
function buildDirectMessage(nf: NotificationFrame): string {
  const emoji =
    nf.scope === "warp.run.timeout" ? "⏰" : /FAILED|ERROR|CANCEL/i.test(nf.title ?? "") ? "❌" : "✅";
  const parts = [`${emoji} ${nf.title ?? nf.scope}`];
  if (nf.body) parts.push(nf.body);
  return truncate(parts.join("\n"), 900);
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
    `[imajin-ws] injection APIs: enqueueSystemEvent=${!!enqueueSystemEvent}, runHeartbeatOnce=${!!runHeartbeatOnce}, ` +
      `directSend=${!!wsNotifications?.directSend?.target}`,
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
    let queuedVia: "system-event" | undefined;

    if (enqueueSystemEvent) {
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
        `[imajin-ws] system-event queue rejected ${nf.scope} for ${targetSession} — direct send still attempted`,
      );
    }

    // Direct channel ping (2026-08-31): deterministic delivery with no model
    // turn. The session event above keeps the agent's context complete; this
    // is what actually reaches the human. `openclaw message send` is a plain
    // gateway client, so calling it from inside the gateway process is safe.
    const ds = wsNotifications?.directSend;
    if (ds?.target) {
      try {
        const { execFile } = await import("node:child_process");
        const cli = ds.cliPath ?? "openclaw";
        const args = [
          "message",
          "send",
          "--channel",
          ds.channel ?? "telegram",
          "--target",
          ds.target,
          "-m",
          buildDirectMessage(nf),
        ];
        await new Promise<void>((resolve, reject) => {
          execFile(cli, args, { timeout: 20_000 }, (err) => (err ? reject(err) : resolve()));
        });
        console.log(
          `[imajin-ws] direct-sent ${nf.scope} → ${ds.channel ?? "telegram"}:${ds.target}` +
            (queuedVia ? ` (context queued via ${queuedVia})` : ""),
        );
        return;
      } catch (err: any) {
        console.error(`[imajin-ws] direct send failed for ${nf.scope}:`, err?.message ?? err);
        // Fall through to the heartbeat wake as a best-effort backup.
      }
    }

    if (!queuedVia) {
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
  },
});
