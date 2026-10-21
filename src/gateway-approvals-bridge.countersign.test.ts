import { afterEach, describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { canonicalize } from "./approval-bridge.js";
import {
  GatewayApprovalsBridge,
  type KernelApprovalRequestedPayload,
  type KernelBusEventFrame,
} from "./gateway-approvals-bridge.js";
import type { OperatorCountersignFields } from "./operator-signature.js";
import { createSkillWorkshopSource, type SkillWorkshopProposalSummary } from "./sources/skill-workshop.js";

const OPERATOR = "did:imajin:operator";
const AGENT = "did:imajin:agent";
const bridges: GatewayApprovalsBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
});

async function fixture() {
  // Fresh, local-only keys: never fixtures copied from an operator or live API.
  const operatorPrivateKey = ed.utils.randomPrivateKey();
  const operatorPublicKey = Buffer.from(await ed.getPublicKeyAsync(operatorPrivateKey)).toString("hex");
  const proposal: SkillWorkshopProposalSummary = {
    id: "workshop-pending", kind: "update", status: "pending",
    title: "Update review skill", description: "Keep the reviewed change",
    skillName: "review", skillKey: "review", scanState: "clean", revisionHash: "native-revision",
  };
  const client = {
    list: vi.fn(async () => ({ proposals: [proposal] })),
    apply: vi.fn(async () => ({ applied: true })),
    reject: vi.fn(async () => undefined),
  };
  const source = createSkillWorkshopSource(client);
  const kernel = {
    publishApprovalRequested: vi.fn(async (_payload: KernelApprovalRequestedPayload) => undefined),
    publishMismatch: vi.fn(async () => undefined),
  };
  const bridge = new GatewayApprovalsBridge(
    {
      operatorDid: OPERATOR, agentDid: AGENT,
      agentPrivateKeyHex: Buffer.from(ed.utils.randomPrivateKey()).toString("hex"),
      requireOperatorCountersignature: true,
    },
    new Map([[source.id, source]]), kernel,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    { resolveOperatorPublicKey: vi.fn(async () => operatorPublicKey) },
  );
  bridges.push(bridge);
  await bridge.reconcile();
  expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
  const wireHash = kernel.publishApprovalRequested.mock.calls[0][0].contentHash;
  expect(wireHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  const fields: OperatorCountersignFields = {
    contentHash: wireHash.slice("sha256:".length),
    decidedAt: "2026-10-20T00:00:00.000Z",
    decision: "approve",
  };
  async function frame(
    signed: OperatorCountersignFields = fields,
    changes: Record<string, unknown> = {},
  ): Promise<KernelBusEventFrame> {
    const sig = Buffer.from(await ed.signAsync(
      new TextEncoder().encode(canonicalize(signed)), operatorPrivateKey,
    )).toString("hex");
    return {
      type: "bus_event", eventType: "operator.approval.decided",
      issuer: OPERATOR, subject: AGENT, scope: "operator",
      payload: {
        ...signed, contentHash: wireHash, proposalId: proposal.id, decidedBy: OPERATOR,
        operatorSignature: { keyId: operatorPublicKey, alg: "ed25519", sig },
        ...changes,
      },
    };
  }
  return { bridge, client, kernel, fields, frame, wireHash };
}

describe("#102 bare signed digest / prefixed wire countersignature contract", () => {
  it.each(["approve", "deny"] as const)("applies bare-signed %s to a pending workshop proposal", async (decision) => {
    const { bridge, client, fields, frame } = await fixture();
    expect(await bridge.handleKernelDecision(await frame({ ...fields, decision }))).toBe("applied");
    expect(decision === "approve" ? client.apply : client.reject)
      .toHaveBeenCalledWith("workshop-pending", "native-revision");
    expect(decision === "approve" ? client.reject : client.apply).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "once" },
    { replyMessage: "" },
    { replyMessage: "Reviewed\nwithout trimming. " },
    { mode: "once", replyMessage: "Reviewed" },
  ])("applies optional fields exactly as signed: %j", async (optional) => {
    const { bridge, client, fields, frame } = await fixture();
    expect(await bridge.handleKernelDecision(await frame({ ...fields, ...optional }))).toBe("applied");
    expect(client.apply).toHaveBeenCalledWith("workshop-pending", "native-revision");
  });

  it.each([
    ["contentHash", `sha256:${"0".repeat(64)}`],
    ["decision", "deny"],
    ["decidedAt", "2026-10-21T00:00:00.000Z"],
    ["mode", "always"],
    ["replyMessage", "Tampered"],
  ])("rejects tampered %s before resolving the source", async (field, value) => {
    const { bridge, client, fields, frame } = await fixture();
    const signed = { ...fields, mode: "once", replyMessage: "Reviewed" };
    client.list.mockClear();
    expect(await bridge.handleKernelDecision(await frame(signed, { [field]: value }))).toBe("rejected");
    // A wire-hash mismatch intentionally re-lists Workshop to restage its card.
    if (field !== "contentHash") expect(client.list).not.toHaveBeenCalled();
    expect(client.apply).not.toHaveBeenCalled();
    expect(client.reject).not.toHaveBeenCalled();
  });

  it.each(["mode", "replyMessage"] as const)("rejects added or removed %s, including empty strings", async (field) => {
    const { bridge, client, fields, frame } = await fixture();
    expect(await bridge.handleKernelDecision(await frame(fields, { [field]: "" }))).toBe("rejected");
    expect(await bridge.handleKernelDecision(await frame({ ...fields, [field]: "" }, { [field]: undefined })))
      .toBe("rejected");
    expect(client.apply).not.toHaveBeenCalled();
    expect(client.reject).not.toHaveBeenCalled();
  });

  it.each([
    ["mode", null], ["mode", 42], ["replyMessage", null], ["replyMessage", {}],
  ])("rejects malformed optional %s=%j", async (field, value) => {
    const { bridge, client, fields, frame } = await fixture();
    expect(await bridge.handleKernelDecision(await frame(fields, { [field]: value }))).toBe("rejected");
    expect(client.apply).not.toHaveBeenCalled();
    expect(client.reject).not.toHaveBeenCalled();
  });

  it("retains the exact prefixed wire echo check despite a valid bare signature", async () => {
    const { bridge, client, kernel, fields, frame } = await fixture();
    expect(await bridge.handleKernelDecision(await frame(fields, { contentHash: fields.contentHash }))).toBe("rejected");
    expect(kernel.publishMismatch).toHaveBeenCalled();
    expect(client.apply).not.toHaveBeenCalled();
  });

  it("does not accept an operator signature over a prefixed or double-prefixed digest", async () => {
    const { bridge, client, fields, frame, wireHash } = await fixture();
    for (const contentHash of [wireHash, `sha256:${wireHash}`]) {
      expect(await bridge.handleKernelDecision(await frame({ ...fields, contentHash }))).toBe("rejected");
    }
    expect(client.apply).not.toHaveBeenCalled();
    expect(client.reject).not.toHaveBeenCalled();
  });
});
