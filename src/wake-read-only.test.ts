import { describe, expect, it, vi } from "vitest";
import { wakeReadOnlyLookup } from "./wake-read-only.js";
import { WakeDecisionRouter } from "./wake-decision.js";

describe("safe optional wake lookups", () => {
  it.each([
    "gh pr view 84 --json state,headRefOid --repo ima-jin/openclaw-imajin-plugin",
    "gh run view 123 --log-failed", "gh pr checks 84 --required", "gh issue list --limit=20",
    "gh pr list -R ima-jin/openclaw-imajin-plugin -L 2", "/opt/fixture/gh run list --branch main",
  ])("allows only a read command through the trusted absolute CLI: %s", (command) => {
    expect(wakeReadOnlyLookup({ toolName: "exec", params: { command } }, "/opt/fixture/gh"))
      .toEqual({ command: command.replace(/^(gh|\/opt\/fixture\/gh)/, "/opt/fixture/gh") });
  });

  it.each([
    "gh pr merge 84", "gh pr review 84 --approve", "gh api /repos/a/b --method POST",
    "gh pr view 84 --json", "gh pr view 84 --json=state --jq .state",
    "gh pr view 84 --repo=foo=bar", "gh pr view 84 --repo --approve",
    "gh pr view 84\n gh pr merge 84", "gh pr view `touch /fixture`", "gh pr view $PR",
    "/tmp/not-the-trusted-gh pr view 84", "gh pr view 84 --template=unsafe",
  ])("refuses mutations, invalid flags and command evaluation: %s", (command) => {
    expect(wakeReadOnlyLookup({ toolName: "exec", params: { command } }, "/usr/bin/gh")).toBeUndefined();
  });

  it("fails closed for untrusted CLI paths, environment overrides and unknown actions/tools", () => {
    const event = { toolName: "exec", params: { command: "gh pr view 84" } };
    for (const cliPath of ["gh", "/fixture/gh;bad", "/fixture/with space/gh"]) {
      expect(wakeReadOnlyLookup(event, cliPath)).toBeUndefined();
    }
    expect(wakeReadOnlyLookup({ ...event, params: { ...event.params, env: {} } }, "/usr/bin/gh")).toBeUndefined();
    expect(wakeReadOnlyLookup({ toolName: "process", params: { action: "kill" } }, "/usr/bin/gh")).toBeUndefined();
    expect(wakeReadOnlyLookup({ toolName: "imajin_warp", params: { action: "send_followup" } }, "/usr/bin/gh")).toBeUndefined();
    expect(wakeReadOnlyLookup({ toolName: "mcp_unknown", params: { action: "read" } }, "/usr/bin/gh")).toBeUndefined();
  });

  it("does not grant unknown subject metadata or a reused batch its predecessor's read permission", () => {
    const router = new WakeDecisionRouter("anthropic/claude-opus-5-5", [], vi.fn(), { wakeReadOnlyLookups: true });
    const sessionKey = "agent:main:warp-events";
    const read = { toolName: "imajin_warp", params: { action: "get_run" } };
    router.track(sessionKey, "unknown");
    expect(router.beforeToolCall(read, { sessionKey })).toMatchObject({ block: true });
    router.untrack("unknown");
    router.track(sessionKey, "failed", { hasPr: true, failedRun: true });
    router.bindRunner("failed", "first-run");
    expect(router.beforeToolCall(read, { sessionKey, runId: "first-run" })?.block).not.toBe(true);
    router.track(sessionKey, "open", { hasPr: true, failedRun: false });
    router.bindRunner("open", "second-run");
    expect(router.beforeToolCall(read, { sessionKey, runId: "second-run" })).toMatchObject({ block: true });
    expect(router.beforeToolCall(read, { sessionKey, runId: "first-run" })?.block).not.toBe(true);
    router.dispose();
  });
});
