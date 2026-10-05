import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  DEFAULT_LOOP_BLOCK_SWEEP_INTERVAL_MS,
  GatewayApprovalsBridge,
  KernelNotifyError,
  MIN_LOOP_BLOCK_SWEEP_INTERVAL_MS,
  resolveLoopBlockSweepIntervalMs,
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
  ApprovalContentDriftError,
  type ApprovalSource,
  type ApprovalSourceCurrentState,
  type ApprovalSourceRequest,
} from "./sources/types.js";

if ("hashes" in ed && ed.hashes) {
  (ed.hashes as { sha512?: typeof sha512 }).sha512 = sha512;
}

const OPERATOR_DID = "did:imajin:operator";
const AGENT_DID = "did:imajin:agent";
const SESSION = "agent:main:main";
const SWEEP_MS = 1000;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A system-agent approval with NO expiry, so only the sweep can clear its block. */
function record(id: string, sessionKey: string = SESSION): SystemAgentApprovalRequestRecord {
  return {
    id,
    request: {
      title: "OpenClaw change",
      description: "Restart the gateway",
      command: "gateway restart",
      proposalHash: "a".repeat(64),
      allowedDecisions: ["allow-once", "deny"],
      agentId: "main",
      sessionKey,
    },
    createdAtMs: Date.now(),
    expiresAtMs: undefined as unknown as number,
  };
}

function decided(id: string, contentHash: string): KernelBusEventFrame {
  return {
    type: "bus_event",
    eventType: "operator.approval.decided",
    issuer: OPERATOR_DID,
    subject: OPERATOR_DID,
    scope: "operator",
    payload: {
      proposalId: id,
      decision: "approve",
      decidedBy: OPERATOR_DID,
      decidedAt: new Date().toISOString(),
      contentHash,
    },
  };
}

describe("resolveLoopBlockSweepIntervalMs (#66)", () => {
  it("defaults, disables on 0, and floors small values", () => {
    expect(resolveLoopBlockSweepIntervalMs(undefined)).toBe(DEFAULT_LOOP_BLOCK_SWEEP_INTERVAL_MS);
    expect(resolveLoopBlockSweepIntervalMs(Number.NaN)).toBe(DEFAULT_LOOP_BLOCK_SWEEP_INTERVAL_MS);
    expect(resolveLoopBlockSweepIntervalMs(-5)).toBe(DEFAULT_LOOP_BLOCK_SWEEP_INTERVAL_MS);
    expect(resolveLoopBlockSweepIntervalMs(0)).toBe(0);
    expect(resolveLoopBlockSweepIntervalMs(10)).toBe(MIN_LOOP_BLOCK_SWEEP_INTERVAL_MS);
    expect(resolveLoopBlockSweepIntervalMs(30_000.9)).toBe(30_000);
    expect(DEFAULT_LOOP_BLOCK_SWEEP_INTERVAL_MS).toBe(60_000);
  });
});

describe("createApprovalLoopBlocker.heldProposalIds (#66)", () => {
  it("lists the proposals currently holding a block", () => {
    const blocker = createApprovalLoopBlocker({ block: vi.fn(), unblock: vi.fn() });
    blocker.block("a", { sessionKey: SESSION }, "r");
    blocker.block("b", { jobId: "job-1" }, "r");
    expect(blocker.heldProposalIds()).toEqual(["a", "b"]);
    blocker.release("a");
    expect(blocker.heldProposalIds()).toEqual(["b"]);
  });
});

