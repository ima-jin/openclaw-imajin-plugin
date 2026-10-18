import { describe, expect, it, vi } from "vitest";
import { WakeGuards, type WakeGuardAlert } from "./wake-guards.js";

const ROOT = { sessionKey: "agent:main:wake:followup", runId: "root-run" };
const CHILD = { sessionKey: "agent:main:subagent:followup", runId: "child-run" };
function setup() {
  const alert = vi.fn(async (_batch: WakeGuardAlert, _reason: string) => {});
  const abort = vi.fn(async () => {});
  const guards = new WakeGuards({ alert, abort, reportTo: [{ sessionKey: "agent:main:telegram:direct:123" }] });
  guards.track({ batchId: "wake", sessionKey: ROOT.sessionKey, uniqueSession: true, subject: "PR #2921" });
  guards.bindRunner("wake", ROOT.runId);
  return { guards, alert, abort };
}
const assistant = (input: number, id: string) => ({ message: { role: "assistant", id, usage: { input } } });
const output = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text }], isError: false, details,
});

describe("production wake guard regressions", () => {
  it("allows ten 20k-context turns instead of adding 200k billed usage", async () => {
    const { guards, alert } = setup();
    for (let i = 0; i < 10; i++) guards.onBeforeMessageWrite(assistant(20_000, `turn-${i}`), ROOT);
    await guards.onLlmOutput({ lastAssistant: { role: "assistant", usage: { input: 20_000 } },
      usage: { input: 200_000 } }, ROOT);
    expect(alert).not.toHaveBeenCalled();
    expect(guards.beforeToolCall({ toolName: "exec", params: {} }, ROOT)).toBeUndefined();
  });

  it("trips on a single 85k-context call", async () => {
    const { guards, alert } = setup();
    guards.onBeforeMessageWrite(assistant(85_000, "oversized"), ROOT);
    await guards.onLlmOutput({}, ROOT);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ tokens: 85_000 }), expect.any(String));
  });

  it("does not add root 60k to child 30k, but child 85k aborts both", async () => {
    const { guards, alert, abort } = setup();
    guards.aliasSession(ROOT.sessionKey, CHILD.sessionKey, CHILD.runId);
    guards.onBeforeMessageWrite(assistant(60_000, "root"), ROOT);
    guards.onBeforeMessageWrite(assistant(30_000, "child-first"), CHILD);
    await guards.onLlmOutput({}, CHILD);
    expect(alert).not.toHaveBeenCalled();
    guards.onBeforeMessageWrite(assistant(85_000, "child-oversized"), CHILD);
    await guards.onLlmOutput({}, CHILD);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ tokens: 85_000 }), expect.any(String));
    expect(abort).toHaveBeenCalledWith(ROOT.sessionKey, ROOT.runId);
    expect(abort).toHaveBeenCalledWith(CHILD.sessionKey, CHILD.runId);
  });

  it("ignores cumulative attempt usage when the last call context is only 44.7k", async () => {
    const { guards, alert } = setup();
    await guards.onLlmOutput({ usage: { input: 454_000 }, lastAssistant: {
      role: "assistant", usage: { input: 40_000, cacheRead: 4_000, cacheWrite: 500, output: 200 },
    } }, ROOT);
    expect(alert).not.toHaveBeenCalled();
  });

  it("detects unchanged exec output despite duration, timestamps, cwd and tokenjuice changes", async () => {
    const { guards, alert } = setup();
    for (let i = 0; i < 3; i++) {
      await guards.afterToolCall({
        toolName: "exec", params: { command: "gh pr view 2921 --json mergeable" },
        result: output('{"mergeable":"UNKNOWN"}', {
          exitCode: 0, status: "completed", durationMs: i + 1, timestamp: i,
          cwd: `/fixture/${i}`, tokenjuice: { tokens: i * 100 },
        }),
      }, ROOT);
      expect(alert).toHaveBeenCalledTimes(i === 2 ? 1 : 0);
    }
  });

  it.each(["poll", "log"])("does not count five identical process %s calls while running", async (action) => {
    const { guards, alert } = setup();
    const call = (status: string) => ({
      toolName: "process", params: { action, sessionId: "background-build" },
      result: output("no new output", { status, exitCode: status === "running" ? null : 0 }),
    });
    for (let i = 0; i < 5; i++) await guards.afterToolCall(call("running"), ROOT);
    expect(alert).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) await guards.afterToolCall(call("completed"), ROOT);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("redacts secret keys and string-shaped credentials in args and output before clipping", async () => {
    const { guards, alert } = setup();
    const credential = "ghp_fixtureCredential123";
    for (let i = 0; i < 3; i++) await guards.afterToolCall({
      toolName: "exec",
      params: { token: "fixture-keyed-secret", nested: { password: "fixture-password" }, command: `use ${credential}` },
      result: output(`Bearer fixtureBearer123 ${credential}`, { secret: "fixture-result-secret" }),
    }, ROOT);
    const evidence = JSON.stringify(alert.mock.calls[0]?.[0]);
    for (const raw of [credential, "fixture-keyed-secret", "fixture-password", "fixtureBearer123", "fixture-result-secret"]) {
      expect(evidence).not.toContain(raw);
    }
    expect(evidence).toContain("[redacted]");
  });

  it.each(["loop", "context", "silent"])("never includes vault results in a %s alert", async (path) => {
    const { guards, alert } = setup();
    const call = { toolName: "imajin_vault", params: { action: "fetch" }, result: output("fixture-vault-sensitive-value") };
    await guards.afterToolCall(call, ROOT);
    if (path === "loop") {
      await guards.afterToolCall(call, ROOT);
      await guards.afterToolCall(call, ROOT);
    } else if (path === "context") {
      guards.onBeforeMessageWrite(assistant(85_000, "oversized"), ROOT);
      await guards.onLlmOutput({}, ROOT);
    } else {
      await guards.end({ messages: [{ role: "assistant", content: "NO_REPLY" }] }, ROOT);
    }
    const evidence = alert.mock.calls[0]?.[0];
    expect(evidence?.lastTool?.result).toBe("[vault result omitted]");
    expect(JSON.stringify(evidence)).not.toContain("fixture-vault-sensitive-value");
  });
});
