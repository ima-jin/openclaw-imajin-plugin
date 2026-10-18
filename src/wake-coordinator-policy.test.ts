import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotificationInjector, type WsNotificationsConfig } from "./notification-injector.js";
import type { NotificationFrame } from "./ws-service.js";

vi.mock("./channel-notify.js", () => ({ sendDirectChannelMessage: vi.fn(async () => {}) }));
const PR = "https://github.com/ima-jin/openclaw-imajin-plugin/pull/84";
const LIVE = { state: "OPEN", isDraft: false, headRefOid: "a".repeat(40), mergeable: "MERGEABLE",
  reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [] };
type PolicyConfig = WsNotificationsConfig & { wakeReadOnlyLookups?: boolean };

describe("option c: enforced wake coordinator boundary", () => {
  let directory: string;
  let config: PolicyConfig;
  let injector: ReturnType<typeof createNotificationInjector>;
  let posts: Array<{ name: string; sessionKey: string; message: string }>;
  const ctx = () => ({ sessionKey: posts[0].sessionKey, runId: "wake-runner" });
  const tool = (toolName: string, params: Record<string, unknown>) =>
    injector.runtimeHooks.before_tool_call({ toolName, params }, ctx()) as
      { block?: boolean; params?: Record<string, unknown> } | undefined;
  const frame = (id: string, pr: boolean, state: string, scope = "warp.run.completed"): NotificationFrame => ({
    type: "notification", id, scope, title: "Wake subject", body: null, createdAt: "",
    data: { runId: id, state, ...(pr ? { expectedPr: PR } : {}) },
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "wake-coordinator-policy-"));
    config = { targetSession: "agent:main:warp-events", hookToken: "fixture-only",
      injectScopes: ["warp.run.completed", "warp.run.failed"], wakeSettleMs: 10, wakeCoalesceMs: 2,
      stateDir: directory, directSend: { target: "123" } };
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: { body: string }) => {
      posts.push(JSON.parse(options.body));
      return { status: 200, json: async () => ({ runId: "admission" }) };
    }));
    for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(async () => {
    injector?.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  async function start(frames: NotificationFrame[], live = LIVE) {
    injector = createNotificationInjector({ runtime: { config: { current: () => ({}) } } }, config, {
      liveStateLookup: async () => live, abortWake: async () => {},
    });
    for (const event of frames) await injector.inject(event);
    await vi.waitFor(() => expect(posts).toHaveLength(1), { interval: 5 });
    injector.runtimeHooks.llm_input({ prompt: posts[0].message, runId: ctx().runId }, ctx());
  }

  it("publishes a default-false lookup switch in the config schema", async () => {
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(manifest.configSchema.properties.wsNotifications.properties.wakeReadOnlyLookups)
      .toMatchObject({ type: "boolean", default: false });
  });

  it.each([false, true])("never lets the wake model approve, merge, review, enqueue or dispatch (lookups=%s)", async (enabled) => {
    config.wakeReadOnlyLookups = enabled;
    await start([frame("open-pr", true, "SUCCEEDED")]);
    expect(posts[0].message).toContain("CHANGES_REQUESTED");
    for (const command of ["gh pr review 84 --approve", "gh pr merge 84 --squash", "gh pr review 84"]) {
      expect(tool("exec", { command })).toMatchObject({ block: true });
    }
    for (const toolName of ["approve_pull_request", "merge_pull_request", "enqueue", "dispatch"]) {
      expect(tool(toolName, { action: "approve" })).toMatchObject({ block: true });
    }
    expect(tool("imajin_warp", { action: "dispatch", prompt: "ship it" })).toMatchObject({ block: true });
    expect(tool("exec", { command: "gh pr view 84 --json state" })).toMatchObject({ block: true });
  });

  it.each([false, true])("keeps reads disabled by default, including FAILED=%s", async (failed) => {
    await start([frame("default", false, failed ? "FAILED" : "SUCCEEDED")]);
    expect(tool("imajin_warp", { action: "get_run", runId: "default" })).toMatchObject({ block: true });
  });

  it.each([
    { pr: false, state: "SUCCEEDED" },
    { pr: false, state: "FAILED" },
    { pr: true, state: "FAILED" },
  ])("allows opted-in safe lookups only for eligible subjects: %j", async ({ pr, state }) => {
    config.wakeReadOnlyLookups = true;
    await start([frame("eligible", pr, state)]);
    expect(tool("imajin_warp", { action: "get_run", runId: "eligible" })?.block).not.toBe(true);
    expect(tool("read", { path: "/fixture/build.log" })?.block).not.toBe(true);
    expect(tool("exec", { command: "gh pr view 84 --json state,mergeable" })).toMatchObject({
      params: { command: "/usr/bin/gh pr view 84 --json state,mergeable" },
    });
    const prompt = injector.runtimeHooks.before_prompt_build({}, ctx()) as { toolsAllow: string[] };
    expect(prompt.toolsAllow).toContain("exec");
    expect(tool("exec", { command: "gh pr merge 84" })).toMatchObject({ block: true });
    expect(tool("imajin_warp", { action: "dispatch" })).toMatchObject({ block: true });
    for (const toolName of ["approve_pull_request", "merge_pull_request", "enqueue"]) {
      expect(tool(toolName, { action: "approve" })).toMatchObject({ block: true });
    }
  });

  it("uses FAILED scope evidence when state is unavailable", async () => {
    config.wakeReadOnlyLookups = true;
    await start([frame("failed-scope", true, "", "warp.run.failed")]);
    expect(tool("imajin_warp", { action: "get_run", runId: "failed-scope" })?.block).not.toBe(true);
  });

  it("does not loosen a successful open-PR wake because a coalesced different run failed", async () => {
    config.wakeReadOnlyLookups = true;
    config.wakeSettleMs = 100;
    await start([frame("green-pr", true, "SUCCEEDED"), frame("other-failed", false, "FAILED")]);
    expect(tool("exec", { command: "gh pr view 84 --json state" })).toMatchObject({ block: true });
  });

  it("does not treat an unavailable known PR as no PR", async () => {
    config.wakeReadOnlyLookups = true;
    await start([frame("unknown-pr", true, "SUCCEEDED")], { ...LIVE, state: "UNAVAILABLE" });
    expect(tool("read", { path: "/fixture/build.log" })).toMatchObject({ block: true });
  });

  it("does not let the lookup exception execute shell payloads or gh mutation verbs", async () => {
    config.wakeReadOnlyLookups = true;
    await start([frame("failed", false, "FAILED")]);
    for (const command of [
      "gh pr view 84; gh pr merge 84", "gh pr view 84 && gh pr review 84 --approve",
      "gh pr view $(gh pr merge 84)", "gh api repos/ima-jin/repo/pulls/84/reviews --method POST",
      "gh pr view 84 > /fixture/output", "gh pr view 84 --web", "gh extension exec approve",
    ]) expect(tool("exec", { command })).toMatchObject({ block: true });
    expect(tool("exec", { command: "gh pr view 84", env: { BASH_ENV: "/fixture/startup" } }))
      .toMatchObject({ block: true });
  });

  it("hands decisions to a model-pinned subagent while preserving the coordinator's independent model", async () => {
    config.model = "imajin/kimi-k3";
    config.decisionModel = "anthropic/claude-opus-5-5";
    await start([frame("handoff", true, "SUCCEEDED")]);
    const spawn = tool("sessions_spawn", { task: "review, approve, merge, enqueue and dispatch", model: "cheap" });
    expect(spawn?.params).toMatchObject({ runtime: "subagent", model: "anthropic/claude-opus-5-5" });
    const child = { sessionKey: "agent:main:subagent:decision", runId: "decision-run" };
    expect(injector.runtimeHooks.before_model_resolve({ prompt: spawn?.params?.task }, child))
      .toEqual({ providerOverride: "anthropic", modelOverride: "claude-opus-5-5" });
    expect(injector.runtimeHooks.before_tool_call({ toolName: "exec", params: { command: "gh pr merge 84" } }, child))
      .toBeUndefined();
    expect(tool("exec", { command: "gh pr merge 84" })).toMatchObject({ block: true });
  });
});
