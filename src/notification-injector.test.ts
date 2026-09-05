import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import type { NotificationFrame } from "./ws-service.js";
import {
  createNotificationInjector,
  WAKE_CONFIRM_TIMEOUT_MS,
  type WsNotificationsConfig,
} from "./notification-injector.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const execFileMock = vi.mocked(execFile);

// We test the batching logic by re-implementing the coalesce behaviour
// in plain JS to avoid needing the full plugin SDK types.

type Batch = { timeout: ReturnType<typeof setTimeout>; frames: NotificationFrame[] };

function createBatcher(
  coalesceMs: number,
  onFlush: (frames: NotificationFrame[]) => void,
) {
  const batches = new Map<string, Batch>();
  return {
    push(scope: string, frame: NotificationFrame) {
      const existing = batches.get(scope);
      if (existing) {
        existing.frames.push(frame);
        return;
      }
      const timeout = setTimeout(() => {
        const buf = batches.get(scope);
        if (buf) {
          batches.delete(scope);
          onFlush(buf.frames);
        }
      }, coalesceMs);
      batches.set(scope, { timeout, frames: [frame] });
    },
    dispose() {
      for (const [, buf] of batches) clearTimeout(buf.timeout);
      batches.clear();
    },
    size(scope: string) {
      return batches.get(scope)?.frames.length ?? 0;
    },
  };
}

describe("Warp wake batching", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces two events within the window into one flush", () => {
    const flushed: NotificationFrame[][] = [];
    const batcher = createBatcher(300_000, (frames) => flushed.push(frames));

    const f1 = { id: "1", scope: "warp.run.completed", title: "run A", body: "", createdAt: "", data: {} } as NotificationFrame;
    const f2 = { id: "2", scope: "warp.run.completed", title: "run B", body: "", createdAt: "", data: {} } as NotificationFrame;

    batcher.push("warp.run.completed", f1);
    expect(batcher.size("warp.run.completed")).toBe(1);

    batcher.push("warp.run.completed", f2);
    expect(batcher.size("warp.run.completed")).toBe(2);
    expect(flushed).toHaveLength(0);

    vi.advanceTimersByTime(300_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(2);
    expect(batcher.size("warp.run.completed")).toBe(0);

    batcher.dispose();
  });

  it("starts a new batch after the window fires", () => {
    const flushed: NotificationFrame[][] = [];
    const batcher = createBatcher(300_000, (frames) => flushed.push(frames));

    const f1 = { id: "1", scope: "warp.run.completed", title: "run A", body: "", createdAt: "", data: {} } as NotificationFrame;
    batcher.push("warp.run.completed", f1);
    vi.advanceTimersByTime(300_000);
    expect(flushed).toHaveLength(1);

    const f2 = { id: "2", scope: "warp.run.completed", title: "run B", body: "", createdAt: "", data: {} } as NotificationFrame;
    batcher.push("warp.run.completed", f2);
    vi.advanceTimersByTime(300_000);
    expect(flushed).toHaveLength(2);

    batcher.dispose();
  });
});

// ---------------------------------------------------------------------------
// Real `inject()` path. Regression for 2026-09-05: with directSend configured
// and healthy, an early `return` after the successful ping meant the wake turn
// was never scheduled — the human got the Telegram ping, the agent never acted.
// ---------------------------------------------------------------------------

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

function stubExecFile(outcome: "ok" | "fail") {
  execFileMock.mockImplementation(((_cli: string, _args: string[], _opts: unknown, cb: ExecCb) => {
    cb(outcome === "ok" ? null : new Error("openclaw message send: boom"), "", "");
    return {} as never;
  }) as never);
}

function makeApi() {
  const enqueueSystemEvent = vi.fn((_text: string, _opts: { sessionKey: string; contextKey?: string }) => true);
  const unscheduleSessionTurnsByTag = vi.fn(async () => ({ removed: 0, failed: 0 }));
  const scheduled: Array<Record<string, unknown>> = [];
  let resolveNext: ((p: Record<string, unknown>) => void) | undefined;
  const scheduleSessionTurn = vi.fn(async (params: Record<string, unknown>) => {
    scheduled.push(params);
    resolveNext?.(params);
    resolveNext = undefined;
    return { id: `turn-${scheduled.length}` };
  });
  /** Resolves with the next scheduleSessionTurn params (test times out if it never fires). */
  const waitForSchedule = () => new Promise<Record<string, unknown>>((r) => (resolveNext = r));
  const api = {
    runtime: { system: { enqueueSystemEvent } },
    session: { workflow: { scheduleSessionTurn, unscheduleSessionTurnsByTag } },
  };
  return { api, enqueueSystemEvent, scheduleSessionTurn, unscheduleSessionTurnsByTag, scheduled, waitForSchedule };
}

const SESSION = "agent:main:telegram:direct:1";
const COALESCE_MS = 1_000;
const CONFIG: WsNotificationsConfig = {
  injectScopes: ["warp.run.completed"],
  targetSession: SESSION,
  wakeCoalesceMs: COALESCE_MS,
  directSend: { channel: "telegram", target: "1", cliPath: "/usr/bin/openclaw" },
};

