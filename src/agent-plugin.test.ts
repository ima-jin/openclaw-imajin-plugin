import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsServiceConfig } from "./ws-service.js";
import type { WsNotificationsConfig } from "./notification-injector.js";
import { AGENT_TOOL_NAMES, type AgentIdentityConfig } from "./agent-identities.js";
import { beginRegistration } from "./registration-lifecycle.js";
import { ImajinClient } from "./client.js";
import { randomUUID } from "node:crypto";
import { AgentInferenceAuth } from "./inference-auth.js";

const mocks = vi.hoisted(() => ({
  signer: vi.fn(),
  sockets: [] as Array<{ config: WsServiceConfig; frame?: (frame: any) => void; stop: ReturnType<typeof vi.fn> }>,
  injectors: [] as Array<{
    config: WsNotificationsConfig; inject: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>;
    hook: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; report: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({ definePluginEntry: (entry: unknown) => entry }));
vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveAgentDir: (_config: unknown, id: string) => `/agents/${id}/agent`,
}));
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
    status = () => ({ state: "open" });
    onConnected = vi.fn();
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

describe("provider signing lifecycle (#150)", () => {
  it("uses resolved map identities only and retires captured hooks on stop", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(ImajinClient.prototype, "requestRaw").mockResolvedValue({
      status: 200, contentType: "application/json", text: JSON.stringify({ data: [] }),
    });
    const registry = register({
      nodeUrl: "https://kernel.invalid", gatewayAgent: "main",
      agents: { main: agent("main"), artifact: agent("artifact") },
      modelDiscovery: { refreshIntervalMs: 0 }, loops: { enabled: false }, attestation: { enabled: false },
    });
    for (const provider of registry.providers) {
      expect(() => provider.wrapStreamFn({ agentId: "artifact", streamFn: vi.fn() })).toThrow("agents.artifact");
    }
    await registry.start();
    const provider = registry.providers.find((entry) => entry.id === "imajin-openai");
    const wrapped = provider.wrapStreamFn({ agentId: "artifact", streamFn: vi.fn() });
    expect(typeof wrapped).toBe("function");
    expect(() => provider.wrapStreamFn({ agentId: "absent", streamFn: vi.fn() })).toThrow("agents.absent");
    await registry.stop();
    await expect(wrapped({}, {})).rejects.toThrow("agents.artifact");
  });
});

function agent(id: string, tools?: string[]): AgentIdentityConfig {
  return {
    did: `did:imajin:${id}`, actAs: `did:imajin:org-${id}`,
    keypair: { source: "store", provider: "sealed", id },
    tools,
  };
}

