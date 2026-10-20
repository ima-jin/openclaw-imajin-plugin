import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";
import {
  GatewayApprovalsBridge,
  KernelNotifyError,
  type KernelBusEventFrame,
} from "./gateway-approvals-bridge.js";
import type {
  ApprovalSource,
  ApprovalSourceCurrentState,
  ApprovalSourceRequest,
} from "./sources/types.js";

const AGENT_DID = "did:imajin:agent";
const OPERATOR_DID = "did:imajin:operator";
const SESSION = "agent:main:main";
type BridgeOptions = NonNullable<ConstructorParameters<typeof GatewayApprovalsBridge>[6]>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function request(): ApprovalSourceRequest {
  return {
    proposalId: "skill-workshop:disposal",
    kind: "skill-workshop:update",
    summary: "Update a skill",
    sourceRevision: "a".repeat(64),
    owner: { sessionKey: SESSION },
  };
}

function decided(contentHash: string): KernelBusEventFrame {
  return {
    type: "bus_event",
    eventType: "operator.approval.decided",
    issuer: OPERATOR_DID,
    subject: AGENT_DID,
    scope: "operator",
    payload: {
      proposalId: request().proposalId,
      decision: "approve",
      decidedBy: OPERATOR_DID,
      decidedAt: new Date().toISOString(),
      contentHash,
    },
  };
}

