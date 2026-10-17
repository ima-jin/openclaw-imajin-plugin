import { afterEach, describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { ApprovalExecutionRegistry, type ApprovalLoopBinding } from "./approval-execution.js";
import type { SignedMessage } from "./approval-bridge.js";
import { verifyMessage } from "./approval-bridge.js";
import type { ApprovalLoopTracker } from "./approval-loop-blocker.js";
import {
  GatewayApprovalsBridge,
  type KernelApprovalRequestedPayload,
  type KernelBusEventFrame,
} from "./gateway-approvals-bridge.js";
import type { ApprovalSource, ApprovalSourceRequest } from "./sources/types.js";

const DID = "did:imajin:agent";
const PRINCIPAL = "did:imajin:operator";
const PRIVATE_KEY = "01".repeat(32);
const bridges: GatewayApprovalsBridge[] = [];
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose(); });

function setup(options: {
  registry?: ApprovalExecutionRegistry;
  tracker?: ApprovalLoopTracker;
  publishBinding?: ReturnType<typeof vi.fn>;
  publishError?: boolean;
  sourceId?: string;
  approvalId?: string;
  owner?: ApprovalSourceRequest["owner"];
} = {}) {
  const request: ApprovalSourceRequest = {
    proposalId: "native-id",
    sourceRevision: "revision",
    kind: "gateway-exec:command",
    summary: "command",
    // Deliberately different from owner. This MUST NOT select the binding.
    detail: { approvalId: options.approvalId ?? "native-id", sessionKey: "untrusted-card-destination" },
    owner: options.owner ?? { sessionKey: "local-owner" },
  };
  const source: ApprovalSource = {
    id: options.sourceId ?? "gateway-exec",
    list: vi.fn(async () => [request]),
    subscribe: () => () => {},
    getCurrent: vi.fn(async () => ({ pending: true, sourceRevision: request.sourceRevision, detail: request.detail })),
    resolve: vi.fn(async () => ({ applied: true })),
    failClosedOnPublishError: true,
  };
  const published: KernelApprovalRequestedPayload[] = [];
  const kernel = {
    publishApprovalRequested: vi.fn(async (payload: KernelApprovalRequestedPayload) => {
      if (options.publishError) throw new Error("offline");
      published.push(payload);
    }),
    publishMismatch: vi.fn(async () => {}),
  };
  const registry = options.registry ?? new ApprovalExecutionRegistry();
  const bridge = new GatewayApprovalsBridge(
    { agentDid: DID, operatorDid: PRINCIPAL, agentPrivateKeyHex: PRIVATE_KEY },
    new Map([[source.id, source]]), kernel,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, undefined,
    {
      executionRegistry: registry,
      loopTracker: options.tracker,
      publishApprovalBinding: options.publishBinding,
      publishRetryDelaysMs: [],
      loopBlockSweepIntervalMs: 0,
    },
  );
  bridges.push(bridge);
  const frame = (): KernelBusEventFrame => ({
    type: "bus_event", eventType: "operator.approval.decided", issuer: PRINCIPAL,
    subject: DID, scope: "operator",
    payload: { proposalId: request.proposalId, decision: "approve", decidedBy: PRINCIPAL, contentHash: published[0]?.contentHash },
  });
  return { bridge, source, registry, request, frame, kernel };
}

