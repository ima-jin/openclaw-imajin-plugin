import { afterEach, describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { canonicalize } from "./approval-bridge.js";
import {
  GatewayApprovalsBridge,
  type KernelApprovalRequestedPayload,
  type KernelBusEventFrame,
} from "./gateway-approvals-bridge.js";
import { createSystemAgentSource, type SystemAgentApprovalRequestRecord } from "./sources/system-agent.js";
import { createGatewayExecSource } from "./sources/gateway-exec.js";
import { createSkillWorkshopSource, type SkillWorkshopProposalSummary } from "./sources/skill-workshop.js";
import type { ApprovalSource } from "./sources/types.js";

const OPERATOR = "did:imajin:operator";
const AGENT = "did:imajin:agent";
const SESSION = "agent:main:main";
const bridges: GatewayApprovalsBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
});

async function fixture(
  sourceId: "system-agent" | "gateway-exec" | "skill-workshop" = "system-agent",
  supportsWithdrawal = true,
) {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = Buffer.from(await ed.getPublicKeyAsync(privateKey)).toString("hex");
  const records: (SystemAgentApprovalRequestRecord & { status: string })[] = [];
  // Model the Gateway's proposal-hash pending-slot reuse without discarding history.
  function request() {
    const existing = records.find((record) => record.status === "pending");
    if (existing) return existing;
    const record = {
      id: `${sourceId}:${records.length + 1}`,
      status: "pending",
      request: {
        title: "Gateway change", description: "Restart the gateway", command: "gateway restart",
        proposalHash: "a".repeat(64), allowedDecisions: ["allow-once", "deny"] as const,
        sessionKey: SESSION,
      },
      createdAtMs: Date.now(), expiresAtMs: Date.now() + 600_000,
    };
    records.push(record);
    return record;
  }
  const record = request();
  const resolve = vi.fn(async (id: string, decision: string) => {
    records.find((entry) => entry.id === id)!.status = decision === "deny" ? "denied" : "allowed";
    return { applied: true };
  });
  const systemClient = {
    list: vi.fn(async () => records.filter((entry) => entry.status === "pending")),
    get: vi.fn(async (id: string) => {
      const current = records.find((entry) => entry.id === id);
      return current ? {
        status: current.status as "pending" | "denied" | "allowed",
        expiresAtMs: current.expiresAtMs,
        presentation: { proposalHash: current.request.proposalHash },
      } : null;
    }),
    resolve,
    onRequested: vi.fn(),
  };
  const proposal: SkillWorkshopProposalSummary = {
    id: record.id, kind: "update", status: "pending", description: "Update review skill",
    skillName: "review", scanState: "clean", revisionHash: "revision-1",
  };
  const workshop = {
    list: vi.fn(async () => ({ proposals: [proposal] })),
    apply: vi.fn(async () => ({ applied: true })),
    reject: vi.fn(async () => { proposal.status = "rejected"; }),
  };
  let source: ApprovalSource;
  if (sourceId === "skill-workshop") {
    source = createSkillWorkshopSource(workshop);
  } else if (sourceId === "gateway-exec") {
    source = createGatewayExecSource({
      list: systemClient.list, resolve, onRequested: vi.fn(), onFinished: vi.fn(),
    }, { agentDid: AGENT });
  } else {
    source = createSystemAgentSource(systemClient);
  }
  const adapter = supportsWithdrawal ? source : { ...source, withdrawalDecision: undefined };
  const getCurrent = vi.spyOn(adapter, "getCurrent");
  const sourceResolve = vi.spyOn(adapter, "resolve");
  const tracker = { block: vi.fn(), unblock: vi.fn() };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const kernel = {
    publishApprovalRequested: vi.fn(async (_payload: KernelApprovalRequestedPayload) => undefined),
    publishMismatch: vi.fn(async () => undefined),
  };
  const bridge = new GatewayApprovalsBridge({
    operatorDid: OPERATOR, agentDid: AGENT,
    agentPrivateKeyHex: Buffer.from(ed.utils.randomPrivateKey()).toString("hex"),
    requireOperatorCountersignature: true,
  }, new Map([[adapter.id, adapter]]), kernel, logger,
  { resolveOperatorPublicKey: async () => publicKey }, undefined,
  { loopTracker: tracker, loopBlockSweepIntervalMs: 0 });
  bridges.push(bridge);
  await bridge.reconcile();
  const contentHash = kernel.publishApprovalRequested.mock.calls[0][0].contentHash;
  async function frame(decision = "withdrawn"): Promise<KernelBusEventFrame> {
    const fields = {
      contentHash: contentHash.slice("sha256:".length), decision,
      decidedAt: new Date().toISOString(),
    };
    const sig = Buffer.from(await ed.signAsync(
      new TextEncoder().encode(canonicalize(fields)), privateKey,
    )).toString("hex");
    return {
      type: "bus_event", eventType: "operator.approval.decided",
      issuer: OPERATOR, subject: AGENT, scope: "operator",
      payload: {
        ...fields, contentHash, proposalId: record.id, decidedBy: OPERATOR,
        operatorSignature: { keyId: publicKey, alg: "ed25519", sig },
      },
    };
  }
  return {
    bridge, record, request, records, resolve, workshop, getCurrent, sourceResolve,
    tracker, logger, kernel, frame,
  };
}