function register(config: any, registrationMode = "full", runtime?: unknown) {
  const tools: any[] = [];
  const services: any[] = [];
  const providers: any[] = [];
  const hooks: Array<{ name: string; handler: (...args: any[]) => unknown }> = [];
  plugin.register({
    pluginConfig: config, registrationMode, config: { secrets: {} }, runtime,
    registerProvider: (provider: any) => providers.push(provider),
    registerTool: (tool: any) => tools.push(tool),
    registerService: (service: any) => services.push(service),
    on: (name: string, handler: any) => hooks.push({ name, handler }),
    registerHook: (name: string, handler: any) => hooks.push({ name, handler }),
  });
  return {
    tools, services, providers,
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("identity discovery admission across entry points (#170)", () => {
  const entryPoints = ["auto-routing", "model.primary", "sessions_send", "openclaw agent"] as const;
  const discoveryStates = [
    "connection_not_loaded", "connection_unavailable", "network", "ok", "empty", "malformed",
  ] as const;
  type DiscoveryState = typeof discoveryStates[number];

  async function routingFixture(entryPoint: typeof entryPoints[number], state: DiscoveryState, actAs?: string) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(AgentInferenceAuth.prototype, "credential").mockResolvedValue({
      token: "fixture-artifact", expiresAt: Date.now() + 600_000,
    });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).endsWith("/infer/v1/models/usable")) return Response.json({ ok: true });
      if (state === "network") throw new Error("private transport detail");
      if (state === "connection_not_loaded" || state === "connection_unavailable") {
        return Response.json({ error: { code: state, message: "Kernel connection refused" } }, { status: 403 });
      }
      if (state === "malformed") return Response.json({ unexpected: [] });
      return Response.json({ data: state === "empty" ? [] : [
        { id: "claude-sonnet-5-5", owned_by: "anthropic", imajin: { picked: true } },
      ] });
    });
    vi.stubGlobal("fetch", fetcher);
    const hostConfig = { agents: {
      defaults: { model: "anthropic/claude-sonnet-5-5", modelPolicy: { allow: ["imajin/*"] } },
      list: entryPoint === "auto-routing" ? [] : [
        { id: "artifact", model: { primary: "anthropic/claude-sonnet-5-5" } },
      ],
    } };
    const registry = register({
      nodeUrl: "https://kernel.invalid", gatewayAgent: "main",
      agents: { artifact: { ...agent("artifact"), actAs } },
      modelDiscovery: { refreshIntervalMs: 0 }, loops: { enabled: false }, attestation: { enabled: false },
    }, "full", { config: { current: () => hostConfig } });
    await registry.start();
    const ctx = {
      agentId: "artifact", runId: entryPoint === "openclaw agent" ? undefined : randomUUID(),
      sessionKey: "agent:artifact:main",
    };
    const resolve = () => Promise.all(registry.emit("before_model_resolve", {}, {
      ...ctx, modelProviderId: "anthropic", modelId: "claude-sonnet-5-5",
    }));
    const gate = async () => {
      const decisions = await Promise.all(registry.emit("before_agent_run", { prompt: "test", messages: [] }, ctx));
      return decisions.find((decision: any) => decision?.outcome === "block");
    };
    return { registry, fetcher, resolve, gate, ctx };
  }

  it.each(entryPoints.flatMap((entryPoint) => discoveryStates.flatMap((state) =>
    [undefined, "did:imajin:artifact-org"].map((actAs) => ({ entryPoint, state, actAs })))))
  ("$entryPoint: $state, acting as $actAs", async ({ entryPoint, state, actAs }) => {
    const { registry, fetcher, resolve, gate } = await routingFixture(entryPoint, state, actAs);
    await resolve();
    const blocked = await gate();
    if (state === "ok") {
      expect(blocked).toBeUndefined();
    } else {
      expect(blocked).toMatchObject({ outcome: "block", message: expect.stringContaining("agents.artifact") });
      if (state.startsWith("connection_")) {
        expect(blocked).toMatchObject({ message: expect.stringContaining(state) });
        expect(blocked).toMatchObject({ message: expect.stringContaining("403") });
      }
      expect(JSON.stringify(blocked)).not.toContain("private transport detail");
    }
    const discovery = fetcher.mock.calls.find(([url]) => String(url).endsWith("/infer/v1/models/usable"));
    expect(discovery).toBeDefined();
    const init = (discovery as unknown as [string, RequestInit])[1];
    expect(init.headers).toEqual({ Authorization: "Bearer fixture-artifact",
      ...(actAs ? { "x-acting-as": actAs } : {}) });
    await registry.stop();
  });

  it("blocks direct execution without an earlier model-resolution hook or runId", async () => {
    const { registry, gate } = await routingFixture("openclaw agent", "connection_not_loaded");
    expect(await gate()).toMatchObject({
      outcome: "block", message: expect.stringContaining("connection_not_loaded"),
    });
    await registry.stop();
  });

  it("does not reuse a successful admission or last-good catalog after a refusal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { registry, fetcher, resolve, gate } = await routingFixture("model.primary", "ok");
    await resolve();
    expect(await gate()).toBeUndefined();
    fetcher.mockImplementation(async () => Response.json({
      code: "connection_unavailable",
    }, { status: 403 }));
    // Expire the discovery TTL without changing the configured agent or run.
    vi.setSystemTime(Date.now() + 61_000);
    expect(await gate()).toMatchObject({
      outcome: "block", message: expect.stringContaining("connection_unavailable"),
    });
    await registry.stop();
  });

  it("leaves a personal main agent without an imajin identity unchanged during discovery refusal", async () => {
    const { registry } = await routingFixture("model.primary", "connection_not_loaded");
    const ctx = { agentId: "main", runId: randomUUID(), sessionKey: "agent:main:main",
      modelProviderId: "anthropic", modelId: "claude-sonnet-5-5" };
    expect((await Promise.all(registry.emit("before_model_resolve", {}, ctx))).every((result) => result === undefined)).toBe(true);
    expect((await Promise.all(registry.emit("before_agent_run", {}, ctx))).every((result) => result === undefined)).toBe(true);
    await registry.stop();
  });

  it("blocks an identity-configured agent even when its sealed signer cannot be loaded", async () => {
    mocks.signer.mockRejectedValue(new Error("private signer detail"));
    const { registry, gate } = await routingFixture("model.primary", "ok");
    const blocked = await gate();
    expect(blocked).toMatchObject({ outcome: "block", message: expect.stringContaining("agents.artifact") });
    expect(JSON.stringify(blocked)).not.toContain("private signer detail");
    await registry.stop();
  });
});

