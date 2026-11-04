import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentInferenceAuth } from "./inference-auth.js";
import { AgentCatalogs } from "./agent-catalogs.js";
import { createAgentModelsFetcher } from "./inference-discovery.js";
import { familyBaseUrl, INFERENCE_FAMILIES } from "./inference-families.js";
import { ImajinCatalogCache, ImajinDiscoveryError, projectImajinCatalogRows, registerImajinProvider } from "./imajin-provider.js";
import { createImajinDefaultRouter } from "./imajin-default-routing.js";
import type { AgentIdentity } from "./agent-identities.js";

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveAgentDir: (_config: unknown, id: string) => `/agents/${id}/agent`,
}));
const logger = () => ({ info: vi.fn(), warn: vi.fn() });
function identity(id: string, actAs?: string): AgentIdentity {
  return { config: { did: `did:imajin:${id}`, actAs, keypair: { source: "store", provider: "sealed", id } },
    signer: { did: `did:imajin:${id}`, signChallenge: vi.fn() }, client: {} as AgentIdentity["client"] };
}
function fixture() {
  const identities = new Map([["main", identity("main")], ["artifact", identity("artifact", "did:imajin:org")]]);
  const auth = new AgentInferenceAuth("https://kernel.invalid", (id) => identities.get(id));
  vi.spyOn(auth, "credential").mockImplementation(async (id) => ({ token: `fixture-${id}`, expiresAt: Date.now() + 600_000 }));
  return { auth, identities };
}
const list = (connector: string, id: string, picked = true) =>
  ({ data: [{ id, owned_by: connector, imajin: { picked } }] });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("kernel-derived route families", () => {
  it.each(INFERENCE_FAMILIES.flatMap((entry) => entry.connectors.map((connector) => ({ connector, ...entry }))))(
    "$connector selects $api from one table", ({ connector, api, path }) => {
      expect(projectImajinCatalogRows(list(connector, "opaque-model"))[0].api).toBe(api);
      expect(familyBaseUrl("http://127.0.0.1:8787/openai/v1", api)).toBe(`http://127.0.0.1:8787${path}`);
    });
  it("skips and logs unknown connectors, never inferring Anthropic from a Claude model name", () => {
    const log = logger();
    expect(projectImajinCatalogRows(list("unknown", "claude-model"), log)).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("unknown inference connector"));
  });
  it("uses owned_by without imajin metadata and preserves the first known routing winner", () => {
    expect(projectImajinCatalogRows({ data: [
      { id: "same", owned_by: "anthropic" }, { id: "same", owned_by: "openai" },
    ] })).toMatchObject([{ id: "same", api: "anthropic-messages", connector: "anthropic" }]);
  });
});

