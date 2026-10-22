import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildImajinModelRef,
  createLiveImajinModelPolicyGatewayClient,
  createImajinCatalogSource,
  isImajinModelAllowedByPolicy,
  type ImajinCatalogSourceDeps,
  type ImajinCatalogProposalState,
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

describe("createImajinCatalogSource reconciliation (#105)", () => {
  function fixture(ids = ["grok-4", "gpt-6-astra"], initialAllow = ["openai/*"]) {
    let models = ids.map((id) => makeModel(id));
    let allow = [...initialAllow];
    let ready = true;
    const gateway = {
      getConfig: vi.fn(async () => ({ hash: "hash-1", allow: [...allow] })),
      patchModelPolicyAllow: vi.fn(async (next: string[], _hash: string) => { allow = next; }),
    };
    const deps: ImajinCatalogSourceDeps = {
      listDiscoveredModels: () => models, isDiscoveryReady: () => ready, gateway,
    };
    const source = createImajinCatalogSource(deps, { pollIntervalMs: 1000 });
    return { source, gateway, setModels: (ids: string[]) => { models = ids.map((id) => makeModel(id)); },
      setAllow: (next: string[]) => { allow = next; }, setReady: (next: boolean) => { ready = next; } };
  }

  it("lists all additions on ONE card, writes nothing until approval, then adds exactly those refs", async () => {
    const { source, gateway } = fixture();
    const requests = await source.list();
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({ kind: "imajin-catalog:reconcile", detail: {
      add: ["imajin/gpt-6-astra", "imajin/grok-4"], remove: [], path: "agents.defaults.modelPolicy.allow",
    } });
    expect(await source.getCurrent(request.proposalId)).toMatchObject({ pending: true, detail: request.detail });
    expect(gateway.patchModelPolicyAllow).not.toHaveBeenCalled();
    await source.resolve(request.proposalId, "approve", request.sourceRevision);
    expect(gateway.patchModelPolicyAllow).toHaveBeenCalledWith(
      ["openai/*", "imajin/gpt-6-astra", "imajin/grok-4"], "hash-1");
    expect(await source.list()).toEqual([]);
  });

  it("proposes removed refs without silently removing them, preserving other provider policy", async () => {
    const { source, gateway } = fixture([], ["openai/*", "imajin/grok-4", "imajin/gpt-6-astra"]);
    const [request] = await source.list();
    expect(request.detail).toMatchObject({ add: [], remove: ["imajin/gpt-6-astra", "imajin/grok-4"] });
    expect(gateway.patchModelPolicyAllow).not.toHaveBeenCalled();
    await source.resolve(request.proposalId, "approve", request.sourceRevision);
    expect(gateway.patchModelPolicyAllow).toHaveBeenCalledWith(["openai/*"], "hash-1");
  });

  it("explicitly warns before approval would empty a restrictive policy (OpenClaw treats [] as allow-any)", async () => {
    const { source, gateway } = fixture([], ["imajin/grok-4"]);
    const [request] = await source.list();
    expect(request.detail).toMatchObject({ remove: ["imajin/grok-4"], warning: expect.stringContaining("allow any") });
    expect(gateway.patchModelPolicyAllow).not.toHaveBeenCalled();
    await source.resolve(request.proposalId, "approve", request.sourceRevision);
    expect(gateway.patchModelPolicyAllow).toHaveBeenCalledWith([], "hash-1");
  });

  it("retires both static namespaces only AFTER their discovered equivalents are allowed", async () => {
    const legacy = ["imajin-openai/gpt-6-astra", "imajin-xai/grok-4", "imajin-xai/keep-me"];
    const { source, gateway } = fixture(undefined, legacy);
    const [add] = await source.list();
    expect(add.detail?.remove).toEqual([]);
    await source.resolve(add.proposalId, "approve", add.sourceRevision);
    expect(gateway.patchModelPolicyAllow.mock.calls[0][0]).toEqual([
      ...legacy, "imajin/gpt-6-astra", "imajin/grok-4",
    ]);
    const [remove] = await source.list();
    expect(remove.detail).toMatchObject({ add: [], remove: legacy.slice(0, 2) });
    await source.resolve(remove.proposalId, "approve", remove.sourceRevision);
    expect(gateway.patchModelPolicyAllow.mock.calls[1][0]).toEqual([
      "imajin-xai/keep-me", "imajin/gpt-6-astra", "imajin/grok-4",
    ]);
  });

  it.each([{ allow: [] }, { allow: ["imajin/*"] }, { allow: ["*"] }])("does not add refs already covered by policy %j", async ({ allow }) => {
    expect(await fixture(undefined, allow).source.list()).toEqual([]);
  });

  it("never removes wildcard or alias policy, even on an empty catalog", async () => {
    const { source } = fixture([], ["imajin/*", "imajin-xai/*", "imajin-openai/*", "brain-alias"]);
    expect(await source.list()).toEqual([]);
  });

  it("reject keeps config unchanged and suppresses the same delta", async () => {
    const { source, gateway } = fixture();
    const [request] = await source.list();
    await source.resolve(request.proposalId, "reject", request.sourceRevision);
    expect(gateway.patchModelPolicyAllow).not.toHaveBeenCalled();
    expect(await source.list()).toEqual([]);
  });

  it("reuses a pending card after restart and persists Ignore without proposing it again", async () => {
    const state: ImajinCatalogProposalState = { revision: null, proposalId: null, dismissed: false };
    const persistState = vi.fn(async () => {});
    const deps: ImajinCatalogSourceDeps = {
      listDiscoveredModels: () => [makeModel("grok-4")], isDiscoveryReady: () => true,
      gateway: { getConfig: async () => ({ hash: "h", allow: ["openai/*"] }), patchModelPolicyAllow: vi.fn() },
    };
    const [original] = await createImajinCatalogSource(deps, { state, persistState }).list();
    const restarted = createImajinCatalogSource(deps, { state, persistState });
    expect(await restarted.list()).toEqual([original]);
    await restarted.resolve(original.proposalId, "reject", original.sourceRevision);
    expect(await createImajinCatalogSource(deps, { state, persistState }).list()).toEqual([]);
    expect(persistState).toHaveBeenCalledTimes(2);
  });

  it("reappearance after an approved removal gets a fresh consent id, not a consumed replay id", async () => {
    const { source, setModels } = fixture(["grok-4"]);
    const [first] = await source.list();
    await source.resolve(first.proposalId, "approve", first.sourceRevision);
    setModels([]);
    const [remove] = await source.list();
    await source.resolve(remove.proposalId, "approve", remove.sourceRevision);
    setModels(["grok-4"]);
    const [again] = await source.list();
    expect(again.sourceRevision).toBe(first.sourceRevision);
    expect(again.proposalId).not.toBe(first.proposalId);
  });

  it.each(["catalog", "policy", "revision", "discovery failure"])("refuses stale approval after %s drift", async (change) => {
    const { source, gateway, setModels, setAllow, setReady } = fixture();
    const [request] = await source.list();
    if (change === "catalog") setModels(["new-model"]);
    if (change === "policy") setAllow(["openai/*", "imajin/grok-4"]);
    if (change === "discovery failure") setReady(false);
    await expect(source.resolve(request.proposalId, "approve", change === "revision" ? "wrong" : request.sourceRevision))
      .rejects.toThrow("delta changed");
    expect(gateway.patchModelPolicyAllow).not.toHaveBeenCalled();
  });

  it("preserves unrelated policy edits made after staging and uses the latest base hash", async () => {
    const { source, gateway, setAllow } = fixture();
    const [request] = await source.list();
    setAllow(["openai/*", "anthropic/*"]);
    await source.resolve(request.proposalId, "approve", request.sourceRevision);
    expect(gateway.patchModelPolicyAllow).toHaveBeenCalledWith([
      "openai/*", "anthropic/*", "imajin/gpt-6-astra", "imajin/grok-4",
    ], "hash-1");
  });

  it("does not mistake failed/unattempted discovery for an authoritative empty catalog", async () => {
    const { source, gateway, setReady } = fixture([], ["imajin/grok-4"]);
    setReady(false);
    expect(await source.list()).toEqual([]);
    expect(gateway.getConfig).not.toHaveBeenCalled();
    expect(gateway.patchModelPolicyAllow).not.toHaveBeenCalled();
  });

  it("rechecks discovery after config.get completes", async () => {
    const { source, gateway, setReady } = fixture();
    gateway.getConfig.mockImplementation(async () => { setReady(false); return { hash: "hash-1", allow: ["other/*"] }; });
    expect(await source.list()).toEqual([]);
    expect(gateway.patchModelPolicyAllow).not.toHaveBeenCalled();
  });

  it("propagates missing scope and config hash conflicts without a fallback write", async () => {
    const { source, gateway } = fixture();
    gateway.getConfig.mockRejectedValueOnce(new Error("FORBIDDEN: missing scope: operator.admin"));
    await expect(source.list()).rejects.toThrow("missing scope");
    const [request] = await source.list();
    gateway.patchModelPolicyAllow.mockRejectedValueOnce(new Error("baseHash changed"));
    await expect(source.resolve(request.proposalId, "approve", request.sourceRevision)).rejects.toThrow("baseHash changed");
    expect(gateway.patchModelPolicyAllow).toHaveBeenCalledTimes(1);
  });

  it("refuses oversized approval detail rather than truncating the refs the operator sees", async () => {
    const { source, gateway } = fixture(Array.from({ length: 1000 }, (_, i) => `long-model-name-${i}`));
    await expect(source.list()).rejects.toThrow("detail limit");
    expect(gateway.patchModelPolicyAllow).not.toHaveBeenCalled();
  });

  it("unknown proposal ids cannot read or mutate policy", async () => {
    const { source, gateway } = fixture();
    expect(await source.getCurrent("another-source:1")).toBeNull();
    expect(await source.resolve("another-source:1", "approve", "n/a")).toEqual({ applied: false });
    expect(gateway.getConfig).not.toHaveBeenCalled();
  });

  describe("refresh notifications", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("unchanged/reordered catalog emits no duplicate card; a changed delta emits one", async () => {
      const { source, setModels, gateway } = fixture([]);
      const notify = vi.fn();
      await source.list();
      const stop = source.subscribe(notify);
      setModels(["grok-4", "gpt-6-astra"]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(notify).toHaveBeenCalledTimes(1);
      setModels(["gpt-6-astra", "grok-4", "grok-4"]);
      await vi.advanceTimersByTimeAsync(3000);
      expect(notify).toHaveBeenCalledTimes(1);
      setModels(["new-model"]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(notify).toHaveBeenCalledTimes(2);
      expect(gateway.patchModelPolicyAllow).not.toHaveBeenCalled();
      stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(notify).toHaveBeenCalledTimes(2);
    });

    it("startup list and subscribe share dedup state", async () => {
      const { source } = fixture();
      await source.list();
      const notify = vi.fn();
      const stop = source.subscribe(notify);
      await vi.advanceTimersByTimeAsync(3000);
      expect(notify).not.toHaveBeenCalled();
      stop();
    });

    it("retries publication failures, respecting deterministic rejection backoff", async () => {
      const { source } = fixture();
      const [request] = await source.list();
      const notify = vi.fn();
      const stop = source.subscribe(notify);
      source.onPublishFailed?.(request.proposalId);
      await vi.advanceTimersByTimeAsync(1000);
      expect(notify).toHaveBeenCalledTimes(1);
      source.onPublishFailed?.(request.proposalId, { retryAtMs: Date.now() + 2000 });
      await vi.advanceTimersByTimeAsync(2000);
      expect(notify).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(notify).toHaveBeenCalledTimes(2);
      stop();
    });
  });
});

describe("live model policy RPC adapter", () => {
  it.each([{}, { hash: "h" }, { config: {} }, { hash: "h", config: { agents: { defaults: { modelPolicy: { allow: [42] } } } } },
    { hash: "h", config: { agents: { defaults: { modelPolicy: { allow: "imajin/*" } } } } }])(
    "rejects malformed config snapshots %j", async (result) => {
      const request = vi.fn().mockResolvedValue(result);
      await expect(createLiveImajinModelPolicyGatewayClient({ request }).getConfig()).rejects.toThrow("invalid config");
      expect(request).toHaveBeenCalledWith("config.get", {});
    });

  it("omitted allow means allow-any, while patch replaces only the exact allow array with baseHash", async () => {
    const request = vi.fn().mockResolvedValue({ hash: "h", config: {} });
    const client = createLiveImajinModelPolicyGatewayClient({ request });
    expect(await client.getConfig()).toEqual({ hash: "h", allow: [] });
    await client.patchModelPolicyAllow(["imajin/grok-4"], "h");
    expect(request).toHaveBeenLastCalledWith("config.patch", {
      raw: JSON.stringify({ agents: { defaults: { modelPolicy: { allow: ["imajin/grok-4"] } } } }),
      baseHash: "h", replacePaths: ["agents.defaults.modelPolicy.allow"],
    });
  });
});
