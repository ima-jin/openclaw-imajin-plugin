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
import { WakeBridgeStore, type HorizonWakeAdapter } from "./wake-bridge.js";
import { readWakeSessionTokens } from "./wake-session-metadata.js";
import { buildWakeOutcome } from "./wake-outcome.js";
import { createLoopbackSessionGateway } from "./session-command-gateway.js";
import { DEFAULT_WAKE_DECISION_MODEL, WakeDecisionRouter, type WakeHookContext, type WakeToolEvent } from "./wake-decision.js";
import { WakeGuards } from "./wake-guards.js";
import { buildWakeLiveState, type WakeLiveState } from "./wake-live-state.js";
import type { WakeDisclosureSender } from "./wake-report-tool.js";
import {
  DEFAULT_WAKE_MAX_TOKENS,
  DEFAULT_WAKE_SESSION,
  deriveWakeSessionKey,
  rotateWakeSessionKey,
  WakeSupervisor,
} from "./wake-supervisor.js";
import type { NotificationFrame } from "./ws-service.js";
import { isReachFrame, isReachScope, type ReachEventsConfig } from "./reach-events.js";
import { sendDirectChannelMessage } from "./channel-notify.js";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { findFinalAssistantMessage, type AgentEndEvent } from "./turn-usage-attestation.js";
import {
  parseReportTo,
  extractWakeBatchId,
  extractFinalAssistantOutput,
  WAKE_REPORT_HOOK_NAME,
  WakeReporter,
  type WakeReportDeliver,
  type WakeRunSummary,
} from "./wake-report.js";
import {
  DEDUP_STATE_FILENAME,
  NotificationDedupStore,
  PENDING_WAKES_FILENAME,
  type PendingWakeRecord,
  PendingWakeStore,
  pendingWakeKey,
  resolveStateDir,
} from "./notification-state-store.js";

