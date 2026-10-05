import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  GatewayApprovalsBridge,
  KernelNotifyError,
  type KernelBusEventFrame,
  type KernelNotifyClient,
} from "./gateway-approvals-bridge.js";
import { createApprovalLoopBlocker } from "./approval-loop-blocker.js";
import {
  createSystemAgentSource,
  type GatewayApprovalsClient,
  type SystemAgentApprovalRequestRecord,
} from "./sources/system-agent.js";
import {
  createGatewayExecSource,
  type GatewayExecApprovalRecord,
  type GatewayExecApprovalsClient,
} from "./sources/gateway-exec.js";
import type { ApprovalSource } from "./sources/types.js";

if ("hashes" in ed && ed.hashes) {
  (ed.hashes as { sha512?: typeof sha512 }).sha512 = sha512;
}

const OPERATOR_DID = "did:imajin:operator";
const AGENT_DID = "did:imajin:agent";
const SESSION = "agent:main:main";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function record(overrides: Partial<SystemAgentApprovalRequestRecord> = {}): SystemAgentApprovalRequestRecord {
  return {
    id: "system-agent:abc123",
    request: {
      title: "OpenClaw change",
      description: "Restart the gateway",
      command: "gateway restart",
      proposalHash: "a".repeat(64),
      allowedDecisions: ["allow-once", "deny"],
      agentId: "main",
      sessionKey: SESSION,
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 600_000,
    ...overrides,
  };
}

describe("GatewayApprovalsBridge → loop block/unblock (#64)", () => {
  let keyHex: string;
  let gateway: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    resolve: ReturnType<typeof vi.fn>;
    onRequested: ReturnType<typeof vi.fn>;
  };
  let kernel: { publishApprovalRequested: ReturnType<typeof vi.fn>; publishMismatch: ReturnType<typeof vi.fn> };
  let requested: ((r: SystemAgentApprovalRequestRecord) => void) | undefined;
  let tracker: { block: ReturnType<typeof vi.fn>; unblock: ReturnType<typeof vi.fn> };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    keyHex = hex(ed.utils.randomPrivateKey());
    requested = undefined;
    gateway = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      resolve: vi.fn().mockResolvedValue({ applied: true }),
      onRequested: vi.fn((h: (r: SystemAgentApprovalRequestRecord) => void) => {
        requested = h;
      }),
    };
    kernel = {
      publishApprovalRequested: vi.fn().mockResolvedValue(undefined),
      publishMismatch: vi.fn().mockResolvedValue(undefined),
    };
    tracker = { block: vi.fn(), unblock: vi.fn() };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function newBridge(): GatewayApprovalsBridge {
    return new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: keyHex },
      new Map<string, ApprovalSource>([
        ["system-agent", createSystemAgentSource(gateway as unknown as GatewayApprovalsClient)],
      ]),
      kernel as unknown as KernelNotifyClient,
      logger,
      undefined,
      undefined,
      { publishRetryDelaysMs: [], loopTracker: tracker },
    );
  }

  function decided(id: string, contentHash: string, decision = "approve"): KernelBusEventFrame {
    return {
      type: "bus_event",
      eventType: "operator.approval.decided",
      issuer: OPERATOR_DID,
      subject: OPERATOR_DID,
      scope: "operator",
      payload: { proposalId: id, decision, decidedBy: OPERATOR_DID, decidedAt: new Date().toISOString(), contentHash },
    };
  }

  const lastHash = (): string =>
    kernel.publishApprovalRequested.mock.calls[kernel.publishApprovalRequested.mock.calls.length - 1][0].contentHash;

  it("blocks the owning session once the card is published, and unblocks when the decision is applied", async () => {
    const bridge = newBridge();
    const rec = record();
    requested!(rec);
    await vi.waitFor(() => expect(tracker.block).toHaveBeenCalledTimes(1));
    expect(tracker.block).toHaveBeenCalledWith(
      { sessionKey: SESSION },
      "awaiting operator approval (system-agent:restart)",
    );
    expect(tracker.unblock).not.toHaveBeenCalled();

    gateway.get.mockResolvedValue({ status: "pending", presentation: { proposalHash: rec.request.proposalHash } });
    expect(await bridge.handleKernelDecision(decided(rec.id, lastHash()))).toBe("applied");
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
    expect(tracker.unblock).toHaveBeenCalledWith({ sessionKey: SESSION });
  });

  it("does not put the proposed command in the block reason", async () => {
    newBridge();
    requested!(record({ request: { ...record().request, description: "rm -rf /secret", command: "rm -rf /secret" } }));
    await vi.waitFor(() => expect(tracker.block).toHaveBeenCalledTimes(1));
    expect(String(tracker.block.mock.calls[0][1])).not.toContain("secret");
  });

  it("does not block when the card fails to publish", async () => {
    newBridge();
    kernel.publishApprovalRequested.mockRejectedValueOnce(new KernelNotifyError(400, "rejected"));
    requested!(record());
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(tracker.block).not.toHaveBeenCalled();
  });

  it("does not block a request with no known session", async () => {
    newBridge();
    requested!(record({ request: { ...record().request, sessionKey: null } }));
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(tracker.block).not.toHaveBeenCalled();
  });

  it("unblocks when the item is no longer pending at the source", async () => {
    const bridge = newBridge();
    const rec = record();
    requested!(rec);
    await vi.waitFor(() => expect(tracker.block).toHaveBeenCalledTimes(1));
    gateway.get.mockResolvedValue({ status: "allowed", presentation: {} });
    expect(await bridge.handleKernelDecision(decided(rec.id, lastHash()))).toBe("noop");
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
  });

  it("stays blocked on a rejected (unverifiable) decision", async () => {
    const bridge = newBridge();
    const rec = record();
    requested!(rec);
    await vi.waitFor(() => expect(tracker.block).toHaveBeenCalledTimes(1));
    await bridge.handleKernelDecision(decided(rec.id, "sha256:wrong"));
    expect(tracker.unblock).not.toHaveBeenCalled();
  });

  it("unblocks when the approval expires without a decision", async () => {
    newBridge();
    requested!(record({ expiresAtMs: Date.now() + 40 }));
    await vi.waitFor(() => expect(tracker.block).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(tracker.unblock).toHaveBeenCalledTimes(1));
    expect(tracker.unblock).toHaveBeenCalledWith({ sessionKey: SESSION });
  });

  it("a throwing tracker never affects publishing or applying the decision", async () => {
    tracker.block.mockImplementation(() => {
      throw new Error("boom");
    });
    tracker.unblock.mockImplementation(() => {
      throw new Error("boom");
    });
    const bridge = newBridge();
    const rec = record();
    requested!(rec);
    await vi.waitFor(() => expect(tracker.block).toHaveBeenCalledTimes(1));
    expect(bridge.isPublished(rec.id)).toBe(true);
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);

    gateway.get.mockResolvedValue({ status: "pending", presentation: { proposalHash: rec.request.proposalHash } });
    expect(await bridge.handleKernelDecision(decided(rec.id, lastHash()))).toBe("applied");
    expect(gateway.resolve).toHaveBeenCalledTimes(1);
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
  });

  it("works unchanged without a loop tracker", async () => {
    const bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: keyHex },
      new Map<string, ApprovalSource>([
        ["system-agent", createSystemAgentSource(gateway as unknown as GatewayApprovalsClient)],
      ]),
      kernel as unknown as KernelNotifyClient,
      logger,
    );
    const rec = record();
    requested!(rec);
    await vi.waitFor(() => expect(bridge.isPublished(rec.id)).toBe(true));
  });
});

