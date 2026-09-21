import { describe, it, expect, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  GatewayApprovalsBridge,
  resolveEnabledApprovalSourceIds,
  type KernelBusEventFrame,
  type KernelNotifyClient,
} from "./gateway-approvals-bridge.js";
import { createSystemAgentSource, type GatewayApprovalsClient } from "./sources/system-agent.js";
import { createSkillWorkshopSource, type SkillWorkshopGatewayClient } from "./sources/skill-workshop.js";
import { createImajinCatalogSource, type ImajinModelPolicyGatewayClient } from "./sources/imajin-catalog.js";
import type { ImajinRuntimeModel } from "./imajin-provider.js";
import {
  createGatewayExecSource,
  type GatewayExecApprovalRecord,
  type GatewayExecApprovalsClient,
} from "./sources/gateway-exec.js";
import type { ApprovalSource } from "./sources/types.js";

if ("hashes" in ed && ed.hashes) {
  (ed.hashes as { sha512?: typeof sha512 }).sha512 = sha512;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function generatePrivateKeyHex(): Promise<string> {
  return bytesToHex(ed.utils.randomPrivateKey());
}

const OPERATOR_DID = "did:imajin:operator";
const AGENT_DID = "did:imajin:agent";

function makeKernel(): { publishApprovalRequested: ReturnType<typeof vi.fn>; publishMismatch: ReturnType<typeof vi.fn> } {
  return {
    publishApprovalRequested: vi.fn().mockResolvedValue(undefined),
    publishMismatch: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDecidedFrame(proposalId: string, decision = "approve", contentHash?: string): KernelBusEventFrame {
  return {
    type: "bus_event",
    eventType: "operator.approval.decided",
    issuer: OPERATOR_DID,
    subject: OPERATOR_DID,
    scope: "operator",
    payload: { proposalId, decision, decidedBy: OPERATOR_DID, decidedAt: new Date().toISOString(), contentHash },
  };
}

function lastPublishedContentHash(kernel: { publishApprovalRequested: ReturnType<typeof vi.fn> }): string {
  const calls = kernel.publishApprovalRequested.mock.calls;
  return calls[calls.length - 1][0].contentHash as string;
}

// --- Adapter contract suite (#33 acceptance: "adapter contract test run against both sources") ---

function makeSystemAgentFixture(): { source: ApprovalSource; makePending: () => void } {
  const client: GatewayApprovalsClient = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({ status: "pending", presentation: { proposalHash: "hash-1" } }),
    resolve: vi.fn().mockResolvedValue({ applied: true }),
    onRequested: vi.fn(),
  };
  const record = {
    id: "contract-proposal",
    request: {
      title: "OpenClaw change",
      description: "Restart the gateway",
      command: "restart",
      proposalHash: "hash-1",
      allowedDecisions: ["allow-once", "deny"] as const,
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 600_000,
  };
  (client.list as ReturnType<typeof vi.fn>).mockResolvedValue([record]);
  return { source: createSystemAgentSource(client), makePending: () => {} };
}

function makeSkillWorkshopFixture(): { source: ApprovalSource; makePending: () => void } {
  const client: SkillWorkshopGatewayClient = {
    list: vi.fn().mockResolvedValue({
      proposals: [
        {
          id: "contract-proposal",
          kind: "update",
          status: "pending",
          description: "Update trip-planning",
          skillName: "trip-planning",
          scanState: "clean",
          revisionHash: "hash-1",
        },
      ],
    }),
    apply: vi.fn().mockResolvedValue({ applied: true }),
    reject: vi.fn().mockResolvedValue(undefined),
  };
  return { source: createSkillWorkshopSource(client), makePending: () => {} };
}

function makeGatewayExecFixture(): { source: ApprovalSource; makePending: () => void } {
  const record: GatewayExecApprovalRecord = {
    id: "contract-proposal",
    request: {
      command: "echo hi",
      cwd: "/tmp",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:1",
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 1_800_000,
  };
  const client: GatewayExecApprovalsClient = {
    list: vi.fn().mockResolvedValue([record]),
    resolve: vi.fn().mockResolvedValue({ applied: true }),
    onRequested: vi.fn(),
    onFinished: vi.fn(),
  };
  return { source: createGatewayExecSource(client, { agentDid: AGENT_DID }), makePending: () => {} };
}

describe.each([
  ["system-agent", makeSystemAgentFixture],
  ["skill-workshop", makeSkillWorkshopFixture],
  ["gateway-exec", makeGatewayExecFixture],
])("ApprovalSource contract: %s", (name, makeFixture) => {
  it("implements list/subscribe/getCurrent/resolve and reports a consistent proposalId+contentHash", async () => {
    const { source } = makeFixture();
    expect(typeof source.list).toBe("function");
    expect(typeof source.subscribe).toBe("function");
    expect(typeof source.getCurrent).toBe("function");
    expect(typeof source.resolve).toBe("function");

    const [request] = await source.list();
    expect(request.proposalId).toBe("contract-proposal");
    // Every source (including gateway-exec, #38, kernel #2221/PR #2223)
    // namespaces `kind` as "<source>:<subkind>" — see gateway-exec.ts's
    // module doc for why an earlier draft's bare "exec.command" literal was
    // corrected to follow this convention.
    expect(request.kind.startsWith(`${source.id}:`)).toBe(true);
    if (name !== "gateway-exec") {
      expect(request.sourceRevision).toBe("hash-1");
    }

    const current = await source.getCurrent(request.proposalId);
    expect(current?.pending).toBe(true);

    const result = await source.resolve(request.proposalId, "approve", current!.sourceRevision!);
    expect(result.applied).toBe(true);

    const unsubscribe = source.subscribe(() => {});
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });
});

// --- resolveEnabledApprovalSourceIds ---

describe("resolveEnabledApprovalSourceIds", () => {
  it("defaults to both known sources when omitted", () => {
    expect(resolveEnabledApprovalSourceIds(undefined)).toEqual(new Set(["system-agent", "skill-workshop"]));
  });
  it("respects an explicit subset", () => {
    expect(resolveEnabledApprovalSourceIds(["system-agent"])).toEqual(new Set(["system-agent"]));
  });
  it("ignores unknown source ids", () => {
    expect(resolveEnabledApprovalSourceIds(["skill-workshop", "not-a-real-source"])).toEqual(
      new Set(["skill-workshop"]),
    );
  });
});

// --- Disabled source is inert (#33 acceptance) ---

describe("disabled source inertness", () => {
  it("a source left out of approvals.sources is never listed or subscribed", async () => {
    const skillWorkshopClient: SkillWorkshopGatewayClient = {
      list: vi.fn().mockResolvedValue({ proposals: [] }),
      apply: vi.fn(),
      reject: vi.fn(),
    };
    const skillWorkshopSource = createSkillWorkshopSource(skillWorkshopClient);
    const enabled = resolveEnabledApprovalSourceIds(["system-agent"]);
    expect(enabled.has("skill-workshop")).toBe(false);

    // Mirrors startGatewayApprovalsBridge's construction: only sources
    // present in the enabled set are ever added to the bridge's Map, so a
    // disabled source's `list`/`subscribe` are never called at all.
    const sources = new Map<string, ApprovalSource>();
    if (enabled.has("skill-workshop")) sources.set("skill-workshop", skillWorkshopSource);

    const kernel = makeKernel();
    const bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: await generatePrivateKeyHex() },
      sources,
      kernel as unknown as KernelNotifyClient,
    );
    await bridge.reconcile();

    expect(skillWorkshopClient.list).not.toHaveBeenCalled();
  });
});

// --- Skill Workshop revision drift -> re-stage, driven end-to-end through the bridge ---

describe("GatewayApprovalsBridge + skill-workshop: revision drift", () => {
  it("does not apply a drifted proposal and re-stages it with the fresh revision hash", async () => {
    const listMock = vi.fn();
    // First call (initial reconcile/discovery): the proposal at rev-1.
    listMock.mockResolvedValueOnce({
      proposals: [
        {
          id: "proposal-1",
          kind: "update",
          status: "pending",
          description: "Update trip-planning",
          skillName: "trip-planning",
          scanState: "clean",
          revisionHash: "rev-1",
        },
      ],
    });
    const client: SkillWorkshopGatewayClient = {
      list: listMock,
      apply: vi.fn(),
      reject: vi.fn(),
    };
    const source = createSkillWorkshopSource(client);
    const kernel = makeKernel();
    const bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: await generatePrivateKeyHex() },
      new Map<string, ApprovalSource>([["skill-workshop", source]]),
      kernel as unknown as KernelNotifyClient,
    );

    await bridge.reconcile();
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
    expect(bridge.isPublished("proposal-1")).toBe(true);
    const stagedContentHash = lastPublishedContentHash(kernel);

    // The proposal was revised (new revisionHash) after the operator saw it,
    // but is still pending — subsequent list() calls (getCurrent's pre-check,
    // then reconcileSource's re-stage) return the fresh revision. The kernel
    // still echoes back the ORIGINALLY staged contentHash (check 1 passes;
    // the kernel has no way to know the source drifted) — the drift is
    // caught at check 2, the bridge's own recompute against current state.
    listMock.mockResolvedValue({
      proposals: [
        {
          id: "proposal-1",
          kind: "update",
          status: "pending",
          description: "Update trip-planning (revised)",
          skillName: "trip-planning",
          scanState: "clean",
          revisionHash: "rev-2",
        },
      ],
    });

    await bridge.handleKernelDecision(makeDecidedFrame("proposal-1", "approve", stagedContentHash));

    expect(client.apply).not.toHaveBeenCalled();
    expect(kernel.publishMismatch).toHaveBeenCalledWith("proposal-1", expect.stringContaining("no longer matches"));
    // Re-staged: evicted then immediately re-published with the fresh hash.
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(2);
    const secondPublish = kernel.publishApprovalRequested.mock.calls[1][0];
    expect(secondPublish.contentHash).not.toBe(stagedContentHash);
    expect(secondPublish.detail).toMatchObject({ sourceRevision: "rev-2" });
    expect(bridge.isPublished("proposal-1")).toBe(true);
  });

  it("hash covers detail (#2084): mutating only detail (same sourceRevision) still blocks the decision", async () => {
    const listMock = vi.fn();
    const pendingProposal = (description: string) => ({
      proposals: [
        {
          id: "proposal-2",
          kind: "update" as const,
          status: "pending",
          description,
          skillName: "trip-planning",
          scanState: "clean" as const,
          revisionHash: "rev-same",
        },
      ],
    });
    listMock.mockResolvedValueOnce(pendingProposal("original description"));
    const client: SkillWorkshopGatewayClient = { list: listMock, apply: vi.fn(), reject: vi.fn() };
    const source = createSkillWorkshopSource(client);
    const kernel = makeKernel();
    const bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: await generatePrivateKeyHex() },
      new Map<string, ApprovalSource>([["skill-workshop", source]]),
      kernel as unknown as KernelNotifyClient,
    );

    await bridge.reconcile();
    const stagedContentHash = lastPublishedContentHash(kernel);

    // Only `description` (part of `detail`) changes; `revisionHash` (the
    // source-native `sourceRevision`) stays exactly "rev-same".
    listMock.mockResolvedValue(pendingProposal("a materially different description"));

    await bridge.handleKernelDecision(makeDecidedFrame("proposal-2", "approve", stagedContentHash));

    expect(client.apply).not.toHaveBeenCalled();
    expect(kernel.publishMismatch).toHaveBeenCalledWith("proposal-2", expect.stringContaining("no longer matches"));
  });
});

