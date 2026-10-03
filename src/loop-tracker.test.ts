import { describe, expect, it, vi } from "vitest";
import { deriveLoopId, type LoopTransition } from "./loop-publisher.js";
import { createLoopTracker, isPrimarySessionKey } from "./loop-tracker.js";

const DID = "did:imajin:agent";
const MAIN = "agent:main:telegram:direct:42";
const CHILD = "agent:main:subagent:aaaa-1111";
const GRANDCHILD = "agent:main:subagent:bbbb-2222";

function setup(options: { keeperJobs?: string[]; emit?: (t: LoopTransition) => void } = {}) {
  const events: LoopTransition[] = [];
  const logger = { warn: vi.fn() };
  const tracker = createLoopTracker({
    did: DID,
    keeperJobs: options.keeperJobs,
    logger,
    emit: options.emit ?? ((t) => events.push(t)),
  });
  const summary = () => events.map((e) => `${e.type}|${e.kind}|${e.state}`);
  return { tracker, events, logger, summary };
}

const sessionId = (key: string) => deriveLoopId(DID, "openclaw.session", key);
const subagentId = (key: string) => deriveLoopId(DID, "openclaw.subagent", key);

describe("openclaw.session", () => {
  it("session_start → started, agent_end → progress, session_end → finished", () => {
    const { tracker, events } = setup();
    tracker.onSessionStart({ sessionId: "sess-1", sessionKey: MAIN });
    tracker.onAgentEnd({ success: true, durationMs: 1200 }, { sessionKey: MAIN });
    tracker.onSessionEnd({ sessionId: "sess-1", sessionKey: MAIN, reason: "idle", durationMs: 9000 });

    expect(events.map((e) => e.type)).toEqual(["loop.started", "loop.progress", "loop.finished"]);
    const loopId = sessionId("sess-1");
    for (const e of events) {
      expect(e.loopId).toBe(loopId);
      expect(e.kind).toBe("openclaw.session");
      expect(e.parentLoopId).toBeNull();
      expect(e.refs).toEqual({ sessionKey: MAIN });
    }
    expect(events.map((e) => e.state)).toEqual(["running", "running", "succeeded"]);
    expect(events[1]!.summary).toBe("turn ended (ok, 1200ms)");
    expect(events[2]!.summary).toBe("session ended (idle, 9000ms)");
  });

  it("derives the loop id from the session id, not from the (reusable) session key", () => {
    const { tracker, events } = setup();
    tracker.onSessionStart({ sessionId: "sess-1", sessionKey: MAIN });
    tracker.onSessionEnd({ sessionId: "sess-1", sessionKey: MAIN, reason: "reset" });
    tracker.onSessionStart({ sessionId: "sess-2", sessionKey: MAIN });
    expect(events[0]!.loopId).not.toBe(events[2]!.loopId);
    expect(events[0]!.loopId).not.toContain(MAIN);
  });

  it.each([
    ["new", "succeeded"],
    ["reset", "succeeded"],
    ["idle", "succeeded"],
    ["daily", "succeeded"],
    ["compaction", "succeeded"],
    ["deleted", "cancelled"],
    ["shutdown", "interrupted"],
    ["restart", "interrupted"],
    ["unknown", "succeeded"],
  ])("session_end reason %s → state %s", (reason, state) => {
    const { tracker, events } = setup();
    tracker.onSessionStart({ sessionId: "s", sessionKey: MAIN });
    tracker.onSessionEnd({ sessionId: "s", sessionKey: MAIN, reason });
    expect(events[1]!.state).toBe(state);
  });

  it("agent_end progress on an unknown session is ignored", () => {
    const { tracker, events } = setup();
    tracker.onAgentEnd({ success: true }, { sessionKey: MAIN });
    expect(events).toEqual([]);
  });

  it("reports a failed turn", () => {
    const { tracker, events } = setup();
    tracker.onSessionStart({ sessionId: "s", sessionKey: MAIN });
    tracker.onAgentEnd({ success: false }, { sessionKey: MAIN });
    expect(events[1]!.summary).toBe("turn ended (error)");
  });

  it("session_end without a seen session_start still publishes a bare finished", () => {
    const { tracker, events } = setup();
    tracker.onSessionEnd({ sessionId: "s", sessionKey: MAIN, reason: "idle" });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("loop.finished");
  });

  it("only visible primary sessions: subagent / cron / acp sessions are not session loops", () => {
    const { tracker, events } = setup();
    for (const key of [CHILD, "agent:main:cron:job-1", "agent:main:acp:xyz"]) {
      tracker.onSessionStart({ sessionId: "x", sessionKey: key });
      tracker.onSessionEnd({ sessionId: "x", sessionKey: key, reason: "idle" });
    }
    expect(events).toEqual([]);
    expect(isPrimarySessionKey(MAIN)).toBe(true);
    expect(isPrimarySessionKey("agent:main:main")).toBe(true);
    expect(isPrimarySessionKey(CHILD)).toBe(false);
  });

  it("a duplicate session_start does not re-publish started", () => {
    const { tracker, events } = setup();
    tracker.onSessionStart({ sessionId: "s", sessionKey: MAIN });
    tracker.onSessionStart({ sessionId: "s", sessionKey: MAIN });
    expect(events).toHaveLength(1);
  });
});