describe("native approval loop binding", () => {
  it("signs exactly the owner-derived public binding, never harness keys", async () => {
    const lookupRef = vi.fn(() => ({
      loopId: "loop-owner", sessionKey: "local-owner", parentLoopId: null, agentDid: DID,
    }));
    const publishBinding = vi.fn(async (_binding: SignedMessage<ApprovalLoopBinding>) => {});
    const { bridge } = setup({ tracker: { block: vi.fn(), unblock: vi.fn(), lookupRef }, publishBinding });
    await bridge.reconcile();
    expect(lookupRef).toHaveBeenCalledWith({ sessionKey: "local-owner" });
    expect(publishBinding).toHaveBeenCalledTimes(1);
    const binding = publishBinding.mock.calls[0]![0];
    expect(binding).toMatchObject({ from: DID, type: "agent", payload: {
      loopId: "loop-owner", principalDid: PRINCIPAL, agentDid: DID, approvalId: "native-id",
    } });
    expect(Object.keys(binding.payload).sort()).toEqual(["agentDid", "approvalId", "loopId", "principalDid"]);
    expect(JSON.stringify(binding)).not.toContain("local-owner");
    expect(JSON.stringify(binding)).not.toContain("untrusted-card-destination");
    const publicKey = Buffer.from(await ed.getPublicKeyAsync(Buffer.from(PRIVATE_KEY, "hex"))).toString("hex");
    expect(await verifyMessage(binding, publicKey)).toBe(true);
    expect(await verifyMessage({ ...binding, payload: { ...binding.payload, loopId: "forged" } }, publicKey)).toBe(false);
  });

  it.each(["unknown", "foreign", "missing-lookup", "lookup-throws"])("does not bind a %s owner", async (mode) => {
    const publishBinding = vi.fn(async () => {});
    const tracker: ApprovalLoopTracker = { block: vi.fn(), unblock: vi.fn() };
    if (mode !== "missing-lookup") tracker.lookupRef = () => {
      if (mode === "lookup-throws") throw new Error("lookup failed");
      return mode === "foreign"
        ? { loopId: "foreign", parentLoopId: null, agentDid: "did:foreign" }
        : undefined;
    };
    const { bridge, source } = setup({ tracker, publishBinding });
    await bridge.reconcile();
    expect(publishBinding).not.toHaveBeenCalled();
    expect(bridge.isPublished("native-id")).toBe(true);
    expect(source.resolve).not.toHaveBeenCalled();
  });

  it("stores owner bindings without a publishing callback for the shared session executor", async () => {
    const { bridge, registry } = setup({
      tracker: { block: vi.fn(), unblock: vi.fn(), lookupRef: () => ({ loopId: "loop", parentLoopId: null, agentDid: DID }) },
    });
    await bridge.reconcile();
    expect(registry.getBinding("native-id")).toEqual({
      loopId: "loop", principalDid: PRINCIPAL, agentDid: DID, approvalId: "native-id",
    });
    expect(registry.claim("native-id")).toBe(true);
  });

  it("stores the binding synchronously before entering the async publish callback", async () => {
    const registry = new ApprovalExecutionRegistry();
    const publishBinding = vi.fn(async () => {
      expect(registry.getBinding("native-id")?.loopId).toBe("loop");
    });
    const { bridge } = setup({
      registry, publishBinding,
      tracker: { block: vi.fn(), unblock: vi.fn(), lookupRef: () => ({ loopId: "loop", parentLoopId: null, agentDid: DID }) },
    });
    await bridge.reconcile();
    expect(publishBinding).toHaveBeenCalledTimes(1);
  });

  it("keeps a successfully published card pending if binding publication fails", async () => {
    const publishBinding = vi.fn(async () => { throw new Error("ws offline"); });
    const { bridge, source } = setup({
      tracker: { block: vi.fn(), unblock: vi.fn(), lookupRef: () => ({ loopId: "loop", parentLoopId: null, agentDid: DID }) },
      publishBinding,
    });
    await bridge.reconcile();
    expect(bridge.isPublished("native-id")).toBe(true);
    expect(source.resolve).not.toHaveBeenCalled();
  });

  it("rejects native/proposal id aliases without publishing or consuming any claim", async () => {
    const { bridge, kernel, registry, source } = setup({ approvalId: "different-native-id" });
    await bridge.reconcile();
    expect(kernel.publishApprovalRequested).not.toHaveBeenCalled();
    expect(source.resolve).not.toHaveBeenCalled();
    expect(registry.claim("native-id")).toBe(true);
    expect(registry.claim("different-native-id")).toBe(true);
  });

  it("replays signed bindings after reconnect without republishing cards or consuming claims", async () => {
    const publishBinding = vi.fn(async (_binding: SignedMessage<ApprovalLoopBinding>) => {});
    const { bridge, registry, kernel } = setup({
      publishBinding,
      tracker: { block: vi.fn(), unblock: vi.fn(), lookupRef: () => ({ loopId: "loop", parentLoopId: null, agentDid: DID }) },
    });
    await bridge.reconcile();
    await bridge.republishApprovalBindings();
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
    expect(publishBinding).toHaveBeenCalledTimes(2);
    expect(publishBinding.mock.calls[1]![0].payload).toEqual(publishBinding.mock.calls[0]![0].payload);
    const publicKey = Buffer.from(await ed.getPublicKeyAsync(Buffer.from(PRIVATE_KEY, "hex"))).toString("hex");
    expect(await verifyMessage(publishBinding.mock.calls[1]![0], publicKey)).toBe(true);
    expect(registry.claim("native-id")).toBe(true);
  });

  it.each(["ended", "replaced", "foreign"])("does not replay a %s owner or reassign its binding", async (mode) => {
    const lookupRef = vi.fn<NonNullable<ApprovalLoopTracker["lookupRef"]>>(() => ({
      loopId: "original", parentLoopId: null, agentDid: DID,
    }));
    const publishBinding = vi.fn(async () => {});
    const { bridge, registry } = setup({ publishBinding, tracker: { block: vi.fn(), unblock: vi.fn(), lookupRef } });
    await bridge.reconcile();
    lookupRef.mockReturnValue(mode === "ended" ? undefined : {
      loopId: mode === "replaced" ? "new" : "original",
      parentLoopId: null,
      agentDid: mode === "foreign" ? "did:foreign" : DID,
    });
    await bridge.republishApprovalBindings();
    expect(publishBinding).toHaveBeenCalledTimes(1);
    expect(registry.getBinding("native-id")?.loopId).toBe("original");
  });
});

