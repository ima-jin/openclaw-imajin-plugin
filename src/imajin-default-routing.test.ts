import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ImajinCatalogCache, ImajinDiscoveryError, buildImajinProviderConfig, isDirectModelRef,
} from "./imajin-provider.js";
import { createImajinDefaultRouter } from "./imajin-default-routing.js";
import { createImajinStatusTool } from "./tools.js";

const following = { modelProviderId: "imajin", modelId: "default" };
const list = (pick = "a") => ({
  data: ["a", "b"].map((id) => ({ id, imajin: { connector: "test", picked: id === pick, servable: true } })),
});

async function fixture() {
  const fetcher = vi.fn().mockResolvedValue(list());
  const cache = new ImajinCatalogCache(fetcher, 60_000, Date.now, { info: vi.fn(), warn: vi.fn() });
  await cache.refresh();
  const config = {
    agents: { defaults: { modelPolicy: { allow: ["imajin/*", "direct/*"] } } },
    plugins: { entries: { imajin: { config: { modelDiscovery: { breakGlassModel: "direct/emergency" } } } } },
  };
  const probe = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const router = createImajinDefaultRouter({ cache, baseUrl: "http://proxy.test/openai/v1", probe,
    getConfig: () => config, now: () => 1234 });
  return { fetcher, cache, config, probe, router };
}

afterEach(() => vi.unstubAllGlobals());

