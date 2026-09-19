import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildImajinModelRef,
  createImajinCatalogSource,
  isImajinModelAllowedByPolicy,
  type ImajinCatalogSourceDeps,
  type ImajinModelPolicyGatewayClient,
} from "./imajin-catalog.js";
import type { ImajinRuntimeModel } from "../imajin-provider.js";

function makeModel(id: string, connector?: string): ImajinRuntimeModel {
  return {
    id,
    name: connector ? `${id} (via ${connector})` : id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    ...(connector ? { connector } : {}),
  };
}

describe("isImajinModelAllowedByPolicy", () => {
  it("allows any model when the allow list is omitted or empty (matches OpenClaw's own semantics)", () => {
    expect(isImajinModelAllowedByPolicy(undefined, "grok-4")).toBe(true);
    expect(isImajinModelAllowedByPolicy([], "grok-4")).toBe(true);
  });

  it("allows an exact imajin/<model> ref", () => {
    expect(isImajinModelAllowedByPolicy(["imajin/grok-4"], "grok-4")).toBe(true);
    expect(isImajinModelAllowedByPolicy(["imajin/grok-4"], "gpt-6-astra")).toBe(false);
  });

  it("allows a trailing wildcard imajin/*", () => {
    expect(isImajinModelAllowedByPolicy(["imajin/*"], "grok-4")).toBe(true);
    expect(isImajinModelAllowedByPolicy(["imajin/*"], "gpt-6-astra")).toBe(true);
  });

  it("does not allow an imajin model when the allow list only names other providers", () => {
    expect(isImajinModelAllowedByPolicy(["openai/*", "anthropic/claude-opus-4-6"], "grok-4")).toBe(false);
  });

  it("buildImajinModelRef builds the imajin/<id> ref", () => {
    expect(buildImajinModelRef("grok-4")).toBe("imajin/grok-4");
  });
});

