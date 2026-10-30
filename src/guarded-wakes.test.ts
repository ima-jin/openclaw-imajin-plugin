import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotificationInjector, type WsNotificationsConfig } from "./notification-injector.js";
import { sendDirectChannelMessage } from "./channel-notify.js";
import { createWakeReportTool } from "./wake-report-tool.js";
import type { NotificationFrame } from "./ws-service.js";
import { PluginServiceRuntime } from "./plugin-service-runtime.js";
import { beginRegistration } from "./registration-lifecycle.js";
import { WakeGuards } from "./wake-guards.js";
import { PendingWakeStore } from "./notification-state-store.js";
import { gradingFixture } from "./fixtures/wake-grading.js";

vi.mock("./channel-notify.js", () => ({ sendDirectChannelMessage: vi.fn(async () => {}) }));
const PR = "https://github.com/ima-jin/openclaw-imajin-plugin/pull/80";
const REPORT = "agent:main:telegram:direct:123";
const OPEN = {
  state: "OPEN", isDraft: false, headRefOid: "a".repeat(40), mergeable: "MERGEABLE",
  reviewDecision: "APPROVED", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
};
type Post = { message: string; sessionKey: string; name: string; model?: string };

describe("guarded wake acceptance (#82)", () => {
  let dir: string;
  let config: WsNotificationsConfig;
  let posts: Post[];
  let injector: ReturnType<typeof createNotificationInjector>;
  let lookup: ReturnType<typeof vi.fn>;
  let abort: ReturnType<typeof vi.fn>;
  const alerts = () => vi.mocked(sendDirectChannelMessage).mock.calls
    .filter(([, text]) => text.includes("automatic wake failed"));
  const wakes = () => posts.filter((post) => post.name === "imajin-wake");
  const ctx = (index = 0) => ({ sessionKey: wakes()[index].sessionKey, runId: `runner-${index}` });
  const frame = (id: string, pr = PR): NotificationFrame => ({
    type: "notification", id, scope: "warp.run.completed", title: `Subject ${id}`, body: null,
    createdAt: "", data: { runId: `run-${id}`, expectedPr: pr },
  });

  async function registeredHooks() {
    const owner = new PluginServiceRuntime("full", async (_lifecycle, on) => {
      for (const [name, handler] of Object.entries({ ...injector.runtimeHooks, agent_end: injector.onAgentEnd! })) {
        on(name, handler, { name: `imajin-wake:${name}` });
      }
    });
    await owner.start();
    const registries = Array.from({ length: 3 }, () => {
      const hooks: Record<string, (event: any, ctx?: any) => unknown> = {};
      const runtime = new PluginServiceRuntime("full", async () => {});
      for (const name of [...Object.keys(injector.runtimeHooks), "agent_end"]) {
        runtime.registerHook({ on: (_name: string, handler: typeof hooks[string]) => { hooks[name] = handler; } },
          name, `imajin-wake:${name}`);
      }
      return hooks;
    });
    return registries.at(-1)!;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "guarded-wakes-"));
    posts = [];
    config = {
      injectScopes: ["warp.run.completed"], targetSession: "agent:main:warp-events",
      hookToken: "fixture-only", wakeSettleMs: 2, wakeCoalesceMs: 2, stateDir: dir,
      reportTo: [REPORT], directSend: { channel: "telegram", target: "123", cliPath: "/fixture/openclaw" },
    };
    lookup = vi.fn(async () => OPEN);
    abort = vi.fn(async () => {});
    vi.mocked(sendDirectChannelMessage).mockReset().mockResolvedValue();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body));
      return { status: 200, json: async () => ({ runId: `admission-${posts.length}` }), text: async () => "" };
    }));
    for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(async () => {
    await beginRegistration().dispose();
    await injector?.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it.each(["events#78", "events#77", "imajin-ai#3160"])("%s blocked verdict survives an early review-started send", async (subject) => {
    create();
    await start();
    const child = await spawnChild();
    expect(injector.runtimeHooks.before_tool_call({
      toolName: "message", params: { action: "send", channel: "telegram", target: "123", message: "review started" },
    }, ctx())).toMatchObject({ block: true, blockReason: expect.stringContaining("concrete verdict") });
    // A legacy/early receipt must not spend the final disclosure even if delivered before the hook upgrade.
    await injector.runtimeHooks.after_tool_call({
      toolName: "message", params: { action: "send", channel: "telegram", target: "123", message: "review started" },
      result: { ok: true },
    }, ctx());
    expect(injector.runtimeHooks.before_tool_call({
      toolName: "imajin_wake_report", params: { outcome: "blocked", message: `${subject}: grading unavailable` },
    }, child)).toBeUndefined();
    await createWakeReportTool(child, injector.reportWake).execute("blocked", {
      outcome: "blocked", message: `${subject}: grading unavailable; did not approve.`,
    });
    expect(vi.mocked(sendDirectChannelMessage).mock.calls.filter(([, text]) =>
      text.includes("Warp wake blocked"))).toHaveLength(1);
    expect(vi.mocked(sendDirectChannelMessage).mock.calls.at(-1)![1]).toContain(`${subject}: grading unavailable`);
    await expect(injector.reportWake(child, { outcome: "blocked", message: "duplicate" })).rejects.toThrow("already disclosed");
    expect(alerts()).toHaveLength(0);
  });

  it("reports a spawn refused after disclosure through the deterministic safety alert", async () => {
    create();
    await start();
    await injector.reportWake(ctx(), { outcome: "blocked", message: "Review could not finish" });
    const refused = await injector.runtimeHooks.before_tool_call({
      toolName: "sessions_spawn", params: { task: "retry review" },
    }, ctx());
    expect(refused).toMatchObject({ block: true, blockReason: expect.stringContaining("spawn refused") });
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0][1]).toContain("Wake already disclosed; decision spawn refused");
  });

  it("does not duplicate a concurrent outcome send", async () => {
    create();
    await start();
    let finish!: () => void;
    vi.mocked(sendDirectChannelMessage).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = injector.reportWake(ctx(), { outcome: "blocked", message: "Missing evidence" });
    await expect(injector.reportWake(ctx(), { outcome: "blocked", message: "second" })).rejects.toThrow("in progress");
    finish();
    await pending;
    expect(vi.mocked(sendDirectChannelMessage).mock.calls.filter(([, text]) => text.includes("Warp wake blocked"))).toHaveLength(1);
  });

  it("stops a watchdog timeout once through the guards despite extra registrations and late hooks", async () => {
    vi.useFakeTimers();
    config.wakeTimeoutMs = 5_000;
    const stop = vi.spyOn(WakeGuards.prototype, "stop");
    create();
    await start();
    const hooks = await registeredHooks();
    await vi.advanceTimersByTimeAsync(5_000);
    const batchId = /Wake batch ID: ([^\n]+)/.exec(wakes()[0].message)![1];
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(batchId, "wake completion timeout");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(ctx().sessionKey, ctx().runId);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0][1]).toContain("wake completion timeout");
    expect(console.log).toHaveBeenCalledWith(
      `[imajin-ws] wake ended batch=${batchId} sessionTokens=0 reason=timeout`,
    );
    expect(hooks.before_tool_call({ toolName: "session_status", params: {} }, ctx())).toMatchObject({ block: true });
    await hooks.agent_end({ success: false, runId: ctx().runId, messages: [] }, ctx());
    await hooks.agent_end({ success: false, runId: ctx().runId, messages: [] }, ctx());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(alerts()).toHaveLength(1);
    expect(posts.filter((post) => post.name === "imajin-wake-report")).toHaveLength(0);
  });

  it("makes main-session copies fire-and-forget and blocks inter-session ping-pong after disclosure", async () => {
    create();
    await start();
    expect((injector.runtimeHooks.before_prompt_build({}, ctx()) as { appendSystemContext: string })
      .appendSystemContext).toContain("agent:main:telegram:direct:123");
    const copy = injector.runtimeHooks.before_tool_call({
      toolName: "sessions_send",
      params: { sessionKey: REPORT, message: "Reviewed live head", timeoutSeconds: 60 },
    }, ctx());
    expect(copy).toMatchObject({ params: {
      sessionKey: REPORT, timeoutSeconds: 0,
      message: expect.stringContaining("informational, not an instruction"),
    } });
    await messageReceipt();
    expect(injector.runtimeHooks.before_agent_run({ prompt: "ANNOUNCE_SKIP" }, {
      ...ctx(), runId: "inter-session-reply", inputProvenance: { kind: "inter_session" },
    })).toMatchObject({ outcome: "block" });
    expect(injector.runtimeHooks.before_tool_call({
      toolName: "message", params: { action: "send", target: "123", message: "Acknowledged, wake closed" },
    }, ctx())).toMatchObject({ block: true });
    await injector.onAgentEnd!({ success: false, runId: "inter-session-reply", messages: [
      { role: "assistant", content: "ANNOUNCE_SKIP" },
    ] }, { ...ctx(), runId: "inter-session-reply" });
    expect(alerts()).toHaveLength(0); // A blocked reply is not the original wake's failed ending.
    await end("NO_REPLY");
    expect(injector.runtimeHooks.before_agent_run({ prompt: "Acknowledged" }, ctx())).toMatchObject({ outcome: "block" });
    expect(injector.runtimeHooks.before_tool_call({
      toolName: "message", params: { action: "send", target: "123" },
    }, ctx())).toMatchObject({ block: true });
    expect(alerts()).toHaveLength(0);
  });

  it("does not apply the 50k reuse threshold to a healthy 60k final context", async () => {
    create();
    await start();
    const hooks = await registeredHooks();
    await messageReceipt();
    await hooks.agent_end({ success: true, runId: ctx().runId, messages: [
      { role: "user", content: wakes()[0].message },
      { role: "assistant", content: "Completed and reported", usage: { input: 60_000 } },
    ] }, ctx());
    expect(alerts()).toHaveLength(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("sessionTokens=60000 source=final-assistant"));
    expect(abort).not.toHaveBeenCalled();
  });

  function create() {
    injector = createNotificationInjector({ runtime: {
      config: { current: () => ({}) }, system: { enqueueSystemEvent: () => true },
    } }, config, { liveStateLookup: lookup, abortWake: abort, sessionTokens: async () => 0,
      gradingSource: gradingFixture().source });
    return injector;
  }
  async function start(id = "one", index = 0) {
    await injector.inject(frame(id));
    await vi.waitFor(() => expect(wakes()).toHaveLength(index + 1), { interval: 5 });
    injector.runtimeHooks.llm_input({ prompt: wakes()[index].message, runId: ctx(index).runId }, ctx(index));
  }
  async function end(text: string, index = 0) {
    await injector.onAgentEnd!({
      success: true, runId: ctx(index).runId,
      messages: [{ role: "user", content: wakes()[index].message }, { role: "assistant", content: text }],
    }, ctx(index));
  }
  async function messageReceipt(target = "123", result: unknown = { ok: true }, index = 0) {
    if (target === "123" && (result as { ok?: boolean })?.ok) {
      await injector.reportWake(ctx(index), { outcome: "completed", message: "Reviewed live head" });
      return;
    }
    await injector.runtimeHooks.after_tool_call({
      toolName: "message", params: { action: "send", channel: "telegram", target }, result,
    }, ctx(index));
  }

  it("starts with live PR fields and existing horizon evidence, keeping coordinator model separate", async () => {
    config.model = "provider/coordinator";
    create();
    await start();
    const message = wakes()[0].message;
    for (const evidence of ["OPEN", "draft", "headSha", "a".repeat(40), "MERGEABLE", "APPROVED", "passed", "Wake continuity"]) {
      expect(message).toContain(evidence);
    }
    expect(message.indexOf("Live PR state")).toBeLessThan(message.indexOf("warp.run.completed ×"));
    expect(wakes()[0].model).toBe("provider/coordinator");
  });

  it.each(["MERGED", "CLOSED"])("short-circuits already %s subjects before null mergeability, with one-line disclosure", async (state) => {
    lookup.mockResolvedValue({ ...OPEN, state, mergeable: null });
    create();
    await injector.inject(frame("terminal"));
    await vi.waitFor(() => expect(vi.mocked(sendDirectChannelMessage).mock.calls
      .some(([, text]) => text.includes(`already ${state}`))).toBe(true));
    expect(wakes()).toHaveLength(0);
    expect(lookup).toHaveBeenCalledTimes(1);
    const disclosure = vi.mocked(sendDirectChannelMessage).mock.calls.find(([, text]) => text.includes(`already ${state}`))!;
    expect(disclosure[1]).not.toContain("\n");
    expect(disclosure[1]).toContain(PR);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(dir, "pending-wakes.json"), "utf8")).wakes).toEqual({}));
    await injector.inject(frame("terminal")); // known duplicate cannot create a silent turn
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(alerts()).toHaveLength(0);
  });

  it.each([false, true])("consumes a terminal marker after one send attempt across five registrations (failure=%s)", async (deliveryFails) => {
    lookup.mockResolvedValue({ ...OPEN, state: "MERGED", mergeable: "UNKNOWN" });
    if (deliveryFails) vi.mocked(sendDirectChannelMessage).mockRejectedValue(new Error("private delivery error"));
    const store = new PendingWakeStore(join(dir, "pending-wakes.json"));
    const sinceTs = Date.now() - 300_000;
    await store.set(`warp.run.completed:${sinceTs}:leading`, {
      scope: "warp.run.completed", sinceTs, frames: [frame("undelivered")], injected: false,
    });
    for (let registration = 0; registration < 5; registration++) {
      create();
      await injector.ready;
      await vi.waitFor(async () => expect(JSON.parse(await readFile(join(dir, "pending-wakes.json"), "utf8")).wakes).toEqual({}));
      await injector.dispose();
    }
    expect(sendDirectChannelMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendDirectChannelMessage).mock.calls[0][1]).toContain("already MERGED");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(alerts()).toHaveLength(0);
    expect(wakes()).toHaveLength(0);
    const bridge = JSON.parse(await readFile(join(dir, "wake-bridge.json"), "utf8"));
    expect(bridge.records).toContainEqual(expect.objectContaining({
      runId: "run-undelivered", status: "closed",
      lastVerdict: expect.stringContaining(deliveryFails ? "disclosure delivery failed" : "already MERGED"),
    }));
  });

  it.each([false, true])("retains mixed open work and marks failed live reads unavailable (disclosure failure=%s)", async (deliveryFails) => {
    lookup.mockImplementation(async (url: string) => {
      if (url === PR) return { ...OPEN, state: "MERGED", mergeable: null };
      throw new Error("private error");
    });
    if (deliveryFails) vi.mocked(sendDirectChannelMessage).mockRejectedValue(new Error("private delivery error"));
    config.wakeSettleMs = 20;
    create();
    await injector.inject(frame("terminal"));
    await injector.inject(frame("unavailable", `${PR}1`));
    await vi.waitFor(() => expect(wakes()).toHaveLength(1));
    expect(wakes()[0].message).toContain("UNAVAILABLE");
    expect(wakes()[0].message).not.toContain("private error");
    expect(wakes()[0].message).toContain(`${PR}1`);
  });

  it("stops after the third unchanged normalized tool result and alerts with complete evidence", async () => {
    create();
    await start();
    const hooks = await registeredHooks();
    for (let i = 0; i < 3; i++) {
      await hooks.after_tool_call({
        toolName: "session_status", toolCallId: `poll-${i}`,
        params: i % 2 ? { b: 2, a: 1 } : { a: 1, b: 2 },
        result: { content: [{ type: "text", text: "unchanged" }] },
      }, ctx());
    }
    expect(alerts()).toHaveLength(1);
    for (const evidence of [ctx().sessionKey, PR, "session_status", "last result", "unchanged"]) {
      expect(alerts()[0][1]).toContain(evidence);
    }
    expect(abort).toHaveBeenCalledWith(ctx().sessionKey, ctx().runId);
    expect(injector.runtimeHooks.before_tool_call({ toolName: "message", params: {} }, ctx())).toMatchObject({ block: true });
    await end("NO_REPLY");
    expect(alerts()).toHaveLength(1);
  });

  it.each([undefined, 100])("enforces configured/default per-session context ceiling %s", async (limit) => {
    config.maxWakeTokens = limit;
    create();
    await start();
    injector.runtimeHooks.before_message_write({ message: {
      id: "first", role: "assistant", content: "working", usage: { input: limit ?? 80_000 },
    } }, ctx());
    expect(alerts()).toHaveLength(0); // exactly at the ceiling is allowed
    injector.runtimeHooks.before_message_write({ message: {
      id: "second", role: "assistant", content: "still working", usage: {
        input: limit ?? 80_000, output: 1, contextUsage: { state: "available", totalTokens: 2 },
      },
    } }, ctx());
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(alerts()[0][1]).toContain("wake per-session context ceiling exceeded");
    expect(alerts()[0][1]).toContain(`tokens: ${(limit ?? 80_000) + 1}`);
    expect(abort).toHaveBeenCalledWith(ctx().sessionKey, ctx().runId);
  });

  it.each(["I will spawn the reviewers now.", "NO_REPLY"])("alerts a non-reporting ending: %s", async (text) => {
    create();
    await start();
    await end(text);
    expect(alerts()).toHaveLength(1);
    for (const evidence of ["wake ended without reporting", ctx().sessionKey, PR, text]) expect(alerts()[0][1]).toContain(evidence);
    await end(text);
    expect(alerts()).toHaveLength(1);
  });

  it("accepts an actual message receipt, not wrong-target or failed sends", async () => {
    create();
    await start("reported");
    await messageReceipt();
    await end("NO_REPLY"); // A confirmed send is still a disclosure even without final prose.
    expect(alerts()).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await start("failed-send", 1);
    await messageReceipt("wrong-target", { ok: true }, 1);
    await messageReceipt("123", { isError: true }, 1);
    await end("I tried to report", 1);
    expect(alerts()).toHaveLength(1);
  });

  async function spawnChild() {
    const spawn = await injector.runtimeHooks.before_tool_call({
      toolName: "sessions_spawn", params: { task: "review, merge, enqueue and dispatch", model: "cheap" },
    }, ctx()) as { params: { task: string; model: string; runtime: string } };
    const child = { sessionKey: "agent:main:subagent:decision", runId: "child-runner" };
    const model = injector.runtimeHooks.before_model_resolve({ prompt: spawn.params.task }, child);
    expect(model).toEqual({ providerOverride: "anthropic", modelOverride: "claude-opus-5-5" });
    expect(spawn.params).toMatchObject({ model: "anthropic/claude-opus-5-5", runtime: "subagent" });
    return child;
  }

  it("uses directSend as the required disclosure destination when reportTo is unset", async () => {
    config.reportTo = undefined;
    create();
    await start();
    expect((injector.runtimeHooks.before_prompt_build({}, ctx()) as { appendSystemContext: string })
      .appendSystemContext).toContain("agent:main:telegram:direct:123");
    await messageReceipt();
    await end("NO_REPLY");
    expect(alerts()).toHaveLength(0);
  });

  it("lets decision children report to directSend without reportTo", async () => {
    config.reportTo = undefined;
    create();
    await start();
    const child = await spawnChild();
    await expect(createWakeReportTool(child, injector.reportWake).execute("r", {
      outcome: "completed", message: "Reviewed live head",
    })).resolves.toBeDefined();
    expect(vi.mocked(sendDirectChannelMessage).mock.calls.some(([ds, text]) =>
      ds?.channel === "telegram" && ds.target === "123" && text.includes("Reviewed live head"))).toBe(true);
  });

  it("warns once at startup and skips silent-ending checks when no disclosure destination exists", async () => {
    config.reportTo = undefined;
    config.directSend = undefined;
    create();
    await start();
    await end("NO_REPLY");
    expect(alerts()).toHaveLength(0);
    expect(vi.mocked(console.warn).mock.calls.filter(([text]) => String(text).includes("silent-ending"))).toHaveLength(1);
  });

  it("pins and supervises a child before subagent_spawned; real child reporting avoids false silence", async () => {
    create();
    await start();
    expect(injector.runtimeHooks.before_tool_call({ toolName: "exec", params: { command: "gh pr merge" } }, ctx())).toMatchObject({ block: true });
    const child = await spawnChild();
    injector.runtimeHooks.llm_input({
      prompt: wakes()[0].message, runId: child.runId,
      provider: "anthropic", model: "claude-opus-5-5",
    }, child); // Delegated evidence must not overwrite the parent runner.
    await end("NO_REPLY"); // delegation is not completion
    expect(alerts()).toHaveLength(0);
    const tool = createWakeReportTool(child, injector.reportWake);
    await tool.execute("report", { outcome: "completed", message: "Reviewed and merged the live head; next step dispatched." });
    expect(vi.mocked(sendDirectChannelMessage).mock.calls.some(([ds, text]) =>
      ds?.channel === "telegram" && ds.target === "123" && text.includes("Warp wake completed"))).toBe(true);
    await injector.onAgentEnd!({ success: true, runId: child.runId, messages: [
      { role: "assistant", content: "Reviewed and merged" },
    ] }, child);
    expect(alerts()).toHaveLength(0);
    const bridge = JSON.parse(await readFile(join(dir, "wake-bridge.json"), "utf8"));
    expect(bridge.records[0].lastVerdict).toBe("Reviewed and merged");
    expect(injector.runtimeHooks.before_tool_call({ toolName: "exec", params: {} }, ctx())).toMatchObject({ block: true });
  });

  it("does not add parent and child contexts, but aborts both for an oversized child", async () => {
    create();
    await start();
    const child = await spawnChild();
    injector.runtimeHooks.before_message_write({ message: { role: "assistant", usage: { input: 60_000 } } }, ctx());
    injector.runtimeHooks.before_message_write({ message: { role: "assistant", usage: { input: 30_000 } } }, child);
    expect(alerts()).toHaveLength(0);
    injector.runtimeHooks.before_message_write({ message: { role: "assistant", usage: { input: 85_000 } } }, child);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(alerts()[0][1]).toContain("tokens: 85000");
    expect(abort).toHaveBeenCalledWith(ctx().sessionKey, ctx().runId);
    expect(abort).toHaveBeenCalledWith(child.sessionKey, child.runId);
  });

  it("aborts and alerts instead of running decision actions on a fallback model", async () => {
    create();
    await start();
    const child = await spawnChild();
    injector.runtimeHooks.llm_input({ provider: "cheap", model: "fallback", runId: child.runId }, child);
    expect(injector.runtimeHooks.before_tool_call({ toolName: "exec", params: {} }, child)).toMatchObject({ block: true });
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(alerts()[0][1]).toContain("decision subagent model differs");
  });

  it("failed child reporting is not a receipt and is surfaced at the end", async () => {
    create();
    await start();
    const child = await spawnChild();
    vi.mocked(sendDirectChannelMessage).mockRejectedValueOnce(new Error("channel offline"));
    await expect(createWakeReportTool(child, injector.reportWake).execute("r", { outcome: "blocked", message: "Could not merge" }))
      .rejects.toThrow("channel offline");
    await end("NO_REPLY");
    await injector.onAgentEnd!({ success: true, runId: child.runId, messages: [{ role: "assistant", content: "NO_REPLY" }] }, child);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0][1]).toContain("wake ended without reporting");
  });

  it("rejects unrelated report calls and malformed disclosure data", async () => {
    create();
    await start();
    await expect(createWakeReportTool({ sessionKey: "agent:other:private" }, injector.reportWake)
      .execute("r", { outcome: "completed", message: "unrelated" })).rejects.toThrow("No active Warp wake");
    await expect(createWakeReportTool(ctx(), injector.reportWake)
      .execute("r", { outcome: "completed", message: "" })).rejects.toThrow("disclosure");
    await expect(injector.reportWake(ctx(), { outcome: "blocked", message: " " })).rejects.toThrow("disclosure");
    await expect(injector.reportWake(ctx(), { outcome: "blocked", message: "x".repeat(2_001) })).rejects.toThrow("disclosure");
    await expect(injector.reportWake(ctx(), { outcome: "started" as "completed", message: "review started" })).rejects.toThrow("disclosure");
  });

  it("rechecks stopped state using factory context without runId before a report side effect", async () => {
    config.maxWakeTokens = 1;
    create();
    await start();
    const child = await spawnChild();
    const tool = createWakeReportTool({ sessionKey: child.sessionKey }, injector.reportWake);
    injector.runtimeHooks.before_message_write({ message: { role: "assistant", usage: { input: 2 } } }, child);
    await expect(tool.execute("late-report", { outcome: "completed", message: "too late" })).rejects.toThrow("already stopped");
  });

  it("accounts live fixed-session usage by current batch/runner, not admission UUID", async () => {
    config.sessionPerWake = false;
    config.maxWakeTokens = 100;
    create();
    await start();
    injector.runtimeHooks.before_message_write({ message: { role: "assistant", usage: { input: 101 } } }, { sessionKey: ctx().sessionKey });
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(abort).toHaveBeenCalledWith(ctx().sessionKey, ctx().runId);
  });
});
