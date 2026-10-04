import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  GatewayApprovalsBridge,
  type KernelBusEventFrame,
  type KernelNotifyClient,
} from "./gateway-approvals-bridge.js";
import {
  createLiveSkillWorkshopGatewayClient,
  createSkillWorkshopSource,
  type SkillWorkshopGatewayClient,
  type SkillWorkshopProposalSummary,
} from "./sources/skill-workshop.js";
import type { ApprovalSource } from "./sources/types.js";

if ("hashes" in ed && ed.hashes) {
  (ed.hashes as { sha512?: typeof sha512 }).sha512 = sha512;
}

const OPERATOR_DID = "did:imajin:operator";
const AGENT_DID = "did:imajin:agent";

function privateKeyHex(): string {
  return Array.from(ed.utils.randomPrivateKey())
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function proposal(id: string, overrides: Partial<SkillWorkshopProposalSummary> = {}): SkillWorkshopProposalSummary {
  return {
    id,
    kind: "create",
    status: "pending",
    description: `Proposal ${id}`,
    skillName: `skill-${id}`,
    scanState: "clean",
    revisionHash: `rev-${id}`,
    ...overrides,
  };
}

function decidedFrame(proposalId: string, decision: "approve" | "reject", contentHash: string): KernelBusEventFrame {
  return {
    type: "bus_event",
    eventType: "operator.approval.decided",
    issuer: OPERATOR_DID,
    subject: OPERATOR_DID,
    scope: "operator",
    payload: { proposalId, decision, decidedBy: OPERATOR_DID, decidedAt: new Date().toISOString(), contentHash },
  };
}

/** A fake Gateway whose workshop is partitioned per agent, like the real `skills.proposals.*`. */
function makeGateway(byAgent: Record<string, SkillWorkshopProposalSummary[]>) {
  const client = {
    list: vi.fn(async (agentId?: string) => ({ proposals: byAgent[agentId ?? ""] ?? [] })),
    listAgentIds: vi.fn(async () => Object.keys(byAgent)),
    apply: vi.fn(async () => ({ applied: true })),
    reject: vi.fn(async () => undefined),
  };
  return client satisfies SkillWorkshopGatewayClient;
}

function makeKernel() {
  return {
    publishApprovalRequested: vi.fn().mockResolvedValue(undefined),
    publishMismatch: vi.fn().mockResolvedValue(undefined),
  };
}

async function makeBridge(client: SkillWorkshopGatewayClient, kernel: ReturnType<typeof makeKernel>, pollIntervalMs = 15_000) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const source = createSkillWorkshopSource(client, { pollIntervalMs });
  const bridge = new GatewayApprovalsBridge(
    { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: privateKeyHex() },
    new Map<string, ApprovalSource>([["skill-workshop", source]]),
    kernel as unknown as KernelNotifyClient,
    logger,
    undefined,
    undefined,
    // This suite exercises the SOURCE's own re-poll retry (#33); the bridge's
    // in-line transient-publish retry (#52) would sleep on the fake timers.
    { publishRetryDelaysMs: [] },
  );
  return { bridge, logger };
}

function publishedHash(kernel: ReturnType<typeof makeKernel>, proposalId: string): string {
  const call = kernel.publishApprovalRequested.mock.calls.find(([payload]) => payload.proposalId === proposalId);
  return call![0].contentHash as string;
}