describe("agent-scoped app+jwt discovery", () => {
  it.each(["main", "artifact"])("%s discovers with its own JWT and only its configured selector", async (agentId) => {
    const { auth } = fixture();
    const fetcher = vi.fn(async () => Response.json(list("anthropic", "sonnet")));
    await createAgentModelsFetcher(auth, agentId, "https://kernel.invalid/", "/infer/v1/models/usable", fetcher)();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://kernel.invalid/infer/v1/models/usable");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ Authorization: `Bearer fixture-${agentId}`,
      ...(agentId === "artifact" ? { "x-acting-as": "did:imajin:org" } : {}) });
  });
  it("missing identities fail before credentials or transport; main is never borrowed", async () => {
    const { auth, identities } = fixture();
    identities.delete("artifact");
    const fetcher = vi.fn();
    await expect(createAgentModelsFetcher(auth, "artifact", "https://kernel.invalid", "/models", fetcher)()).rejects.toThrow("agents.artifact");
    expect(auth.credential).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 403])("HTTP %s logs bounded kernel code/message, withholding tokens and unrelated fields", async (status) => {
    const { auth } = fixture();
    const invalidate = vi.spyOn(auth, "invalidate");
    const log = logger();
    const cache = new ImajinCatalogCache(createAgentModelsFetcher(auth, "artifact", "https://kernel.invalid", "/models",
      async () => Response.json({ error: "Not authorized to act as this group", code: "org_grant_required",
        message: "fixture-artifact Bearer hidden.token.value", privateKey: "withheld" }, { status })), 60_000, Date.now, log);
    const state = await cache.get();
    expect(state).toMatchObject({ outcome: "auth-error", httpStatus: status });
    expect(state.error).toContain("Not authorized to act as this group");
    expect(state.error).toContain("org_grant_required");
    const output = JSON.stringify(log.warn.mock.calls);
    for (const secret of ["fixture-artifact", "hidden.token.value", "withheld", "privateKey"]) expect(output).not.toContain(secret);
    expect(invalidate).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });
  it.each(["network", "non-json", "error-html", "error-json"])("handles %s without raw exception/body leakage", async (mode) => {
    const { auth } = fixture();
    const fetcher = async () => {
      if (mode === "network") throw new Error("private transport value");
      if (mode === "error-json") return Response.json({ error: "catalog_unavailable" }, { status: 500 });
      return new Response("private transport value", { status: mode === "error-html" ? 503 : 200 });
    };
    await expect(createAgentModelsFetcher(auth, "artifact", "https://kernel.invalid", "/models", fetcher)())
      .rejects.toThrow(ImajinDiscoveryError);
    try { await createAgentModelsFetcher(auth, "artifact", "https://kernel.invalid", "/models", fetcher)(); }
    catch (error) { expect(String(error)).not.toContain("private transport value"); }
  });
  it("missing nodeUrl never sends a credential and identity replacement rejects an in-flight response", async () => {
    const { auth, identities } = fixture();
    const fetcher = vi.fn();
    await expect(createAgentModelsFetcher(auth, "main", undefined, "/models", fetcher)()).rejects.toThrow("nodeUrl");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(createAgentModelsFetcher(auth, "artifact", "https://kernel.invalid", "/models", async () => {
      identities.set("artifact", identity("artifact", "did:imajin:other"));
      return Response.json(list("anthropic", "sonnet"));
    })()).rejects.toThrow("runtime changed");
  });
  it("separates caches and invalidation by agent, selector and signer generation", async () => {
    const { auth, identities } = fixture();
    const fetcher = vi.fn().mockResolvedValue(list("anthropic", "sonnet"));
    const catalogs = new AgentCatalogs(auth, "https://kernel.invalid", "/models",
      { fetcher, agentIds: ["main", "artifact"], gatewayAgent: "main", logger: logger() });
    const main = await catalogs.forAgent("main");
    const artifact = await catalogs.forAgent("artifact");
    expect(main).not.toBe(artifact);
    await Promise.all([main.get(), artifact.get()]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    catalogs.invalidate("artifact");
    await artifact.get();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await main.get()).toBe(main.peek());
    identities.get("artifact")!.config.actAs = "did:imajin:neworg";
    expect(await catalogs.forAgent("artifact")).not.toBe(artifact);
    identities.set("main", identity("main"));
    expect(await catalogs.forAgent("main")).not.toBe(main);
    identities.delete("artifact");
    await expect(catalogs.forAgent("artifact")).rejects.toThrow("agents.artifact");
    catalogs.clear();
    expect(catalogs.peekGateway().peek()).toBeNull();
    await expect(main.get()).rejects.toThrow("runtime changed");
  });
  it("CLI uses the explicit gateway signer; agentDir discovery never falls back to it", async () => {
    const { auth } = fixture();
    const log = logger();
    const catalogs = new AgentCatalogs(auth, "https://kernel.invalid", "/models",
      { gatewayAgent: "main", agentIds: ["main", "artifact"], logger: log });
    expect(await catalogs.signer()).toBe("main");
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("signer: agents.main"));
    expect(await catalogs.signer({ agentDir: "/agents/artifact/agent" })).toBe("artifact");
    await expect(catalogs.signer({ agentDir: "/agents/unknown/agent" })).rejects.toThrow("no unique configured signer");
    await expect(new AgentCatalogs(auth, undefined, "/models", {}).signer()).rejects.toThrow("gatewayAgent");
  });
  it("an auth-refused agent catalog cannot serve its last-good models", async () => {
    const { auth } = fixture();
    const fetcher = vi.fn().mockResolvedValueOnce(list("anthropic", "sonnet"))
      .mockRejectedValue(new ImajinDiscoveryError("auth-error", "denied", 403));
    const catalogs = new AgentCatalogs(auth, "https://kernel.invalid", "/models",
      { fetcher, gatewayAgent: "artifact", agentIds: ["artifact"], logger: logger() });
    expect(await catalogs.models()).toHaveLength(1);
    await (await catalogs.forAgent("artifact")).refresh();
    await expect(catalogs.models()).rejects.toThrow("denied");
  });
  it("mint refusal cannot be classified as a transport outage or reuse a last-good catalog", async () => {
    const { auth } = fixture();
    vi.mocked(auth.credential).mockRejectedValue(new Error("private mint detail"));
    const fetcher = vi.fn();
    const cache = new ImajinCatalogCache(createAgentModelsFetcher(auth, "main", "https://kernel.invalid", "/models", fetcher),
      60_000, Date.now, logger());
    expect(await cache.get()).toMatchObject({ outcome: "auth-error" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(cache.peek()?.error).not.toContain("private mint detail");
  });
  it("routes Anthropic rows only through canonical imajin without config edits", async () => {
    const registerProvider = vi.fn();
    registerImajinProvider({ registerProvider }, undefined, {
      fetcher: async () => list("anthropic", "sonnet"), logger: logger(),
    });
    const providers = registerProvider.mock.calls.map(([provider]) => provider);
    const catalog = await providers[0].catalog.run();
    expect(catalog.provider.models[0]).toMatchObject({ id: "sonnet", api: "anthropic-messages" });
    expect(providers[0].normalizeResolvedModel({ model: catalog.provider.models[0] }))
      .toMatchObject({ api: "anthropic-messages", baseUrl: "http://127.0.0.1:8787/anthropic" });
    expect(providers.map((entry) => entry.id)).toEqual(["imajin", "imajin-openai", "imajin-xai"]);
    expect(providers.map((entry) => entry.id)).not.toContain("imajin-anthropic");
    const canonical = providers.find((entry) => entry.id === "imajin");
    expect(await canonical.prepareDynamicModel({ modelId: "sonnet" }))
      .toMatchObject({ provider: "imajin", connector: "anthropic", api: "anthropic-messages", baseUrl: "http://127.0.0.1:8787/anthropic" });
    expect(await canonical.prepareDynamicModel({ modelId: "unknown" })).toBeUndefined();
    expect(() => canonical.wrapStreamFn({ agentId: "missing", streamFn: vi.fn() })).toThrow("agents.missing");
  });
});

