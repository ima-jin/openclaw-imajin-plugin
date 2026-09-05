/**
 * WS-notification → agent-session injector (#1672).
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
// How long to wait for an `agent_end` in the wake session after a
// successfully-scheduled (real id) wake turn before treating it as a stuck
// job and escalating (#13). `scheduleSessionTurn` schedules via a Cron `at`
// job with `wakeMode: "now"` (openclaw core, host-hook-scheduled-turns.ts),
// which the host fires within a few seconds in practice — 60s leaves ample
// margin without leaving the human hanging.
export const WAKE_CONFIRM_TIMEOUT_MS = 60_000;

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

/** Stringifies a host response for a warn log without ever throwing on a weird shape. */
function safePreview(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
 *
 * #13 (2026-09-05 18:53): `scheduleSessionTurn` resolved successfully but its
 * handle carried no `id` — the host (`schedulePluginSessionTurn`, openclaw
 * core `src/plugins/host-hook-scheduled-turns.ts`) has several paths that
 * resolve to `undefined` with **no warn log at all** (a plugin-liveness gate
 * checked both before `cron.add()` and again after, silently rolling the job
 * back if the plugin looks unloaded at that instant — see
 * `docs/warp-wake-chain.md` for the full trace and the exact source lines).
 * The old code trusted a truthy-looking log line (`handle?.id ?? "(no id)"`)
 * as if it were success. It is not: a missing id must be treated as a
 * failure, retried once, and escalated to a plain channel message if the
 * retry also comes back empty — see `flushWakeTurn` below.
 */
export function createNotificationInjector(
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
  const onHook: ((hookName: string, handler: (event: any) => void, opts?: { name?: string }) => void) | undefined =
    typeof api.on === "function" ? api.on.bind(api) : undefined;

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
  let warnedMissingScheduler = false;

  // In-memory coalesce buffer: { timeout, frames: NotificationFrame[] }
  const coalesceByScope = new Map<string, { timeout: ReturnType<typeof setTimeout>; frames: NotificationFrame[] }>();

  // #13 determinism check: a wake schedule that returned a real id is not
  // proof the turn ran — the host creates the Cron task record synchronously
  // but runs it asynchronously. Track scheduled ids and confirm them via the
  // `agent_end` hook (fires with the same `sessionKey` the turn ran in,
  // openclaw core `src/plugins/hook-message.types.ts`); escalate if none
  // arrives within WAKE_CONFIRM_TIMEOUT_MS. Session-key-only correlation
  // means an unrelated human message in the same window can also confirm a
  // pending wake — acceptable: it proves the session is not stuck, which is
  // the thing we actually can't otherwise observe (no job-status query is
  // exposed to plugins; see docs/warp-wake-chain.md).
  const pendingWakeConfirmations = new Map<
    string,
    { scope: string; frames: NotificationFrame[]; timeout: ReturnType<typeof setTimeout> }
  >();

  function confirmWakeTurn(id: string) {
    const pending = pendingWakeConfirmations.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingWakeConfirmations.delete(id);
    console.log(`[imajin-ws] wake turn confirmed ${id} (${pending.scope})`);
  }

  function watchWakeTurn(id: string, scope: string, frames: NotificationFrame[]) {
    const timeout = setTimeout(() => {
      pendingWakeConfirmations.delete(id);
      const reason = `scheduled wake turn ${id} never ran (no agent_end within ${Math.round(WAKE_CONFIRM_TIMEOUT_MS / 1000)}s)`;
      console.warn(`[imajin-ws] ${reason} — escalating for ${scope}`);
      sendChannelMessage(buildWakeFailureMessage(frames, reason))
        .then(() => console.log(`[imajin-ws] wake-confirmation-timeout fallback message sent for ${scope}`))
        .catch((err: any) =>
          console.error(`[imajin-ws] wake-confirmation-timeout fallback message FAILED for ${scope}:`, err?.message ?? err),
        );
    }, WAKE_CONFIRM_TIMEOUT_MS);
    pendingWakeConfirmations.set(id, { scope, frames, timeout });
  }

  if (onHook && wakeSessionKey) {
    onHook(
      "agent_end",
      (event: { sessionKey?: string }) => {
        if (event?.sessionKey !== wakeSessionKey || pendingWakeConfirmations.size === 0) {
          return;
        }
        // FIFO: confirm the oldest still-pending wake for this session.
        const oldest = pendingWakeConfirmations.keys().next();
        if (!oldest.done) confirmWakeTurn(oldest.value);
      },
      { name: "imajin-wake-confirm" },
    );
  }

  console.log(
    `[imajin-ws] injection APIs: enqueueSystemEvent=${!!enqueueSystemEvent}, scheduleSessionTurn=${!!scheduleSessionTurn}, ` +
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

    async function attemptSchedule(attemptTag: string): Promise<{ id: string } | undefined> {
      try {
        return await scheduleSessionTurn!({
          sessionKey: wakeSessionKey!,
          message,
          delayMs: 0,
          tag: attemptTag,
          deliveryMode: "announce",
          deleteAfterRun: true,
        });
      } catch (err: any) {
        console.error(`[imajin-ws] scheduleSessionTurn threw for ${scope} (tag=${attemptTag}):`, err?.message ?? err);
        return undefined;
      }
    }

    // #13: a missing/empty id is a FAILURE, never success — never log a
    // "(no id)" placeholder as if the turn were scheduled. Warn with the raw
    // response so the refusal reason is visible, then retry once before
    // escalating to a plain channel message (deliverable 2/3 of #13).
    let handle = await attemptSchedule(tag);
    let usedFallback = false;
    if (!handle?.id) {
      console.warn(
        `[imajin-ws] wake schedule returned no job id for ${scope} → ${wakeSessionKey} — raw response: ${safePreview(handle)}`,
      );
      handle = await attemptSchedule(tag);
      usedFallback = true;
      if (!handle?.id) {
        console.warn(
          `[imajin-ws] wake fallback ALSO returned no job id for ${scope} → ${wakeSessionKey} — raw response: ${safePreview(handle)}`,
        );
      }
    }

    if (!handle?.id) {
      const reason = "no job id from automations wake (primary + fallback attempts)";
      console.error(
        `[imajin-ws] wake turn FAILED for ${scope} → ${wakeSessionKey} after ${reason} (${frames.length} notification(s) coalesced)`,
      );
      try {
        await sendChannelMessage(buildWakeFailureMessage(frames, reason));
        console.log(`[imajin-ws] wake-failure fallback message sent for ${scope}`);
      } catch (err: any) {
        console.error(`[imajin-ws] wake-failure fallback message FAILED for ${scope}:`, err?.message ?? err);
      }
      return;
    }

    console.log(
      `[imajin-ws] scheduled wake turn ${handle.id} for ${scope} → ${wakeSessionKey} ` +
        `(${frames.length} notification(s) coalesced)${usedFallback ? " [fallback attempt]" : ""}`,
    );
    watchWakeTurn(handle.id, scope, frames);
  }

  function dispose() {
    for (const [scope, buf] of coalesceByScope) {
      clearTimeout(buf.timeout);
      coalesceByScope.delete(scope);
    }
    for (const [id, pending] of pendingWakeConfirmations) {
      clearTimeout(pending.timeout);
      pendingWakeConfirmations.delete(id);
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
