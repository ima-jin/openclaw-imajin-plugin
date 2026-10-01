/**
 * `wsNotifications.reportTo` (#47) — the wake worker session discloses.
 *
 * `targetSession` / `wakeSessionKey` (e.g. `agent:main:warp-events`) is an
 * isolated worker: it has no channel binding, so whatever a wake turn
 * produces (PR verdicts, `ev:` lines, DECISION cards) is never seen by a
 * human — the gateway logs `delivered:false`. Rather than repointing the
 * worker at a DM, this module watches the worker's `agent_end` lifecycle
 * event and, once per wake batch, forwards that turn's final assistant output
 * to each configured `reportTo` session, wrapped as a report from
 * `warp-events`.
 *
 * Pure + dependency-injected (no gateway/fetch imports): the injector hands in
 * a `deliver` function, so this stays unit-testable and free of the circular
 * import `notification-injector.ts` would otherwise create.
 *
 * Guarantees:
 * - Default (`reportTo` omitted/empty) → no reporter is built at all.
 * - Exactly one report per wake batch id, however many times the batch is
 *   tracked or `agent_end` fires (see `track` / `claim`).
 * - A wake turn with no assistant output (or the `NO_REPLY` sentinel) still
 *   reports — "no output" plus the Warp run state(s) and turn status — never
 *   silence.
 * - Invalid session keys are dropped with ONE log line at construction; a
 *   delivery failure logs once per target. Nothing here ever throws.
 * - The report is wrapped as informational, not as a wake: it carries an
 *   explicit "do not start work" header and never touches the wake queue,
 *   so it cannot re-trigger the worker (a `reportTo` entry equal to the
 *   wake session itself is rejected for the same reason).
 */

import type { AgentEndEvent, AgentMessage } from "./turn-usage-attestation.js";

/** `agent:<agentId>:<rest>` — the shape every OpenClaw session key has. */
const SESSION_KEY_RE = /^agent:([^:\s]+):\S+$/;
const NO_REPLY_SENTINEL = "NO_REPLY";
// A channel message is the end of this pipe (Telegram caps at 4096 chars):
// leave room for the wrapper header.
const MAX_REPORT_OUTPUT_CHARS = 3_000;
const MAX_REPORT_RUNS = 10;
const MAX_PENDING_BATCHES = 50;
const MAX_REMEMBERED_IDS = 500;
export const WAKE_REPORT_HOOK_NAME = "imajin-wake-report";

export interface WakeRunSummary {
  runId: string;
  state: string;
  title: string;
}

/** One wake POST's worth of Warp runs; `batchId` is the wake's idempotency key. */
export interface WakeBatch {
  batchId: string;
  scope: string;
  runs: WakeRunSummary[];
}

export interface ReportTarget {
  sessionKey: string;
  agentId: string;
}

export interface WakeReportDelivery {
  ok: boolean;
  /** Gateway admitted/queued the turn but it hasn't returned yet — not a failure. */
  pending?: boolean;
  reason?: string;
}

export type WakeReportDeliver = (
  target: ReportTarget,
  message: string,
  idempotencyKey: string,
) => Promise<WakeReportDelivery>;

interface PendingBatch extends WakeBatch {
  /** The `runId` the Gateway returned for this wake, once known. */
  hookRunId?: string;
}

interface TurnSummary {
  output?: string;
  status: "ok" | "error";
  error?: string;
}

function sameSession(a: string | undefined, b: string): boolean {
  return a?.trim().toLowerCase() === b.trim().toLowerCase();
}

function describeEntry(entry: unknown): string {
  try {
    return (JSON.stringify(entry) ?? String(entry)).slice(0, 80);
  } catch {
    return "(unserializable)";
  }
}

/**
 * Validates `wsNotifications.reportTo`. Logs ONE warning per rejected entry
 * (this runs once, at injector construction) and returns only usable targets;
 * never throws. A non-array value, non-string / malformed entries, duplicates,
 * and the wake session itself (which would re-trigger the worker) are dropped.
 */
export function parseReportTo(raw: unknown, wakeSessionKey?: string): ReportTarget[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    console.warn("[imajin-ws] wsNotifications.reportTo must be an array of session keys — ignoring it");
    return [];
  }
  const targets = new Map<string, ReportTarget>();
  for (const entry of raw) {
    const sessionKey = typeof entry === "string" ? entry.trim() : "";
    const agentId = SESSION_KEY_RE.exec(sessionKey)?.[1];
    if (!agentId) {
      console.warn(
        `[imajin-ws] wsNotifications.reportTo: ignoring invalid session key ${describeEntry(entry)} (expected agent:<agentId>:<...>)`,
      );
    } else if (wakeSessionKey && sameSession(sessionKey, wakeSessionKey)) {
      console.warn(
        `[imajin-ws] wsNotifications.reportTo: ignoring ${sessionKey} — it is the wake session itself and would re-trigger the worker`,
      );
    } else {
      targets.set(sessionKey.toLowerCase(), { sessionKey, agentId });
    }
  }
  return [...targets.values()];
}

function messageText(message: AgentMessage): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      const b = block as { type?: unknown; text?: unknown } | null;
      return b?.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * The turn's final assistant output, or `undefined` when there is none (no
 * assistant message, an empty one, or the `NO_REPLY` sentinel).
 */
export function extractFinalAssistantOutput(messages: AgentMessage[] | undefined): string | undefined {
  const last = [...(messages ?? [])].reverse().find((m) => m?.role === "assistant");
  const text = last ? messageText(last) : "";
  return text && text !== NO_REPLY_SENTINEL ? text : undefined;
}