describe("tenant default admission", () => {
  async function routing() {
    const log = logger();
    const main = new ImajinCatalogCache(async () => list("xai", "main-model"), 60_000, Date.now, log);
    const fetcher = vi.fn().mockResolvedValue(list("anthropic", "org-sonnet"));
    const artifact = new ImajinCatalogCache(fetcher, 60_000, Date.now, log);
    const config = { agents: { entries: {} as Record<string, { model?: string }>,
      defaults: { model: "anthropic/direct-default", modelPolicy: { allow: ["imajin/*"] } } } };
    const cacheForAgent = vi.fn(async (id: string) => {
      if (id === "artifact") return artifact;
      if (id === "main") return main;
      throw new Error("Agent identity unavailable");
    });
    const router = createImajinDefaultRouter({ cache: main, cacheForAgent, gatewayAgent: "main",
      baseUrl: "http://127.0.0.1:8787/openai/v1", getConfig: () => config, probe: async () => ({ ok: true }) });
    const ctx = { agentId: "artifact", runId: "org-run", modelProviderId: "anthropic", modelId: "direct-default" };
    return { router, ctx, config, artifact, fetcher, cacheForAgent };
  }
  it("artifact defaults to its own kernel Anthropic pick; main and explicit pins are unchanged", async () => {
    const { router, ctx, config, cacheForAgent } = await routing();
    const before = JSON.stringify(config);
    expect(await router.beforeModelResolve({}, ctx)).toEqual({ providerOverride: "imajin", modelOverride: "org-sonnet" });
    expect(router.beforeAgentRun({}, ctx)).toBeUndefined();
    expect(cacheForAgent).toHaveBeenCalledWith("artifact");
    expect(await router.beforeModelResolve({}, { ...ctx, agentId: "main" })).toBeUndefined();
    expect(await router.beforeModelResolve({}, { ...ctx, modelId: "explicit-pin" })).toBeUndefined();
    expect(JSON.stringify(config)).toBe(before);
    config.agents.entries.artifact = { model: "anthropic/direct-default" };
    expect(await router.beforeModelResolve({}, ctx)).toBeUndefined();
  });
  it("no route keeps the configured model; personal imajin/default uses its own cache", async () => {
    const { router, ctx, fetcher, artifact } = await routing();
    fetcher.mockResolvedValue({ data: [] });
    expect(await router.beforeModelResolve({}, ctx)).toBeUndefined();
    expect(router.beforeAgentRun({}, ctx)).toBeUndefined();
    expect(await router.beforeModelResolve({}, { ...ctx, agentId: "main", modelProviderId: "imajin", modelId: "default" }))
      .toEqual({ providerOverride: "imajin", modelOverride: "main-model" });
    fetcher.mockResolvedValue(list("anthropic", "new-pick")); await artifact.refresh();
    expect(await router.beforeModelResolve({}, ctx)).toMatchObject({ modelOverride: "new-pick" });
  });
  it("identity failure, discovery refusal and live policy denial block rather than using built-in Anthropic", async () => {
    const { router, ctx, fetcher, artifact, config } = await routing();
    const unknown = { ...ctx, agentId: "unknown", runId: "unknown-run" };
    await expect(router.beforeModelResolve({}, unknown)).rejects.toThrow("identity unavailable");
    expect(router.beforeAgentRun({}, unknown)).toMatchObject({ outcome: "block" });
    await router.beforeModelResolve({}, ctx);
    config.agents.defaults.modelPolicy.allow = ["imajin/different-model"];
    await router.beforeModelResolve({}, ctx);
    expect(router.beforeAgentRun({}, ctx)).toMatchObject({ outcome: "block" });
    config.agents.defaults.modelPolicy.allow = ["imajin/*"];
    fetcher.mockRejectedValue(new ImajinDiscoveryError("auth-error", "org grant revoked", 403));
    await artifact.refresh();
    expect(await router.beforeModelResolve({}, ctx)).toBeUndefined();
    expect(router.beforeAgentRun({}, ctx)).toMatchObject({ outcome: "block" });
  });
  it("a swallowed automatic-routing failure without runId still blocks the built-in provider", async () => {
    const { router, ctx } = await routing();
    const missing = { ...ctx, runId: undefined, agentId: "missing" };
    await expect(router.beforeModelResolve({}, missing)).rejects.toThrow("identity unavailable");
    expect(router.beforeAgentRun({}, missing)).toMatchObject({ outcome: "block" });
  });
});
