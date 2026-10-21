import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotificationInjector, type WsNotificationsConfig } from "./notification-injector.js";
import { resolveWakeModel } from "./wake-model.js";
import { PendingWakeStore } from "./notification-state-store.js";

const sdk = vi.hoisted(() => ({
  loadModelCatalog: vi.fn(),
  resolveDefaultModelForAgent: vi.fn(),
  resolveAllowedModelRef: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/agent-runtime", () => sdk);
vi.mock("./channel-notify.js", () => ({ sendDirectChannelMessage: vi.fn(async () => {}) }));

const DEFAULT = { provider: "default-provider", model: "gateway-model" };
const WAKE = { provider: "imajin", model: "kimi-k3" };
const CONFIG = Object.freeze({
  agents: Object.freeze({ defaults: Object.freeze({ model: "default-provider/gateway-model" }) }),
});
const frame = (id: string) => ({
  type: "notification" as const, id, scope: "warp.run.completed",
  title: "Completed", body: null, createdAt: "", data: { runId: `run-${id}` },
});
type Post = { sessionKey: string; message: string; model?: string; name: string; idempotencyKey: string };

describe("wakeModel (#117)", () => {
  let dir: string;
  let config: WsNotificationsConfig;
  let posts: Post[];
  let bodies: string[];
  let injector: ReturnType<typeof createNotificationInjector>;
  const modelLogs = () => vi.mocked(console.log).mock.calls
    .map(([text]) => String(text)).filter((text) => text.startsWith("[imajin-ws] wake model="));
  const modelWarnings = () => vi.mocked(console.warn).mock.calls
    .map(([text]) => String(text)).filter((text) => text.includes("wakeModel"));

  beforeEach(async () => {
    vi.resetAllMocks();
    dir = await mkdtemp(join(tmpdir(), "wake-model-"));
    posts = [];
    bodies = [];
    config = {
      injectScopes: ["warp.run.completed"], hookToken: "fixture-only",
      stateDir: dir, wakeSettleMs: 2, wakeCoalesceMs: 50,
    };
    sdk.loadModelCatalog.mockResolvedValue([{ provider: WAKE.provider, id: WAKE.model }]);
    sdk.resolveDefaultModelForAgent.mockReturnValue(DEFAULT);
    sdk.resolveAllowedModelRef.mockReturnValue({ ref: WAKE, key: "imajin/kimi-k3" });
    for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      posts.push(JSON.parse(init.body));
      return { status: 200, json: async () => ({ runId: `admitted-${posts.length}` }), text: async () => "" };
    }));
  });

  afterEach(async () => {
    injector?.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function create() {
    injector = createNotificationInjector({
      config: CONFIG, runtime: { config: { current: () => CONFIG } },
    }, config);
    return injector;
  }

  async function wake(id = "one", count = 1) {
    await injector.inject(frame(id));
    await vi.waitFor(() => expect(posts).toHaveLength(count), { interval: 5 });
  }

  function input(index = 0, model = DEFAULT, prompt = posts[index].message) {
    injector.runtimeHooks.llm_input({
      prompt, runId: `runner-${index}`, provider: model.provider, model: model.model,
    }, { sessionKey: posts[index].sessionKey, runId: `runner-${index}` });
  }

  it("sends the resolved wakeModel only on the wake and never changes defaults or decisionModel", async () => {
    config.wakeModel = "  imajin/kimi-k3  ";
    config.model = "legacy/coordinator";
    create();
    await wake();
    expect(posts[0].model).toBe("imajin/kimi-k3");
    expect(sdk.loadModelCatalog).toHaveBeenCalledWith({ config: CONFIG, agentId: "main", readOnly: true });
    expect(sdk.resolveAllowedModelRef).toHaveBeenCalledWith({
      cfg: CONFIG, agentId: "main", raw: "imajin/kimi-k3",
      catalog: [{ provider: WAKE.provider, id: WAKE.model }],
      defaultProvider: DEFAULT.provider, defaultModel: DEFAULT,
    });
    expect(CONFIG.agents.defaults.model).toBe("default-provider/gateway-model");
    expect(injector.runtimeHooks.before_model_resolve({}, { sessionKey: posts[0].sessionKey })).toBeUndefined();
    const decision = injector.runtimeHooks.before_tool_call({
      toolName: "sessions_spawn", params: { task: "Review evidence" },
    }, { sessionKey: posts[0].sessionKey });
    expect(decision).toMatchObject({ params: { model: "anthropic/claude-opus-5-5" } });
    input(0, WAKE);
    input(0, WAKE);
    expect(modelLogs()).toEqual([
      `[imajin-ws] wake model="imajin/kimi-k3" source=wakeModel batch=${posts[0].idempotencyKey}`,
    ]);
    expect(modelWarnings()).toEqual([]);
  });

  it.each([undefined, "", " \t "])("keeps the old default payload for wakeModel=%j", async (wakeModel) => {
    config.wakeModel = wakeModel;
    create();
    await wake();
    expect(posts[0]).not.toHaveProperty("model");
    expect(Object.keys(posts[0])).toEqual([
      "message", "agentId", "idempotencyKey", "sessionMode", "sessionKey", "deliver", "name",
    ]);
    expect(sdk.loadModelCatalog).not.toHaveBeenCalled();
    expect(sdk.resolveDefaultModelForAgent).not.toHaveBeenCalled();
    input();
    input();
    expect(modelLogs()).toEqual([
      `[imajin-ws] wake model="default-provider/gateway-model" source=default batch=${posts[0].idempotencyKey}`,
    ]);
    expect(modelWarnings()).toEqual([]);
  });

  it("preserves byte-for-byte legacy payloads with an empty override", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    config.model = " legacy/coordinator ";
    create();
    await wake();
    const previousBody = bodies[0];
    input(0, { provider: "legacy", model: "coordinator" });
    expect(modelLogs()[0]).toContain('model="legacy/coordinator" source=model');
    injector.dispose();
    config.stateDir = undefined;
    config.wakeModel = "";
    create();
    await wake("one", 2);
    expect(bodies[1]).toBe(previousBody);
  });

  it.each(["unknown", "disallowed", "catalog-failed", "config-failed", "timeout", "invalid-type"])(
    "warns and sends a default wake when the override is %s, without leaking error details",
    async (failure) => {
      config.wakeModel = "imajin/unavailable";
      config.model = "legacy/coordinator"; // An invalid new override must use default, not this.
      if (failure === "unknown") sdk.loadModelCatalog.mockResolvedValue([]);
      if (failure === "disallowed") sdk.resolveAllowedModelRef.mockReturnValue({ error: "private diagnostics" });
      if (failure === "catalog-failed") sdk.loadModelCatalog.mockRejectedValue(new Error("private diagnostics"));
      if (failure === "config-failed") sdk.resolveDefaultModelForAgent.mockImplementation(() => { throw new Error("private diagnostics"); });
      if (failure === "timeout") sdk.loadModelCatalog.mockReturnValue(new Promise(() => {}));
      if (failure === "invalid-type") config.wakeModel = 42 as unknown as string;
      create();
      await injector.inject(frame("one"));
      await vi.waitFor(() => expect(posts).toHaveLength(1), { interval: 10, timeout: 3_000 });
      expect(posts[0]).not.toHaveProperty("model");
      expect(modelWarnings()).toEqual([
        `[imajin-ws] wakeModel could not be resolved or is not allowed; using gateway default batch=${posts[0].idempotencyKey}`,
      ]);
      input();
      input();
      expect(modelLogs()).toEqual([
        `[imajin-ws] wake model="default-provider/gateway-model" source=default batch=${posts[0].idempotencyKey}`,
      ]);
      expect([...modelWarnings(), ...modelLogs()].join("\n")).not.toContain("private diagnostics");
    },
  );

  it("uses host alias resolution and scopes catalog/policy reads to hookAgentId", async () => {
    config.wakeModel = "wake-alias";
    config.hookAgentId = "worker";
    create();
    await wake();
    expect(posts[0].model).toBe("imajin/kimi-k3");
    expect(sdk.resolveDefaultModelForAgent).toHaveBeenCalledWith({ cfg: CONFIG, agentId: "worker" });
    expect(sdk.loadModelCatalog).toHaveBeenCalledWith({ config: CONFIG, agentId: "worker", readOnly: true });
    expect(sdk.resolveAllowedModelRef).toHaveBeenCalledWith(expect.objectContaining({ raw: "wake-alias", agentId: "worker" }));
  });
  it("records a fast root input before HTTP admission completes, without overriding reports", async () => {
    config.wakeModel = "imajin/kimi-k3";
    config.reportTo = ["agent:main:telegram:direct:123"];
    create();
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const post: Post = JSON.parse(String(init?.body));
      posts.push(post);
      if (post.name === "imajin-wake") input(0, WAKE);
      return { status: 200, json: async () => ({ runId: "admitted-1" }) } as Response;
    });
    await wake();
    expect(modelLogs()).toHaveLength(1);
    const ctx = { sessionKey: posts[0].sessionKey, runId: "runner-0" };
    await injector.runtimeHooks.after_tool_call({
      toolName: "message",
      params: { action: "send", channel: "telegram", target: "123" },
      result: { ok: true },
    }, ctx);
    await injector.onAgentEnd!({
      success: true, runId: ctx.runId,
      messages: [{ role: "user", content: posts[0].message }, { role: "assistant", content: "Reported." }],
    }, ctx);
    expect(posts).toHaveLength(2);
    expect(posts[1].name).toBe("imajin-wake-report");
    expect(posts[1]).not.toHaveProperty("model");
    input(1, DEFAULT);
    expect(modelLogs()).toHaveLength(1);
  });

  it("logs the actual model, not an assumed/requested model, and ignores non-wake/child inputs", async () => {
    config.wakeModel = "imajin/kimi-k3";
    create();
    await wake();
    const ctx = { sessionKey: posts[0].sessionKey, runId: "runner-0" };
    injector.runtimeHooks.llm_input({ provider: "other", model: "other" }, { sessionKey: "agent:main:main" });
    injector.runtimeHooks.subagent_spawned({ childSessionKey: "agent:main:subagent:decision", runId: "child" },
      { requesterSessionKey: ctx.sessionKey });
    injector.runtimeHooks.llm_input({ provider: "anthropic", model: "claude-opus-5-5" },
      { sessionKey: "agent:main:subagent:decision", runId: "child" });
    injector.runtimeHooks.llm_input({ prompt: posts[0].message, runId: ctx.runId }, ctx);
    expect(modelLogs()).toEqual([]);
    input(0, { provider: "actual", model: "actual/model\none-line" });
    expect(modelLogs()).toEqual([
      `[imajin-ws] wake model="actual/model\\none-line" source=wakeModel batch=${posts[0].idempotencyKey}`,
    ]);
  });

  it("applies the override and one log per leading and trailing wake", async () => {
    config.wakeModel = "imajin/kimi-k3";
    create();
    await wake();
    input(0, WAKE);
    await wake("two", 2);
    input(1, WAKE);
    input(1, WAKE);
    expect(posts.map((post) => post.model)).toEqual(["imajin/kimi-k3", "imajin/kimi-k3"]);
    expect(posts[0].idempotencyKey).toMatch(/:leading$/);
    expect(posts[1].idempotencyKey).toMatch(/:trailing$/);
    expect(modelLogs()).toHaveLength(2);
  });

  it("applies wakeModel to a persisted startup replay too", async () => {
    const store = new PendingWakeStore(join(dir, "pending-wakes.json"));
    await store.set("persisted", { scope: "warp.run.completed", sinceTs: Date.now(), frames: [frame("owed")], injected: false });
    config.wakeModel = "imajin/kimi-k3";
    create();
    await injector.ready;
    await vi.waitFor(() => expect(posts).toHaveLength(1), { interval: 5 });
    expect(posts[0].model).toBe("imajin/kimi-k3");
    input(0, WAKE);
    expect(modelLogs()).toHaveLength(1);
  });

  it.each([undefined, "", " "])("does not inspect config on the legacy fast path %j", async (wakeModel) => {
    const getConfig = vi.fn(() => { throw new Error("must not read"); });
    await expect(resolveWakeModel(wakeModel, undefined, "main", getConfig)).resolves.toEqual({ model: undefined, source: "default" });
    expect(getConfig).not.toHaveBeenCalled();
  });

  it("publishes an optional string schema (empty accepted, no default) and README contract", async () => {
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const ws = manifest.configSchema.properties.wsNotifications;
    expect(ws.properties.wakeModel.type).toBe("string");
    expect(ws.properties.wakeModel).not.toHaveProperty("default");
    expect(ws.properties.wakeModel).not.toHaveProperty("minLength");
    expect(ws.required ?? []).not.toContain("wakeModel");
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    for (const text of ["wsNotifications.wakeModel", "imajin/kimi-k3", "source=wakeModel|default|model", "warn"]) {
      expect(readme).toContain(text);
    }
  });
});
