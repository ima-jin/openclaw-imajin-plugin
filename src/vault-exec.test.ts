import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";
import { AgentIdentities, publicKeyDid, resolveAgentSigner, signerFromValue } from "./agent-identities.js";
import { parseVaultExecConfig, resolveVaultExec, runVaultExec } from "./vault-exec.js";
import { createIdentityTool } from "./tools.js";

const mocks = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(), readFile: mocks.read,
}));
vi.mock("openclaw/plugin-sdk/secret-ref-runtime", () => ({ resolveSecretRefValues: mocks.resolve }));

const request = (ids = ["artifact-identity"]) =>
  JSON.stringify({ protocolVersion: 1, provider: "imajin-vault", ids });
// Compare digests so assertion diagnostics cannot print throwaway private material.
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const failure = { protocolVersion: 1, values: {}, errors: { "artifact-identity": { code: "UNAVAILABLE" } } };
const config = { gatewayConfigPath: "/gateway.json", consumerDid: "", grants: { "artifact-identity": "grant_artifact" } };
let main: { did: string; publicKey: string; privateKey: string };
let target: typeof main;
let gateway: any;
let wire: Array<{ url: string; init: RequestInit }>;
let result: unknown;
let status: number;
let fetchMock: ReturnType<typeof vi.fn>;

async function keypair() {
  const privateBytes = randomBytes(32);
  const publicKey = Buffer.from(await ed.getPublicKeyAsync(privateBytes)).toString("hex");
  return { did: publicKeyDid(publicKey), publicKey, privateKey: privateBytes.toString("hex") };
}

