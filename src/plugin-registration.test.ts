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
  loopHook: vi.fn(), wakeHook: vi.fn(), usageHook: vi.fn(),
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
      start: vi.fn(async () => {}), stop: vi.fn(),
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
  createNotificationInjector: () => {
    const timer = setInterval(() => {}, 120_000);
    const dispose = vi.fn(() => clearInterval(timer));
    mocks.helpers.push({ dispose });
    return {
      inject: vi.fn(async () => {}), dispose,
      runtimeHooks: { before_agent_start: mocks.wakeHook },
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
  registerLoopLifecycle: (api: { on: (name: string, handler: () => void) => void }) => {
    api.on("session_start", mocks.loopHook);
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
      get: vi.fn(async () => ({ status: "pending", presentation: { proposalHash: "revision" } })),
      resolve: vi.fn(async () => ({ applied: true })),
      onRequested: vi.fn((handler) => { listener = handler; }),
    },
    start: vi.fn(async () => {}), stop: vi.fn(),
    emit(record: SystemAgentApprovalRequestRecord) { listener?.(record); },
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

  function register(overrides: Record<string, unknown> = {}) {
    const services: Service[] = [];
    const hooks = new Map<string, Array<(...args: any[]) => unknown>>();
    plugin.register({
      pluginConfig: { ...config, ...overrides }, registerTool: vi.fn(),
      registerService: (service: Service) => services.push(service),
      on: (name: string, handler: (...args: any[]) => unknown) =>
        hooks.set(name, [...hooks.get(name) ?? [], handler]),
    });
    return {
      emit: (name: string) => hooks.get(name)?.forEach((handler) => handler({})),
      ws: services.find((service) => service.id === "imajin-ws")!,
      discovery: services.find((service) => service.id === "imajin-model-discovery")!,
    };
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

  it("N=3 leaves one client per source, one poller and one publish/notification", async () => {
    const registrations = [];
    for (let index = 0; index < 3; index++) {
      const registration = register();
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
    expect(vi.getTimerCount()).toBe(4); // Helpers + discovery + real Skill Workshop poller.
    workshops.forEach((live) => live.client.list.mockClear());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(workshops.map((live) => live.client.list.mock.calls.length)).toEqual([0, 0, 1]);
    systems.forEach((live) => live.emit(record)); // Include delivery from closed sockets.
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(JSON.parse(publish.mock.calls[0][1].body)).toMatchObject({
      scope: "operator.approval.requested", data: { proposalId: "proposal" },
    });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(6)); // + expiry and sweep.
    registrations[2].ws.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rapid registrations cancel superseded startup before opening sources", async () => {
    register();
    register();
    register();
    await ready();
    expect(mocks.system).toHaveBeenCalledOnce();
    expect(mocks.workshop).toHaveBeenCalledOnce();
  });

  it("closes pending connections and closes again if startup opens a late socket", async () => {
    const pending = deferred<void>();
    const first = systemConnection();
    first.start.mockImplementation(() => pending.promise);
    mocks.system.mockResolvedValueOnce(first);
    register();
    await vi.waitFor(() => expect(first.start).toHaveBeenCalledOnce());
    register();
    expect(first.stop).toHaveBeenCalledOnce();
    pending.resolve();
    await ready();
    expect(first.stop).toHaveBeenCalledTimes(2);
    expect(workshops).toHaveLength(1);
  });

  it("closes a client factory result that arrives after replacement without starting it", async () => {
    const pending = deferred<ReturnType<typeof systemConnection>>();
    mocks.system.mockReturnValueOnce(pending.promise);
    register();
    await vi.waitFor(() => expect(mocks.system).toHaveBeenCalledOnce());
    register();
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
    register({
      approvals: {
        enabled: true, operatorDid: "did:imajin:operator",
        notifyWebhookSecret: "test-fixture", sources: [sourceId],
      },
    });
    await vi.waitFor(() => expect(live.start).toHaveBeenCalledOnce());
    register({ nodeUrl: undefined });
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
    register();
    await vi.waitFor(() => expect(mocks.preflight).toHaveBeenCalledOnce());
    expect(vi.getTimerCount()).toBe(3);
    register({ nodeUrl: undefined });
    expect(vi.getTimerCount()).toBe(0);
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
    register();
    await ready();
    expect(failed.stop).toHaveBeenCalledOnce();
    register();
    await ready();
    expect(systems).toHaveLength(1);
    expect(systems[0].start).toHaveBeenCalledOnce();
    expect(systems[0].stop).not.toHaveBeenCalled();
  });

  it("stale service/hook callbacks cannot revive old work or stop the new owner", async () => {
    const old = register();
    await ready();
    const current = register();
    await ready();
    await old.ws.start();
    old.discovery.start();
    old.ws.stop();
    for (const hook of ["session_start", "before_agent_start", "agent_end"]) old.emit(hook);
    expect(mocks.sockets[0].start).not.toHaveBeenCalled();
    for (const hook of [mocks.loopHook, mocks.wakeHook, mocks.usageHook]) expect(hook).not.toHaveBeenCalled();
    for (const hook of ["session_start", "before_agent_start", "agent_end"]) current.emit(hook);
    for (const hook of [mocks.loopHook, mocks.wakeHook, mocks.usageHook]) expect(hook).toHaveBeenCalledOnce();
    expect(systems[1].stop).not.toHaveBeenCalled();
    expect(mocks.sockets[1].stop).not.toHaveBeenCalled();
  });

  it("unconfigured registrations still retire previous resources", async () => {
    register();
    await ready();
    register({ nodeUrl: undefined });
    expect(systems[0].stop).toHaveBeenCalledOnce();
    expect(workshops[0].stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop closes late WS startup and ignores late frames/reconnects", async () => {
    const registration = register();
    await ready();
    const pending = deferred<void>();
    const socket = mocks.sockets[0];
    socket.start.mockImplementation(() => pending.promise);
    const start = registration.ws.start();
    registration.ws.stop();
    pending.resolve();
    await start;
    socket.frame?.({ type: "notification", scope: "connector.models.changed" });
    await socket.connected?.();
    expect(socket.stop).toHaveBeenCalledTimes(2);
    expect(systems[0].stop).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it("replacement reconciliation does not re-notify an already published proposal", async () => {
    register();
    await ready();
    systems[0].emit(record);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const replacement = systemConnection();
    replacement.stage(record);
    mocks.system.mockResolvedValueOnce(replacement);
    register();
    await ready();
    expect(publish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(5); // Helpers + poller + restored expiry and sweep.
    replacement.emit(record);
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledOnce();
  });
});
