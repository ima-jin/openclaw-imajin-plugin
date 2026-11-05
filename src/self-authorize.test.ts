import { generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImajinClient } from "./client.js";
import type { AgentIdentity } from "./agent-identities.js";
import { AgentInferenceAuth } from "./inference-auth.js";
import { ImajinCatalogCache, ImajinDiscoveryError, registerImajinProvider } from "./imajin-provider.js";
import { createSelfAuthorizer, type SelfAuthorizeOptions } from "./self-authorize.js";
import { createIdentityTool } from "./tools.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const scopes = ["infer:completions", "infer:usage-read"];
const logger = { info: vi.fn(), warn: vi.fn() };

describe("explicit agent self-authorization", () => {
  let identities: Map<string, AgentIdentity>;
  let grants: Map<string, { issuer: string; subject: string; scopes: string[] }>;
  let wire: Array<{ path: string; headers: Headers; body: any }>;
  let appRows: any[];
  let status: number;
  let lookupStatus: number;
  let protectedDetail: string;
  let options: SelfAuthorizeOptions;
  let rediscover: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    identities = new Map(); grants = new Map(); wire = [];
    status = lookupStatus = 200; protectedDetail = randomUUID();
    const publicKeys = new Map();
    for (const id of ["main", "artifact"]) {
      const pair = generateKeyPairSync("ed25519");
      const did = `did:imajin:${id}`;
      publicKeys.set(did, pair.publicKey);
      const signer = { did, signChallenge: vi.fn(async (challenge: string) =>
        sign(null, Buffer.from(challenge), pair.privateKey).toString("hex")) };
      const config = { did, actAs: `did:imajin:org-${id}`, keypair: { source: "store" as const, provider: "sealed", id } };
      identities.set(id, { signer, config, client: new ImajinClient({ nodeUrl: "https://kernel.invalid", ...config, signer }) });
    }
    appRows = [...identities.values()].map(({ config }) => ({
      id: `app_${config.did.split(":").at(-1)}`, appDid: config.did,
      requestedScopes: scopes, status: "active", visibility: "internal",
    }));
    const kernelKey = generateKeyPairSync("ed25519");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const headers = new Headers(init?.headers);
      wire.push({ path: path + parsed.search, body, headers });
      if (path.endsWith("/challenge")) return Response.json({
        challengeId: body.did, challenge: body.did, expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      if (path.endsWith("/verify")) {
        expect(verify(null, Buffer.from(body.challengeId), publicKeys.get(body.challengeId), Buffer.from(body.signature, "hex"))).toBe(true);
        return Response.json({}, { headers: { "set-cookie": `session=${body.challengeId}; HttpOnly` } });
      }
      if (path === "/api/registry/apps") {
        if (lookupStatus !== 200) return Response.json({ error: protectedDetail }, { status: lookupStatus });
        const offset = Number(parsed.searchParams.get("offset"));
        return Response.json({ apps: appRows.slice(offset, offset + 100) });
      }
      if (path === "/api/auth/authorize") {
        if (status >= 400) return Response.json({ error: protectedDetail }, { status });
        const app = appRows.find((app) => app.id === body.appId)!;
        const issuer = headers.get("cookie")!.slice("session=".length);
        grants.set(`${issuer}:${app.appDid}`, { issuer, subject: app.appDid, scopes: body.scopes });
        return Response.json({ redirect: `https://callback.invalid/?code=${protectedDetail}` }, { status });
      }
      if (path === "/auth/api/apps/token") {
        const proof = `${body.appDid}:${body.principalDid}:${body.nonce}:${body.timestamp}`;
        expect(verify(null, Buffer.from(proof), publicKeys.get(body.appDid), Buffer.from(body.signature, "hex"))).toBe(true);
        if (!grants.has(`${body.principalDid}:${body.appDid}`)) return Response.json({ error: "no_live_grant" }, { status: 403 });
        const unsigned = `${encode({ typ: "app+jwt", alg: "EdDSA" })}.${encode({
          azp: body.appDid, sub: body.principalDid, aud: "imajin:apps", exp: Date.now() / 1000 + 600,
        })}`;
        const token = `${unsigned}.${sign(null, Buffer.from(unsigned), kernelKey.privateKey).toString("base64url")}`;
        return Response.json({ token, expiresIn: 600, scopes });
      }
      if (path === "/infer/v1/models/usable") return Response.json({
        data: [{ id: "agent-model", imajin: { picked: true, servable: true } }],
      });
      throw new Error("Unexpected request");
    }));
    rediscover = vi.fn(async () => ["imajin/agent-model"]);
    options = { callerId: "artifact", sessionKey: "agent:artifact:main", operatorAgentId: "main",
      getIdentity: (id) => identities.get(id), assertCurrent: () => {}, rediscover };
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each(["main", "artifact"])("%s signs only with its own signer and reuses the identical scope-set grant", async (id) => {
    options.callerId = id; options.sessionKey = `agent:${id}:main`;
    const authorize = createSelfAuthorizer(options);
    const result = await authorize();
    await authorize();
    expect(result).toMatchObject({ authorized: true, did: `did:imajin:${id}`, discovery: "ok" });
    expect(grants.size).toBe(1);
    expect([...grants.values()]).toEqual([{ issuer: `did:imajin:${id}`, subject: `did:imajin:${id}`, scopes }]);
    expect(identities.get(id)!.signer.signChallenge).toHaveBeenCalledTimes(1);
    expect(identities.get(id === "main" ? "artifact" : "main")!.signer.signChallenge).not.toHaveBeenCalled();
    const posts = wire.filter((request) => request.path === "/api/auth/authorize");
    for (const post of posts) {
      expect(post.headers.get("cookie")).toBe(`session=did:imajin:${id}`);
      expect(post.headers.has("x-acting-for")).toBe(false);
      expect(post.headers.has("x-acting-as")).toBe(false);
      expect(post.body).toMatchObject({ appId: `app_${id}`, scopes });
      expect(post.body.state).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(posts[0].body.state).not.toBe(posts[1].body.state);
    expect(JSON.stringify(result)).not.toContain(protectedDetail);
    expect(rediscover).toHaveBeenLastCalledWith(id);
  });

  it("operator targeting artifact never logs in or signs as main", async () => {
    options.callerId = "main"; options.sessionKey = "agent:main:main";
    await createSelfAuthorizer(options)("artifact");
    expect(identities.get("main")!.signer.signChallenge).not.toHaveBeenCalled();
    expect([...grants.values()][0]).toMatchObject({ issuer: "did:imajin:artifact", subject: "did:imajin:artifact" });
  });

  it.each([undefined, "did:imajin:personal", "did:imajin:org"])("lookup honors configured acting context %s while consent remains self", async (actAs) => {
    const identity = identities.get("artifact")!;
    identity.config.actAs = actAs;
    identity.client = new ImajinClient({ nodeUrl: "https://kernel.invalid", did: identity.config.did, signer: identity.signer, actAs });
    await createSelfAuthorizer(options)();
    const lookup = wire.find((request) => request.path.startsWith("/api/registry/apps"))!;
    expect(lookup.headers.get("x-acting-for")).toBe(actAs ?? null);
    expect(wire.find((request) => request.path === "/api/auth/authorize")!.headers.has("x-acting-for")).toBe(false);
  });

  it("denies tenant-to-main targeting before any request or signing", async () => {
    await expect(createSelfAuthorizer(options)("main")).rejects.toThrow("Only the operator/main");
    expect(wire).toEqual([]);
  });

  it.each(["", "__proto__", " bad", "bad\nid"])("invalid target %# is refused without echoing input", async (id) => {
    await expect(createSelfAuthorizer(options)(id)).rejects.toThrow("Invalid agent id");
    expect(wire).toEqual([]);
  });

  it.each(["missing-caller", "session-mismatch", "missing-target", "signer-mismatch", "client-mismatch", "retired"])("fails closed at %s boundary", async (boundary) => {
    if (boundary === "missing-caller") options.callerId = undefined;
    if (boundary === "session-mismatch") options.sessionKey = "agent:main:main";
    if (boundary === "missing-target") identities.delete("artifact");
    if (boundary === "signer-mismatch") identities.get("artifact")!.signer.did = "did:imajin:main";
    if (boundary === "client-mismatch") identities.get("artifact")!.client = identities.get("main")!.client;
    if (boundary === "retired") options.assertCurrent = () => { throw new Error(protectedDetail); };
    await expect(createSelfAuthorizer(options)()).rejects.not.toThrow(protectedDetail);
    expect(wire).toEqual([]);
  });

  it.each([404, 403, 401, 500])("consent HTTP %s is status-only, without rediscovery or partial grants", async (httpStatus) => {
    status = httpStatus;
    const tool = createIdentityTool(identities.get("artifact")!.client, createSelfAuthorizer(options));
    const result = await tool.execute("test", { action: "self_authorize" });
    expect(result.details).toMatchObject({ error: true });
    expect(JSON.stringify(result)).not.toContain(protectedDetail);
    expect(JSON.stringify(result)).toContain(httpStatus === 404 ? "/auth/developer/apps" : `HTTP ${httpStatus}`);
    expect(grants.size).toBe(0); expect(rediscover).not.toHaveBeenCalled();
  });

  it.each([404, 403])("lookup HTTP %s never attempts consent", async (httpStatus) => {
    lookupStatus = httpStatus;
    await expect(createSelfAuthorizer(options)()).rejects.not.toThrow(protectedDetail);
    expect(wire.some((request) => request.path === "/api/auth/authorize")).toBe(false);
  });

  it("missing registration reports developer setup without writing anything", async () => {
    appRows = [];
    await expect(createSelfAuthorizer(options)()).rejects.toThrow("/auth/developer/apps");
    expect(wire.filter((request) => request.path.startsWith("/api/registry/apps"))).toHaveLength(2);
    expect(grants.size).toBe(0); expect(rediscover).not.toHaveBeenCalled();
  });

  it("paginates the acting owner's apps and matches the DID, never a name or first row", async () => {
    appRows = [...Array.from({ length: 100 }, (_, i) => ({ appDid: `did:imajin:other${i}` })), appRows[1]];
    await createSelfAuthorizer(options)();
    expect(wire.some((request) => request.path.endsWith("offset=100"))).toBe(true);
    expect([...grants.values()][0].subject).toBe("did:imajin:artifact");
  });

  it.each([
    { id: "" }, { id: "../main" }, { status: "revoked" }, { requestedScopes: null },
    { requestedScopes: [42] }, { requestedScopes: [""] }, { requestedScopes: ["not a scope"] },
  ])("invalid registration %# never posts consent", async (patch) => {
    Object.assign(appRows[1], patch);
    await expect(createSelfAuthorizer(options)()).rejects.toThrow("/auth/developer/apps");
    expect(grants.size).toBe(0); expect(rediscover).not.toHaveBeenCalled();
  });

  it("falls back to the documented public list when the acting owner list has no match", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => String(url).includes("owner=me")
      ? Promise.resolve(Response.json({ apps: [] })) : original(url, init));
    await createSelfAuthorizer(options)();
    expect(wire.some((request) => request.path === "/api/registry/apps?limit=100&offset=0")).toBe(true);
    expect(grants.size).toBe(1);
  });

  it("bounded pagination never mutates when lookup is incomplete", async () => {
    appRows = Array.from({ length: 100 }, () => ({ appDid: "did:imajin:other" }));
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => String(url).includes("/api/registry/apps")
      ? Promise.resolve(Response.json({ apps: appRows })) : original(url, init));
    await expect(createSelfAuthorizer(options)()).rejects.toThrow("lookup limit");
    expect(grants.size).toBe(0); expect(rediscover).not.toHaveBeenCalled();
  });

  it.each(["network", "json", "signer"])("contains %s diagnostics without exposing protected values", async (failure) => {
    if (failure === "signer") {
      vi.mocked(identities.get("artifact")!.signer.signChallenge).mockRejectedValue(new Error(protectedDetail));
    } else {
      const original = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation((url, init) => {
        if (!String(url).includes("/api/registry/apps")) return original(url, init);
        if (failure === "network") throw new Error(protectedDetail);
        return Promise.resolve(new Response(protectedDetail));
      });
    }
    await expect(createSelfAuthorizer(options)()).rejects.toThrow("self-authorization unavailable");
    expect(grants.size).toBe(0); expect(rediscover).not.toHaveBeenCalled();
  });

  it("malformed and ambiguous lists fail safely before mutation", async () => {
    appRows.push(appRows[1]);
    await expect(createSelfAuthorizer(options)()).rejects.toThrow("Ambiguous");
    vi.mocked(fetch).mockResolvedValue(Response.json({ apps: "invalid" }));
    await expect(createSelfAuthorizer(options)()).rejects.toThrow("Invalid kernel app list");
    expect(grants.size).toBe(0);
  });

  it("runtime change during lookup never consents with a retired signer", async () => {
    options.assertCurrent = () => { if (wire.length) identities.delete("artifact"); };
    await expect(createSelfAuthorizer(options)()).rejects.toThrow("runtime changed");
    expect(grants.size).toBe(0);
  });

  it("successful consent is reported even when subsequent discovery is unavailable", async () => {
    rediscover.mockRejectedValue(new Error(protectedDetail));
    const result = await createSelfAuthorizer(options)();
    expect(result).toMatchObject({ authorized: true, discovery: "retry-required" });
    expect(JSON.stringify(result)).not.toContain(protectedDetail);
    expect(grants.size).toBe(1);
  });

  it("tool denies delegation overrides, unsupported legacy signing, and missing lookup queries", async () => {
    const client = identities.get("artifact")!.client;
    const tool = createIdentityTool(client, createSelfAuthorizer(options));
    expect(tool.parameters.required).toEqual(["action"]);
    expect((await tool.execute("test", { action: "self_authorize", onBehalfOf: "self" })).details).toMatchObject({ error: true });
    expect((await createIdentityTool(client).execute("test", { action: "self_authorize" })).details).toMatchObject({ error: true });
    for (const action of ["lookup", "connections"]) {
      expect((await tool.execute("test", { action })).details).toMatchObject({ error: true });
    }
    expect(wire).toEqual([]);
  });

  it("consent recovers a 403 mint and stale catalog immediately, using artifact's app token and org selector", async () => {
    let authorized = false;
    const fetcher = vi.fn(async () => {
      if (!authorized) throw new ImajinDiscoveryError("auth-error", "no_live_grant", 403);
      return { data: [{ id: "gateway-model" }] };
    });
    const provider = registerImajinProvider({ registerProvider: () => {} }, undefined, {
      nodeUrl: "https://kernel.invalid", getIdentity: (id) => identities.get(id), fetcher, logger,
    });
    const auth = new AgentInferenceAuth("https://kernel.invalid", (id) => identities.get(id));
    await expect(auth.credential("artifact")).rejects.toMatchObject({ status: 403 });
    expect((await provider.cache.get()).outcome).toBe("auth-error");
    options.rediscover = async (id) => { authorized = true; return provider.refreshAfterAuthorization(id); };
    expect(await createSelfAuthorizer(options)()).toMatchObject({ authorized: true, discovery: "ok", models: ["imajin/agent-model"] });
    expect((await auth.credential("artifact")).token).toBeTruthy();
    expect(provider.cache.peek()).toMatchObject({ outcome: "ok", models: [{ id: "gateway-model" }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const discovery = wire.find((request) => request.path === "/infer/v1/models/usable")!;
    expect(discovery.headers.get("x-acting-as")).toBe("did:imajin:org-artifact");
    expect(discovery.headers.has("cookie")).toBe(false);
    const claims = JSON.parse(Buffer.from(discovery.headers.get("authorization")!.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ sub: "did:imajin:artifact", azp: "did:imajin:artifact" });
  });

  it("documents explicit self-consent after app registration in per-agent setup", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const section = readme.slice(readme.indexOf("### Calling-agent inference authentication"));
    expect(section).toContain("Per-agent setup, after app registration (#168)");
    expect(section).toContain('{"action":"self_authorize","agentId":"artifact"}');
    expect(section).toContain("No startup hook");
  });

  it.each([200, 201])("HTTP %s discards callback codes and never follows the returned redirect", async (httpStatus) => {
    status = httpStatus;
    const result = await createSelfAuthorizer(options)();
    expect(result.authorized).toBe(true);
    expect(JSON.stringify(result)).not.toContain(protectedDetail);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => new URL(String(url)).host === "kernel.invalid")).toBe(true);
    for (const [url, init] of vi.mocked(fetch).mock.calls) {
      if (String(url).includes("/api/registry/apps") || String(url).endsWith("/api/auth/authorize")) {
        expect(init?.redirect).toBe("error");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
      }
    }
  });

  it("evicts only the consenting agent's cached token", async () => {
    await createSelfAuthorizer({ ...options, callerId: "main", sessionKey: "agent:main:main" })();
    await createSelfAuthorizer(options)();
    const auth = new AgentInferenceAuth("https://kernel.invalid", (id) => identities.get(id));
    await auth.credential("main"); await auth.credential("artifact");
    const before = wire.filter((request) => request.path === "/auth/api/apps/token").length;
    auth.forget("artifact");
    await auth.credential("main"); await auth.credential("artifact");
    expect(wire.filter((request) => request.path === "/auth/api/apps/token")).toHaveLength(before + 1);
    expect(wire.at(-1)!.body.appDid).toBe("did:imajin:artifact");
  });
});

it("post-consent catalog refresh waits out an old in-flight failure before fetching again", async () => {
  let fail!: (error: Error) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }))
    .mockResolvedValueOnce({ data: [{ id: "recovered" }] });
  const cache = new ImajinCatalogCache(fetcher, 60_000, Date.now, logger);
  const old = cache.refresh();
  const recovery = cache.invalidateAndRefresh();
  fail(new ImajinDiscoveryError("auth-error", "pre-consent failure", 403));
  await old;
  expect(await recovery).toMatchObject({ outcome: "ok", models: [{ id: "recovered" }] });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