describe("openclaw.subagent", () => {
  it("spawned → started, progress → progress, ended → finished, with refs", () => {
    const { tracker, events } = setup();
    tracker.onSessionStart({ sessionId: "sess-1", sessionKey: MAIN });
    tracker.onSubagentSpawned(
      { childSessionKey: CHILD, runId: "run-9", agentId: "scout", label: "discover", mode: "run" },
      { requesterSessionKey: MAIN },
    );
    tracker.onSubagentProgress({ phase: "started", runId: "run-9", childSessionKey: CHILD });
    tracker.onSubagentProgress({ phase: "ended", runId: "run-9", childSessionKey: CHILD, outcome: "ok" });
    tracker.onSubagentEnded({ targetSessionKey: CHILD, targetKind: "subagent", reason: "done", outcome: "ok", runId: "run-9" });

    const sub = events.slice(1);
    expect(sub.map((e) => e.type)).toEqual([
      "loop.started",
      "loop.progress",
      "loop.progress",
      "loop.finished",
    ]);
    for (const e of sub) {
      expect(e.kind).toBe("openclaw.subagent");
      expect(e.loopId).toBe(subagentId(CHILD));
      expect(e.refs).toEqual({ sessionKey: CHILD, runId: "run-9" });
      expect(e.parentLoopId).toBe(sessionId("sess-1"));
    }
    expect(sub[0]!.summary).toBe("subagent started: discover");
    expect(sub[1]!.summary).toBe("run started");
    expect(sub[2]!.summary).toBe("run ended (ok)");
    expect(sub.map((e) => e.state)).toEqual(["running", "running", "running", "succeeded"]);
  });

  it.each([
    ["ok", "succeeded"],
    ["error", "failed"],
    ["timeout", "timeout"],
    ["killed", "cancelled"],
    ["reset", "cancelled"],
    ["deleted", "cancelled"],
  ])("subagent_ended outcome %s → state %s", (outcome, state) => {
    const { tracker, events } = setup();
    tracker.onSubagentSpawned({ childSessionKey: CHILD }, { requesterSessionKey: undefined });
    tracker.onSubagentEnded({ targetSessionKey: CHILD, targetKind: "subagent", reason: "r", outcome });
    expect(events.at(-1)!.type).toBe("loop.finished");
    expect(events.at(-1)!.state).toBe(state);
  });

  it("an ended subagent with no outcome still finishes", () => {
    const { tracker, events } = setup();
    tracker.onSubagentEnded({ targetSessionKey: CHILD, reason: "gone" });
    expect(events).toHaveLength(1);
    expect(events[0]!.state).toBe("finished");
    expect(events[0]!.summary).toBe("subagent ended (gone)");
  });

  describe("lineage (parentLoopId)", () => {
    it("operator session → subagent → nested subagent", () => {
      const { tracker, events } = setup();
      tracker.onSessionStart({ sessionId: "sess-1", sessionKey: MAIN });
      tracker.onSubagentSpawned({ childSessionKey: CHILD, runId: "r1" }, { requesterSessionKey: MAIN });
      tracker.onSubagentSpawned({ childSessionKey: GRANDCHILD, runId: "r2" }, { requesterSessionKey: CHILD });

      const [root, child, grandchild] = events;
      expect(root!.parentLoopId).toBeNull();
      expect(child!.parentLoopId).toBe(root!.loopId);
      expect(grandchild!.parentLoopId).toBe(child!.loopId);
    });

    it("a requester session we never saw start is started lazily, once, as the parent", () => {
      const { tracker, events } = setup();
      tracker.onSubagentSpawned({ childSessionKey: CHILD }, { requesterSessionKey: MAIN });
      tracker.onSubagentSpawned({ childSessionKey: GRANDCHILD }, { requesterSessionKey: MAIN });

      expect(events.map((e) => `${e.type}|${e.kind}`)).toEqual([
        "loop.started|openclaw.session",
        "loop.started|openclaw.subagent",
        "loop.started|openclaw.subagent",
      ]);
      expect(events[1]!.parentLoopId).toBe(events[0]!.loopId);
      expect(events[2]!.parentLoopId).toBe(events[0]!.loopId);
    });

    it("a lazily started session loop is closed by its session_end with the same id when keyed by sessionKey only", () => {
      const { tracker, events } = setup();
      tracker.onSubagentSpawned({ childSessionKey: CHILD }, { requesterSessionKey: MAIN });
      tracker.onSessionEnd({ sessionKey: MAIN, reason: "idle" });
      expect(events.at(-1)!.loopId).toBe(events[0]!.loopId);
    });

    it("no requester, or an unknown non-primary requester → root loop", () => {
      const { tracker, events } = setup();
      tracker.onSubagentSpawned({ childSessionKey: CHILD }, {});
      tracker.onSubagentSpawned({ childSessionKey: GRANDCHILD }, { requesterSessionKey: "agent:main:cron:j1" });
      expect(events.map((e) => e.parentLoopId)).toEqual([null, null]);
    });

    it("a cron-run session is the parent of a subagent it spawns", () => {
      const { tracker, events } = setup();
      const cronKey = "agent:main:cron:nightly:run:1";
      tracker.onCronChanged({ action: "started", jobId: "nightly", runAtMs: 1000, sessionKey: cronKey });
      tracker.onSubagentSpawned({ childSessionKey: CHILD }, { requesterSessionKey: cronKey });
      expect(events[1]!.parentLoopId).toBe(events[0]!.loopId);
    });

    it("finish keeps the parent recorded at spawn", () => {
      const { tracker, events } = setup();
      tracker.onSessionStart({ sessionId: "s", sessionKey: MAIN });
      tracker.onSubagentSpawned({ childSessionKey: CHILD }, { requesterSessionKey: MAIN });
      tracker.onSubagentEnded({ targetSessionKey: CHILD, outcome: "ok" });
      expect(events.at(-1)!.parentLoopId).toBe(events[0]!.loopId);
    });
  });

  it("redacts secrets from an error summary", () => {
    const { tracker, events } = setup();
    tracker.onSubagentSpawned({ childSessionKey: CHILD }, {});
    tracker.onSubagentEnded({
      targetSessionKey: CHILD,
      outcome: "error",
      error: "upstream said Bearer abcdefghijklmnopqrstuvwxyz",
    });
    expect(events.at(-1)!.summary).not.toContain("abcdefghijklmnop");
  });
});

