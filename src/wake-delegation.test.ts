// Regression coverage for issue #121: wake delegation must not open coordinator actions.
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WAKE_DECISION_MODEL, WakeDecisionRouter, type WakeToolEvent } from "./wake-decision.js";

const parent = { sessionKey: "agent:main:warp-events:delegation" };
const spawnParams = {
  runtime: "subagent", model: "anthropic/claude-opus-5-5", task: "Review the wake subject",
};
const blockReason = "Wake review/approve/merge/enqueue/dispatch actions must run in a sessions_spawn subagent on anthropic/claude-opus-5-5. Only explicitly enabled, eligible read-only lookups may run here.";
const forbidden: WakeToolEvent[] = [
  { toolName: "exec", params: { command: "printf blocked" } },
  { toolName: "exec", params: { command: "gh pr merge 121 --squash" } },
  { toolName: "exec", params: { command: "gh pr review 121 --approve" } },
  { toolName: "exec", params: { command: 'gh api graphql -f query=mutation{enqueuePullRequest}' } },
  { toolName: "approve_pull_request", params: {} },
  { toolName: "merge_pull_request", params: {} },
  { toolName: "enqueue", params: {} },
  { toolName: "imajin_warp", params: { action: "dispatch", prompt: "ship it" } },
  { toolName: "dispatch", params: {} },
];

function setup() {
  const router = new WakeDecisionRouter(DEFAULT_WAKE_DECISION_MODEL, [], vi.fn());
  router.track(parent.sessionKey);
  return router;
}

describe("wake delegation regression (#121)", () => {
  it("allows native sessions_spawn and preserves pinned delegation parameters", async () => {
    const router = setup();
    expect(router.beforePromptBuild({}, parent)?.toolsAllow).toContain("sessions_spawn");
    const result = await router.beforeToolCall({ toolName: "sessions_spawn", params: spawnParams }, parent);
    expect(result?.block).not.toBe(true);
    expect(result?.params).toMatchObject({
      runtime: "subagent", model: "anthropic/claude-opus-5-5",
      task: expect.stringMatching(/^Wake decision ticket: .+\nReview the wake subject\n/),
    });
  });

  it("allows nested sessions_spawn through the host-identified Code Mode exec bridge", async () => {
    const router = setup();
    const code = "await sessions_spawn(params)";
    const event = {
      toolName: "exec", toolKind: "code_mode_exec", toolInputKind: "javascript",
      params: { title: "Delegate wake review", code, command: code },
    };
    expect(await router.beforeToolCall(event, parent)).toBeUndefined();
    // Model the host bridge: nested calls re-enter the same hook with their real tool name.
    const sessions_spawn = vi.fn(async (params: Record<string, unknown>) =>
      router.beforeToolCall({ toolName: "sessions_spawn", params }, parent));
    const result = await runInNewContext(`(async () => ${code})()`, { sessions_spawn, params: spawnParams });
    expect(sessions_spawn).toHaveBeenCalledOnce();
    expect(result?.block).not.toBe(true);
    expect(result?.params).toMatchObject({
      runtime: "subagent", model: "anthropic/claude-opus-5-5",
      task: expect.stringContaining("Wake decision ticket:"),
    });
  });

  it.each(forbidden)("refuses coordinator action $toolName with the existing blockReason: $params", async (event) => {
    const router = setup();
    expect(await router.beforeToolCall(event, parent)).toEqual({ block: true, blockReason });
  });
});
