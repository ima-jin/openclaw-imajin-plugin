import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemAgentApprovalRequestRecord } from "./sources/system-agent.js";
import { beginRegistration } from "./registration-lifecycle.js";

const mocks = vi.hoisted(() => ({
  system: vi.fn(), workshop: vi.fn(), catalog: vi.fn(), exec: vi.fn(), preflight: vi.fn(),
  helpers: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
  sockets: [] as Array<{
    start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>;
    frame?: (frame: any) => void; connected?: () => Promise<void>;
  }>,
  discovery: [] as Array<{ stop: ReturnType<typeof vi.fn> }>,
  sessionGateways: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
  loopHook: vi.fn(), wakeHook: vi.fn(), usageHook: vi.fn(), wsStart: vi.fn(), inject: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: unknown) => entry, resolveApprovalOverGateway: vi.fn(),
}));
vi.mock("./sources/system-agent.js", async (original) => ({
  ...await original<object>(), createLiveGatewayApprovalsClient: mocks.system,
}));
vi.mock("./sources/skill-workshop.js", async (original) => ({
  ...await original<object>(), createLiveSkillWorkshopConnection: mocks.workshop,
}));
vi.mock("./sources/imajin-catalog.js", async (original) => ({
  ...await original<object>(), createLiveImajinCatalogConnection: mocks.catalog,
}));
vi.mock("./sources/gateway-exec.js", async (original) => ({
  ...await original<object>(), createLiveGatewayExecConnection: mocks.exec,
}));
vi.mock("./client.js", () => ({ ImajinClient: class { requestRaw = mocks.preflight; } }));
vi.mock("./imajin-provider.js", () => ({
  IMAJIN_PROVIDER_ID: "imajin",
  isImajinCatalogInvalidationScope: () => false,
  registerImajinProvider: () => ({
    baseUrl: "http://localhost:8000", cache: { peek: () => undefined },
    startDiscovery: () => {
      const timer = setInterval(() => {}, 60_000);
      const handle = { stop: vi.fn(() => clearInterval(timer)) };
      mocks.discovery.push(handle);
      return handle;
    },
  }),
}));
vi.mock("./ws-service.js", () => ({
  ImajinWsService: class {
    readonly socket = {
      start: vi.fn(() => mocks.wsStart()), stop: vi.fn(),
      frame: undefined as ((frame: any) => void) | undefined,
      connected: undefined as (() => Promise<void>) | undefined,
    };
    constructor() { mocks.sockets.push(this.socket); }
    start() { return this.socket.start(); }
    stop() { this.socket.stop(); }
    send() {}
    onFrame(handler: (frame: any) => void) { this.socket.frame = handler; }
    onConnected(handler: () => Promise<void>) { this.socket.connected = handler; }
  },
}));
vi.mock("./notification-injector.js", () => ({
  WAKE_RUNTIME_HOOKS: ["before_agent_run"],
  createNotificationInjector: () => {
    const timer = setInterval(() => {}, 120_000);
    const dispose = vi.fn(() => clearInterval(timer));
    mocks.helpers.push({ dispose });
    return {
      inject: mocks.inject, dispose,
      runtimeHooks: { before_agent_run: mocks.wakeHook },
      onAgentEnd: vi.fn(async () => {}), reportWake: vi.fn(),
    };
  },
}));
vi.mock("./reach-events.js", () => ({
  isReachFrame: () => false,
  createReachEventHandler: () => {
    const timer = setInterval(() => {}, 120_000);
    const dispose = vi.fn(() => clearInterval(timer));
    mocks.helpers.push({ dispose });
    return { dispose, handle: vi.fn() };
  },
}));
vi.mock("./session-command-gateway.js", () => ({
  createLoopbackSessionGateway: () => {
    const handle = { gateway: {}, dispose: vi.fn() };
    mocks.sessionGateways.push(handle);
    return handle;
  },
}));
vi.mock("./session-commands.js", () => ({
  createSessionCommandExecutor: () => ({}),
  createSessionCommandAttester: () => vi.fn(), isSessionCommandFrame: () => false,
}));
vi.mock("./loop-hooks.js", () => ({
  LOOP_LIFECYCLE_HOOKS: ["session_start"],
  registerLoopLifecycle: (api: { on: (name: string, handler: () => void, opts: { name: string }) => void }) => {
    api.on("session_start", mocks.loopHook, { name: "imajin-loops:session_start" });
    return { tracker: { block: vi.fn(), unblock: vi.fn() } };
  },
}));
vi.mock("./turn-usage-attestation.js", () => ({
  createTurnUsageAttestationHandler: () => mocks.usageHook,
}));

