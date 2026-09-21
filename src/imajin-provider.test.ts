import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  IMAJIN_CATALOG_INVALIDATION_SCOPES,
  IMAJIN_PROVIDER_ID,
  IMAJIN_SYNTHETIC_API_KEY,
  ImajinCatalogCache,
  buildImajinProviderConfig,
  buildImajinStatusSnapshot,
  isImajinCatalogInvalidationScope,
  projectImajinCatalogRows,
  registerImajinProvider,
  resolveImajinHealthzUrl,
  resolveImajinInferProxyBaseUrl,
  resolveImajinModelsUrl,
  type ImajinModelsListResponse,
} from "./imajin-provider.js";

// The recorded kernel `/models` fixture from ima-jin/imajin-ai#2201: two
// usable (connector, model) rows.
const TWO_ROW_KERNEL_RESPONSE: ImajinModelsListResponse = {
  object: "list",
  data: [
    {
      id: "grok-4",
      object: "model",
      owned_by: "xai",
      created: 1_700_000_000,
      imajin: { connector: "xai", credentialDid: "did:imajin:example-user", servable: true },
    },
    {
      id: "gpt-6-astra",
      object: "model",
      owned_by: "openai",
      created: 1_700_000_100,
      imajin: { connector: "openai", credentialDid: "did:imajin:example-user", servable: true },
    },
  ],
};

describe("projectImajinCatalogRows", () => {
  it("projects the 2-row fixture (xai/grok-4, openai/gpt-6-astra) as text models named '<id> (via <connector>)'", () => {
    const models = projectImajinCatalogRows(TWO_ROW_KERNEL_RESPONSE);

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "grok-4",
      name: "grok-4 (via xai)",
      connector: "xai",
      reasoning: false,
      input: ["text"],
    });
    expect(models[1]).toMatchObject({
      id: "gpt-6-astra",
      name: "gpt-6-astra (via openai)",
      connector: "openai",
    });
  });

  it("projects a row with no imajin.connector metadata using the bare id as the display name", () => {
    const models = projectImajinCatalogRows({ object: "list", data: [{ id: "bare-model" }] });
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("bare-model");
    expect(models[0].name).toBe("bare-model");
    expect(models[0].connector).toBeUndefined();
  });

  it("drops rows with a missing/blank id and de-duplicates by id (keeps the first occurrence)", () => {
    const models = projectImajinCatalogRows({
      object: "list",
      data: [
        { id: "dup", imajin: { connector: "first" } },
        { id: "  " },
        { id: "dup", imajin: { connector: "second" } },
        {} as { id: string },
      ],
    });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: "dup", connector: "first" });
  });

  it("returns an empty catalog for a malformed/missing body instead of throwing", () => {
    expect(projectImajinCatalogRows(null)).toEqual([]);
    expect(projectImajinCatalogRows(undefined)).toEqual([]);
    expect(projectImajinCatalogRows({})).toEqual([]);
    expect(projectImajinCatalogRows({ data: "not-an-array" } as unknown as ImajinModelsListResponse)).toEqual([]);
  });
});

describe("resolveImajinInferProxyBaseUrl", () => {
  it("defaults to the documented loopback proxy URL when unconfigured", () => {
    expect(resolveImajinInferProxyBaseUrl(undefined)).toBe("http://127.0.0.1:8787/openai/v1");
    expect(resolveImajinInferProxyBaseUrl({})).toBe("http://127.0.0.1:8787/openai/v1");
    expect(resolveImajinInferProxyBaseUrl({ inferProxyBaseUrl: "  " })).toBe(
      "http://127.0.0.1:8787/openai/v1",
    );
  });

  it("uses the configured base URL, trimmed and without a trailing slash", () => {
    expect(resolveImajinInferProxyBaseUrl({ inferProxyBaseUrl: "http://10.0.0.5:9000/openai/v1/" })).toBe(
      "http://10.0.0.5:9000/openai/v1",
    );
  });
});

describe("resolveImajinModelsUrl / resolveImajinHealthzUrl", () => {
  it("builds the models endpoint relative to baseUrl", () => {
    expect(resolveImajinModelsUrl("http://127.0.0.1:8787/openai/v1")).toBe(
      "http://127.0.0.1:8787/openai/v1/models",
    );
  });

  it("builds healthz at the proxy root, not under /openai/v1", () => {
    expect(resolveImajinHealthzUrl("http://127.0.0.1:8787/openai/v1")).toBe(
      "http://127.0.0.1:8787/healthz",
    );
  });
});