// --- imajin-catalog (#36): publish on a newly discovered row; resolve only ever writes config on a verified decision ---

function makeImajinModel(id: string, connector: string): ImajinRuntimeModel {
  return {
    id,
    name: `${id} (via ${connector})`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    connector,
  };
}

describe("GatewayApprovalsBridge + imajin-catalog: publish on new row, config write only on decision", () => {
  it("publishes operator.approval.requested for a newly discovered model, and only writes config.patch after a verified approve decision", async () => {
    let discovered: ImajinRuntimeModel[] = [];
    const gateway: ImajinModelPolicyGatewayClient = {
      getConfig: vi.fn().mockResolvedValue({ hash: "cfg-hash-1", allow: ["openai/*"] }),
      patchModelPolicyAllow: vi.fn().mockResolvedValue(undefined),
    };
    const source = createImajinCatalogSource({
      listDiscoveredModels: () => discovered,
      isModelAllowed: () => false,
      gateway,
    });
    const kernel = makeKernel();
    const bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: await generatePrivateKeyHex() },
      new Map<string, ApprovalSource>([["imajin-catalog", source]]),
      kernel as unknown as KernelNotifyClient,
    );

    // Nothing discovered yet — reconcile publishes nothing, and no config is
    // ever read or written just from starting the bridge.
    await bridge.reconcile();
    expect(kernel.publishApprovalRequested).not.toHaveBeenCalled();
    expect(gateway.getConfig).not.toHaveBeenCalled();

    // A new kernel brain appears (sealing a connector card on /jin).
    discovered = [makeImajinModel("grok-4", "xai")];
    await bridge.reconcile();
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
    const published = kernel.publishApprovalRequested.mock.calls[0][0];
    expect(published.source).toBe("imajin-catalog");
    expect(published.kind).toBe("imajin-catalog:new-model");
    expect(published.detail).toMatchObject({ modelId: "grok-4", ref: "imajin/grok-4" });
    expect(bridge.isPublished("imajin-catalog:grok-4")).toBe(true);

    // #36 hard requirement: no config write has happened yet — only a
    // verified `operator.approval.decided` can trigger one.
    expect(gateway.getConfig).not.toHaveBeenCalled();
    expect(gateway.patchModelPolicyAllow).not.toHaveBeenCalled();

    const stagedContentHash = lastPublishedContentHash(kernel);
    await bridge.handleKernelDecision(makeDecidedFrame("imajin-catalog:grok-4", "approve", stagedContentHash));

    expect(gateway.getConfig).toHaveBeenCalledTimes(1);
    expect(gateway.patchModelPolicyAllow).toHaveBeenCalledWith(["openai/*", "imajin/grok-4"], "cfg-hash-1");
  });

  it("never writes config for a decision from an unverified signer (not the configured operator)", async () => {
    const gateway: ImajinModelPolicyGatewayClient = {
      getConfig: vi.fn().mockResolvedValue({ hash: "cfg-hash-1", allow: [] }),
      patchModelPolicyAllow: vi.fn().mockResolvedValue(undefined),
    };
    const source = createImajinCatalogSource({
      listDiscoveredModels: () => [makeImajinModel("grok-4", "xai")],
      isModelAllowed: () => false,
      gateway,
    });
    const kernel = makeKernel();
    const bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: await generatePrivateKeyHex() },
      new Map<string, ApprovalSource>([["imajin-catalog", source]]),
      kernel as unknown as KernelNotifyClient,
    );

    await bridge.reconcile();
    const stagedContentHash = lastPublishedContentHash(kernel);

    const forgedFrame: KernelBusEventFrame = {
      type: "bus_event",
      eventType: "operator.approval.decided",
      issuer: "did:imajin:not-the-operator",
      subject: "did:imajin:not-the-operator",
      scope: "operator",
      payload: {
        proposalId: "imajin-catalog:grok-4",
        decision: "approve",
        decidedBy: "did:imajin:not-the-operator",
        contentHash: stagedContentHash,
      },
    };

    await bridge.handleKernelDecision(forgedFrame);

    expect(gateway.getConfig).not.toHaveBeenCalled();
    expect(gateway.patchModelPolicyAllow).not.toHaveBeenCalled();
  });
});

