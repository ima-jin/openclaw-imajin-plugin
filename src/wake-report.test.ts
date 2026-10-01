import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationInjector, type WsNotificationsConfig } from "./notification-injector.js";
import { buildWakeReport, extractFinalAssistantOutput, parseReportTo, WakeReporter } from "./wake-report.js";
import type { AgentEndEvent } from "./turn-usage-attestation.js";
import type { NotificationFrame } from "./ws-service.js";

// The wake path's CLI ping is irrelevant here; keep it from spawning anything.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const WORKER = "agent:main:warp-events";
const DM = "agent:main:telegram:direct:1";
const DM_2 = "agent:main:telegram:direct:2";
const SETTLE_MS = 1_000;

const CONFIG: WsNotificationsConfig = {
  injectScopes: ["warp.run.completed"],
  targetSession: WORKER,
  wakeSettleMs: SETTLE_MS,
  wakeCoalesceMs: SETTLE_MS,
  hookToken: "test-hook-token-do-not-log",
  reportTo: [DM, DM_2],
};

type Posted = { sessionKey: string; message: string; name: string; deliver: boolean; idempotencyKey: string };

/** Mocked gateway: records every `POST /hooks/agent` and admits it with a runId. */
function mockGateway() {
  const posts: Posted[] = [];
  let seq = 0;
  const fetchMock = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body);
    posts.push({
      sessionKey: body.sessionKey,
      message: body.message,
      name: body.name,
      deliver: body.deliver,
      idempotencyKey: init.headers["Idempotency-Key"],
    });
    seq += 1;
    const payload = { runId: `gw-run-${seq}` };
    return { status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    wakes: () => posts.filter((p) => p.sessionKey === WORKER),
    reports: (sessionKey?: string) =>
      posts.filter((p) => p.name === "imajin-wake-report" && (!sessionKey || p.sessionKey === sessionKey)),
    posts,
  };
}

function makeApi() {
  return {
    runtime: {
      system: { enqueueSystemEvent: vi.fn(() => true) },
      config: { current: () => ({}) },
    },
  };
}

function frame(id: string, title = `Warp run ${id} SUCCEEDED`): NotificationFrame {
  return { id, scope: "warp.run.completed", title, body: "", createdAt: "", data: {} } as NotificationFrame;
}

function turnEnd(text: string | undefined, extra: Partial<AgentEndEvent> = {}): AgentEndEvent {
  const messages: AgentEndEvent["messages"] = [{ role: "user", content: "wake evidence" }];
  if (text !== undefined) messages.push({ role: "assistant", content: [{ type: "text", text }] });
  return { sessionKey: WORKER, messages, ...extra };
}

