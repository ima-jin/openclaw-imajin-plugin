import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotificationInjector, DEFAULT_WAKE_OWED_MAX_AGE_MS, type WsNotificationsConfig } from "./notification-injector.js";
import { sendDirectChannelMessage } from "./channel-notify.js";
import { DEFAULT_WAKE_TIMEOUT_MS, MAX_WAKE_TIMEOUT_MS, deriveWakeSessionKey, wakeEventTokens, WakeSupervisor } from "./wake-supervisor.js";
import { buildWakeOutcome } from "./wake-outcome.js";
import { extractWakeBatchId } from "./wake-report.js";
import { PendingWakeStore } from "./notification-state-store.js";
import type { NotificationFrame } from "./ws-service.js";
import type { AgentEndEvent } from "./turn-usage-attestation.js";

vi.mock("./channel-notify.js", () => ({ sendDirectChannelMessage: vi.fn(async () => {}) }));

const BASE = "agent:main:warp-events";
const directSend = { channel: "fixture-channel", target: "fixture-recipient", cliPath: "/fixture/cli" };
const frame = (id: string): NotificationFrame => ({
  type: "notification", id: `notification-${id}`, scope: "warp.run.completed",
  title: `Run ${id} SUCCEEDED`, body: null, createdAt: "",
  data: { runId: id, issue: "fixture/issue/79", expectedPr: "fixture/pr/80" },
});

