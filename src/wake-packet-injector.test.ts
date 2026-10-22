import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationInjector, type WsNotificationsConfig } from "./notification-injector.js";
import { sendDirectChannelMessage } from "./channel-notify.js";
import { LIGHT_WAKE_BOOTSTRAP, MAX_WAKE_FIRST_TURN_BYTES } from "./wake-packet.js";
import type { NotificationFrame } from "./ws-service.js";

vi.mock("./channel-notify.js", () => ({ sendDirectChannelMessage: vi.fn(async () => {}) }));
const builder = fileURLToPath(new URL("./fixtures/wake-packet-builder.mjs", import.meta.url));
const command = (mode = "packet") => [process.execPath, builder, mode];
const frame = (runId = "run-a"): NotificationFrame => ({
  type: "notification", id: `notification-${runId}`, scope: "warp.run.completed",
  title: "Fixture SUCCEEDED", body: null, createdAt: "",
  data: {
    runId, state: "SUCCEEDED", title: "Fixture", runTime: "10s",
    artifacts: [{ type: "pull_request", url: "https://github.com/fixture/repo/pull/107", branch: "feat/fixture" }],
  },
});

describe("packet wake path (#107)", () => {
  let injector: ReturnType<typeof createNotificationInjector>;
  let config: WsNotificationsConfig;
  let api: any;
  let posts: Array<{ sessionKey: string; message: string; name: string }>;
  let lookup: ReturnType<typeof vi.fn>;
  let horizon: { readOpenItems: ReturnType<typeof vi.fn>; writeStepEvents: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    posts = [];
    for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
    vi.mocked(sendDirectChannelMessage).mockReset().mockResolvedValue();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body));
      return { status: 200, json: async () => ({ runId: "hook-run" }) };
    }));
    api = { registerHook: vi.fn(), config: {}, runtime: { config: { current: () => ({}) }, system: { enqueueSystemEvent: vi.fn() } } };
    config = {
      injectScopes: ["warp.run.completed"], hookToken: "fixture-only",
      wakeSettleMs: 5, wakeCoalesceMs: 5, stateDir: await mkdtemp(join(tmpdir(), "packet-wake-")),
      directSend: { channel: "fixture", target: "operator" },
      reportTo: ["agent:main:fixture:direct:operator"],
      wakePacket: { command: command() }, horizonEnabled: true,
    };
    lookup = vi.fn(async () => { throw new Error("unexpected duplicate live read"); });
    horizon = { readOpenItems: vi.fn(async () => []), writeStepEvents: vi.fn(async () => {}) };
  });
  afterEach(() => {
    injector?.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function wake(overrides: Partial<WsNotificationsConfig> = {}) {
    injector = createNotificationInjector(api, { ...config, ...overrides }, {
      liveStateLookup: lookup, horizon, sessionTokens: async () => 0, abortWake: async () => {},
    });
    await injector.ready;
    await injector.inject(frame());
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    return { sessionKey: posts[0].sessionKey, runId: "hook-run" };
  }
  function bootstrap(sessionKey: string) {
    const event = {
      type: "agent", action: "bootstrap", sessionKey,
      context: { workspaceDir: "/fixture/operator-workspace", bootstrapFiles: [
        { name: "AGENTS.md", path: "/fixture/operator-workspace/AGENTS.md", content: "x".repeat(54_000), missing: false },
      ] },
    };
    injector.runtimeHooks["agent:bootstrap"](event);
    return event.context.bootstrapFiles;
  }

  it("starts from the packet with event evidence, avoids duplicate reads, and reports provenance", async () => {
    const ctx = await wake({ sessionPerWake: false, wakePacket: { command: command("sample-size") } });
    const message = posts[0].message;
    for (const evidence of ["runId: run-a", "state: SUCCEEDED", "title: Fixture", "runTime: 10s",
      "pull_request https://github.com/fixture/repo/pull/107 (feat/fixture)", "notificationId: notification-run-a"]) {
      expect(message).toContain(evidence);
    }
    expect(message.indexOf("notificationId:")).toBeLessThan(message.indexOf("# Wake packet"));
    expect(message).toContain("PR state:");
    expect(message).toContain("Sonar:");
    expect(lookup).not.toHaveBeenCalled();
    expect(horizon.readOpenItems).not.toHaveBeenCalled();
    expect(api.runtime.system.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(ctx.sessionKey).not.toBe("agent:main:warp-events");
    const files = bootstrap(ctx.sessionKey);
    expect(files).toEqual([{
      name: "AGENTS.md", path: "/fixture/operator-workspace/AGENTS.md", missing: false, content: LIGHT_WAKE_BOOTSTRAP,
    }]);
    const firstTurnBytes = Buffer.byteLength(files[0].content + message);
    expect(firstTurnBytes).toBeLessThan(MAX_WAKE_FIRST_TURN_BYTES);
    expect(firstTurnBytes).toBeLessThan(54_000 / 2);
    injector.runtimeHooks.llm_input({ prompt: message, systemPrompt: files[0].content, runId: ctx.runId }, ctx);
    injector.runtimeHooks.before_message_write({
      message: { role: "assistant", usage: { input: 100, cacheRead: 20, cacheWrite: 3, output: 40 } },
    }, ctx);
    // Later calls, aggregated usage and unrelated sessions cannot overwrite the first call.
    injector.runtimeHooks.before_message_write({ message: { role: "assistant", usage: { input: 999 } } }, ctx);
    injector.runtimeHooks.llm_input({ prompt: "later", systemPrompt: "later" }, ctx);
    await injector.runtimeHooks.llm_output({ usage: { input: 9999 } }, ctx);
    await injector.reportWake(ctx, { outcome: "completed", message: "PR state/checks/Sonar consumed from packet; no gaps." });
    await injector.onAgentEnd?.({
      success: true, messages: [{ role: "assistant", content: "Packet review complete", usage: { input: 600, output: 40 } }],
    }, ctx);
    expect(sendDirectChannelMessage).toHaveBeenCalledWith(expect.anything(),
      expect.stringContaining("Started from script-built packet"), api);
    expect(posts[1].message).toContain("Started from script-built packet");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(
      `bootstrapBytes=${Buffer.byteLength(LIGHT_WAKE_BOOTSTRAP)} firstTurnBytes=${firstTurnBytes} firstTurnInputTokens=123 packetSource=packet`,
    ));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("packetBytes=12700"));
    expect(horizon.writeStepEvents).toHaveBeenCalledOnce();
    expect(bootstrap(ctx.sessionKey)[0].content).toHaveLength(54_000);
  });
  it("logs unavailable first-turn metrics on timeout rather than estimating them or suppressing disclosure", async () => {
    await wake({ wakePacket: { command: command("fail") }, wakeTimeoutMs: 50 });
    await vi.waitFor(() => expect(console.log).toHaveBeenCalledWith(expect.stringMatching(
      /wake ended .*packetBytes=0 bootstrapBytes=unavailable firstTurnBytes=unavailable firstTurnInputTokens=unavailable packetSource=evidence-only.*reason=timeout/,
    )));
    expect(sendDirectChannelMessage).toHaveBeenCalledWith(expect.anything(),
      expect.stringContaining("GAP: packet unavailable (nonzero exit)"), api);
  });

  it("cancels an active packet builder on disposal without posting a late wake", async () => {
    injector = createNotificationInjector(api, {
      ...config, wakePacket: { command: command("timeout"), timeoutMs: 5000 },
    });
    await injector.ready;
    await injector.inject(frame());
    await new Promise((resolve) => setTimeout(resolve, 30));
    injector.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(posts).toEqual([]);
  });

  it("passes packet evidence and the no-refetch rule to delegated decision work", async () => {
    const ctx = await wake({ wakeReadOnlyLookups: true });
    const duplicateRead = injector.runtimeHooks.before_tool_call({
      toolName: "exec", params: { command: "/usr/bin/gh pr view 107 --json state" },
    }, ctx) as { block: boolean };
    expect(duplicateRead.block).toBe(true);
    const delegated = injector.runtimeHooks.before_tool_call({
      toolName: "sessions_spawn", params: { task: "Review the supplied state" },
    }, ctx) as { params: { task: string } };
    expect(delegated.params.task).toContain(posts[0].message);
    expect(delegated.params.task).toContain("Do not re-fetch a supplied section");
    injector.runtimeHooks.subagent_spawned({ childSessionKey: "agent:main:subagent:fixture", runId: "child" },
      { requesterSessionKey: ctx.sessionKey });
    const policy = injector.runtimeHooks.before_prompt_build({}, { sessionKey: "agent:main:subagent:fixture", runId: "child" }) as { appendSystemContext: string };
    expect(policy.appendSystemContext).toContain("unless that section has a GAP:");
    expect(bootstrap("agent:main:subagent:fixture")[0].content).toHaveLength(54_000);
  });

  it.each([["fail", "nonzero exit"], ["timeout", "timeout"], ["overflow", "maxBytes exceeded"]])(
    "%s admits the evidence-only wake, discloses the gap immediately and includes it in its outcome", async (mode, reason) => {
      const ctx = await wake({ wakePacket: { command: command(mode), timeoutMs: mode === "timeout" ? 250 : 5000 } });
      const gap = `GAP: packet unavailable (${reason})`;
      expect(posts[0].message).toContain("runId: run-a");
      expect(posts[0].message.match(/GAP: packet unavailable/g)).toHaveLength(1);
      expect(posts[0].message).toContain(gap);
      expect(posts[0].message).not.toContain("# Wake packet");
      expect(bootstrap(ctx.sessionKey)[0].content).toBe(LIGHT_WAKE_BOOTSTRAP);
      expect(sendDirectChannelMessage).toHaveBeenCalledWith(expect.anything(), gap, api);
      await injector.reportWake(ctx, { outcome: "blocked", message: "Missing packet; event retained." });
      await injector.onAgentEnd?.({ success: true, messages: [{ role: "assistant", content: "Blocked" }] }, ctx);
      expect(posts[1].message).toContain(gap);
      expect(JSON.stringify(posts)).not.toContain("fixture-private-diagnostic");
    },
  );

  it.each(["unregistered", "disabled"])("names a %s bootstrap hook gap instead of pretending the workspace was reduced", async (mode) => {
    if (mode === "unregistered") delete api.registerHook;
    else api.config = { hooks: { internal: { enabled: false } } };
    await wake();
    expect(posts[0].message).toContain("GAP: packet unavailable (bootstrap hook unavailable)");
  });

  it("does not alter normal sessions, report recipients, or unadmitted wake-like keys", async () => {
    const ctx = await wake();
    for (const key of ["agent:main:normal", config.reportTo![0], "agent:main:warp-events:untracked"]) {
      expect(bootstrap(key)[0].content).toHaveLength(54_000);
    }
    const wrongEvent = { type: "command", action: "bootstrap", sessionKey: ctx.sessionKey, context: { bootstrapFiles: [] } };
    injector.runtimeHooks["agent:bootstrap"](wrongEvent);
    expect(wrongEvent.context.bootstrapFiles).toEqual([]);
    expect(() => injector.runtimeHooks["agent:bootstrap"]({ type: "agent", action: "bootstrap" })).not.toThrow();
  });

  it("preserves the existing non-packet wake path when the feature is omitted", async () => {
    lookup.mockResolvedValue({ state: "OPEN", mergeable: "UNKNOWN" });
    const ctx = await wake({ wakePacket: undefined });
    expect(lookup).toHaveBeenCalledOnce();
    expect(horizon.readOpenItems).toHaveBeenCalledOnce();
    expect(posts[0].message).not.toContain("# Wake packet");
    expect(bootstrap(ctx.sessionKey)[0].content).toHaveLength(54_000);
  });
});