describe("verified withdrawal resolves the pending source slot (#87)", () => {
  it.each(["system-agent", "gateway-exec"] as const)("denies %s once, forgets it and unblocks its loop", async (sourceId) => {
    const { bridge, record, resolve, tracker, frame } = await fixture(sourceId);
    expect(tracker.block).toHaveBeenCalledTimes(1);
    const decision = await frame();
    expect(await Promise.all([
      bridge.handleKernelDecision(decision), bridge.handleKernelDecision(decision),
    ])).toEqual(["applied", "applied"]);
    expect(await bridge.handleKernelDecision(decision)).toBe("noop");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(record.id, "deny");
    expect(bridge.isPublished(record.id)).toBe(false);
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
    expect(tracker.unblock).toHaveBeenCalledWith({ sessionKey: SESSION });
  });

  it("frees the same-hash pending slot so the next agent request gets a new proposalId", async () => {
    const { bridge, record, request, records, tracker, kernel, frame } = await fixture();
    expect(request().id).toBe(record.id);
    expect(await bridge.handleKernelDecision(await frame())).toBe("applied");
    const next = request();
    expect(next.request.proposalHash).toBe(record.request.proposalHash);
    expect(next.id).not.toBe(record.id);
    expect(records.map((entry) => entry.status)).toEqual(["denied", "pending"]);
    await bridge.reconcile();
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(2);
    expect(bridge.isPublished(next.id)).toBe(true);
    expect(bridge.isPublished(record.id)).toBe(false);
    expect(tracker.block).toHaveBeenCalledTimes(2);
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
  });

  it("rejects Skill Workshop with its original revision pin, never applies", async () => {
    const { bridge, record, workshop, frame } = await fixture("skill-workshop");
    expect(await bridge.handleKernelDecision(await frame())).toBe("applied");
    expect(workshop.reject).toHaveBeenCalledTimes(1);
    expect(workshop.reject).toHaveBeenCalledWith(record.id, "revision-1");
    expect(workshop.apply).not.toHaveBeenCalled();
    expect(bridge.isPublished(record.id)).toBe(false);
  });

  it("keeps a logged no-op for a source without a cancel analog", async () => {
    const { bridge, record, getCurrent, sourceResolve, tracker, logger, frame } = await fixture("system-agent", false);
    expect(await bridge.handleKernelDecision(await frame())).toBe("noop");
    expect(getCurrent).not.toHaveBeenCalled();
    expect(sourceResolve).not.toHaveBeenCalled();
    expect(bridge.isPublished(record.id)).toBe(true);
    expect(tracker.unblock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("source has no cancel analog"));
  });

  it.each([
    { field: "issuer", value: "did:imajin:other" },
    { field: "subject", value: "did:imajin:other" },
    { field: "decidedBy", value: "did:imajin:other" },
    { field: "contentHash", value: "sha256:mismatched" },
    { field: "operatorSignature", value: undefined },
    { field: "decision", value: "unknown" },
  ] as const)(
    "rejects an invalid withdrawal $field before any source read or resolve", async ({ field, value }) => {
      const { bridge, record, getCurrent, sourceResolve, tracker, frame } = await fixture();
      const decision = await frame();
      if (field === "issuer" || field === "subject") decision[field] = value;
      else decision.payload = { ...decision.payload, [field]: value };
      expect(await bridge.handleKernelDecision(decision)).toBe("rejected");
      expect(getCurrent).not.toHaveBeenCalled();
      expect(sourceResolve).not.toHaveBeenCalled();
      expect(bridge.isPublished(record.id)).toBe(true);
      expect(tracker.unblock).not.toHaveBeenCalled();
    },
  );

  it("verifies the signed raw withdrawn value, not the mapped reject action", async () => {
    const { bridge, getCurrent, sourceResolve, frame } = await fixture();
    const decision = await frame("reject");
    decision.payload = { ...decision.payload, decision: "withdrawn" };
    expect(await bridge.handleKernelDecision(decision)).toBe("rejected");
    expect(getCurrent).not.toHaveBeenCalled();
    expect(sourceResolve).not.toHaveBeenCalled();
  });

  it("does not deny a proposal whose current source revision has drifted", async () => {
    const { bridge, record, sourceResolve, tracker, frame } = await fixture();
    const decision = await frame();
    record.request.proposalHash = "b".repeat(64);
    expect(await bridge.handleKernelDecision(decision)).toBe("rejected");
    expect(sourceResolve).not.toHaveBeenCalled();
    expect(bridge.isPublished(record.id)).toBe(true);
    expect(tracker.unblock).not.toHaveBeenCalled();
  });
});