describe("openclaw.automation / openclaw.keeper (cron)", () => {
  it("cron started → started, finished → finished, same loop id", () => {
    const { tracker, events } = setup();
    tracker.onCronChanged({ action: "started", jobId: "digest", job: { id: "digest", name: "Daily digest" }, runAtMs: 5000 });
    tracker.onCronChanged({ action: "finished", jobId: "digest", runAtMs: 5000, status: "ok", completionStatus: "succeeded", durationMs: 90 });

    expect(events.map((e) => `${e.type}|${e.kind}|${e.state}`)).toEqual([
      "loop.started|openclaw.automation|running",
      "loop.finished|openclaw.automation|succeeded",
    ]);
    expect(events[0]!.loopId).toBe(events[1]!.loopId);
    expect(events[0]!.loopId).toBe(deriveLoopId(DID, "openclaw.automation", "digest", "5000"));
    expect(events[0]!.parentLoopId).toBeNull();
    expect(events[0]!.summary).toBe("automation run: Daily digest");
  });

  it("a failed run finishes failed and carries a redacted error", () => {
    const { tracker, events } = setup();
    tracker.onCronChanged({ action: "started", jobId: "j", runAtMs: 1 });
    tracker.onCronChanged({ action: "finished", jobId: "j", status: "error", error: "boom password=hunter2hunter2" });
    expect(events[1]!.state).toBe("failed");
    expect(events[1]!.summary).toContain("boom");
    expect(events[1]!.summary).not.toContain("hunter2");
  });

  it.each([
    [{ status: "ok" }, "succeeded"],
    [{ completionStatus: "succeeded" }, "succeeded"],
    [{ status: "error" }, "failed"],
    [{ completionStatus: "failed" }, "failed"],
    [{ status: "skipped" }, "skipped"],
    [{}, "finished"],
  ])("finished %j → %s", (fields, state) => {
    const { tracker, events } = setup();
    tracker.onCronChanged({ action: "started", jobId: "j", runAtMs: 1 });
    tracker.onCronChanged({ action: "finished", jobId: "j", ...fields });
    expect(events[1]!.state).toBe(state);
  });

  it("refs carry the run's session key and run id", () => {
    const { tracker, events } = setup();
    tracker.onCronChanged({ action: "started", jobId: "j", runAtMs: 1, sessionKey: "agent:main:cron:j", runId: "run-7" });
    expect(events[0]!.refs).toEqual({ sessionKey: "agent:main:cron:j", runId: "run-7" });
  });

  it("a finished with no seen start derives the same id from runAtMs", () => {
    const { tracker, events } = setup();
    tracker.onCronChanged({ action: "finished", jobId: "j", runAtMs: 77, status: "ok" });
    expect(events).toHaveLength(1);
    expect(events[0]!.loopId).toBe(deriveLoopId(DID, "openclaw.automation", "j", "77"));
  });

  it("removing a job mid-run cancels its loop; removing an idle job publishes nothing", () => {
    const { tracker, events } = setup();
    tracker.onCronChanged({ action: "removed", jobId: "idle" });
    expect(events).toEqual([]);
    tracker.onCronChanged({ action: "started", jobId: "j", runAtMs: 1 });
    tracker.onCronChanged({ action: "removed", jobId: "j" });
    expect(events.at(-1)).toMatchObject({ type: "loop.finished", state: "cancelled" });
  });

  it("a new run while the previous never finished closes the old loop first", () => {
    const { tracker, events } = setup();
    tracker.onCronChanged({ action: "started", jobId: "j", runAtMs: 1 });
    tracker.onCronChanged({ action: "started", jobId: "j", runAtMs: 2 });
    expect(events.map((e) => `${e.type}|${e.state}`)).toEqual([
      "loop.started|running",
      "loop.finished|interrupted",
      "loop.started|running",
    ]);
    expect(tracker.openCount()).toBe(1);
  });

  it("ignores scheduled/added/updated and events without a job id", () => {
    const { tracker, events } = setup();
    for (const action of ["scheduled", "added", "updated"]) {
      tracker.onCronChanged({ action, jobId: "j" });
    }
    tracker.onCronChanged({ action: "started" });
    expect(events).toEqual([]);
  });

  describe("keepers", () => {
    it.each([
      ["configured by job id", { keeperJobs: ["job-1"] }, { jobId: "job-1" }],
      ["configured by name", { keeperJobs: ["Heartbeat keeper"] }, { jobId: "x", job: { name: "Heartbeat keeper" } }],
      ["configured by declarationKey", { keeperJobs: ["decl:keeper"] }, { jobId: "x", job: { declarationKey: "decl:keeper" } }],
      ["keeper: name prefix", {}, { jobId: "x", job: { name: "keeper:inbox" } }],
      ["keeper-name prefix", {}, { jobId: "x", job: { name: "Keeper-nightly" } }],
      ["bare keeper name", {}, { jobId: "x", job: { name: "keeper" } }],
    ])("%s → openclaw.keeper", (_label, options, event) => {
      const { tracker, events } = setup(options);
      tracker.onCronChanged({ action: "started", runAtMs: 1, ...event });
      tracker.onCronChanged({ action: "finished", runAtMs: 1, status: "ok", ...event });
      expect(events.map((e) => e.kind)).toEqual(["openclaw.keeper", "openclaw.keeper"]);
      expect(events[0]!.summary.startsWith("keeper run:")).toBe(true);
      expect(events[0]!.loopId).toBe(events[1]!.loopId);
    });

    it("a similarly named job is not a keeper", () => {
      const { tracker, events } = setup();
      tracker.onCronChanged({ action: "started", jobId: "x", job: { name: "keepers-digest" }, runAtMs: 1 });
      expect(events[0]!.kind).toBe("openclaw.automation");
    });
  });

  describe("cron_reconciled backstop (no phantom running loops after a restart)", () => {
    it("startup: a run the persisted snapshot still marks running is finished as interrupted", () => {
      const { tracker, events } = setup();
      tracker.onCronReconciled(
        { reason: "startup", enabled: true },
        [
          { id: "stuck", name: "Stuck job", state: { runningAtMs: 4242 } },
          { id: "idle", name: "Idle job", state: { lastRunAtMs: 100, lastRunStatus: "ok" } },
        ],
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "loop.finished",
        kind: "openclaw.automation",
        state: "interrupted",
        loopId: deriveLoopId(DID, "openclaw.automation", "stuck", "4242"),
      });
    });

    it("startup: the finish for a keeper job lands on the keeper loop id", () => {
      const { tracker, events } = setup({ keeperJobs: ["k1"] });
      tracker.onCronReconciled({ reason: "startup", enabled: true }, [{ id: "k1", state: { runningAtMs: 9 } }]);
      expect(events[0]).toMatchObject({
        kind: "openclaw.keeper",
        loopId: deriveLoopId(DID, "openclaw.keeper", "k1", "9"),
      });
    });

    it("startup closes exactly the loop an earlier start would have opened (same id)", () => {
      const first = setup();
      first.tracker.onCronChanged({ action: "started", jobId: "j", runAtMs: 4242 });
      const second = setup();
      second.tracker.onCronReconciled({ reason: "startup", enabled: true }, [{ id: "j", state: { runningAtMs: 4242 } }]);
      expect(second.events[0]!.loopId).toBe(first.events[0]!.loopId);
    });

    it("reload: closes in-flight loops whose job is gone, leaves still-running ones open", () => {
      const { tracker, events } = setup();
      tracker.onCronChanged({ action: "started", jobId: "gone", runAtMs: 1 });
      tracker.onCronChanged({ action: "started", jobId: "live", runAtMs: 2 });
      events.length = 0;
      tracker.onCronReconciled(
        { reason: "reload", enabled: true },
        [{ id: "live", state: { runningAtMs: 2 } }],
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "loop.finished", state: "cancelled" });
      expect(tracker.openCount()).toBe(1);
    });

    it("reload: a run whose job finished while we missed the event takes the last run status", () => {
      const { tracker, events } = setup();
      tracker.onCronChanged({ action: "started", jobId: "j", runAtMs: 1 });
      events.length = 0;
      tracker.onCronReconciled(
        { reason: "reload", enabled: true },
        [{ id: "j", state: { lastRunAtMs: 1, lastRunStatus: "error" } }],
      );
      expect(events[0]).toMatchObject({ type: "loop.finished", state: "failed" });
    });

    it("is idempotent: a second reconcile does not re-finish", () => {
      const { tracker, events } = setup();
      tracker.onCronChanged({ action: "started", jobId: "j", runAtMs: 1 });
      tracker.onCronReconciled({ reason: "reload", enabled: true }, []);
      const count = events.length;
      tracker.onCronReconciled({ reason: "reload", enabled: true }, []);
      expect(events).toHaveLength(count);
    });

    it("a missing job listing (cron unavailable) does not crash and finishes nothing running", () => {
      const { tracker, events } = setup();
      tracker.onCronChanged({ action: "started", jobId: "j", runAtMs: 1 });
      expect(() => tracker.onCronReconciled({ reason: "startup", enabled: true }, undefined)).not.toThrow();
      expect(events.at(-1)).toMatchObject({ type: "loop.finished", state: "cancelled" });
    });

    it("caps the number of emissions per reconcile", () => {
      const { tracker, events } = setup();
      const jobs = Array.from({ length: 500 }, (_, i) => ({ id: `j${i}`, state: { runningAtMs: i + 1 } }));
      tracker.onCronReconciled({ reason: "startup", enabled: true }, jobs);
      expect(events.length).toBeLessThanOrEqual(200);
    });
  });
});