describe("identity card registration and calling-agent isolation", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(ImajinClient.prototype, "requestRaw").mockResolvedValue({
      status: 200, contentType: "application/json", text: JSON.stringify({ data: [] }),
    });
  });

  it("registers no-arg cards for each agent with its signer, own kernel request, channel and GitHub scope", async () => {
    const discover = vi.spyOn(AgentInferenceAuth.prototype, "discoverSelf").mockImplementation(async (id) => ({
      identity: { did: `did:imajin:${id}`, handle: id, kind: "agent", tier: "hard", actAs: `did:imajin:org-${id}` },
      connectors: [], usableModels: [],
    }));
    const gateway = vi.fn(async (_method, params) => ({
      agentId: params.agentId, selectedScope: "agent", selected: { configured: false },
      effective: { source: "system-detected", credentialKind: "native", credentialState: "available",
        evidence: "github-api", account: { login: "host-user" } },
    }));
    const registry = register({
      nodeUrl: "https://kernel.invalid", gatewayAgent: "main",
      agents: { main: agent("main"), artifact: agent("artifact") },
      modelDiscovery: { refreshIntervalMs: 0 }, loops: { enabled: false }, attestation: { enabled: false },
    }, "full", { gateway: { request: gateway } });
    await registry.start();
    for (const agentId of ["main", "artifact"]) {
      const tool = registry.agentTools({
        agentId, sessionKey: `agent:${agentId}:telegram:direct:example`,
        activeModel: { provider: "imajin", modelId: "claude-test" },
        getRuntimeConfig: () => ({ bindings: [{ agentId, match: { channel: "telegram", accountId: `${agentId}-bot` } }] }),
      }).find((tool) => tool.name === "imajin_identity_card");
      expect(tool.parameters).toEqual({ type: "object", properties: {}, additionalProperties: false });
      const card = (await tool.execute()).details;
      expect(card.from).toBe(`did:imajin:${agentId}`);
      expect(card.payload.identity.did).toBe(card.from);
      expect(card.payload.rows.find((row: any) => row.connector === "channels").outboundIdentity).toBe(`${agentId}-bot`);
      expect(card.signature).toContain(`fake:${card.from}:`);
      expect(discover).toHaveBeenLastCalledWith(agentId);
      expect(gateway).toHaveBeenLastCalledWith("tools.github.status",
        { agentId, selectedScope: "agent" }, { timeoutMs: 5_000 });
    }
    expect(registry.agentTools({ agentId: "absent" })).toEqual([]);
    await registry.stop();
  });

  it("respects tool allowlists and never uses legacy or gateway credentials for a missing identity", async () => {
    const registry = register({
      nodeUrl: "https://kernel.invalid",
      agents: { main: agent("main", []), artifact: agent("artifact", ["imajin_identity_card"]) },
      did: "did:imajin:legacy", keypairPath: "/must-not-read", modelDiscovery: { refreshIntervalMs: 0 },
    });
    await registry.start();
    expect(registry.agentTools({ agentId: "main" })).toEqual([]);
    expect(registry.agentTools({ agentId: "artifact" }).map((tool) => tool.name)).toEqual(["imajin_identity_card"]);
    expect(registry.agentTools({})).toEqual([]);
    await registry.stop();
    const legacy = register({ nodeUrl: "https://kernel.invalid", did: "did:imajin:legacy" });
    const tool = legacy.agentTools({ agentId: "artifact" }).find((tool) => tool.name === "imajin_identity_card");
    expect((await tool.execute()).details).toEqual({ error: "Calling-agent signing identity unavailable" });
  });
});

