import { afterEach, describe, expect, it, vi } from "vitest";
import { beginRegistration } from "./registration-lifecycle.js";
import { PluginServiceRuntime } from "./plugin-service-runtime.js";

afterEach(() => {
  beginRegistration().dispose();
});

describe("PluginServiceRuntime", () => {
  it("registers session bootstrap through internal hooks, forwarding only to the active runtime", async () => {
    const api = { on: vi.fn(), registerHook: vi.fn() };
    const handler = vi.fn();
    const runtime = new PluginServiceRuntime("full", async (_lifecycle, on) => {
      on("agent:bootstrap", handler, { name: "bootstrap" });
    });
    runtime.registerHook(api, "agent:bootstrap", "bootstrap");
    expect(api.on).not.toHaveBeenCalled();
    expect(api.registerHook).toHaveBeenCalledWith("agent:bootstrap", expect.any(Function), { name: "bootstrap" });
    const proxy = api.registerHook.mock.calls[0][1];
    const event = { context: { bootstrapFiles: [] } };
    proxy(event);
    expect(handler).not.toHaveBeenCalled();
    await runtime.start();
    proxy(event);
    proxy(event);
    expect(handler).toHaveBeenCalledOnce();
    runtime.stop();
    proxy({});
    expect(handler).toHaveBeenCalledOnce();
    const metadata = new PluginServiceRuntime("discovery", async () => {});
    api.registerHook.mockClear();
    metadata.registerHook(api, "agent:bootstrap", "bootstrap");
    expect(api.registerHook).not.toHaveBeenCalled();
  });
  it("defers ownership and preserves hook return values from the started owner", async () => {
    const previous = beginRegistration();
    const api = { on: vi.fn() };
    const handler = vi.fn(() => ({ modelOverride: "test-model" }));
    const setup = vi.fn(async (_lifecycle, on) => {
      on("before_model_resolve", handler, { name: "model" });
    });
    const runtime = new PluginServiceRuntime("full", setup);
    runtime.registerHook(api, "before_model_resolve", "model");
    const proxy = api.on.mock.calls[0][1];
    expect(proxy({})).toBeUndefined();
    expect(previous.active).toBe(true);
    expect(setup).not.toHaveBeenCalled();
    const starting = runtime.start();
    expect(runtime.start()).toBe(starting);
    await starting;
    expect(previous.active).toBe(false);
    expect(proxy({})).toEqual({ modelOverride: "test-model" });
    expect(setup).toHaveBeenCalledOnce();
    runtime.stop();
    expect(proxy({})).toBeUndefined();
  });

  it("disposes partial setup when startup fails", async () => {
    const cleanup = vi.fn();
    const runtime = new PluginServiceRuntime("full", async (lifecycle) => {
      lifecycle.add(cleanup);
      throw new Error("setup failed");
    });
    await expect(runtime.start()).rejects.toThrow("setup failed");
    runtime.stop();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("guards the deferred wake tool before start and after stop", async () => {
    const sender = vi.fn(async () => {});
    const runtime = new PluginServiceRuntime("full", async () => {
      runtime.setWakeSender(sender);
    });
    const disclosure = { outcome: "completed" as const, message: "Test complete" };
    await expect(runtime.reportWake({}, disclosure)).rejects.toThrow("not started");
    await runtime.start();
    await runtime.reportWake({}, disclosure);
    expect(sender).toHaveBeenCalledWith({}, disclosure);
    runtime.stop();
    await expect(runtime.reportWake({}, disclosure)).rejects.toThrow("not started");
    expect(sender).toHaveBeenCalledOnce();
  });

  it("routes hooks from a registry that never started to the started owner (#92)", async () => {
    const handler = vi.fn(() => ({ block: true, blockReason: "delegate" }));
    const owner = new PluginServiceRuntime("full", async (_lifecycle, on) => {
      on("before_tool_call", handler, { name: "imajin-wake:before_tool_call" });
    });
    const ownerApi = { on: vi.fn() };
    owner.registerHook(ownerApi, "before_tool_call", "imajin-wake:before_tool_call");
    await owner.start();

    // Later full-mode registries (config reloads) register hooks but are never started.
    const reloads = [1, 2, 3].map(() => {
      const api = { on: vi.fn() };
      new PluginServiceRuntime("full", async () => {}).registerHook(api, "before_tool_call", "imajin-wake:before_tool_call");
      return api.on.mock.calls[0][1];
    });
    const latest = reloads.at(-1)!;
    const event = { toolName: "exec", params: { command: "gh pr review 1 --approve" } };
    expect(latest(event, { sessionKey: "agent:main:warp-events:abc" })).toEqual({ block: true, blockReason: "delegate" });
    expect(handler).toHaveBeenCalledOnce();

    // If the host ever dispatches the same event through several registrations, handle it once.
    expect(ownerApi.on.mock.calls[0][1](event, {})).toBeUndefined();
    expect(reloads[0](event, {})).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();

    owner.stop();
    expect(latest({ toolName: "exec", params: {} }, {})).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("routes the wake report tool from any registration to the started owner (#92)", async () => {
    const sender = vi.fn(async () => {});
    const owner = new PluginServiceRuntime("full", async () => {
      owner.setWakeSender(sender);
    });
    const reload = new PluginServiceRuntime("full", async () => {});
    const disclosure = { outcome: "completed" as const, message: "Done" };
    await expect(reload.reportWake({}, disclosure)).rejects.toThrow("not started");
    await owner.start();
    await reload.reportWake({ sessionKey: "agent:main:warp-events:abc" }, disclosure);
    expect(sender).toHaveBeenCalledWith({ sessionKey: "agent:main:warp-events:abc" }, disclosure);
    owner.stop();
    await expect(reload.reportWake({}, disclosure)).rejects.toThrow("not started");
  });

  it("cannot revive a retired service or dispose a replacement from a stale stop", async () => {
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    const first = new PluginServiceRuntime("full", async (lifecycle) => lifecycle.add(firstCleanup));
    const second = new PluginServiceRuntime("full", async (lifecycle) => lifecycle.add(secondCleanup));
    await first.start();
    await second.start();
    first.stop();
    await first.start();
    expect(firstCleanup).toHaveBeenCalledOnce();
    expect(secondCleanup).not.toHaveBeenCalled();
    second.stop();
    expect(secondCleanup).toHaveBeenCalledOnce();
  });
});