describe("wake completion watchdog", () => {
  const supervisors: WakeSupervisor[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function track(timeoutMs?: number) {
    const alert = vi.fn(async () => {});
    const complete = vi.fn(async () => {});
    const abort = vi.fn(async () => {});
    const sessionTokens = vi.fn(async (): Promise<number | undefined> => 0);
    const supervisor = new WakeSupervisor({ timeoutMs, alert, abort, complete, sessionTokens });
    supervisors.push(supervisor);
    supervisor.track({ batchId: "batch", sessionKey: BASE, scope: "scope", runs: [], uniqueSession: true });
    return { supervisor, alert, abort, complete, sessionTokens };
  }

  it.each([42_123, undefined, "throws"] as const)("logs timeout tokens from metadata (%s) without disclosing reader errors", async (tokens) => {
    const { sessionTokens, abort, alert } = track(10);
    sessionTokens.mockImplementation(async () => {
      if (tokens === "throws") throw new Error("private metadata details");
      return tokens;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      `[imajin-ws] wake ended batch=batch sessionTokens=${typeof tokens === "number" ? tokens : "unavailable"} reason=timeout`,
    );
    expect(abort).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("aborts and writes back without waiting for metadata", async () => {
    const { sessionTokens, abort, alert, complete } = track(10);
    let resolve!: (tokens: number) => void;
    sessionTokens.mockReturnValue(new Promise((done) => { resolve = done; }));
    await vi.advanceTimersByTimeAsync(10);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
    resolve(123);
    await vi.advanceTimersByTimeAsync(0);
    expect(console.log).toHaveBeenCalledWith("[imajin-ws] wake ended batch=batch sessionTokens=123 reason=timeout");
  });

  it("aborts capacity evictions with one alert and does not expire the same wake twice", async () => {
    const { supervisor, abort, alert, complete, sessionTokens } = track(10);
    for (let i = 1; i < 100; i++) {
      supervisor.track({ batchId: `batch-${i}`, sessionKey: `${BASE}:${i}`, scope: "scope", runs: [] });
    }
    supervisor.track({ batchId: "overflow", sessionKey: `${BASE}:overflow`, scope: "scope", runs: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ batchId: "batch" }), "wake supervision capacity exceeded");
    expect(alert).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(sessionTokens).toHaveBeenCalledWith(BASE);
    expect(console.log).toHaveBeenCalledWith("[imajin-ws] wake ended batch=batch sessionTokens=0 reason=timeout");
    await vi.advanceTimersByTimeAsync(10);
    expect(abort).toHaveBeenCalledTimes(101);
    // The oldest retained wake already timed out, so eviction cannot abort or alert again.
    supervisor.track({ batchId: "after-timeout", sessionKey: `${BASE}:after`, scope: "scope", runs: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(abort).toHaveBeenCalledTimes(101);
    expect(alert).toHaveBeenCalledTimes(101);
    expect(complete).toHaveBeenCalledTimes(101);
  });

  it("keeps alert and writeback independent of a failed abort without retrying disclosure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { abort, alert, complete } = track(10);
    abort.mockRejectedValue(new Error("private abort failure"));
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(100);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("[imajin-ws] wake timeout abort failed");
  });

  it.each([
    { timeoutMs: undefined, expectedMs: 900_000 },
    { timeoutMs: Number.NaN, expectedMs: 900_000 },
    { timeoutMs: Number.POSITIVE_INFINITY, expectedMs: 900_000 },
    { timeoutMs: -1, expectedMs: 1 },
    { timeoutMs: 0, expectedMs: 1 },
    { timeoutMs: 50_000, expectedMs: 50_000 },
    { timeoutMs: 3_600_000, expectedMs: 3_600_000 },
    { timeoutMs: 3_600_001, expectedMs: 3_600_000 },
  ])("uses $expectedMs ms for configured timeout $timeoutMs", async ({ timeoutMs, expectedMs }) => {
    const { alert, abort, complete, sessionTokens } = track(timeoutMs);
    await vi.advanceTimersByTimeAsync(expectedMs - 1);
    expect(alert).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ batchId: "batch" }), "wake completion timeout");
    expect(complete).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ wakeWatchdog: true }));
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ batchId: "batch" }), "wake completion timeout");
    expect(sessionTokens).toHaveBeenCalledTimes(1);
    expect(sessionTokens).toHaveBeenCalledWith(BASE);
    expect(console.log).toHaveBeenCalledWith("[imajin-ws] wake ended batch=batch sessionTokens=0 reason=timeout");
  });

  it("keeps runtime and config-schema defaults/bounds aligned at 15 and 60 minutes", async () => {
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(DEFAULT_WAKE_TIMEOUT_MS).toBe(900_000);
    expect(MAX_WAKE_TIMEOUT_MS).toBe(3_600_000);
    expect(manifest.configSchema.properties.wsNotifications.properties.wakeTimeoutMs).toMatchObject({
      default: DEFAULT_WAKE_TIMEOUT_MS, minimum: 1, maximum: MAX_WAKE_TIMEOUT_MS,
    });
  });

  it("does not alert or write a timeout verdict for a healthy turn finishing after 60 seconds", async () => {
    const { supervisor, alert, abort, complete, sessionTokens } = track();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(alert).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    const event = { success: true, runId: "runner", messages: [{ role: "assistant", content: "Review complete; PR awaiting review" }] };
    await supervisor.onAgentEnd(event, { sessionKey: BASE });
    expect(alert).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(expect.any(Object), event, undefined);
    await vi.advanceTimersByTimeAsync(DEFAULT_WAKE_TIMEOUT_MS);
    expect(alert).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
    expect(sessionTokens).not.toHaveBeenCalled();
  });

  it.each([
    { success: false, messages: [], reason: "wake turn failed" },
    { success: true, messages: [{ role: "assistant", content: "" }], reason: "empty wake reply" },
    { success: true, messages: [{ role: "assistant", content: "partial", stopReason: "length" }], reason: "stopReason=length (truncated reply)" },
  ])("alerts an observed $reason immediately without waiting 15 minutes", async ({ reason, ...event }) => {
    const { supervisor, alert } = track();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(alert).not.toHaveBeenCalled();
    const observedAt = Date.now();
    await supervisor.onAgentEnd(event, { sessionKey: BASE });
    expect(alert).toHaveBeenCalledWith(expect.any(Object), reason);
    expect(Date.now()).toBe(observedAt);
  });
});