describe("Skill Workshop source through the bridge (#33)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("publish: a proposal created after startup reaches the kernel within one poll interval", async () => {
    vi.useFakeTimers();
    const byAgent: Record<string, SkillWorkshopProposalSummary[]> = { main: [] };
    const gateway = makeGateway(byAgent);
    const kernel = makeKernel();
    const { bridge } = await makeBridge(gateway, kernel);
    await bridge.reconcile();
    expect(kernel.publishApprovalRequested).not.toHaveBeenCalled();

    byAgent.main.push(proposal("new-1"));
    await vi.advanceTimersByTimeAsync(15_000);
    // Signing is genuinely async (dynamic imports + crypto), so wait for the publish to land.
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1));
    const payload = kernel.publishApprovalRequested.mock.calls[0][0];
    expect(payload).toMatchObject({
      proposalId: "new-1",
      source: "skill-workshop",
      kind: "skill-workshop:create",
      signerDid: AGENT_DID,
    });
    expect(payload.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload.detail).toMatchObject({ skillName: "skill-new-1", sourceRevision: "rev-new-1" });
    bridge.dispose();
  });

  it("backfill: proposals already pending when the bridge starts are published, across every agent", async () => {
    const gateway = makeGateway({
      main: [proposal("old-1"), proposal("old-2", { status: "applied" })],
      ops: [proposal("old-3", { kind: "update" })],
    });
    const kernel = makeKernel();
    const { bridge } = await makeBridge(gateway, kernel);

    await bridge.reconcile();

    const ids = kernel.publishApprovalRequested.mock.calls.map(([payload]) => payload.proposalId).sort();
    expect(ids).toEqual(["old-1", "old-3"]);
    expect(gateway.list).toHaveBeenCalledWith("main");
    expect(gateway.list).toHaveBeenCalledWith("ops");
    bridge.dispose();
  });

  it("apply: an approved decision applies exactly the reviewed revision on the owning agent", async () => {
    const gateway = makeGateway({ main: [proposal("a-1")], ops: [proposal("b-1")] });
    const kernel = makeKernel();
    const { bridge } = await makeBridge(gateway, kernel);
    await bridge.reconcile();

    const outcome = await bridge.handleKernelDecision(decidedFrame("b-1", "approve", publishedHash(kernel, "b-1")));

    expect(outcome).toBe("applied");
    expect(gateway.apply).toHaveBeenCalledTimes(1);
    expect(gateway.apply).toHaveBeenCalledWith("b-1", "rev-b-1", "ops");
    expect(gateway.reject).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("reject: a rejected decision rejects (never applies) on the owning agent", async () => {
    const gateway = makeGateway({ main: [proposal("a-1")], ops: [proposal("b-1")] });
    const kernel = makeKernel();
    const { bridge } = await makeBridge(gateway, kernel);
    await bridge.reconcile();

    const outcome = await bridge.handleKernelDecision(decidedFrame("a-1", "reject", publishedHash(kernel, "a-1")));

    expect(outcome).toBe("applied");
    expect(gateway.reject).toHaveBeenCalledWith("a-1", "rev-a-1", "main");
    expect(gateway.apply).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("apply with a single unscoped workshop (no agent roster) omits agentId", async () => {
    const gateway = makeGateway({ "": [proposal("solo-1")] });
    gateway.listAgentIds.mockResolvedValue([]);
    const kernel = makeKernel();
    const { bridge } = await makeBridge(gateway, kernel);
    await bridge.reconcile();

    await bridge.handleKernelDecision(decidedFrame("solo-1", "approve", publishedHash(kernel, "solo-1")));

    expect(gateway.list).toHaveBeenCalledWith();
    expect(gateway.apply).toHaveBeenCalledWith("solo-1", "rev-solo-1");
    bridge.dispose();
  });

  it("failed publish: logged loudly, nothing is marked published, and the next poll retries it", async () => {
    vi.useFakeTimers();
    const gateway = makeGateway({ main: [proposal("flaky-1")] });
    const kernel = makeKernel();
    kernel.publishApprovalRequested.mockRejectedValueOnce(new Error("kernel notify failed (503): upstream down"));
    const { bridge, logger } = await makeBridge(gateway, kernel);

    await bridge.reconcile();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to publish operator.approval.requested for flaky-1"),
    );
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("503"));
    expect(bridge.isPublished("flaky-1")).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(bridge.isPublished("flaky-1")).toBe(true));
    bridge.dispose();
  });

  it("one agent's workshop failing is logged loudly and does not hide the other agents' proposals", async () => {
    const gateway = makeGateway({ main: [proposal("ok-1")], broken: [] });
    gateway.list.mockImplementation(async (agentId?: string) => {
      if (agentId === "broken") throw new Error("workspace unreadable");
      return { proposals: [proposal("ok-1")] };
    });
    const kernel = makeKernel();
    const { bridge } = await makeBridge(gateway, kernel);

    await bridge.reconcile();

    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("list failed for agent broken"));
    bridge.dispose();
  });

  it("every agent failing makes list() throw so the bridge logs the failed reconcile", async () => {
    const gateway = makeGateway({ main: [], ops: [] });
    gateway.list.mockRejectedValue(new Error("gateway down"));
    const kernel = makeKernel();
    const { bridge, logger } = await makeBridge(gateway, kernel);

    await bridge.reconcile();

    expect(kernel.publishApprovalRequested).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("skill-workshop.list() failed"));
    bridge.dispose();
  });

  it("a missing operator scope on agents.list warns once and surfaces as a list failure", async () => {
    const gateway = makeGateway({ main: [proposal("x-1")] });
    const scopeError = Object.assign(new Error("missing scope: operator.read"), {
      name: "GatewayClientRequestError",
      gatewayCode: "FORBIDDEN",
    });
    gateway.listAgentIds.mockRejectedValue(scopeError);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kernel = makeKernel();
    const { bridge, logger } = await makeBridge(gateway, kernel);

    await bridge.reconcile();
    await bridge.reconcile();

    expect(kernel.publishApprovalRequested).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("approvals.skillWorkshop.operatorScopes"));
    warnSpy.mockRestore();
    bridge.dispose();
  });

  it("falls back to the default agent when agents.list is unavailable", async () => {
    const gateway = makeGateway({ "": [proposal("fallback-1")] });
    gateway.listAgentIds.mockRejectedValue(new Error("unknown method"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kernel = makeKernel();
    const { bridge } = await makeBridge(gateway, kernel);

    await bridge.reconcile();

    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("could not enumerate agents"));
    warnSpy.mockRestore();
    bridge.dispose();
  });

  it("a failure listing OTHER agents never makes a tracked proposal look resolved at decision time", async () => {
    const gateway = makeGateway({ main: [proposal("a-1")], ops: [proposal("b-1")] });
    const kernel = makeKernel();
    const { bridge } = await makeBridge(gateway, kernel);
    await bridge.reconcile();

    gateway.list.mockImplementation(async (agentId?: string) => {
      if (agentId === "main") throw new Error("main workshop unreadable");
      return { proposals: [proposal("b-1")] };
    });

    const outcome = await bridge.handleKernelDecision(decidedFrame("b-1", "approve", publishedHash(kernel, "b-1")));

    expect(outcome).toBe("applied");
    expect(gateway.apply).toHaveBeenCalledWith("b-1", "rev-b-1", "ops");
    bridge.dispose();
  });
});

describe("createLiveSkillWorkshopGatewayClient", () => {
  it("scopes list/apply/reject by agentId and reads agent ids from agents.list", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "agents.list") return { agents: [{ id: "main" }, { id: "ops" }, { name: "no-id" }] };
      return { proposals: [] };
    });
    const live = createLiveSkillWorkshopGatewayClient({ request: request as never });

    await expect(live.listAgentIds!()).resolves.toEqual(["main", "ops"]);
    await live.list("ops");
    await live.list();
    await live.apply("p1", "rev", "ops");
    await live.reject("p2", "rev");

    expect(request).toHaveBeenCalledWith("skills.proposals.list", { agentId: "ops" });
    expect(request).toHaveBeenCalledWith("skills.proposals.list", {});
    expect(request).toHaveBeenCalledWith("skills.proposals.apply", {
      proposalId: "p1",
      expectedRevisionHash: "rev",
      agentId: "ops",
    });
    expect(request).toHaveBeenCalledWith("skills.proposals.reject", { proposalId: "p2", expectedRevisionHash: "rev" });
  });
});