describe("registered self_authorize action (#168)", () => {
  it("never auto-consents; operator targeting uses artifact's client, and tenants cannot target main", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const consents: Array<{ did?: string; options: any }> = [];
    const request = vi.spyOn(ImajinClient.prototype, "requestRaw").mockImplementation(async function (this: ImajinClient, path, options) {
      const did = this.identityStatus().did;
      if (path.startsWith("/api/registry/apps")) return {
        status: 200, contentType: "application/json", text: JSON.stringify({ apps: [{
          id: `app_${did!.split(":").at(-1)}`, appDid: did, status: "active",
          requestedScopes: ["infer:completions", "infer:usage-read"],
        }] }),
      };
      if (path === "/api/auth/authorize") consents.push({ did, options });
      return { status: 200, contentType: "application/json", text: JSON.stringify({ data: [] }) };
    });
    const credential = vi.spyOn(AgentInferenceAuth.prototype, "credential").mockImplementation(async (id) =>
      ({ token: `fixture-${id}`, expiresAt: Date.now() + 600_000 }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      data: [{ id: "artifact-model", imajin: { connector: "openai" } }],
    })));
    const registry = register({
      nodeUrl: "https://kernel.invalid", gatewayAgent: "main",
      agents: { main: agent("main"), artifact: agent("artifact") },
      modelDiscovery: { refreshIntervalMs: 0 }, loops: { enabled: false }, attestation: { enabled: false },
    });
    await registry.start();
    expect(consents).toEqual([]);
    credential.mockClear();
    const tool = (id: string) => registry.agentTools({ agentId: id, sessionKey: `agent:${id}:main` })
      .find((tool) => tool.name === "imajin_identity");
    const main = tool("main");
    expect((await main.execute("test", { action: "self_authorize", agentId: "artifact" })).details)
      .toMatchObject({ agentId: "artifact", did: "did:imajin:artifact", authorized: true, models: ["imajin/artifact-model"] });
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      did: "did:imajin:artifact", options: { method: "POST", onBehalfOf: "self", body: { appId: "app_artifact" } },
    });
    expect(credential.mock.calls.map(([id]) => id)).toEqual(["artifact"]);
    request.mockClear();
    expect((await tool("artifact").execute("test", { action: "self_authorize", agentId: "main" })).details)
      .toMatchObject({ error: true });
    expect(request).not.toHaveBeenCalled();
    await registry.stop();
    expect(() => main.execute("test", { action: "self_authorize" })).toThrow("no longer active");
  });
});

