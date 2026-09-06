/**
 * WS-notification → agent-session injector (#1672, #18).
 *
 * Lives in its own module (no plugin-sdk imports) so the real `inject()`
 * path can be unit-tested; `index.ts` wires it into the plugin entry.
 */

import type { NotificationFrame } from "./ws-service.js";

/** `plugins.entries.imajin.config.wsNotifications` (openclaw.json). */
export interface WsNotificationsConfig {
  /** Notification scopes that should wake the agent, e.g. `warp.run.completed`. */
  injectScopes?: string[];
  /** Exact session key to inject into, e.g. `agent:main:telegram:direct:8321865723`. */
  targetSession?: string;
  /**
   * Session key to run a real agent turn into when a Warp run completes/fails,
   * via the Gateway `POST /hooks/agent` wake (#18). Falls back to `targetSession`
   * when omitted.
   */
  wakeSessionKey?: string;
  /** Coalesce window for Warp wake turns (ms). Default 300000 (5 min). */
  wakeCoalesceMs?: number;
  /**
   * Bearer token for the Gateway's `hooks.token` (#18) — required to call
   * `POST /hooks/agent`. Sourced the same way this plugin sources other
   * secrets (see `attestation.internalApiKey`): plaintext here, falling back
   * to the `IMAJIN_WAKE_HOOK_TOKEN` env var when omitted. Never logged or
   * echoed.
   */
  hookToken?: string;
  /** Gateway hooks base path (`hooks.path` on the Gateway side). Default `/hooks`. */
  hooksPath?: string;
  /** Agent id to route the wake hook to (`hooks.allowedAgentIds` must permit it). Default `main`. */
  hookAgentId?: string;
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
// Default coalesce window for Warp wake turns.
export const DEFAULT_WAKE_COALESCE_MS = 300_000;
// Gateway hooks defaults (#18, docs/automation/webhook.md).
const DEFAULT_HOOKS_PATH = "/hooks";
const DEFAULT_HOOK_AGENT_ID = "main";
// `--port` -> `OPENCLAW_GATEWAY_PORT` -> `gateway.port` -> this default
// (openclaw core, src/config/paths.ts:resolveGatewayPort / docs/gateway.md).
const DEFAULT_GATEWAY_PORT = 18789;
// Generous enough for a cold-started isolated agent turn to be *admitted*
// (the hook responds once the run is accepted, not once it finishes) while
// still failing fast to the Telegram fallback on a wedged/unreachable Gateway.
export const HOOK_REQUEST_TIMEOUT_MS = 10_000;
// Falls back here when `wsNotifications.hookToken` is omitted — same pattern
// as `attestation.internalApiKey` / `ATTESTATION_INTERNAL_API_KEY`.
export const HOOK_TOKEN_ENV = "IMAJIN_WAKE_HOOK_TOKEN";

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

export function buildNotificationText(nf: NotificationFrame): string {
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
export function buildDirectMessage(nf: NotificationFrame): string {
  const emoji =
    nf.scope === "warp.run.timeout" ? "⏰" : /FAILED|ERROR|CANCEL/i.test(nf.title ?? "") ? "❌" : "✅";
  const parts = [`${emoji} ${nf.title ?? nf.scope}`];
  if (nf.body) parts.push(nf.body);
  return truncate(parts.join("\n"), 900);
}

/**
 * Second-tier fallback (#13): when the automations wake call never produces a
 * verifiable job id (and the retry doesn't either), this is what actually
 * reaches the human — a deterministic, no-model-in-the-loop channel message,
 * same delivery mechanism as `buildDirectMessage`'s instant ping.
 */
export function buildWakeFailureMessage(frames: NotificationFrame[], reason: string): string {
  const title =
    frames.length === 1 ? (frames[0].title ?? frames[0].scope) : `${frames.length} Warp runs`;
  return truncate(
    `⚠️ Warp run ${title} finished — automatic wake failed (${reason}); ask me to review`,
    900,
  );
}

/**
 * Resolves the Gateway's listening port the same way the host itself does:
 * `--port` -> `OPENCLAW_GATEWAY_PORT` -> `gateway.port` -> 18789 (openclaw
 * core, `src/config/paths.ts:resolveGatewayPort`). This plugin runs inside
 * the Gateway process, so only the config layer is reachable here; CLI/env
 * overrides are the host's own concern and already baked into whatever
 * `runtime.config.current()` returns.
 */
function resolveGatewayPort(api: any): number {
  try {
    const cfg = api?.runtime?.config?.current?.();
    const port = cfg?.gateway?.port;
    if (typeof port === "number" && Number.isFinite(port) && port > 0) {
      return port;
    }
  } catch (err: any) {
    console.warn(
      `[imajin-ws] failed to read gateway.port from runtime.config.current() — using default ${DEFAULT_GATEWAY_PORT}:`,
      err?.message ?? err,
    );
  }
  return DEFAULT_GATEWAY_PORT;
}

interface WakeHookResult {
  ok: boolean;
  /** Only present on an admitted (200) response, and only when the body carries one. */
  runId?: string;
  /** Only present on a non-ok result — never includes the token. */
  reason?: string;
}

/**
 * POSTs the wake to the local Gateway's `POST /hooks/agent` (#18,
 * docs/automation/webhook.md) — a first-class, documented, upgrade-safe
 * surface that runs a real agent turn in an explicit session, replacing the
 * bundled-only `scheduleSessionTurn` seam this plugin cannot use.
 *
 * The Gateway responds 200 once the run is *admitted* (accepted), not once
 * it finishes — the durable injection queued earlier is what the hook turn
 * drains. Never logs `hookToken`; it only ever appears in the `Authorization`
 * header of the outgoing request.
 */
async function postWakeHook(params: {
  gatewayPort: number;
  hooksPath: string;
  hookToken: string;
  agentId: string;
  sessionKey: string;
  message: string;
  idempotencyKey: string;
}): Promise<WakeHookResult> {
  const url = `http://127.0.0.1:${params.gatewayPort}${params.hooksPath}/agent`;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), HOOK_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.hookToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": params.idempotencyKey,
      },
      body: JSON.stringify({
        message: params.message,
        agentId: params.agentId,
        sessionMode: "persistent",
        sessionKey: params.sessionKey,
        deliver: true,
        name: "imajin-wake",
      }),
      signal: controller.signal,
    });
    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: `gateway returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
    }
    let runId: string | undefined;
    try {
      const body = (await res.json()) as Record<string, unknown> | undefined;
      const rawId = body?.runId ?? body?.id;
      runId = typeof rawId === "string" ? rawId : undefined;
    } catch {
      // A 200 with no/unparseable JSON body is still an admitted wake.
    }
    return { ok: true, runId };
  } catch (err: any) {
    const reason =
      err?.name === "AbortError"
        ? `timed out after ${HOOK_REQUEST_TIMEOUT_MS}ms`
        : String(err?.code ?? err?.message ?? err);
    return { ok: false, reason };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Builds the WS-notification → agent-session injector (#1672, #18).
 *
 * The returned function is called from the WebSocket frame callback, which runs
 * on the socket's event loop turn and **not** inside an agent turn. Every host
 * API it touches therefore has to be told which session to act on.
 *
 * Flow:
 * 1. Durable context injection (`enqueueNextTurnInjection` or fallback
 *    `enqueueSystemEvent`) so the event survives restarts — unchanged by #18.
 * 2. Coalesce: multiple completions within the coalesce window are batched and
 *    flushed together, keyed by scope + the coalesce window's start time
 *    (`Idempotency-Key: imajin-wake:<scope>:<coalesceWindowStart>`) rather than
 *    the tag-based unschedule/coalesce #13/#17 used — `unschedulePluginSessionTurnsByTag`
 *    is gated the same bundled-only way as `scheduleSessionTurn` and cannot be
 *    used by a third-party plugin either way.
 * 3. Run a real agent turn in the owner's session via the local Gateway's
 *    `POST /hooks/agent` (`postWakeHook` above) instead of the bundled-only
 *    `api.session.workflow.scheduleSessionTurn` seam (#13, #17): that seam
 *    returns `undefined` for any plugin with `origin !== "bundled"`
 *    (openclaw core, `src/plugins/host-hook-scheduled-turns.ts`), so it never
 *    worked for this plugin. `/hooks/agent` is first-class, documented, and
 *    upgrade-safe (docs/automation/webhook.md).
 * 4. Outcome handling: HTTP 200 → log the admitted runId (never the token) and
 *    stop. Anything else (non-200, ECONNREFUSED, timeout) → the Telegram
 *    fallback from #14 (`buildWakeFailureMessage` + `sendChannelMessage`),
 *    which remains the backstop when the hook is disabled or unreachable.
 *
 * Evidence (2026-09-05, see docs/warp-wake-chain.md for the historical trace):
 * - `runHeartbeatOnce` wakes the heartbeat lane, which is isolated+lightContext
 *   on a local model and cannot see the owner's session → no turn ever runs.
 * - `scheduleSessionTurn` (bundled-only) and its tag-based coalesce/unschedule
 *   were the previous approach (#11-#17); #18 replaces all of it.
 */
export function createNotificationInjector(
  api: any,
  wsNotifications: WsNotificationsConfig | undefined,
): { inject: (nf: NotificationFrame) => Promise<void>; dispose: () => void } {
  const injectScopes = new Set(wsNotifications?.injectScopes ?? []);
  const targetSession = wsNotifications?.targetSession?.trim();
  const wakeSessionKey = wsNotifications?.wakeSessionKey?.trim() ?? targetSession;
  const wakeCoalesceMs = wsNotifications?.wakeCoalesceMs ?? DEFAULT_WAKE_COALESCE_MS;
  const hookToken = wsNotifications?.hookToken?.trim() || process.env[HOOK_TOKEN_ENV]?.trim();
  const hooksPath = (wsNotifications?.hooksPath?.trim() || DEFAULT_HOOKS_PATH).replace(/\/+$/, "") || DEFAULT_HOOKS_PATH;
  const hookAgentId = wsNotifications?.hookAgentId?.trim() || DEFAULT_HOOK_AGENT_ID;

  const enqueueSystemEvent:
    | ((text: string, options: { sessionKey: string; contextKey?: string }) => boolean)
    | undefined = api.runtime?.system?.enqueueSystemEvent;

  const ds = wsNotifications?.directSend;

  /**
   * The one real human-facing delivery mechanism this plugin has: a plain
   * `openclaw message send` CLI call, no model in the loop. Used both for
   * the instant completion ping (`inject`) and the #13 wake-failure
   * escalation (`flushWakeTurn`) — if this fails too there is genuinely
   * nothing left to try, so callers must log the rejection themselves.
   */
  async function sendChannelMessage(text: string): Promise<void> {
    if (!ds?.target) {
      throw new Error("directSend not configured");
    }
    const { execFile } = await import("node:child_process");
    const cli = ds.cliPath ?? "openclaw";
    const args = ["message", "send", "--channel", ds.channel ?? "telegram", "--target", ds.target, "-m", text];
    await new Promise<void>((resolve, reject) => {
      execFile(cli, args, { timeout: 20_000 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  let warnedMissingWakeKey = false;
  let warnedMissingHookToken = false;

  // In-memory coalesce buffer, keyed by scope. `windowStart` is the wall-clock
  // time the buffer opened — it becomes the `Idempotency-Key`'s window
  // component so repeated flushes of the same window (there should only ever
  // be one) collide instead of double-waking, while a new window after the
  // previous one fires gets a fresh key (#18: coalesce by window + idempotency
  // key, replacing the tag-based unschedule/coalesce from #13/#17).
  const coalesceByScope = new Map<
    string,
    { timeout: ReturnType<typeof setTimeout>; frames: NotificationFrame[]; windowStart: number }
  >();

  console.log(
    `[imajin-ws] injection APIs: enqueueSystemEvent=${!!enqueueSystemEvent}, wakeHookConfigured=${!!hookToken}, ` +
      `directSend=${!!ds?.target}`,
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

  /** The #14 Telegram fallback — unchanged backstop for a disabled/unreachable hook. */
  async function escalateWakeFailure(scope: string, frames: NotificationFrame[], reason: string): Promise<void> {
    try {
      await sendChannelMessage(buildWakeFailureMessage(frames, reason));
      console.log(`[imajin-ws] wake-failure fallback message sent for ${scope}`);
    } catch (err: any) {
      console.error(`[imajin-ws] wake-failure fallback message FAILED for ${scope}:`, err?.message ?? err);
    }
  }

  async function flushWakeTurn(scope: string, frames: NotificationFrame[], windowStart: number) {
    coalesceByScope.delete(scope);

    if (!wakeSessionKey) {
      if (!warnedMissingWakeKey) {
        warnedMissingWakeKey = true;
        console.warn(
          "[imajin-ws] cannot run wake turn: no wakeSessionKey (or targetSession) configured",
        );
      }
      return;
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

    if (!hookToken) {
      if (!warnedMissingHookToken) {
        warnedMissingHookToken = true;
        console.warn(
          `[imajin-ws] wsNotifications.hookToken not configured (and ${HOOK_TOKEN_ENV} unset) — ` +
            "cannot call the Gateway wake hook, falling back to the channel message",
        );
      }
      await escalateWakeFailure(scope, frames, "no hook token configured");
      return;
    }

    const idempotencyKey = `imajin-wake:${scope}:${windowStart}`;
    const gatewayPort = resolveGatewayPort(api);
    const result = await postWakeHook({
      gatewayPort,
      hooksPath,
      hookToken,
      agentId: hookAgentId,
      sessionKey: wakeSessionKey,
      message,
      idempotencyKey,
    });

    if (result.ok) {
      console.log(
        `[imajin-ws] wake admitted${result.runId ? ` runId=${result.runId}` : ""} for ${scope} → ${wakeSessionKey} ` +
          `(${frames.length} notification(s) coalesced)`,
      );
      return;
    }

    console.error(
      `[imajin-ws] wake hook FAILED for ${scope} → ${wakeSessionKey}: ${result.reason} (${frames.length} notification(s) coalesced)`,
    );
    await escalateWakeFailure(scope, frames, result.reason ?? "unknown wake hook failure");
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
    if (ds?.target) {
      try {
        await sendChannelMessage(buildDirectMessage(nf));
        console.log(
          `[imajin-ws] direct-sent ${nf.scope} → ${ds.channel ?? "telegram"}:${ds.target}` +
            (queuedVia ? ` (context queued via ${queuedVia})` : ""),
        );
        // No early return here: the direct ping is the instant human-facing
        // notification, but the wake turn below is what makes the agent act.
        // Both must happen (2026-09-05: a `return` here meant the wake never
        // fired when directSend was configured and healthy).
      } catch (err: any) {
        console.error(`[imajin-ws] direct send failed for ${nf.scope}:`, err?.message ?? err);
        // Fall through to wake-turn scheduling.
      }
    }

    if (!queuedVia) {
      return;
    }

    // Run a real agent turn in the owner's DM (via the Gateway wake hook)
    // instead of poking the heartbeat lane (isolated, cannot see the owner's
    // session). Coalesce by scope; the window's start time becomes part of
    // the Idempotency-Key sent with the eventual hook request.
    const existing = coalesceByScope.get(nf.scope);
    if (existing) {
      existing.frames.push(nf);
      console.log(`[imajin-ws] warp wake: batched ${nf.id} (n=${existing.frames.length}, fires in ${wakeCoalesceMs}ms)`);
      return;
    }

    const windowStart = Date.now();
    const timeout = setTimeout(() => {
      const buf = coalesceByScope.get(nf.scope);
      if (buf) void flushWakeTurn(nf.scope, buf.frames, buf.windowStart);
    }, wakeCoalesceMs);

    coalesceByScope.set(nf.scope, { timeout, frames: [nf], windowStart });
    console.log(`[imajin-ws] warp wake: batched ${nf.id} (n=1, fires in ${wakeCoalesceMs}ms)`);
  }

  return { inject, dispose };
}
