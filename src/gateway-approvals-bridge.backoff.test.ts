import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayApprovalsBridge, KernelNotifyError } from "./gateway-approvals-bridge.js";
import type { ApprovalSourceRequest, ApprovalSource } from "./sources/types.js";

function fixture(status = 400) {
  const request: ApprovalSourceRequest = {
    proposalId: "rejected", sourceRevision: "rev-1", kind: "test:update",
    summary: "Update", detail: { description: "Original" },
  };
  const source: ApprovalSource = {
    id: "test", list: async () => [request], subscribe: () => () => {},
    getCurrent: async () => null, resolve: vi.fn(),
    onPublishFailed: vi.fn(),
  };
  const kernel = {
    publishApprovalRequested: vi.fn().mockRejectedValue(new KernelNotifyError(status, "kernel refused")),
    publishMismatch: vi.fn(),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const config = {
    operatorDid: "did:imajin:operator", agentDid: "did:imajin:agent", agentPrivateKeyHex: "01".repeat(32),
  };
  const bridge = new GatewayApprovalsBridge(config, new Map([["test", source]]), kernel, logger, undefined, undefined, {
    publishRetryDelaysMs: [0, 0],
  });
  return { bridge, kernel, source, request, logger, config };
}

afterEach(() => vi.useRealTimers());

describe("deterministic kernel rejection backoff (#94)", () => {
  it.each([400, 401, 403, 404, 409, 422])("holds unchanged content after HTTP %s, including on reconnect", async (status) => {
    vi.useFakeTimers();
    const { bridge, kernel, source, logger } = fixture(status);
    try {
      await bridge.reconcile();
      await bridge.reconcile();
      vi.setSystemTime(Date.now() + 15_000);
      await bridge.reconcile();
      expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(source.onPublishFailed).toHaveBeenLastCalledWith("rejected", { retryAtMs: Date.now() });
    } finally {
      bridge.dispose();
    }
  });

  it("increases the retry delay from 15s to a 30m cap and logs once for the rejected revision", async () => {
    vi.useFakeTimers();
    const { bridge, kernel, source, logger } = fixture();
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        const now = Date.now();
        await bridge.reconcile();
        const callback = vi.mocked(source.onPublishFailed!).mock.calls.at(-1)!;
        const deadline = callback[1]!.retryAtMs;
        expect(deadline - now).toBe(Math.min(15_000 * 2 ** attempt, 30 * 60_000));
        vi.setSystemTime(deadline);
        await bridge.reconcile();
        expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(attempt + 1);
        vi.setSystemTime(deadline + 1);
      }
      expect(logger.error).toHaveBeenCalledTimes(1);
    } finally {
      bridge.dispose();
    }
  });

  it.each(["revision", "detail", "summary"])("publishes changed %s immediately and resets backoff", async (changed) => {
    vi.useFakeTimers();
    const { bridge, kernel, request, source, logger } = fixture();
    try {
      await bridge.reconcile();
      if (changed === "revision") request.sourceRevision = "rev-2";
      else if (changed === "detail") request.detail = { description: "Changed" };
      else request.summary = "Changed";
      await bridge.reconcile();
      expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(source.onPublishFailed).toHaveBeenLastCalledWith("rejected", { retryAtMs: Date.now() + 15_000 });
      kernel.publishApprovalRequested.mockResolvedValue(undefined);
      vi.setSystemTime(Date.now() + 15_001);
      await bridge.reconcile();
      expect(bridge.isPublished("rejected")).toBe(true);
    } finally {
      bridge.dispose();
    }
  });

  it.each([408, 429, 500, 503])("preserves inline and subsequent-event retries for transient HTTP %s", async (status) => {
    const { bridge, kernel, source } = fixture(status);
    try {
      await bridge.reconcile();
      expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(3);
      expect(source.onPublishFailed).toHaveBeenCalledWith("rejected", undefined);
      kernel.publishApprovalRequested.mockResolvedValue(undefined);
      await bridge.reconcile();
      expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(4);
      expect(bridge.isPublished("rejected")).toBe(true);
    } finally {
      bridge.dispose();
    }
  });

  it("remembers an in-flight 400 arriving after service bridge replacement", async () => {
    const { bridge: unused, kernel, source, config, logger } = fixture();
    unused.dispose();
    const ledger = { published: new Map(), reservations: new Map() };
    const makeBridge = () => new GatewayApprovalsBridge(
      config, new Map([["test", source]]), kernel, logger, undefined, undefined, { publicationLedger: ledger },
    );
    let rejectPost!: (err: Error) => void;
    let entered!: () => void;
    const publishing = new Promise<void>((resolve) => { entered = resolve; });
    kernel.publishApprovalRequested.mockImplementationOnce(() => {
      entered();
      return new Promise<void>((_, reject) => { rejectPost = reject; });
    });
    const first = makeBridge();
    const initial = first.reconcile();
    await publishing;
    first.dispose();
    const replacement = makeBridge();
    try {
      const reconciled = replacement.reconcile();
      rejectPost(new KernelNotifyError(400, "rejected"));
      await Promise.all([initial, reconciled]);
      expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
      expect(source.onPublishFailed).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledTimes(1);
    } finally {
      replacement.dispose();
    }
  });

  it("retains deterministic rejection backoff across service bridge replacement", async () => {
    vi.useFakeTimers();
    const { bridge: unused, kernel, source, config, logger } = fixture();
    unused.dispose();
    const ledger = { published: new Map(), reservations: new Map() };
    const makeBridge = () => new GatewayApprovalsBridge(
      config, new Map([["test", source]]), kernel, logger, undefined, undefined, { publicationLedger: ledger },
    );
    const first = makeBridge();
    await first.reconcile();
    first.dispose();
    const replacement = makeBridge();
    try {
      await replacement.reconcile();
      expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
    } finally {
      replacement.dispose();
    }
  });
});