describe("wsNotifications.reportTo (#47)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Injects one frame, lets the wake fire, and returns the injector. */
  async function wake(config: WsNotificationsConfig, id = "n1") {
    const injector = createNotificationInjector(makeApi(), config);
    await injector.inject(frame(id));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    return injector;
  }

  it("forwards the wake turn's final output exactly once per reportTo entry", async () => {
    const gw = mockGateway();
    const { onAgentEnd, dispose } = await wake(CONFIG);

    expect(gw.wakes()).toHaveLength(1);
    expect(gw.reports()).toHaveLength(0); // nothing is reported before the turn ends

    await onAgentEnd!(turnEnd("Verdict: LGTM on #2319\nev: pr.reviewed", { runId: "gw-run-1" }));

    expect(gw.reports()).toHaveLength(2);
    for (const target of [DM, DM_2]) {
      const [report, ...rest] = gw.reports(target);
      expect(rest).toHaveLength(0);
      expect(report.deliver).toBe(true);
      expect(report.message).toContain("Report from warp-events");
      expect(report.message).toContain("Verdict: LGTM on #2319\nev: pr.reviewed");
      expect(report.message).toContain("Warp runs (1):");
      expect(report.message).toContain("n1 SUCCEEDED");
    }
    // The wake itself was never re-posted: reports are not wakes.
    expect(gw.wakes()).toHaveLength(1);
    dispose();
  });

  it("does not double-send when agent_end fires twice for the same run", async () => {
    const gw = mockGateway();
    const { onAgentEnd, dispose } = await wake({ ...CONFIG, reportTo: [DM] });

    await onAgentEnd!(turnEnd("done", { runId: "gw-run-1" }));
    await onAgentEnd!(turnEnd("done", { runId: "gw-run-1" }));

    expect(gw.reports()).toHaveLength(1);
    dispose();
  });

  it("does not double-send for a duplicate batch id", async () => {
    const deliver = vi.fn(async () => ({ ok: true }));
    const reporter = new WakeReporter({
      wakeSessionKey: WORKER,
      targets: parseReportTo([DM]),
      deliver,
    });
    const batch = { batchId: "imajin-wake:warp.run.completed:1:leading", scope: "warp.run.completed", runs: [] };

    expect(reporter.track(batch)).toBe(true);
    expect(reporter.track(batch)).toBe(false); // already pending
    await reporter.onAgentEnd(turnEnd("first"));
    expect(reporter.track(batch)).toBe(false); // already reported
    await reporter.onAgentEnd(turnEnd("second")); // nothing left to claim

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      { sessionKey: DM, agentId: "main" },
      expect.stringContaining("first"),
      `imajin-wake-report:${batch.batchId}:${DM}`,
    );
  });

  it("reports 'no output' plus the run state when the wake turn produced nothing", async () => {
    const gw = mockGateway();
    // Run state lives in the frame title ("… FAILED"), as for real Warp frames.
    const injector = createNotificationInjector(makeApi(), { ...CONFIG, reportTo: [DM] });
    await injector.inject(frame("n2", "Warp run n2 FAILED"));
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    await injector.onAgentEnd!(turnEnd(undefined, { runId: "gw-run-1" }));

    expect(gw.reports()).toHaveLength(1);
    const { message } = gw.reports()[0];
    expect(message).toContain("no output");
    expect(message).toContain("FAILED");
    expect(message).toContain("Turn: ok");
    injector.dispose();
  });

  it("treats a NO_REPLY answer as no output, and surfaces an errored turn", async () => {
    const gw = mockGateway();
    const { onAgentEnd, dispose } = await wake({ ...CONFIG, reportTo: [DM] });

    await onAgentEnd!(turnEnd("NO_REPLY", { runId: "gw-run-1", success: false, error: "model timeout" }));

    const { message } = gw.reports()[0];
    expect(message).toContain("no output");
    expect(message).toContain("Turn: error (model timeout)");
    dispose();
  });

  it("forwards nothing — and registers no hook — when reportTo is empty or omitted", async () => {
    const gw = mockGateway();
    const empty = await wake({ ...CONFIG, reportTo: [] });
    expect(empty.onAgentEnd).toBeUndefined();
    empty.dispose();

    const { reportTo: _omit, ...omitted } = CONFIG;
    const none = createNotificationInjector(makeApi(), omitted);
    expect(none.onAgentEnd).toBeUndefined();
    none.dispose();

    expect(gw.reports()).toHaveLength(0);
  });

  it("ignores turns in other sessions (including the report targets themselves)", async () => {
    const gw = mockGateway();
    const { onAgentEnd, dispose } = await wake({ ...CONFIG, reportTo: [DM] });

    await onAgentEnd!(turnEnd("dm reply", { sessionKey: DM, runId: "x" }));
    await onAgentEnd!({ messages: [] }); // no session at all
    expect(gw.reports()).toHaveLength(0);

    // …and the batch is still waiting for the worker's own turn.
    await onAgentEnd!(turnEnd("real", { runId: "gw-run-1" }));
    expect(gw.reports()).toHaveLength(1);
    dispose();
  });

  it("logs a failing target once and never throws", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const reporter = new WakeReporter({ wakeSessionKey: WORKER, targets: parseReportTo([DM]), deliver: failing });

    for (const id of ["a", "b"]) {
      reporter.track({ batchId: id, scope: "s", runs: [] });
      await expect(reporter.onAgentEnd(turnEnd("out"))).resolves.toBeUndefined();
    }

    expect(failing).toHaveBeenCalledTimes(2);
    const failures = vi.mocked(console.error).mock.calls.filter((c) => String(c[0]).includes("FAILED"));
    expect(failures).toHaveLength(1);
  });
});

describe("parseReportTo", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("defaults to no targets", () => {
    expect(parseReportTo(undefined)).toEqual([]);
    expect(parseReportTo([])).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("derives the agent id and de-duplicates", () => {
    expect(parseReportTo([DM, ` ${DM} `, "agent:ops:telegram:direct:9"])).toEqual([
      { sessionKey: DM, agentId: "main" },
      { sessionKey: "agent:ops:telegram:direct:9", agentId: "ops" },
    ]);
  });

  it("drops invalid entries with one warning each, never throwing", () => {
    const result = parseReportTo([DM, "", "not-a-session", 42, null, { a: 1 }, "agent::x"]);
    expect(result).toEqual([{ sessionKey: DM, agentId: "main" }]);
    expect(console.warn).toHaveBeenCalledTimes(6);
    expect(parseReportTo("agent:main:x:y")).toEqual([]);
  });

  it("rejects the wake session itself (it would re-trigger the worker)", () => {
    expect(parseReportTo([WORKER.toUpperCase(), DM], WORKER)).toEqual([{ sessionKey: DM, agentId: "main" }]);
  });
});

describe("report formatting", () => {
  it("extracts only the last assistant message's text", () => {
    expect(
      extractFinalAssistantOutput([
        { role: "assistant", content: "earlier narration" },
        { role: "toolResult", content: "x" },
        { role: "assistant", content: [{ type: "text", text: "final " }, { type: "toolCall" }, { type: "text", text: "answer" }] },
      ]),
    ).toBe("final \nanswer");
    expect(extractFinalAssistantOutput([{ role: "user", content: "hi" }])).toBeUndefined();
    expect(extractFinalAssistantOutput(undefined)).toBeUndefined();
  });

  it("clips very long output and caps the run list", () => {
    const runs = Array.from({ length: 12 }, (_, i) => ({ runId: `r${i}`, state: "SUCCEEDED", title: "t" }));
    const report = buildWakeReport({ batchId: "b", scope: "s", runs }, { output: "x".repeat(5_000), status: "ok" });
    expect(report).toContain("…and 2 more");
    expect(report).toContain("[truncated 2000 chars]");
  });
});
