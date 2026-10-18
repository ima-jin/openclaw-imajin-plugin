import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WAKE_DECISION_MODEL, WakeDecisionRouter } from "./wake-decision.js";

const parent = { sessionKey: "agent:main:warp-events:batch" };
const child = { sessionKey: "agent:main:subagent:decision" };
const ended = (text: string) => ({ success: true, messages: [{ role: "assistant", content: text }] });
function setup(model = DEFAULT_WAKE_DECISION_MODEL) {
  const added = vi.fn();
  const router = new WakeDecisionRouter(model, ["agent:main:telegram:direct:123"], added);
  router.track(parent.sessionKey);
  return { router, added };
}

describe("wake decision delegation", () => {
  it("narrows only coordinator tools and preserves unrelated session policy", () => {
    const { router } = setup();
    expect(router.beforePromptBuild({}, parent)).toMatchObject({ toolsAllow: ["message", "sessions_spawn", "session_status"] });
    expect(router.beforePromptBuild({}, parent)?.appendSystemContext).toContain("anthropic/claude-opus-5-5");
    expect(router.beforePromptBuild({}, {})).toBeUndefined();
    expect(router.beforeToolCall({ toolName: "exec", params: { command: "gh pr merge" } }, parent)?.block).toBe(true);
    expect(router.beforeToolCall({ toolName: "exec", params: {} }, {})).toBeUndefined();
    expect(router.beforeToolCall({ toolName: "message", params: {} }, parent)).toBeUndefined();
  });

  it("pins every delegated action and descendant spawn to the configured decision model", () => {
    const { router, added } = setup("provider/decision");
    expect(router.beforeToolCall({ toolName: "sessions_spawn", params: { model: "cheap", runtime: "acp", task: "review" } }, parent)).toEqual({
      params: { model: "provider/decision", runtime: "subagent", task: expect.stringMatching(/^Wake decision ticket: .+\nreview$/) },
    });
    router.onSubagentSpawned({ childSessionKey: child.sessionKey, runId: "child-run" }, { requesterSessionKey: parent.sessionKey });
    expect(added).toHaveBeenCalledWith(parent.sessionKey, child.sessionKey, "child-run", parent.sessionKey);
    expect(router.beforeModelResolve({}, child)).toEqual({ providerOverride: "provider", modelOverride: "decision" });
    expect(router.beforeModelResolve({}, parent)).toBeUndefined();
    expect(router.beforeToolCall({ toolName: "exec", params: {} }, child)).toBeUndefined();
    expect(router.beforePromptBuild({}, child)).not.toHaveProperty("toolsAllow");
    expect(router.beforeToolCall({ toolName: "sessions_spawn", params: {} }, child)?.params?.model).toBe("provider/decision");
  });

  it("waits for accepted children before claiming the wake complete", () => {
    const { router } = setup();
    router.onSubagentSpawned({ childSessionKey: child.sessionKey }, { requesterSessionKey: parent.sessionKey });
    expect(router.end(ended("NO_REPLY"), parent)).toBeUndefined();
    expect(router.end(ended("Reviewed and disclosed"), child)).toMatchObject({
      sessionKey: parent.sessionKey, event: { success: true, messages: [{ role: "user" }, { content: "Reviewed and disclosed" }] },
    });
    router.untrack(parent.sessionKey);
    expect(router.end(ended("duplicate"), child)).toBeUndefined();
  });

  it("retains child failure even if the coordinator claims success", () => {
    const { router } = setup();
    router.afterToolCall({ toolName: "sessions_spawn", params: {}, result: {
      content: [{ type: "text", text: JSON.stringify({ childSessionKey: child.sessionKey }) }],
    } }, parent);
    expect(router.end({ ...ended("failed"), success: false }, child)).toBeUndefined();
    expect(router.end(ended("parent result"), parent)?.event.success).toBe(false);
    router.dispose();
    expect(router.root(parent.sessionKey)).toBeUndefined();
  });

  it("does not treat failed or malformed spawn results as accepted children", () => {
    const { router, added } = setup();
    for (const result of [undefined, { isError: true }, { content: [{ type: "text", text: "not json" }] }]) {
      router.afterToolCall({ toolName: "sessions_spawn", params: {}, result }, parent);
    }
    expect(added).not.toHaveBeenCalled();
    expect(router.end(ended("complete"), parent)).toBeDefined();
  });
});
