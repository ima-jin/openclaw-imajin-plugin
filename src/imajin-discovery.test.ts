import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_DISCOVERY_REFRESH_INTERVAL_MS,
  DEFAULT_KERNEL_MODELS_PATH,
  ImajinCatalogCache,
  ImajinDiscoveryError,
  MIN_DISCOVERY_REFRESH_INTERVAL_MS,
  buildImajinStatusSnapshot,
  classifyImajinTransportError,
  createImajinKernelModelsFetcher,
  isImajinModelsListResponse,
  projectImajinCatalogRows,
  registerImajinProvider,
  resolveDiscoveryRefreshIntervalMs,
  resolveImajinKernelModelsPath,
  resolveImajinKernelModelsUrl,
  startImajinModelDiscovery,
  type ImajinKernelRequester,
} from "./imajin-provider.js";

const KERNEL_LIST = {
  object: "list",
  data: [
    {
      id: "grok-4",
      object: "model",
      owned_by: "xai",
      created: 1,
      imajin: { connector: "xai", credentialDid: "did:imajin:x", servable: true },
    },
    {
      id: "gpt-6-astra",
      object: "model",
      owned_by: "openai",
      created: 1,
      imajin: { connector: "openai", credentialDid: "did:imajin:x", servable: true },
    },
    {
      id: "glm-5",
      object: "model",
      owned_by: "zai",
      created: 1,
      imajin: { connector: "zai", credentialDid: "did:imajin:x", servable: true },
    },
  ],
};

function quietLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function requester(
  impl: () => Promise<{ status: number; contentType?: string; text: string }>,
): ImajinKernelRequester & { requestRaw: ReturnType<typeof vi.fn> } {
  return {
    requestRaw: vi.fn(async () => {
      const res = await impl();
      return { contentType: "application/json", ...res };
    }),
  };
}

async function fetchOutcome(client: ImajinKernelRequester | undefined) {
  const fetcher = createImajinKernelModelsFetcher(client);
  try {
    await fetcher();
    return null;
  } catch (err) {
    return err as ImajinDiscoveryError;
  }
}

