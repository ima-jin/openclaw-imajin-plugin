/**
 * OpenClaw hook events → kernel loop transitions (#46).
 *
 * Pure mapping + lineage bookkeeping; no I/O. Every handler is wrapped so a
 * thrown error, a malformed event, or a failing `emit` is swallowed and logged
 * — the loop (the session / subagent / cron run itself) is never affected by
 * publishing. See `loop-publisher.ts` for the wire contract.
 *
 * ## Mapping
 *
 *   openclaw.session    session_start → started, agent_end → progress,
 *                       session_end → finished (state from `reason`)
 *   openclaw.subagent   subagent_spawned → started, subagent_progress →
 *                       progress, subagent_ended → finished (state from `outcome`)
 *   openclaw.automation cron_changed started → started, finished → finished,
 *                       removed (run open) → finished/cancelled;
 *   openclaw.keeper     same as automation, for cron jobs classified as keepers
 *                       (see `isKeeper`); cron_reconciled backstops runs
 *                       that never saw a `finished` (gateway restart).
 *   any kind            `block()` → loop.blocked, `unblock()` → loop.progress
 *
 * ## Lineage (parentLoopId)
 * Loop ids are derived from OpenClaw identifiers (see `deriveLoopId`). A
 * session-key → loop-id registry lets a subagent spawned from session S (or
 * from another subagent) name S's loop as its parent. When the requester is a
 * primary session we have not seen start (plugin reloaded mid-session), its
 * loop is lazily started first so the parent always exists.
 *
 * ## Out of scope: transcript content
 * Only ids, state, and a short redacted summary are published. Assistant text,
 * tool args/results and the like are NOT published: the loops rail envelope has
 * no payload field for them (see ima-jin/imajin-ai#2552).
 */

import {
  deriveLoopId,
  sanitizeSummary,
  type LoopKind,
  type LoopLifecycleType,
  type LoopRefs,
  type LoopTransition,
} from "./loop-publisher.js";

export interface LoopTrackerLogger {
  warn: (message: string) => void;
}

export interface LoopTrackerOptions {
  /** The publisher DID — part of every derived loop id. */
  did: string;
  emit: (transition: LoopTransition) => void;
  /** Cron job ids / names / declarationKeys to publish as `openclaw.keeper`. */
  keeperJobs?: readonly string[];
  logger?: LoopTrackerLogger;
}

// --- Hook event shapes (only the fields read; all optional, read defensively) ---

export interface SessionStartEvent {
  sessionId?: string;
  sessionKey?: string;
}
export interface SessionEndEvent {
  sessionId?: string;
  sessionKey?: string;
  reason?: string;
  durationMs?: number;
  messageCount?: number;
}
export interface AgentEndLoopEvent {
  success?: boolean;
  durationMs?: number;
  runId?: string;
}
export interface SubagentSpawnedEvent {
  childSessionKey?: string;
  runId?: string;
  agentId?: string;
  label?: string;
  mode?: string;
}
export interface SubagentProgressEvent {
  phase?: string;
  runId?: string;
  childSessionKey?: string;
  outcome?: string;
}
export interface SubagentEndedEvent {
  targetSessionKey?: string;
  targetKind?: string;
  reason?: string;
  outcome?: string;
  error?: string;
  runId?: string;
}
export interface SubagentContext {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
}
export interface CronJobSnapshot {
  id?: string;
  declarationKey?: string;
  name?: string;
  enabled?: boolean;
  state?: { runningAtMs?: number; lastRunAtMs?: number; lastRunStatus?: string };
}
export interface CronChangedEvent {
  action?: string;
  jobId?: string;
  job?: CronJobSnapshot;
  runAtMs?: number;
  durationMs?: number;
  status?: string;
  completionStatus?: string;
  error?: string;
  sessionKey?: string;
  runId?: string;
}
export interface CronReconciledEvent {
  reason?: string;
  enabled?: boolean;
}

interface OpenLoop {
  loopId: string;
  kind: LoopKind;
  refs: LoopRefs;
  parentLoopId: string | null;
  label: string;
}

