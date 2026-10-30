import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsServiceConfig } from "./ws-service.js";
import type { WsNotificationsConfig } from "./notification-injector.js";
import { AGENT_TOOL_NAMES, type AgentIdentityConfig } from "./agent-identities.js";
import { beginRegistration } from "./registration-lifecycle.js";
import { ImajinClient } from "./client.js";

const mocks = vi.hoisted(() => ({
  signer: vi.fn(),
  sockets: [] as Array<{ config: WsServiceConfig; frame?: (frame: any) => void; stop: ReturnType<typeof vi.fn> }>,
  injectors: [] as Array<{
    config: WsNotificationsConfig; inject: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>;
    hook: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; report: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({ definePluginEntry: (entry: unknown) => entry }));
vi.mock("./agent-identities.js", async (original) => ({
  ...await original<object>(), resolveAgentSigner: mocks.signer,
}));
vi.mock("./notification-injector.js", () => ({
  WAKE_RUNTIME_HOOKS: ["before_agent_run"],
  createNotificationInjector: (_api: unknown, config: WsNotificationsConfig) => {
    const injector = {
      config, inject: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
      hook: vi.fn(), end: vi.fn(async () => {}), report: vi.fn(async () => {}),
    };
    mocks.injectors.push(injector);
    return {
      inject: injector.inject, dispose: injector.dispose, runtimeHooks: { before_agent_run: injector.hook },
      onAgentEnd: injector.end, reportWake: injector.report,
    };
  },
}));
vi.mock("./reach-events.js", () => ({
  isReachFrame: () => false,
  createReachEventHandler: () => ({ handle: vi.fn(), dispose: vi.fn() }),
}));
vi.mock("./ws-service.js", async (original) => ({
  ...await original<object>(),
  ImajinWsService: class {
    socket: (typeof mocks.sockets)[number];
    constructor(config: WsServiceConfig) {
      this.socket = { config, stop: vi.fn() };
      mocks.sockets.push(this.socket);
    }
    start = vi.fn(async () => {});
    stop() { this.socket.stop(); }
    send = vi.fn();
    onFrame(handler: (frame: any) => void) { this.socket.frame = handler; }
  },
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readFile: (...args: any[]) => args[0] === "/legacy-public-only.json"
      ? Promise.resolve(JSON.stringify({ did: "did:imajin:legacy", publicKey: "public-only" }))
      : (fs.readFile as any)(...args),
  };
});
import plugin from "../index.js";

function agent(id: string, tools?: string[]): AgentIdentityConfig {
  return {
    did: `did:imajin:${id}`, actAs: `did:imajin:org-${id}`,
    keypair: { source: "store", provider: "sealed", id },
    tools,
  };
}

function register(config: any, registrationMode = "full") {
  const tools: any[] = [];
  const services: any[] = [];
  const hooks: Array<{ name: string; handler: (...args: any[]) => unknown }> = [];
  plugin.register({
    pluginConfig: config, registrationMode, config: { secrets: {} },
    registerProvider: vi.fn(),
    registerTool: (tool: any) => tools.push(tool),
    registerService: (service: any) => services.push(service),
    on: (name: string, handler: any) => hooks.push({ name, handler }),
    registerHook: (name: string, handler: any) => hooks.push({ name, handler }),
  });
  return {
    tools, services,
    agentTools: (ctx: any) => tools.flatMap((tool) => typeof tool === "function" ? tool(ctx) ?? [] : [tool]),
    emit: (name: string, event: object, ctx?: object) => hooks.filter((hook) => hook.name === name)
      .map((hook) => hook.handler(event, ctx)),
    start: async () => { for (const service of services) await service.start(); },
    stop: async () => { for (const service of services) await service.stop(); },
  };
}

beforeEach(() => {
  mocks.sockets.length = mocks.injectors.length = 0;
  mocks.signer.mockReset().mockImplementation(async (_config, _ref, did) => ({
    did, signChallenge: async (challenge: string) => `fake:${did}:${challenge}`,
  }));
});
afterEach(async () => {
  await beginRegistration().dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("per-agent plugin registration", () => {
  it("fails closed for unknown agents even with a complete main identity configured", async () => {
    const registry = register({
      nodeUrl: "https://kernel.invalid", did: "did:imajin:legacy", keypairPath: "/must-not-read",
      actAs: "did:imajin:legacy-org", agents: { main: agent("main") },
    });
    expect(registry.agentTools({ agentId: "main" })).toEqual([]); // Secret not resolved yet.
    await registry.start();
    for (const ctx of [{}, { agentId: "missing" }, { sessionKey: "agent:main:session" }]) {
      expect(registry.agentTools(ctx)).toEqual([]);
    }
    expect(registry.agentTools({ agentId: "main" }).map((tool) => tool.name).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
    expect(mocks.signer).toHaveBeenCalledTimes(1);
    expect(mocks.signer.mock.calls[0][1]).toEqual(agent("main").keypair);
  });

  it.each([{}, null, [], "invalid"])("an empty or invalid agents map never enables legacy tools %#", async (agents) => {
    const registry = register({ nodeUrl: "https://kernel.invalid", did: "did:imajin:main", keypairPath: "/unused", agents });
    await registry.start();
    expect(registry.agentTools({ agentId: "main" })).toEqual([]);
    expect(mocks.signer).not.toHaveBeenCalled();
  });

  it("disables unresolved agents only, without borrowing another identity", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.signer.mockRejectedValueOnce(new Error("unavailable"));
    const registry = register({ nodeUrl: "https://kernel.invalid", agents: { main: agent("main"), tenant: agent("tenant") } });
    await registry.start();
    expect(registry.agentTools({ agentId: "main" })).toEqual([]);
    expect(registry.agentTools({ agentId: "tenant" })).toHaveLength(AGENT_TOOL_NAMES.length);
    expect(mocks.sockets.map((socket) => socket.config.did)).toEqual(["did:imajin:tenant"]);
  });

  it("applies exact allowlists to all tools, including status, build tools and wake reports", async () => {
    const registry = register({
      nodeUrl: "https://kernel.invalid",
      approvals: { enabled: true }, approvalBridge: { pinnedApproverPublicKeyHex: "public-only" },
      agents: { main: agent("main"), tenant: agent("tenant", ["imajin_identity"]), empty: agent("empty", []) },
    });
    await registry.start();
    expect(registry.agentTools({ agentId: "tenant" }).map((tool) => tool.name)).toEqual(["imajin_identity"]);
    expect(registry.agentTools({ agentId: "empty" })).toEqual([]);
    expect(registry.agentTools({ agentId: "main" }).map((tool) => tool.name)).toContain("imajin_warp");
    // No Gateway-global approval/session-command bridges are registered in map mode.
    expect(registry.services.map((service) => service.id)).toEqual(["imajin-ws"]);
  });

  it("routes sockets, wake/report config and hook events independently", async () => {
    const main = agent("main");
    const tenant = agent("tenant");
    tenant.wsNotifications = { reportTo: ["agent:tenant:operator"], wakeSessionKey: "agent:tenant:custom" };
    const registry = register({
      nodeUrl: "https://kernel.invalid", agents: { main, tenant },
      wsNotifications: { reportTo: ["agent:main:private"], targetSession: "agent:main:private" },
    });
    await registry.start();
    expect(mocks.injectors.map((injector) => injector.config)).toMatchObject([
      { targetSession: "agent:main:warp-events", hookAgentId: "main" },
      { targetSession: "agent:tenant:warp-events", wakeSessionKey: "agent:tenant:custom",
        reportTo: ["agent:tenant:operator"], hookAgentId: "tenant" },
    ]);
    expect(mocks.injectors[0].config.reportTo).toBeUndefined();
    const frame = { type: "notification", id: "n", scope: "warp.run.completed", title: "Completed" };
    mocks.sockets[1].frame?.(frame);
    expect(mocks.injectors[1].inject).toHaveBeenCalledWith(frame);
    expect(mocks.injectors[0].inject).not.toHaveBeenCalled();
    registry.emit("before_agent_run", {}, { agentId: "tenant", sessionKey: "agent:tenant:custom" });
    expect(mocks.injectors[1].hook).toHaveBeenCalledOnce();
    expect(mocks.injectors[0].hook).not.toHaveBeenCalled();
    await Promise.all(registry.emit("agent_end", { sessionKey: "agent:tenant:custom" }));
    expect(mocks.injectors[1].end).toHaveBeenCalledOnce();
    expect(mocks.injectors[0].end).not.toHaveBeenCalled();
    const report = registry.agentTools({ agentId: "tenant" }).find((tool) => tool.name === "imajin_wake_report");
    await report.execute("report", { outcome: "blocked", message: "Waiting for operator" });
    expect(mocks.injectors[1].report).toHaveBeenCalledOnce();
    expect(mocks.injectors[0].report).not.toHaveBeenCalled();
  });

  it("a registered tool and WS transport use the same agent-scoped client/session", async () => {
    const wire: Array<{ path: string; body: any; headers: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      wire.push({ path, body, headers: init?.headers });
      if (path.endsWith("/challenge")) return Response.json({
        challengeId: body.did, challenge: body.did, expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      if (path.endsWith("/verify")) {
        expect(body.signature).toBe(`fake:${body.challengeId}:${body.challengeId}`);
        return Response.json({}, { headers: { "set-cookie": `session=${body.challengeId}` } });
      }
      return Response.json({ did: "did:imajin:lookup", scope: "actor", subtype: "agent" });
    }));
    const registry = register({ nodeUrl: "https://kernel.invalid", agents: { main: agent("main"), tenant: agent("tenant") } });
    await registry.start();
    for (const [index, id] of ["main", "tenant"].entries()) {
      const tool = registry.agentTools({ agentId: id }).find((entry) => entry.name === "imajin_identity");
      await tool.execute("call", { action: "lookup", query: "did:imajin:lookup" });
      expect(await mocks.sockets[index].config.authenticate?.()).toBe(`session=did:imajin:${id}`);
    }
    expect(wire.filter((row) => row.path.endsWith("/challenge")).map((row) => row.body.did))
      .toEqual(["did:imajin:main", "did:imajin:tenant"]);
    expect(wire.filter((row) => row.path.includes("/lookup/")).map((row) => row.headers))
      .toEqual(["main", "tenant"].map((id) => ({
        Accept: "application/json", Cookie: `session=did:imajin:${id}`,
        "X-Agent-DID": `did:imajin:${id}`, "X-Acting-For": `did:imajin:org-${id}`,
      })));
  });

  it("inert metadata registries reach the active owner without resolving more secrets", async () => {
    const config = { nodeUrl: "https://kernel.invalid", agents: { tenant: agent("tenant") } };
    const active = register(config);
    await active.start();
    const metadata = register(config, "tool-discovery");
    await metadata.start();
    expect(metadata.agentTools({ agentId: "tenant" })).toHaveLength(AGENT_TOOL_NAMES.length);
    expect(mocks.signer).toHaveBeenCalledOnce();
    await metadata.stop();
    expect(active.agentTools({ agentId: "tenant" })).toHaveLength(AGENT_TOOL_NAMES.length);
  });

  it("retained tools and late socket frames fail closed after stop/replacement", async () => {
    const registry = register({ nodeUrl: "https://kernel.invalid", agents: { tenant: agent("tenant") } });
    await registry.start();
    const tool = registry.agentTools({ agentId: "tenant" })[0];
    await registry.stop();
    expect(() => tool.execute("call", {})).toThrow("no longer active");
    expect(registry.agentTools({ agentId: "tenant" })).toEqual([]);
    mocks.sockets[0].frame?.({ type: "notification", id: "late", scope: "x", title: "late" });
    expect(mocks.injectors[0].inject).not.toHaveBeenCalled();
    expect(mocks.sockets[0].stop).toHaveBeenCalledOnce();
    expect(mocks.injectors[0].dispose).toHaveBeenCalledOnce();
  });

  it("legacy config without agents preserves DID, tool set and notification targets", async () => {
    vi.spyOn(ImajinClient.prototype as any, "signChallenge").mockResolvedValue("fake-legacy-signature");
    const wire: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      wire.push({ url, body, headers: init?.headers });
      if (url.endsWith("/challenge")) return Response.json({ challengeId: "legacy", challenge: "public-challenge" });
      if (url.endsWith("/verify")) return Response.json({}, { headers: { "set-cookie": "session=legacy" } });
      return Response.json({ did: "did:imajin:lookup", scope: "actor", subtype: "agent" });
    }));
    const config = {
      nodeUrl: "https://kernel.invalid", did: "did:imajin:legacy",
      keypairPath: "/legacy-public-only.json", actAs: "did:imajin:legacy-org",
      warp: { usdPerCredit: 0.02 },
      wsNotifications: { wakeSessionKey: "agent:main:custom", reportTo: ["agent:main:operator"] },
    };
    const registry = register(config);
    expect(registry.tools.filter((tool) => typeof tool !== "function").map((tool) => tool.name).sort())
      .toEqual(AGENT_TOOL_NAMES.filter((name) => name !== "imajin_wake_report").sort());
    await registry.tools.find((tool) => tool.name === "imajin_identity")
      .execute("legacy", { action: "lookup", query: "did:imajin:lookup" });
    expect(wire[0].body).toEqual({ did: "did:imajin:legacy" });
    expect(wire[1].body.signature).toBe("fake-legacy-signature");
    expect(wire[2].headers).toMatchObject({ "X-Agent-DID": config.did, "X-Acting-For": config.actAs });
    // Existing registration-runtime tests exercise legacy startup, including notification config.
    expect(mocks.signer).not.toHaveBeenCalled();
    expect(config.wsNotifications.wakeSessionKey).toBe("agent:main:custom");
  });
});