describe("projectImajinCatalogRows (mapper, #55)", () => {
  it("maps the OpenAI list shape to imajin/<id> catalog rows with connector names", () => {
    const models = projectImajinCatalogRows(KERNEL_LIST);
    expect(models.map((m) => m.id)).toEqual(["grok-4", "gpt-6-astra", "glm-5"]);
    expect(models.map((m) => m.name)).toEqual([
      "grok-4 (via xai)",
      "gpt-6-astra (via openai)",
      "glm-5 (via zai)",
    ]);
    for (const model of models) {
      expect(model.input).toEqual(["text"]);
      expect(model.contextWindow).toBeGreaterThan(0);
    }
  });

  it("drops rows the kernel marks servable: false", () => {
    const models = projectImajinCatalogRows({
      object: "list",
      data: [
        { id: "ok", imajin: { connector: "xai", servable: true } },
        { id: "nope", imajin: { connector: "xai", servable: false } },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["ok"]);
  });

  it("returns [] for an empty list and for non-object bodies", () => {
    expect(projectImajinCatalogRows({ object: "list", data: [] })).toEqual([]);
    expect(projectImajinCatalogRows(null)).toEqual([]);
    expect(projectImajinCatalogRows(undefined)).toEqual([]);
    expect(projectImajinCatalogRows({ data: "nope" } as never)).toEqual([]);
  });

  it("ignores rows with non-string ids", () => {
    const models = projectImajinCatalogRows({
      data: [{ id: 42 }, null, { id: "fine" }] as never,
    });
    expect(models.map((m) => m.id)).toEqual(["fine"]);
  });
});

describe("isImajinModelsListResponse", () => {
  it("accepts an object with a data array (even empty)", () => {
    expect(isImajinModelsListResponse({ data: [] })).toBe(true);
    expect(isImajinModelsListResponse(KERNEL_LIST)).toBe(true);
  });

  it("rejects everything else", () => {
    for (const body of [null, undefined, "x", 3, [], {}, { data: {} }, { data: "x" }]) {
      expect(isImajinModelsListResponse(body)).toBe(false);
    }
  });
});

describe("createImajinKernelModelsFetcher failure modes", () => {
  it("returns the parsed body on 200 and requests the kernel usable-models route", async () => {
    const client = requester(async () => ({ status: 200, text: JSON.stringify(KERNEL_LIST) }));
    const body = await createImajinKernelModelsFetcher(client)();
    expect(body).toEqual(KERNEL_LIST);
    expect(client.requestRaw).toHaveBeenCalledWith(DEFAULT_KERNEL_MODELS_PATH);
  });

  it("honours a configured modelsPath", async () => {
    const client = requester(async () => ({ status: 200, text: JSON.stringify(KERNEL_LIST) }));
    await createImajinKernelModelsFetcher(client, { modelsPath: "/custom/models" })();
    expect(client.requestRaw).toHaveBeenCalledWith("/custom/models");
  });

  it("kernel unreachable (connection refused) -> kind 'unreachable', no http status", async () => {
    const client = requester(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await fetchOutcome(client);
    expect(err).toBeInstanceOf(ImajinDiscoveryError);
    expect(err?.kind).toBe("unreachable");
    expect(err?.httpStatus).toBeUndefined();
  });

  it("kernel not answering within the timeout -> 'unreachable'", async () => {
    vi.useFakeTimers();
    try {
      const client: ImajinKernelRequester = {
        requestRaw: () => new Promise(() => {}),
      };
      const pending = createImajinKernelModelsFetcher(client, { timeoutMs: 50 })().catch(
        (e: unknown) => e as ImajinDiscoveryError,
      );
      await vi.advanceTimersByTimeAsync(60);
      const err = await pending;
      expect(err).toBeInstanceOf(ImajinDiscoveryError);
      expect((err as ImajinDiscoveryError).kind).toBe("unreachable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("502/503/504 from a front proxy -> 'unreachable' (with the status)", async () => {
    for (const status of [502, 503, 504]) {
      const err = await fetchOutcome(requester(async () => ({ status, text: "bad gateway" })));
      expect(err?.kind).toBe("unreachable");
      expect(err?.httpStatus).toBe(status);
    }
  });

  it("404 (route missing) -> 'route-error' carrying the status, distinct from unreachable", async () => {
    const err = await fetchOutcome(
      requester(async () => ({ status: 404, text: '{"error":"not_found"}' })),
    );
    expect(err?.kind).toBe("route-error");
    expect(err?.httpStatus).toBe(404);
    expect(err?.message).toContain("404");
  });

  it("500 (route error) -> 'route-error' carrying the status and a bounded body snippet", async () => {
    const err = await fetchOutcome(
      requester(async () => ({ status: 500, text: "x".repeat(5_000) })),
    );
    expect(err?.kind).toBe("route-error");
    expect(err?.httpStatus).toBe(500);
    expect(err!.message.length).toBeLessThan(400);
  });

  it("401/403 -> 'auth-error' with the status", async () => {
    for (const status of [401, 403]) {
      const err = await fetchOutcome(requester(async () => ({ status, text: "{}" })));
      expect(err?.kind).toBe("auth-error");
      expect(err?.httpStatus).toBe(status);
    }
  });

  it("2xx with a non-JSON body -> 'malformed'", async () => {
    const err = await fetchOutcome(requester(async () => ({ status: 200, text: "<html>oops" })));
    expect(err?.kind).toBe("malformed");
  });

  it("no client (no nodeUrl/keypair) -> 'unconfigured', never throws synchronously", async () => {
    const err = await fetchOutcome(undefined);
    expect(err?.kind).toBe("unconfigured");
  });

  it("session/login failures thrown by the client are 'auth-error', transport failures 'unreachable'", () => {
    expect(classifyImajinTransportError(new Error("Auth challenge failed (500): boom")).kind).toBe(
      "auth-error",
    );
    expect(classifyImajinTransportError(new Error("Auth verify failed (401): no")).kind).toBe(
      "auth-error",
    );
    expect(
      classifyImajinTransportError(new Error("No keypairPath configured — cannot authenticate"))
        .kind,
    ).toBe("auth-error");
    expect(
      classifyImajinTransportError(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }))
        .kind,
    ).toBe("auth-error");
    expect(classifyImajinTransportError(new TypeError("fetch failed")).kind).toBe("unreachable");
    expect(classifyImajinTransportError("string failure").kind).toBe("unreachable");
  });
});

describe("ImajinCatalogCache discovery outcomes", () => {
  async function cacheFor(steps: Array<unknown | Error>) {
    const fetcher = vi.fn();
    for (const step of steps) {
      if (step instanceof Error) fetcher.mockRejectedValueOnce(step);
      else fetcher.mockResolvedValueOnce(step);
    }
    const logger = quietLogger();
    const cache = new ImajinCatalogCache(fetcher, 60_000, Date.now, logger);
    return { cache, fetcher, logger };
  }

  it("ok: populates the catalog and reports modelCount > 0", async () => {
    const { cache } = await cacheFor([KERNEL_LIST]);
    const state = await cache.refresh();
    expect(state.outcome).toBe("ok");
    expect(state.models).toHaveLength(3);
    expect(state.error).toBeUndefined();
    expect(state.lastGoodAtMs).not.toBeNull();
  });

  it("empty list: authoritative — outcome 'empty' and the catalog becomes empty", async () => {
    const { cache } = await cacheFor([KERNEL_LIST, { object: "list", data: [] }]);
    await cache.refresh();
    const state = await cache.refresh();
    expect(state.outcome).toBe("empty");
    expect(state.models).toEqual([]);
  });

  it("malformed body: outcome 'malformed', last good catalog kept", async () => {
    const { cache } = await cacheFor([KERNEL_LIST, { object: "list" }]);
    await cache.refresh();
    const state = await cache.refresh();
    expect(state.outcome).toBe("malformed");
    expect(state.models).toHaveLength(3);
    expect(state.error).toMatch(/OpenAI list/);
  });

  it("route-error then unreachable are recorded distinctly; last good survives both", async () => {
    const { cache } = await cacheFor([
      KERNEL_LIST,
      new ImajinDiscoveryError("route-error", "GET x returned 500", 500),
      new ImajinDiscoveryError("unreachable", "fetch failed"),
    ]);
    await cache.refresh();
    const routeError = await cache.refresh();
    expect(routeError.outcome).toBe("route-error");
    expect(routeError.httpStatus).toBe(500);
    expect(routeError.models).toHaveLength(3);
    const unreachable = await cache.refresh();
    expect(unreachable.outcome).toBe("unreachable");
    expect(unreachable.httpStatus).toBeUndefined();
    expect(unreachable.models).toHaveLength(3);
  });

  it("a failure before any success yields an empty catalog and lastGoodAtMs null", async () => {
    const { cache } = await cacheFor([new ImajinDiscoveryError("route-error", "404", 404)]);
    const state = await cache.refresh();
    expect(state.models).toEqual([]);
    expect(state.lastGoodAtMs).toBeNull();
  });

  it("a plain (non-discovery) thrown error is recorded as 'unreachable', never rethrown", async () => {
    const { cache } = await cacheFor([new Error("boom")]);
    await expect(cache.refresh()).resolves.toMatchObject({ outcome: "unreachable", error: "boom" });
  });

  it("logs a failure once, not on every retry, and logs recovery", async () => {
    const { cache, logger } = await cacheFor([
      new ImajinDiscoveryError("route-error", "GET x returned 404", 404),
      new ImajinDiscoveryError("route-error", "GET x returned 404", 404),
      new ImajinDiscoveryError("route-error", "GET x returned 404", 404),
      KERNEL_LIST,
    ]);
    await cache.refresh();
    await cache.refresh();
    await cache.refresh();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("route-error 404");
    expect(logger.warn.mock.calls[0][0]).toContain("keeping last good catalog");

    await cache.refresh();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("recovered"));
  });

  it("logs again when the failure kind changes", async () => {
    const { cache, logger } = await cacheFor([
      new ImajinDiscoveryError("route-error", "404", 404),
      new ImajinDiscoveryError("unreachable", "down"),
    ]);
    await cache.refresh();
    await cache.refresh();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("invalidate() keeps the last good catalog visible and forces the next get() to refetch", async () => {
    const { cache, fetcher } = await cacheFor([
      KERNEL_LIST,
      { object: "list", data: [KERNEL_LIST.data[0]] },
    ]);
    await cache.get();
    cache.invalidate();
    expect(cache.peek()?.models).toHaveLength(3);
    const state = await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(state.models).toHaveLength(1);
  });

  it("refresh() calls in flight share one fetch", async () => {
    let resolve: (v: unknown) => void = () => {};
    const fetcher = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    const cache = new ImajinCatalogCache(fetcher, 60_000, Date.now, quietLogger());
    const a = cache.refresh();
    const b = cache.refresh();
    resolve(KERNEL_LIST);
    expect(await a).toBe(await b);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not hammer the kernel while failing: get() within the TTL reuses the failed state", async () => {
    const fetcher = vi.fn().mockRejectedValue(new ImajinDiscoveryError("unreachable", "down"));
    const cache = new ImajinCatalogCache(fetcher, 60_000, Date.now, quietLogger());
    await cache.get();
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("startImajinModelDiscovery (#55 — the reason discovery never ran)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs discovery immediately at start, before any catalog.run call", () => {
    const cache = { refresh: vi.fn().mockResolvedValue({}) };
    const handle = startImajinModelDiscovery(cache, 0);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("re-runs on the interval and stops cleanly", async () => {
    vi.useFakeTimers();
    const cache = { refresh: vi.fn().mockResolvedValue({}) };
    const handle = startImajinModelDiscovery(cache, 10_000);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cache.refresh).toHaveBeenCalledTimes(4);
    handle.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cache.refresh).toHaveBeenCalledTimes(4);
  });

  it("interval 0 disables the periodic refresh (start-up discovery only)", async () => {
    vi.useFakeTimers();
    const cache = { refresh: vi.fn().mockResolvedValue({}) };
    startImajinModelDiscovery(cache, 0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  it("an unreachable kernel at start never throws and leaves a recorded failure", async () => {
    const client = requester(async () => {
      throw new TypeError("fetch failed");
    });
    const registerProvider = vi.fn();
    const provider = registerImajinProvider({ registerProvider }, undefined, {
      client,
      nodeUrl: "https://kernel.example",
      logger: quietLogger(),
    });
    expect(() => provider.startDiscovery().stop()).not.toThrow();
    const state = await provider.cache.refresh();
    expect(state.outcome).toBe("unreachable");
  });
});

describe("config resolution", () => {
  it("defaults the refresh interval to 5 minutes", () => {
    expect(resolveDiscoveryRefreshIntervalMs(undefined)).toBe(DEFAULT_DISCOVERY_REFRESH_INTERVAL_MS);
    expect(DEFAULT_DISCOVERY_REFRESH_INTERVAL_MS).toBe(300_000);
    expect(resolveDiscoveryRefreshIntervalMs({ refreshIntervalMs: Number.NaN })).toBe(
      DEFAULT_DISCOVERY_REFRESH_INTERVAL_MS,
    );
  });

  it("accepts a configured interval, floors tiny values, and treats <= 0 as disabled", () => {
    expect(resolveDiscoveryRefreshIntervalMs({ refreshIntervalMs: 60_000 })).toBe(60_000);
    expect(resolveDiscoveryRefreshIntervalMs({ refreshIntervalMs: 5 })).toBe(
      MIN_DISCOVERY_REFRESH_INTERVAL_MS,
    );
    expect(resolveDiscoveryRefreshIntervalMs({ refreshIntervalMs: 0 })).toBe(0);
    expect(resolveDiscoveryRefreshIntervalMs({ refreshIntervalMs: -1 })).toBe(0);
  });

  it("defaults to the kernel usable-models route and normalizes a configured path", () => {
    expect(resolveImajinKernelModelsPath(undefined)).toBe("/infer/v1/models/usable");
    expect(resolveImajinKernelModelsPath({ modelsPath: "  " })).toBe("/infer/v1/models/usable");
    expect(resolveImajinKernelModelsPath({ modelsPath: "custom/models" })).toBe("/custom/models");
    expect(resolveImajinKernelModelsPath({ modelsPath: "/custom/models" })).toBe("/custom/models");
  });

  it("builds the kernel discovery URL from nodeUrl", () => {
    expect(resolveImajinKernelModelsUrl("https://jin.imajin.ai/", "/infer/v1/models/usable")).toBe(
      "https://jin.imajin.ai/infer/v1/models/usable",
    );
  });
});

describe("registerImajinProvider + discovery end to end", () => {
  it("discovers through the kernel client and serves imajin models with the passthrough baseUrl", async () => {
    const client = requester(async () => ({ status: 200, text: JSON.stringify(KERNEL_LIST) }));
    const registerProvider = vi.fn();
    const provider = registerImajinProvider(
      { registerProvider },
      { inferProxyBaseUrl: "http://127.0.0.1:8787/openai/v1" },
      { client, nodeUrl: "https://jin.imajin.ai", logger: quietLogger() },
    );

    await provider.cache.refresh();

    const definition = registerProvider.mock.calls[0][0] as {
      catalog: { run: () => Promise<{ provider: { baseUrl: string; models: Array<{ id: string }> } }> };
    };
    const { provider: config } = await definition.catalog.run();
    expect(config.baseUrl).toBe("http://127.0.0.1:8787/openai/v1");
    expect(config.models.map((m) => m.id)).toEqual(["grok-4", "gpt-6-astra", "glm-5"]);
    expect(provider.discovery).toEqual({
      modelsUrl: "https://jin.imajin.ai/infer/v1/models/usable",
      refreshIntervalMs: 300_000,
    });
  });

  it("a model added kernel-side appears on the next refresh with no config edit", async () => {
    let body: unknown = { object: "list", data: [KERNEL_LIST.data[0]] };
    const client = requester(async () => ({ status: 200, text: JSON.stringify(body) }));
    const provider = registerImajinProvider({ registerProvider: vi.fn() }, undefined, {
      client,
      logger: quietLogger(),
    });
    expect((await provider.cache.refresh()).models.map((m) => m.id)).toEqual(["grok-4"]);

    body = KERNEL_LIST;
    expect((await provider.cache.refresh()).models.map((m) => m.id)).toEqual([
      "grok-4",
      "gpt-6-astra",
      "glm-5",
    ]);
  });

  it("without a client, discovery reports 'unconfigured' and plugin registration still succeeds", async () => {
    const provider = registerImajinProvider({ registerProvider: vi.fn() }, undefined, {
      logger: quietLogger(),
    });
    const state = await provider.cache.refresh();
    expect(state.outcome).toBe("unconfigured");
    expect(state.models).toEqual([]);
  });
});

describe("buildImajinStatusSnapshot failure reporting", () => {
  const discovery = {
    modelsUrl: "https://jin.imajin.ai/infer/v1/models/usable",
    refreshIntervalMs: 300_000,
  };
  const healthz = { ok: true, status: 200 };
  const models = projectImajinCatalogRows(KERNEL_LIST);

  it("route-error reports the status and keeps the last good catalog visible", () => {
    const snapshot = buildImajinStatusSnapshot({
      baseUrl: "http://127.0.0.1:8787/openai/v1",
      cacheState: {
        models,
        fetchedAtMs: 2_000,
        outcome: "route-error",
        error: "GET /infer/v1/models/usable returned 500",
        httpStatus: 500,
        lastGoodAtMs: 1_000,
      },
      healthz,
      discovery,
    });
    expect(snapshot.lastDiscovery).toEqual({
      fetchedAt: new Date(2_000).toISOString(),
      outcome: "route-error",
      error: "GET /infer/v1/models/usable returned 500",
      httpStatus: 500,
      lastGoodAt: new Date(1_000).toISOString(),
      modelCount: 3,
    });
    expect(snapshot.catalog.map((c) => c.ref)).toEqual([
      "imajin/grok-4",
      "imajin/gpt-6-astra",
      "imajin/glm-5",
    ]);
    expect(snapshot.discovery).toEqual(discovery);
  });

  it("unreachable has no httpStatus, so it is distinguishable from route-error", () => {
    const snapshot = buildImajinStatusSnapshot({
      baseUrl: "x",
      cacheState: {
        models: [],
        fetchedAtMs: 5,
        outcome: "unreachable",
        error: "fetch failed",
        lastGoodAtMs: null,
      },
      healthz,
    });
    expect(snapshot.lastDiscovery.outcome).toBe("unreachable");
    expect(snapshot.lastDiscovery).not.toHaveProperty("httpStatus");
    expect(snapshot.lastDiscovery.lastGoodAt).toBeNull();
    expect(snapshot).not.toHaveProperty("discovery");
  });

  it("ok reports modelCount > 0 and no error", () => {
    const snapshot = buildImajinStatusSnapshot({
      baseUrl: "x",
      cacheState: { models, fetchedAtMs: 10, outcome: "ok", lastGoodAtMs: 10 },
      healthz,
    });
    expect(snapshot.lastDiscovery.outcome).toBe("ok");
    expect(snapshot.lastDiscovery.modelCount).toBeGreaterThan(0);
    expect(snapshot.lastDiscovery).not.toHaveProperty("error");
  });
});
