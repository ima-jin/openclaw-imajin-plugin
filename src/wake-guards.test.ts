import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WAKE_TOKEN_BUDGET, WakeGuards, type WakeGuardAlert, type WakeGuardOptions, type WakeGuardToolEvent } from "./wake-guards.js";

const SESSION = "agent:main:wake:batch";
const CTX = { sessionKey: SESSION, runId: "runner" };
const TARGET = { sessionKey: "agent:main:telegram:direct:123" };

function setup(options: Partial<WakeGuardOptions> = {}, uniqueSession = true, knownDuplicate = false) {
  const alert = vi.fn(async (_batch: WakeGuardAlert, _reason: string) => {});
  const abort = vi.fn(async () => {});
  const guards = new WakeGuards({ alert, abort, reportTo: [TARGET], ...options });
  guards.track({ batchId: "batch", sessionKey: SESSION, subject: "Review issue #82", uniqueSession, knownDuplicate });
  return { guards, alert, abort };
}

function tool(params: Record<string, unknown> = { query: "state" }, result: unknown = { state: "pending" }): WakeGuardToolEvent {
  return { toolName: "poll", params, result };
}

function message(tokens: number, id?: string) {
  return { role: "assistant", id, usage: { input: tokens }, content: "first line\nlast line" };
}

async function send(guards: WakeGuards, target = "123", result: unknown = { ok: true }, ctx = CTX) {
  await guards.afterToolCall({
    toolName: "message", params: { action: "send", channel: "telegram", target }, result,
  }, ctx);
}