const MAX_RECONCILE_EMISSIONS = 200;
const KEEPER_NAME = /^keeper(?:[:/_-]|$)/i;

/** Session keys of non-primary sessions: owned by subagent / cron / ACP loops. */
const NON_PRIMARY_SESSION = /:(?:subagent|cron|acp):/;

/** Hook payloads are untrusted shapes: only accept non-empty strings as ids. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isPrimarySessionKey(sessionKey: string): boolean {
  return !NON_PRIMARY_SESSION.test(sessionKey);
}

const SESSION_END_STATE: Record<string, string> = {
  shutdown: "interrupted",
  restart: "interrupted",
  deleted: "cancelled",
};

const SUBAGENT_OUTCOME_STATE: Record<string, string> = {
  ok: "succeeded",
  error: "failed",
  timeout: "timeout",
  killed: "cancelled",
  reset: "cancelled",
  deleted: "cancelled",
};

function cronRunState(event: CronChangedEvent): string {
  if (event.completionStatus === "succeeded" || event.status === "ok") return "succeeded";
  if (event.completionStatus === "failed" || event.status === "error") return "failed";
  if (event.status === "skipped") return "skipped";
  return "finished";
}

function lastRunState(status: string | undefined): string {
  if (status === "ok") return "succeeded";
  if (status === "error") return "failed";
  if (status === "skipped") return "skipped";
  return "finished";
}

/**
 * Names an open loop from the OpenClaw side: a session / subagent session key,
 * or the id of a cron job (automation / keeper) with a run in flight.
 */
export interface LoopRef {
  sessionKey?: string;
  jobId?: string;
}

export interface LoopTracker {
  onSessionStart(event: SessionStartEvent): void;
  onSessionEnd(event: SessionEndEvent): void;
  onAgentEnd(event: AgentEndLoopEvent, ctx?: { sessionKey?: string }): void;
  onSubagentSpawned(event: SubagentSpawnedEvent, ctx?: SubagentContext): void;
  onSubagentProgress(event: SubagentProgressEvent, ctx?: SubagentContext): void;
  onSubagentEnded(event: SubagentEndedEvent): void;
  onCronChanged(event: CronChangedEvent): void;
  onCronReconciled(
    event: CronReconciledEvent,
    jobs: readonly CronJobSnapshot[] | undefined,
  ): void;
  /** Marks an open loop blocked (e.g. waiting on an operator). */
  block(ref: LoopRef, reason: string): void;
  /** Returns a blocked loop to running. */
  unblock(ref: LoopRef): void;
  /** Number of loops currently open (started, not finished). Exposed for tests. */
  openCount(): number;
}

