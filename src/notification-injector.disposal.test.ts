import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotificationInjector, type WsNotificationsConfig } from "./notification-injector.js";
import { PendingWakeStore } from "./notification-state-store.js";
import { WakeBridgeStore } from "./wake-bridge.js";
import type { NotificationFrame } from "./ws-service.js";

const io = vi.hoisted(() => ({
  gate: undefined as undefined | {
    matches: (file: string, content: string) => boolean;
    entered: () => void;
    wait: Promise<void>;
  },
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      const gate = io.gate;
      if (gate?.matches(String(args[0]), String(args[1]))) {
        gate.entered();
        await gate.wait;
      }
      return fs.writeFile(...args);
    },
  };
});
vi.mock("./channel-notify.js", () => ({ sendDirectChannelMessage: vi.fn(async () => {}) }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const frame = (id: string): NotificationFrame => ({
  type: "notification", id, scope: "warp.run.completed", title: "Completed", body: null, createdAt: "",
  data: { runId: id, expectedPr: "https://github.com/ima-jin/openclaw-imajin-plugin/pull/84" },
});

describe("notification injector disposal drain (#120)", () => {
  let directory: string;
  let config: WsNotificationsConfig;
  const injectors: Array<ReturnType<typeof createNotificationInjector>> = [];
  const releases: Array<() => void> = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "injector-disposal-"));
    config = {
      stateDir: directory, injectScopes: ["warp.run.completed"], hookToken: "fixture-only",
      wakeSettleMs: 10, wakeCoalesceMs: 10,
    };
    for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, json: async () => ({ runId: "admission" }) })));
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    for (const injector of injectors.splice(0)) await injector.dispose();
    io.gate = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  function create(deps: Parameters<typeof createNotificationInjector>[2] = {}) {
    const injector = createNotificationInjector({ runtime: { config: { current: () => ({}) } } }, config, {
      liveStateLookup: async () => ({ state: "MERGED" }), ...deps,
    });
    injectors.push(injector);
    return injector;
  }

  function gateWrite(matches: NonNullable<typeof io.gate>["matches"]) {
    const entered = deferred();
    const release = deferred();
    releases.push(release.resolve);
    io.gate = { matches, entered: entered.resolve, wait: release.promise };
    return { entered: entered.promise, release: release.resolve };
  }

  async function expectWaiting(task: Promise<void>) {
    const done = vi.fn();
    void task.then(done);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(done).not.toHaveBeenCalled();
  }

  it.each(["pending", "bridge"])("does not resolve before the %s write lands on disk", async (store) => {
    const gate = gateWrite((file, content) => store === "pending"
      ? file.includes("pending-wakes.json.") && content === '{"wakes":{}}'
      : file.includes("wake-bridge.json.") && content.includes('"status":"closed"'));
    const injector = create();
    await injector.inject(frame("terminal"));
    await gate.entered;

    const disposing = injector.dispose();
    expect(injector.dispose()).toBe(disposing);
    await expectWaiting(disposing);
    gate.release();
    await disposing;

    expect(JSON.parse(await readFile(join(directory, "pending-wakes.json"), "utf8")).wakes).toEqual({});
    expect(JSON.parse(await readFile(join(directory, "wake-bridge.json"), "utf8")).records)
      .toContainEqual(expect.objectContaining({ runId: "terminal", status: "closed" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("waits for a wake turn that has not yet queued its persistence writes", async () => {
    const entered = deferred();
    const release = deferred();
    releases.push(release.resolve);
    const injector = create({ liveStateLookup: async () => {
      entered.resolve();
      await release.promise;
      return { state: "MERGED" };
    } });
    await injector.inject(frame("queued"));
    await entered.promise;
    const disposing = injector.dispose();
    await expectWaiting(disposing);
    release.resolve();
    await disposing;
    // Main cancels dispatch after a lookup returns to an aborted injector.
    // Drain that lookup, but retain the owed evidence for startup replay.
    const wakes = JSON.parse(await readFile(join(directory, "pending-wakes.json"), "utf8")).wakes;
    expect(Object.values(wakes)).toEqual([expect.objectContaining({ frames: [frame("queued")] })]);
    const records = JSON.parse(await readFile(join(directory, "wake-bridge.json"), "utf8")).records;
    expect(records).toContainEqual(expect.objectContaining({ runId: "queued", status: "open" }));
    expect(await readFile(join(directory, "wake-bridge.json"), "utf8")).not.toContain("already MERGED");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("waits for startup state work when disposed before ready", async () => {
    const gate = gateWrite((file) => file.includes("wake-bridge.json."));
    const injector = create();
    const disposing = injector.dispose();
    await gate.entered;
    await expectWaiting(disposing);
    gate.release();
    await disposing;
    expect(JSON.parse(await readFile(join(directory, "wake-bridge.json"), "utf8")).records).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drains an injection in progress, then ignores new injections after disposal", async () => {
    const gate = gateWrite((file) => file.endsWith("notification-ack-dedup.json"));
    const injector = create();
    const injecting = injector.inject(frame("in-flight"));
    await gate.entered;
    const disposing = injector.dispose();
    await expectWaiting(disposing);
    gate.release();
    await Promise.all([injecting, disposing]);
    expect(JSON.parse(await readFile(join(directory, "notification-ack-dedup.json"), "utf8")).ids)
      .toEqual(["in-flight"]);
    await injector.inject(frame("too-late"));
    expect(await readFile(join(directory, "wake-bridge.json"), "utf8")).not.toContain("too-late");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["pending", "bridge"])("exposes a drain for fire-and-forget %s store writes", async (kind) => {
    const gate = gateWrite((file) => file.includes(`${kind === "pending" ? "pending-wakes" : "wake-bridge"}.json.`));
    const store = kind === "pending"
      ? new PendingWakeStore(join(directory, "pending-wakes.json"))
      : new WakeBridgeStore(join(directory, "wake-bridge.json"));
    const writing = store instanceof PendingWakeStore
      ? store.set("owed", { scope: "warp.run.completed", sinceTs: Date.now(), frames: [frame("stored")] })
      : store.ingest([frame("stored")]);
    await gate.entered;
    const draining = store.drain();
    await expectWaiting(draining);
    gate.release();
    await Promise.all([writing, draining]);
    const file = kind === "pending" ? "pending-wakes.json" : "wake-bridge.json";
    expect(await readFile(join(directory, file), "utf8")).toContain("stored");
  });
});