describe("GatewayApprovalsBridge → stale approval block sweep (#66)", () => {
  let keyHex: string;
  let gateway: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    resolve: ReturnType<typeof vi.fn>;
    onRequested: ReturnType<typeof vi.fn>;
  };
  let kernel: { publishApprovalRequested: ReturnType<typeof vi.fn>; publishMismatch: ReturnType<typeof vi.fn> };
  let tracker: { block: ReturnType<typeof vi.fn>; unblock: ReturnType<typeof vi.fn> };
  let bridges: GatewayApprovalsBridge[];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    keyHex = hex(ed.utils.randomPrivateKey());
    bridges = [];
    gateway = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ status: "pending", presentation: { proposalHash: "a".repeat(64) } }),
      resolve: vi.fn().mockResolvedValue({ applied: true }),
      onRequested: vi.fn(),
    };
    kernel = {
      publishApprovalRequested: vi.fn().mockResolvedValue(undefined),
      publishMismatch: vi.fn().mockResolvedValue(undefined),
    };
    tracker = { block: vi.fn(), unblock: vi.fn() };
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
  });

  afterEach(() => {
    for (const bridge of bridges) bridge.dispose();
    // No leaked intervals: every bridge timer is cleared by dispose().
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  function newBridge(sweepMs: number | undefined = SWEEP_MS): GatewayApprovalsBridge {
    const bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: keyHex },
      new Map<string, ApprovalSource>([
        ["system-agent", createSystemAgentSource(gateway as unknown as GatewayApprovalsClient)],
      ]),
      kernel as unknown as KernelNotifyClient,
      logger,
      undefined,
      undefined,
      { publishRetryDelaysMs: [], loopTracker: tracker, loopBlockSweepIntervalMs: sweepMs },
    );
    bridges.push(bridge);
    return bridge;
  }

  async function stage(bridge: GatewayApprovalsBridge, ...records: SystemAgentApprovalRequestRecord[]): Promise<void> {
    gateway.list.mockResolvedValue(records);
    await bridge.reconcile();
  }

  it("clears the block of an approval settled outside /jin (no expiry) within one sweep interval", async () => {
    const bridge = newBridge();
    await stage(bridge, record("system-agent:one"));
    expect(tracker.block).toHaveBeenCalledTimes(1);

    // Still pending at the source: stays blocked.
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    expect(gateway.get).toHaveBeenCalledWith("system-agent:one");
    expect(tracker.unblock).not.toHaveBeenCalled();

    // Settled in the gateway UI / CLI: no decided event, no expiry.
    gateway.get.mockResolvedValue({ status: "allowed", presentation: {} });
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
    expect(tracker.unblock).toHaveBeenCalledWith({ sessionKey: SESSION });

    // Nothing left to watch: the interval stops itself.
    expect(vi.getTimerCount()).toBe(0);
    const getCalls = gateway.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SWEEP_MS * 3);
    expect(gateway.get.mock.calls.length).toBe(getCalls);
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
  });

  it("treats a proposal unknown to the source as settled", async () => {
    const bridge = newBridge();
    await stage(bridge, record("system-agent:gone"));
    gateway.get.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
  });

  it("unblocks a session only once its last pending approval is settled", async () => {
    const bridge = newBridge();
    await stage(bridge, record("system-agent:a"), record("system-agent:b"));
    expect(tracker.block).toHaveBeenCalledTimes(1);

    gateway.get.mockImplementation(async (id: string) =>
      id === "system-agent:a"
        ? { status: "denied", presentation: {} }
        : { status: "pending", presentation: { proposalHash: "a".repeat(64) } },
    );
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    expect(tracker.unblock).not.toHaveBeenCalled();

    gateway.get.mockResolvedValue({ status: "expired", presentation: {} });
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
  });

  it("a failing getCurrent is logged and dropped: the block stays and the next sweep retries", async () => {
    const bridge = newBridge();
    await stage(bridge, record("system-agent:flaky"));
    gateway.get.mockRejectedValue(new Error("gateway down"));
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    expect(tracker.unblock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("getCurrent failed"));
    expect(logger.error).not.toHaveBeenCalled();

    gateway.get.mockResolvedValue({ status: "allowed", presentation: {} });
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
  });

  it("a throwing tracker never affects the sweep, publishing, or applying a decision", async () => {
    tracker.unblock.mockImplementation(() => {
      throw new Error("boom");
    });
    const bridge = newBridge();
    await stage(bridge, record("system-agent:one"), record("system-agent:two", "agent:main:other"));
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(2);

    gateway.get.mockImplementation(async (id: string) =>
      id === "system-agent:one"
        ? { status: "allowed", presentation: {} }
        : { status: "pending", presentation: { proposalHash: "a".repeat(64) } },
    );
    await expect(bridge.sweepStaleLoopBlocks()).resolves.toBeUndefined();
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
    expect(bridge.isPublished("system-agent:two")).toBe(true);

    // The decision path still applies.
    const hash = kernel.publishApprovalRequested.mock.calls[1][0].contentHash as string;
    expect(await bridge.handleKernelDecision(decided("system-agent:two", hash))).toBe("applied");
    expect(gateway.resolve).toHaveBeenCalledTimes(1);
  });

  it("does not start any timer when the sweep is disabled (0)", async () => {
    const bridge = newBridge(0);
    await stage(bridge, record("system-agent:one"));
    expect(tracker.block).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_LOOP_BLOCK_SWEEP_INTERVAL_MS * 2);
    expect(gateway.get).not.toHaveBeenCalled();
  });

  it("starts no timer without a loop tracker or without a held block", async () => {
    const noTracker = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: keyHex },
      new Map<string, ApprovalSource>([
        ["system-agent", createSystemAgentSource(gateway as unknown as GatewayApprovalsClient)],
      ]),
      kernel as unknown as KernelNotifyClient,
      logger,
      undefined,
      undefined,
      { publishRetryDelaysMs: [], loopBlockSweepIntervalMs: SWEEP_MS },
    );
    bridges.push(noTracker);
    gateway.list.mockResolvedValue([record("system-agent:one")]);
    await noTracker.reconcile();
    expect(vi.getTimerCount()).toBe(0);

    const bridge = newBridge();
    await stage(bridge, record("system-agent:no-session", "  "));
    expect(tracker.block).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose() clears the sweep interval and stops sweeping", async () => {
    const bridge = newBridge();
    await stage(bridge, record("system-agent:one"));
    expect(vi.getTimerCount()).toBe(1);
    bridge.dispose();
    expect(vi.getTimerCount()).toBe(0);

    gateway.get.mockResolvedValue({ status: "allowed", presentation: {} });
    await vi.advanceTimersByTimeAsync(SWEEP_MS * 3);
    await bridge.sweepStaleLoopBlocks();
    expect(gateway.get).not.toHaveBeenCalled();
    expect(tracker.unblock).not.toHaveBeenCalled();
  });

  it("does not overlap sweeps while a getCurrent is still in flight", async () => {
    const bridge = newBridge();
    await stage(bridge, record("system-agent:slow"));
    let finish!: (v: unknown) => void;
    gateway.get.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await vi.advanceTimersByTimeAsync(SWEEP_MS * 3);
    expect(gateway.get).toHaveBeenCalledTimes(1);
    finish({ status: "allowed", presentation: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
  });
});

