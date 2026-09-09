/**
 * WS-notification → agent-session injector (#1672, #18, #20).
 *
 * Lives in its own module (no *top-level* plugin-sdk imports) so the real
 * `inject()` path can be unit-tested; `index.ts` wires it into the plugin
 * entry. `resolveHookToken` below dynamically `import()`s
 * `openclaw/plugin-sdk/secret-input-runtime` and
 * `openclaw/plugin-sdk/secret-ref-runtime` — but only when
 * `wsNotifications.hookToken` is actually configured as a SecretRef object
 * (#20) — so the plain-string/env-fallback paths (and every existing test)
 * stay entirely free of the plugin SDK, and tests that *do* exercise the
 * SecretRef path can `vi.mock(...)` those two specifiers.
 */

import * as path from "node:path";
import type { NotificationFrame } from "./ws-service.js";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  DEDUP_STATE_FILENAME,
  NotificationDedupStore,
  PENDING_WAKES_FILENAME,
  PendingWakeStore,
  pendingWakeKey,
  resolveStateDir,
} from "./notification-state-store.js";

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
  /**
   * Leading-edge settle window (ms, #25): how long the first qualifying
   * frame in an idle window waits before its wake fires. Any further frame
   * arriving during this settle joins the same leading wake. Default 10000
   * (10s).
   */
  wakeSettleMs?: number;
  /**
   * Trailing coalesce window (ms, #25): once the leading wake fires, any
   * frame arriving within this window (measured from the leading fire, not
   * from the frame itself) batches into ONE follow-up wake fired at the
   * window's end — so a burst still produces at most two wake turns
   * (leading + one trailing batch). Default 30000 (30s, was 300000/5min —
   * see #25: the old trailing-only 5-minute window was the entire
   * user-visible wake lag for a single completion).
   */
  wakeCoalesceMs?: number;
  /**
   * Bearer token for the Gateway's `hooks.token` (#18) — required to call
   * `POST /hooks/agent`. Accepts either a plain string (unchanged) or a
   * SecretRef object (`{ source, provider, id }`, see
   * `openclaw/plugin-sdk/secret-input-runtime`), resolved once at injector
   * construction via `openclaw/plugin-sdk/secret-ref-runtime`'s
   * `resolveSecretRefValues` (#20) — the same shape the Gateway's own
   * `hooks.token` (`$secretRef`) can reference, so both sides can point at
   * one secrets-store entry. Resolution order: config SecretRef → config
   * plain string → the `IMAJIN_WAKE_HOOK_TOKEN` env var → none (a single
   * startup warning, wake disabled, direct-send fallback only). Never
   * logged or echoed.
   */
  hookToken?: SecretInput;
  /** Gateway hooks base path (`hooks.path` on the Gateway side). Default `/hooks`. */
  hooksPath?: string;
  /** Agent id to route the wake hook to (`hooks.allowedAgentIds` must permit it). Default `main`. */
  hookAgentId?: string;
  /**
   * Directory for this injector's persisted state (#26): the ack-dedup LRU
   * (last 500 injected notification ids) and "wake owed" markers that
   * survive a gateway restart. Defaults to a directory colocated with
   * `keypairPath` (see `resolveStateDir` in `notification-state-store.ts`).
   */
  stateDir?: string;
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
// Leading-edge settle window (#25): the first frame in an idle window fires
// its own wake after this delay; anything joining before it fires batches
// into that same leading wake.
export const DEFAULT_WAKE_SETTLE_MS = 10_000;
// Trailing coalesce window for Warp wake turns, measured from the moment
// the leading wake fires (#25). Was 300_000 (5 min) — trailing-only meant a
// single completion waited the entire window; leading-edge + trailing now
// surfaces a single completion in ~DEFAULT_WAKE_SETTLE_MS instead.
export const DEFAULT_WAKE_COALESCE_MS = 30_000;
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
// Backoff schedule for `POST /hooks/agent` retries (#26): a transient
// gateway hiccup (5xx, timeout, connection refused) gets these 3 retries
// before falling back to the Telegram ping. Exported for unit tests.
export const HOOK_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];

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