describe("loop.blocked / unblocked (any loop kind)", () => {
  it("session", () => {
    const { tracker, events } = setup();
    tracker.onSessionStart({ sessionId: "s", sessionKey: MAIN });
    tracker.block({ sessionKey: MAIN }, "awaiting operator approval");
    tracker.unblock({ sessionKey: MAIN });
    expect(events.slice(1).map((e) => `${e.type}|${e.kind}|${e.state}`)).toEqual([
      "loop.blocked|openclaw.session|blocked",
      "loop.progress|openclaw.session|running",
    ]);
    expect(events[1]!.summary).toBe("blocked: awaiting operator approval");
    expect(events[1]!.loopId).toBe(events[0]!.loopId);
  });

  it("subagent", () => {
    const { tracker, events } = setup();
    tracker.onSubagentSpawned({ childSessionKey: CHILD, runId: "r" }, {});
    tracker.block({ sessionKey: CHILD }, "exec approval");
    tracker.unblock({ sessionKey: CHILD });
    expect(events.slice(1).map((e) => `${e.type}|${e.kind}|${e.state}`)).toEqual([
      "loop.blocked|openclaw.subagent|blocked",
      "loop.progress|openclaw.subagent|running",
    ]);
    expect(events[1]!.refs).toEqual({ sessionKey: CHILD, runId: "r" });
  });

  it("automation (by cron job id)", () => {
    const { tracker, events } = setup();
    tracker.onCronChanged({ action: "started", jobId: "digest", runAtMs: 1 });
    tracker.block({ jobId: "digest" }, "waiting for approval");
    tracker.unblock({ jobId: "digest" });
    expect(events.slice(1).map((e) => `${e.type}|${e.kind}|${e.state}`)).toEqual([
      "loop.blocked|openclaw.automation|blocked",
      "loop.progress|openclaw.automation|running",
    ]);
  });

  it("keeper (by cron job id)", () => {
    const { tracker, events } = setup({ keeperJobs: ["k"] });
    tracker.onCronChanged({ action: "started", jobId: "k", runAtMs: 1 });
    tracker.block({ jobId: "k" }, "waiting");
    expect(events[1]).toMatchObject({ type: "loop.blocked", kind: "openclaw.keeper", state: "blocked" });
  });

  it("blocking something that is not open publishes nothing", () => {
    const { tracker, events } = setup();
    tracker.block({ sessionKey: MAIN }, "x");
    tracker.block({ jobId: "nope" }, "x");
    tracker.unblock({});
    expect(events).toEqual([]);
  });

  it("a finished loop can no longer be blocked", () => {
    const { tracker, events } = setup();
    tracker.onSubagentSpawned({ childSessionKey: CHILD }, {});
    tracker.onSubagentEnded({ targetSessionKey: CHILD, outcome: "ok" });
    const count = events.length;
    tracker.block({ sessionKey: CHILD }, "late");
    expect(events).toHaveLength(count);
  });
});