describe("GatewayApprovalsBridge → drift restage keeps the block (#66)", () => {
  interface Item {
    revision: string;
    pending: boolean;
  }

  let keyHex: string;
  let items: Map<string, Item>;
  let relistEmpty: boolean;
  let kernel: { publishApprovalRequested: ReturnType<typeof vi.fn>; publishMismatch: ReturnType<typeof vi.fn> };
  let events: string[];
  let tracker: { block: ReturnType<typeof vi.fn>; unblock: ReturnType<typeof vi.fn> };
  let bridge: GatewayApprovalsBridge;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const request = (id: string, revision: string): ApprovalSourceRequest => ({
    proposalId: id,
    kind: "fake:update",
    summary: `proposal ${id}`,
    sourceRevision: revision,
    owner: { sessionKey: SESSION },
  });

  beforeEach(() => {
    keyHex = hex(ed.utils.randomPrivateKey());
    items = new Map();
    relistEmpty = false;
    events = [];
    kernel = {
      publishApprovalRequested: vi.fn().mockResolvedValue(undefined),
      publishMismatch: vi.fn().mockResolvedValue(undefined),
    };
    tracker = {
      block: vi.fn(() => events.push("block")),
      unblock: vi.fn(() => events.push("unblock")),
    };
    const source: ApprovalSource = {
      id: "fake",
      onDriftPolicy: "restage",
      async list() {
        if (relistEmpty) return [];
        return [...items].filter(([, i]) => i.pending).map(([id, i]) => request(id, i.revision));
      },
      subscribe: () => () => {},
      async getCurrent(id): Promise<ApprovalSourceCurrentState | null> {
        const item = items.get(id);
        return item ? { pending: item.pending, sourceRevision: item.revision } : null;
      },
      async resolve(id, _decision, expected) {
        const item = items.get(id);
        if (item && item.revision !== expected) throw new ApprovalContentDriftError(id, "revision changed");
        if (item) item.pending = false;
        return { applied: true };
      },
    };
    bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: keyHex },
      new Map<string, ApprovalSource>([["fake", source]]),
      kernel as unknown as KernelNotifyClient,
      logger,
      undefined,
      undefined,
      // Sweep off: this suite is about the restage path alone.
      { publishRetryDelaysMs: [], loopTracker: tracker, loopBlockSweepIntervalMs: 0 },
    );
  });

  afterEach(() => {
    bridge.dispose();
  });

  const hashOfPublish = (n: number): string => kernel.publishApprovalRequested.mock.calls[n][0].contentHash as string;

  async function stageAndDrift(id: string): Promise<void> {
    items.set(id, { revision: "rev-1", pending: true });
    await bridge.reconcile();
    expect(events).toEqual(["block"]);
    items.get(id)!.revision = "rev-2"; // the proposal changed after the card was published
    expect(await bridge.handleKernelDecision(decided(id, hashOfPublish(0)))).toBe("rejected");
  }

  it("emits no unblock→block pair when a drifted proposal is restaged", async () => {
    await stageAndDrift("p1");
    // Re-published against the new revision...
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(2);
    expect(hashOfPublish(1)).not.toBe(hashOfPublish(0));
    expect(bridge.isPublished("p1")).toBe(true);
    // ...with one continuous block: the tracker never saw an unblock.
    expect(events).toEqual(["block"]);
    expect(tracker.block).toHaveBeenCalledTimes(1);
    expect(tracker.unblock).not.toHaveBeenCalled();

    // The restaged card is still decidable and settling it unblocks exactly once.
    expect(await bridge.handleKernelDecision(decided("p1", hashOfPublish(1)))).toBe("applied");
    expect(events).toEqual(["block", "unblock"]);
  });

  it("unblocks once if the restaged item is no longer pending when re-listed", async () => {
    items.set("p1", { revision: "rev-1", pending: true });
    await bridge.reconcile();
    // The item is revised (drift), and the re-list no longer returns it.
    items.get("p1")!.revision = "rev-2";
    relistEmpty = true;
    await bridge.handleKernelDecision(decided("p1", hashOfPublish(0)));
    expect(bridge.isPublished("p1")).toBe(false);
    expect(events).toEqual(["block", "unblock"]);
  });

  it("unblocks (and does not re-block) if the restaged card fails to publish", async () => {
    items.set("p1", { revision: "rev-1", pending: true });
    await bridge.reconcile();
    items.get("p1")!.revision = "rev-2";
    kernel.publishApprovalRequested.mockRejectedValueOnce(new KernelNotifyError(400, "rejected"));
    await bridge.handleKernelDecision(decided("p1", hashOfPublish(0)));
    expect(bridge.isPublished("p1")).toBe(false);
    expect(events).toEqual(["block", "unblock"]);
  });

  it("a throwing tracker never affects the restage", async () => {
    tracker.block.mockImplementation(() => {
      throw new Error("boom");
    });
    tracker.unblock.mockImplementation(() => {
      throw new Error("boom");
    });
    items.set("p1", { revision: "rev-1", pending: true });
    await bridge.reconcile();
    items.get("p1")!.revision = "rev-2";
    expect(await bridge.handleKernelDecision(decided("p1", hashOfPublish(0)))).toBe("rejected");
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(2);
    expect(bridge.isPublished("p1")).toBe(true);
  });
});