describe("buildImajinProviderConfig", () => {
  it("builds an openai-completions provider config with the synthetic (non-secret) api key", () => {
    const models = projectImajinCatalogRows(TWO_ROW_KERNEL_RESPONSE);
    const provider = buildImajinProviderConfig({ baseUrl: "http://127.0.0.1:8787/openai/v1", models });
    expect(provider).toMatchObject({
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8787/openai/v1",
      apiKey: IMAJIN_SYNTHETIC_API_KEY,
    });
    expect(provider.models).toHaveLength(2);
  });
});

describe("ImajinCatalogCache", () => {
  it("caches a successful fetch and does not refetch within the TTL", async () => {
    const fetcher = vi.fn().mockResolvedValue(TWO_ROW_KERNEL_RESPONSE);
    const cache = new ImajinCatalogCache(fetcher, 60_000);

    const first = await cache.get();
    const second = await cache.get();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.models).toHaveLength(2);
    expect(second).toBe(first);
  });

  it("refetches after invalidate() is called, even within the TTL (WS-driven refresh)", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(TWO_ROW_KERNEL_RESPONSE)
      .mockResolvedValueOnce({ object: "list", data: [{ id: "grok-4", imajin: { connector: "xai" } }] });
    const cache = new ImajinCatalogCache(fetcher, 60_000);

    const first = await cache.get();
    expect(first.models).toHaveLength(2);

    cache.invalidate();
    const second = await cache.get();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(second.models).toHaveLength(1);
  });

  it("a proxy outage degrades to an EMPTY catalog, never a stale previously-successful one", async () => {
    let now = 0;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(TWO_ROW_KERNEL_RESPONSE)
      .mockRejectedValueOnce(new Error("kernel proxy unreachable"));
    const cache = new ImajinCatalogCache(fetcher, 1_000, () => now);

    const first = await cache.get();
    expect(first.models).toHaveLength(2);
    expect(first.outcome).toBe("live");

    // Past the TTL — forces a refetch, which fails.
    now = 2_000;
    const second = await cache.get();

    expect(second.outcome).toBe("error");
    expect(second.models).toEqual([]);
    expect(second.error).toContain("kernel proxy unreachable");
  });

  it("peek() returns the last resolved state without forcing a fetch", async () => {
    const fetcher = vi.fn().mockResolvedValue(TWO_ROW_KERNEL_RESPONSE);
    const cache = new ImajinCatalogCache(fetcher, 60_000);

    expect(cache.peek()).toBeNull();
    await cache.get();
    expect(cache.peek()?.models).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("concurrent get() calls in flight share one fetch", async () => {
    let resolveFetch: (value: ImajinModelsListResponse) => void = () => {};
    const fetcher = vi.fn().mockReturnValue(
      new Promise<ImajinModelsListResponse>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const cache = new ImajinCatalogCache(fetcher, 60_000);

    const p1 = cache.get();
    const p2 = cache.get();
    resolveFetch(TWO_ROW_KERNEL_RESPONSE);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });
});

describe("isImajinCatalogInvalidationScope", () => {
  it("matches exactly the three kernel scopes confirmed by ima-jin/imajin-ai#2219", () => {
    expect(isImajinCatalogInvalidationScope("connector.credential.sealed")).toBe(true);
    expect(isImajinCatalogInvalidationScope("connector.credential.unsealed")).toBe(true);
    expect(isImajinCatalogInvalidationScope("connector.models.changed")).toBe(true);
  });

  it("exposes exactly those three scopes and no others", () => {
    expect(IMAJIN_CATALOG_INVALIDATION_SCOPES).toEqual([
      "connector.credential.sealed",
      "connector.credential.unsealed",
      "connector.models.changed",
    ]);
  });

  it("does not match an unrelated notification scope", () => {
    expect(isImajinCatalogInvalidationScope("warp.run.completed")).toBe(false);
    expect(isImajinCatalogInvalidationScope("")).toBe(false);
  });

  it("no longer matches the retired pre-#2219 speculative scope names", () => {
    expect(isImajinCatalogInvalidationScope("imajin.connector.sealed")).toBe(false);
    expect(isImajinCatalogInvalidationScope("imajin.connector.unsealed")).toBe(false);
    expect(isImajinCatalogInvalidationScope("imajin.connector.model_changed")).toBe(false);
    expect(isImajinCatalogInvalidationScope("imajin.connector.model-changed")).toBe(false);
    expect(isImajinCatalogInvalidationScope("connector.sealed")).toBe(false);
    expect(isImajinCatalogInvalidationScope("connector.unsealed")).toBe(false);
    expect(isImajinCatalogInvalidationScope("connector.model_changed")).toBe(false);
  });
});

describe("registerImajinProvider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("registers a provider with the expected id/label/auth/catalog shape", () => {
    const registerProvider = vi.fn();
    const api = { registerProvider };

    const registered = registerImajinProvider(api, undefined);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    const definition = registerProvider.mock.calls[0][0] as Record<string, unknown>;
    expect(definition.id).toBe(IMAJIN_PROVIDER_ID);
    expect(definition.label).toBe("Imajin (kernel seat)");
    // No user-entered credential: `auth` is an empty array (never prompts).
    expect(definition.auth).toEqual([]);
    expect(typeof definition.resolveSyntheticAuth).toBe("function");
    expect(typeof (definition.catalog as { run: unknown }).run).toBe("function");
    expect(typeof (definition.staticCatalog as { run: unknown }).run).toBe("function");
    expect(registered.baseUrl).toBe("http://127.0.0.1:8787/openai/v1");
  });

  it("resolveSyntheticAuth returns the non-secret placeholder marker, never a real credential", () => {
    const registerProvider = vi.fn();
    registerImajinProvider({ registerProvider }, undefined);
    const definition = registerProvider.mock.calls[0][0] as {
      resolveSyntheticAuth: () => { apiKey: string; mode: string };
    };
    const auth = definition.resolveSyntheticAuth();
    expect(auth.apiKey).toBe(IMAJIN_SYNTHETIC_API_KEY);
    expect(auth.mode).toBe("api-key");
  });

  it("static catalog seed is empty (never a stale/wrong fallback list)", async () => {
    const registerProvider = vi.fn();
    registerImajinProvider({ registerProvider }, undefined);
    const definition = registerProvider.mock.calls[0][0] as {
      staticCatalog: { run: () => Promise<{ provider: { models: unknown[] } }> };
    };
    const result = await definition.staticCatalog.run();
    expect(result.provider.models).toEqual([]);
  });

  it("catalog.run resolves models from the live cache", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => TWO_ROW_KERNEL_RESPONSE,
    });
    const registerProvider = vi.fn();
    registerImajinProvider({ registerProvider }, undefined);
    const definition = registerProvider.mock.calls[0][0] as {
      catalog: { run: () => Promise<{ provider: { models: unknown[] } }> };
    };

    const result = await definition.catalog.run();
    expect(result.provider.models).toHaveLength(2);
  });
});

