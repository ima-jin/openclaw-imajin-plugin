import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as ed from "@noble/ed25519";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { registerAgentPlugin } from "./agent-plugin.js";
import { publicKeyDid, type AgentIdentityConfig } from "./agent-identities.js";
import { ImajinClient } from "./client.js";
import { ApprovalBridge, canonicalize, verifyMessage } from "./approval-bridge.js";
import { APPROVALS_STATE_FILENAME } from "./approvals-state.js";
import { APPROVALS_CURSOR_FILENAME } from "./approvals-catchup.js";
import { buildSessionCommandBody, signSessionCommandBody, SESSION_COMMAND_TYPES } from "./session-commands.js";
import { beginRegistration } from "./registration-lifecycle.js";
import * as approvals from "./gateway-approvals-bridge.js";
import type { WsServiceConfig } from "./ws-service.js";
import type { SystemAgentApprovalRequestRecord } from "./sources/system-agent.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), system: vi.fn(), exec: vi.fn(), loopback: vi.fn(),
  sockets: [] as Array<{
    config: WsServiceConfig; frame?: (frame: any) => void; connected?: () => Promise<void>;
    send: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("openclaw/plugin-sdk/secret-ref-runtime", () => ({ resolveSecretRefValues: mocks.resolve }));
vi.mock("./sources/system-agent.js", async (original) => ({
  ...await original<object>(), createLiveGatewayApprovalsClient: mocks.system,
}));
vi.mock("./sources/gateway-exec.js", async (original) => ({
  ...await original<object>(), createLiveGatewayExecConnection: mocks.exec,
}));
vi.mock("./session-command-gateway.js", async (original) => ({
  ...await original<object>(), createLoopbackSessionGateway: mocks.loopback,
}));
vi.mock("./imajin-provider.js", () => ({
  registerImajinProvider: () => ({ baseUrl: "http://proxy.invalid", cache: {}, discovery: {} }),
}));
vi.mock("./notification-injector.js", () => ({
  WAKE_RUNTIME_HOOKS: [],
  createNotificationInjector: () => ({
    inject: vi.fn(), dispose: vi.fn(), reportWake: vi.fn(), runtimeHooks: {},
  }),
}));
vi.mock("./reach-events.js", () => ({
  isReachFrame: () => false,
  createReachEventHandler: () => ({ dispose: vi.fn() }),
}));
vi.mock("./ws-service.js", async (original) => ({
  ...await original<object>(),
  ImajinWsService: class {
    socket: (typeof mocks.sockets)[number];
    constructor(config: WsServiceConfig) {
      this.socket = { config, send: vi.fn(), stop: vi.fn() };
      mocks.sockets.push(this.socket);
    }
    start = vi.fn(async () => {});
    stop() { this.socket.stop(); }
    send(frame: unknown) { this.socket.send(frame); }
    onFrame(handler: (frame: any) => void) { this.socket.frame = handler; }
    onConnected(handler: () => Promise<void>) { this.socket.connected = handler; }
  },
}));

async function key() {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = Buffer.from(await ed.getPublicKeyAsync(privateKey)).toString("hex");
  return { did: publicKeyDid(publicKey), publicKey, privateKey: Buffer.from(privateKey).toString("hex") };
}

function systemConnection() {
  const expiresAtMs = Date.now() + 60_000;
  return {
    start: vi.fn(async () => {}), stop: vi.fn(),
    client: {
      list: vi.fn(async (): Promise<SystemAgentApprovalRequestRecord[]> => []),
      get: vi.fn(async () => ({
        status: "pending", expiresAtMs, presentation: { proposalHash: "revision" },
      })),
      resolve: vi.fn(async () => ({ applied: true })), onRequested: vi.fn(),
    },
  };
}

describe("map-mode gateway principal (#139)", () => {
  let main: Awaited<ReturnType<typeof key>>;
  let tenant: Awaited<ReturnType<typeof key>>;
  let kernel: Awaited<ReturnType<typeof key>>;
  let agents: Record<string, AgentIdentityConfig>;
  let dir: string;
  let system: ReturnType<typeof systemConnection>;
  let gateway: { send: ReturnType<typeof vi.fn>; spawn: ReturnType<typeof vi.fn>; resolveApproval: ReturnType<typeof vi.fn> };
  let wire: Array<{ path: string; body: any; headers: Record<string, string> }>;
  let bridgeStart: MockInstance<typeof approvals.startGatewayApprovalsBridge>;
  let caughtUp: object[];

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.sockets.length = 0;
    for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
    [main, tenant, kernel] = await Promise.all([key(), key(), key()]);
    dir = await mkdtemp(join(tmpdir(), "gateway-principal-"));
    agents = Object.fromEntries(([["main", main], ["tenant", tenant]] as const).map(([id, identity]) => [id, {
      did: identity.did, actAs: "did:imajin:operator",
      keypair: { source: id === "main" ? "store" : "exec", provider: "sealed", id },
      wsNotifications: { stateDir: dir },
    }]));
    mocks.resolve.mockImplementation(async ([ref]) => new Map([["ref", ref.id === "main" ? main : tenant]]));
    system = systemConnection();
    mocks.system.mockResolvedValue(system);
    gateway = {
      send: vi.fn(async () => ({ runId: "run" })),
      spawn: vi.fn(async () => ({ sessionKey: "agent:main:child" })),
      resolveApproval: vi.fn(async () => ({ applied: true, kind: "exec" })),
    };
    mocks.loopback.mockReturnValue({ gateway, start: vi.fn(async () => {}), dispose: vi.fn() });
    vi.spyOn(ImajinClient.prototype, "getServiceOf").mockResolvedValue(["did:imajin:operator"]);
    vi.spyOn(ImajinClient.prototype, "getIdentity").mockResolvedValue({
      did: "did:imajin:operator", scope: "actor", subtype: "human", publicKey: kernel.publicKey,
    });
    wire = [];
    caughtUp = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      wire.push({ path, body, headers: init?.headers as Record<string, string> });
      if (path.endsWith("/challenge")) return Response.json({ challengeId: body.did, challenge: "challenge" });
      if (path.endsWith("/verify")) {
        const identity = body.challengeId === main.did ? main : tenant;
        expect(await ed.verifyAsync(Buffer.from(body.signature, "hex"), new TextEncoder().encode("challenge"),
          Buffer.from(identity.publicKey, "hex"))).toBe(true);
        return Response.json({}, { headers: { "set-cookie": `session=${identity.did}` } });
      }
      const cursor = new URL(url).searchParams.get("cursor") ?? "0";
      const events = cursor === "0" ? caughtUp : [];
      return Response.json({ events, nextCursor: caughtUp.length ? "1" : "0", entitledEventTypes: ["operator.approval.decided"] });
    }));
    bridgeStart = vi.spyOn(approvals, "startGatewayApprovalsBridge");
  });

  it("pins main for send/spawn and rejects an unexpected tenant spawn result without registering its loop", async () => {
    await ready(register());
    mocks.sockets[0].frame?.(await command("session.send", { sessionKey: "agent:main:main", message: "test" }));
    await vi.waitFor(() => expect(mocks.sockets[0].send).toHaveBeenCalledTimes(1));
    expect(gateway.send).toHaveBeenCalledWith(expect.objectContaining({ agentId: "main" }));
    mocks.sockets[0].frame?.(await command("session.spawn", { task: "test" }));
    await vi.waitFor(() => expect(mocks.sockets[0].send).toHaveBeenCalledTimes(2));
    expect(gateway.spawn).toHaveBeenCalledWith(expect.objectContaining({ agentId: "main" }));
    expect(mocks.sockets[0].send.mock.calls[1][0].type).toBe("loop.session.spawn.completed");
    gateway.spawn.mockResolvedValueOnce({ sessionKey: "agent:tenant:child" });
    mocks.sockets[0].frame?.(await command("session.spawn", { task: "test" }));
    await vi.waitFor(() => expect(mocks.sockets[0].send).toHaveBeenCalledTimes(3));
    const failure = mocks.sockets[0].send.mock.calls[2][0].attestation.payload;
    expect(failure.reason).toBe("loop_target_mismatch");
    expect(failure.childLoopId).toBeUndefined();
  });

  it("runs gateway-exec preflight and publishes native approvals as the selected DID", async () => {
    const record = {
      id: "native-exec", createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
      request: { command: "test", host: "gateway", cwd: "/workspace", agentId: "main", sessionKey: "agent:main:main" },
    };
    const exec = {
      start: vi.fn(async () => {}), stop: vi.fn(),
      client: {
        list: vi.fn(async () => [record]), resolve: vi.fn(async () => ({ applied: true })),
        onRequested: vi.fn(), onFinished: vi.fn(),
      },
    };
    mocks.exec.mockResolvedValue(exec);
    const registration = register({
      approvals: { enabled: true, operatorDid: "did:imajin:operator", sources: ["gateway-exec"],
        notifyWebhookSecret: randomUUID() },
    });
    await registration.start();
    await vi.waitFor(() => expect(wire.some((row) => row.body?.scope === "operator.approval.requested")).toBe(true));
    const data = wire.find((row) => row.body?.scope === "operator.approval.requested")!.body.data;
    expect(data.signerDid).toBe(main.did);
    expect(data.detail.requestedBy).toBe(main.did);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[imajin-approvals-bridge]"));
    expect(mocks.sockets[1].send).not.toHaveBeenCalled();
    await registration.stop();
    expect(exec.stop).toHaveBeenCalledOnce();
  });
  afterEach(async () => {
    await beginRegistration().dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function register(overrides: Record<string, unknown> = {}) {
    const services: any[] = [];
    const config = {
      nodeUrl: "https://kernel.invalid", agents, gatewayAgent: "main",
      approvals: { enabled: true, operatorDid: "did:imajin:operator", sources: ["system-agent"],
        notifyWebhookSecret: randomUUID() },
      sessionCommands: { enabled: true, kernelPublicKeyHex: kernel.publicKey },
      ...overrides,
    };
    const registration = registerAgentPlugin({
      registrationMode: "full", config: {}, registerProvider: vi.fn(), registerTool: vi.fn(), on: vi.fn(),
      registerService: (service: any) => services.push(service),
    }, config);
    return { ...registration, start: () => services[0].start(), stop: () => services[0].stop() };
  }

  async function ready(registration: ReturnType<typeof register>) {
    await registration.start();
    await vi.waitFor(() => expect(system.client.onRequested).toHaveBeenCalled());
    await mocks.sockets[0].connected?.();
  }

  async function command(type: string, payload: object, overrides: Record<string, unknown> = {}) {
    const frame: any = {
      type, commandId: randomUUID(), to: main.did, principal: "did:imajin:operator", issuer: kernel.did,
      issuedAt: new Date().toISOString(), payload, ...overrides,
    };
    frame.signature = await signSessionCommandBody(buildSessionCommandBody(frame), kernel.privateKey);
    frame.countersignature = frame.signature;
    return frame;
  }

  it.each(["live", "catch-up"])("resolves an approval only through main via %s, signs its digest and scopes durable state", async (transport) => {
    const registration = register({ did: tenant.did, keypairPath: "/must-not-read", actAs: tenant.did });
    expect(registration.getGatewayIdentity()).toBeUndefined();
    await ready(registration);
    const identity = registration.getGatewayIdentity()!;
    expect(identity.agentId).toBe("main");
    expect(identity.config.did).toBe(main.did);
    const deps = bridgeStart.mock.calls[0][2];
    expect(deps.identityClient).toBe(identity.client);
    expect(deps.kernelHttp).toBe(identity.client);
    expect(deps.signer).toBe(identity.signer);
    expect(deps.keypairPath).toBeUndefined();
    expect(deps.stateDir).toBe(join(dir, "main"));
    const preflights = wire.filter((row) => row.path.includes("catchup"));
    expect(preflights.length).toBeGreaterThan(0);
    expect(preflights.every((row) => row.headers["X-Agent-DID"] === main.did)).toBe(true);
    const snapshot = await system.client.get();
    const record: SystemAgentApprovalRequestRecord = {
      id: "proposal", createdAtMs: Date.now(), expiresAtMs: snapshot.expiresAtMs,
      request: { title: "Restart", description: "Restart", command: "restart", proposalHash: "revision", allowedDecisions: ["allow-once", "deny"] },
    };
    system.client.list.mockResolvedValue([record]);
    system.client.onRequested.mock.calls[0][0](record);
    await vi.waitFor(() => expect(wire.some((row) => row.body?.scope === "operator.approval.requested")).toBe(true));
    const data = wire.find((row) => row.body?.scope === "operator.approval.requested")!.body.data;
    const { signature, signerDid, contentHash: _hash, ...digest } = data;
    expect(signerDid).toBe(main.did);
    expect(await ed.verifyAsync(Buffer.from(signature, "hex"), new TextEncoder().encode(canonicalize(digest)),
      Buffer.from(main.publicKey, "hex"))).toBe(true);
    const decision = {
      type: "bus_event", eventType: "operator.approval.decided",
      issuer: "did:imajin:operator", subject: main.did, scope: "operator",
      payload: { proposalId: "proposal", decidedBy: "did:imajin:operator", decision: "approve", contentHash: data.contentHash },
    };
    mocks.sockets[1].frame?.(decision);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(system.client.resolve).not.toHaveBeenCalled();
    if (transport === "live") mocks.sockets[0].frame?.(decision);
    else {
      caughtUp = [{
        ...decision, id: "event-1", cursor: "1", correlationId: null,
        occurredAt: new Date().toISOString(), grantId: "grant",
      }];
      expect(mocks.sockets[1].connected).toBeUndefined();
      await mocks.sockets[0].connected?.();
    }
    await vi.waitFor(() => expect(system.client.resolve).toHaveBeenCalledOnce());
    await vi.waitFor(async () => {
      const state = JSON.parse(await readFile(join(dir, "main", APPROVALS_STATE_FILENAME), "utf8"));
      expect(state.agentDid).toBe(main.did);
      expect(state.outcomes.proposal).toBe("applied");
    });
    if (transport === "catch-up") {
      const cursor = JSON.parse(await readFile(join(dir, "main", APPROVALS_CURSOR_FILENAME), "utf8"));
      expect(cursor.agentDid).toBe(main.did);
      expect(cursor.cursor).toBe("1");
    }
    expect(mocks.sockets[1].send).not.toHaveBeenCalled();
    await registration.stop();
    expect(registration.getGatewayIdentity()).toBeUndefined();
  });

  it("ignores every command/approval frame on tenant sockets, including main-addressed valid commands", async () => {
    const handler = vi.spyOn(ApprovalBridge.prototype, "handleFrame");
    await ready(register({ approvalBridge: { pinnedApproverPublicKeyHex: kernel.publicKey } }));
    for (const type of [...SESSION_COMMAND_TYPES, "approval.decision", "bus_event"]) {
      mocks.sockets[1].frame?.(await command(type, { sessionKey: "agent:main:main", message: "test" }));
    }
    expect(gateway.send).not.toHaveBeenCalled();
    expect(gateway.resolveApproval).not.toHaveBeenCalled();
    expect(mocks.sockets[0].send).not.toHaveBeenCalled();
    expect(mocks.sockets[1].send).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("executes a verified session command on main and cryptographically attests only on main's socket", async () => {
    await ready(register());
    mocks.sockets[0].frame?.(await command("session.approve", { approvalId: "native", kind: "exec" }));
    await vi.waitFor(() => expect(mocks.sockets[0].send).toHaveBeenCalledOnce());
    expect(gateway.resolveApproval).toHaveBeenCalledWith({ id: "native", kind: "exec", decision: "allow-once" });
    const result = mocks.sockets[0].send.mock.calls[0][0];
    expect(result).toMatchObject({ type: "loop.session.approve.completed", attestation: { from: main.did } });
    expect(await verifyMessage(result.attestation, main.publicKey)).toBe(true);
    expect(await verifyMessage(result.attestation, tenant.publicKey)).toBe(false);
    expect(mocks.sockets[1].send).not.toHaveBeenCalled();
  });

  it.each([undefined, { enabled: false, kernelPublicKeyHex: "unused" }, { enabled: true }])(
    "does not accept session commands without explicit opt-in and a kernel pin %#", async (sessionCommands) => {
      await ready(register({ sessionCommands }));
      mocks.sockets[0].frame?.(await command("session.approve", { approvalId: "native" }));
      expect(mocks.loopback).not.toHaveBeenCalled();
      expect(gateway.resolveApproval).not.toHaveBeenCalled();
      expect(mocks.sockets[0].send).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "absent", " main", "__proto__", 1, null])(
    "missing or invalid gatewayAgent disables both features without legacy fallback %#", async (gatewayAgent) => {
      const registration = register({ gatewayAgent, did: main.did, keypairPath: "/must-not-read" });
      await registration.start();
      expect(bridgeStart).not.toHaveBeenCalled();
      expect(mocks.loopback).not.toHaveBeenCalled();
      expect(registration.getGatewayIdentity()).toBeUndefined();
      expect(console.warn).toHaveBeenCalledWith("[imajin-plugin] gatewayAgent unavailable; approvals and session commands disabled");
      for (const socket of mocks.sockets) {
        socket.frame?.(await command("session.approve", { approvalId: "native" }));
        expect(socket.send).not.toHaveBeenCalled();
      }
      expect(gateway.resolveApproval).not.toHaveBeenCalled();
    },
  );

  it.each(["unresolved", "invalid", "duplicate-did", "duplicate-ref"])("fails closed for %s gateway identity", async (failure) => {
    if (failure === "unresolved") mocks.resolve.mockRejectedValueOnce(new Error("provider detail must remain private"));
    if (failure === "invalid") agents.main.keypair = { source: "file", provider: "sealed", id: "main" } as any;
    if (failure === "duplicate-did") agents.tenant.did = main.did;
    if (failure === "duplicate-ref") agents.tenant.keypair = agents.main.keypair;
    const registration = register({ did: main.did, keypairPath: "/must-not-read" });
    await registration.start();
    expect(registration.getGatewayIdentity()).toBeUndefined();
    expect(bridgeStart).not.toHaveBeenCalled();
    expect(mocks.loopback).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[imajin-plugin] gatewayAgent unavailable; approvals and session commands disabled");
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).not.toContain("provider detail");
  });

  it.each([
    ["session.send", { sessionKey: "agent:tenant:main", message: "test" }],
    ["session.send", { sessionKey: "agent:main:main", agentId: "tenant", message: "test" }],
    ["session.spawn", { task: "test", agentId: "tenant" }],
    ["session.spawn", { task: "test", parentSessionKey: "agent:tenant:main" }],
  ])("refuses tenant activity addressed to main: %s %#", async (type, payload) => {
    await ready(register());
    mocks.sockets[0].frame?.(await command(type as string, payload as object));
    await vi.waitFor(() => expect(mocks.sockets[0].send).toHaveBeenCalledOnce());
    expect(mocks.sockets[0].send.mock.calls[0][0].attestation.payload.reason).toBe("loop_target_mismatch");
    expect(gateway.send).not.toHaveBeenCalled();
    expect(gateway.spawn).not.toHaveBeenCalled();
  });

  it("still rejects a wrong kernel signer and a tenant-addressed command delivered to main", async () => {
    await ready(register());
    const wrong = await command("session.approve", { approvalId: "bad" });
    wrong.signature = await signSessionCommandBody(buildSessionCommandBody(wrong), tenant.privateKey);
    mocks.sockets[0].frame?.(wrong);
    await vi.waitFor(() => expect(mocks.sockets[0].send).toHaveBeenCalledTimes(1));
    expect(mocks.sockets[0].send.mock.calls[0][0].attestation.payload.reason).toBe("invalid_signature");
    mocks.sockets[0].frame?.(await command("session.approve", { approvalId: "bad" }, { to: tenant.did }));
    await vi.waitFor(() => expect(mocks.sockets[0].send).toHaveBeenCalledTimes(2));
    expect(mocks.sockets[0].send.mock.calls[1][0].attestation.payload.reason).toBe("misaddressed");
    expect(gateway.resolveApproval).not.toHaveBeenCalled();
  });

  it("exposes an exec-backed gateway signer, selects only the named entry and retires it on replacement", async () => {
    const registration = register({ gatewayAgent: "tenant", approvals: undefined, sessionCommands: undefined });
    await registration.start();
    expect(registration.getGatewayIdentity()?.config.did).toBe(tenant.did);
    expect(registration.getGatewayIdentity()?.ws).toBeDefined();
    await register({ gatewayAgent: undefined }).start();
    expect(registration.getGatewayIdentity()).toBeUndefined();
    mocks.sockets[1].frame?.({ type: "session.approve" });
    expect(gateway.resolveApproval).not.toHaveBeenCalled();
  });

  it("declares gateway selection and command settings in the manifest and documents rollout/identity boundaries", async () => {
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const selection = manifest.configSchema.properties.gatewayAgent;
    expect(selection.type).toBe("string");
    const pattern = new RegExp(selection.pattern);
    expect(pattern.test("main")).toBe(true);
    for (const invalid of ["", "Main", "../main", " main", "a".repeat(65)]) expect(pattern.test(invalid)).toBe(false);
    expect(manifest.configSchema.properties.sessionCommands.additionalProperties).toBe(false);
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    for (const required of ['gatewayAgent: "main"', "epic #138", "never a fallback", "sealed"]) {
      expect(readme.toLowerCase()).toContain(required.toLowerCase());
    }
  });
});