// --- gateway-exec (#38) end-to-end: resolve is only ever called after a
// verified operator.approval.decided with a matching contentHash. ---

function makeExecRecord(overrides: Partial<GatewayExecApprovalRecord> = {}): GatewayExecApprovalRecord {
  return {
    id: "exec-1",
    request: {
      command: "deploy.sh --prod && echo done",
      cwd: "/srv/app",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:1",
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 1_800_000,
    ...overrides,
  };
}

describe("GatewayApprovalsBridge + gateway-exec: verified-decision-only resolve", () => {
  it("approve resolves allow-once exactly once, with the verbatim command staged in detail", async () => {
    const listMock = vi.fn().mockResolvedValue([makeExecRecord()]);
    const client: GatewayExecApprovalsClient = {
      list: listMock,
      resolve: vi.fn().mockResolvedValue({ applied: true }),
      onRequested: vi.fn(),
      onFinished: vi.fn(),
    };
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });
    const kernel = makeKernel();
    const bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: await generatePrivateKeyHex() },
      new Map<string, ApprovalSource>([["gateway-exec", source]]),
      kernel as unknown as KernelNotifyClient,
    );

    await bridge.reconcile();
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
    const published = kernel.publishApprovalRequested.mock.calls[0][0];
    expect(published.kind).toBe("gateway-exec:command");
    expect(published.detail.command).toBe("deploy.sh --prod && echo done");
    const stagedContentHash = lastPublishedContentHash(kernel);

    await bridge.handleKernelDecision(makeDecidedFrame("exec-1", "approve", stagedContentHash));

    expect(client.resolve).toHaveBeenCalledTimes(1);
    expect(client.resolve).toHaveBeenCalledWith("exec-1", "allow-once");
    expect(client.resolve).not.toHaveBeenCalledWith("exec-1", "allow-always");
  });

  it("reject resolves deny", async () => {
    const client: GatewayExecApprovalsClient = {
      list: vi.fn().mockResolvedValue([makeExecRecord({ id: "exec-2" })]),
      resolve: vi.fn().mockResolvedValue({ applied: true }),
      onRequested: vi.fn(),
      onFinished: vi.fn(),
    };
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });
    const kernel = makeKernel();
    const bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: await generatePrivateKeyHex() },
      new Map<string, ApprovalSource>([["gateway-exec", source]]),
      kernel as unknown as KernelNotifyClient,
    );

    await bridge.reconcile();
    const stagedContentHash = lastPublishedContentHash(kernel);

    await bridge.handleKernelDecision(makeDecidedFrame("exec-2", "reject", stagedContentHash));

    expect(client.resolve).toHaveBeenCalledWith("exec-2", "deny");
  });

  it("an unrecognized wire decision (e.g. a hypothetical allow-always) is dropped before any source is touched", async () => {
    const client: GatewayExecApprovalsClient = {
      list: vi.fn().mockResolvedValue([makeExecRecord({ id: "exec-3" })]),
      resolve: vi.fn().mockResolvedValue({ applied: true }),
      onRequested: vi.fn(),
      onFinished: vi.fn(),
    };
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });
    const kernel = makeKernel();
    const bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: await generatePrivateKeyHex() },
      new Map<string, ApprovalSource>([["gateway-exec", source]]),
      kernel as unknown as KernelNotifyClient,
    );

    await bridge.reconcile();
    const stagedContentHash = lastPublishedContentHash(kernel);

    await bridge.handleKernelDecision(makeDecidedFrame("exec-3", "allow-always", stagedContentHash));

    expect(client.resolve).not.toHaveBeenCalled();
  });

  it("a decided event whose contentHash does not match the staged proposal is never resolved (check 1)", async () => {
    const client: GatewayExecApprovalsClient = {
      list: vi.fn().mockResolvedValue([makeExecRecord({ id: "exec-4" })]),
      resolve: vi.fn().mockResolvedValue({ applied: true }),
      onRequested: vi.fn(),
      onFinished: vi.fn(),
    };
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });
    const kernel = makeKernel();
    const bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: await generatePrivateKeyHex() },
      new Map<string, ApprovalSource>([["gateway-exec", source]]),
      kernel as unknown as KernelNotifyClient,
    );

    await bridge.reconcile();

    await bridge.handleKernelDecision(makeDecidedFrame("exec-4", "approve", "sha256:" + "0".repeat(64)));

    expect(client.resolve).not.toHaveBeenCalled();
    expect(kernel.publishMismatch).toHaveBeenCalledWith("exec-4", expect.stringContaining("contentHash"));
  });

  it("an expired/already-resolved approval (no longer in list()) is never resolved — idempotent no-op", async () => {
    const listMock = vi.fn();
    listMock.mockResolvedValueOnce([makeExecRecord({ id: "exec-5" })]);
    const client: GatewayExecApprovalsClient = {
      list: listMock,
      resolve: vi.fn().mockResolvedValue({ applied: true }),
      onRequested: vi.fn(),
      onFinished: vi.fn(),
    };
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });
    const kernel = makeKernel();
    const bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: await generatePrivateKeyHex() },
      new Map<string, ApprovalSource>([["gateway-exec", source]]),
      kernel as unknown as KernelNotifyClient,
    );

    await bridge.reconcile();
    const stagedContentHash = lastPublishedContentHash(kernel);

    // OpenClaw itself expired (or someone else already resolved) the approval
    // before the operator's decision arrived — it drops out of list().
    listMock.mockResolvedValue([]);

    await bridge.handleKernelDecision(makeDecidedFrame("exec-5", "approve", stagedContentHash));

    expect(client.resolve).not.toHaveBeenCalled();
  });
});
