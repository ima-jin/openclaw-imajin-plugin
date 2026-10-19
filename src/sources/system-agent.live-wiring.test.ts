import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  GatewayApprovalsBridge,
  type KernelBusEventFrame,
} from "../gateway-approvals-bridge.js";
import {
  createLiveGatewayApprovalsClient,
  createSystemAgentSource,
  type SystemAgentApprovalRequestRecord,
} from "./system-agent.js";

const createGatewayClient = vi.hoisted(() => vi.fn());
const startGatewayClient = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  createOperatorApprovalsGatewayClient: createGatewayClient,
  startGatewayClientWhenEventLoopReady: startGatewayClient,
}));

if ("hashes" in ed && ed.hashes) {
  (ed.hashes as { sha512?: typeof sha512 }).sha512 = sha512;
}

const OPERATOR_DID = "did:imajin:operator";
const AGENT_DID = "did:imajin:agent";
const SESSION = "agent:main:main";
const SWEEP_MS = 1000;

function record(id = "system-agent:pending"): SystemAgentApprovalRequestRecord {
  return {
    id,
    request: {
      title: "OpenClaw change",
      description: "Restart the gateway",
      command: "gateway restart",
      proposalHash: "a".repeat(64),
      allowedDecisions: ["allow-once", "deny"],
      sessionKey: SESSION,
    },
    createdAtMs: Date.now(),
    // No expiry timer: only a decision or a source read can release the block.
    expiresAtMs: undefined as unknown as number,
  };
}

