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
  /**
   * Session key to schedule a real agent turn into when a Warp run completes/fails.
   * Falls back to `targetSession` when omitted.
   */
  wakeSessionKey?: string;
  /** Coalesce window for Warp wake turns (ms). Default 300000 (5 min). */
  wakeCoalesceMs?: number;
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
// Default coalesce window for Warp wake turns.
const DEFAULT_WAKE_COALESCE_MS = 300_000;

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
 * API it touches therefore has to be told which session to act on.
 *
 * Flow:
 * 1. Durable context injection (`enqueueNextTurnInjection` or fallback
 *    `enqueueSystemEvent`) so the event survives restarts.
 * 2. Schedule a real agent turn into the owner's conversation via
 *    `api.session.workflow.scheduleSessionTurn({ delayMs: 0, sessionKey, message, tag, deliveryMode: "announce" })`.
 *    This is a bundled-only Cron-backed seam that creates a background task
 *    record and runs it immediately (delayMs: 0). It targets an exact session
 *    key, so the turn runs in the owner's DM — not the heartbeat lane.
 * 3. Coalesce: multiple completions within the coalesce window unschedule the
 *    previous pending turn by tag and reschedule a combined one.
 *
 * Evidence (2026-09-05):
 * - `runHeartbeatOnce` wakes the heartbeat lane, which is isolated+lightContext
 *   on a local model and cannot see the owner's session → no turn ever runs.
 * - A one-shot automations job {schedule at-now, sessionTarget "current",
 *   payload agentTurn, delivery announce} DID produce a real turn in the DM.
 * - `automations wake mode:now sessionKey:<key>` did NOT (injection only).
 */
