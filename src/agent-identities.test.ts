import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  AgentIdentities, AGENT_TOOL_NAMES, agentNotifications, isSealedKeyRef,
  resolveAgentSigner, validAgentConfig, type AgentIdentityConfig,
} from "./agent-identities.js";
import { ImajinClient } from "./client.js";

const sdk = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("openclaw/plugin-sdk/secret-ref-runtime", () => ({ resolveSecretRefValues: sdk.resolve }));

export function agent(id: string): AgentIdentityConfig {
  return {
    did: `did:imajin:${id}`,
    keypair: { source: "store", provider: "sealed", id: `agents/${id}` },
    actAs: `did:imajin:org-${id}`,
  };
}

const fakeSigner = async (_config: unknown, _ref: unknown, did: string) => ({
  did, signChallenge: vi.fn(async (challenge: string) => `fake-signature:${did}:${challenge}`),
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("sealed per-agent config", () => {
  it("accepts distinct sealed identities and rejects absent/unknown agent IDs", async () => {
    const identities = new AgentIdentities();
    await identities.prepare("https://kernel.invalid", { main: agent("main"), tenant: agent("tenant") }, {}, fakeSigner);
    expect(identities.get("main")?.client).not.toBe(identities.get("tenant")?.client);
    for (const id of [undefined, "", "missing", "__proto__", "constructor"]) expect(identities.get(id)).toBeUndefined();
    identities.clear();
    expect([...identities.entries()]).toEqual([]);
  });

  it.each([
    "inline-is-not-a-reference", null, {}, [], { source: "env", provider: "sealed", id: "key" },
    { source: "file", provider: "sealed", id: "key" },
    { source: "store", id: "key" }, { source: "store", provider: " ", id: "key" },
    { source: "store", provider: "sealed", id: "" },
    { source: "exec", provider: "sealed", id: "key", unexpected: true },
  ])("rejects malformed, unsealed, and inline key references %#", (ref) => {
    expect(isSealedKeyRef(ref)).toBe(false);
    expect(validAgentConfig("tenant", { ...agent("tenant"), keypair: ref })).toBe(false);
  });

  it.each([
    null, [], {}, { ...agent("tenant"), did: "invalid" },
    { ...agent("tenant"), actAs: "invalid" }, { ...agent("tenant"), tools: "imajin_identity" },
    { ...agent("tenant"), tools: ["imajin_unknown"] },
    { ...agent("tenant"), tools: ["imajin_identity", "imajin_identity"] },
    { ...agent("tenant"), keypairPath: "/not-used" }, { ...agent("tenant"), privateKey: null },
  ])("fails closed for invalid agent records %#", async (entry) => {
    expect(validAgentConfig("tenant", entry)).toBe(false);
    const resolver = vi.fn(fakeSigner);
    const identities = new AgentIdentities();
    await identities.prepare("https://kernel.invalid", { tenant: entry } as any, {}, resolver);
    expect(identities.get("tenant")).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(["../main", "Main", "a:b", "", "a".repeat(65)])("rejects invalid agent id %s", (id) => {
    expect(validAgentConfig(id, agent("tenant"))).toBe(false);
  });

  it("accepts explicit empty allowlist, self principal and exec vault references", () => {
    const config = { ...agent("tenant"), actAs: undefined, tools: [], keypair: { source: "exec", provider: "vault", id: "tenant" } };
    expect(validAgentConfig("tenant", config)).toBe(true);
  });

  it.each(["did", "reference"])("rejects both agents sharing a %s", async (shared) => {
    const tenant = agent("tenant");
    const main = agent("main");
    if (shared === "did") tenant.did = main.did;
    else tenant.keypair = main.keypair;
    const resolver = vi.fn(fakeSigner);
    const identities = new AgentIdentities();
    await identities.prepare("https://kernel.invalid", { main, tenant }, {}, resolver);
    expect([...identities.entries()]).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("never falls back when resolution fails or returns another agent's signer", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const identities = new AgentIdentities();
    await identities.prepare("https://kernel.invalid", { main: agent("main"), tenant: agent("tenant") }, {},
      async (_config, _ref, did) => {
        if (did.endsWith("main")) throw new Error("provider diagnostics must not be logged");
        return { did: "did:imajin:main", signChallenge: vi.fn() };
      });
    expect([...identities.entries()]).toEqual([]);
    expect(warning.mock.calls.flat().join(" ")).not.toContain("provider diagnostics");
  });

  it("does not publish late resolution after service retirement", async () => {
    const identities = new AgentIdentities();
    await identities.prepare("https://kernel.invalid", { tenant: agent("tenant") }, {}, fakeSigner, () => false);
    expect(identities.get("tenant")).toBeUndefined();
  });

  it("resolves only one exact SDK ref with host config and rejects public-only/unavailable values", async () => {
    const config = { secrets: { providers: {} } };
    const entry = agent("tenant");
    const publicOnly = { did: entry.did, publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a" };
    for (const value of [undefined, "", "not-json", publicOnly, { ...publicOnly, did: "did:imajin:other" }]) {
      sdk.resolve.mockResolvedValue(new Map([["ref", value]]));
      await expect(resolveAgentSigner(config, entry.keypair, entry.did)).rejects.toThrow();
    }
    expect(sdk.resolve).toHaveBeenLastCalledWith([entry.keypair], { config, env: process.env });
    sdk.resolve.mockResolvedValue(new Map());
    await expect(resolveAgentSigner(config, entry.keypair, entry.did)).rejects.toThrow("unavailable");
    await expect(resolveAgentSigner(config, "inline" as any, entry.did)).rejects.toThrow("reference");
  });

  it("scopes wake targets and persistence, preserving only explicit per-agent reportTo", () => {
    const tenant = agent("tenant");
    expect(agentNotifications("tenant", tenant)).toMatchObject({
      targetSession: "agent:tenant:warp-events", wakeSessionKey: "agent:tenant:warp-events", hookAgentId: "tenant",
    });
    tenant.wsNotifications = {
      targetSession: "agent:main:custom", wakeSessionKey: "agent:main:wakes:{batchId}",
      hookAgentId: "main", stateDir: "/state", reportTo: ["agent:tenant:channel:operator"],
    };
    expect(agentNotifications("tenant", tenant)).toMatchObject({
      targetSession: "agent:tenant:custom", wakeSessionKey: "agent:tenant:wakes:{batchId}",
      hookAgentId: "tenant", stateDir: "/state/tenant", reportTo: ["agent:tenant:channel:operator"],
    });
    expect(agentNotifications("main", agent("main")).stateDir).not.toBe(agentNotifications("tenant", agent("tenant")).stateDir);
  });

  it("manifest only allows sealed refs and matches the runtime tool allowlist", async () => {
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const entry = manifest.configSchema.properties.agents.additionalProperties;
    expect(entry.required).toEqual(["did", "keypair"]);
    expect(entry.additionalProperties).toBe(false);
    expect(entry.properties.keypair.additionalProperties).toBe(false);
    expect(entry.properties.keypair.properties.source.enum).toEqual(["store", "exec"]);
    expect(entry.properties.tools.items.enum).toEqual(AGENT_TOOL_NAMES);
    expect(entry.properties.tools.uniqueItems).toBe(true);
    expect(entry.properties.wsNotifications.$ref).toBe("#/properties/wsNotifications");
    expect(manifest.configSchema.properties.keypairPath.type).toBe("string");
  });
});

describe("two-agent challenge-response wire proof", () => {
  it("sends distinct DIDs/signatures/cookies/principals and coalesces only within each agent", async () => {
    const wire: Array<{ path: string; body: any; headers: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      wire.push({ path, body, headers: init?.headers });
      if (path.endsWith("/challenge")) return Response.json({
        challengeId: body.did, challenge: `challenge:${body.did}`, expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      if (path.endsWith("/verify")) {
        expect(body.signature).toBe(`fake-signature:${body.challengeId}:challenge:${body.challengeId}`);
        return Response.json({}, { headers: { "set-cookie": `session=${body.challengeId}; Path=/` } });
      }
      return Response.json({ ok: true });
    }));
    const identities = new AgentIdentities();
    await identities.prepare("https://kernel.invalid", { main: agent("main"), tenant: agent("tenant") }, {}, fakeSigner);
    const main = identities.get("main")!.client;
    const tenant = identities.get("tenant")!.client;
    await Promise.all([main.getRaw("/probe"), main.getRaw("/probe"), tenant.getRaw("/probe"), tenant.getRaw("/probe")]);
    expect(wire.filter((row) => row.path.endsWith("/challenge")).map((row) => row.body.did).sort())
      .toEqual(["did:imajin:main", "did:imajin:tenant"]);
    expect(new Set(wire.filter((row) => row.path.endsWith("/verify")).map((row) => row.body.signature)).size).toBe(2);
    for (const row of wire.filter((row) => row.path === "/probe")) {
      const did = row.headers["X-Agent-DID"];
      expect(row.headers.Cookie).toBe(`session=${did}`);
      expect(row.headers["X-Acting-For"]).toBe(did.replace("did:imajin:", "did:imajin:org-"));
    }
    expect(await main.authenticatedCookie()).toBe("session=did:imajin:main");
    expect(await tenant.authenticatedCookie()).toBe("session=did:imajin:tenant");
    expect(wire.filter((row) => row.path.endsWith("/challenge"))).toHaveLength(2);
  });

  it("refuses a signer belonging to another DID before any network call", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(() => new ImajinClient({
      nodeUrl: "https://kernel.invalid", did: "did:imajin:tenant",
      signer: { did: "did:imajin:main", signChallenge: vi.fn() },
    })).toThrow("does not match");
    expect(fetch).not.toHaveBeenCalled();
  });
});