describe("wake repetition guards", () => {
  it("stops immediately after the third completed identical result with normalized keys", async () => {
    const { guards, alert, abort } = setup();
    await guards.afterToolCall(tool({ a: 1, b: { y: 2, z: 3 } }, { a: 1, b: 2 }), CTX);
    await guards.afterToolCall(tool({ b: { z: 3, y: 2 }, a: 1 }, { b: 2, a: 1 }), CTX);
    expect(alert).not.toHaveBeenCalled();
    expect(guards.beforeToolCall(tool(), CTX)).toBeUndefined();
    await guards.afterToolCall(tool({ a: 1, b: { y: 2, z: 3 } }, { a: 1, b: 2 }), CTX);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(SESSION, "runner");
    expect(guards.beforeToolCall(tool(), CTX)).toMatchObject({ block: true });
    await guards.afterToolCall(tool(), CTX);
    await guards.end({ messages: [] }, CTX);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("detects interleaved polling, retaining separate counters for each argument set", async () => {
    const { guards, alert } = setup();
    for (let index = 0; index < 3; index++) {
      await guards.afterToolCall(tool({ id: "a" }), CTX);
      if (index < 2) await guards.afterToolCall(tool({ id: "b" }, { progress: index }), CTX);
    }
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: SESSION, subject: "Review issue #82",
      lastTool: expect.objectContaining({ toolName: "poll", args: expect.stringContaining("a"), result: expect.stringContaining("pending") }),
    }), "repeated tool call without progress");
  });

  it("resets the same-call streak when its result changes", async () => {
    const { guards, alert } = setup();
    for (const state of ["pending", "pending", "running", "running"]) {
      await guards.afterToolCall(tool(undefined, { state }), CTX);
    }
    expect(alert).not.toHaveBeenCalled();
    await guards.afterToolCall(tool(undefined, { state: "running" }), CTX);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("does not count duplicate after-tool hooks twice", async () => {
    const { guards, alert } = setup();
    for (let index = 0; index < 5; index++) {
      await guards.afterToolCall({ ...tool(), toolCallId: "same-call" }, CTX);
    }
    expect(alert).not.toHaveBeenCalled();
  });

  it("tracks live usage for an authoritative active fixed runner, not the next queued batch", async () => {
    const { guards, alert } = setup({ maxTokens: 9 }, false);
    guards.track({ batchId: "queued", sessionKey: SESSION, subject: "queued" });
    guards.bindRunner("batch", "runner");
    guards.onBeforeMessageWrite({ message: message(10) }, { sessionKey: SESSION });
    await guards.onLlmOutput({}, CTX);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ batchId: "batch", tokens: 10 }), "wake token budget exceeded");
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("correlates fixed queued batches by exact runner and aliases by explicit batch", async () => {
    const { guards, alert } = setup({}, false);
    guards.track({ batchId: "queued", sessionKey: SESSION, subject: "queued" });
    guards.bindRunner("batch", "runner");
    guards.bindRunner("queued", "queued-runner");
    expect(guards.aliasSession(SESSION, "child")).toBe(false);
    expect(guards.aliasSession(SESSION, "child", "child-runner", "queued")).toBe(true);
    await send(guards);
    await guards.end({ batchId: "batch", messages: [] }, CTX);
    expect(alert).not.toHaveBeenCalled();
    await guards.end({ batchId: "queued", messages: [] }, { sessionKey: SESSION, runId: "queued-runner" });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ batchId: "queued" }), "wake ended without reporting");
  });

  it("supports injected external fail-closed stopping with once-only alert and abort", async () => {
    const { guards, alert, abort } = setup();
    const stopped = guards.stop("batch", "decision model mismatch");
    expect(guards.beforeToolCall(tool(), CTX)).toMatchObject({ block: true });
    await stopped;
    await guards.stop("batch", "second stop");
    expect(alert).toHaveBeenCalledWith(expect.any(Object), "decision model mismatch");
    expect(alert).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
    await guards.stop("unknown", "ignored");
  });

  it("skips cyclic signatures rather than false-tripping", async () => {
    const { guards, alert } = setup();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (let index = 0; index < 3; index++) {
      await guards.afterToolCall(tool({}, cyclic), CTX);
    }
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("per-wake usage budget", () => {
  it("uses 80,000 tokens independently of a larger context window", async () => {
    const { guards, alert } = setup();
    expect(DEFAULT_WAKE_TOKEN_BUDGET).toBe(80_000);
    guards.onBeforeMessageWrite({ message: {
      ...message(50_000), usage: { input: 50_000, output: 5_000, cacheRead: 20_000, cacheWrite: 5_001,
        contextUsage: { state: "available", totalTokens: 1_000 } },
    } }, { sessionKey: SESSION });
    expect(guards.beforeToolCall(tool(), CTX)).toMatchObject({ block: true });
    await guards.onLlmOutput({ usage: { input: 80_000 } }, CTX);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ tokens: 80_001 }), "wake token budget exceeded");
  });

  it("sums every assistant message live and does not consume user or tool usage", async () => {
    const { guards, alert } = setup({ maxTokens: 99 });
    guards.onBeforeMessageWrite({ message: { role: "user", usage: { input: 1_000 } } }, CTX);
    guards.onBeforeMessageWrite({ message: { role: "toolResult", usage: { input: 1_000 } } }, CTX);
    guards.onBeforeMessageWrite({ message: message(40, "one") }, CTX);
    expect(alert).not.toHaveBeenCalled();
    guards.onBeforeMessageWrite({ message: message(60, "two") }, CTX);
    expect(guards.beforeToolCall(tool(), CTX)).toMatchObject({ block: true });
    await guards.onLlmOutput({}, CTX);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("deduplicates object identity, stable IDs and timestamped assistant copies", async () => {
    const { guards, alert } = setup({ maxTokens: 99 });
    const first = message(20);
    guards.onBeforeMessageWrite({ message: first }, CTX);
    guards.onBeforeMessageWrite({ message: first }, CTX);
    guards.onBeforeMessageWrite({ message: message(20, "id") }, CTX);
    guards.onBeforeMessageWrite({ message: message(20, "id") }, CTX);
    guards.onBeforeMessageWrite({ message: { ...message(20), timestamp: 1 } }, CTX);
    guards.onBeforeMessageWrite({ message: { ...message(20), timestamp: 1 } }, CTX);
    await guards.onLlmOutput({ usage: { input: 60 } }, CTX);
    expect(alert).not.toHaveBeenCalled();
  });

  it("aggregate fallback never double-adds live messages or duplicate llm_output", async () => {
    const { guards, alert } = setup({ maxTokens: 99 });
    guards.onBeforeMessageWrite({ message: message(40, "one") }, CTX);
    await guards.onLlmOutput({ usage: { input: 70 }, lastAssistant: { id: "attempt" } }, CTX);
    await guards.onLlmOutput({ usage: { input: 70 }, lastAssistant: { id: "attempt" } }, CTX);
    guards.onBeforeMessageWrite({ message: message(40, "two") }, CTX);
    expect(alert).not.toHaveBeenCalled();
    await guards.onLlmOutput({ usage: { input: 100 }, lastAssistant: { id: "attempt" } }, CTX);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ tokens: 100 }), "wake token budget exceeded");
  });

  it("allows exactly the budget and accumulates distinct retry attempts without live messages", async () => {
    const { guards, alert } = setup({ maxTokens: 100 });
    await guards.onLlmOutput({ usage: { input: 60 }, lastAssistant: { id: "attempt-one" } }, CTX);
    await guards.onLlmOutput({ usage: { input: 40 }, lastAssistant: { id: "attempt-two" } }, CTX);
    expect(alert).not.toHaveBeenCalled();
    await guards.onLlmOutput({ usage: { input: 1 }, lastAssistant: { id: "attempt-three" } }, CTX);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ tokens: 101 }), "wake token budget exceeded");
  });

  it("hashes large string results fully instead of bypassing repetition", async () => {
    const { guards, alert } = setup();
    for (let index = 0; index < 3; index++) await guards.afterToolCall(tool({}, "x".repeat(70_000)), CTX);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("accepts only configured trusted plugin receipts and supports synthetic exact batch endings", async () => {
    const { guards, alert } = setup();
    guards.recordDisclosure("unknown", TARGET.sessionKey);
    guards.recordDisclosure("batch", "agent:other:telegram:direct:other");
    guards.recordDisclosure("batch", TARGET.sessionKey);
    await guards.end({ batchId: "batch", sessionKey: SESSION, messages: [] });
    expect(alert).not.toHaveBeenCalled();
    expect(guards.track({ batchId: "batch", sessionKey: SESSION, subject: "duplicate" })).toBe(false);
  });

  it.each([
    { details: { messageId: "sent" } },
    { content: [{ type: "text", text: '{"ok":true,"messageId":"sent"}' }] },
    '{"success":true}',
  ])("accepts positive SDK receipts %j", async (result) => {
    const { guards, alert } = setup();
    await send(guards, "123", result);
    await guards.end({ messages: [] }, CTX);
    expect(alert).not.toHaveBeenCalled();
  });

  it.each([
    {}, "sent", { isError: false },
    { ok: true, content: [{ type: "text", text: '{"error":"failed"}' }] },
    { content: [{ type: "text", text: '{"ok":false}' }] },
  ])("rejects unproven or structured failed receipts %j", async (result) => {
    const { guards, alert } = setup();
    await send(guards, "123", result);
    await guards.end({ messages: [] }, CTX);
    expect(alert).toHaveBeenCalledWith(expect.any(Object), "wake ended without reporting");
  });

  it("uses aggregate-only usage when no live messages are available", async () => {
    const { guards, alert } = setup({ maxTokens: 9 });
    await guards.onLlmOutput({ usage: { input: 3, output: 2, cacheRead: 3, cacheWrite: 2 } }, CTX);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("does not use context usage, cost, NaN or negative usage as token totals", async () => {
    const { guards, alert } = setup({ maxTokens: 9 });
    guards.onBeforeMessageWrite({ message: {
      role: "assistant", usage: { input: NaN, output: -3, cacheRead: Infinity, contextUsage: { totalTokens: 100_000 } },
      cost: { total: 100_000 },
    } }, CTX);
    await guards.onLlmOutput({ usage: { total: 9 } }, CTX);
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("verified channel disclosure and silent endings", () => {
  it("does not infer one unspecified channel send as disclosure to multiple channels", async () => {
    const { guards, alert } = setup({ reportTo: [TARGET, { sessionKey: "agent:main:discord:direct:123" }] });
    await guards.afterToolCall({
      toolName: "message", params: { action: "send", target: "123" }, result: { ok: true },
    }, CTX);
    await guards.end({ messages: [] }, CTX);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("does not silently forget required destinations beyond the storage cap", async () => {
    const reportTo = Array.from({ length: 129 }, (_, index) => ({ sessionKey: `agent:main:telegram:direct:${index}` }));
    const { guards, alert } = setup({ reportTo });
    for (const target of reportTo) guards.recordDisclosure("batch", target.sessionKey);
    await guards.end({ messages: [] }, CTX);
    expect(alert).toHaveBeenCalledTimes(1);
  });
  it("counts successful sends to every required destination, including to and channel prefixes", async () => {
    const { guards, alert } = setup({ reportTo: [TARGET, { sessionKey: "agent:main:telegram:group:-456" }] });
    await send(guards);
    await guards.afterToolCall({
      toolName: "message", params: { action: "send", to: "telegram:-456" }, result: { isError: false, messageId: "sent-id" },
    }, CTX);
    expect(await guards.end({ messages: [{ role: "assistant", content: "NO_REPLY" }] }, CTX)).toBeUndefined();
    expect(alert).not.toHaveBeenCalled();
  });

  it("alerts partial disclosure even with confident final prose", async () => {
    const { guards, alert } = setup({ reportTo: [TARGET, { sessionKey: "agent:main:telegram:group:-456" }] });
    await send(guards);
    await guards.end({ messages: [{ role: "assistant", content: "Everything has been reported" }] }, CTX);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({
      lastAssistantLine: "Everything has been reported",
    }), "wake ended without reporting");
  });

  it.each([
    undefined, null, false, { isError: true }, { error: "failed" }, { ok: false }, { success: false },
    { details: { isError: true } }, { details: { error: "failed" } }, { status: "error" },
  ])("does not count unsuccessful send result %j", async (result) => {
    const { guards, alert } = setup();
    await guards.afterToolCall({
      toolName: "message", params: { action: "send", channel: "telegram", target: "123" }, result,
    }, CTX);
    await guards.end({ messages: [] }, CTX);
    expect(alert).toHaveBeenCalledWith(expect.any(Object), "wake ended without reporting");
  });

  it.each([
    { toolName: "exec", params: { action: "send", target: "123" } },
    { toolName: "message", params: { action: "read", target: "123" } },
    { toolName: "message", params: { action: "send", target: "other" } },
    { toolName: "message", params: { action: "send", target: "123", channel: "discord" } },
  ])("ignores wrong tool, action or destination %j", async (event) => {
    const { guards, alert } = setup();
    await guards.afterToolCall({ ...event, result: { ok: true } }, CTX);
    await guards.end({ messages: [] }, CTX);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("rejects explicit after-tool errors despite successful-looking results", async () => {
    const { guards, alert } = setup();
    await guards.afterToolCall({
      toolName: "message", params: { action: "send", target: "123" }, result: { isError: false, messageId: "sent-id" }, error: "failed",
    }, CTX);
    await guards.end({ messages: [] }, CTX);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it.each(["NO_REPLY", "", "finished"])("treats %j as silent without verified delivery", async (content) => {
    const { guards, alert } = setup();
    await guards.end({ messages: [{ role: "assistant", content }] }, CTX);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("suppresses silent alerts only for explicitly known duplicates", async () => {
    const { guards, alert } = setup({}, true, true);
    await guards.end({ messages: [{ role: "assistant", content: "NO_REPLY" }] }, CTX);
    expect(alert).not.toHaveBeenCalled();
  });

  it("known duplicates do not suppress real loop guards", async () => {
    const { guards, alert } = setup({}, true, true);
    for (let index = 0; index < 3; index++) await guards.afterToolCall(tool(), CTX);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it.each([{ reportTo: [] }, { reportTo: [{ sessionKey: "agent:reporter:fixture" }] }])("fails loud without routable reportTo %j", async ({ reportTo }) => {
    const { guards, alert } = setup({ reportTo });
    await send(guards);
    await guards.end({ messages: [] }, CTX);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("duplicate endings are idempotent and cannot claim a later tracked batch", async () => {
    const { guards, alert } = setup();
    await Promise.all([guards.end({ messages: [] }, CTX), guards.end({ messages: [] }, CTX)]);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(guards.track({ batchId: "batch", sessionKey: SESSION, subject: "duplicate" })).toBe(false);
    guards.track({ batchId: "next", sessionKey: SESSION, subject: "next", uniqueSession: true });
    guards.bindRunner("next", "next-runner");
    await guards.end({ messages: [] }, CTX);
    expect(alert).toHaveBeenCalledTimes(1);
  });
});

describe("exact correlation, child ownership and bounded lifecycle", () => {
  it("unique session captures actual runner independently of gateway admission UUID", async () => {
    const { guards, alert, abort } = setup({ maxTokens: 9 });
    guards.bindRun("batch", "admission");
    await guards.onLlmOutput({ usage: { input: 10 } }, CTX);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(SESSION, "runner");
    expect(guards.beforeToolCall(tool(), { ...CTX, runId: "unrelated" })).toBeUndefined();
  });

  it("fixed sessions need a proven runner and ignore uncorrelated live writes", async () => {
    const { guards, alert } = setup({ maxTokens: 9 }, false);
    guards.onBeforeMessageWrite({ message: message(10) }, CTX);
    await guards.onLlmOutput({ usage: { input: 10 } }, CTX);
    expect(alert).not.toHaveBeenCalled();
    guards.bindRun("batch", "admission");
    await guards.onLlmOutput({ usage: { input: 10 } }, CTX);
    expect(alert).not.toHaveBeenCalled();
    guards.bindRunner("batch", "runner");
    await guards.onLlmOutput({ usage: { input: 10 } }, CTX);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("ignores missing/unknown sessions, missing runs and conflicting event/context", async () => {
    const { guards, alert } = setup({ maxTokens: 0.5 });
    await guards.onLlmOutput({ usage: { input: 10 } }, { runId: "runner" });
    await guards.onLlmOutput({ usage: { input: 10 } }, { sessionKey: "nonwake", runId: "runner" });
    await guards.onLlmOutput({ usage: { input: 10 } }, { sessionKey: SESSION });
    await guards.onLlmOutput({ sessionKey: "other", usage: { input: 10 } }, CTX);
    await guards.onLlmOutput({ runId: "other", usage: { input: 10 } }, CTX);
    await guards.end({ messages: [] }, { sessionKey: "nonwake", runId: "runner" });
    expect(alert).not.toHaveBeenCalled();
  });

  it("shares root and child budgets, blocks both and aborts all owned runs", async () => {
    const { guards, alert, abort } = setup({ maxTokens: 99 });
    guards.bindRunner("batch", "runner");
    const child = { sessionKey: "agent:main:subagent:child", runId: "child-runner" };
    expect(guards.aliasSession(SESSION, child.sessionKey, child.runId)).toBe(true);
    guards.onBeforeMessageWrite({ message: message(40, "same-id") }, CTX);
    guards.onBeforeMessageWrite({ message: message(60, "same-id") }, child);
    expect(guards.beforeToolCall(tool(), child)).toMatchObject({ block: true });
    await guards.onLlmOutput({}, child);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ tokens: 100 }), "wake token budget exceeded");
    expect(abort).toHaveBeenCalledWith(SESSION, "runner");
    expect(abort).toHaveBeenCalledWith(child.sessionKey, "child-runner");
    expect(guards.beforeToolCall(tool(), CTX)).toMatchObject({ block: true });
  });

  it("accepts a child send as root disclosure", async () => {
    const { guards, alert } = setup();
    const child = { sessionKey: "agent:main:subagent:child", runId: "child-runner" };
    guards.aliasSession(SESSION, child.sessionKey, child.runId);
    await send(guards, "123", { ok: true }, child);
    await guards.end({ messages: [] }, CTX);
    expect(alert).not.toHaveBeenCalled();
  });

  it("does not throw or send twice when abort and alert reject", async () => {
    const alert = vi.fn(async () => { throw new Error("private alert error"); });
    const abort = vi.fn(async () => { throw new Error("private abort error"); });
    const { guards } = setup({ alert, abort, maxTokens: 0.5 });
    guards.onBeforeMessageWrite({ message: message(1) }, CTX);
    await expect(guards.end({ messages: [] }, CTX)).resolves.toBe("wake token budget exceeded");
    expect(alert).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("bounds private evidence and does not log raw arguments, results or assistant lines", async () => {
    const spies = ["log", "warn", "error", "info"].map((method) => vi.spyOn(console, method as "log").mockImplementation(() => {}));
    try {
      const { guards, alert } = setup();
      const value = "private-evidence".repeat(1_000);
      for (let index = 0; index < 3; index++) await guards.afterToolCall(tool({ value }, value), CTX);
      const evidence = alert.mock.calls[0]?.[0];
      expect(evidence).toMatchObject({ sessionKey: SESSION });
      expect(evidence?.lastTool?.args.length).toBeLessThanOrEqual(1_024);
      expect(evidence?.lastTool?.result.length).toBeLessThanOrEqual(1_024);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("untrack and dispose remove ownership; capacity refuses excess tracked batches", async () => {
    const { guards, alert } = setup();
    expect(guards.track({ batchId: "batch", sessionKey: SESSION, subject: "duplicate" })).toBe(false);
    for (let index = 1; index < 100; index++) {
      expect(guards.track({ batchId: `b${index}`, sessionKey: `s${index}`, subject: "subject" })).toBe(true);
    }
    expect(guards.track({ batchId: "overflow", sessionKey: "overflow", subject: "subject" })).toBe(false);
    guards.untrack("batch");
    await guards.end({ messages: [] }, CTX);
    guards.dispose();
    await guards.onLlmOutput({ usage: { input: 100_000 } }, CTX);
    expect(alert).not.toHaveBeenCalled();
  });
});