describe("createImajinCatalogSource", () => {
  function makeDeps(overrides: Partial<ImajinCatalogSourceDeps> = {}): {
    deps: ImajinCatalogSourceDeps;
    gateway: { getConfig: ReturnType<typeof vi.fn>; patchModelPolicyAllow: ReturnType<typeof vi.fn> };
  } {
    const gateway = {
      getConfig: vi.fn().mockResolvedValue({ hash: "hash-1", allow: ["openai/*"] }),
      patchModelPolicyAllow: vi.fn().mockResolvedValue(undefined),
    };
    const deps: ImajinCatalogSourceDeps = {
      listDiscoveredModels: () => [makeModel("grok-4", "xai"), makeModel("gpt-6-astra", "openai")],
      isModelAllowed: () => false,
      gateway: gateway as unknown as ImajinModelPolicyGatewayClient,
      ...overrides,
    };
    return { deps, gateway };
  }

  it("has id 'imajin-catalog', onDriftPolicy 'restage', and Enable/Ignore decision labels", () => {
    const { deps } = makeDeps();
    const source = createImajinCatalogSource(deps);
    expect(source.id).toBe("imajin-catalog");
    expect(source.onDriftPolicy).toBe("restage");
    expect(source.decisionLabels).toEqual({ approve: "Enable", reject: "Ignore" });
  });

  it("list() proposes only models not yet allowed", async () => {
    const { deps } = makeDeps({
      isModelAllowed: (modelId: string) => modelId === "gpt-6-astra",
    });
    const source = createImajinCatalogSource(deps);

    const requests = await source.list();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      proposalId: "imajin-catalog:grok-4",
      kind: "imajin-catalog:new-model",
      summary: "Enable imajin/grok-4 for agents?",
      sourceRevision: "grok-4",
    });
    expect(requests[0].detail).toMatchObject({ modelId: "grok-4", ref: "imajin/grok-4", connector: "xai" });
  });

  it("list() proposes nothing once every discovered model is allowed", async () => {
    const { deps } = makeDeps({ isModelAllowed: () => true });
    const source = createImajinCatalogSource(deps);
    expect(await source.list()).toEqual([]);
  });

  describe("subscribe()", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("polls discovery on an interval and reports only newly-pending models", async () => {
      let models: ImajinRuntimeModel[] = [];
      const { deps } = makeDeps({ listDiscoveredModels: () => models });
      const source = createImajinCatalogSource(deps, { pollIntervalMs: 1000 });
      const onRequested = vi.fn();
      const unsubscribe = source.subscribe(onRequested);

      models = [makeModel("grok-4", "xai")];
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).toHaveBeenCalledTimes(1);
      expect(onRequested).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "imajin-catalog:grok-4" }));

      // Still pending on the next poll — must not re-fire.
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).toHaveBeenCalledTimes(1);

      unsubscribe();
    });
  });

  it("getCurrent() reports pending:false for an already-allowed or unknown model", async () => {
    const { deps } = makeDeps({ isModelAllowed: () => true });
    const source = createImajinCatalogSource(deps);

    await expect(source.getCurrent("imajin-catalog:grok-4")).resolves.toEqual({
      pending: false,
      sourceRevision: null,
    });
    await expect(source.getCurrent("not-an-imajin-catalog-id")).resolves.toBeNull();
  });

  it("getCurrent() reports pending:true with detail for a still-pending model", async () => {
    const { deps } = makeDeps();
    const source = createImajinCatalogSource(deps);

    const current = await source.getCurrent("imajin-catalog:grok-4");
    expect(current).toMatchObject({ pending: true, sourceRevision: "grok-4" });
  });

  // --- #36 hard requirement: never write gateway config without a decision ---

  it("resolve('approve') fetches the current allow list and appends imajin/<model> via config.patch", async () => {
    const { deps, gateway } = makeDeps();
    const source = createImajinCatalogSource(deps);

    const result = await source.resolve("imajin-catalog:grok-4", "approve", "grok-4");

    expect(result.applied).toBe(true);
    expect(gateway.getConfig).toHaveBeenCalledTimes(1);
    expect(gateway.patchModelPolicyAllow).toHaveBeenCalledWith(["openai/*", "imajin/grok-4"], "hash-1");
  });

  it("resolve('approve') is a no-op write when the ref is already present", async () => {
    const { deps, gateway } = makeDeps();
    gateway.getConfig.mockResolvedValue({ hash: "hash-1", allow: ["imajin/grok-4"] });
    const source = createImajinCatalogSource(deps);

    const result = await source.resolve("imajin-catalog:grok-4", "approve", "grok-4");

    expect(result.applied).toBe(true);
    expect(gateway.patchModelPolicyAllow).not.toHaveBeenCalled();
  });

  it("resolve('reject') NEVER reads or writes gateway config, and dismisses the model", async () => {
    const { deps, gateway } = makeDeps();
    const source = createImajinCatalogSource(deps);

    const result = await source.resolve("imajin-catalog:grok-4", "reject", "grok-4");

    expect(result.applied).toBe(true);
    expect(gateway.getConfig).not.toHaveBeenCalled();
    expect(gateway.patchModelPolicyAllow).not.toHaveBeenCalled();

    // A dismissed model must not be re-proposed by list().
    const requests = await source.list();
    expect(requests.some((r) => r.proposalId === "imajin-catalog:grok-4")).toBe(false);
  });

  it("no config write ever happens simply from list()/subscribe()/getCurrent() — only resolve('approve') writes", async () => {
    const { deps, gateway } = makeDeps();
    const source = createImajinCatalogSource(deps);

    await source.list();
    await source.getCurrent("imajin-catalog:grok-4");
    const unsubscribe = source.subscribe(() => {});
    unsubscribe();

    expect(gateway.getConfig).not.toHaveBeenCalled();
    expect(gateway.patchModelPolicyAllow).not.toHaveBeenCalled();
  });

  it("resolve() for an unrecognized proposal id is a safe no-op", async () => {
    const { deps, gateway } = makeDeps();
    const source = createImajinCatalogSource(deps);

    const result = await source.resolve("system-agent:something-else", "approve", "n/a");

    expect(result).toEqual({ applied: false });
    expect(gateway.getConfig).not.toHaveBeenCalled();
  });
});