describe("publish / handler failures never break the loop", () => {
  it("emit throwing is swallowed by every handler and later events still flow", () => {
    let fail = true;
    const delivered: LoopTransition[] = [];
    const { tracker, logger } = setup({
      emit: (t) => {
        if (fail) throw new Error("emit exploded");
        delivered.push(t);
      },
    });

    expect(() => {
      tracker.onSessionStart({ sessionId: "s", sessionKey: MAIN });
      tracker.onAgentEnd({}, { sessionKey: MAIN });
      tracker.onSubagentSpawned({ childSessionKey: CHILD }, { requesterSessionKey: MAIN });
      tracker.onSubagentProgress({ phase: "started", childSessionKey: CHILD });
      tracker.onSubagentEnded({ targetSessionKey: CHILD, outcome: "ok" });
      tracker.onCronChanged({ action: "started", jobId: "j", runAtMs: 1 });
      tracker.onCronChanged({ action: "finished", jobId: "j" });
      tracker.onCronReconciled({ reason: "startup", enabled: true }, [{ id: "j", state: { runningAtMs: 1 } }]);
      tracker.block({ sessionKey: MAIN }, "x");
      tracker.unblock({ sessionKey: MAIN });
      tracker.onSessionEnd({ sessionId: "s", sessionKey: MAIN, reason: "idle" });
    }).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();

    fail = false;
    tracker.onSubagentSpawned({ childSessionKey: GRANDCHILD }, {});
    expect(delivered).toHaveLength(1);
  });

  it("malformed hook payloads are ignored, not thrown", () => {
    const { tracker, events } = setup();
    const junk = [undefined, null, 42, "x", {}, { sessionKey: 7 }] as never[];
    expect(() => {
      for (const j of junk) {
        tracker.onSessionStart(j);
        tracker.onSessionEnd(j);
        tracker.onAgentEnd(j, j);
        tracker.onSubagentSpawned(j, j);
        tracker.onSubagentProgress(j, j);
        tracker.onSubagentEnded(j);
        tracker.onCronChanged(j);
        tracker.onCronReconciled(j, j);
      }
    }).not.toThrow();
    expect(events).toEqual([]);
  });
});

describe("no transcript content is published", () => {
  it("agent_end / spawn / cron payload bodies never reach a transition", () => {
    const { tracker, events } = setup();
    const secret = "TOP-SECRET-TRANSCRIPT-TEXT";
    tracker.onSessionStart({ sessionId: "s", sessionKey: MAIN });
    tracker.onAgentEnd(
      { success: true, messages: [{ role: "assistant", content: secret }] } as never,
      { sessionKey: MAIN },
    );
    tracker.onSubagentSpawned(
      { childSessionKey: CHILD, task: secret, prompt: secret } as never,
      { requesterSessionKey: MAIN },
    );
    tracker.onCronChanged({
      action: "started",
      jobId: "j",
      runAtMs: 1,
      job: { id: "j", name: "digest", payload: { kind: "agentTurn", text: secret } },
    } as never);
    expect(events.length).toBeGreaterThan(3);
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});