/** `plugins.entries.imajin.config.wsNotifications` (openclaw.json). */
export interface WsNotificationsConfig {
  /** Signed reach events use a separate untrusted adapter, never the Warp wake pipeline. */
  reach?: ReachEventsConfig;
  /** Notification scopes that should wake the agent, e.g. `warp.run.completed`. */
  injectScopes?: string[];
  /** Wake base key or {batchId}/{runId} template. Default agent:main:warp-events. */
  targetSession?: string;
  /** Fresh per-batch sessions by default. Explicit false preserves fixed-key routing. */
  sessionPerWake?: boolean;
  /** Context threshold for rotation; default and ceiling 50000 tokens. */
  maxSessionTokens?: number;
  /** Cumulative per-wake usage (including delegated work); default 80000. */
  maxWakeTokens?: number;
  /** Coordinator model; omitted keeps the host's configured wake-agent model. */
  model?: string;
  /** Model pinned on decision subagents; default anthropic/claude-opus-5-5. */
  decisionModel?: string;
  /** Absolute authenticated GitHub CLI path; default /usr/bin/gh, never PATH lookup. */
  githubCliPath?: string;
  /** Missing-completion watchdog; default 15 minutes, clamped to 1ms..60 minutes. */
  wakeTimeoutMs?: number;
  /** Bounded plugin-owned open-work file; default stateDir/wake-bridge.json. */
  bridgeStatePath?: string;
  /** Future horizon read / signed-step adapter opt-in; false by default. */
  horizonEnabled?: boolean;
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
   * Age bound (ms, #30) for a persisted "wake owed" marker replayed at
   * startup: when a marker is older than this, its frames were already
   * durably injected (`enqueueSystemEvent` succeeded before the marker was
   * ever written — see `PendingWakeRecord.injected`), so instead of firing a
   * possibly very stale wake turn, the marker is dropped with a log line
   * (`owed wake expired for <scope> … — injected only`) and the agent picks
   * the context up on its next natural turn. Default 3600000 (1h). Guards
   * against exactly the 2026-09-09 incident: ~20 owed markers, some many
   * hours stale, all replaying as live wakes the moment the hook token was
   * fixed.
   */
  wakeOwedMaxAgeMs?: number;
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
  /**
   * Session keys (e.g. `agent:main:telegram:direct:<id>`) the wake worker
   * discloses to (#47). After a wake turn completes in the wake session, its
   * final assistant output — or "no output" plus the run state — is forwarded
   * once per wake batch to each of these sessions, wrapped as a report from
   * warp-events (informational, not a wake). Default empty = no reports.
   * Invalid entries are logged once and ignored.
   */
  reportTo?: string[];
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

/** External adapters/metadata cannot wedge the wake lane. */
async function withWakeDeadline<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("wake adapter timeout")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
// Age bound for a persisted owed-wake marker replayed at startup (#30):
// beyond this, the marker's frames are treated as inject-only (they already
// reached the agent's context via `enqueueSystemEvent`) rather than worth a
// fresh, possibly very stale, wake turn.
export const DEFAULT_WAKE_OWED_MAX_AGE_MS = 3_600_000;
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
export function buildWakeFailureMessage(frames: NotificationFrame[], reason: string, maxChars = 900): string {
  const title =
    frames.length === 1 ? (frames[0].title ?? frames[0].scope) : `${frames.length} Warp runs`;
  return truncate(
    `⚠️ Warp run ${frames.map((f) => extractWakeRunData(f).runId ?? f.id).slice(0, 5).join(", ")}: ${reason} — automatic wake failed; ${title}`,
    maxChars,
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

/** Per-run `{ runId, state, title }` for a wake batch — what a #47 report names. */
function summarizeWakeRuns(frames: NotificationFrame[]): WakeRunSummary[] {
  return frames.map((nf) => {
    const data = extractWakeRunData(nf);
    return {
      runId: data.runId ?? nf.id,
      state: deriveWakeState(nf, data.state),
      title: collapseNewlines(data.title ?? nf.title ?? nf.scope),
    };
  });
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
  const entries: string[] = [];
  let bytes = Buffer.byteLength(header) + 2;
  for (const frame of sorted.slice(0, 50)) {
    const entry = formatWakeRunEntry(frame);
    const bounded = Buffer.from(entry.slice(0, 4_000)).subarray(0, 4_000).toString("utf8");
    if (bytes + Buffer.byteLength(bounded) + 64 > 16_000) break;
    entries.push(bounded);
    bytes += Buffer.byteLength(bounded) + 2;
  }
  if (entries.length < frames.length) entries.push("[Additional wake evidence omitted; retained in pending state/bridge]");
  return [header, "", entries.join("\n\n")].join("\n");
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
    } catch {
      // Never resolves to a throw: an unresolvable ref degrades to the next
      // tier (env, then none) rather than crashing the WS service (#20).
      console.warn(
        "[imajin-ws] wsNotifications.hookToken SecretRef failed to resolve — falling back",
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
  /**
   * `wake-pending` (#31): the payload is already durable and a wake is
   * either running or queued behind one that is — a client-side timeout, or
   * a 503 whose JSON body carries a `runId` (the gateway queued the run but
   * couldn't start it before its admission window). Always `false` when
   * `ok` is `true`. Callers must not walk the retry ladder for this case
   * and must keep the owed marker — see `postWakeHookWithRetries` and
   * `flushWakeTurn`.
   */
  pending?: boolean;
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
  /** Hook run label; defaults to the wake's `imajin-wake`. */
  name?: string;
  model?: string;
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
        idempotencyKey: params.idempotencyKey,
        sessionMode: "persistent",
        sessionKey: params.sessionKey,
        deliver: true,
        name: params.name ?? "imajin-wake",
        ...(params.model ? { model: params.model } : {}),
      }),
      signal: controller.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text().catch(() => "");
      if (res.status === 503) {
        // Admission-timeout 503 (#31): the gateway queued the run — it
        // returns the queued `runId` in the JSON body — but couldn't start
        // it before its admission window. Distinguishable from a "real" 503
        // (gateway down/rejecting) only by that `runId`; a non-JSON or
        // runId-less 503 body falls through to the retryable-failure return
        // below, unchanged from before #31.
        let queuedRunId: string | undefined;
        try {
          const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
          const rawId = body?.runId;
          queuedRunId = typeof rawId === "string" ? rawId : undefined;
        } catch {
          // Not the admission-timeout JSON shape — treat as a real 503 below.
        }
        if (queuedRunId) {
          return {
            ok: false,
            pending: true,
            runId: queuedRunId,
            reason: "gateway queued the run but it did not start before the admission timeout",
          };
        }
      }
      return { ok: false, reason: `gateway returned ${res.status}` };
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
    if (err?.name === "AbortError") {
      // Client-side timeout (#31): the gateway accepted the POST but the
      // agent turn didn't return within HOOK_REQUEST_TIMEOUT_MS — a normal
      // turn is longer than that under any load, so this is not evidence
      // the wake was refused, just that it's still running/queued.
      return { ok: false, pending: true, reason: `timed out after ${HOOK_REQUEST_TIMEOUT_MS}ms` };
    }
    const reason = "gateway transport failure";
    return { ok: false, reason };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
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
  onFailure?: (reason: string) => void,
  signal?: AbortSignal,
): Promise<WakeHookResult> {
  let result = await postWakeHook(params);
  if (result.pending) {
    // wake-pending (#31): never walk the retry ladder — the payload is
    // already durable and a wake is either running or queued behind one
    // that is, so retrying here would only add more queued turns for the
    // same session. The caller logs one summary line and keeps the owed
    // marker; a later 2xx (this run or a replay after restart) clears it.
    return result;
  }
  let attempt = 0;
  for (const delayMs of HOOK_RETRY_DELAYS_MS) {
    if (result.ok) {
      return result;
    }
    onFailure?.(result.reason ?? "wake hook failed");
    attempt += 1;
    console.warn(
      `[imajin-ws] wake hook attempt ${attempt} failed (${result.reason}) — retrying in ${delayMs}ms`,
    );
    await sleep(delayMs, signal);
    if (signal?.aborted) return result;
    result = await postWakeHook(params);
    if (result.pending) {
      return result;
    }
  }
  if (!result.ok) onFailure?.(result.reason ?? "wake hook failed");
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
 * 1. Persist fresh-batch evidence locally before ack; fixed-mode compatibility
 *    retains guarded `enqueueSystemEvent` injection.
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
 * 3. Run a real agent turn in a fresh batch session (or explicit fixed key) via
 *    the local Gateway's
 *    `POST /hooks/agent` (`postWakeHook` above) instead of the bundled-only
 *    `api.session.workflow.scheduleSessionTurn` seam (#13, #17): that seam
 *    returns `undefined` for any plugin with `origin !== "bundled"`
 *    (openclaw core, `src/plugins/host-hook-scheduled-turns.ts`), so it never
 *    worked for this plugin. `/hooks/agent` is first-class, documented, and
 *    upgrade-safe (docs/automation/webhook.md).
 * 4. HTTP admission is not completion: supervise agent_end and a bounded
 *    watchdog, update bridge outcomes, and alert via configured directSend.
 *    Pending admission never retries; real hook failures alert before retry.
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
  /** Harness-side adapter owns loops_get horizon reads and signed step publishing. */
  horizon?: HorizonWakeAdapter;
  /** Test seam; production uses scoped session metadata from the public SDK. */
  sessionTokens?: (sessionKey: string) => Promise<number | undefined>;
  /** Test seam for bounded GitHub PR reads; production uses authenticated gh. */
  liveStateLookup?: (url: string) => Promise<unknown>;
  /** Test seam; production uses the existing authenticated loopback adapter. */
  abortWake?: (sessionKey: string, runId?: string) => Promise<void>;
}

export function createNotificationInjector(
  api: any,
  wsNotifications: WsNotificationsConfig | undefined,
  deps: NotificationInjectorDeps = {},
): {
  inject: (nf: NotificationFrame) => Promise<void>;
  dispose: () => void;
  ready: Promise<void>;
  /**
   * Always installed for wake supervision; also forwards optional reportTo reports.
   */
  onAgentEnd?: (event: AgentEndEvent, ctx?: { sessionKey?: string; runId?: string }) => Promise<void>;
  runtimeHooks: Record<string, (event: any, ctx?: any) => unknown>;
  reportWake: WakeDisclosureSender;
} {
  const injectScopes = new Set(wsNotifications?.injectScopes ?? []);
  const targetSession = wsNotifications?.targetSession?.trim() || DEFAULT_WAKE_SESSION;
  const hookAgentId = wsNotifications?.hookAgentId?.trim() || DEFAULT_HOOK_AGENT_ID;
  const configuredWakeKey = wsNotifications?.wakeSessionKey?.trim() || targetSession;
  // The gateway re-scopes agent-prefixed hook keys to the selected target agent.
  const wakeSessionKey = configuredWakeKey.replace(/^agent:[^:]+:/, `agent:${hookAgentId}:`);
  const sessionPerWake = wsNotifications?.sessionPerWake !== false;
  const freshSessions = sessionPerWake || /\{(?:batchId|runId)\}/.test(wakeSessionKey);
  const configuredMax = wsNotifications?.maxSessionTokens;
  const maxSessionTokens = typeof configuredMax === "number" && Number.isFinite(configuredMax)
    ? Math.max(1, Math.min(DEFAULT_WAKE_MAX_TOKENS, configuredMax)) : DEFAULT_WAKE_MAX_TOKENS;
  const readTokens = deps.sessionTokens ?? ((sessionKey: string) => readWakeSessionTokens(api, sessionKey));
  const lifecycle = new AbortController();
  let reusedSessionKey = wakeSessionKey;
  let allocatedFreshReuseKey = false;
  const reservedTokens = new Map<string, number>();
  const wakeCoalesceMs = wsNotifications?.wakeCoalesceMs ?? DEFAULT_WAKE_COALESCE_MS;
  const wakeSettleMs = wsNotifications?.wakeSettleMs ?? DEFAULT_WAKE_SETTLE_MS;
  const wakeOwedMaxAgeMs = wsNotifications?.wakeOwedMaxAgeMs ?? DEFAULT_WAKE_OWED_MAX_AGE_MS;
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
    .catch(() => {
      console.error("[imajin-ws] unexpected error resolving wsNotifications.hookToken");
    });
  const hooksPath = (wsNotifications?.hooksPath?.trim() || DEFAULT_HOOKS_PATH).replace(/\/+$/, "") || DEFAULT_HOOKS_PATH;

  // #47: the wake worker discloses to `reportTo` sessions. Validated once here
  // (invalid keys log once); no reporter at all when nothing valid is left.
  const reportTargets = parseReportTo(wsNotifications?.reportTo, wakeSessionKey);
  const deliverWakeReport: WakeReportDeliver = async (target, message, idempotencyKey) => {
    await hookTokenReady;
    if (!hookToken) {
      return { ok: false, reason: "no hook token configured" };
    }
    return postWakeHookWithRetries({
      gatewayPort: resolveGatewayPort(api),
      hooksPath,
      hookToken,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      message,
      idempotencyKey,
      name: WAKE_REPORT_HOOK_NAME,
    });
  };
  if (reportTargets.length > 0 && !wakeSessionKey) {
    console.warn("[imajin-ws] wsNotifications.reportTo is set but there is no wake session — nothing to report on");
  }
  const wakeReporter =
    reportTargets.length > 0 && wakeSessionKey
      ? new WakeReporter({ wakeSessionKey, targets: reportTargets, deliver: deliverWakeReport })
      : undefined;

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
  const bridge = new WakeBridgeStore(
    wsNotifications?.bridgeStatePath ?? (stateDir ? path.join(stateDir, "wake-bridge.json") : undefined),
    (message) => console.warn(message),
  );
  const bridgeReady = bridge.load();
  const horizon = wsNotifications?.horizonEnabled === true ? deps.horizon : undefined;
  const supervisor = new WakeSupervisor({
    timeoutMs: wsNotifications?.wakeTimeoutMs,
    maxTokens: maxSessionTokens,
    sessionTokens: readTokens,
    alert: async (batch, reason) => {
      const frames: NotificationFrame[] = batch.runs.map((r) => ({
        type: "notification", id: r.runId, title: r.title, scope: batch.scope,
        body: null, createdAt: "", data: { runId: r.runId },
      }));
      await sendChannelMessage(buildWakeFailureMessage(frames,
        `session: ${batch.sessionKey}\n${reason}`, 3_600)).catch(() => {
        console.error("[imajin-ws] wake alert delivery failed; check directSend configuration");
      });
    },
    complete: async (batch, event) => {
      reservedTokens.delete(batch.sessionKey);
      const outcome = buildWakeOutcome(batch.runs.map((r) => r.runId), event);
      await bridge.recordOutcome(outcome);
      if (event.wakeWatchdog !== true) {
        await pendingWakeStore.delete(batch.batchId.replace(/^imajin-wake:/, ""));
      }
      if (horizon) {
        await withWakeDeadline(horizon.writeStepEvents(outcome)).catch(() => {
          console.warn("[imajin-ws] horizon step writeback failed; outcome retained in bridge");
        });
      }
      wakeReporter?.untrack(batch.batchId);
    },
  });
  const abortGateway = createLoopbackSessionGateway({
    getConfig: () => api?.runtime?.config?.current?.() ?? api?.config ?? {},
    clientDisplayName: "Imajin wake guards",
  });
  const guards = new WakeGuards({
    maxTokens: wsNotifications?.maxWakeTokens,
    reportTo: reportTargets,
    alert: async (batch, reason) => {
      const evidence = [
        reason, `subject: ${batch.subject.slice(0, 500)}`, `tokens: ${batch.tokens}`,
        batch.lastTool ? `call: ${batch.lastTool.toolName} ${batch.lastTool.args.slice(0, 600)}\nlast result: ${batch.lastTool.result.slice(0, 600)}` : "",
        `last assistant: ${batch.lastAssistantLine?.slice(0, 500) ?? "(none)"}`,
      ].filter(Boolean).join("\n");
      await supervisor.alert(batch.batchId, evidence);
    },
    abort: deps.abortWake ?? (async (sessionKey, runId) => {
      await withWakeDeadline(abortGateway.gateway.abort({ sessionKey, runId }));
    }),
  });
  const decisionRouter = new WakeDecisionRouter(
    wsNotifications?.decisionModel?.trim() || DEFAULT_WAKE_DECISION_MODEL,
    reportTargets.map((target) => target.sessionKey),
    (parent, child, runId, batchId) => {
      if (!guards.aliasSession(parent, child, runId, batchId)) void guards.stop(batchId, "decision child could not be supervised");
    },
  );
  const runtimeHooks = {
    before_prompt_build: (event: unknown, ctx: WakeHookContext = {}) => decisionRouter.beforePromptBuild(event, ctx),
    before_model_resolve: (event: { prompt?: string }, ctx: WakeHookContext = {}) => decisionRouter.beforeModelResolve(event, ctx),
    before_tool_call: (event: WakeToolEvent, ctx: WakeHookContext = {}) =>
      guards.beforeToolCall(event, ctx) ?? decisionRouter.beforeToolCall(event, ctx),
    after_tool_call: async (event: WakeToolEvent, ctx: WakeHookContext = {}) => {
      decisionRouter.afterToolCall(event, ctx);
      await guards.afterToolCall(event, ctx);
    },
    before_message_write: (event: any, ctx: WakeHookContext = {}) => guards.onBeforeMessageWrite(event, ctx),
    llm_output: (event: any, ctx: WakeHookContext = {}) => guards.onLlmOutput(event, ctx),
    llm_input: (event: { prompt?: string; runId?: string; provider?: string; model?: string }, ctx: WakeHookContext = {}) => {
      const batchId = extractWakeBatchId([{ role: "user", content: event.prompt }]);
      if (batchId && event.runId && ctx.sessionKey === decisionRouter.root(ctx.sessionKey)) {
        guards.bindRunner(batchId, event.runId);
        decisionRouter.bindRunner(batchId, event.runId);
      }
      const wrongModel = decisionRouter.wrongDecisionModel(event, ctx);
      if (wrongModel) void guards.stop(wrongModel, "decision subagent model differs from configured decisionModel");
    },
    subagent_spawned: (event: any, ctx: any = {}) => decisionRouter.onSubagentSpawned(event, ctx),
  };
  const reportWake: WakeDisclosureSender = async (ctx, disclosure) => {
    const batchId = decisionRouter.batch(ctx);
    if (!batchId) throw new Error("No active Warp wake owns this report");
    if (!reportTargets.length) throw new Error("No reportTo targets configured");
    if (guards.isStopped(batchId)) throw new Error("Wake already stopped; directSend guard alert owns disclosure");
    await Promise.all(reportTargets.map(async (target) => {
      if (guards.isStopped(batchId)) throw new Error("Wake stopped before report delivery");
      const match = /^agent:[^:]+:([^:]+):(?:direct|dm|group|channel):(.+)$/.exec(target.sessionKey);
      if (!match) throw new Error("reportTo target has no channel destination");
      await sendDirectChannelMessage(
        { ...wsNotifications?.directSend, channel: match[1], target: match[2] },
        `Warp wake ${disclosure.outcome} (${batchId}): ${disclosure.message}`,
      );
      guards.recordDisclosure(batchId, target.sessionKey);
    }));
  };

  /**
   * Sends the kernel-facing `notification_ack` frame (#26). Never called
   * before the durable-enqueue step succeeds; a best-effort no-op when the
   * socket isn't open (`ImajinWsService.send` drops + logs it).
   */
  function sendAck(id: string): void {
    sendFrame({ type: "notification_ack", id });
  }

  // Per-target-session in-flight cap (#30, default 1): every wake POST —
  // startup replay and a live coalesce firing alike — funnels through this
  // queue so a burst behaves like a drain, never a fan-out (the Gateway
  // itself runs one turn at a time per session anyway; queuing here just
  // stops this plugin from ever offering it more than one at once). A
  // queued wake waits for the current one to *settle* — admitted (2xx),
  // wake-pending (#31, single attempt, no retry), or retries-exhausted —
  // before its own attempt starts.
  const wakeQueueBySession = new Map<string, Promise<void>>();
  function scheduleWakeTurn(
    scope: string,
    frames: NotificationFrame[],
    windowStart: number,
    phase: "leading" | "trailing",
  ): Promise<void> {
    const sessionKey = freshSessions ? `${scope}:${windowStart}:${phase}` : wakeSessionKey;
    const prior = wakeQueueBySession.get(sessionKey) ?? Promise.resolve();
    const task = prior.then(
      () => flushWakeTurn(scope, frames, windowStart, phase),
      () => flushWakeTurn(scope, frames, windowStart, phase),
    );
    // `flushWakeTurn` never throws (every branch handles its own errors), but
    // guard the queue chain anyway so one unexpected rejection can't wedge
    // every wake behind it forever.
    const guarded = task.catch(() => {
      void escalateWakeFailure(scope, frames, "unexpected wake dispatch failure");
    }).finally(() => {
      if (wakeQueueBySession.get(sessionKey) === guarded) wakeQueueBySession.delete(sessionKey);
    });
    wakeQueueBySession.set(sessionKey, guarded);
    return task;
  }

  // Loaded once at construction (mirrors `hookTokenReady`'s pattern below).
  // `inject()` awaits this before consulting the dedup store. Once loaded,
  // immediately replay any wake that was owed but never confirmed delivered
  // before the last restart (#2098 Candidate B) — no fresh coalesce wait.
  // #30: a scope can accumulate several owed markers across many failed
  // flushes before a restart (each failed flush retains its marker but
  // still moves the in-memory scope back to idle, so the next notification
  // opens a brand-new window) — replaying each one as its own wake is
  // exactly the fan-out that storms the gateway. Group by scope first, drop
  // anything older than `wakeOwedMaxAgeMs` (already durably injected, so
  // nothing is lost), then merge whatever's left into ONE leading-phase
  // wake with the union of frames and the earliest `sinceTs`.
  interface OwedEntry {
    key: string;
    owed: PendingWakeRecord;
  }
  const stateReady: Promise<void> = Promise.all([dedupStore.load(), pendingWakeStore.load(), bridgeReady])
    .then(async () => {
      const owedByScope = new Map<string, OwedEntry[]>();
      // Legacy/misconfigured reach records must never re-enter the generic
      // action-oriented wake or automatic channel fallback pipeline.
      const reachKeys = pendingWakeStore.all()
        .filter(([, owed]) => isReachScope(owed.scope))
        .map(([key]) => key);
      await pendingWakeStore.deleteMany(reachKeys);
      await bridge.ingest(pendingWakeStore.all().flatMap(([, owed]) => owed.frames));
      for (const [key, owed] of pendingWakeStore.all()) {
        const list = owedByScope.get(owed.scope) ?? [];
        list.push({ key, owed });
        owedByScope.set(owed.scope, list);
      }

      for (const [scope, entries] of owedByScope) {
        const now = Date.now();
        const live: OwedEntry[] = [];
        for (const entry of entries) {
          const age = now - entry.owed.sinceTs;
          if (age > wakeOwedMaxAgeMs && entry.owed.injected !== false) {
            // Every frame that ever reaches this store already passed
            // `enqueueSystemEvent` successfully (`inject()` below only pushes
            // into the coalesce buffer — and therefore this store — after
            // that durable step succeeds), so "injected only" always holds
            // here; `PendingWakeRecord.injected` documents that guarantee
            // rather than gating on it.
            console.log(
              `[imajin-ws] owed wake expired for ${scope} (${entry.owed.frames.length} frame(s), age ${age}ms) — injected only`,
            );
            await pendingWakeStore.delete(entry.key);
          } else {
            live.push(entry);
          }
        }
        if (live.length === 0) {
          continue;
        }

        const framesById = new Map<string, NotificationFrame>();
        let earliestSinceTs = live[0].owed.sinceTs;
        for (const entry of live) {
          earliestSinceTs = Math.min(earliestSinceTs, entry.owed.sinceTs);
          for (const f of entry.owed.frames) {
            framesById.set(f.id, f);
          }
        }
        const mergedFrames = [...framesById.values()];
        const mergedKey = `${pendingWakeKey(scope, earliestSinceTs)}:leading`;
        const needsConsolidation = live.length > 1 || live[0].key !== mergedKey;

        if (needsConsolidation) {
          // Write the merged marker BEFORE deleting the markers it subsumes
          // (each `set`/`delete` persists the whole file on its own). A crash
          // between the two must never land on "merged marker never written,
          // some source markers already gone" — that loses a wake outright.
          // Set-first means the worst a crash-between leaves behind is a
          // harmless duplicate (merged key + one or more stale source keys,
          // all describing a subset of the same union) — the next startup's
          // merge re-consolidates it idempotently (same scope, same or wider
          // union, same earliest sinceTs → same `mergedKey`), so set-first is
          // strictly safer and converges rather than losing anything.
          await pendingWakeStore.set(mergedKey, {
            scope,
            sinceTs: earliestSinceTs,
            frames: mergedFrames,
            injected: live.every((entry) => entry.owed.injected !== false),
          });
          for (const entry of live) {
            if (entry.key !== mergedKey) {
              await pendingWakeStore.delete(entry.key);
            }
          }
        }

        console.log(
          live.length > 1
            ? `[imajin-ws] replaying owed wake for ${scope} from persisted state: merged ${live.length} window(s) into ${mergedFrames.length} notification(s)`
            : `[imajin-ws] replaying owed wake ${mergedKey} from persisted state (${mergedFrames.length} notification(s))`,
        );
        void scheduleWakeTurn(scope, mergedFrames, earliestSinceTs, "leading");
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
    await sendDirectChannelMessage(ds, text);
  }
  async function discloseTerminalSubjects(message: string): Promise<boolean> {
    try {
      await sendChannelMessage(message);
      return true;
    } catch {
      console.error("[imajin-ws] terminal wake disclosure delivery failed");
      return false;
    }
  }


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
  } else {
    console.log(
      `[imajin-ws] injecting configured scopes (${freshSessions ? "fresh" : "guarded fixed"} wake sessions)`,
    );
  }
  if (wakeSessionKey) {
    console.log(
      `[imajin-ws] wake turns configured (settle ${wakeSettleMs}ms, coalesce ${wakeCoalesceMs}ms)`,
    );
  }

  /** The #14 Telegram fallback — unchanged backstop for a disabled/unreachable hook. */
  async function escalateWakeFailure(scope: string, frames: NotificationFrame[], reason: string): Promise<void> {
    try {
      await sendChannelMessage(buildWakeFailureMessage(frames, reason));
      console.log(`[imajin-ws] wake-failure fallback message sent for ${scope}`);
    } catch {
      console.error(`[imajin-ws] wake-failure fallback message FAILED for ${scope}; check directSend configuration`);
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


    // Evidence, not instructions (#22): one entry per run in the batch, no
    // imperative sentences — see `buildWakeTurnMessage`.
    await bridgeReady;
    const idempotencyKey = `imajin-wake:${scope}:${windowStart}:${phase}`;
    const continuity = await wakeContinuity(summarizeWakeRuns(frames).map((r) => r.runId));
    const liveState = await buildWakeLiveState(frames, bridge.listOpen(), {
      lookup: deps.liveStateLookup, githubCliPath: wsNotifications?.githubCliPath,
    });
    const message = `Wake batch ID: ${idempotencyKey}\n\n${liveState.preamble}\n\n${buildWakeTurnMessage(scope, frames)}\n\n${continuity}`;
    if (await handleTerminalSubjects(liveState, scope, frames, pendingKey)) return;

    if (!hookToken) {
      // The single startup warning already fired in `hookTokenReady`'s
      // `.then()` above (#20) — alert the operator and retain open work in the bridge.
      await escalateWakeFailure(scope, frames, "no hook token configured");
      await pendingWakeStore.delete(pendingKey);
      return;
    }

    const sessionKey = freshSessions
      ? deriveWakeSessionKey(wakeSessionKey, idempotencyKey, summarizeWakeRuns(frames).map((r) => r.runId), sessionPerWake)
      : await guardedReuseSession(frames);
    const gatewayPort = resolveGatewayPort(api);
    // Tracked BEFORE the POST so a fast turn can't finish unmatched (#47).
    const batch = { batchId: idempotencyKey, scope, runs: summarizeWakeRuns(frames), sessionKey, uniqueSession: freshSessions };
    wakeReporter?.track(batch);
    supervisor.track(batch);
    const guarded = guards.track({
      ...batch,
      subject: liveState.subjects.map((subject) => subject.url).join(", ") || batch.runs.map((run) => run.title).join("; "),
    });
    if (!guarded) {
      await supervisor.alert(idempotencyKey, "wake guard capacity exceeded; wake not admitted");
      supervisor.untrack(idempotencyKey);
      wakeReporter?.untrack(idempotencyKey);
      return;
    }
    decisionRouter.track(sessionKey, idempotencyKey);
    const result = await postWakeHookWithRetries({
      gatewayPort,
      hooksPath,
      hookToken,
      agentId: hookAgentId,
      sessionKey,
      message,
      idempotencyKey,
      model: wsNotifications?.model?.trim(),
    }, (reason) => { void supervisor.alert(idempotencyKey, reason); }, lifecycle.signal);
    supervisor.bindRun(idempotencyKey, result.runId);
    guards.bindRun(idempotencyKey, result.runId);
    allocatedFreshReuseKey = false;
    if (!result.ok && !result.pending) {
      supervisor.untrack(idempotencyKey);
      guards.untrack(idempotencyKey);
      decisionRouter.untrack(idempotencyKey);
    }

    if (wakeReporter) {
      if (result.ok || result.pending) {
        wakeReporter.bindRun(idempotencyKey, result.runId);
      } else {
        wakeReporter.untrack(idempotencyKey); // never admitted: no turn to report on
      }
    }

    if (result.ok) {
      const admittedRun = result.runId ? " runId=" + result.runId : "";
      console.log(
        `[imajin-ws] wake admitted${admittedRun} for ${scope} ` +
          `(${phase}, ${frames.length} notification(s) coalesced)`,
      );
      await pendingWakeStore.delete(pendingKey);
      return;
    }

    if (result.pending) {
      // wake-pending (#31): one summary line per coalesce window, not one per
      // attempt — no retry ladder was walked (`postWakeHookWithRetries`
      // already stopped after the single attempt). The owed marker stays
      // exactly as-is: a restart replays it once (subject to
      // `wakeOwedMaxAgeMs`, #30), and a later 2xx for the same scope
      // (whether from this run or a future replay) clears it as today. Not
      // a failure, so no Telegram escalation.
      console.info(
        `[imajin-ws] wake pending for ${scope}: ${frames.length} notification(s), ${frames.length} frame(s) durable (${result.reason})`,
      );
      return;
    }

    console.error(
      `[imajin-ws] wake hook FAILED for ${scope}: ${result.reason} (${phase}, ${frames.length} notification(s) coalesced)`,
    );
    // Marker intentionally retained: a transient hook failure (unlike the two
    // static-misconfiguration branches above) is worth retrying on the next
    // restart (#26) — cleared only once `postWakeHookWithRetries` reports 2xx.
    // The first real failed attempt already alerted, before the retry ladder.
  }

  /** A successful terminal disclosure consumes only an entirely terminal batch. */
  async function handleTerminalSubjects(
    liveState: WakeLiveState, scope: string, frames: NotificationFrame[], pendingKey: string,
  ): Promise<boolean> {
    if (!liveState.terminalSubjects.length) return false;
    const disclosure = liveState.terminalSubjects.map((subject) =>
      `${subject.url} is already ${subject.state}; wake skipped — no review or merge action taken.`).join("\n");
    if (!await discloseTerminalSubjects(disclosure)) {
      await escalateWakeFailure(scope, frames, "terminal subject disclosure failed; wake retained for retry");
      return true;
    }
    if (!liveState.allSubjectsTerminal) return false;
    await bridge.recordOutcome({
      runIds: summarizeWakeRuns(frames).map((run) => run.runId),
      lastVerdict: disclosure, status: "closed",
    });
    await pendingWakeStore.delete(pendingKey);
    return true;
  }

  /** Authoritative horizon evidence when available, otherwise bounded local continuity. */
  async function wakeContinuity(runIds: string[]): Promise<string> {
    if (!horizon) return bridge.buildPrompt();
    try {
      const items = await withWakeDeadline(horizon.readOpenItems({ runIds }));
      const snapshot = new WakeBridgeStore();
      await snapshot.merge(items);
      await bridge.merge(items);
      return snapshot.buildPrompt();
    } catch {
      console.warn("[imajin-ws] horizon read unavailable; using wake bridge");
      return bridge.buildPrompt();
    }
  }

  async function guardedReuseSession(frames: NotificationFrame[], reserve = 0): Promise<string> {
    const observed = await withWakeDeadline(readTokens(reusedSessionKey)).catch(() => undefined);
    const size = observed ?? (allocatedFreshReuseKey ? 0 : undefined);
    // Reserve room for bounded evidence + bridge. Unknown metadata is not proof of safety.
    if (size === undefined || size + (reservedTokens.get(reusedSessionKey) ?? 0) + reserve + 24_000 > maxSessionTokens) {
      reservedTokens.delete(reusedSessionKey);
      reusedSessionKey = rotateWakeSessionKey(wakeSessionKey);
      allocatedFreshReuseKey = true;
      await escalateWakeFailure("session-size", frames,
        size === undefined ? "session size unavailable; rotated to fresh session" : `session size ${size} tokens; rotated before wake limit`);
    }
    reservedTokens.set(reusedSessionKey, (reservedTokens.get(reusedSessionKey) ?? 0) + reserve);
    return reusedSessionKey;
  }

  function onLeadingFire(scope: string) {
    const state = coalesceByScope.get(scope);
    if (!state || state.phase !== "leading") {
      return;
    }
    const { frames, windowStart } = state;
    const trailingTimeout = setTimeout(() => onTrailingFire(scope), wakeCoalesceMs);
    coalesceByScope.set(scope, { phase: "trailing", timeout: trailingTimeout, frames: [], windowStart });
    void scheduleWakeTurn(scope, frames, windowStart, "leading");
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
    void scheduleWakeTurn(scope, state.frames, state.windowStart, "trailing");
  }

  function dispose() {
    lifecycle.abort();
    supervisor.dispose();
    guards.dispose();
    decisionRouter.dispose();
    abortGateway.dispose();
    for (const [scope, buf] of coalesceByScope) {
      clearTimeout(buf.timeout);
      coalesceByScope.delete(scope);
    }
  }

  async function inject(nf: NotificationFrame): Promise<void> {
    if (isReachFrame(nf)) return;
    if (!injectScopes.has(nf.scope) || !targetSession) {
      return;
    }

    await stateReady;

    // Kernel-side replay after a reconnect (#2099): already durably injected
    // once, so re-ack without running enqueue/direct-send/coalesce again.
    if (dedupStore.has(nf.id)) {
      console.log(`[imajin-ws] ${nf.id} already injected for ${nf.scope} — re-acking without re-injecting`);
      if (!freshSessions || stateDir) sendAck(nf.id);
      return;
    }

    await bridge.ingest([nf]);
    const text = freshSessions ? "" : buildNotificationText(nf);
    let queuedVia: "system-event" | undefined;
    // Fresh wakes persist evidence locally, never accumulating a fixed gateway inbox.
    if (freshSessions) {
      if (await bufferWake(nf)) queuedVia = "system-event";
      else await escalateWakeFailure(nf.scope, [nf], "pending wake persistence failed; notification not acknowledged");
    } else if (enqueueSystemEvent) {
      try {
        enqueueSystemEvent(text, {
          sessionKey: await guardedReuseSession([nf], Buffer.byteLength(text)),
          contextKey: `imajin-ws:${nf.scope}`,
        });
        queuedVia = "system-event";
      } catch {
        console.error(`[imajin-ws] enqueueSystemEvent failed for ${nf.scope}`);
      }
    }

    if (queuedVia) {
      // Ack only after the durable step succeeded, never before (#26) — a
      // dropped/failed enqueue must leave the notification un-acked so the
      // kernel replays it on the next reconnect.
      await dedupStore.add(nf.id);
      if (!freshSessions || stateDir) sendAck(nf.id);
    } else {
      console.error(
        `[imajin-ws] wake evidence queue rejected ${nf.scope} — direct send still attempted`,
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
          `[imajin-ws] direct-sent ${nf.scope} via configured channel` +
            (queuedVia ? ` (context queued via ${queuedVia})` : ""),
        );
        // No early return here: the direct ping is the instant human-facing
        // notification, but the wake turn below is what makes the agent act.
        // Both must happen (2026-09-05: a `return` here meant the wake never
        // fired when directSend was configured and healthy).
      } catch {
        console.error(`[imajin-ws] direct send failed for ${nf.scope}; check directSend configuration`);
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
    if (!freshSessions) await bufferWake(nf);
  }

  async function bufferWake(nf: NotificationFrame): Promise<boolean> {
    let state = coalesceByScope.get(nf.scope);
    if (!state) {
      const windowStart = Date.now();
      const timeout = setTimeout(() => onLeadingFire(nf.scope), wakeSettleMs);
      state = { phase: "leading", timeout, frames: [], windowStart };
      coalesceByScope.set(nf.scope, state);
    }
    if (!state.frames.some((f) => f.id === nf.id)) state.frames.push(nf);
    const stored = await pendingWakeStore.set(`${pendingWakeKey(nf.scope, state.windowStart)}:${state.phase}`, {
      scope: nf.scope,
      sinceTs: state.windowStart,
      frames: state.frames,
      injected: !freshSessions,
    });
    console.log(`[imajin-ws] warp wake: ${state.phase} batched notification (n=${state.frames.length})`);
    return stored;
  }

  return {
    inject,
    dispose,
    ready: stateReady,
    runtimeHooks,
    reportWake,
    onAgentEnd: async (event, ctx = {}) => {
      const settled = decisionRouter.end(event, ctx);
      if (!settled) return;
      const rootCtx = { sessionKey: settled.sessionKey, runId: settled.event.runId, batchId: settled.batchId };
      const guardReason = await guards.end(settled.event, rootCtx);
      if (!guardReason && !extractFinalAssistantOutput(settled.event.messages)) {
        const last = findFinalAssistantMessage(settled.event.messages);
        settled.event.messages = [
          { role: "user", content: `Wake batch ID: ${settled.batchId}` },
          { ...last, role: "assistant", content: "Outcome disclosed to reportTo via channel message." },
        ];
      }
      await Promise.all([
        wakeReporter?.onAgentEnd(settled.event, rootCtx),
        supervisor.onAgentEnd(settled.event, rootCtx),
      ]);
      guards.untrack(settled.batchId);
      decisionRouter.untrack(settled.batchId);
    },
  };
}