describe("fresh wake bridge (#79)", () => {
  let dir: string;
  let posts: Array<{ sessionKey: string; message: string; name: string }>;
  let config: WsNotificationsConfig;
  let api: any;
  const injectors: Array<ReturnType<typeof createNotificationInjector>> = [];
  const configurations = new WeakMap<ReturnType<typeof createNotificationInjector>, WsNotificationsConfig>();
  const alerts = () => vi.mocked(sendDirectChannelMessage).mock.calls.filter(([, text]) => text.includes("automatic wake failed"));
  const posted = async (count: number) => vi.waitFor(() => expect(posts).toHaveLength(count), { interval: 5 });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fresh-wakes-"));
    posts = [];
    config = {
      targetSession: BASE, injectScopes: ["warp.run.completed"], hookToken: "fixture-only",
      wakeSettleMs: 2, wakeCoalesceMs: 2, stateDir: dir, directSend,
    };
    api = { runtime: { system: { enqueueSystemEvent: vi.fn(() => true) }, config: { current: () => ({}) } } };
    vi.mocked(sendDirectChannelMessage).mockReset().mockResolvedValue();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body));
      return { status: 200, json: async () => ({ runId: `hook-${posts.length}` }), text: async () => "" };
    }));
    for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const injector of injectors.splice(0)) injector.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  function create(settings = config, deps: Parameters<typeof createNotificationInjector>[2] = {}) {
    const injector = createNotificationInjector(api, settings, deps);
    configurations.set(injector, settings);
    injectors.push(injector);
    return injector;
  }

  async function finish(injector: ReturnType<typeof create>, index: number, event: AgentEndEvent = {}) {
    if (!Object.keys(event).length) {
      const settings = configurations.get(injector)!;
      const key = settings.reportTo?.[0]?.split(":");
      const channel = key?.[2] ?? settings.directSend?.channel ?? "telegram";
      const target = key?.slice(4).join(":") ?? settings.directSend?.target;
      await injector.runtimeHooks.after_tool_call({
        toolName: "message", toolCallId: `report-${index}`,
        params: { action: "send", channel, target, message: "Reviewed; PR awaiting review" },
        result: { ok: true },
      }, { sessionKey: posts[index].sessionKey, runId: `runner-${index + 1}` });
    }
    await injector.onAgentEnd!({
      success: true, runId: `runner-${index + 1}`,
      messages: [{ role: "user", content: posts[index].message }, { role: "assistant", content: "Reviewed; PR awaiting review", usage: {
        contextUsage: { state: "available", promptTokens: 2_000, totalTokens: 2_500 },
      } }], ...event,
    }, { sessionKey: posts[index].sessionKey });
  }

  it("20 consecutive wakes use 20 fresh sessions, bounded context, and no fixed-session inbox", async () => {
    const sendFrame = vi.fn();
    const injector = create(config, { sendFrame });
    for (let i = 0; i < 20; i++) {
      await injector.inject(frame(`run-${i}`));
      await posted(i + 1);
      expect(Buffer.byteLength(posts[i].message)).toBeLessThan(24_000);
      await finish(injector, i);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(new Set(posts.map((p) => p.sessionKey)).size).toBe(20);
    expect(posts.every((p) => p.sessionKey.startsWith(`${BASE}:`))).toBe(true);
    expect(api.runtime.system.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(sendFrame).toHaveBeenCalledTimes(20);
    const sizes = vi.mocked(console.log).mock.calls.filter(([text]) => String(text).includes("wake ended"));
    expect(sizes).toHaveLength(20);
    expect(sizes.every(([text]) => String(text).includes("sessionTokens=2500"))).toBe(true);
    expect(alerts()).toHaveLength(0); // Successful sends to directSend are valid fallback receipts.
  });

  it("keeps an explicit fixed key when sessionPerWake=false and the metadata is safe", async () => {
    const injector = create({ ...config, sessionPerWake: false }, { sessionTokens: async () => 1_000 });
    await injector.inject(frame("fixed"));
    await posted(1);
    expect(posts[0].sessionKey).toBe(BASE);
    expect(api.runtime.system.enqueueSystemEvent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sessionKey: BASE }));
    await finish(injector, 0);
    expect(await readFile(join(dir, "wake-bridge.json"), "utf8")).toContain("Reviewed; PR awaiting review");
  });

  it.each([195_000, undefined])("rotates unsafe reused metadata (%s) before any injection and alerts", async (tokens) => {
    const read = vi.fn(async (key: string) => key === BASE ? tokens : undefined);
    const injector = create({ ...config, sessionPerWake: false }, { sessionTokens: read });
    await injector.inject(frame("guarded"));
    await posted(1);
    expect(posts[0].sessionKey).toMatch(/:rotated-/);
    expect(api.runtime.system.enqueueSystemEvent.mock.calls[0][1].sessionKey).toBe(posts[0].sessionKey);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0][0]).toEqual(directSend);
    expect(alerts()[0][1]).toContain("guarded");
    await finish(injector, 0);
  });

  it.each([
    { messages: [{ role: "assistant", content: "" }] },
    { messages: [{ role: "assistant", content: "NO_REPLY" }] },
    { messages: [{ role: "assistant", content: "partial", stopReason: "length" }] },
    { success: false, error: "fixture error" },
  ])("alerts empty/truncated/failed outcomes via configured directSend: %j", async (event: AgentEndEvent) => {
    const injector = create();
    await injector.inject(frame("failed-run"));
    await posted(1);
    await finish(injector, 0, event);
    await finish(injector, 0, event);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0][0]).toEqual(directSend);
    expect(alerts()[0][1]).toContain("failed-run");
    if (event.messages?.[0]?.stopReason === "length") expect(alerts()[0][1]).toContain("stopReason=length");
  });

  it("alerts hook failure on the first attempt, without waiting through the retry ladder", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401, text: async () => "ignored private response" })));
    const injector = create();
    await injector.inject(frame("hook-failure"));
    await vi.waitFor(() => expect(alerts()).toHaveLength(1), { interval: 5 });
    expect(alerts()[0][1]).toContain("gateway returned 401");
    expect(alerts()[0][1]).toContain("hook-failure");
  });

  it("retains #31 queued-503 semantics and alerts at the configured missing-completion deadline", async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body));
      return { status: 503, text: async () => JSON.stringify({ runId: "queued-hook" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const injector = create({ ...config, wakeTimeoutMs: 30 });
    await injector.inject(frame("queued-run"));
    await posted(1);
    expect(alerts()).toHaveLength(0);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1), { interval: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(alerts()[0][1]).toContain("completion timeout");
    expect(alerts()[0][1]).toContain("queued-run");
  });

  it("clears pending admission markers on a real completion, not on watchdog expiry", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body));
      return { status: 503, text: async () => JSON.stringify({ runId: "hook-1" }) };
    }));
    const injector = create({ ...config, wakeTimeoutMs: 30 });
    await injector.inject(frame("pending"));
    await posted(1);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1), { interval: 5 });
    expect(Object.keys(JSON.parse(await readFile(join(dir, "pending-wakes.json"), "utf8")).wakes)).toHaveLength(1);
    await finish(injector, 0);
    expect(JSON.parse(await readFile(join(dir, "pending-wakes.json"), "utf8")).wakes).toEqual({});
  });

  it("next fresh wake reads the previous verdict and open PR from disk, never prior messages", async () => {
    const first = create();
    await first.inject(frame("watched"));
    await posted(1);
    await finish(first, 0);
    first.dispose();
    const second = create();
    await second.inject(frame("next"));
    await posted(2);
    expect(posts[1].sessionKey).not.toBe(posts[0].sessionKey);
    expect(posts[1].message).toContain("Reviewed; PR awaiting review");
    expect(posts[1].message).toContain("fixture/pr/80");
    expect(posts[1].message).toContain("watched");
  });

  it.each([
    { maxAge: undefined, deliveryFails: false },
    { maxAge: undefined, deliveryFails: true },
    { maxAge: 1_000, deliveryFails: false },
    { maxAge: 1_000, deliveryFails: true },
  ])("expires fresh evidence on load with one disclosure attempt: %j", async ({ maxAge, deliveryFails }) => {
    const store = new PendingWakeStore(join(dir, "pending-wakes.json"));
    const sinceTs = Date.now() - (maxAge ?? DEFAULT_WAKE_OWED_MAX_AGE_MS) - 1;
    await store.set(`warp.run.completed:${sinceTs}:leading`, {
      scope: "warp.run.completed", sinceTs, frames: [frame("old")], injected: false,
    });
    if (deliveryFails) vi.mocked(sendDirectChannelMessage).mockRejectedValue(new Error("private delivery error"));
    for (let registration = 0; registration < 5; registration++) {
      const injector = create({ ...config, wakeOwedMaxAgeMs: maxAge });
      await injector.ready;
      injector.dispose();
      expect(JSON.parse(await readFile(join(dir, "pending-wakes.json"), "utf8")).wakes).toEqual({});
    }
    expect(posts).toHaveLength(0);
    expect(sendDirectChannelMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendDirectChannelMessage).mock.calls[0][1]).toContain("expired");
    const bridge = JSON.parse(await readFile(join(dir, "wake-bridge.json"), "utf8"));
    expect(bridge.records).toContainEqual(expect.objectContaining({
      runId: "old", status: "open", lastVerdict: expect.stringContaining("expired"),
    }));
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("private delivery error"));
  });

  it.each([999, 1_000])("replays fresh evidence at or below the configured age bound (%s ms)", async (age) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const sinceTs = now - age;
    const store = new PendingWakeStore(join(dir, "pending-wakes.json"));
    await store.set(`warp.run.completed:${sinceTs}:leading`, {
      scope: "warp.run.completed", sinceTs, frames: [frame("recent")], injected: false,
    });
    await create({ ...config, wakeOwedMaxAgeMs: 1_000 }).ready;
    await posted(1);
    expect(posts[0].message).toContain("recent");
    expect(sendDirectChannelMessage).not.toHaveBeenCalled();
  });

  it("does not acknowledge fresh evidence without a durable state directory", async () => {
    const sendFrame = vi.fn();
    const injector = create({ ...config, stateDir: undefined }, { sendFrame });
    await injector.inject(frame("in-memory"));
    await posted(1);
    expect(sendFrame).not.toHaveBeenCalled();
  });

  it("does not acknowledge a failed pending-file write", async () => {
    await writeFile(join(dir, "not-a-directory"), "");
    const sendFrame = vi.fn();
    const injector = create({ ...config, stateDir: join(dir, "not-a-directory") }, { sendFrame });
    await injector.inject(frame("disk-failure"));
    expect(sendFrame).not.toHaveBeenCalled();
    expect(alerts().some(([, text]) => text.includes("persistence failed"))).toBe(true);
  });

  it("horizon is feature-flagged off by default, then reads open items and writes sanitized outcomes when enabled", async () => {
    const horizon = {
      readOpenItems: vi.fn(async () => [{ runId: "horizon-open", status: "open" as const, expectedPr: "fixture/pr/horizon" }]),
      writeStepEvents: vi.fn(async () => {}),
    };
    const off = create(config, { horizon });
    await off.inject(frame("off"));
    await posted(1);
    await finish(off, 0);
    expect(horizon.readOpenItems).not.toHaveBeenCalled();
    expect(horizon.writeStepEvents).not.toHaveBeenCalled();
    off.dispose();
    const on = create({ ...config, horizonEnabled: true }, { horizon });
    await on.inject(frame("on"));
    await posted(2);
    expect(posts[1].message).toContain("horizon-open");
    await finish(on, 1);
    expect(horizon.writeStepEvents).toHaveBeenCalledWith(expect.objectContaining({ runIds: ["on"], lastVerdict: "Reviewed; PR awaiting review" }));
  });

  it("falls back to bridge when horizon read or signed-step write fails", async () => {
    const horizon = {
      readOpenItems: vi.fn(async () => { throw new Error("offline"); }),
      writeStepEvents: vi.fn(async () => { throw new Error("offline"); }),
    };
    const injector = create({ ...config, horizonEnabled: true }, { horizon });
    await injector.inject(frame("fallback"));
    await posted(1);
    expect(posts[0].message).toContain("fixture/pr/80");
    await finish(injector, 0);
    expect(await readFile(join(dir, "wake-bridge.json"), "utf8")).toContain("Reviewed; PR awaiting review");
  });

  it("a pending wake cannot block a later fresh batch", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body));
      return { status: 503, text: async () => JSON.stringify({ runId: `queued-${posts.length}` }) };
    }));
    const injector = create();
    await injector.inject(frame("stuck"));
    await posted(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await injector.inject(frame("next-independent"));
    await posted(2);
    expect(posts[1].sessionKey).not.toBe(posts[0].sessionKey);
  });

  it("an authoritative empty horizon does not inject stale bridge work", async () => {
    const horizon = { readOpenItems: async () => [], writeStepEvents: async () => {} };
    const injector = create({ ...config, horizonEnabled: true }, { horizon });
    await injector.inject(frame("current"));
    await posted(1);
    expect(posts[0].message).not.toContain("Wake continuity");
  });

  it("uses the gateway-selected agent namespace for completion correlation", async () => {
    const injector = create({ ...config, targetSession: "agent:other:warp-events", hookAgentId: "worker" });
    await injector.inject(frame("agent-routing"));
    await posted(1);
    expect(posts[0].sessionKey).toMatch(/^agent:worker:/);
    await finish(injector, 0);
    expect(vi.mocked(console.log).mock.calls.some(([text]) => String(text).includes("wake ended"))).toBe(true);
  });

  it("reports a fresh wake exactly once when admission and runner UUIDs differ", async () => {
    const injector = create({ ...config, reportTo: ["agent:main:telegram:direct:123"] });
    await injector.inject(frame("different-ids"));
    await posted(1);
    await finish(injector, 0);
    await finish(injector, 0);
    expect(posts.filter((post) => post.name === "imajin-wake-report")).toHaveLength(1);
    expect(posts[1].message).toContain("Reviewed; PR awaiting review");
    expect(alerts()).toHaveLength(0);
  });
});