export function createLoopTracker(options: LoopTrackerOptions): LoopTracker {
  const { did, emit } = options;
  const keeperJobs = new Set(options.keeperJobs ?? []);
  const warn = options.logger?.warn ?? ((m: string) => console.warn(m));

  /** loopId → open loop (anything started and not yet finished). */
  const open = new Map<string, OpenLoop>();
  /** sessionKey → loopId, for lineage and for turn-level progress. */
  const bySessionKey = new Map<string, string>();
  /** cron jobId → loopId of its in-flight run. */
  const cronRuns = new Map<string, string>();

  const guard =
    <A extends unknown[]>(name: string, fn: (...args: A) => void) =>
    (...args: A): void => {
      try {
        fn(...args);
      } catch (err: unknown) {
        warn(`[imajin-loops] ${name} ignored (${err instanceof Error ? err.name : "error"})`);
      }
    };

  const send = (
    type: LoopLifecycleType,
    loop: OpenLoop,
    state: string,
    summary: string,
  ): void => {
    emit({
      type,
      loopId: loop.loopId,
      kind: loop.kind,
      parentLoopId: loop.parentLoopId,
      refs: loop.refs,
      state,
      summary: sanitizeSummary(summary),
    });
  };

  const start = (loop: OpenLoop, summary: string): void => {
    open.set(loop.loopId, loop);
    if (loop.refs.sessionKey) bySessionKey.set(loop.refs.sessionKey, loop.loopId);
    send("loop.started", loop, "running", summary);
  };

  const finish = (loop: OpenLoop, state: string, summary: string): void => {
    open.delete(loop.loopId);
    if (loop.refs.sessionKey && bySessionKey.get(loop.refs.sessionKey) === loop.loopId) {
      bySessionKey.delete(loop.refs.sessionKey);
    }
    send("loop.finished", loop, state, summary);
  };

  const sessionLoop = (sessionKey: string | undefined, sessionId: string | undefined): OpenLoop => ({
    loopId: deriveLoopId(did, "openclaw.session", sessionId || sessionKey || "unknown"),
    kind: "openclaw.session",
    refs: { sessionKey },
    parentLoopId: null,
    label: "session",
  });

  /** Resolves the loop a requester session belongs to, starting a primary one lazily. */
  const resolveParent = (requesterSessionKey: string | undefined): string | null => {
    if (!requesterSessionKey) return null;
    const known = bySessionKey.get(requesterSessionKey);
    if (known) return known;
    if (!isPrimarySessionKey(requesterSessionKey)) return null;
    const loop = sessionLoop(requesterSessionKey, undefined);
    start(loop, "session observed");
    return loop.loopId;
  };

  const subagentLoopId = (sessionKey: string): string =>
    deriveLoopId(did, "openclaw.subagent", sessionKey);

  const isKeeper = (job: CronJobSnapshot | undefined, jobId: string): boolean => {
    if (keeperJobs.has(jobId)) return true;
    const name = str(job?.name);
    const declarationKey = str(job?.declarationKey);
    if (name && (keeperJobs.has(name) || KEEPER_NAME.test(name))) return true;
    return Boolean(declarationKey && keeperJobs.has(declarationKey));
  };

  const cronLoop = (
    jobId: string,
    job: CronJobSnapshot | undefined,
    runKey: number | undefined,
    refs: LoopRefs,
  ): OpenLoop => {
    const kind: LoopKind = isKeeper(job, jobId) ? "openclaw.keeper" : "openclaw.automation";
    return {
      loopId: deriveLoopId(did, kind, jobId, String(runKey ?? "unknown")),
      kind,
      refs,
      parentLoopId: null,
      label: str(job?.name) ?? jobId,
    };
  };

  const cronStarted = (event: CronChangedEvent, jobId: string): void => {
    const runKey = event.runAtMs ?? event.job?.state?.runningAtMs ?? Date.now();
    const loop = cronLoop(jobId, event.job, runKey, {
      sessionKey: str(event.sessionKey),
      runId: str(event.runId),
    });
    const previous = cronRuns.get(jobId);
    const stale = previous ? open.get(previous) : undefined;
    if (stale && stale.loopId !== loop.loopId) {
      finish(stale, "interrupted", `${stale.label} superseded by a new run`);
    }
    cronRuns.set(jobId, loop.loopId);
    const noun = loop.kind === "openclaw.keeper" ? "keeper" : "automation";
    start(loop, `${noun} run: ${loop.label}`);
  };

  const cronFinished = (event: CronChangedEvent, jobId: string): void => {
    const openId = cronRuns.get(jobId);
    const existing = openId ? open.get(openId) : undefined;
    const runKey = event.runAtMs ?? event.job?.state?.lastRunAtMs;
    const loop =
      existing ??
      cronLoop(jobId, event.job, runKey, {
        sessionKey: str(event.sessionKey),
        runId: str(event.runId),
      });
    cronRuns.delete(jobId);
    const state = cronRunState(event);
    const detail = str(event.error) ? `: ${event.error}` : "";
    finish(loop, state, `${loop.label} ${state}${detail}`);
  };

  const cronRemoved = (jobId: string): void => {
    const openId = cronRuns.get(jobId);
    const existing = openId ? open.get(openId) : undefined;
    cronRuns.delete(jobId);
    if (existing) finish(existing, "cancelled", `${existing.label} removed while running`);
  };

  const onCronChanged = guard("cron_changed", (event: CronChangedEvent): void => {
    const jobId = str(event?.jobId) ?? str(event?.job?.id);
    if (!jobId) return;
    if (event.action === "started") cronStarted(event, jobId);
    else if (event.action === "finished") cronFinished(event, jobId);
    else if (event.action === "removed") cronRemoved(jobId);
  });

  /** Runs this process opened whose job vanished or is no longer running. */
  const closeStaleRuns = (
    enabled: boolean,
    byId: ReadonlyMap<string, CronJobSnapshot>,
    budget: { left: number },
  ): void => {
    for (const [jobId, loopId] of cronRuns) {
      const loop = open.get(loopId);
      const job = byId.get(jobId);
      const stillRunning = job?.state?.runningAtMs !== undefined && enabled;
      if (loop && stillRunning) continue;
      cronRuns.delete(jobId);
      if (!loop) continue;
      if (budget.left-- <= 0) return;
      const state = job ? lastRunState(job.state?.lastRunStatus) : "cancelled";
      finish(loop, state, `${loop.label} closed at cron reconcile`);
    }
  };

  /** Fresh process: any run the persisted snapshot still marks running is orphaned. */
  const closeOrphanedRuns = (
    byId: ReadonlyMap<string, CronJobSnapshot>,
    budget: { left: number },
  ): void => {
    for (const [jobId, job] of byId) {
      const running = job.state?.runningAtMs;
      if (running === undefined) continue;
      if (budget.left-- <= 0) return;
      const loop = cronLoop(jobId, job, running, {});
      finish(loop, "interrupted", `${loop.label} interrupted by gateway restart`);
    }
  };

  /**
   * Backstop for runs whose `finished` never arrived (gateway restart / crash).
   * Stateless across restarts: a run's loop id is derived from its job id and
   * start time, so the persisted job snapshot is enough to close it. Only
   * `startup` looks at snapshots for loops this process never opened.
   */
  const onCronReconciled = guard(
    "cron_reconciled",
    (event: CronReconciledEvent, jobs: readonly CronJobSnapshot[] | undefined): void => {
      const byId = new Map<string, CronJobSnapshot>();
      for (const job of Array.isArray(jobs) ? jobs : []) {
        const id = str(job?.id);
        if (id) byId.set(id, job);
      }
      const budget = { left: MAX_RECONCILE_EMISSIONS };
      closeStaleRuns(event?.enabled !== false, byId, budget);
      if (event?.reason === "startup") closeOrphanedRuns(byId, budget);
    },
  );

  /** The open loop a session key currently maps to (lazy or started), if any. */
  const openLoopForKey = (key: string | undefined): OpenLoop | undefined => {
    const loopId = key ? bySessionKey.get(key) : undefined;
    return loopId ? open.get(loopId) : undefined;
  };

  const onSessionStart = guard("session_start", (event: SessionStartEvent): void => {
    const key = str(event?.sessionKey);
    const id = str(event?.sessionId);
    if (key && !isPrimarySessionKey(key)) return;
    if (!key && !id) return;
    const loop = sessionLoop(key, id);
    const current = openLoopForKey(key);
    if (current?.loopId === loop.loopId || open.has(loop.loopId)) return;
    // A new session id on a key that still has an open loop: the previous
    // session's end was never seen, so close it rather than orphan it.
    if (current) finish(current, "interrupted", "session superseded");
    start(loop, "session started");
  });

  /**
   * The loop a session_end closes. A lazily started parent loop is keyed by
   * sessionKey, not by the sessionId the event carries, so resolve through the
   * session key. A mapped loop for a *different* sessionId is a newer session:
   * a late session_end for the superseded one must not close it.
   */
  const loopToEnd = (key: string | undefined, id: string | undefined): OpenLoop => {
    const fresh = sessionLoop(key, id);
    const mapped = openLoopForKey(key);
    const lazyId = sessionLoop(key, undefined).loopId;
    if (mapped && (!id || mapped.loopId === lazyId || mapped.loopId === fresh.loopId)) return mapped;
    return open.get(fresh.loopId) ?? fresh;
  };

  const onSessionEnd = guard("session_end", (event: SessionEndEvent): void => {
    const key = str(event?.sessionKey);
    const id = str(event?.sessionId);
    if (key && !isPrimarySessionKey(key)) return;
    if (!key && !id) return;
    const loop = loopToEnd(key, id);
    const reason = str(event.reason) ?? "unknown";
    const state = SESSION_END_STATE[reason] ?? "succeeded";
    const duration = typeof event.durationMs === "number" ? `, ${event.durationMs}ms` : "";
    finish(loop, state, `session ended (${reason}${duration})`);
  });

  const onAgentEnd = guard(
    "agent_end",
    (event: AgentEndLoopEvent, ctx?: { sessionKey?: string }): void => {
      const loop = openLoopForKey(str(ctx?.sessionKey));
      if (!loop) return;
      const outcome = event?.success === false ? "error" : "ok";
      const duration = typeof event?.durationMs === "number" ? `, ${event.durationMs}ms` : "";
      send("loop.progress", loop, "running", `turn ended (${outcome}${duration})`);
    },
  );

  const onSubagentSpawned = guard(
    "subagent_spawned",
    (event: SubagentSpawnedEvent, ctx?: SubagentContext): void => {
      const childKey = str(event?.childSessionKey) ?? str(ctx?.childSessionKey);
      if (!childKey) return;
      const label = str(event.label) ?? str(event.agentId) ?? "subagent";
      const loop: OpenLoop = {
        loopId: subagentLoopId(childKey),
        kind: "openclaw.subagent",
        refs: { sessionKey: childKey, runId: str(event.runId) ?? str(ctx?.runId) },
        parentLoopId: resolveParent(str(ctx?.requesterSessionKey)),
        label,
      };
      start(loop, `subagent started: ${label}`);
    },
  );

  const onSubagentProgress = guard(
    "subagent_progress",
    (event: SubagentProgressEvent, ctx?: SubagentContext): void => {
      const childKey = str(event?.childSessionKey) ?? str(ctx?.childSessionKey);
      const loop = childKey ? open.get(subagentLoopId(childKey)) : undefined;
      if (!loop) return;
      const summary =
        event.phase === "ended" ? `run ended (${str(event.outcome) ?? "unknown"})` : "run started";
      const refs = { ...loop.refs, runId: str(event.runId) ?? loop.refs.runId };
      send("loop.progress", { ...loop, refs }, "running", summary);
    },
  );

  const onSubagentEnded = guard("subagent_ended", (event: SubagentEndedEvent): void => {
    const childKey = str(event?.targetSessionKey);
    if (!childKey) return;
    const loopId = subagentLoopId(childKey);
    const loop: OpenLoop = open.get(loopId) ?? {
      loopId,
      kind: "openclaw.subagent",
      refs: { sessionKey: childKey, runId: str(event.runId) },
      parentLoopId: null,
      label: "subagent",
    };
    const outcome = str(event.outcome) ?? str(event.reason) ?? "unknown";
    const state = SUBAGENT_OUTCOME_STATE[str(event.outcome) ?? ""] ?? "finished";
    const detail = str(event.error) ? `: ${event.error}` : "";
    finish(loop, state, `subagent ended (${outcome})${detail}`);
  });

  const findOpen = (ref: LoopRef): OpenLoop | undefined => {
    const loopId =
      (ref.sessionKey ? bySessionKey.get(ref.sessionKey) : undefined) ??
      (ref.jobId ? cronRuns.get(ref.jobId) : undefined);
    return loopId ? open.get(loopId) : undefined;
  };

  const onBlock = guard("block", (ref: LoopRef, reason: string): void => {
    const loop = findOpen(ref);
    if (loop) send("loop.blocked", loop, "blocked", `blocked: ${reason}`);
  });

  const onUnblock = guard("unblock", (ref: LoopRef): void => {
    const loop = findOpen(ref);
    if (loop) send("loop.progress", loop, "running", "unblocked");
  });

  return {
    onSessionStart,
    onSessionEnd,
    onAgentEnd,
    onSubagentSpawned,
    onSubagentProgress,
    onSubagentEnded,
    onCronChanged,
    onCronReconciled,
    block: onBlock,
    unblock: onUnblock,
    openCount: () => open.size,
  };
}