describe("system-agent with a runtime-only Gateway client (#88)", () => {
  const gateway = {
    list: vi.fn(),
    get: vi.fn(),
    resolve: vi.fn(),
    request: vi.fn(),
    stop: vi.fn(),
  };
  const kernel = {
    publishApprovalRequested: vi.fn(),
    publishMismatch: vi.fn(),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const tracker = { block: vi.fn(), unblock: vi.fn() };
  let bridge: GatewayApprovalsBridge;
  let source: ReturnType<typeof createSystemAgentSource>;
  let live: Awaited<ReturnType<typeof createLiveGatewayApprovalsClient>>;
  let pending: SystemAgentApprovalRequestRecord;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    pending = record();
    // Match the Gateway's no-device-id visibility split: get cannot see the
    // live approval, while the runtime list and resolve RPCs can.
    gateway.get.mockRejectedValue(new Error("approval not found"));
    gateway.list.mockResolvedValue([record("system-agent:unrelated"), pending]);
    gateway.resolve.mockResolvedValue({ applied: true });
    gateway.request.mockImplementation(async (method: string, params: unknown) => {
      switch (method) {
        case "approval.get":
          return gateway.get(params);
        case "openclaw.approval.list":
          return gateway.list(params);
        case "approval.resolve":
          return gateway.resolve(params);
        default:
          throw new Error(`unexpected Gateway RPC: ${method}`);
      }
    });
    createGatewayClient.mockResolvedValue(gateway);
    startGatewayClient.mockResolvedValue({ ready: true });
    kernel.publishApprovalRequested.mockResolvedValue(undefined);
    kernel.publishMismatch.mockResolvedValue(undefined);
    live = await createLiveGatewayApprovalsClient({}, { clientDisplayName: "system-agent test" });
    source = createSystemAgentSource(live.client);
    bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: "01".repeat(32) },
      new Map([["system-agent", source]]),
      kernel,
      logger,
      undefined,
      undefined,
      { loopTracker: tracker, loopBlockSweepIntervalMs: SWEEP_MS, publishRetryDelaysMs: [] },
    );
    await bridge.reconcile();
  });

  afterEach(() => {
    bridge.dispose();
    live.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  function decided(): KernelBusEventFrame {
    const payload = kernel.publishApprovalRequested.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.proposalId === pending.id);
    return {
      type: "bus_event",
      eventType: "operator.approval.decided",
      issuer: OPERATOR_DID,
      subject: AGENT_DID,
      scope: "operator",
      payload: {
        proposalId: pending.id,
        decision: "approve",
        decidedBy: OPERATOR_DID,
        decidedAt: new Date().toISOString(),
        contentHash: payload.contentHash,
      },
    };
  }

  it("applies one approve exactly once without deferring or needing approval.get/device auth", async () => {
    await expect(gateway.request("approval.get", { id: pending.id })).rejects.toThrow("approval not found");
    gateway.get.mockClear();

    await expect(bridge.handleKernelDecision(decided())).resolves.toBe("applied");
    await expect(bridge.handleKernelDecision(decided())).resolves.toBe("noop");
    expect(gateway.resolve).toHaveBeenCalledTimes(1);
    expect(gateway.resolve).toHaveBeenCalledWith({
      id: pending.id,
      kind: "system-agent",
      decision: "allow-once",
    });
    expect(gateway.get).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(bridge.isPublished(pending.id)).toBe(false);
    // No config, scopes, or device identity overrides are required.
    expect(createGatewayClient).toHaveBeenCalledTimes(1);
    expect(createGatewayClient).toHaveBeenCalledWith(expect.objectContaining({ config: {} }));
  });

  it("keeps live proposals blocked across repeated sweeps without approval-not-found warnings", async () => {
    await vi.advanceTimersByTimeAsync(SWEEP_MS * 3);

    expect(gateway.list).toHaveBeenCalledTimes(7); // reconcile + two held proposals per sweep
    expect(gateway.get).not.toHaveBeenCalled();
    expect(tracker.unblock).not.toHaveBeenCalled();
    expect(bridge.isPublished(pending.id)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("reads the current hash from the matching live record, not the first or cached record", async () => {
    const changed = { ...pending, request: { ...pending.request, proposalHash: "b".repeat(64) } };
    gateway.list.mockResolvedValue([record("system-agent:unrelated"), changed]);

    await expect(source.getCurrent(pending.id)).resolves.toEqual({
      pending: true,
      sourceRevision: changed.request.proposalHash,
    });
    await expect(bridge.handleKernelDecision(decided())).resolves.toBe("rejected");
    expect(gateway.resolve).not.toHaveBeenCalled();
    expect(kernel.publishMismatch).toHaveBeenCalledTimes(1);
    expect(bridge.isPublished(pending.id)).toBe(true);
  });

  it("does not resolve a truly gone proposal when a successful list omits its id", async () => {
    gateway.list.mockResolvedValue([record("system-agent:unrelated")]);

    await expect(source.getCurrent(pending.id)).resolves.toBeNull();
    await expect(bridge.handleKernelDecision(decided())).resolves.toBe("noop");
    expect(gateway.resolve).not.toHaveBeenCalled();
    expect(bridge.isPublished(pending.id)).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("releases stale loop blocks when the pending list becomes empty", async () => {
    gateway.list.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(SWEEP_MS);

    expect(tracker.unblock).toHaveBeenCalledTimes(1);
    expect(tracker.unblock).toHaveBeenCalledWith({ sessionKey: SESSION });
    expect(vi.getTimerCount()).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(gateway.get).not.toHaveBeenCalled();
  });

  it.each(["gateway unavailable", "approval not found"])(
    "keeps an unreadable list (%s) unknown, then applies the same decision on retry",
    async (message) => {
      gateway.list.mockRejectedValue(new Error(message));
      await expect(source.getCurrent(pending.id)).rejects.toThrow(message);
      await expect(bridge.handleKernelDecision(decided())).resolves.toBe("deferred");
      expect(bridge.isPublished(pending.id)).toBe(true);
      expect(gateway.resolve).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SWEEP_MS);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("getCurrent failed"));
      expect(tracker.unblock).not.toHaveBeenCalled();

      gateway.list.mockResolvedValue([pending]);
      await expect(bridge.handleKernelDecision(decided())).resolves.toBe("applied");
      expect(gateway.resolve).toHaveBeenCalledTimes(1);
    },
  );

  it("also relays a rejection through the runtime-visible path", async () => {
    const frame = decided();
    frame.payload!.decision = "reject";

    await expect(bridge.handleKernelDecision(frame)).resolves.toBe("applied");
    expect(gateway.resolve).toHaveBeenCalledTimes(1);
    expect(gateway.resolve).toHaveBeenCalledWith({
      id: pending.id,
      kind: "system-agent",
      decision: "deny",
    });
    expect(gateway.get).not.toHaveBeenCalled();
  });
});