describe("wake supervision pure contracts", () => {
  it("correlates fixed queued batches by current evidence, not a previous transcript turn", async () => {
    const complete = vi.fn(async () => {});
    const supervisor = new WakeSupervisor({ complete, alert: async () => {}, abort: async () => {}, sessionTokens: async () => 0 });
    for (const id of ["one", "two"]) {
      supervisor.track({ batchId: `imajin-wake:${id}`, sessionKey: BASE, scope: "scope", runs: [] });
      supervisor.bindRun(`imajin-wake:${id}`, `admission-${id}`);
    }
    await supervisor.onAgentEnd({ runId: "runner-two", messages: [
      { role: "user", content: "Wake batch ID: imajin-wake:one" },
      { role: "assistant", content: "old turn" },
      { role: "user", content: [{ type: "text", text: "Wake batch ID: imajin-wake:two\nEvidence" }] },
      { role: "assistant", content: "second result" },
    ] }, { sessionKey: BASE });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ batchId: "imajin-wake:two" }), expect.any(Object), undefined);
    expect(extractWakeBatchId([
      { role: "user", content: "Wake batch ID: imajin-wake:one" },
      { role: "user", content: "Unrelated current turn" },
    ])).toBeUndefined();
    supervisor.dispose();
  });
  it("buffers early completions until the exact gateway run ID is bound", async () => {
    const complete = vi.fn(async () => {});
    const supervisor = new WakeSupervisor({ complete, alert: async () => {}, abort: async () => {}, sessionTokens: async () => 0 });
    supervisor.track({ batchId: "a", sessionKey: BASE, scope: "scope", runs: [] });
    supervisor.track({ batchId: "b", sessionKey: BASE, scope: "scope", runs: [] });
    await supervisor.onAgentEnd({ runId: "second", messages: [{ role: "assistant", content: "result" }] }, { sessionKey: BASE });
    expect(complete).not.toHaveBeenCalled();
    supervisor.bindRun("a", "first");
    expect(complete).not.toHaveBeenCalled();
    supervisor.bindRun("b", "second");
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ batchId: "b" }), expect.any(Object), undefined);
    supervisor.dispose();
  });
  it("derives stable template batches, separates repeated run IDs and supports fixed keys", () => {
    expect(deriveWakeSessionKey(BASE, "batch", ["run"], false)).toBe(BASE);
    for (const template of [`${BASE}:{batchId}`, `${BASE}:{runId}`]) {
      const one = deriveWakeSessionKey(template, "one", ["run"]);
      expect(one).toBe(deriveWakeSessionKey(template, "one", ["run"]));
      expect(one).not.toBe(deriveWakeSessionKey(template, "two", ["run"]));
      expect(one).not.toContain("{");
    }
  });

  it("prefers the final context snapshot to cumulative billable usage", () => {
    expect(wakeEventTokens({ messages: [{ role: "assistant", usage: {
      totalTokens: 195_000, contextUsage: { state: "available", promptTokens: 100, totalTokens: 200 },
    } }] })).toBe(200);
    expect(wakeEventTokens({ messages: [] })).toBeUndefined();
  });

  it("sanitizes structured outcome updates and never infers closure from prose or failed output", () => {
    const event = (content: string, stopReason = "stop") => ({ messages: [{ role: "assistant", content, stopReason }] });
    expect(buildWakeOutcome(["r"], event("All closed")).updates).toEqual([]);
    const output = JSON.stringify({ updates: [
      { runId: "r", status: "closed", expectedPr: "fixture/pr", secretField: "discard" },
      { runId: "unrelated", status: "closed" },
    ] });
    expect(buildWakeOutcome(["r"], event(output)).updates).toEqual([{
      runId: "r", status: "closed", expectedPr: "fixture/pr", issue: undefined, lastVerdict: undefined,
    }]);
    expect(buildWakeOutcome(["r"], event(output, "length")).updates).toEqual([]);
    expect(Buffer.byteLength(buildWakeOutcome(["r"], event("字".repeat(5_000))).lastVerdict!)).toBeLessThanOrEqual(768);
  });

  it("does not consume a different session/run and keeps observing late completions", async () => {
    vi.useFakeTimers();
    const complete = vi.fn(async () => {});
    const alert = vi.fn(async () => {});
    const supervisor = new WakeSupervisor({ timeoutMs: 50_000, alert, abort: async () => {}, complete, sessionTokens: async () => 0 });
    supervisor.track({ batchId: "batch", sessionKey: `${BASE}:fresh`, scope: "scope", runs: [] });
    supervisor.bindRun("batch", "real");
    await supervisor.onAgentEnd({ runId: "wrong", messages: [] }, { sessionKey: `${BASE}:fresh` });
    await supervisor.onAgentEnd({ runId: "real", messages: [] }, { sessionKey: "agent:main:other" });
    expect(complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(alert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(alert).toHaveBeenCalledTimes(1);
    await supervisor.onAgentEnd({ runId: "real", messages: [{ role: "assistant", content: "late success" }] }, { sessionKey: `${BASE}:fresh` });
    expect(complete).toHaveBeenCalledTimes(2);
    supervisor.dispose();
    vi.useRealTimers();
  });
});