/** One artifact attached to a completed run (`data.artifacts[]`, #22). */
export interface WakeArtifact {
  type: string;
  url: string;
  branch?: string;
}

interface WakeRunData {
  runId?: string;
  state?: string;
  title?: string;
  runTime?: string;
  statusMessage?: string;
  errorCode?: string;
  artifacts: WakeArtifact[];
}

const FAILURE_STATE_RE = /FAILED|ERROR|CANCEL/i;
// Kept in sync with `buildNotificationText`'s truncation of a run's status
// text: an excerpt is evidence, the full (potentially huge) message is not.
const STATUS_MESSAGE_EXCERPT_CHARS = 300;

/**
 * `data.statusMessage`'s actual wire shape (verified against `imajin-ai`,
 * the kernel this plugin talks to, 2026-09-06): Warp's `RunStatusMessage` is
 * an object, `{ message: string, errorCode: string | null, retryable:
 * boolean | null }` (`apps/kernel/src/lib/warp/dispatch.ts`'s
 * `WarpRunStatusMessage`, set verbatim as `statusMessage: run.statusMessage`
 * by both `publishRunCompleted` and `publishRunFailed`), and the bus's
 * `notify` reactor (`packages/bus/src/reactors/notify.ts`) spreads the
 * entire event payload — `data: { ...event.payload, … }` — into the
 * notification's `data` unchanged, so this plugin receives that same nested
 * object on every path in the kernel source, never a flattened string.
 * `data.errorCode` is not actually a top-level field the kernel sends
 * either (its flat scalar for FAILED/BLOCKED is `summary`, not
 * `errorCode`) — so a bare string `data.statusMessage` or a top-level
 * `data.errorCode` are accepted here only as forward/backward compatibility
 * for a future or alternate publisher, not because the current kernel sends
 * them.
 */
function extractStatusMessage(raw: unknown): { text?: string; errorCode?: string } {
  if (typeof raw === "string") {
    return { text: raw || undefined };
  }
  if (raw && typeof raw === "object") {
    const sm = raw as Record<string, unknown>;
    const text = typeof sm.message === "string" && sm.message ? sm.message : undefined;
    const errorCode = typeof sm.errorCode === "string" && sm.errorCode ? sm.errorCode : undefined;
    return { text, errorCode };
  }
  return {};
}

/**
 * Projects the fields the wake message needs out of a notification frame's
 * `data` — the same `{ runId, state, title, runTime, statusMessage,
 * artifacts[] }` shape the WS push (`warp.run.completed`) carries (#22). No
 * Warp/kernel API calls; this is a pure projection of what already arrived
 * over the WS frame.
 */
function extractWakeRunData(nf: NotificationFrame): WakeRunData {
  const data = (nf.data && typeof nf.data === "object" ? nf.data : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const rawArtifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
  const artifacts: WakeArtifact[] = rawArtifacts
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => ({ type: str(a.type) ?? "artifact", url: str(a.url) ?? "", branch: str(a.branch) }))
    .filter((a) => a.url);
  // A top-level `data.errorCode` (this plugin's original assumption) wins
  // when present; otherwise fall back to the nested/string statusMessage's
  // own errorCode. See `extractStatusMessage`'s doc for why both exist.
  const statusMessage = extractStatusMessage(data.statusMessage);
  return {
    runId: str(data.runId),
    state: str(data.state),
    title: str(data.title),
    runTime: str(data.runTime),
    statusMessage: statusMessage.text,
    errorCode: str(data.errorCode) ?? statusMessage.errorCode,
    artifacts,
  };
}

/**
 * Derives a display state (`SUCCEEDED`/`FAILED`/`CANCELLED`/…) when the WS
 * payload's `data.state` is missing, by scanning the title — how every
 * notification observed before #22 carried this information.
 */