describe("shared approval execution rail", () => {
  it("suppresses the legacy executor when a session rail claimed first", async () => {
    const { bridge, registry, source, frame } = setup();
    await bridge.reconcile();
    expect(registry.claim("native-id")).toBe(true);
    expect(await bridge.handleKernelDecision(frame())).toBe("noop");
    expect(source.resolve).not.toHaveBeenCalled();
  });

  it("claims before entering the harness and excludes a racing session rail", async () => {
    const { bridge, registry, source, frame } = setup();
    await bridge.reconcile();
    let finish!: () => void;
    let entered!: () => void;
    const harnessEntered = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(source.resolve).mockImplementation(async () => {
      entered();
      await new Promise<void>((resolve) => { finish = resolve; });
      return { applied: true };
    });
    const decision = bridge.handleKernelDecision(frame());
    await harnessEntered;
    expect(registry.claim("native-id")).toBe(false);
    const duplicate = bridge.handleKernelDecision(frame());
    finish();
    expect(await decision).toBe("applied");
    expect(await duplicate).toBe("applied");
    expect(source.resolve).toHaveBeenCalledTimes(1);
  });

  it("two bridge instances share a claim even when both pass asynchronous checks", async () => {
    const registry = new ApprovalExecutionRegistry();
    const a = setup({ registry });
    const b = setup({ registry });
    await Promise.all([a.bridge.reconcile(), b.bridge.reconcile()]);
    const results = await Promise.all([a.bridge.handleKernelDecision(a.frame()), b.bridge.handleKernelDecision(b.frame())]);
    expect(results.sort()).toEqual(["applied", "noop"]);
    expect(vi.mocked(a.source.resolve).mock.calls.length + vi.mocked(b.source.resolve).mock.calls.length).toBe(1);
  });

  it("retains the claim after an ambiguous source error, including a reconcile replay", async () => {
    const { bridge, registry, source, frame } = setup();
    await bridge.reconcile();
    vi.mocked(source.resolve).mockRejectedValue(new Error("response lost after execution"));
    expect(await bridge.handleKernelDecision(frame())).toBe("rejected");
    await bridge.reconcile();
    expect(await bridge.handleKernelDecision(frame())).toBe("noop");
    expect(source.resolve).toHaveBeenCalledTimes(1);
    expect(registry.claim("native-id")).toBe(false);
  });

  it.each(["issuer", "hash", "signature", "decision", "drift"])("does not consume claims on invalid %s frames", async (invalid) => {
    const { bridge, registry, source, frame } = setup();
    await bridge.reconcile();
    const bad = frame();
    if (invalid === "issuer") bad.issuer = "did:attacker";
    if (invalid === "hash") bad.payload!.contentHash = "tampered";
    if (invalid === "signature") bad.payload!.operatorSignature = { bad: true };
    if (invalid === "decision") bad.payload!.decision = "allow-always";
    if (invalid === "drift") vi.mocked(source.getCurrent).mockResolvedValue({ pending: true, sourceRevision: "changed" });
    expect(await bridge.handleKernelDecision(bad)).toBe("rejected");
    expect(source.resolve).not.toHaveBeenCalled();
    expect(registry.claim("native-id")).toBe(true);
  });

  it("fail-closed deny also consumes the shared claim, permanently across retries", async () => {
    const { bridge, source, registry } = setup({ publishError: true });
    vi.mocked(source.resolve).mockRejectedValue(new Error("ambiguous denial"));
    await bridge.reconcile();
    await bridge.reconcile();
    expect(source.resolve).toHaveBeenCalledTimes(1);
    expect(source.resolve).toHaveBeenCalledWith("native-id", "reject", "revision");
    expect(registry.claim("native-id")).toBe(false);
  });

  it("fail-closed deny respects a competing rail's claim", async () => {
    const { bridge, source, registry } = setup({ publishError: true });
    registry.claim("native-id");
    await bridge.reconcile();
    expect(source.resolve).not.toHaveBeenCalled();
  });
});
