import { describe, it, expect, vi, beforeEach } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  GatewayApprovalsBridge,
  buildApprovalRequestedPayload,
  isApprovalsBridgeConfigured,
  isKernelBusEventFrame,
  signCanonicalPayload,
  type KernelBusEventFrame,
  type KernelNotifyClient,
} from "./gateway-approvals-bridge.js";
import {
  createSystemAgentSource,
  deriveProposalKind,
  type GatewayApprovalsClient,
  type GatewayApprovalSnapshot,
  type SystemAgentApprovalDecisionKind,
  type SystemAgentApprovalRequestRecord,
} from "./sources/system-agent.js";
import type { ApprovalSource } from "./sources/types.js";

if ("hashes" in ed && ed.hashes) {
  (ed.hashes as { sha512?: typeof sha512 }).sha512 = sha512;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function generateKeypairHex(): Promise<{ privateKeyHex: string; publicKeyHex: string }> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKeyHex: bytesToHex(privateKey), publicKeyHex: bytesToHex(publicKey) };
}

const OPERATOR_DID = "did:imajin:operator";
const AGENT_DID = "did:imajin:agent";

function makeRecord(overrides: Partial<SystemAgentApprovalRequestRecord> = {}): SystemAgentApprovalRequestRecord {
  return {
    id: "system-agent:abc123",
    request: {
      title: "OpenClaw change",
      description: "Restart the gateway to load the updated plugin",
      command: "gateway restart",
      proposalHash: "a".repeat(64),
      allowedDecisions: ["allow-once", "deny"],
      agentId: "main",
      sessionKey: "agent:main",
      sessionId: "sess-1",
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 600_000,
    ...overrides,
  };
}

function makeDecidedFrame(overrides: Partial<KernelBusEventFrame> = {}): KernelBusEventFrame {
  return {
    type: "bus_event",
    eventType: "operator.approval.decided",
    issuer: OPERATOR_DID,
    subject: OPERATOR_DID,
    scope: "operator",
    payload: {
      proposalId: "system-agent:abc123",
      decision: "approve",
      decidedBy: OPERATOR_DID,
      decidedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

describe("deriveProposalKind", () => {
  it("detects restart", () => {
    expect(deriveProposalKind({ title: "x", description: "Restart the gateway", command: "" })).toBe("restart");
  });
  it("detects config-mutation", () => {
    expect(deriveProposalKind({ title: "x", description: "Set config.foo to bar", command: "" })).toBe(
      "config-mutation",
    );
  });
  it("falls back to other", () => {
    expect(deriveProposalKind({ title: "x", description: "Do something unrelated", command: "" })).toBe("other");
  });
});

describe("buildApprovalRequestedPayload", () => {
  it("signs exactly the five canonical fields and never includes keysTouched entries", async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeypairHex();
    const record = makeRecord();
    const request = {
      proposalId: record.id,
      kind: `system-agent:${deriveProposalKind(record.request)}`,
      summary: record.request.description,
      contentHash: record.request.proposalHash,
    };
    const payload = await buildApprovalRequestedPayload("system-agent", request, { did: AGENT_DID, privateKeyHex });

    expect(payload.proposalId).toBe(record.id);
    expect(payload.source).toBe("system-agent");
    expect(payload.contentHash).toBe(record.request.proposalHash);
    expect(payload.keysTouched).toEqual([]);
    expect(payload.signerDid).toBe(AGENT_DID);

    const verified = await ed.verifyAsync(
      Uint8Array.from(Buffer.from(payload.signature, "hex")),
      new TextEncoder().encode(
        await (async () => {
          const { canonicalize } = await import("./approval-bridge.js");
          return canonicalize({
            proposalId: payload.proposalId,
            kind: payload.kind,
            summary: payload.summary,
            keysTouched: payload.keysTouched,
            contentHash: payload.contentHash,
          });
        })(),
      ),
      Uint8Array.from(Buffer.from(publicKeyHex, "hex")),
    );
    expect(verified).toBe(true);
  });
});

describe("isApprovalsBridgeConfigured", () => {
  it("is false when disabled or missing required fields", () => {
    expect(isApprovalsBridgeConfigured(undefined, AGENT_DID)).toBe(false);
    expect(isApprovalsBridgeConfigured({ enabled: false, operatorDid: OPERATOR_DID }, AGENT_DID)).toBe(false);
    expect(isApprovalsBridgeConfigured({ enabled: true }, AGENT_DID)).toBe(false);
    expect(isApprovalsBridgeConfigured({ enabled: true, operatorDid: OPERATOR_DID }, undefined)).toBe(false);
  });
  it("is true only when enabled with operatorDid and an agent did", () => {
    expect(isApprovalsBridgeConfigured({ enabled: true, operatorDid: OPERATOR_DID }, AGENT_DID)).toBe(true);
  });
});

describe("isKernelBusEventFrame", () => {
  it("accepts a well-formed frame and rejects unrelated shapes", () => {
    expect(isKernelBusEventFrame(makeDecidedFrame())).toBe(true);
    expect(isKernelBusEventFrame({ type: "notification" })).toBe(false);
    expect(isKernelBusEventFrame(null)).toBe(false);
  });
});

describe("GatewayApprovalsBridge", () => {
  let agentPrivateKeyHex: string;
  let gateway: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    resolve: ReturnType<typeof vi.fn>;
    onRequested: ReturnType<typeof vi.fn>;
  };
  let kernel: { publishApprovalRequested: ReturnType<typeof vi.fn>; publishMismatch: ReturnType<typeof vi.fn> };
  let requestedHandler: ((record: SystemAgentApprovalRequestRecord) => void) | undefined;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    agentPrivateKeyHex = (await generateKeypairHex()).privateKeyHex;
    requestedHandler = undefined;
    gateway = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      resolve: vi.fn().mockResolvedValue({ applied: true }),
      onRequested: vi.fn((handler: (record: SystemAgentApprovalRequestRecord) => void) => {
        requestedHandler = handler;
      }),
    };
    kernel = {
      publishApprovalRequested: vi.fn().mockResolvedValue(undefined),
      publishMismatch: vi.fn().mockResolvedValue(undefined),
    };
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  function newBridge(): GatewayApprovalsBridge {
    const source = createSystemAgentSource(gateway as unknown as GatewayApprovalsClient);
    return new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex },
      new Map<string, ApprovalSource>([["system-agent", source]]),
      kernel as unknown as KernelNotifyClient,
      logger,
    );
  }

  function pendingSnapshot(proposalHash: string): GatewayApprovalSnapshot {
    return { status: "pending", presentation: { proposalHash } };
  }

  it("publishes a signed operator.approval.requested on a live openclaw.approval.requested event", async () => {
    const bridge = newBridge();
    const record = makeRecord();
    requestedHandler!(record);
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1));
    const published = kernel.publishApprovalRequested.mock.calls[0][0];
    expect(published.proposalId).toBe(record.id);
    expect(published.contentHash).toBe(record.request.proposalHash);
    expect(bridge.isPublished(record.id)).toBe(true);
  });

  it("dedups by proposalId — a duplicate live event never republishes", async () => {
    newBridge();
    const record = makeRecord();
    requestedHandler!(record);
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1));
    requestedHandler!(record);
    // Give the (synchronous) dedup check a tick to prove no second call happens.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
  });

  it("startup reconcile publishes only proposals not already published", async () => {
    const bridge = newBridge();
    const already = makeRecord({ id: "system-agent:already" });
    const fresh = makeRecord({ id: "system-agent:fresh" });
    requestedHandler!(already);
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1));

    gateway.list.mockResolvedValue([already, fresh]);
    await bridge.reconcile();

    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(2);
    const publishedIds = kernel.publishApprovalRequested.mock.calls.map((call) => call[0].proposalId);
    expect(publishedIds).toEqual(["system-agent:already", "system-agent:fresh"]);
  });

  it("rejects a decision from a non-operator signer without ever calling the Gateway", async () => {
    const bridge = newBridge();
    requestedHandler!(makeRecord());
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1));

    const frame = makeDecidedFrame({
      issuer: "did:imajin:attacker",
      subject: "did:imajin:attacker",
      payload: {
        proposalId: "system-agent:abc123",
        decision: "approve",
        decidedBy: "did:imajin:attacker",
        decidedAt: new Date().toISOString(),
      },
    });
    await bridge.handleKernelDecision(frame);

    expect(gateway.get).not.toHaveBeenCalled();
    expect(gateway.resolve).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("signer is not the configured operator"));
  });

  it("hash mismatch: does not resolve and publishes a mismatch event", async () => {
    const bridge = newBridge();
    const record = makeRecord();
    requestedHandler!(record);
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1));

    gateway.get.mockResolvedValue(pendingSnapshot("b".repeat(64))); // different from record.request.proposalHash
    await bridge.handleKernelDecision(makeDecidedFrame());

    expect(gateway.resolve).not.toHaveBeenCalled();
    expect(kernel.publishMismatch).toHaveBeenCalledWith(
      "system-agent:abc123",
      expect.stringContaining("no longer matches"),
    );
  });

  it("unknown proposal id is a no-op", async () => {
    const bridge = newBridge();
    await bridge.handleKernelDecision(
      makeDecidedFrame({
        payload: {
          proposalId: "system-agent:never-published",
          decision: "approve",
          decidedBy: OPERATOR_DID,
          decidedAt: new Date().toISOString(),
        },
      }),
    );
    expect(gateway.get).not.toHaveBeenCalled();
    expect(gateway.resolve).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("not tracked by this bridge"));
  });

  it("expired/no-longer-pending proposal is a no-op", async () => {
    const bridge = newBridge();
    requestedHandler!(makeRecord());
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1));

    gateway.get.mockResolvedValue({ status: "expired" } satisfies GatewayApprovalSnapshot);
    await bridge.handleKernelDecision(makeDecidedFrame());

    expect(gateway.resolve).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("no longer pending"));
    expect(bridge.isPublished("system-agent:abc123")).toBe(false);
  });

  it("happy path: approve maps to allow-once", async () => {
    const bridge = newBridge();
    const record = makeRecord();
    requestedHandler!(record);
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1));

    gateway.get.mockResolvedValue(pendingSnapshot(record.request.proposalHash));
    await bridge.handleKernelDecision(makeDecidedFrame());

    expect(gateway.resolve).toHaveBeenCalledWith("system-agent:abc123", "allow-once");
    expect(bridge.isPublished("system-agent:abc123")).toBe(false);
  });

  it("happy path: deny maps to deny", async () => {
    const bridge = newBridge();
    const record = makeRecord({ id: "system-agent:deny-me" });
    requestedHandler!(record);
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1));

    gateway.get.mockResolvedValue(pendingSnapshot(record.request.proposalHash));
    await bridge.handleKernelDecision(
      makeDecidedFrame({
        payload: {
          proposalId: "system-agent:deny-me",
          decision: "deny",
          decidedBy: OPERATOR_DID,
          decidedAt: new Date().toISOString(),
        },
      }),
    );

    expect(gateway.resolve).toHaveBeenCalledWith("system-agent:deny-me", "deny");
  });

  it("swallows a resolve error (Gateway conflict) without throwing", async () => {
    const bridge = newBridge();
    const record = makeRecord();
    requestedHandler!(record);
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1));

    gateway.get.mockResolvedValue(pendingSnapshot(record.request.proposalHash));
    gateway.resolve.mockRejectedValue(new Error("approval already resolved"));

    await expect(bridge.handleKernelDecision(makeDecidedFrame())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("approval.resolve failed"));
  });

  it("ignores events other than operator.approval.decided", async () => {
    const bridge = newBridge();
    await bridge.handleKernelDecision(makeDecidedFrame({ eventType: "operator.approval.requested" }));
    expect(gateway.get).not.toHaveBeenCalled();
  });

  it("treats withdrawn as a no-op (no Gateway analog)", async () => {
    const bridge = newBridge();
    requestedHandler!(makeRecord());
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1));

    await bridge.handleKernelDecision(
      makeDecidedFrame({
        payload: {
          proposalId: "system-agent:abc123",
          decision: "withdrawn",
          decidedBy: OPERATOR_DID,
          decidedAt: new Date().toISOString(),
        },
      }),
    );
    expect(gateway.get).not.toHaveBeenCalled();
    expect(gateway.resolve).not.toHaveBeenCalled();
  });
});

describe("signCanonicalPayload", () => {
  it("produces a signature verifiable against the matching public key", async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeypairHex();
    const sig = await signCanonicalPayload({ b: 1, a: 2 }, privateKeyHex);
    const decisionKinds: SystemAgentApprovalDecisionKind[] = ["allow-once", "deny"];
    expect(decisionKinds).toContain("allow-once");
    const verified = await ed.verifyAsync(
      Uint8Array.from(Buffer.from(sig, "hex")),
      new TextEncoder().encode('{"a":2,"b":1}'),
      Uint8Array.from(Buffer.from(publicKeyHex, "hex")),
    );
    expect(verified).toBe(true);
  });
});
