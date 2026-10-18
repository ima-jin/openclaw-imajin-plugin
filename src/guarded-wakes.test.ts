import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotificationInjector, type WsNotificationsConfig } from "./notification-injector.js";
import { sendDirectChannelMessage } from "./channel-notify.js";
import { createWakeReportTool } from "./wake-report-tool.js";
import type { NotificationFrame } from "./ws-service.js";

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
    injector?.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function create() {
    injector = createNotificationInjector({ runtime: {
      config: { current: () => ({}) }, system: { enqueueSystemEvent: () => true },
    } }, config, { liveStateLookup: lookup, abortWake: abort, sessionTokens: async () => 0 });
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

  it("does not admit or discard a terminal wake when its disclosure send fails", async () => {
    lookup.mockResolvedValue({ ...OPEN, state: "MERGED", mergeable: "UNKNOWN" });
    vi.mocked(sendDirectChannelMessage).mockImplementation(async (_ds, text) => {
      if (text.includes("already MERGED")) throw new Error("delivery failed");
    });
    create();
    await injector.inject(frame("undelivered"));
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(alerts()[0][1]).toContain("terminal subject disclosure failed");
    expect(wakes()).toHaveLength(0);
    expect(Object.keys(JSON.parse(await readFile(join(dir, "pending-wakes.json"), "utf8")).wakes)).toHaveLength(1);
  });

  it("retains mixed open work and explicitly marks failed live reads unavailable", async () => {
    lookup.mockImplementation(async (url: string) => {
      if (url === PR) return { ...OPEN, state: "MERGED", mergeable: null };
      throw new Error("private error");
    });
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
    for (let i = 0; i < 3; i++) {
      await injector.runtimeHooks.after_tool_call({
        toolName: "session_status", toolCallId: `poll-${i}`,
        params: i % 2 ? { b: 2, a: 1 } : { a: 1, b: 2 }, result: { state: "unchanged" },
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

  it.each([undefined, 100])("enforces configured/default cumulative ceiling %s during the wake, not final context size", async (limit) => {
    config.maxWakeTokens = limit;
    create();
    await start();
    injector.runtimeHooks.before_message_write({ message: {
      id: "first", role: "assistant", content: "working", usage: { input: limit ?? 80_000 },
    } }, ctx());
    expect(alerts()).toHaveLength(0); // exactly at the ceiling is allowed
    injector.runtimeHooks.before_message_write({ message: {
      id: "second", role: "assistant", content: "still working", usage: {
        output: 1, contextUsage: { state: "available", totalTokens: 2 },
      },
    } }, ctx());
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(alerts()[0][1]).toContain("wake token budget exceeded");
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
    const spawn = injector.runtimeHooks.before_tool_call({
      toolName: "sessions_spawn", params: { task: "review, merge, enqueue and dispatch", model: "cheap" },
    }, ctx()) as { params: { task: string; model: string; runtime: string } };
    const child = { sessionKey: "agent:main:subagent:decision", runId: "child-runner" };
    const model = injector.runtimeHooks.before_model_resolve({ prompt: spawn.params.task }, child);
    expect(model).toEqual({ providerOverride: "anthropic", modelOverride: "claude-opus-5-5" });
    expect(spawn.params).toMatchObject({ model: "anthropic/claude-opus-5-5", runtime: "subagent" });
    return child;
  }

  it("pins and supervises a child before subagent_spawned; real child reporting avoids false silence", async () => {
    create();
    await start();
    expect(injector.runtimeHooks.before_tool_call({ toolName: "exec", params: { command: "gh pr merge" } }, ctx())).toMatchObject({ block: true });
    const child = await spawnChild();
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
  });

  it("sums parent and child usage and aborts both on a crossing", async () => {
    config.maxWakeTokens = 100;
    create();
    await start();
    const child = await spawnChild();
    injector.runtimeHooks.before_message_write({ message: { role: "assistant", usage: { input: 60 } } }, ctx());
    injector.runtimeHooks.before_message_write({ message: { role: "assistant", usage: { input: 50 } } }, child);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(alerts()[0][1]).toContain("tokens: 110");
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