describe("approval sources expose the owning session (#64)", () => {
  it("system-agent carries sessionKey + expiry, outside detail", async () => {
    const rec = record();
    const source = createSystemAgentSource({
      list: async () => [rec],
    } as unknown as GatewayApprovalsClient);
    const [req] = await source.list();
    expect(req.owner).toEqual({ sessionKey: SESSION });
    expect(req.expiresAtMs).toBe(rec.expiresAtMs);
    expect(req.detail).toBeUndefined();
  });

  it("gateway-exec carries the raw sessionKey, never the 'unspecified' placeholder", async () => {
    const mk = (sessionKey: string | null): GatewayExecApprovalRecord => ({
      id: `exec:${String(sessionKey)}`,
      request: { command: "ls", sessionKey },
      createdAtMs: 1,
      expiresAtMs: 2,
    });
    const source = createGatewayExecSource(
      { list: async () => [mk(SESSION), mk(null)] } as unknown as GatewayExecApprovalsClient,
      { agentDid: AGENT_DID },
    );
    const [withKey, without] = await source.list();
    expect(withKey.owner).toEqual({ sessionKey: SESSION });
    expect(withKey.expiresAtMs).toBe(2);
    expect(without.owner).toBeUndefined();
  });
});

describe("createApprovalLoopBlocker", () => {
  it("blocks once and unblocks only when the last pending approval for a session is released", () => {
    const tracker = { block: vi.fn(), unblock: vi.fn() };
    const blocker = createApprovalLoopBlocker(tracker);
    const owner = { sessionKey: SESSION };
    blocker.block("a", owner, "r");
    blocker.block("b", owner, "r");
    blocker.block("a", owner, "r"); // idempotent per proposal
    expect(tracker.block).toHaveBeenCalledTimes(1);
    blocker.release("a");
    expect(tracker.unblock).not.toHaveBeenCalled();
    blocker.release("b");
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
    blocker.release("b"); // already released
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
    expect(blocker.pendingCount()).toBe(0);
  });

  it("ignores a missing owner and supports cron jobs", () => {
    const tracker = { block: vi.fn(), unblock: vi.fn() };
    const blocker = createApprovalLoopBlocker(tracker);
    blocker.block("a", undefined, "r");
    blocker.block("b", {}, "r");
    expect(tracker.block).not.toHaveBeenCalled();
    blocker.block("c", { jobId: "job-1" }, "r");
    expect(tracker.block).toHaveBeenCalledWith({ jobId: "job-1" }, "r");
  });

  it("dispose cancels expiry timers", () => {
    vi.useFakeTimers();
    const tracker = { block: vi.fn(), unblock: vi.fn() };
    const blocker = createApprovalLoopBlocker(tracker);
    blocker.block("a", { sessionKey: SESSION }, "r", Date.now() + 1000);
    blocker.dispose();
    vi.advanceTimersByTime(5000);
    expect(tracker.unblock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
