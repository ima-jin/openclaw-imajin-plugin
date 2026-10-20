import { afterEach, describe, expect, it, vi } from "vitest";
import { beginRegistration } from "./registration-lifecycle.js";
import { PluginServiceRuntime } from "./plugin-service-runtime.js";

afterEach(() => {
  beginRegistration().dispose();
});

describe("PluginServiceRuntime", () => {
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