describe("GatewayApprovalsBridge disposal boundaries (#86)", () => {
  const bridges: GatewayApprovalsBridge[] = [];
  let emit: (proposal: ApprovalSourceRequest) => void;
  let source: ApprovalSource;
  let list: ReturnType<typeof vi.fn>;
  let getCurrent: ReturnType<typeof vi.fn>;
  let resolve: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let publishFailed: ReturnType<typeof vi.fn>;
  let kernel: {
    publishApprovalRequested: ReturnType<typeof vi.fn>;
    publishMismatch: ReturnType<typeof vi.fn>;
  };
  let tracker: {
    block: ReturnType<typeof vi.fn>;
    unblock: ReturnType<typeof vi.fn>;
    lookupRef: ReturnType<typeof vi.fn>;
  };
  let publishBinding: ReturnType<typeof vi.fn>;
  let notifyOperator: ReturnType<typeof vi.fn>;
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let privateKeyHex: string;

  beforeEach(() => {
    vi.useFakeTimers();
    privateKeyHex = Buffer.from(ed.utils.randomPrivateKey()).toString("hex");
    list = vi.fn().mockResolvedValue([request()]);
    getCurrent = vi.fn().mockResolvedValue({
      pending: true,
      sourceRevision: request().sourceRevision,
    });
    resolve = vi.fn().mockResolvedValue({ applied: true });
    unsubscribe = vi.fn();
    publishFailed = vi.fn();
    source = {
      id: "skill-workshop",
      list,
      getCurrent,
      resolve,
      onPublishFailed: publishFailed,
      failClosedOnPublishError: true,
      subscribe: (handler) => {
        emit = handler;
        return unsubscribe;
      },
    };
    kernel = {
      publishApprovalRequested: vi.fn().mockResolvedValue(undefined),
      publishMismatch: vi.fn().mockResolvedValue(undefined),
    };
    tracker = {
      block: vi.fn(),
      unblock: vi.fn(),
      lookupRef: vi.fn().mockReturnValue({
        loopId: "loop:disposal",
        parentLoopId: null,
        agentDid: AGENT_DID,
      }),
    };
    publishBinding = vi.fn().mockResolvedValue(undefined);
    notifyOperator = vi.fn().mockResolvedValue(undefined);
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  afterEach(() => {
    for (const bridge of bridges.splice(0)) bridge.dispose();
    const remainingTimers = vi.getTimerCount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    expect(remainingTimers).toBe(0);
  });

  function newBridge(options: BridgeOptions = {}): GatewayApprovalsBridge {
    const bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: privateKeyHex },
      new Map([[source.id, source]]),
      kernel,
      logger,
      undefined,
      notifyOperator,
      {
        loopTracker: tracker,
        publishApprovalBinding: publishBinding,
        loopBlockSweepIntervalMs: 1000,
        ...options,
      },
    );
    bridges.push(bridge);
    return bridge;
  }

  function lastDecision(): KernelBusEventFrame {
    const calls = kernel.publishApprovalRequested.mock.calls;
    return decided(calls[calls.length - 1][0].contentHash as string);
  }

  it("unsubscribes once and ignores late source callbacks after disposal", async () => {
    const bridge = newBridge();
    bridge.dispose();
    bridge.dispose();

    emit(request());
    await bridge.reconcile();
    await bridge.republishApprovalBindings();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    expect(kernel.publishApprovalRequested).not.toHaveBeenCalled();
    expect(publishBinding).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not publish proposals returned by a source list after disposal", async () => {
    const pendingList = deferred<ApprovalSourceRequest[]>();
    list.mockReturnValueOnce(pendingList.promise);
    const bridge = newBridge();
    const reconciliation = bridge.reconcile();
    expect(list).toHaveBeenCalledTimes(1);

    bridge.dispose();
    pendingList.resolve([request()]);
    await reconciliation;

    expect(kernel.publishApprovalRequested).not.toHaveBeenCalled();
    expect(tracker.block).not.toHaveBeenCalled();
    expect(publishBinding).not.toHaveBeenCalled();
  });

  it("does not publish when disposed while real asynchronous signing is pending", async () => {
    const bridge = newBridge();
    const reconciliation = bridge.reconcile();
    await Promise.resolve();
    expect(list).toHaveBeenCalledTimes(1);
    expect(kernel.publishApprovalRequested).not.toHaveBeenCalled();

    bridge.dispose();
    await reconciliation;

    expect(kernel.publishApprovalRequested).not.toHaveBeenCalled();
    expect(bridge.isPublished(request().proposalId)).toBe(false);
    expect(publishFailed).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("cancels a scheduled publish retry and settles reconciliation without advancing time", async () => {
    const retryScheduled = deferred<void>();
    logger.warn.mockImplementation(() => retryScheduled.resolve(undefined));
    kernel.publishApprovalRequested.mockRejectedValue(new KernelNotifyError(503, "unavailable"));
    const bridge = newBridge({ publishRetryDelaysMs: [60_000] });
    const reconciliation = bridge.reconcile();
    await retryScheduled.promise;
    expect(vi.getTimerCount()).toBe(1);

    bridge.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await reconciliation;
    await vi.advanceTimersByTimeAsync(120_000);

    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
    expect(publishFailed).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(notifyOperator).not.toHaveBeenCalled();
  });

  it("does not fail closed when an in-flight publish rejects after disposal", async () => {
    const publishing = deferred<void>();
    const entered = deferred<void>();
    kernel.publishApprovalRequested.mockImplementationOnce(() => {
      entered.resolve(undefined);
      return publishing.promise;
    });
    const bridge = newBridge();
    const reconciliation = bridge.reconcile();
    await entered.promise;

    bridge.dispose();
    publishing.reject(new KernelNotifyError(400, "rejected"));
    await reconciliation;

    expect(resolve).not.toHaveBeenCalled();
    expect(publishFailed).not.toHaveBeenCalled();
    expect(notifyOperator).not.toHaveBeenCalled();
    expect(tracker.block).not.toHaveBeenCalled();
  });

  it("does not create loop bindings or timers when a publish completes after disposal", async () => {
    const publishing = deferred<void>();
    const entered = deferred<void>();
    kernel.publishApprovalRequested.mockImplementationOnce(() => {
      entered.resolve(undefined);
      return publishing.promise;
    });
    const bridge = newBridge();
    const reconciliation = bridge.reconcile();
    await entered.promise;

    bridge.dispose();
    publishing.resolve(undefined);
    await reconciliation;

    expect(tracker.block).not.toHaveBeenCalled();
    expect(publishBinding).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores decisions arriving after disposal", async () => {
    const bridge = newBridge();
    await bridge.reconcile();
    const frame = lastDecision();
    bridge.dispose();

    await expect(bridge.handleKernelDecision(frame)).resolves.toBe("noop");

    expect(getCurrent).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(kernel.publishMismatch).not.toHaveBeenCalled();
  });

  it("does not resolve a decision whose current-state lookup completes after disposal", async () => {
    const current = deferred<ApprovalSourceCurrentState>();
    const entered = deferred<void>();
    const bridge = newBridge();
    await bridge.reconcile();
    getCurrent.mockImplementationOnce(() => {
      entered.resolve(undefined);
      return current.promise;
    });
    const decision = bridge.handleKernelDecision(lastDecision());
    await entered.promise;

    bridge.dispose();
    current.resolve({ pending: true, sourceRevision: request().sourceRevision });
    await expect(decision).resolves.toBe("noop");

    expect(resolve).not.toHaveBeenCalled();
    expect(kernel.publishMismatch).not.toHaveBeenCalled();
  });

  it("does not send a replay binding when disposed during asynchronous signing", async () => {
    const bridge = newBridge();
    await bridge.reconcile();
    expect(publishBinding).toHaveBeenCalledTimes(1);
    publishBinding.mockClear();

    const replay = bridge.republishApprovalBindings();
    bridge.dispose();
    await replay;
    await bridge.republishApprovalBindings();

    expect(publishBinding).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears loop expiry and sweep timers on disposal", async () => {
    list.mockResolvedValueOnce([{ ...request(), expiresAtMs: Date.now() + 60_000 }]);
    const bridge = newBridge();
    await bridge.reconcile();
    expect(tracker.block).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(2);

    bridge.dispose();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(getCurrent).not.toHaveBeenCalled();
    expect(tracker.unblock).not.toHaveBeenCalled();
  });

  it("restores a replacement's loop hold without republishing a successful card", async () => {
    const publicationLedger: NonNullable<BridgeOptions["publicationLedger"]> = {
      published: new Map(),
      reservations: new Map(),
    };
    const first = newBridge({ publicationLedger });
    await first.reconcile();
    const frame = lastDecision();
    first.dispose();
    tracker.block.mockClear();

    const replacement = newBridge({ publicationLedger });
    await replacement.reconcile();
    await replacement.reconcile();

    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
    expect(tracker.block).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await expect(replacement.handleKernelDecision(frame)).resolves.toBe("applied");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(tracker.unblock).toHaveBeenCalledTimes(1);
  });

  it("lets a replacement publish when the previous instance's retry was cancelled", async () => {
    const publicationLedger: NonNullable<BridgeOptions["publicationLedger"]> = {
      published: new Map(),
      reservations: new Map(),
    };
    const retryScheduled = deferred<void>();
    logger.warn.mockImplementation(() => retryScheduled.resolve(undefined));
    kernel.publishApprovalRequested.mockRejectedValueOnce(new KernelNotifyError(503, "unavailable"));
    const first = newBridge({ publicationLedger, publishRetryDelaysMs: [60_000] });
    const reconciliation = first.reconcile();
    await retryScheduled.promise;
    first.dispose();
    await reconciliation;
    expect(publicationLedger.reservations.size).toBe(0);

    const replacement = newBridge({ publicationLedger });
    await replacement.reconcile();

    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(2);
    expect(tracker.block).toHaveBeenCalledTimes(1);
    expect(publishBinding).toHaveBeenCalledTimes(1);
  });

  it("publishes after a retired predecessor releases its pending signing reservation", async () => {
    const publicationLedger: NonNullable<BridgeOptions["publicationLedger"]> = {
      published: new Map(),
      reservations: new Map(),
    };
    const first = newBridge({ publicationLedger });
    const initialReconciliation = first.reconcile();
    // Orphan reconciliation finishes before a new publish reserves its slot.
    await Promise.resolve();
    await Promise.resolve();
    expect(publicationLedger.reservations.size).toBe(1);
    expect(kernel.publishApprovalRequested).not.toHaveBeenCalled();
    first.dispose();

    const replacement = newBridge({ publicationLedger });
    const replacementReconciliation = replacement.reconcile();
    await Promise.all([initialReconciliation, replacementReconciliation]);

    expect(publicationLedger.reservations.size).toBe(0);
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
    expect(tracker.block).toHaveBeenCalledTimes(1);
    expect(publishBinding).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"] as const)(
    "waits for a retired predecessor's in-flight POST %s before deciding whether to republish",
    async (outcome) => {
      const publicationLedger: NonNullable<BridgeOptions["publicationLedger"]> = {
        published: new Map(),
        reservations: new Map(),
      };
      const publishing = deferred<void>();
      const entered = deferred<void>();
      kernel.publishApprovalRequested.mockImplementationOnce(() => {
        entered.resolve(undefined);
        return publishing.promise;
      });
      const first = newBridge({ publicationLedger });
      const initialReconciliation = first.reconcile();
      await entered.promise;
      first.dispose();

      const replacement = newBridge({ publicationLedger });
      const replacementReconciliation = replacement.reconcile();
      await Promise.resolve();
      expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
      expect(tracker.block).not.toHaveBeenCalled();

      if (outcome === "success") publishing.resolve(undefined);
      else publishing.reject(new KernelNotifyError(503, "unavailable"));
      await Promise.all([initialReconciliation, replacementReconciliation]);

      expect(publicationLedger.reservations.size).toBe(0);
      expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(outcome === "success" ? 1 : 2);
      expect(tracker.block).toHaveBeenCalledTimes(1);
      expect(resolve).not.toHaveBeenCalled();
      expect(publishFailed).not.toHaveBeenCalled();
    },
  );
});