describe("buildImajinStatusSnapshot", () => {
  it("reports catalog, last discovery, and healthz from the given state", () => {
    const cacheState = {
      models: projectImajinCatalogRows(TWO_ROW_KERNEL_RESPONSE),
      fetchedAtMs: 1_700_000_000_000,
      outcome: "live" as const,
    };
    const snapshot = buildImajinStatusSnapshot({
      baseUrl: "http://127.0.0.1:8787/openai/v1",
      cacheState,
      healthz: { ok: true, status: 200, body: { status: "ok" } },
    });

    expect(snapshot.catalog).toEqual([
      { id: "grok-4", name: "grok-4 (via xai)", connector: "xai" },
      { id: "gpt-6-astra", name: "gpt-6-astra (via openai)", connector: "openai" },
    ]);
    expect(snapshot.lastDiscovery).toMatchObject({ outcome: "live", modelCount: 2 });
    expect(snapshot.healthz).toEqual({ ok: true, status: 200, body: { status: "ok" } });
  });

  it("reports outcome 'never' and an empty catalog before any discovery has run", () => {
    const snapshot = buildImajinStatusSnapshot({
      baseUrl: "http://127.0.0.1:8787/openai/v1",
      cacheState: null,
      healthz: { ok: false, error: "connect refused" },
    });

    expect(snapshot.catalog).toEqual([]);
    expect(snapshot.lastDiscovery).toMatchObject({ outcome: "never", fetchedAt: null, modelCount: 0 });
    expect(snapshot.healthz.ok).toBe(false);
  });
});
