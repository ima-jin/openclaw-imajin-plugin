import { generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, StreamFn, StreamModel } from "openclaw/plugin-sdk/llm";
import { AgentInferenceAuth } from "./inference-auth.js";
import { createAgentInferenceWrapper } from "./inference-stream.js";
import { ImajinClient } from "./client.js";
import type { AgentIdentity } from "./agent-identities.js";
import { registerImajinProvider, IMAJIN_PROVIDER_IDS } from "./imajin-provider.js";
import { buildStatusIdentity } from "./status-identity.js";
import { verifyAssignedAgentRequest } from "./test-fixtures/assigned-agent-verifier.js";

const kernelKey = generateKeyPairSync("ed25519");
const identities = new Map<string, AgentIdentity>();
const publicKeys = new Map<string, ReturnType<typeof generateKeyPairSync>["publicKey"]>();
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function mintJwt(appDid: string, sub: string, exp = Date.now() / 1000 + 600, claims = {}, header = {}) {
  const unsigned = `${encode({ typ: "app+jwt", alg: "EdDSA", ...header })}.${encode({
    azp: appDid, sub, exp, iss: "auth.imajin.ai", aud: "imajin:apps", scope: "infer:completions",
    attestationId: randomUUID(), jti: randomUUID(), ...claims,
  })}`;
  return `${unsigned}.${sign(null, Buffer.from(unsigned), kernelKey.privateKey).toString("base64url")}`;
}
function agent(id: string, actAs?: string): AgentIdentity {
  const pair = generateKeyPairSync("ed25519");
  const did = `did:imajin:${id}`;
  publicKeys.set(did, pair.publicKey);
  return {
    config: { did, ...(actAs ? { actAs } : {}), keypair: { source: "store", provider: "sealed", id } },
    signer: { did, signChallenge: async (challenge) => sign(null, Buffer.from(challenge), pair.privateKey).toString("hex") },
    client: new ImajinClient({ nodeUrl: "https://unused.invalid" }),
  };
}
const model: StreamModel = { id: "agent-only-model", api: "openai-completions", provider: "imajin" };
const message = (errorMessage?: string): AssistantMessage => ({
  role: "assistant", content: [], api: model.api, model: model.id, provider: model.provider, usage: {},
  stopReason: errorMessage ? "error" : "stop", timestamp: Date.now(), ...(errorMessage ? { errorMessage } : {}),
});
async function events(stream: ReturnType<StreamFn>): Promise<AssistantMessageEvent[]> {
  const result: AssistantMessageEvent[] = [];
  for await (const event of await stream) result.push(event);
  return result;
}