function describeTurn(event: AgentEndEvent | undefined): TurnSummary {
  const error = typeof event?.error === "string" && event.error ? event.error : undefined;
  const failed = event?.success === false || error !== undefined;
  return {
    output: extractFinalAssistantOutput(event?.messages),
    status: failed ? "error" : "ok",
    error,
  };
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

function formatRuns(runs: WakeRunSummary[]): string[] {
  const lines = runs
    .slice(0, MAX_REPORT_RUNS)
    .map((r) => `- ${r.runId} ${r.state} — ${clip(r.title, 120)}`);
  if (runs.length > MAX_REPORT_RUNS) lines.push(`- …and ${runs.length - MAX_REPORT_RUNS} more`);
  return lines;
}

/** Wraps a wake turn's outcome as a report from warp-events (see module doc). */
export function buildWakeReport(batch: WakeBatch, turn: TurnSummary): string {
  const states = [...new Set(batch.runs.map((r) => r.state))].join(", ") || "UNKNOWN";
  const errorSuffix = turn.error ? ` (${clip(turn.error, 200)})` : "";
  const turnLine = `Turn: ${turn.status}${errorSuffix}`;
  const body = turn.output
    ? `Output:\n${clip(turn.output, MAX_REPORT_OUTPUT_CHARS)}`
    : `Output: no output — the warp-events turn finished without any assistant output (${turnLine.toLowerCase()}; warp run state: ${states}).`;
  return [
    `[Report from warp-events — wake batch ${batch.batchId}]`,
    "Informational report only. This is NOT a wake or a task: do not start work, call tools, or reply to warp-events. Relay it to the operator as written.",
    "",
    `Warp runs (${batch.runs.length}):`,
    ...formatRuns(batch.runs),
    turnLine,
    "",
    body,
  ].join("\n");
}

function remember(set: Set<string>, value: string): void {
  set.add(value);
  if (set.size > MAX_REMEMBERED_IDS) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

export interface WakeReporterOptions {
  wakeSessionKey: string;
  targets: ReportTarget[];
  deliver: WakeReportDeliver;
}

export class WakeReporter {
  private readonly pending = new Map<string, PendingBatch>();
  private readonly reportedBatches = new Set<string>();
  private readonly handledRuns = new Set<string>();
  private readonly failedTargets = new Set<string>();

  constructor(private readonly opts: WakeReporterOptions) {}

  /**
   * Registers a wake batch about to be (or just) POSTed, BEFORE the POST so a
   * turn that finishes before the response is processed still matches.
   * Returns `false` — and tracks nothing — when this batch id was already
   * reported or is already pending (a replayed/duplicate wake).
   */
  track(batch: WakeBatch): boolean {
    if (this.reportedBatches.has(batch.batchId) || this.pending.has(batch.batchId)) return false;
    if (this.pending.size >= MAX_PENDING_BATCHES) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) {
        this.pending.delete(oldest);
        console.warn(`[imajin-ws] wake report: dropped oldest unreported batch ${oldest} (cap ${MAX_PENDING_BATCHES})`);
      }
    }
    this.pending.set(batch.batchId, { ...batch });
    return true;
  }

  /** Records the Gateway's runId for a tracked batch so `agent_end` can match it exactly. */
  bindRun(batchId: string, hookRunId: string | undefined): void {
    const batch = this.pending.get(batchId);
    if (batch && hookRunId) batch.hookRunId = hookRunId;
  }

  /** The wake POST failed outright — there will be no turn to report on. */
  untrack(batchId: string): void {
    this.pending.delete(batchId);
  }

  /**
   * `agent_end` handler. Reports on the wake session's turns only; everything
   * else (the report targets' own turns included) is ignored, so a report can
   * never loop back into another report. Never throws.
   */
  async onAgentEnd(event: AgentEndEvent | undefined, ctx?: { sessionKey?: string }): Promise<void> {
    try {
      if (!sameSession(event?.sessionKey ?? ctx?.sessionKey, this.opts.wakeSessionKey)) return;
      const batch = this.claim(event?.runId);
      if (!batch) return;
      const report = buildWakeReport(batch, describeTurn(event));
      await Promise.all(this.opts.targets.map((target) => this.send(target, batch.batchId, report)));
    } catch (err: unknown) {
      console.error("[imajin-ws] wake report failed:", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Picks the batch this turn belongs to: the one whose Gateway runId matches,
   * else the oldest pending one (the wake session is a dedicated worker and
   * wakes are serialized per session, so completions arrive in order). Marks
   * it reported so a duplicate `agent_end` can neither re-report it nor
   * consume the next batch.
   */
  private claim(runId: string | undefined): PendingBatch | undefined {
    if (runId && this.handledRuns.has(runId)) return undefined;
    const batches = [...this.pending.values()];
    const batch = (runId ? batches.find((b) => b.hookRunId === runId) : undefined) ?? batches[0];
    if (!batch) return undefined;
    this.pending.delete(batch.batchId);
    remember(this.reportedBatches, batch.batchId);
    if (runId) remember(this.handledRuns, runId);
    return batch;
  }

  private async send(target: ReportTarget, batchId: string, report: string): Promise<void> {
    let result: WakeReportDelivery;
    try {
      result = await this.opts.deliver(target, report, `imajin-wake-report:${batchId}:${target.sessionKey}`);
    } catch (err: unknown) {
      result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok || result.pending) {
      console.log(
        `[imajin-ws] wake report for ${batchId} → ${target.sessionKey}${result.pending ? " (queued)" : ""}`,
      );
    } else if (!this.failedTargets.has(target.sessionKey)) {
      remember(this.failedTargets, target.sessionKey);
      console.error(
        `[imajin-ws] wake report to ${target.sessionKey} FAILED (${result.reason ?? "unknown"}) — further failures for this session are not logged`,
      );
    }
  }
}