import plugin from "../index.js";

type Service = { id: string; start: () => unknown; stop: () => unknown };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function systemConnection() {
  let listener: ((record: SystemAgentApprovalRequestRecord) => void) | undefined;
  let records: SystemAgentApprovalRequestRecord[] = [];
  return {
    client: {
      list: vi.fn(async () => records),
      get: vi.fn(async (id: string) => {
        const live = records.find((entry) => entry.id === id);
        return live ? {
          status: "pending", expiresAtMs: live.expiresAtMs,
          presentation: { proposalHash: live.request.proposalHash },
        } : null;
      }),
      resolve: vi.fn(async (id: string) => {
        records = records.filter((entry) => entry.id !== id);
        return { applied: true };
      }),
      onRequested: vi.fn((handler) => { listener = handler; }),
    },
    start: vi.fn(async () => {}), stop: vi.fn(),
    emit(record: SystemAgentApprovalRequestRecord) { records = [record]; listener?.(record); },
    stage(record: SystemAgentApprovalRequestRecord) { records = [record]; },
  };
}

function workshopConnection() {
  return {
    client: {
      list: vi.fn(async () => ({ proposals: [] })),
      listAgentIds: vi.fn(async () => []), apply: vi.fn(), reject: vi.fn(),
    },
    start: vi.fn(async () => {}), stop: vi.fn(),
  };
}

const record: SystemAgentApprovalRequestRecord = {
  id: "proposal", createdAtMs: 0, expiresAtMs: 1_000_000,
  request: {
    title: "Restart", description: "Restart gateway", command: "restart",
    proposalHash: "revision", allowedDecisions: ["allow-once", "deny"], sessionKey: "main",
  },
};