describe("kernel-picked default (#106)", () => {
  it("follows the next successful refresh without writing gateway config or pinning a session", async () => {
    const { router, config, fetcher, cache } = await fixture();
    const before = JSON.stringify(config);
    expect(await router.beforeModelResolve({}, following)).toEqual({ providerOverride: "imajin", modelOverride: "a" });
    fetcher.mockResolvedValue(list("b"));
    await cache.refresh();
    expect(await router.beforeModelResolve({}, following)).toEqual({ providerOverride: "imajin", modelOverride: "b" });
    expect(JSON.stringify(config)).toBe(before);
    expect(router.status()).toMatchObject({ pickedModel: "imajin/b", fallbackCount: 0, lastReason: null });
  });

  it("blocks denied/missing picks even when the host swallows a model-hook failure", async () => {
    const { router, config, probe, fetcher, cache } = await fixture();
    const ctx = { ...following, runId: "blocked-run" };
    config.agents.defaults.modelPolicy.allow = ["imajin/default"];
    await router.beforeModelResolve({}, ctx);
    expect(router.beforeAgentRun({}, ctx)).toMatchObject({ outcome: "block" });
    config.agents.defaults.modelPolicy.allow = ["imajin/*", "direct/*"];
    probe.mockRejectedValueOnce(new Error("probe failure"));
    await expect(router.beforeModelResolve({}, ctx)).rejects.toThrow("probe failure");
    expect(router.beforeAgentRun({}, ctx)).toMatchObject({ outcome: "block" });
    await router.beforeModelResolve({}, ctx);
    expect(router.beforeAgentRun({}, ctx)).toBeUndefined();
    router.onAgentEnd({}, ctx);
    expect(router.beforeAgentRun({}, ctx)).toMatchObject({ outcome: "block" });
    fetcher.mockResolvedValue({ data: [] });
    await cache.refresh();
    await router.beforeModelResolve({}, ctx);
    expect(router.beforeAgentRun({}, ctx)).toMatchObject({ outcome: "block" });
    router.preserveExplicitOverride(ctx);
    expect(router.beforeAgentRun({}, ctx)).toBeUndefined();
    expect(router.beforeAgentRun({}, { modelProviderId: "imajin", modelId: "a" })).toBeUndefined();
  });

  it("uses the refreshed pick and live policy if they change during the health probe", async () => {
    const { router, probe, fetcher, cache, config } = await fixture();
    probe.mockImplementationOnce(async () => {
      fetcher.mockResolvedValue(list("b"));
      await cache.refresh();
      config.agents.defaults.modelPolicy.allow = ["imajin/b"];
      return { ok: true, status: 200 };
    });
    expect(await router.beforeModelResolve({}, following)).toEqual({ providerOverride: "imajin", modelOverride: "b" });
  });

  it.each(["a", "b"])("explicit session imajin/%s survives refresh and outages, including a pin equal to the old pick", async (id) => {
    const { router, fetcher, cache, probe } = await fixture();
    const ctx = { modelProviderId: "imajin", modelId: id };
    expect(await router.beforeModelResolve({}, ctx)).toBeUndefined();
    fetcher.mockResolvedValue(list("b"));
    await cache.refresh();
    probe.mockResolvedValue({ ok: false });
    expect(await router.beforeModelResolve({}, ctx)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    expect(router.status().fallbackCount).toBe(0);
  });

  it.each([{}, { modelProviderId: "direct", modelId: "emergency" }, { modelProviderId: "other", modelId: "default" }])(
    "does not hijack other explicit routing %j", async (ctx) => {
      const { router, probe } = await fixture();
      expect(await router.beforeModelResolve({}, ctx)).toBeUndefined();
      expect(probe).not.toHaveBeenCalled();
    });

  it("advertises the floating selector only with a real picked marker, retaining kernel order for multiple cards", async () => {
    const { cache, fetcher, router } = await fixture();
    fetcher.mockResolvedValue({ data: [
      { id: "b", imajin: { picked: true } }, { id: "a", imajin: { picked: true } },
    ] });
    await cache.refresh();
    expect(await router.beforeModelResolve({}, following)).toMatchObject({ modelOverride: "b" });
    const catalog = buildImajinProviderConfig({ baseUrl: "proxy", models: cache.peek()!.models });
    expect(catalog.models.map((m) => m.id)).toEqual(["b", "a", "default"]);
    fetcher.mockResolvedValue({ data: [
      { id: "a", imajin: { picked: "true" } }, { id: "b", imajin: { picked: true, servable: false } },
    ] });
    await cache.refresh();
    expect(await router.beforeModelResolve({}, following)).toBeUndefined();
    expect(buildImajinProviderConfig({ baseUrl: "proxy", models: cache.peek()!.models }).models.map((m) => m.id)).toEqual(["a"]);
    expect(router.status().pickedModel).toBeNull();
  });

  it("an authoritative empty list clears the pick; discovery failure keeps the last good pick", async () => {
    const { router, fetcher, cache } = await fixture();
    fetcher.mockRejectedValue(new ImajinDiscoveryError("auth-error", "denied"));
    await cache.refresh();
    expect(await router.beforeModelResolve({}, following)).toMatchObject({ modelOverride: "a" });
    fetcher.mockResolvedValue({ data: [] });
    await cache.refresh();
    expect(await router.beforeModelResolve({}, following)).toBeUndefined();
    expect(router.status().fallbackCount).toBe(0);
  });
});

describe("observable transport-only break-glass", () => {
  it.each([undefined, 502, 503, 504])("routes directly only on passthrough transport failure %s and recovers next turn", async (status) => {
    const { router, probe } = await fixture();
    probe.mockResolvedValue({ ok: false, status, error: "untrusted transport details" });
    expect(await router.beforeModelResolve({}, following)).toEqual({ providerOverride: "direct", modelOverride: "emergency" });
    expect(router.status()).toMatchObject({
      fallbackCount: 1, lastReason: "passthrough_unreachable", lastFallbackAt: new Date(1234).toISOString(),
    });
    await router.beforeModelResolve({}, following);
    expect(router.status().fallbackCount).toBe(2);
    probe.mockResolvedValue({ ok: true, status: 200 });
    expect(await router.beforeModelResolve({}, following)).toMatchObject({ modelOverride: "a" });
    expect(router.status().fallbackCount).toBe(2);
  });

  it("confirms kernel discovery transport failure, and checks recovery before falling back again", async () => {
    const { router, fetcher, cache } = await fixture();
    fetcher.mockRejectedValue(new ImajinDiscoveryError("unreachable", "untrusted network details"));
    await cache.refresh();
    expect(await router.beforeModelResolve({}, following)).toMatchObject({ providerOverride: "direct" });
    expect(router.status()).toMatchObject({ fallbackCount: 1, lastReason: "kernel_unreachable" });
    fetcher.mockResolvedValue(list("b"));
    expect(await router.beforeModelResolve({}, following)).toMatchObject({ providerOverride: "imajin", modelOverride: "b" });
    expect(router.status().fallbackCount).toBe(1);
  });

  it.each([400, 401, 403, 404, 402, 409, 429, 500])("never treats reachable HTTP %s as permission to spend directly", async (status) => {
    const { router, probe } = await fixture();
    probe.mockResolvedValue({ ok: false, status });
    expect(await router.beforeModelResolve({}, following)).toMatchObject({ providerOverride: "imajin" });
    expect(router.status().fallbackCount).toBe(0);
  });

  it.each(["auth-error", "route-error", "malformed", "unconfigured"] as const)(
    "discovery %s never enables direct fallback", async (kind) => {
      const { router, fetcher, cache } = await fixture();
      fetcher.mockRejectedValue(new ImajinDiscoveryError(kind, "untrusted response"));
      await cache.refresh();
      expect(await router.beforeModelResolve({}, following)).toMatchObject({ providerOverride: "imajin" });
      expect(router.status().fallbackCount).toBe(0);
    });

  it("does not infer outage from stale proxy history", async () => {
    const { router, probe } = await fixture();
    probe.mockResolvedValue({ ok: true, status: 200, body: { kernelOk: false, passthroughOk: false } });
    expect(await router.beforeModelResolve({}, following)).toMatchObject({ providerOverride: "imajin" });
  });

  it.each(["", "alias", "imajin/a", "imajin-xai/a", "IMAJIN/a", "direct/*", "https://host/a", "direct/a b", "direct/"])(
    "refuses invalid/non-direct break-glass ref %j", async (ref) => {
      const { router, probe, config } = await fixture();
      config.plugins.entries.imajin.config.modelDiscovery.breakGlassModel = ref;
      probe.mockResolvedValue({ ok: false });
      expect(isDirectModelRef(ref)).toBe(false);
      expect(await router.beforeModelResolve({}, following)).toMatchObject({ providerOverride: "imajin" });
      expect(router.status().fallbackCount).toBe(0);
      const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
      expect(new RegExp(manifest.configSchema.properties.modelDiscovery.properties.breakGlassModel.pattern).test(ref)).toBe(false);
    });

  it("does not bypass model policy for either the picked model or emergency ref", async () => {
    const { router, config, probe } = await fixture();
    config.agents.defaults.modelPolicy.allow = ["imajin/default"];
    expect(await router.beforeModelResolve({}, following)).toBeUndefined();
    probe.mockResolvedValue({ ok: false });
    expect(await router.beforeModelResolve({}, following)).toBeUndefined();
    expect(router.status().fallbackCount).toBe(0);
    config.agents.defaults.modelPolicy.allow = "invalid" as never;
    expect(await router.beforeModelResolve({}, following)).toBeUndefined();
  });

  it("imajin_status exposes every routed fallback count and a value-free last reason", async () => {
    const { router, cache, probe } = await fixture();
    probe.mockResolvedValue({ ok: false });
    await router.beforeModelResolve({}, following);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
    const tool = createImajinStatusTool({ baseUrl: "http://proxy.test", cache, getDefaultRouting: router.status });
    const report = JSON.parse((await tool.execute()).content[0].text);
    expect(report.defaultRouting).toEqual({
      selector: "imajin/default", pickedModel: "imajin/a",
      fallbackCount: 1, lastReason: "passthrough_unreachable", lastFallbackAt: new Date(1234).toISOString(),
    });
  });
});