function frame(id: string, title = `Warp run ${id} SUCCEEDED`): NotificationFrame {
  return { id, scope: "warp.run.completed", title, body: "", createdAt: "", data: {} } as NotificationFrame;
}

describe("createNotificationInjector.inject — direct send AND wake turn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("schedules the wake turn even when direct send succeeds (regression)", async () => {
    stubExecFile("ok");
    const { api, enqueueSystemEvent, scheduleSessionTurn, waitForSchedule } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));

    // Instant ping went out via the CLI…
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe("/usr/bin/openclaw");
    expect(execFileMock.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["message", "send", "--channel", "telegram", "--target", "1"]),
    );
    // …durable context was queued…
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent.mock.calls[0][1]).toMatchObject({ sessionKey: SESSION, contextKey: "imajin-ws:warp.run.completed" });
    // …and the wake is batched, not fired yet.
    expect(scheduleSessionTurn).not.toHaveBeenCalled();

    const pending = waitForSchedule();
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    const params = await pending;

    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
    expect(params).toMatchObject({
      sessionKey: SESSION,
      tag: "imajin-wake:warp.run.completed",
      delayMs: 0,
      deliveryMode: "announce",
      deleteAfterRun: true,
    });
    expect(String(params.message)).toContain("Warp runs completed (1)");
    dispose();
  });

  it("still schedules the wake turn when direct send fails", async () => {
    stubExecFile("fail");
    const { api, scheduleSessionTurn, waitForSchedule } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(scheduleSessionTurn).not.toHaveBeenCalled();

    const pending = waitForSchedule();
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    await pending;
    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("coalesces several successful-ping completions into one wake turn", async () => {
    stubExecFile("ok");
    const { api, scheduleSessionTurn, unscheduleSessionTurnsByTag, waitForSchedule } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await inject(frame("2", "Warp run 2 FAILED"));
    await inject(frame("3"));

    expect(execFileMock).toHaveBeenCalledTimes(3); // one ping per completion
    expect(scheduleSessionTurn).not.toHaveBeenCalled();

    const pending = waitForSchedule();
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    const params = await pending;

    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1); // one wake for all three
    expect(unscheduleSessionTurnsByTag).toHaveBeenCalledWith({ sessionKey: SESSION, tag: "imajin-wake:warp.run.completed" });
    expect(String(params.message)).toContain("Warp runs completed (3) — 1 need attention");
    dispose();
  });

  it("schedules the wake turn when directSend is not configured", async () => {
    const { api, scheduleSessionTurn, waitForSchedule } = makeApi();
    const { directSend: _omit, ...noDirect } = CONFIG;
    const { inject, dispose } = createNotificationInjector(api, noDirect);

    await inject(frame("1"));
    expect(execFileMock).not.toHaveBeenCalled();

    const pending = waitForSchedule();
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    await pending;
    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("ignores frames outside injectScopes", async () => {
    stubExecFile("ok");
    const { api, enqueueSystemEvent, scheduleSessionTurn } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject({ ...frame("1"), scope: "warp.run.started" } as NotificationFrame);
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(scheduleSessionTurn).not.toHaveBeenCalled();
    dispose();
  });

  it("keeps the newest notification when coalescing three completions", async () => {
    stubExecFile("ok");
    const { api, waitForSchedule } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1", "Warp run 1 SUCCEEDED"));
    await inject(frame("2", "Warp run 2 SUCCEEDED"));
    const pending = waitForSchedule();
    await inject(frame("3", "Warp run 3 SUCCEEDED"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    const params = await pending;

    // The 5-minute coalesce buffer must retain every frame pushed into it,
    // including the last one — a naive "replace, don't append" batcher would
    // silently drop the newest notification (hypothesis (d) in #13).
    expect(String(params.message)).toContain("Warp run 1 SUCCEEDED");
    expect(String(params.message)).toContain("Warp run 2 SUCCEEDED");
    expect(String(params.message)).toContain("Warp run 3 SUCCEEDED");
    dispose();
  });

  it("does not dedupe a resumed run's completion (same runId, new sessionId)", async () => {
    stubExecFile("ok");
    const { api, waitForSchedule } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    const segment1: NotificationFrame = {
      ...frame("1", "Warp run X SUCCEEDED"),
      data: { runId: "run-x", sessionId: "session-a" },
    } as NotificationFrame;
    const segment2: NotificationFrame = {
      ...frame("2", "Warp run X SUCCEEDED (resumed)"),
      data: { runId: "run-x", sessionId: "session-b" },
    } as NotificationFrame;

    const pending = waitForSchedule();
    await inject(segment1);
    await inject(segment2);

    // Same runId, different sessionId (a resumed segment) — both notifications
    // must reach the human and both must be coalesced into the wake turn.
    // Nothing in ws-service/notification-injector may key off `runId` alone.
    expect(execFileMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    const params = await pending;
    expect(String(params.message)).toContain("Warp runs completed (2)");
    expect(String(params.message)).toContain("Warp run X SUCCEEDED");
    expect(String(params.message)).toContain("Warp run X SUCCEEDED (resumed)");
    dispose();
  });
});

// ---------------------------------------------------------------------------
// #13: a missing/empty job id from `scheduleSessionTurn` must be treated as a
// failure (warn + fallback retry + escalation message), never logged as if it
// were a successful schedule. Also covers the post-schedule confirmation
// watchdog (`agent_end` correlation).
// ---------------------------------------------------------------------------

/** Configurable `scheduleSessionTurn` mock: pops one scripted response per call. */
function makeConfigurableApi(scheduleResponses: Array<{ id: string } | null | undefined | Record<string, never> | Error>) {
  const responses = [...scheduleResponses];
  const enqueueSystemEvent = vi.fn((_text: string, _opts: { sessionKey: string; contextKey?: string }) => true);
  const unscheduleSessionTurnsByTag = vi.fn(async () => ({ removed: 0, failed: 0 }));
  const calls: Array<Record<string, unknown>> = [];
  const scheduleSessionTurn = vi.fn(async (params: Record<string, unknown>) => {
    calls.push(params);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const hookHandlers: Record<string, (event: unknown) => void> = {};
  const on = vi.fn((hookName: string, handler: (event: unknown) => void) => {
    hookHandlers[hookName] = handler;
  });
  const api = {
    runtime: { system: { enqueueSystemEvent } },
    session: { workflow: { scheduleSessionTurn, unscheduleSessionTurnsByTag } },
    on,
  };
  return {
    api,
    scheduleSessionTurn,
    calls,
    emitAgentEnd: (sessionKey: string) => hookHandlers.agent_end?.({ sessionKey }),
  };
}

function wakeFailureCalls() {
  return execFileMock.mock.calls.filter((call) => String((call[1] as string[])[7] ?? "").includes("automatic wake failed"));
}

describe("createNotificationInjector — #13 missing wake id is a failure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("warns, retries, and escalates to a channel message when the wake call returns {}", async () => {
    const { api, scheduleSessionTurn } = makeConfigurableApi([{}, {}]);
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(scheduleSessionTurn).toHaveBeenCalledTimes(2); // primary + fallback
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no job id"));
    expect(wakeFailureCalls()).toHaveLength(1);
    expect(String(wakeFailureCalls()[0][1])).toContain("automatic wake failed");
    dispose();
  });

  it("treats a null response identically to {}", async () => {
    const { api, scheduleSessionTurn } = makeConfigurableApi([null, null]);
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(scheduleSessionTurn).toHaveBeenCalledTimes(2);
    expect(wakeFailureCalls()).toHaveLength(1);
    dispose();
  });

  it("treats a thrown error identically to a missing id, then escalates", async () => {
    const { api, scheduleSessionTurn } = makeConfigurableApi([new Error("automations unavailable"), new Error("automations unavailable")]);
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(scheduleSessionTurn).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("scheduleSessionTurn threw"),
      "automations unavailable",
    );
    expect(wakeFailureCalls()).toHaveLength(1);
    dispose();
  });

  it("does not escalate when the fallback attempt succeeds with a real id", async () => {
    const { api, scheduleSessionTurn } = makeConfigurableApi([{}, { id: "turn-fallback" }]);
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(scheduleSessionTurn).toHaveBeenCalledTimes(2);
    expect(wakeFailureCalls()).toHaveLength(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("scheduled wake turn turn-fallback"));
    dispose();
  });

  it("never retries when the primary attempt returns a real id", async () => {
    const { api, scheduleSessionTurn } = makeConfigurableApi([{ id: "turn-1" }]);
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(scheduleSessionTurn).toHaveBeenCalledTimes(1);
    expect(wakeFailureCalls()).toHaveLength(0);
    dispose();
  });
});

describe("createNotificationInjector — #13 wake confirmation watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs confirmation when agent_end fires for the wake session before the timeout", async () => {
    const { api, emitAgentEnd } = makeConfigurableApi([{ id: "turn-1" }]);
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    emitAgentEnd(SESSION);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("wake turn confirmed turn-1"));
    expect(wakeFailureCalls()).toHaveLength(0);

    // Confirmed already — the watchdog must not still fire an escalation later.
    await vi.advanceTimersByTimeAsync(WAKE_CONFIRM_TIMEOUT_MS);
    expect(wakeFailureCalls()).toHaveLength(0);
    dispose();
  });

  it("escalates to a channel message when no agent_end arrives within the confirmation window", async () => {
    const { api } = makeConfigurableApi([{ id: "turn-1" }]);
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    await vi.advanceTimersByTimeAsync(WAKE_CONFIRM_TIMEOUT_MS);

    expect(wakeFailureCalls()).toHaveLength(1);
    expect(String(wakeFailureCalls()[0][1])).toContain("never ran");
    dispose();
  });

  it("ignores agent_end events from unrelated sessions", async () => {
    const { api, emitAgentEnd } = makeConfigurableApi([{ id: "turn-1" }]);
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    emitAgentEnd("agent:main:telegram:direct:someone-else");
    await vi.advanceTimersByTimeAsync(WAKE_CONFIRM_TIMEOUT_MS);

    expect(wakeFailureCalls()).toHaveLength(1); // still escalates — never confirmed
    dispose();
  });
});