describe("calling-agent provider wire contract", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let auth: AgentInferenceAuth;
  let mints: Array<Record<string, string>>;
  let requests: IncomingMessage[];
  let statuses: number[];
  let mintStatus: number;
  let outputText: string;
  let inner: StreamFn;
  const controller = (principalDid: string, callerDid: string) => ({
    valid: [...identities.values()].some((identity) =>
      identity.config.did === callerDid && identity.config.actAs === principalDid),
    role: "agent", allowedServices: ["infer"],
  });

  beforeEach(async () => {
    identities.clear(); publicKeys.clear();
    identities.set("main", agent("main", "did:imajin:personal"));
    identities.set("artifact", agent("artifact", "did:imajin:org"));
    mints = []; requests = []; statuses = []; mintStatus = 200; outputText = "";
    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/auth/api/apps/token") {
        const mint = JSON.parse(body);
        mints.push(mint);
        const challenge = `${mint.appDid}:${mint.principalDid}:${mint.nonce}:${mint.timestamp}`;
        expect(verify(null, Buffer.from(challenge), publicKeys.get(mint.appDid)!, Buffer.from(mint.signature, "hex"))).toBe(true);
        expect(mint.scope).toBe("infer:completions");
        expect(mint).not.toHaveProperty("actAs");
        expect(req.headers["x-acting-as"]).toBeUndefined();
        expect(mint.aud).toBeUndefined();
        expect(mint.nonce.length).toBeGreaterThanOrEqual(16);
        res.statusCode = mintStatus;
        res.end(JSON.stringify(mintStatus === 200
          ? { token: mintJwt(mint.appDid, mint.principalDid), expiresIn: 600, scopes: ["infer:completions"] }
          : { error: "no_live_grant" }));
        return;
      }
      requests.push(req);
      const verified = verifyAssignedAgentRequest(new Headers(req.headers as Record<string, string>), kernelKey.publicKey, controller);
      if (verified.status !== 200) {
        res.statusCode = verified.status;
        res.end(JSON.stringify({ error: verified.status === 401 ? "invalid_agent_credential" : "Not authorized to act as this group" }));
        return;
      }
      const status = statuses.shift() ?? 200;
      res.statusCode = status;
      if (req.url === "/infer/v1/self") {
        res.end(JSON.stringify(status === 200 ? {
          identity: { did: verified.appAuth?.appDid, actAs: verified.appAuth?.actingAs ?? null },
          connectors: [], usableModels: [],
        } : { error: outputText }));
        return;
      }
      if (status === 200 && JSON.parse(body).stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.end(`data: ${JSON.stringify({
          id: "completion", object: "chat.completion.chunk", created: 0, model: model.id,
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`);
        return;
      }
      res.end(JSON.stringify(status === 200 ? { text: "ok" } : {
        error: status === 401 ? "invalid_agent_credential" : "member grant required", detail: outputText,
      }));
    };
    server = createServer((req, res) => { void handle(req, res); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    auth = new AgentInferenceAuth(baseUrl, (id) => identities.get(id));
    // Normal transport contract: model defaults then options, apiKey -> Bearer.
    inner = async function* (currentModel, _context, options) {
      yield { type: "start", partial: message() };
      const response = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
        method: "POST", signal: options?.signal,
        headers: { Authorization: `Bearer ${options?.apiKey}`, ...currentModel.headers, ...options?.headers },
        body: JSON.stringify({ model: currentModel.id, messages: [] }),
      });
      await options?.onResponse?.({ status: response.status, headers: {} }, currentModel);
      const body = await response.text();
      yield response.ok ? { type: "done", reason: "stop", message: message() }
        : { type: "error", reason: "error", error: message(`${response.status} ${body}`) };
    };
  });
  it.each(["__proto__", " main", "bad\nid"])("rejects invalid agentId case %# without exposing the value", (agentId) => {
    expect(() => createAgentInferenceWrapper(auth)({ agentId, streamFn: inner })).toThrow("agentId");
    expect(mints).toEqual([]); expect(requests).toEqual([]);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const call = (id: string, stream?: StreamFn) =>
    createAgentInferenceWrapper(auth)({ agentId: id, streamFn: stream ?? inner })(model, {}, {});
  it.each(["main", "artifact"])("%s self-discovery uses own app-token, never a session cookie or another agent", async (agentId) => {
    const identity = identities.get(agentId)!;
    const snapshot = await auth.discoverSelf(agentId);
    expect(snapshot).toMatchObject({ identity: { did: identity.config.did, actAs: identity.config.actAs } });
    expect(mints).toHaveLength(1);
    expect(mints[0]).toMatchObject({ appDid: identity.config.did, principalDid: identity.config.did });
    const request = requests.at(-1)!;
    expect(request.method).toBe("GET");
    expect(request.url).toBe("/infer/v1/self");
    expect(request.headers["x-acting-as"]).toBe(identity.config.actAs);
    expect(request.headers["cache-control"]).toBe("no-store");
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers["x-acting-for"]).toBeUndefined();
    const token = (await auth.credential(agentId)).token;
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    expect(mints).toHaveLength(1);
  });

  it.each([401, 403, 404, 429, 503])("self-discovery HTTP %s stays status-only with no retry/fallback", async (status) => {
    outputText = randomUUID();
    statuses = [status];
    await expect(auth.discoverSelf("artifact")).rejects.toMatchObject({ status, message: expect.not.stringContaining(outputText) });
    expect(mints).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });
  it("personal self-discovery omits act-as and never selects a gateway principal", async () => {
    identities.set("main", agent("main"));
    expect(await auth.discoverSelf("main")).toMatchObject({ identity: { did: "did:imajin:main", actAs: null } });
    expect(requests[0].headers["x-acting-as"]).toBeUndefined();
    expect(mints[0].principalDid).toBe("did:imajin:main");
  });

  it.each(["json", "network", "retired"])("self-discovery contains %s failure without retaining protected diagnostics", async (kind) => {
    const protectedDetail = randomUUID();
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (!String(url).endsWith("/infer/v1/self")) return originalFetch(url, init);
      if (kind === "network") throw new Error(protectedDetail);
      if (kind === "retired") identities.delete("main");
      return new Response(kind === "json" ? protectedDetail : "{}", { status: 200 });
    });
    await expect(auth.discoverSelf("main")).rejects.toMatchObject({
      message: expect.not.stringContaining(protectedDetail),
    });
    expect(requests).toHaveLength(0);
  });

  it.each(["", "absent", "__proto__", " other"])("self-discovery rejects invalid caller %# before mint", async (agentId) => {
    await expect(auth.discoverSelf(agentId)).rejects.toThrow("Imajin inference");
    expect(mints).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it.each([
    { agentId: "main", context: "main→Ryan" },
    { agentId: "artifact", context: "artifact→@artifact" },
  ])("$context uses an agent-subject token plus selector; target-subject tokens are refused (#3236)", async ({ agentId }) => {
    const { did, actAs } = identities.get(agentId)!.config;
    const targetSubject = mintJwt(did, actAs!);
    const lookup = vi.fn(controller);
    expect(verifyAssignedAgentRequest(new Headers({
      Authorization: `Bearer ${targetSubject}`, "x-acting-as": actAs!,
    }), kernelKey.publicKey, lookup).status).toBe(403);
    expect(lookup).toHaveBeenLastCalledWith(actAs, actAs);
    const rejected = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${targetSubject}`, "x-acting-as": actAs! },
      body: JSON.stringify({ model: model.id, messages: [] }),
    });
    expect(rejected.status).toBe(403);
    const outcome = await events(call(agentId));
    expect(outcome.at(-1)?.type).toBe("done");
    expect(mints.at(-1)?.principalDid).toBe(did);
    expect(mints.at(-1)?.principalDid).not.toBe(actAs);
    const request = requests.at(-1)!;
    const verified = verifyAssignedAgentRequest(new Headers(request.headers as Record<string, string>), kernelKey.publicKey, lookup);
    expect(verified).toMatchObject({ status: 200, appAuth: { appDid: did, userDid: did, actingAs: actAs } });
    expect(lookup).toHaveBeenLastCalledWith(actAs, did);
    expect(request.headers["x-acting-for"]).toBeUndefined();
  });

  it.each(["main", "artifact"])("%s verifier still refuses invalid signatures, scope and current assignment", async (agentId) => {
    const { did, actAs } = identities.get(agentId)!.config;
    const { token } = await auth.credential(agentId);
    const headers = new Headers({ Authorization: `Bearer ${token}`, "x-acting-as": actAs! });
    expect(verifyAssignedAgentRequest(headers, kernelKey.publicKey, controller).status).toBe(200);
    for (const authority of [
      { valid: false, role: "agent" }, { valid: true, role: "member" },
      { valid: true, role: "agent", allowedServices: [] },
    ]) {
      expect(verifyAssignedAgentRequest(headers, kernelKey.publicKey, () => authority).status).toBe(403);
    }
    headers.set("Authorization", `Bearer ${mintJwt(did, did, undefined, { scope: "other" })}`);
    expect(verifyAssignedAgentRequest(headers, kernelKey.publicKey, controller).status).toBe(403);
    const [head, claims] = token.split(".");
    headers.set("Authorization", `Bearer ${head}.${claims}.${Buffer.alloc(64).toString("base64url")}`);
    expect(verifyAssignedAgentRequest(headers, kernelKey.publicKey, controller).status).toBe(401);
  });

  // Optional peer integration: point at @openclaw/ai's dist directory, never a live kernel.
  it.runIf(Boolean(process.env.IMAJIN_TEST_TRANSPORT_DIR)).each([200, 401, 403])(
    "published OpenClaw transport keeps credentials private and handles HTTP %s", async (status) => {
      const directory = process.env.IMAJIN_TEST_TRANSPORT_DIR!;
      const { createNodeLlmRuntime } = await import(/* @vite-ignore */ `${directory}/index.mjs`);
      const { registerBuiltInApiProviders } = await import(/* @vite-ignore */ `${directory}/providers.mjs`);
      const runtime = createNodeLlmRuntime();
      registerBuiltInApiProviders(runtime.registry);
      statuses = status === 401 ? [401, 200] : [status];
      const wrapped = createAgentInferenceWrapper(auth)({ agentId: "artifact", streamFn: runtime.streamSimple });
      const result = await events(wrapped({
        ...model, baseUrl: `${baseUrl}/openai/v1`, name: model.id, input: ["text"],
        reasoning: false, contextWindow: 128000, maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        headers: { authorization: "static-test-marker", "x-api-key": "static-test-marker" },
      }, { messages: [] }, { apiKey: "static-test-marker", headers: { Authorization: "static-test-marker" } }));
      expect(result.at(-1)?.type).toBe(status === 403 ? "error" : "done");
      expect(requests).toHaveLength(status === 401 ? 2 : 1);
      expect(mints).toHaveLength(status === 401 ? 2 : 1);
      for (const request of requests) {
        expect(request.headers.authorization?.startsWith("Bearer ey")).toBe(true);
        expect(request.rawHeaders.filter((h) => h.toLowerCase() === "authorization")).toHaveLength(1);
        expect(request.headers["x-acting-as"]).toBe("did:imajin:org");
        expect(JSON.stringify(request.headers)).not.toContain("static-test-marker");
      }
    },
  );

  it.each(IMAJIN_PROVIDER_IDS)("registers %s and signs two concurrent callers with distinct JWTs and their own selectors", async (providerId) => {
    const providers: any[] = [];
    registerImajinProvider({ registerProvider: (definition) => providers.push(definition) }, undefined, {
      nodeUrl: baseUrl, getIdentity: (id) => identities.get(id),
    });
    const provider = providers.find((entry) => entry.id === providerId);
    const marker = "non-secret-static-test-marker";
    const invoke = (agentId: string) => provider.wrapStreamFn({ agentId, streamFn: inner })(
      { ...model, headers: { aUtHoRiZaTiOn: marker, "X-API-Key": marker, "X-Acting-As": "did:imajin:wrong" } }, {},
      { apiKey: marker, headers: { authorization: marker, "x-api-key": marker, "x-acting-as": "did:imajin:wrong", "x-imajin-run": "run" } },
    );
    await Promise.all([events(invoke("main")), events(invoke("artifact"))]);
    expect(requests).toHaveLength(2);
    const seen = requests.map((req) => {
      const token = req.headers.authorization!.slice(7);
      const [header, claims, signature] = token.split(".");
      expect(verify(null, Buffer.from(`${header}.${claims}`), kernelKey.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
      expect(req.rawHeaders.filter((h) => h.toLowerCase() === "authorization")).toHaveLength(1);
      expect(JSON.stringify(req.headers)).not.toContain(marker);
      expect(req.headers["x-api-key"]).toBeUndefined();
      expect(req.headers["x-imajin-run"]).toBe("run");
      return { token, azp: JSON.parse(Buffer.from(claims, "base64url").toString()).azp, actAs: req.headers["x-acting-as"] };
    });
    expect(new Set(seen.map((row) => row.token)).size).toBe(2);
    expect(seen).toEqual(expect.arrayContaining([
      expect.objectContaining({ azp: "did:imajin:main", actAs: "did:imajin:personal" }),
      expect.objectContaining({ azp: "did:imajin:artifact", actAs: "did:imajin:org" }),
    ]));
    expect(provider.resolveSyntheticAuth().apiKey).toBe("imajin-local-proxy");
    if (providerId !== "imajin") {
      expect(provider.catalog).toBeUndefined();
      expect(provider.staticCatalog).toBeUndefined();
    }
  });

  it("personal context omits even inherited selectors and uses only its own DID as mint principal", async () => {
    identities.set("main", agent("main"));
    await events(call("main"));
    expect(requests[0].headers["x-acting-as"]).toBeUndefined();
    expect(mints[0].principalDid).toBe("did:imajin:main");
  });

  it.each([
    ["main", "/anthropic/v1/messages"], ["artifact", "/anthropic/v1/messages"],
    ["main", "/anthropic/v1/messages/count_tokens"], ["artifact", "/anthropic/v1/messages/count_tokens"],
  ])("%s signs %s with its own app JWT, stripping inherited secrets but retaining Anthropic headers", async (agentId, path) => {
    if (agentId === "main") identities.set("main", agent("main"));
    const headers = {
      aUtHoRiZaTiOn: "inherited-marker", "X-API-KEY": "inherited-marker", "Api-Key": "inherited-marker",
      "X-Acting-As": "did:imajin:wrong", "X-Acting-For": "did:imajin:wrong", Cookie: "inherited-marker",
      "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31",
    };
    const transport: StreamFn = async function* (current, _context, options) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST", headers: { ...current.headers, ...options?.headers },
        body: JSON.stringify({ model: current.id, messages: [] }),
      });
      expect(response.status).toBe(200);
      yield { type: "done", reason: "stop", message: message() };
    };
    const providers: any[] = [];
    registerImajinProvider({ registerProvider: (definition) => providers.push(definition) }, undefined, {
      nodeUrl: baseUrl, getIdentity: (id) => identities.get(id),
    });
    const provider = providers.find((entry) => entry.id === "imajin-anthropic");
    await events(provider.wrapStreamFn({ agentId, streamFn: transport })(
      { ...model, api: "anthropic-messages", headers }, {}, { headers, apiKey: "inherited-marker" },
    ));
    const request = requests.at(-1)!;
    expect(request.url).toBe(path);
    expect(verifyAssignedAgentRequest(new Headers(request.headers as Record<string, string>), kernelKey.publicKey, controller))
      .toMatchObject({ status: 200, appAuth: { appDid: `did:imajin:${agentId}`, userDid: `did:imajin:${agentId}` } });
    expect(request.headers["x-acting-as"]).toBe(agentId === "artifact" ? "did:imajin:org" : undefined);
    for (const header of ["x-api-key", "api-key", "x-acting-for", "cookie"]) expect(request.headers[header]).toBeUndefined();
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(JSON.stringify(request.headers)).not.toContain("inherited-marker");
  });

  it("reuses cached credentials and coalesces concurrent mints", async () => {
    await Promise.all([events(call("main")), events(call("main"))]);
    await events(call("main"));
    expect(mints).toHaveLength(1);
    expect(new Set(requests.map((req) => req.headers.authorization)).size).toBe(1);
  });

  it("settles result() without requiring the caller to drain the event iterator", async () => {
    const stream = await call("main") as AssistantMessageEventStream;
    expect((await stream.result()).stopReason).toBe("stop");
    expect((await events(stream)).map((event) => event.type)).toEqual(["start", "done"]);
  });
  it.each(["absent", "unlisted"])("missing agents.%s fails before any request", async (id) => {
    expect(() => call(id)).toThrow(`agents.${id}`);
    expect(mints).toEqual([]); expect(requests).toEqual([]);
  });
  it("missing agentId fails closed, never choosing main", () => {
    expect(() => createAgentInferenceWrapper(auth)({ streamFn: inner })).toThrow("agentId");
    expect(mints).toEqual([]); expect(requests).toEqual([]);
  });
  it("missing streamFn fails closed", () => {
    expect(() => createAgentInferenceWrapper(auth)({ agentId: "main" })).toThrow("streamFn");
  });
  it("invalid actAs fails before mint/transport and does not disclose its value", () => {
    identities.get("artifact")!.config.actAs = "invalid-selector";
    expect(() => call("artifact")).toThrow("agents.artifact");
    try { call("artifact"); } catch (error) { expect(String(error)).not.toContain("invalid-selector"); }
    expect(mints).toEqual([]); expect(requests).toEqual([]);
  });
  it("missing app.authorized surfaces the calling config and no inference request", async () => {
    mintStatus = 403;
    await expect(call("artifact")).rejects.toThrow("agents.artifact");
    expect(mints).toHaveLength(1); expect(requests).toEqual([]);
  });
  it("401 refreshes once for the same caller, retaining the org selector", async () => {
    statuses = [401, 200];
    expect((await events(call("artifact"))).map((event) => event.type)).toEqual(["start", "done"]);
    expect(mints.map((mint) => mint.appDid)).toEqual(["did:imajin:artifact", "did:imajin:artifact"]);
    expect(requests.map((req) => req.headers["x-acting-as"])).toEqual(["did:imajin:org", "did:imajin:org"]);
    expect(requests[0].headers.authorization).not.toBe(requests[1].headers.authorization);
  });
  it("a second 401 terminates after one refresh without another identity", async () => {
    statuses = [401, 401];
    const result = await events(call("artifact"));
    expect(result.at(-1)?.type).toBe("error");
    expect(mints).toHaveLength(2); expect(requests).toHaveLength(2);
    await auth.credential("artifact");
    expect(mints).toHaveLength(3);
  });
  it.each([403, 500, 503])("passes HTTP %s refusal unretried with its body", async (status) => {
    statuses = [status]; outputText = "membership boundary";
    const result = await events(call("artifact"));
    expect(result.at(-1)).toMatchObject({ type: "error", error: { errorMessage: `${status} ${JSON.stringify({
      error: "member grant required", detail: outputText,
    })}` } });
    expect(mints).toHaveLength(1); expect(requests).toHaveLength(1);
  });
  it("redacts JWTs in errors and emits no credentials in logs", async () => {
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const credential = await auth.credential("artifact");
    outputText = credential.token;
    statuses = [403];
    const result = JSON.stringify(await events(call("artifact")));
    expect(result).not.toContain(credential.token);
    expect(result).toContain("[redacted]");
    expect([log.mock.calls, warn.mock.calls, error.mock.calls]).toEqual([[], [], []]);
    const identity = identities.get("artifact")!;
    const status = JSON.stringify(buildStatusIdentity({
      agentId: "artifact", mode: "map", did: identity.config.did, actAs: identity.config.actAs,
      client: identity.client, isGatewayAgent: false,
    }));
    expect(status).not.toContain(credential.token);
    expect(status).not.toContain("privateKey");
  });
  it("does not retry after streamed content has begun", async () => {
    const stream: StreamFn = async function* () {
      yield { type: "text_delta", delta: "already sent" };
      yield { type: "error", reason: "error", error: message("401 invalid_agent_credential") };
    };
    expect((await events(call("artifact", stream))).map((event) => event.type)).toEqual(["text_delta", "error"]);
    expect(mints).toHaveLength(1);
  });
  it("redacts thrown SDK errors and recognizes a numeric 401 only with the credential code", async () => {
    let attempts = 0;
    const stream: StreamFn = async () => {
      attempts++;
      throw Object.assign(new Error("401 invalid_agent_credential"), { status: 401 });
    };
    expect((await events(call("main", stream))).at(-1)).toMatchObject({ type: "error", error: { errorMessage: expect.stringContaining("agents.main") } });
    expect(attempts).toBe(2);
    expect(mints).toHaveLength(2);
  });
  it("aborts before minting and does not retry cancellation", async () => {
    const signal = AbortSignal.abort();
    const wrapped = createAgentInferenceWrapper(auth)({ agentId: "main", streamFn: inner });
    await expect(wrapped(model, {}, { signal })).rejects.toThrow();
    expect(mints).toEqual([]); expect(requests).toEqual([]);
  });
  it("a stale 401 shares an already-refreshed token instead of minting twice", async () => {
    const old = await auth.credential("main");
    const current = await auth.credential("main", old.token);
    expect(await auth.credential("main", old.token)).toBe(current);
    expect(mints).toHaveLength(2);
  });
  it("cleared/removed identity cannot reuse old credentials or a captured wrapper", async () => {
    const wrapped = createAgentInferenceWrapper(auth)({ agentId: "main", streamFn: inner });
    await events(wrapped(model, {}));
    identities.clear(); auth.clear();
    await expect(wrapped(model, {})).rejects.toThrow("agents.main");
    expect(requests).toHaveLength(1);
  });
});

describe("mint validation and expiration", () => {
  let identity: AgentIdentity;
  beforeEach(() => { identity = agent("main", "did:imajin:principal"); });
  it("isolates configured selector changes and a replaced signer generation", async () => {
    const mint = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      return Response.json({ token: mintJwt(body.appDid, body.principalDid), expiresIn: 600, scopes: ["infer:completions"] });
    });
    const auth = new AgentInferenceAuth("https://kernel.invalid", () => identity, mint);
    const first = await auth.credential("main");
    identity.config.actAs = "did:imajin:new-org";
    expect((await auth.credential("main")).token).not.toBe(first.token);
    identity = agent("main", "did:imajin:new-org");
    await auth.credential("main");
    expect(mint).toHaveBeenCalledTimes(3);
  });
  it("does not publish an in-flight mint after the runtime cache is cleared", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const mint = vi.fn(async () => {
      await wait;
      return Response.json({ token: mintJwt(identity.config.did, identity.config.did), expiresIn: 600, scopes: ["infer:completions"] });
    });
    const auth = new AgentInferenceAuth("https://kernel.invalid", () => identity, mint);
    const pending = auth.credential("main");
    auth.clear(); release();
    await expect(pending).rejects.toThrow("runtime changed");
  });
  it("missing node URL and signer mismatch refuse without network access", async () => {
    const mint = vi.fn();
    const auth = new AgentInferenceAuth(undefined, () => identity, mint);
    await expect(auth.credential("main")).rejects.toThrow("nodeUrl");
    identity.signer.did = "did:imajin:wrong";
    await expect(auth.credential("main")).rejects.toThrow("agents.main");
    expect(mint).not.toHaveBeenCalled();
  });
  it("refreshes at exp minus 60s using the earlier of JWT and response TTL", async () => {
    let now = Date.now();
    const mint = vi.fn(async () => Response.json({
      token: mintJwt(identity.config.did, identity.config.did, now / 1000 + 300),
      expiresIn: 600, scopes: ["infer:completions"],
    }));
    const auth = new AgentInferenceAuth("https://kernel.invalid/", () => identity, mint, () => now);
    await auth.credential("main");
    now += 239_000; await auth.credential("main"); expect(mint).toHaveBeenCalledTimes(1);
    now += 2_000; await auth.credential("main"); expect(mint).toHaveBeenCalledTimes(2);
  });
  it.each([
    { claims: { azp: "did:imajin:other" } }, { claims: { sub: "did:imajin:other" } },
    { claims: { aud: "other" } }, { claims: { exp: 0 } }, { claims: { exp: "later" } },
    { header: { typ: "session-app+jwt" } }, { header: { alg: "none" } },
  ])("refuses wrong-type/identity/audience/expiration token case %#", async ({ claims, header }) => {
    const token = mintJwt(identity.config.did, identity.config.did, undefined, claims, header);
    const auth = new AgentInferenceAuth("https://kernel.invalid", () => identity, async () => Response.json({
      token, expiresIn: 600, scopes: ["infer:completions"],
    }));
    await expect(auth.credential("main")).rejects.toThrow("agents.main");
    try { await auth.credential("main"); } catch (error) { expect(String(error)).not.toContain(token); }
  });
  it.each([null, {}, { token: "bad" }, { expiresIn: -1 }, { scopes: [] }])("refuses malformed mint response %#", async (body) => {
    const auth = new AgentInferenceAuth("https://kernel.invalid", () => identity, async () => Response.json(body));
    await expect(auth.credential("main")).rejects.toThrow("invalid response");
  });
  it.each([
    { expiresIn: -1 }, { expiresIn: 0 }, { expiresIn: "600" }, { scopes: [] },
    { scopes: ["infer:completions", 1] }, { scopes: "infer:completions" },
  ])("rejects invalid TTL/scopes even with an otherwise valid token case %#", async (override) => {
    const auth = new AgentInferenceAuth("https://kernel.invalid", () => identity, async () => Response.json({
      token: mintJwt(identity.config.did, identity.config.did), expiresIn: 600,
      scopes: ["infer:completions"], ...override,
    }));
    await expect(auth.credential("main")).rejects.toThrow("invalid response");
  });
  it("refuses a mint response whose subject is actAs rather than the calling agent", async () => {
    const auth = new AgentInferenceAuth("https://kernel.invalid", () => identity, async () => Response.json({
      token: mintJwt(identity.config.did, identity.config.actAs!), expiresIn: 600, scopes: ["infer:completions"],
    }));
    await expect(auth.credential("main")).rejects.toThrow("agents.main");
  });
  it("hides provider exception values and causes", async () => {
    const protectedValue = randomUUID();
    identity.signer.signChallenge = async () => { throw new Error(protectedValue); };
    const auth = new AgentInferenceAuth("https://kernel.invalid", () => identity);
    try { await auth.credential("main"); } catch (error) {
      expect(String(error)).toContain("agents.main");
      expect(String(error)).not.toContain(protectedValue);
      expect((error as Error).cause).toBeUndefined();
    }
  });
});