describe("process-wide plugin registration (#86)", () => {
  let config: Record<string, unknown>;
  let systems: ReturnType<typeof systemConnection>[];
  let workshops: ReturnType<typeof workshopConnection>[];
  let publish: ReturnType<typeof vi.fn>;

  function register(overrides: Record<string, unknown> = {}, registrationMode?: string) {
    const services: Service[] = [];
    const hooks = new Map<string, Array<(...args: any[]) => unknown>>();
    plugin.register({
      registrationMode, pluginConfig: { ...config, ...overrides }, registerTool: vi.fn(),
      registerService: (service: Service) => services.push(service),
      on: (name: string, handler: (...args: any[]) => unknown) =>
        hooks.set(name, [...hooks.get(name) ?? [], handler]),
    });
    return {
      emit: (name: string, event?: object) => hooks.get(name)?.forEach((handler) => handler(event ?? {})),
      ws: services.find((service) => service.id === "imajin-ws")!,
      discovery: services.find((service) => service.id === "imajin-model-discovery")!,
    };
  }

  async function start(overrides: Record<string, unknown> = {}) {
    const registration = register(overrides, "full");
    await (registration.ws ?? registration.discovery).start();
    return registration;
  }

  async function ready() {
    await vi.waitFor(() => expect(workshops.at(-1)?.client.list).toHaveBeenCalled());
    await mocks.sockets.at(-1)?.connected?.();
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    beginRegistration().dispose();
    vi.clearAllMocks();
    mocks.helpers.length = mocks.sockets.length = mocks.discovery.length = mocks.sessionGateways.length = 0;
    systems = [];
    workshops = [];
    for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), "plugin-registration-"));
    const keypairPath = join(dir, "identity.json");
    await writeFile(keypairPath, JSON.stringify({ did: "did:imajin:test", privateKey: "01".repeat(32) }));
    config = {
      nodeUrl: `http://kernel.test/${dir.split("/").at(-1)}`, did: "did:imajin:test", keypairPath,
      wsNotifications: { stateDir: dir },
      sessionCommands: { enabled: true, kernelPublicKeyHex: "02".repeat(32) },
      approvals: { enabled: true, operatorDid: "did:imajin:operator", notifyWebhookSecret: "test-fixture" },
    };
    mocks.system.mockImplementation(async () => {
      const live = systemConnection();
      systems.push(live);
      return live;
    });
    mocks.workshop.mockImplementation(async () => {
      const live = workshopConnection();
      workshops.push(live);
      return live;
    });
    mocks.wsStart.mockResolvedValue(undefined);
    mocks.inject.mockResolvedValue(undefined);
    mocks.preflight.mockResolvedValue({
      status: 200,
      text: JSON.stringify({ events: [], nextCursor: "0", entitledEventTypes: ["operator.approval.decided"] }),
    });
    publish = vi.fn(async (_url: unknown, _options: any) => ({ ok: true }));
    vi.stubGlobal("fetch", publish);
  });

  afterEach(() => {
    beginRegistration().dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("full/start stays live through three non-full register passes without any further starts", async () => {
    const active = await start();
    await ready();
    const socket = mocks.sockets[0];
    for (const mode of ["tool-discovery", "discovery", "cli-metadata"]) {
      const metadata = register({}, mode);
      metadata.emit("session_start");
      metadata.emit("before_agent_run");
      metadata.ws.stop(); // Even an unstarted registry's stop cannot touch the owner.
    }
    expect(systems).toHaveLength(1);
    expect(workshops).toHaveLength(1);
    expect(mocks.sockets).toHaveLength(1);
    expect(mocks.helpers).toHaveLength(2);
    expect(mocks.discovery).toHaveLength(1);
    expect(mocks.sessionGateways).toHaveLength(1);
    expect(socket.stop).not.toHaveBeenCalled();
    expect(systems[0].stop).not.toHaveBeenCalled();
    expect(workshops[0].stop).not.toHaveBeenCalled();
    expect(mocks.loopHook).not.toHaveBeenCalled();
    expect(mocks.wakeHook).not.toHaveBeenCalled();
    for (const hook of ["session_start", "before_agent_run", "agent_end"]) active.emit(hook);
    for (const hook of [mocks.loopHook, mocks.wakeHook, mocks.usageHook]) expect(hook).toHaveBeenCalledOnce();
    workshops[0].client.list.mockClear();
    await vi.advanceTimersByTimeAsync(30_000); // Beyond the observed ~20s failure.
    expect(workshops[0].client.list).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(5); // Includes the single approvals entitlement timer.
    for (let index = 0; index < 4; index++) systems[0].emit(record);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const data = JSON.parse(publish.mock.calls[0][1].body).data;
    socket.frame?.({ type: "notification", id: "n1", scope: "test", title: "Test", createdAt: "" });
    expect(mocks.inject).toHaveBeenCalledOnce();
    socket.frame?.({
      type: "bus_event", eventType: "operator.approval.decided",
      issuer: "did:imajin:operator", subject: "did:imajin:test", scope: "operator",
      payload: {
        proposalId: record.id, decidedBy: "did:imajin:operator",
        decision: "approve", contentHash: data.contentHash,
      },
    });
    await vi.waitFor(() => expect(systems[0].client.resolve).toHaveBeenCalledOnce());
    await socket.connected?.();
    expect(socket.stop).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("building another full registry without starting it leaves the active owner untouched", async () => {
    const active = await start();
    await ready();
    const replacement = register({}, "full");
    replacement.ws.stop();
    expect(mocks.sockets).toHaveLength(1);
    expect(mocks.sockets[0].stop).not.toHaveBeenCalled();
    // The same host event dispatched through both registries is handled once.
    const event = {};
    active.emit("session_start", event);
    replacement.emit("session_start", event);
    expect(mocks.loopHook).toHaveBeenCalledOnce();
    // #92: a registry the host builds later but never starts still reaches the started owner.
    replacement.emit("session_start");
    expect(mocks.loopHook).toHaveBeenCalledTimes(2);
    await replacement.ws.start();
    await ready();
    expect(mocks.sockets).toHaveLength(2);
    expect(mocks.sockets[0].stop).toHaveBeenCalledOnce();
    expect(systems[0].stop).toHaveBeenCalledOnce();
    expect(mocks.sockets[1].stop).not.toHaveBeenCalled();
  });

  it.each(["full", undefined])("registration mode %s performs no runtime IO before start", async (mode) => {
    const registration = register({}, mode);
    registration.emit("session_start");
    registration.emit("before_agent_run");
    expect(systems).toHaveLength(0);
    expect(mocks.sockets).toHaveLength(0);
    expect(mocks.helpers).toHaveLength(0);
    expect(mocks.discovery).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await registration.ws.start();
    await ready();
    expect(systems).toHaveLength(1);
    expect(mocks.sockets).toHaveLength(1);
  });

  it.each(["tool-discovery", "discovery", "cli-metadata", "setup-only"])(
    "%s services stay inert even if start is called", async (mode) => {
      await start();
      await ready();
      const metadata = register({}, mode);
      await metadata.ws.start();
      await metadata.discovery.start();
      metadata.ws.stop();
      metadata.discovery.stop();
      expect(systems).toHaveLength(1);
      expect(mocks.sockets).toHaveLength(1);
      expect(mocks.sockets[0].stop).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(5);
    },
  );

  it("both service IDs and concurrent starts share one runtime and one discovery poller", async () => {
    const registration = register({}, "full");
    await Promise.all([
      registration.ws.start(), registration.ws.start(),
      registration.discovery.start(), registration.discovery.start(),
    ]);
    await ready();
    expect(systems).toHaveLength(1);
    expect(mocks.sockets[0].start).toHaveBeenCalledOnce();
    expect(mocks.discovery).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(5);
  });

  it("N=3 leaves one client per source, one poller and one publish/notification", async () => {
    const registrations = [];
    for (let index = 0; index < 3; index++) {
      const registration = register({}, "full");
      registrations.push(registration);
      await registration.discovery.start();
      await registration.ws.start();
      await ready();
    }
    expect(systems).toHaveLength(3);
    expect(workshops).toHaveLength(3);
    for (const live of [...systems.slice(0, 2), ...workshops.slice(0, 2)]) expect(live.stop).toHaveBeenCalledOnce();
    expect(systems[2].stop).not.toHaveBeenCalled();
    expect(workshops[2].stop).not.toHaveBeenCalled();
    expect(mocks.discovery.slice(0, 2).every((handle) => handle.stop.mock.calls.length === 1)).toBe(true);
    expect(mocks.helpers.slice(0, 4).every((handle) => handle.dispose.mock.calls.length === 1)).toBe(true);
    expect(mocks.sessionGateways.slice(0, 2).every((handle) => handle.dispose.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(5); // Helpers + discovery + real Skill Workshop poller + entitlement.
    workshops.forEach((live) => live.client.list.mockClear());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(workshops.map((live) => live.client.list.mock.calls.length)).toEqual([0, 0, 1]);
    systems.forEach((live) => live.emit(record)); // Include delivery from closed sockets.
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(JSON.parse(publish.mock.calls[0][1].body)).toMatchObject({
      scope: "operator.approval.requested", data: { proposalId: "proposal" },
    });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(7)); // + expiry and sweep.
    registrations[2].ws.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rapid full service starts cancel superseded setup before opening sources", async () => {
    const first = register({}, "full");
    const second = register({}, "full");
    const third = register({}, "full");
    await Promise.all([first.ws.start(), second.ws.start(), third.ws.start()]);
    await ready();
    expect(mocks.system).toHaveBeenCalledOnce();
    expect(mocks.workshop).toHaveBeenCalledOnce();
  });

  it("closes pending connections and closes again if startup opens a late socket", async () => {
    const pending = deferred<void>();
    const first = systemConnection();
    first.start.mockImplementation(() => pending.promise);
    mocks.system.mockResolvedValueOnce(first);
    await start();
    await vi.waitFor(() => expect(first.start).toHaveBeenCalledOnce());
    await start();
    expect(first.stop).toHaveBeenCalledOnce();
    pending.resolve();
    await ready();
    expect(first.stop).toHaveBeenCalledTimes(2);
    expect(workshops).toHaveLength(1);
  });

  it("closes a client factory result that arrives after replacement without starting it", async () => {
    const pending = deferred<ReturnType<typeof systemConnection>>();
    mocks.system.mockReturnValueOnce(pending.promise);
    await start();
    await vi.waitFor(() => expect(mocks.system).toHaveBeenCalledOnce());
    await start();
    const late = systemConnection();
    pending.resolve(late);
    await ready();
    expect(late.start).not.toHaveBeenCalled();
    expect(late.stop).toHaveBeenCalledOnce();
  });

  it.each([
    ["system-agent", mocks.system], ["skill-workshop", mocks.workshop],
    ["imajin-catalog", mocks.catalog], ["gateway-exec", mocks.exec],
  ] as const)("retires a pending %s source before it can install subscriptions", async (sourceId, factory) => {
    const pending = deferred<void>();
    const live = { ...systemConnection(), start: vi.fn(() => pending.promise) };
    factory.mockResolvedValueOnce(live);
    await start({
      approvals: {
        enabled: true, operatorDid: "did:imajin:operator",
        notifyWebhookSecret: "test-fixture", sources: [sourceId],
      },
    });
    await vi.waitFor(() => expect(live.start).toHaveBeenCalledOnce());
    await start({ nodeUrl: undefined });
    expect(live.stop).toHaveBeenCalledOnce();
    pending.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(live.stop).toHaveBeenCalledTimes(2);
    expect(live.client.onRequested).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("cancels subscriptions and pollers immediately while startup preflight is pending", async () => {
    const pending = deferred<unknown>();
    mocks.preflight.mockReturnValueOnce(pending.promise);
    await start();
    await vi.waitFor(() => expect(mocks.preflight).toHaveBeenCalledOnce());
    expect(vi.getTimerCount()).toBe(5);
    await start({ nodeUrl: undefined });
    expect(vi.getTimerCount()).toBe(1);
    pending.resolve({
      status: 200, text: JSON.stringify({ events: [], nextCursor: "0", entitledEventTypes: [] }),
    });
    await vi.advanceTimersByTimeAsync(1);
    systems[0].emit(record);
    expect(publish).not.toHaveBeenCalled();
  });

  it("closes failed source starts and can start a healthy replacement", async () => {
    const failed = systemConnection();
    failed.start.mockRejectedValueOnce(new Error("cannot connect"));
    mocks.system.mockResolvedValueOnce(failed);
    await start();
    await ready();
    expect(failed.stop).toHaveBeenCalledOnce();
    await start();
    await ready();
    expect(systems).toHaveLength(1);
    expect(systems[0].start).toHaveBeenCalledOnce();
    expect(systems[0].stop).not.toHaveBeenCalled();
  });

  it("stale service/hook callbacks cannot revive old work or stop the new owner", async () => {
    const old = await start();
    await ready();
    const current = await start();
    await ready();
    await old.ws.start();
    old.discovery.start();
    old.ws.stop();
    const events = new Map(["session_start", "before_agent_run", "agent_end"].map((hook) => [hook, {}]));
    for (const [hook, event] of events) old.emit(hook, event);
    expect(mocks.sockets[0].start).toHaveBeenCalledOnce();
    // #92: hooks fired through a superseded registry reach the current owner, never retired work.
    for (const hook of [mocks.loopHook, mocks.wakeHook, mocks.usageHook]) expect(hook).toHaveBeenCalledOnce();
    for (const [hook, event] of events) current.emit(hook, event);
    for (const hook of [mocks.loopHook, mocks.wakeHook, mocks.usageHook]) expect(hook).toHaveBeenCalledOnce();
    expect(systems[1].stop).not.toHaveBeenCalled();
    expect(mocks.sockets[1].stop).not.toHaveBeenCalled();
  });

  it("starting an unconfigured full service retires previous resources", async () => {
    await start();
    await ready();
    await start({ nodeUrl: undefined });
    expect(systems[0].stop).toHaveBeenCalledOnce();
    expect(workshops[0].stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stop closes late WS startup and ignores late frames/reconnects", async () => {
    const pending = deferred<void>();
    mocks.wsStart.mockReturnValueOnce(pending.promise);
    const registration = register();
    const starting = registration.ws.start();
    await vi.waitFor(() => expect(mocks.sockets[0]?.start).toHaveBeenCalledOnce());
    const socket = mocks.sockets[0];
    registration.ws.stop();
    pending.resolve();
    await starting;
    socket.frame?.({ type: "notification", scope: "connector.models.changed" });
    await socket.connected?.();
    expect(socket.stop).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });

  it("replacement reconciliation does not re-notify an already published proposal", async () => {
    await start();
    await ready();
    systems[0].emit(record);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const replacement = systemConnection();
    replacement.stage(record);
    mocks.system.mockResolvedValueOnce(replacement);
    await start();
    await ready();
    expect(publish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(7); // Helpers + discovery + poller + entitlement + restored expiry and sweep.
    replacement.emit(record);
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledOnce();
  });
});