function deriveWakeState(nf: NotificationFrame, dataState: string | undefined): string {
  if (dataState) return dataState.toUpperCase();
  const match = /\b(SUCCEEDED|FAILED|CANCELLED|CANCELED|ERRORED?|TIMEOUT|BLOCKED)\b/i.exec(
    nf.title ?? "",
  );
  if (!match) return "UNKNOWN";
  return match[1].toUpperCase().replace("CANCELED", "CANCELLED").replace(/^ERRORED?$/, "ERROR");
}

function isFailureState(state: string): boolean {
  return FAILURE_STATE_RE.test(state);
}

/** Collapses embedded newlines to a single space — a title is one line of evidence. */
function collapseNewlines(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** Renders one run's evidence block (see `buildWakeTurnMessage`). */
function formatWakeRunEntry(nf: NotificationFrame): string {
  const data = extractWakeRunData(nf);
  const state = deriveWakeState(nf, data.state);
  const title = collapseNewlines(data.title ?? nf.title ?? nf.scope);
  const lines = [`- runId: ${data.runId ?? nf.id}`, `  state: ${state}`, `  title: ${title}`];
  if (data.runTime) lines.push(`  runTime: ${data.runTime}`);
  if (data.artifacts.length > 0) {
    lines.push("  artifacts:");
    for (const a of data.artifacts) {
      lines.push(`    - ${a.type} ${a.url}${a.branch ? ` (${a.branch})` : ""}`);
    }
  }
  if (isFailureState(state)) {
    if (data.errorCode) lines.push(`  errorCode: ${data.errorCode}`);
    if (data.statusMessage) {
      lines.push(`  statusMessage: ${truncate(data.statusMessage, STATUS_MESSAGE_EXCERPT_CHARS)}`);
    }
  }
  lines.push(`  notificationId: ${nf.id}`);
  return lines.join("\n");
}

/**
 * Renders the wake hook's `message` body (#22): evidence, not instructions.
 * One entry per completed run in the batch — runId, state, title, runTime,
 * artifacts, and (for FAILED/CANCELLED only) errorCode/a short statusMessage
 * excerpt — plus notificationId for cross-checking against the WS/backlog
 * delivery. No imperative sentences: the standing behaviour for what to do
 * with a completed run lives on the agent side (AGENTS.md / skills), not in
 * this payload. FAILED/CANCELLED runs sort first. The Gateway's untrusted
 * wrapping (SECURITY NOTICE / `EXTERNAL_UNTRUSTED_CONTENT` fences) is applied
 * on top of this by the Gateway itself and is out of scope here.
 */
export function buildWakeTurnMessage(scope: string, frames: NotificationFrame[]): string {
  const sorted = [...frames].sort((a, b) => {
    const aFail = isFailureState(deriveWakeState(a, extractWakeRunData(a).state)) ? 0 : 1;
    const bFail = isFailureState(deriveWakeState(b, extractWakeRunData(b).state)) ? 0 : 1;
    return aFail - bFail;
  });
  const header = `${scope} × ${frames.length}`;
  return [header, "", sorted.map(formatWakeRunEntry).join("\n\n")].join("\n");
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

type HookTokenSource = "secretRef" | "config" | "env" | "none";

/**
 * Resolves `wsNotifications.hookToken` (#20). Resolution order: config
 * SecretRef -> config plain string -> the `IMAJIN_WAKE_HOOK_TOKEN` env var
 * -> none. Only the SecretRef branch ever touches the plugin SDK, and it
 * does so via a dynamic `import()` so the plain-string/env paths (and every
 * test that doesn't configure a SecretRef) never need those two specifiers
 * to resolve on disk — see the module doc at the top of this file.
 */
async function resolveHookToken(
  api: any,
  raw: SecretInput | undefined,
): Promise<{ token: string | undefined; source: HookTokenSource }> {
  if (raw && typeof raw === "object") {
    try {
      const { isSecretRef } = await import("openclaw/plugin-sdk/secret-input-runtime");
      if (isSecretRef(raw)) {
        const { resolveSecretRefValues } = await import("openclaw/plugin-sdk/secret-ref-runtime");
        const config = api?.runtime?.config?.current?.() ?? {};
        const resolved = await resolveSecretRefValues([raw], { config, env: process.env });
        // Exactly one ref went in, so at most one resolved value comes back —
        // the resolver keys its Map by an internal ref-key we don't have a
        // public accessor for, so grab the (sole) value directly.
        const value = resolved.values().next().value;
        const trimmed = typeof value === "string" ? value.trim() : "";
        if (trimmed) {
          return { token: trimmed, source: "secretRef" };
        }
        console.warn(
          "[imajin-ws] wsNotifications.hookToken SecretRef resolved to an empty/non-string value — falling back",
        );
      } else {
        console.warn(
          "[imajin-ws] wsNotifications.hookToken is an object but not a recognized SecretRef — falling back",
        );
      }
    } catch (err: any) {
      // Never resolves to a throw: an unresolvable ref degrades to the next
      // tier (env, then none) rather than crashing the WS service (#20).
      console.warn(
        `[imajin-ws] wsNotifications.hookToken SecretRef failed to resolve: ${err?.message ?? err} — falling back`,
      );
    }
  } else if (typeof raw === "string" && raw.trim()) {
    return { token: raw.trim(), source: "config" };
  }

  const envToken = process.env[HOOK_TOKEN_ENV]?.trim();
  if (envToken) {
    return { token: envToken, source: "env" };
  }
  return { token: undefined, source: "none" };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wraps `postWakeHook` with the `HOOK_RETRY_DELAYS_MS` backoff policy (#26):
 * a non-2xx/network failure is retried up to 3 times before the caller falls
 * back to the Telegram ping. Callers are responsible for deciding whether
 * the final outcome clears or retains the persisted "wake owed" marker.
 */
export async function postWakeHookWithRetries(
  params: Parameters<typeof postWakeHook>[0],
): Promise<WakeHookResult> {
  let result = await postWakeHook(params);
  let attempt = 0;
  for (const delayMs of HOOK_RETRY_DELAYS_MS) {
    if (result.ok) {
      return result;
    }
    attempt += 1;
    console.warn(
      `[imajin-ws] wake hook attempt ${attempt} failed (${result.reason}) — retrying in ${delayMs}ms`,
    );
    await sleep(delayMs);
    result = await postWakeHook(params);
  }
  return result;
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
 * 2. Coalesce (#25): leading-edge + trailing. The first qualifying frame in an
 *    idle window fires its own wake after a short settle (`wakeSettleMs`);
 *    anything joining before that settle elapses batches into the same
 *    leading wake. Once the leading wake fires, any frame arriving within
 *    the following `wakeCoalesceMs` window batches into ONE trailing wake
 *    fired at that window's end — so a burst produces at most two wake
 *    turns. Both wakes of one window share the window's start time but are
 *    kept distinct via a `:leading`/`:trailing` suffix
 *    (`Idempotency-Key: imajin-wake:<scope>:<windowStart>:<leading|trailing>`),
 *    so a replayed frame can never double-wake either one — this replaces
 *    the tag-based unschedule/coalesce #13/#17 used previously;
 *    `unschedulePluginSessionTurnsByTag` is gated the same bundled-only way
 *    as `scheduleSessionTurn` and cannot be used by a third-party plugin
 *    either way.
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
export interface NotificationInjectorDeps {
  /**
   * Sends a frame over the authenticated WS connection — pass
   * `ImajinWsService.send` bound to the live service instance. Used only
   * for the outbound `notification_ack` frame (#26). Best-effort: when
   * omitted (e.g. tests that don't exercise the ack path) or when the
   * socket isn't open, the frame is silently dropped — the kernel replays
   * un-acked notifications on reconnect, so this is safe.
   */
  sendFrame?: (frame: unknown) => void;
  /** Used only to derive the default `stateDir` (colocated with the keypair file) when `wsNotifications.stateDir` is not set. */
  keypairPath?: string;
}

export function createNotificationInjector(
  api: any,
  wsNotifications: WsNotificationsConfig | undefined,
  deps: NotificationInjectorDeps = {},
): { inject: (nf: NotificationFrame) => Promise<void>; dispose: () => void; ready: Promise<void> } {
  const injectScopes = new Set(wsNotifications?.injectScopes ?? []);
  const targetSession = wsNotifications?.targetSession?.trim();
  const wakeSessionKey = wsNotifications?.wakeSessionKey?.trim() ?? targetSession;
  const wakeCoalesceMs = wsNotifications?.wakeCoalesceMs ?? DEFAULT_WAKE_COALESCE_MS;
  const wakeSettleMs = wsNotifications?.wakeSettleMs ?? DEFAULT_WAKE_SETTLE_MS;
  // Resolved once here (not per request, #20) — `flushWakeTurn` awaits
  // `hookTokenReady` before reading `hookToken`.
  let hookToken: string | undefined;
  const hookTokenReady: Promise<void> = resolveHookToken(api, wsNotifications?.hookToken)
    .then((result) => {
      hookToken = result.token;
      if (result.source === "none") {
        console.warn("[imajin-ws] wake hook token not configured; wake disabled, fallback only");
      } else {
        console.log(`[imajin-ws] wake hook token resolved from ${result.source}`);
      }
    })
    .catch((err: any) => {
      console.error("[imajin-ws] unexpected error resolving wsNotifications.hookToken:", err?.message ?? err);
    });
  const hooksPath = (wsNotifications?.hooksPath?.trim() || DEFAULT_HOOKS_PATH).replace(/\/+$/, "") || DEFAULT_HOOKS_PATH;
  const hookAgentId = wsNotifications?.hookAgentId?.trim() || DEFAULT_HOOK_AGENT_ID;

  // Persisted state (#26): ack-dedup LRU + "wake owed" markers so a kernel
  // replay after a gateway restart is acked-but-not-reinjected, and any wake
  // that was buffered but never confirmed delivered is retried immediately
  // on the next start rather than silently lost. Best-effort: a missing
  // `stateDir` degrades to in-memory-only behavior (see `notification-state-store.ts`).
  const sendFrame = deps.sendFrame ?? (() => {});
  const stateDir = resolveStateDir(wsNotifications?.stateDir, deps.keypairPath);
  const dedupStore = new NotificationDedupStore(
    stateDir ? path.join(stateDir, DEDUP_STATE_FILENAME) : undefined,
  );
  const pendingWakeStore = new PendingWakeStore(
    stateDir ? path.join(stateDir, PENDING_WAKES_FILENAME) : undefined,
  );

  /**
   * Sends the kernel-facing `notification_ack` frame (#26). Never called
   * before the durable-enqueue step succeeds; a best-effort no-op when the
   * socket isn't open (`ImajinWsService.send` drops + logs it).
   */
  function sendAck(id: string): void {
    sendFrame({ type: "notification_ack", id });
  }

  // Loaded once at construction (mirrors `hookTokenReady`'s pattern below).
  // `inject()` awaits this before consulting the dedup store. Once loaded,
  // immediately replay any wake that was owed but never confirmed delivered
  // before the last restart (#2098 Candidate B) — no fresh coalesce wait.
  const stateReady: Promise<void> = Promise.all([dedupStore.load(), pendingWakeStore.load()])
    .then(() => {
      for (const [key, owed] of pendingWakeStore.all()) {
        // The persisted key carries a `:leading`/`:trailing` suffix appended
        // below (see `flushWakeTurn`'s `pendingKey`) so a restart replays the
        // right phase's Idempotency-Key even though `PendingWakeRecord`
        // itself has no phase field (#25). Any older, pre-#25 key (no
        // suffix) replays as `leading` — the only phase that existed then.
        const phase: "leading" | "trailing" = key.endsWith(":trailing") ? "trailing" : "leading";
        console.log(
          `[imajin-ws] replaying owed wake ${key} from persisted state (${owed.frames.length} notification(s))`,
        );
        void flushWakeTurn(owed.scope, owed.frames, owed.sinceTs, phase);
      }
    })
    .catch((err: any) => {
      console.error("[imajin-ws] failed to load persisted notification state:", err?.message ?? err);
    });

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

  // In-memory coalesce state, keyed by scope (#25: leading-edge + trailing —
  // see the module doc comment above). `windowStart` is the wall-clock time
  // the *leading* phase opened; it stays fixed across both phases of one
  // window so the `:leading`/`:trailing`-suffixed Idempotency-Key stays
  // stable per scope+window (repeated flushes of the same phase collide
  // instead of double-waking), while a brand-new window after the trailing
  // phase closes gets a fresh `windowStart`.
  interface CoalesceState {
    phase: "leading" | "trailing";
    timeout: ReturnType<typeof setTimeout>;
    frames: NotificationFrame[];
    windowStart: number;
  }
  const coalesceByScope = new Map<string, CoalesceState>();

  console.log(
    `[imajin-ws] injection APIs: enqueueSystemEvent=${!!enqueueSystemEvent}, directSend=${!!ds?.target}`,
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
    console.log(
      `[imajin-ws] wake turns → session ${wakeSessionKey} (settle ${wakeSettleMs}ms, coalesce ${wakeCoalesceMs}ms)`,
    );
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

  async function flushWakeTurn(
    scope: string,
    frames: NotificationFrame[],
    windowStart: number,
    phase: "leading" | "trailing",
  ) {
    // Distinct-but-deterministic per phase (#25): both wakes of one window
    // share `windowStart`, so the suffix is what keeps a replayed frame from
    // double-waking either the leading or the trailing wake independently.
    const pendingKey = `${pendingWakeKey(scope, windowStart)}:${phase}`;
    await hookTokenReady;

    if (!wakeSessionKey) {
      if (!warnedMissingWakeKey) {
        warnedMissingWakeKey = true;
        console.warn(
          "[imajin-ws] cannot run wake turn: no wakeSessionKey (or targetSession) configured",
        );
      }
      // Static misconfiguration, not a transient failure — retrying on every
      // future restart would only repeat the same warning forever (#26).
      await pendingWakeStore.delete(pendingKey);
      return;
    }

    // Evidence, not instructions (#22): one entry per run in the batch, no
    // imperative sentences — see `buildWakeTurnMessage`.
    const message = buildWakeTurnMessage(scope, frames);

    if (!hookToken) {
      // The single startup warning already fired in `hookTokenReady`'s
      // `.then()` above (#20) — nothing new to log per dropped wake. Same
      // "static config, don't keep retrying" reasoning as the missing
      // wakeSessionKey branch above.
      await escalateWakeFailure(scope, frames, "no hook token configured");
      await pendingWakeStore.delete(pendingKey);
      return;
    }

    const idempotencyKey = `imajin-wake:${scope}:${windowStart}:${phase}`;
    const gatewayPort = resolveGatewayPort(api);
    const result = await postWakeHookWithRetries({
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
          `(${phase}, ${frames.length} notification(s) coalesced)`,
      );
      await pendingWakeStore.delete(pendingKey);
      return;
    }

    console.error(
      `[imajin-ws] wake hook FAILED for ${scope} → ${wakeSessionKey}: ${result.reason} (${phase}, ${frames.length} notification(s) coalesced)`,
    );
    // Marker intentionally retained: a transient hook failure (unlike the two
    // static-misconfiguration branches above) is worth retrying on the next
    // restart (#26) — cleared only once `postWakeHookWithRetries` reports 2xx.
    await escalateWakeFailure(scope, frames, result.reason ?? "unknown wake hook failure");
  }

  /**
   * Fires when a scope's leading settle (`wakeSettleMs`) elapses (#25).
   * Flushes whatever batched during the settle as the leading wake, then
   * immediately opens the trailing phase for `wakeCoalesceMs` so any frame
   * that arrives while the (possibly slow, retried) leading flush is still
   * in flight joins the trailing batch rather than being lost or re-joining
   * the batch that's already being sent.
   */
  function onLeadingFire(scope: string) {
    const state = coalesceByScope.get(scope);
    if (!state || state.phase !== "leading") {
      return;
    }
    const { frames, windowStart } = state;
    const trailingTimeout = setTimeout(() => onTrailingFire(scope), wakeCoalesceMs);
    coalesceByScope.set(scope, { phase: "trailing", timeout: trailingTimeout, frames: [], windowStart });
    void flushWakeTurn(scope, frames, windowStart, "leading");
  }

  /**
   * Fires when a scope's trailing window (`wakeCoalesceMs`, measured from
   * the leading wake) elapses (#25). A no-op when nothing arrived during
   * the trailing window — a single completion must never produce a second,
   * empty wake. The scope returns to idle either way, so the next frame
   * (whenever it arrives) starts a brand-new leading window.
   */
  function onTrailingFire(scope: string) {
    const state = coalesceByScope.get(scope);
    if (!state || state.phase !== "trailing") {
      return;
    }
    coalesceByScope.delete(scope);
    if (state.frames.length === 0) {
      return;
    }
    void flushWakeTurn(scope, state.frames, state.windowStart, "trailing");
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

    await stateReady;

    // Kernel-side replay after a reconnect (#2099): already durably injected
    // once, so re-ack without running enqueue/direct-send/coalesce again.
    if (dedupStore.has(nf.id)) {
      console.log(`[imajin-ws] ${nf.id} already injected for ${nf.scope} — re-acking without re-injecting`);
      sendAck(nf.id);
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

    if (queuedVia) {
      // Ack only after the durable step succeeded, never before (#26) — a
      // dropped/failed enqueue must leave the notification un-acked so the
      // kernel replays it on the next reconnect.
      await dedupStore.add(nf.id);
      sendAck(nf.id);
    } else {
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
    // session). Leading-edge + trailing coalesce (#25): see the module doc
    // comment and `onLeadingFire`/`onTrailingFire` above for the full state
    // machine. A frame joins whichever phase is currently open (leading or
    // trailing); a frame arriving while the scope is idle starts a brand-new
    // leading window.
    const existing = coalesceByScope.get(nf.scope);
    if (existing) {
      existing.frames.push(nf);
      const pendingKey = `${pendingWakeKey(nf.scope, existing.windowStart)}:${existing.phase}`;
      await pendingWakeStore.set(pendingKey, {
        scope: nf.scope,
        sinceTs: existing.windowStart,
        frames: existing.frames,
      });
      const firesInMs = existing.phase === "leading" ? wakeSettleMs : wakeCoalesceMs;
      console.log(
        `[imajin-ws] warp wake: ${existing.phase} batched ${nf.id} (n=${existing.frames.length}, fires in ~${firesInMs}ms)`,
      );
      return;
    }

    const windowStart = Date.now();
    const timeout = setTimeout(() => onLeadingFire(nf.scope), wakeSettleMs);
    coalesceByScope.set(nf.scope, { phase: "leading", timeout, frames: [nf], windowStart });
    await pendingWakeStore.set(`${pendingWakeKey(nf.scope, windowStart)}:leading`, {
      scope: nf.scope,
      sinceTs: windowStart,
      frames: [nf],
    });
    console.log(`[imajin-ws] warp wake: leading batched ${nf.id} (n=1, fires in ${wakeSettleMs}ms)`);
  }

  return { inject, dispose, ready: stateReady };
}