describe("agent-signed model discovery (imajin-ai#3198)", () => {
  const models = { data: [{ id: "picked-model", imajin: { connector: "anthropic", picked: true } }] };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(AgentInferenceAuth.prototype, "credential").mockImplementation(async (id) =>
      ({ token: `fixture-${id}`, expiresAt: Date.now() + 600_000 }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(models)));
  });

  it.each(["store", "exec"] as const)("CLI resolves the %s-backed gateway signer lazily; discovery and tenant tools keep distinct auth", async (source) => {
    const main = agent("main");
    main.keypair.source = source;
    const wire: Array<{ path: string; body: any; headers: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      wire.push({ path, body, headers: init?.headers });
      if (path.endsWith("/challenge")) return Response.json({ challengeId: body.did, challenge: body.did });
      if (path.endsWith("/verify")) {
        expect(body.signature).toBe(`fake:${body.challengeId}:${body.challengeId}`);
        return Response.json({}, { headers: { "set-cookie": `session=${body.challengeId}` } });
      }
      return Response.json(path === "/custom/models" ? models : { did: "did:imajin:lookup" });
    }));
    const registry = register({
      nodeUrl: "https://kernel.invalid", gatewayAgent: "main",
      agents: { tenant: agent("tenant"), main },
      did: "did:imajin:legacy", keypairPath: "/must-not-read", actAs: "did:imajin:legacy-org",
      modelDiscovery: { refreshIntervalMs: 0, modelsPath: "/custom/models" },
      inferProxyBaseUrl: "http://proxy.invalid/openai/v1",
    });
    const catalog = registry.providers[0].catalog;
    expect((await catalog.run()).provider.models[0].api).toBe("anthropic-messages");
    expect(mocks.sockets).toEqual([]);
    await registry.start();
    await vi.waitFor(() => expect(wire.some((row) => row.path === "/custom/models")).toBe(true));
    const discovered = (await catalog.run()).provider;
    expect(discovered.models.map((model: any) => `imajin/${model.id}`)).toEqual(["imajin/picked-model", "imajin/default"]);
    expect(discovered.baseUrl).toBe("http://proxy.invalid/openai/v1");
    const discovery = wire.find((row) => row.path === "/custom/models")!;
    expect(discovery.headers).toEqual({ Authorization: "Bearer fixture-main", "x-acting-as": main.actAs });
    expect(wire.filter((row) => row.path.endsWith("/challenge"))).toEqual([]);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("signer: agents.main"));
    const tenantTool = registry.agentTools({ agentId: "tenant" }).find((tool) => tool.name === "imajin_identity");
    await tenantTool.execute("lookup", { action: "lookup", query: "did:imajin:lookup" });
    expect(wire.find((row) => row.path.includes("/lookup/"))!.headers).toMatchObject({
      Cookie: "session=did:imajin:tenant", "X-Agent-DID": "did:imajin:tenant",
      "X-Acting-For": "did:imajin:org-tenant",
    });
    expect(wire.filter((row) => row.path === "/custom/models")).toHaveLength(3);
    const tenantCatalog = await catalog.run({ agentDir: "/agents/tenant/agent" });
    expect(tenantCatalog.provider.models[0].api).toBe("anthropic-messages");
    expect(mocks.signer).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "", "absent", " main", "__proto__"])("never falls back to tenants or legacy credentials for gatewayAgent %s", async (gatewayAgent) => {
    const request = vi.spyOn(ImajinClient.prototype, "requestRaw");
    const registry = register({
      nodeUrl: "https://kernel.invalid", gatewayAgent,
      agents: { main: agent("main"), tenant: agent("tenant") },
      did: "did:imajin:legacy", keypairPath: "/must-not-read",
      modelDiscovery: { refreshIntervalMs: 0 },
    });
    await registry.start();
    await expect(registry.providers[0].catalog.run()).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not borrow a healthy tenant client when the selected gateway signer fails", async () => {
    mocks.signer.mockImplementation(async (_config, _ref, did) => {
      if (did === "did:imajin:main") throw new Error("protected provider detail");
      return { did, signChallenge: vi.fn() };
    });
    const request = vi.spyOn(ImajinClient.prototype, "requestRaw");
    const registry = register({
      nodeUrl: "https://kernel.invalid", gatewayAgent: "main",
      agents: { main: agent("main"), tenant: agent("tenant") }, modelDiscovery: { refreshIntervalMs: 0 },
    });
    await registry.start();
    expect(registry.agentTools({ agentId: "tenant" })).toHaveLength(AGENT_TOOL_NAMES.length);
    await expect(registry.providers[0].catalog.run()).rejects.toThrow("agents.main");
    expect(request).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).not.toContain("protected provider detail");
  });

  it.each([401, 403, 500])("HTTP %s preserves each agent's signer without fallback and logs only safe kernel fields", async (status) => {
    const request = vi.spyOn(ImajinClient.prototype, "requestRaw");
    const fetcher = vi.fn(async () => Response.json({
      error: "membership_required", detail: "protected upstream detail",
    }, { status }));
    vi.stubGlobal("fetch", fetcher);
    const registry = register({
      nodeUrl: "https://kernel.invalid", gatewayAgent: "main",
      agents: { main: agent("main"), tenant: agent("tenant") }, modelDiscovery: { refreshIntervalMs: 0 },
    });
    await registry.start();
    if (status === 500) expect((await registry.providers[0].catalog.run()).provider.models).toEqual([]);
    else await expect(registry.providers[0].catalog.run()).rejects.toThrow("membership_required");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(request).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).not.toContain("protected upstream detail");
  });

  it("refreshes per agent, accepts tenant invalidation, and retires discovery on replacement/stop", async () => {
    vi.useFakeTimers();
    const request = vi.mocked(fetch);
    const config = {
      nodeUrl: "https://kernel.invalid", gatewayAgent: "main",
      agents: { main: agent("main"), tenant: agent("tenant") }, modelDiscovery: { refreshIntervalMs: 10_000 },
    };
    const registry = register(config);
    await registry.start();
    await registry.providers[0].catalog.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
    const frame = { type: "notification", id: "catalog", scope: "connector.models.changed", title: "Changed" };
    mocks.sockets[1].frame?.(frame);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(3);
    mocks.sockets[0].frame?.(frame);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(6);
    const metadata = register(config, "tool-discovery");
    await metadata.start();
    await metadata.providers[0].catalog.run();
    expect(request).toHaveBeenCalledTimes(7);
    expect(mocks.signer).toHaveBeenCalledTimes(4);
    const replacement = register({ ...config, agents: {}, gatewayAgent: undefined });
    await replacement.start();
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(registry.providers[0].catalog.run()).rejects.toThrow("no longer active");
    expect(request).toHaveBeenCalledTimes(7);
    await replacement.stop();
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(replacement.providers[0].catalog.run()).rejects.toThrow("gatewayAgent");
    expect(request).toHaveBeenCalledTimes(7);
    expect(mocks.signer).toHaveBeenCalledTimes(4);
  });

  it("registered tenant-default hooks select the caller's Anthropic model without editing host config", async () => {
    const config = {
      nodeUrl: "https://kernel.invalid", gatewayAgent: "main",
      agents: { main: agent("main"), artifact: agent("artifact") },
      modelDiscovery: { refreshIntervalMs: 0 }, loops: { enabled: false }, attestation: { enabled: false },
    };
    const before = JSON.stringify(config);
    const registry = register(config);
    await registry.start();
    const ctx = { agentId: "artifact", runId: "artifact-turn", modelProviderId: "anthropic", modelId: "direct" };
    const results = await Promise.all(registry.emit("before_model_resolve", {}, ctx));
    expect(results).toContainEqual({ providerOverride: "imajin", modelOverride: "picked-model" });
    const mainResults = await Promise.all(registry.emit("before_model_resolve", {}, { ...ctx, agentId: "main", runId: "main-turn" }));
    expect(mainResults.every((result) => result === undefined)).toBe(true);
    const model = await registry.providers[0].prepareDynamicModel({
      agentDir: "/agents/artifact/agent", modelId: "picked-model",
    });
    expect(model).toMatchObject({ api: "anthropic-messages", baseUrl: "http://127.0.0.1:8787/anthropic" });
    expect(JSON.stringify(config)).toBe(before);
  });
});
describe("per-agent plugin registration", () => {
  function statusTransport() {
    vi.spyOn(AgentInferenceAuth.prototype, "credential").mockRejectedValue(new Error("test discovery unavailable"));
    vi.spyOn(ImajinClient.prototype, "requestRaw").mockResolvedValue({
      status: 200, contentType: "application/json", text: JSON.stringify({ data: [] }),
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/mcp")
      ? Response.json({ error: "no_route_configured" }, { status: 422 })
      : Response.json({ status: "ok" })));
  }

  it.each([undefined, "did:imajin:business"])("reports only the caller's map identity with acting principal %s", async (actAs) => {
    statusTransport();
    const protectedValue = randomUUID();
    const main = { ...agent("main"), actAs };
    const artifact = {
      ...agent("artifact"), actAs,
      keypair: { source: "exec" as const, provider: "imajin-vault", id: "artifact-identity" },
    };
    mocks.signer.mockImplementation(async (_config, _ref, did) => ({
      did, publicKey: (did === main.did ? "ab" : "cd").repeat(32), signChallenge: vi.fn(),
      privateKey: protectedValue, seed: protectedValue, token: protectedValue,
    }));
    const registry = register({
      nodeUrl: "https://kernel.invalid", gatewayAgent: "main", agents: { main, artifact },
      did: "did:imajin:must-not-borrow", keypairPath: "/must-not-read",
      modelDiscovery: { refreshIntervalMs: 0 }, loops: { enabled: false }, attestation: { enabled: false },
    });
    await registry.start();
    for (const [id, own, other] of [["main", main, artifact], ["artifact", artifact, main]] as const) {
      const tool = registry.agentTools({ agentId: id }).find((entry) => entry.name === "imajin_status");
      const report = await tool.execute("status", { agentId: other.did });
      const body = report.details;
      expect(body.identity).toMatchObject({
        agentId: id, mode: "map", did: own.did, isGatewayAgent: id === "main",
        keypairSource: `${own.keypair.source}:${own.keypair.id}`,
        auth: null, ws: { state: "open" }, warnings: [],
      });
      expect(body.identity.actAs).toBe(actAs);
      expect(body.identity.publicKey).toMatch(/^[a-f0-9]{12}$/);
      expect(JSON.stringify(body.identity)).not.toContain(other.did);
      expect(report.content[0].text).not.toContain("must-not-borrow");
      expect(body.sources.kernelMcp).toEqual({
        url: "http://127.0.0.1:8787/mcp", reachable: false, outcome: "not-configured",
        httpStatus: 422, errorCode: "no_route_configured",
      });
      expect(JSON.parse(report.content[0].text)).toEqual(body);
      expect(JSON.stringify(body)).not.toMatch(/"(privateKey|seed|token|sessionCookie)"\s*:/);
      expect(JSON.stringify(report)).not.toContain(protectedValue);
    }
    expect(mocks.signer).toHaveBeenCalledTimes(2);
    expect(ImajinClient.prototype.requestRaw).not.toHaveBeenCalled(); // discovery never uses a session
    expect(fetch).toHaveBeenCalledTimes(4); // one existing health + MCP probe per call
    await registry.stop();
  });

  it("keeps unresolved status value-free, allowlisted and retired with its runtime", async () => {
    statusTransport();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.signer.mockRejectedValue(new Error("protected-provider-output"));
    const registry = register({
      nodeUrl: "https://kernel.invalid", gatewayAgent: "main",
      agents: { main: agent("main"), denied: agent("denied", []), noStatus: agent("no-status", ["imajin_identity"]) },
      modelDiscovery: { refreshIntervalMs: 0 },
    });
    await registry.start();
    const tools = registry.agentTools({ agentId: "main" });
    expect(tools.map((tool) => tool.name)).toEqual(["imajin_status"]);
    for (const agentId of ["denied", "noStatus", "missing", "__proto__"]) {
      expect(registry.agentTools({ agentId })).toEqual([]);
    }
    const report = await tools[0].execute();
    expect(report.details.identity).toMatchObject({
      did: "did:imajin:main", mode: "map", isGatewayAgent: false,
      keypairSource: "store:main", publicKey: null, auth: null, ws: { state: "disabled" },
      warnings: [
        "Identity keypair unavailable; authenticated tools disabled",
        "Gateway agent unavailable; gateway features disabled",
      ],
    });
    expect(JSON.stringify(report)).not.toContain("protected-provider-output");
    expect(JSON.stringify(report.details)).not.toMatch(/"(privateKey|seed|token|sessionCookie)"\s*:/);
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).not.toContain("protected-provider-output");
    expect(ImajinClient.prototype.requestRaw).not.toHaveBeenCalled();
    await registry.stop();
    expect(() => tools[0].execute()).toThrow("no longer active");
    expect(registry.agentTools({ agentId: "main" })).toEqual([]);
  });

  it.each([undefined, "did:imajin:business"])("reports legacy top-level identity with acting principal %s", async (actAs) => {
    statusTransport();
    const registry = register({
      nodeUrl: "https://kernel.invalid", did: "did:imajin:legacy", keypairPath: "/must-not-read",
      actAs, modelDiscovery: { refreshIntervalMs: 0 },
    });
    const tool = registry.agentTools({ agentId: "main" }).find((entry) => entry.name === "imajin_status");
    const report = await tool.execute();
    expect(report.details.identity).toEqual({
      agentId: "main", mode: "legacy", did: "did:imajin:legacy",
      ...(actAs === undefined ? {} : { actAs }),
      isGatewayAgent: true, keypairSource: "file", publicKey: null, auth: null,
      ws: { state: "not-started" }, warnings: [],
    });
    expect(JSON.stringify(report)).not.toContain("/must-not-read");
    expect(mocks.signer).not.toHaveBeenCalled();
  });

  it("legacy discovery stays unconfigured without attempting a missing file identity", async () => {
    statusTransport();
    vi.mocked(ImajinClient.prototype.requestRaw).mockRestore();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = register({
      nodeUrl: "https://kernel.invalid", did: "did:imajin:legacy",
      keypairPath: "/missing-status-identity.json", modelDiscovery: { refreshIntervalMs: 0 },
    });
    const tool = registry.agentTools({ agentId: "main" }).find((entry) => entry.name === "imajin_status");
    const report = await tool.execute();
    expect(report.details.identity).toMatchObject({
      mode: "legacy", did: "did:imajin:legacy",
      auth: null,
      warnings: [],
    });
    expect(report.details.lastDiscovery.outcome).toBe("unconfigured");
  });
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
    expect(registry.agentTools({ agentId: "main" }).map((tool) => tool.name)).toEqual(["imajin_status"]);
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
    registry.emit("before_agent_run", {}, { agentId: "tenant", sessionKey: "agent:main:custom" });
    expect(mocks.injectors[1].hook).toHaveBeenCalledOnce();
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
      const status = registry.agentTools({ agentId: id }).find((entry) => entry.name === "imajin_status");
      const report = await status.execute();
      expect(report.details.identity).toMatchObject({
        did: `did:imajin:${id}`, auth: { ok: true, at: expect.any(String) },
      });
      expect(JSON.stringify(report.details.identity)).not.toContain(`session=did:imajin:${id}`);
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
      loops: { enabled: false },
      wsNotifications: { wakeSessionKey: "agent:main:custom", reportTo: ["agent:main:operator"] },
    };
    const registry = register(config);
    expect(registry.agentTools({ agentId: "main" }).map((tool) => tool.name).sort())
      .toEqual([...AGENT_TOOL_NAMES].sort());
    await registry.tools.find((tool) => tool.name === "imajin_identity")
      .execute("legacy", { action: "lookup", query: "did:imajin:lookup" });
    expect(wire[0].body).toEqual({ did: "did:imajin:legacy" });
    expect(wire[1].body.signature).toBe("fake-legacy-signature");
    expect(wire[2].headers).toMatchObject({ "X-Agent-DID": config.did, "X-Acting-For": config.actAs });
    expect(mocks.signer).not.toHaveBeenCalled();
    await registry.start();
    expect(mocks.injectors[0].config).toEqual(config.wsNotifications);
    expect(mocks.sockets[0].config).toMatchObject({
      did: config.did, keypairPath: config.keypairPath, actAs: config.actAs,
    });
  });
});