function createNotificationInjector(
  api: any,
  wsNotifications: WsNotificationsConfig | undefined,
): { inject: (nf: NotificationFrame) => Promise<void>; dispose: () => void } {
  const injectScopes = new Set(wsNotifications?.injectScopes ?? []);
  const targetSession = wsNotifications?.targetSession?.trim();
  const wakeSessionKey = wsNotifications?.wakeSessionKey?.trim() ?? targetSession;
  const wakeCoalesceMs = wsNotifications?.wakeCoalesceMs ?? DEFAULT_WAKE_COALESCE_MS;

  const enqueueSystemEvent:
    | ((text: string, options: { sessionKey: string; contextKey?: string }) => boolean)
    | undefined = api.runtime?.system?.enqueueSystemEvent;

  const scheduleSessionTurn:
    | ((params: {
        sessionKey: string;
        message: string;
        delayMs: number;
        tag?: string;
        deliveryMode?: "none" | "announce";
        deleteAfterRun?: boolean;
      }) => Promise<{ id: string } | undefined>)
    | undefined = api.session?.workflow?.scheduleSessionTurn;
  const unscheduleSessionTurnsByTag:
    | ((params: { sessionKey: string; tag: string }) => Promise<{ removed: number; failed: number }>)
    | undefined = api.session?.workflow?.unscheduleSessionTurnsByTag;

  let warnedMissingWakeKey = false;
  let warnedMissingScheduler = false;

  // In-memory coalesce buffer: { timeout, frames: NotificationFrame[] }
  const coalesceByScope = new Map<string, { timeout: ReturnType<typeof setTimeout>; frames: NotificationFrame[] }>();

  console.log(
    `[imajin-ws] injection APIs: enqueueSystemEvent=${!!enqueueSystemEvent}, scheduleSessionTurn=${!!scheduleSessionTurn}, ` +
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
  if (wakeSessionKey) {
    console.log(`[imajin-ws] wake turns → session ${wakeSessionKey} (coalesce ${wakeCoalesceMs}ms)`);
  }

  async function flushWakeTurn(scope: string, frames: NotificationFrame[]) {
    coalesceByScope.delete(scope);

    if (!wakeSessionKey) {
      if (!warnedMissingWakeKey) {
        warnedMissingWakeKey = true;
        console.warn(
          "[imajin-ws] cannot schedule wake turn: no wakeSessionKey (or targetSession) configured",
        );
      }
      return;
    }

    if (!scheduleSessionTurn) {
      if (!warnedMissingScheduler) {
        warnedMissingScheduler = true;
        console.warn(
          "[imajin-ws] scheduleSessionTurn unavailable — wake turn will not be scheduled. " +
            "Is this a bundled/trusted plugin installation?",
        );
      }
      return;
    }

    const tag = `imajin-wake:${scope}`;

    // Unschedule any previous pending turn for this scope so we coalesce.
    if (unscheduleSessionTurnsByTag) {
      try {
        await unscheduleSessionTurnsByTag({ sessionKey: wakeSessionKey, tag });
      } catch (err: any) {
        console.warn(`[imajin-ws] unscheduleSessionTurnsByTag failed for ${tag}:`, err?.message ?? err);
      }
    }

    // Sort: FAILED/CANCELLED first, then SUCCEEDED
    const severity = (f: NotificationFrame) => {
      if (/FAILED|ERROR|CANCEL/i.test(f.title ?? "")) return 0;
      return 1;
    };
    const sorted = [...frames].sort((a, b) => severity(a) - severity(b));

    const lines = sorted.map((f) => {
      const state = /FAILED|ERROR|CANCEL/i.test(f.title ?? "") ? "⚠️" : "✅";
      const link = f.data && typeof f.data === "object"
        ? (f.data.prUrl || f.data.commentUrl || f.data.sessionUrl || "")
        : "";
      return `${state} ${f.title ?? f.scope}${link ? ` — ${link}` : ""}`;
    });

    const failedCount = sorted.filter((f) => /FAILED|ERROR|CANCEL/i.test(f.title ?? "")).length;
    const header = failedCount > 0
      ? `Warp runs completed (${frames.length}) — ${failedCount} need attention`
      : `Warp runs completed (${frames.length})`;

    const message = [
      header,
      "",
      ...lines,
      "",
      "React now: review, merge or send back per the review rules, then report to Ryan.",
    ].join("\n");

    try {
      const handle = await scheduleSessionTurn({
        sessionKey: wakeSessionKey,
        message,
        delayMs: 0,
        tag,
        deliveryMode: "announce",
        deleteAfterRun: true,
      });
      console.log(
        `[imajin-ws] scheduled wake turn ${handle?.id ?? "(no id)"} for ${scope} → ${wakeSessionKey} ` +
          `(${frames.length} notification(s) coalesced)`,
      );
    } catch (err: any) {
      console.error(`[imajin-ws] scheduleSessionTurn failed for ${scope}:`, err?.message ?? err);
    }
  }

  function dispose() {
    for (const [scope, buf] of coalesceByScope) {
      clearTimeout(buf.timeout);
      coalesceByScope.delete(scope);
    }
  }

  async function inject(nf: NotificationFrame): Promise<void> {
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
        // Fall through to wake-turn scheduling.
      }
    }

    if (!queuedVia) {
      return;
    }

    // Schedule a real agent turn into the owner's DM instead of poking the
    // heartbeat lane (which is isolated and cannot see the owner's session).
    const existing = coalesceByScope.get(nf.scope);
    if (existing) {
      existing.frames.push(nf);
      console.log(`[imajin-ws] warp wake: batched ${nf.id} (n=${existing.frames.length}, fires in ${wakeCoalesceMs}ms)`);
      return;
    }

    const timeout = setTimeout(() => {
      const buf = coalesceByScope.get(nf.scope);
      if (buf) void flushWakeTurn(nf.scope, buf.frames);
    }, wakeCoalesceMs);

    coalesceByScope.set(nf.scope, { timeout, frames: [nf] });
    console.log(`[imajin-ws] warp wake: batched ${nf.id} (n=1, fires in ${wakeCoalesceMs}ms)`);
  }

  return { inject, dispose };
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
