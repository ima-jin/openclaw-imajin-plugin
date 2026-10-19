import { afterEach, describe, expect, it, vi } from "vitest";
import { beginRegistration, RegistrationLifecycle } from "./registration-lifecycle.js";

afterEach(() => {
  beginRegistration().dispose();
  vi.restoreAllMocks();
});

describe("RegistrationLifecycle", () => {
  it("aborts before cleaning up resources in reverse ownership order", () => {
    const lifecycle = new RegistrationLifecycle();
    const order: string[] = [];
    lifecycle.signal.addEventListener("abort", () => order.push("abort"));
    lifecycle.add(() => {
      expect(lifecycle.active).toBe(false);
      order.push("first");
    });
    lifecycle.add(() => order.push("second"));

    expect(lifecycle.active).toBe(true);
    lifecycle.dispose();

    expect(order).toEqual(["abort", "second", "first"]);
    expect(lifecycle.signal.aborted).toBe(true);
  });

  it("disposes each resource once even when cleanup re-enters dispose", () => {
    const lifecycle = new RegistrationLifecycle();
    const cleanup = vi.fn(() => lifecycle.dispose());
    lifecycle.add(cleanup);

    lifecycle.dispose();
    lifecycle.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("immediately cleans up resources acquired after retirement", () => {
    const lifecycle = new RegistrationLifecycle();
    lifecycle.dispose();
    const cleanup = vi.fn();

    lifecycle.add(cleanup);
    lifecycle.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("continues cleanup after a disposer throws, including late disposers", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const lifecycle = new RegistrationLifecycle();
    const cleanup = vi.fn();
    lifecycle.add(cleanup);
    lifecycle.add(() => {
      throw new Error("cleanup failed");
    });

    expect(() => lifecycle.dispose()).not.toThrow();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(() => lifecycle.add(() => {
      throw new Error("late cleanup failed");
    })).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe("process registration ownership", () => {
  it("retires the previous registration before returning its replacement", () => {
    const first = beginRegistration();
    const firstCleanup = vi.fn();
    first.add(firstCleanup);
    const second = beginRegistration();
    const secondCleanup = vi.fn();
    second.add(secondCleanup);
    const third = beginRegistration();

    expect(first.active).toBe(false);
    expect(second.active).toBe(false);
    expect(third.active).toBe(true);
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(secondCleanup).toHaveBeenCalledTimes(1);

    first.dispose();
    second.dispose();
    expect(third.active).toBe(true);
  });

  it("preserves process ownership when the lifecycle module is re-imported", async () => {
    const previous = beginRegistration();
    const cleanup = vi.fn();
    previous.add(cleanup);
    vi.resetModules();
    const reimported = await import("./registration-lifecycle.js");

    const replacement = reimported.beginRegistration();

    expect(previous.active).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(replacement.active).toBe(true);
    previous.dispose();
    expect(replacement.active).toBe(true);
  });
});