beforeEach(async () => {
  main = await keypair();
  target = await keypair();
  config.consumerDid = main.did;
  gateway = { plugins: { entries: { imajin: { enabled: true, config: {
    nodeUrl: "https://kernel.invalid", did: main.did, keypairPath: "/existing-main.json",
  } } } } };
  mocks.read.mockReset().mockImplementation(async (path: string) => {
    if (path === "/gateway.json") return JSON.stringify(gateway);
    if (path === "/existing-main.json") return JSON.stringify(main);
    if (path === "/provider.json") return JSON.stringify(config);
    throw new Error(target.privateKey);
  });

  mocks.resolve.mockReset();
  wire = [];
  status = 200;
  result = { ok: true, field: "credential:artifact", value: JSON.stringify(target),
    purpose: "agent-keypair", oneTime: false, expiresAt: null };
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    wire.push({ url, init });
    if (url.endsWith("/challenge")) {
      const body = JSON.parse(init.body as string);
      expect(body.did).toBe(main.did);
      return Response.json({ challengeId: "challenge-id", challenge: main.publicKey,
        expiresAt: new Date(Date.now() + 300000).toISOString() });
    }
    if (url.endsWith("/verify")) {
      const { signature } = JSON.parse(init.body as string);
      expect(await ed.verifyAsync(signature, new TextEncoder().encode(main.publicKey), main.publicKey)).toBe(true);
      return Response.json({ did: main.did }, { headers: { "set-cookie": "session=throwaway; Path=/" } });
    }
    return Response.json(result, { status });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("imajin-vault exec provider", () => {
  it.each([
    {}, { challengeId: "" }, { challenge: "" }, { challenge: "not-hex" }, { challenge: "a" },
    { expiresAt: "bad-date" }, { expiresAt: "2000-01-01T00:00:00Z" },
  ])("refuses malformed or expired authentication challenges %#", async (patch) => {
    const body = Object.keys(patch).length ? {
      challengeId: "id", challenge: main.publicKey, expiresAt: new Date(Date.now() + 300000).toISOString(), ...patch,
    } : patch;
    fetchMock.mockResolvedValue(Response.json(body));
    expect(JSON.parse(await resolveVaultExec(request(), config))).toEqual(failure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { did: "did:imajin:wrong" }, { mfaRequired: true }])(
    "refuses malformed, wrong-DID or MFA verification responses %#", async (patch) => {
      fetchMock.mockImplementation(async (url: string) => url.endsWith("/challenge")
        ? Response.json({ challengeId: "id", challenge: main.publicKey, expiresAt: new Date(Date.now() + 300000).toISOString() })
        : Response.json(Object.keys(patch).length ? { did: main.did, ...patch } : patch,
          { headers: { "set-cookie": "session=throwaway" } }));
      expect(JSON.parse(await resolveVaultExec(request(), config))).toEqual(failure);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
  it.each([undefined, "did:imajin:org-artifact"])(
    "authenticates as the explicit main consumer, not the personal/org acting principal %#", async (actAs) => {
      gateway.plugins.entries.imajin.config.actAs = actAs;
      const response = JSON.parse(await resolveVaultExec(request(), config));
      expect(digest(response.values["artifact-identity"])).toBe(digest(JSON.stringify(target)));
      expect(response.errors).toEqual({});
      const fetch = wire[2];
      expect(fetch.url).toBe("https://kernel.invalid/auth/api/vault/delegation/grants/grant_artifact/fetch");
      expect(fetch.init.method).toBe("POST");
      const headers = new Headers(fetch.init.headers);
      expect(headers.get("X-Agent-DID")).toBe(main.did);
      expect(headers.get("Cookie")).toBe("session=throwaway");
      expect(headers.has("X-Acting-For")).toBe(false);
      expect(headers.has("x-acting-as")).toBe(false);
      for (const call of wire) {
        expect(call.init.redirect).toBe("error");
        expect(call.init.credentials).toBe("omit");
        expect(call.init.signal).toBeInstanceOf(AbortSignal);
        expect(new Headers(call.init.headers).get("Cache-Control")).toBe("no-store");
        expect(JSON.stringify(call).includes(target.privateKey)).toBe(false);
      }
    },
  );

  it.each([401, 403, 404, 410, 429, 500, 302])("fails closed for grant HTTP %i without body diagnostics", async (code) => {
    status = code;
    result = { error: target.privateKey };
    expect(JSON.parse(await resolveVaultExec(request(), config))).toEqual(failure);
  });

  it("never guesses an unmapped grant or reads a bootstrap key for it", async () => {
    expect(JSON.parse(await resolveVaultExec(request(), { ...config, grants: { other: "grant_other" } }))).toEqual(failure);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(await resolveVaultExec(request(["constructor"]), config)).values).toEqual({});
  });

  it.each(["challenge", "verify"])("redacts authentication failure at %s", async (step) => {
    fetchMock.mockImplementation(async (url: string) => url.endsWith(`/${step}`)
      ? Response.json({ error: target.privateKey }, { status: 401 })
      : Response.json({ challengeId: "id", challenge: main.publicKey,
        expiresAt: new Date(Date.now() + 300000).toISOString() }));
    expect(JSON.parse(await resolveVaultExec(request(), config))).toEqual(failure);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/fetch"))).toBe(false);
  });

  it.each([undefined, "", "session=", "bare"])("refuses absent/malformed auth cookie %#", async (cookie) => {
    fetchMock.mockImplementation(async (url: string) => url.endsWith("/challenge")
      ? Response.json({ challengeId: "id", challenge: main.publicKey,
        expiresAt: new Date(Date.now() + 300000).toISOString() })
      : Response.json({ did: main.did }, cookie === undefined ? {} : { headers: { "set-cookie": cookie } }));
    expect(JSON.parse(await resolveVaultExec(request(), config))).toEqual(failure);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("redacts network exceptions", async () => {
    fetchMock.mockRejectedValue(new Error(target.privateKey));
    expect(JSON.parse(await resolveVaultExec(request(), config))).toEqual(failure);
  });

  it.each([
    null, [], {}, { ok: false }, { value: "" }, { value: 1 }, { field: null },
    { purpose: 1 }, { oneTime: true }, { oneTime: undefined }, { expiresAt: undefined },
    { expiresAt: "not-a-date" }, { expiresAt: "2000-01-01T00:00:00Z" },
  ])("rejects malformed/expired/one-time grant bodies %#", async (patch) => {
    result = patch === null || Array.isArray(patch) || Object.keys(patch).length === 0
      ? patch : { ...(result as object), ...patch };
    expect(JSON.parse(await resolveVaultExec(request(), config))).toEqual(failure);
  });

  it("accepts a future expiry and rejects invalid JSON and oversized responses", async () => {
    result = { ...(result as object), expiresAt: new Date(Date.now() + 60000).toISOString() };
    expect(Object.keys(JSON.parse(await resolveVaultExec(request(), config)).values)).toEqual(["artifact-identity"]);
    for (const body of ["{invalid", "x".repeat(262145)]) {
      fetchMock.mockResolvedValue(new Response(body));
      expect(JSON.parse(await resolveVaultExec(request(), config))).toEqual(failure);
    }
  });

  it.each([
    { enabled: false }, { did: "did:imajin:other" }, { keypairPath: undefined },
    { keypairPath: "relative" }, { nodeUrl: "http://kernel.invalid" },
    { nodeUrl: "https://user:pass@kernel.invalid" }, { nodeUrl: "https://kernel.invalid/path" },
    { nodeUrl: "https://kernel.invalid?q=1" }, { nodeUrl: "https://kernel.invalid/#fragment" },
    { nodeUrl: "not-url" },
  ])("refuses invalid or mismatched bootstrap configuration %#", async (patch) => {
    if ("enabled" in patch) gateway.plugins.entries.imajin.enabled = patch.enabled;
    else Object.assign(gateway.plugins.entries.imajin.config, patch);
    expect(JSON.parse(await resolveVaultExec(request(), config))).toEqual(failure);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses malformed or mismatched bootstrap key material without any fallback", async () => {
    for (const raw of ["not-json", JSON.stringify(target), JSON.stringify({ did: main.did })]) {
      mocks.read.mockImplementation(async (path: string) => path === "/gateway.json" ? JSON.stringify(gateway) : raw);
      expect(JSON.parse(await resolveVaultExec(request(), config))).toEqual(failure);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["nested", "publicKeyHex"])("supports the existing main keypair file format %s", async (format) => {
    const stored = format === "nested"
      ? { did: main.did, keypair: { publicKey: main.publicKey, privateKey: main.privateKey } }
      : { ...main, publicKey: "public-base58-compat", publicKeyHex: main.publicKey };
    mocks.read.mockImplementation(async (path: string) =>
      JSON.stringify(path === "/gateway.json" ? gateway : stored));
    const response = JSON.parse(await resolveVaultExec(request(), config));
    expect(digest(response.values["artifact-identity"])).toBe(digest(JSON.stringify(target)));
  });

  it.each([
    "", "not-json", "null", "[]", "{}", JSON.stringify({ protocolVersion: 2, provider: "imajin-vault", ids: ["a"] }),
    JSON.stringify({ protocolVersion: 1, provider: "other", ids: ["a"] }),
    ...[[], ["a", "a"], [null], ["../a"], ["a/./b"], ["a/../b"], [" a"], ["a".repeat(257)],
      Array.from({ length: 65 }, (_, n) => `id${n}`)]
      .map((ids) => JSON.stringify({ protocolVersion: 1, provider: "imajin-vault", ids })),
    request().replace('"ids"', '"extra":true,"ids"'), " ".repeat(262145),
  ])("rejects invalid protocol input before I/O %#", async (raw) => {
    await expect(resolveVaultExec(raw, config)).rejects.toThrow("imajin-vault: resolution unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each([
    null, [], {}, { gatewayConfigPath: "relative" }, { consumerDid: "personal-session" },
    { grants: [] }, { grants: {} }, { grants: { "../id": "grant" } },
    { grants: { id: "" } }, { grants: { id: "../grant" } }, { grants: { id: 1 } },
    { grants: Object.fromEntries(Array.from({ length: 65 }, (_, n) => [`id${n}`, "grant"])) },
    { extra: true },
  ])("rejects invalid non-secret mapping configuration %#", (patch) => {
    const input = patch === null || Array.isArray(patch) || Object.keys(patch).length === 0
      ? patch : { ...config, ...patch };
    expect(() => parseVaultExecConfig(input)).toThrow("imajin-vault: resolution unavailable");
  });

  it("isolates a failed id while returning a healthy id", async () => {
    const response = JSON.parse(await resolveVaultExec(request(["missing", "artifact-identity"]), config));
    expect(Object.keys(response.values)).toEqual(["artifact-identity"]);
    expect(response.errors).toEqual({ missing: { code: "UNAVAILABLE" } });
  });
  it("coalesces bootstrap/auth across a batch but fetches every mapped grant", async () => {
    const batch = { ...config, grants: { first: "grant_first", second: "grant_second" } };
    const response = JSON.parse(await resolveVaultExec(request(["first", "second"]), batch));
    expect(Object.keys(response.values).sort()).toEqual(["first", "second"]);
    expect(wire.filter((row) => row.url.endsWith("/challenge"))).toHaveLength(1);
    expect(wire.filter((row) => row.url.endsWith("/verify"))).toHaveLength(1);
    expect(wire.filter((row) => row.url.endsWith("/fetch"))).toHaveLength(2);
    expect(mocks.read.mock.calls.map(([path]) => path)).toEqual(["/gateway.json", "/existing-main.json"]);
  });

  it("rejects oversized aggregate output without emitting any partial values", async () => {
    const batch = { ...config, grants: { first: "grant_first", second: "grant_second" } };
    result = { ...(result as object), value: JSON.stringify(target).repeat(700) };
    const out = vi.fn(), err = vi.fn();
    mocks.read.mockImplementation(async (path: string) =>
      JSON.stringify(path === "/provider.json" ? batch : path === "/gateway.json" ? gateway : main));
    async function* stdin() { yield request(["first", "second"]); }
    expect(await runVaultExec(["--config", "/provider.json"], stdin(), out, err)).toBe(1);
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith("imajin-vault: resolution unavailable\n");
  });

  it("loads agents.<id>.keypair and removes it on the next refresh after revocation, with no value in tools or logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.resolve.mockImplementation(async ([ref]) => {
      const response = JSON.parse(await resolveVaultExec(request([ref.id]), config));
      if (!Object.hasOwn(response.values, ref.id)) throw new Error(target.privateKey);
      return new Map([[ref.id, response.values[ref.id]]]);
    });
    const agents = { artifact: { did: target.did,
      keypair: { source: "exec" as const, provider: "imajin-vault", id: "artifact-identity" } } };
    const identities = new AgentIdentities();
    await identities.prepare("https://kernel.invalid", agents, {}, resolveAgentSigner);
    const identity = identities.get("artifact");
    expect(identity).toBeDefined();
    // A tool gets only public identity data, never the keypair/protocol payload.
    vi.spyOn(identity!.client, "lookupIdentity").mockResolvedValue({ did: target.did, scope: "actor", subtype: "agent" });
    const tool = createIdentityTool(identity!.client);
    const toolResult = await tool.execute("test", { action: "lookup", query: target.did });
    expect(toolResult.details).toEqual({ did: target.did, scope: "actor", subtype: "agent" });
    expect(JSON.stringify(toolResult).includes(target.privateKey)).toBe(false);
    expect(JSON.stringify(identity).includes(target.privateKey)).toBe(false);
    status = 403;
    result = { error: target.privateKey };
    await identities.prepare("https://kernel.invalid", agents, {}, resolveAgentSigner);
    expect(identities.get("artifact")).toBeUndefined();
    expect(wire.filter((row) => row.url.endsWith("/fetch"))).toHaveLength(2);
    expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]).includes(target.privateKey)).toBe(false);
  });

  it("redacts malformed keypair parser errors", async () => {
    let caught: unknown;
    try { await signerFromValue(`invalid${target.privateKey}`, target.did); } catch (error) { caught = error; }
    expect(String(caught)).toBe("Error: Identity keypair unavailable");
  });
  it("rejects public-DID and private/public mismatches using only generated throwaway keys", async () => {
    const invalid = [
      { ...target, publicKey: main.publicKey }, { ...target, privateKey: main.privateKey },
      { ...target, privateKey: 1 }, null,
    ];
    await Promise.all(invalid.map(async (key) => {
      await expect(signerFromValue(key, target.did)).rejects.toThrow("Identity keypair unavailable");
    }));
  });

  it("CLI writes only the private protocol response, with no stderr or secret file writes", async () => {
    const out = vi.fn();
    const err = vi.fn();
    async function* stdin() { yield Buffer.from(request()); }
    expect(await runVaultExec(["--config", "/provider.json"], stdin(), out, err)).toBe(0);
    expect(out).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out.mock.calls[0][0]).protocolVersion).toBe(1);
    expect(err).not.toHaveBeenCalled();
    expect(mocks.read.mock.calls.map(([path]) => path)).toEqual(["/provider.json", "/gateway.json", "/existing-main.json"]);
  });

  it.each([[], ["--config", "relative"], ["--unknown", "/provider.json"], ["--config", "/provider.json", "extra"]].map((args) => ({ args })))(
    "CLI redacts argument and input failures %#", async ({ args }) => {
      const out = vi.fn(), err = vi.fn();
      async function* stdin() { yield `not-json${target.privateKey}`; }
      expect(await runVaultExec(args, stdin(), out, err)).toBe(1);
      expect(out).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledTimes(1);
      expect(err).toHaveBeenCalledWith("imajin-vault: resolution unavailable\n");
    },
  );

  it("CLI bounds input and sanitizes stream/config read errors", async () => {
    for (const mode of ["oversize", "stream-error", "config-error"]) {
      const out = vi.fn(), err = vi.fn();
      async function* stdin() {
        if (mode === "stream-error") throw new Error(target.privateKey);
        yield mode === "oversize" ? " ".repeat(262145) : request();
      }
      if (mode === "config-error") mocks.read.mockRejectedValue(new Error(target.privateKey));
      expect(await runVaultExec(["--config", "/provider.json"], stdin(), out, err)).toBe(1);
      expect(out).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledWith("imajin-vault: resolution unavailable\n");
    }
  });
});
