import { beforeAll, describe, expect, it, vi } from "vitest";
import { verifyMessage, type SignedMessage } from "./approval-bridge.js";
import {
  buildSessionCommandBody,
  createSessionCommandAttester,
  createSessionCommandExecutor,
  hashPayload,
  isSessionCommandFrame,
  signSessionCommandBody,
  type SessionCommandAttestationPayload,
  type SessionCommandExecutorConfig,
  type SessionCommandFrame,
  type SessionCommandType,
} from "./session-commands.js";
import type { SessionGateway } from "./session-command-gateway.js";
import { createLoopTracker, type LoopTracker } from "./loop-tracker.js";
import { deriveLoopId } from "./loop-publisher.js";
import { ApprovalExecutionRegistry } from "./approval-execution.js";
import { GatewayApprovalsBridge, type KernelApprovalRequestedPayload, type KernelBusEventFrame } from "./gateway-approvals-bridge.js";
import type { ApprovalSource } from "./sources/types.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => JSON.stringify({ did: "did:imajin:agent", privateKey: "33".repeat(32) })),
}));

const AGENT = "did:imajin:agent";
const PRINCIPAL = "did:imajin:principal";
const KERNEL = "did:imajin:kernel";
const NOW = Date.parse("2026-10-06T16:00:00.000Z");

const KERNEL_PRIV = "11".repeat(32);
const PRINCIPAL_PRIV = "22".repeat(32);
const AGENT_PRIV = "33".repeat(32);
const ROGUE_PRIV = "44".repeat(32);

let kernelPub = "";
let principalPub = "";
let agentPub = "";

beforeAll(async () => {
  const probe = (priv: string) =>
    signSessionCommandBody(
      { type: "session.send", commandId: "x", to: "x", principal: "x", issuer: "x", issuedAt: "x", expiresAt: null, payload: null },
      priv,
    ).then((s) => s.keyId);
  [kernelPub, principalPub, agentPub] = await Promise.all([
    probe(KERNEL_PRIV),
    probe(PRINCIPAL_PRIV),
    probe(AGENT_PRIV),
  ]);
});

function fakeGateway(): SessionGateway & {
  send: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  resolveApproval: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn>;
} {
  return {
    send: vi.fn(async () => ({ runId: "run-1" })),
    abort: vi.fn(async () => ({ aborted: true })),
    resolveApproval: vi.fn(async ({ kind }: { kind?: "exec" | "plugin" }) => ({
      applied: true,
      kind: kind ?? ("exec" as const),
    })),
    spawn: vi.fn(async () => ({ sessionKey: "agent:main:child-1" })),
  };
}

interface Harness {
  loops: LoopTracker;
  approvals: ApprovalExecutionRegistry;
  gateway: ReturnType<typeof fakeGateway>;
  attestations: Array<{ eventType: string; payload: SessionCommandAttestationPayload }>;
  handle: ReturnType<typeof createSessionCommandExecutor>["handleFrame"];
  resolveServiceOf: ReturnType<typeof vi.fn>;
}

function harness(
  config: Partial<SessionCommandExecutorConfig> = {},
  overrides: { serviceOf?: string[] | null | Error; principalKey?: string | null } = {},
): Harness {
  const gateway = fakeGateway();
  const loops = createLoopTracker({ did: AGENT, emit: vi.fn() });
  const approvals = new ApprovalExecutionRegistry();
  const attestations: Harness["attestations"] = [];
  const resolveServiceOf = vi.fn(async () => {
    if (overrides.serviceOf instanceof Error) throw overrides.serviceOf;
    return overrides.serviceOf === undefined ? [PRINCIPAL] : overrides.serviceOf;
  });
  const executor = createSessionCommandExecutor(
    { agentDid: AGENT, kernelPublicKeyHex: kernelPub, kernelDid: KERNEL, ...config },
    {
      gateway,
      loopTracker: loops,
      executionRegistry: approvals,
      attest: async (eventType, payload) => {
        attestations.push({ eventType, payload });
      },
      resolveServiceOf,
      resolvePublicKey: async () => (overrides.principalKey === undefined ? principalPub : overrides.principalKey),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => NOW,
    },
  );
  return { gateway, attestations, handle: executor.handleFrame, resolveServiceOf, loops, approvals };
}

let counter = 0;

async function signedFrame(
  type: SessionCommandType,
  payload: unknown,
  overrides: Partial<SessionCommandFrame> = {},
  keys: { kernel?: string; principal?: string | null } = {},
): Promise<SessionCommandFrame> {
  const frame: SessionCommandFrame = {
    type,
    commandId: `cmd-${++counter}`,
    to: AGENT,
    principal: PRINCIPAL,
    issuer: KERNEL,
    issuedAt: new Date(NOW - 1000).toISOString(),
    payload,
    ...overrides,
  };
  const body = buildSessionCommandBody(frame);
  frame.signature = await signSessionCommandBody(body, keys.kernel ?? KERNEL_PRIV);
  if (keys.principal !== null) {
    frame.countersignature = await signSessionCommandBody(body, keys.principal ?? PRINCIPAL_PRIV);
  }
  return frame;
}

describe("isSessionCommandFrame", () => {
  it("recognizes exactly the five command types", () => {
    for (const type of ["session.send", "session.approve", "session.deny", "session.abort", "session.spawn"]) {
      expect(isSessionCommandFrame({ type })).toBe(true);
    }
    expect(isSessionCommandFrame({ type: "session.delete" })).toBe(false);
    expect(isSessionCommandFrame({ type: "notification" })).toBe(false);
    expect(isSessionCommandFrame(null)).toBe(false);
  });
});

describe("session.send", () => {
  it("verifies, executes via chat.send, and attests loop.session.send.completed", async () => {
    const h = harness();
    const payload = { sessionKey: "agent:main:main", message: "hello from /jin" };
    const frame = await signedFrame("session.send", payload);

    const outcome = await h.handle(frame);

    expect(outcome).toEqual({ ok: true, eventType: "loop.session.send.completed" });
    expect(h.gateway.send).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      message: "hello from /jin",
      agentId: undefined,
      idempotencyKey: frame.commandId,
    });
    expect(h.attestations).toHaveLength(1);
    const [{ eventType, payload: att }] = h.attestations;
    expect(eventType).toBe("loop.session.send.completed");
    expect(att).toMatchObject({
      eventType: "loop.session.send.completed",
      commandId: frame.commandId,
      command: "session.send",
      outcome: "completed",
      principal: PRINCIPAL,
      issuer: KERNEL,
      payloadHash: hashPayload(payload),
      agentDid: AGENT,
      loopId: deriveLoopId(AGENT, "openclaw.session", "agent:main:main"),
      runId: "run-1",
    });
    expect(att.reason).toBeUndefined();
  });

  it("never echoes the message text back in the attestation", async () => {
    const h = harness();
    await h.handle(await signedFrame("session.send", { sessionKey: "k", message: "super private text" }));
    expect(JSON.stringify(h.attestations)).not.toContain("super private text");
  });

  it("passes agentId through and rejects an oversized/empty message as invalid_payload", async () => {
    const h = harness();
    await h.handle(await signedFrame("session.send", { sessionKey: "k", message: "m", agentId: "ops" }));
    expect(h.gateway.send).toHaveBeenCalledWith(expect.objectContaining({ agentId: "ops" }));

    const bad = await h.handle(await signedFrame("session.send", { sessionKey: "k", message: "" }));
    expect(bad).toMatchObject({ ok: false, eventType: "loop.session.send.failed", reason: "invalid_payload" });
    expect(h.gateway.send).toHaveBeenCalledTimes(1);
  });

  it("attests gateway_error (with a redacted detail) when chat.send throws", async () => {
    const h = harness();
    h.gateway.send.mockRejectedValueOnce(new Error("boom token=abcdef1234567890abcdef"));
    const outcome = await h.handle(await signedFrame("session.send", { sessionKey: "k", message: "m" }));
    expect(outcome).toMatchObject({ ok: false, reason: "gateway_error" });
    const att = h.attestations[0].payload;
    expect(att.eventType).toBe("loop.session.send.failed");
    expect(att.detail).toBe("local gateway execution failed");
    expect(att.detail).not.toContain("abcdef1234567890abcdef");
  });
});

describe("session.approve / session.deny", () => {
  it("approve resolves the named approval as allow-once and attests completed", async () => {
    const h = harness();
    const outcome = await h.handle(await signedFrame("session.approve", { approvalId: "appr-1", kind: "exec" }));
    expect(outcome).toEqual({ ok: true, eventType: "loop.session.approve.completed" });
    expect(h.gateway.resolveApproval).toHaveBeenCalledWith({ id: "appr-1", kind: "exec", decision: "allow-once" });
    expect(h.attestations[0].payload).toMatchObject({ approvalId: "appr-1", approvalKind: "exec" });
  });

  it("deny resolves the named approval as deny and attests completed", async () => {
    const h = harness();
    const outcome = await h.handle(await signedFrame("session.deny", { approvalId: "appr-2" }));
    expect(outcome).toEqual({ ok: true, eventType: "loop.session.deny.completed" });
    expect(h.gateway.resolveApproval).toHaveBeenCalledWith({ id: "appr-2", kind: undefined, decision: "deny" });
  });

  it("attests approval_not_found when nothing was resolved", async () => {
    const h = harness();
    h.gateway.resolveApproval.mockResolvedValueOnce({ applied: false, kind: "plugin" });
    const outcome = await h.handle(await signedFrame("session.approve", { approvalId: "gone" }));
    expect(outcome).toMatchObject({ ok: false, eventType: "loop.session.approve.failed", reason: "approval_not_found" });
  });

  it("rejects an invalid kind / missing id and never calls the gateway", async () => {
    const h = harness();
    expect(await h.handle(await signedFrame("session.approve", { approvalId: "a", kind: "other" }))).toMatchObject({
      reason: "invalid_payload",
    });
    expect(await h.handle(await signedFrame("session.deny", {}))).toMatchObject({ reason: "invalid_payload" });
    expect(h.gateway.resolveApproval).not.toHaveBeenCalled();
  });
});

describe("session.abort", () => {
  it("cancels the named session via chat.abort and attests completed", async () => {
    const h = harness();
    const outcome = await h.handle(await signedFrame("session.abort", { sessionKey: "agent:main:main", runId: "run-9" }));
    expect(outcome).toEqual({ ok: true, eventType: "loop.session.abort.completed" });
    expect(h.gateway.abort).toHaveBeenCalledWith({ sessionKey: "agent:main:main", runId: "run-9" });
    expect(h.attestations[0].payload).toMatchObject({
      loopId: deriveLoopId(AGENT, "openclaw.session", "agent:main:main"), runId: "run-9",
    });
  });

  it("attests nothing_to_abort when the session had no active run", async () => {
    const h = harness();
    h.gateway.abort.mockResolvedValueOnce({ aborted: false });
    const outcome = await h.handle(await signedFrame("session.abort", { sessionKey: "idle" }));
    expect(outcome).toMatchObject({ ok: false, eventType: "loop.session.abort.failed", reason: "nothing_to_abort" });
  });
});

describe("session.spawn", () => {
  it("creates a child session and attests its loop lineage, never its key", async () => {
    const h = harness();
    const frame = await signedFrame("session.spawn", {
      task: "triage the backlog",
      parentSessionKey: "agent:main:main",
      label: "triage",
    });
    const outcome = await h.handle(frame);
    expect(outcome).toEqual({ ok: true, eventType: "loop.session.spawn.completed" });
    expect(h.gateway.spawn).toHaveBeenCalledWith({
      task: "triage the backlog",
      parentSessionKey: "agent:main:main",
      label: "triage",
      agentId: undefined,
      group: undefined,
      model: undefined,
      idempotencyKey: frame.commandId,
    });
    expect(h.attestations[0].payload).toMatchObject({
      loopId: deriveLoopId(AGENT, "openclaw.subagent", "agent:main:child-1"),
      childLoopId: deriveLoopId(AGENT, "openclaw.subagent", "agent:main:child-1"),
      parentLoopId: deriveLoopId(AGENT, "openclaw.session", "agent:main:main"),
      agentDid: AGENT,
    });
    expect(h.attestations[0].payload).not.toHaveProperty("sessionKey");
  });

  it("rejects a spawn without a task", async () => {
    const h = harness();
    expect(await h.handle(await signedFrame("session.spawn", { label: "x" }))).toMatchObject({
      ok: false,
      eventType: "loop.session.spawn.failed",
      reason: "invalid_payload",
    });
    expect(h.gateway.spawn).not.toHaveBeenCalled();
  });
});

describe("loop-addressed commands", () => {
  function start(h: Harness, key = "agent:main:main") {
    h.loops.onSessionStart({ sessionKey: key, sessionId: "native-session" });
    return h.loops.lookupSession(key)!;
  }

  it("resolves send and abort inside the plugin without a supplied sessionKey", async () => {
    const h = harness();
    const target = start(h);
    expect(await h.handle(await signedFrame("session.send", { loopId: target.loopId, message: "hi" }))).toMatchObject({ ok: true });
    expect(await h.handle(await signedFrame("session.abort", { loopId: target.loopId }))).toMatchObject({ ok: true });
    expect(h.gateway.send).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: target.sessionKey }));
    expect(h.gateway.abort).toHaveBeenCalledWith({ sessionKey: target.sessionKey, runId: undefined });
    for (const { payload } of h.attestations) {
      expect(payload).toMatchObject({ loopId: target.loopId, parentLoopId: null, agentDid: AGENT });
      expect(payload).not.toHaveProperty("sessionKey");
    }
  });

  it.each(["session.send", "session.abort", "session.spawn"] as const)(
    "%s fails closed for unknown, foreign and ended loops, even with a fallback key",
    async (type) => {
      const h = harness();
      const ended = start(h);
      h.loops.onSessionEnd({ sessionKey: ended.sessionKey });
      for (const loopId of ["unknown", deriveLoopId("did:imajin:foreign", "openclaw.session", "native-session"), ended.loopId]) {
        const payload = type === "session.spawn"
          ? { parentLoopId: loopId, parentSessionKey: "fallback", task: "t" }
          : { loopId, sessionKey: "fallback", message: "m" };
        expect(await h.handle(await signedFrame(type, payload))).toMatchObject({ ok: false, reason: "loop_not_found" });
      }
      expect(h.gateway.send).not.toHaveBeenCalled();
      expect(h.gateway.abort).not.toHaveBeenCalled();
      expect(h.gateway.spawn).not.toHaveBeenCalled();
    },
  );

  it("rejects a conflicting local key instead of changing the loop destination", async () => {
    const h = harness();
    const target = start(h);
    expect(await h.handle(await signedFrame("session.send", {
      loopId: target.loopId, sessionKey: "other", message: "m",
    }))).toMatchObject({ reason: "loop_target_mismatch" });
    expect(h.gateway.send).not.toHaveBeenCalled();
  });

  it("does not resurrect an ended loop through a legacy sessionKey fallback", async () => {
    const h = harness();
    const target = start(h);
    h.loops.onSessionEnd({ sessionKey: target.sessionKey, sessionId: "native-session" });
    expect(await h.handle(await signedFrame("session.send", {
      sessionKey: target.sessionKey, message: "late",
    }))).toMatchObject({ reason: "loop_not_found" });
    expect(h.gateway.send).not.toHaveBeenCalled();
    expect(h.loops.lookupSession(target.sessionKey)).toBeUndefined();
    h.loops.onSessionStart({ sessionKey: target.sessionKey, sessionId: "fresh-native-session" });
    expect(await h.handle(await signedFrame("session.send", {
      loopId: h.loops.lookupSession(target.sessionKey)!.loopId, message: "fresh",
    }))).toMatchObject({ ok: true });
  });

  it("forwards spawn group/model and signs the child and parent lineage with the agent identity", async () => {
    const h = harness();
    const parent = start(h);
    const frames: Array<{ type: string; attestation: SignedMessage<SessionCommandAttestationPayload> }> = [];
    const attest = createSessionCommandAttester({
      did: AGENT, keypairPath: "/fake", send: (frame) => frames.push(frame as typeof frames[number]),
    });
    const executor = createSessionCommandExecutor(
      { agentDid: AGENT, kernelPublicKeyHex: kernelPub },
      {
        gateway: h.gateway, loopTracker: h.loops, executionRegistry: h.approvals, attest,
        resolveServiceOf: async () => [PRINCIPAL], resolvePublicKey: async () => principalPub,
        now: () => NOW, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    );
    expect(await executor.handleFrame(await signedFrame("session.spawn", {
      task: "t", parentLoopId: parent.loopId, group: "team", model: "imajin/model",
    }))).toMatchObject({ ok: true });
    expect(h.gateway.spawn).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionKey: parent.sessionKey, group: "team", model: "imajin/model",
    }));
    const { attestation } = frames[0];
    expect(attestation.payload).toMatchObject({
      loopId: h.loops.lookupSession("agent:main:child-1")!.loopId,
      childLoopId: h.loops.lookupSession("agent:main:child-1")!.loopId,
      parentLoopId: parent.loopId, agentDid: AGENT,
    });
    expect(JSON.stringify(attestation)).not.toContain("agent:main:");
    expect(await verifyMessage(attestation, agentPub)).toBe(true);
    expect(await verifyMessage({
      ...attestation, payload: { ...attestation.payload, parentLoopId: "forged" },
    }, agentPub)).toBe(false);
  });

  it("attests the resolved loop even when the gateway fails", async () => {
    const h = harness();
    const target = start(h);
    h.gateway.send.mockRejectedValueOnce(new Error("offline"));
    await h.handle(await signedFrame("session.send", { loopId: target.loopId, message: "m" }));
    expect(h.attestations[0].payload).toMatchObject({ reason: "gateway_error", loopId: target.loopId });
  });

  it("uses the native approval binding, rejecting client-selected destinations before claiming", async () => {
    const h = harness();
    const target = start(h);
    h.approvals.bind({ approvalId: "bound", agentDid: AGENT, principalDid: PRINCIPAL, loopId: target.loopId });
    expect(await h.handle(await signedFrame("session.approve", {
      approvalId: "bound", loopId: "client-selected",
    }))).toMatchObject({ reason: "approval_binding_mismatch" });
    expect(await h.handle(await signedFrame("session.approve", { approvalId: "bound" }))).toMatchObject({ ok: true });
    expect(h.attestations[1].payload).toMatchObject({ loopId: target.loopId, approvalId: "bound" });
    expect(await h.handle(await signedFrame("session.deny", { approvalId: "bound" }))).toMatchObject({ reason: "approval_already_executed" });
    expect(h.gateway.resolveApproval).toHaveBeenCalledTimes(1);
  });

  it("rejects converted payload/owner mismatches before consuming the approval claim", async () => {
    const h = harness();
    const target = start(h);
    h.approvals.bind({ approvalId: "bound", agentDid: AGENT, principalDid: PRINCIPAL, loopId: target.loopId });
    h.loops.onSessionStart({ sessionKey: "other" });
    const other = h.loops.lookupSession("other")!;
    expect(await h.handle(await signedFrame("session.spawn", {
      approvalId: "bound", parentLoopId: other.loopId, task: "wrong parent",
    }))).toMatchObject({ reason: "approval_binding_mismatch" });
    expect(await h.handle(await signedFrame("session.send", {
      approvalId: "bound", loopId: target.loopId, message: "",
    }))).toMatchObject({ reason: "invalid_payload" });
    expect(h.approvals.claim("bound")).toBe(true);
    expect(h.gateway.send).not.toHaveBeenCalled();
    expect(h.gateway.spawn).not.toHaveBeenCalled();
  });

  it("retains the shared execution claim after ambiguous gateway errors", async () => {
    const h = harness();
    h.gateway.resolveApproval.mockRejectedValueOnce(new Error("response lost"));
    expect(await h.handle(await signedFrame("session.approve", { approvalId: "a" }))).toMatchObject({ reason: "gateway_error" });
    expect(h.approvals.claim("a")).toBe(false);
    expect(await h.handle(await signedFrame("session.deny", { approvalId: "a" }))).toMatchObject({ reason: "approval_already_executed" });
    expect(h.gateway.resolveApproval).toHaveBeenCalledTimes(1);
  });
});

describe("real approval executor single rail", () => {
  const cases = (["session.approve", "session.send", "session.abort", "session.spawn"] as const)
    .flatMap((type) => ["legacy-first", "session-first", "concurrent"].map((order) => ({ type, order })));
  it.each(cases)("$type: $order", async ({ type, order }) => {
    const h = harness();
    h.loops.onSessionStart({ sessionKey: "owner" });
    const target = h.loops.lookupSession("owner")!;
    const request = {
      proposalId: "native-approval", kind: "gateway-exec:command", summary: "safe",
      sourceRevision: "revision", detail: { approvalId: "native-approval" },
      owner: { sessionKey: target.sessionKey },
    };
    const source: ApprovalSource = {
      id: "gateway-exec", list: async () => [request], subscribe: () => () => {},
      getCurrent: async () => ({ pending: true, sourceRevision: "revision", detail: request.detail }),
      resolve: vi.fn(async () => ({ applied: true })),
    };
    let card: KernelApprovalRequestedPayload | undefined;
    const bridge = new GatewayApprovalsBridge(
      { agentDid: AGENT, operatorDid: PRINCIPAL, agentPrivateKeyHex: AGENT_PRIV },
      new Map([[source.id, source]]),
      { publishApprovalRequested: async (payload) => { card = payload; }, publishMismatch: async () => {} },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, undefined,
      { executionRegistry: h.approvals, loopTracker: h.loops, loopBlockSweepIntervalMs: 0 },
    );
    try {
      await bridge.reconcile();
      const legacy: KernelBusEventFrame = {
        type: "bus_event", eventType: "operator.approval.decided", issuer: PRINCIPAL,
        subject: AGENT, scope: "operator",
        payload: { proposalId: request.proposalId, decision: "approve", decidedBy: PRINCIPAL, contentHash: card!.contentHash },
      };
      const payload = type === "session.spawn"
        ? { approvalId: request.proposalId, parentLoopId: target.loopId, task: "converted task" }
        : { approvalId: request.proposalId, loopId: target.loopId, kind: "exec", message: "converted message" };
      const command = await signedFrame(type, payload);
      if (order === "legacy-first") {
        expect(await bridge.handleKernelDecision(legacy)).toBe("applied");
        expect(await h.handle(command)).toMatchObject({ reason: "approval_already_executed" });
      } else if (order === "session-first") {
        expect(await h.handle(command)).toMatchObject({ ok: true });
        expect(await bridge.handleKernelDecision(legacy)).toBe("noop");
      } else {
        await Promise.all([bridge.handleKernelDecision(legacy), h.handle(command)]);
      }
      expect(
        vi.mocked(source.resolve).mock.calls.length + h.gateway.resolveApproval.mock.calls.length +
        h.gateway.send.mock.calls.length + h.gateway.abort.mock.calls.length + h.gateway.spawn.mock.calls.length,
      ).toBe(1);
    } finally {
      bridge.dispose();
    }
  });
});

describe("rejections are attested, never silent, and never execute", () => {
  async function expectRejected(
    h: Harness,
    frame: SessionCommandFrame,
    reason: string,
    eventType = "loop.session.send.failed",
  ) {
    const outcome = await h.handle(frame);
    expect(outcome).toMatchObject({ ok: false, reason, eventType });
    expect(h.attestations).toHaveLength(1);
    expect(h.attestations[0].eventType).toBe(eventType);
    expect(h.attestations[0].payload).toMatchObject({ outcome: "failed", reason });
    expect(h.gateway.send).not.toHaveBeenCalled();
  }
  const send = { sessionKey: "k", message: "m" };

  it("unsigned command", async () => {
    const h = harness();
    const frame = await signedFrame("session.send", send);
    delete frame.signature;
    await expectRejected(h, frame, "unsigned");
  });

  it("malformed signature object counts as unsigned", async () => {
    const h = harness();
    const frame = await signedFrame("session.send", send);
    frame.signature = { keyId: "nope" };
    await expectRejected(h, frame, "unsigned");
  });

  it("misaddressed command (valid signature, wrong agent DID)", async () => {
    const h = harness();
    await expectRejected(h, await signedFrame("session.send", send, { to: "did:imajin:other-agent" }), "misaddressed");
  });

  it("signed by a key other than the pinned kernel key", async () => {
    const h = harness();
    await expectRejected(h, await signedFrame("session.send", send, {}, { kernel: ROGUE_PRIV }), "invalid_signature");
  });

  it("tampered payload invalidates the signature", async () => {
    const h = harness();
    const frame = await signedFrame("session.send", send);
    frame.payload = { sessionKey: "k", message: "something else" };
    await expectRejected(h, frame, "invalid_signature");
  });

  it("issuer other than the configured kernel DID", async () => {
    const h = harness();
    await expectRejected(h, await signedFrame("session.send", send, { issuer: "did:imajin:evil" }), "issuer_mismatch");
  });

  it("expired command", async () => {
    const h = harness();
    const frame = await signedFrame("session.send", send, {
      issuedAt: new Date(NOW - 10 * 60_000).toISOString(),
    });
    await expectRejected(h, frame, "expired");
  });

  it("explicit expiresAt in the past", async () => {
    const h = harness();
    const frame = await signedFrame("session.send", send, { expiresAt: new Date(NOW - 1).toISOString() });
    await expectRejected(h, frame, "expired");
  });

  it("issuedAt too far in the future", async () => {
    const h = harness();
    const frame = await signedFrame("session.send", send, { issuedAt: new Date(NOW + 10 * 60_000).toISOString() });
    await expectRejected(h, frame, "not_yet_valid");
  });

  it("replayed commandId is rejected after the first execution", async () => {
    const h = harness();
    const frame = await signedFrame("session.send", send);
    expect(await h.handle(frame)).toMatchObject({ ok: true });
    const replay = await h.handle(frame);
    expect(replay).toMatchObject({ ok: false, reason: "replayed" });
    expect(h.gateway.send).toHaveBeenCalledTimes(1);
    expect(h.attestations).toHaveLength(2);
  });

  it("an unauthenticated frame cannot burn a commandId", async () => {
    const h = harness();
    const good = await signedFrame("session.send", send);
    const forged = { ...good, signature: await signedFrame("session.send", send, {}, { kernel: ROGUE_PRIV }).then((f) => f.signature) };
    expect(await h.handle(forged)).toMatchObject({ reason: "invalid_signature" });
    expect(await h.handle(good)).toMatchObject({ ok: true });
  });

  it("principal not in the agent's serviceOf", async () => {
    const h = harness({}, { serviceOf: ["did:imajin:someone-else"] });
    await expectRejected(h, await signedFrame("session.send", send), "not_service_of");
  });

  it("serviceOf unresolvable (null or error) fails closed", async () => {
    for (const serviceOf of [null, new Error("kernel down")]) {
      const h = harness({}, { serviceOf });
      await expectRejected(h, await signedFrame("session.send", send), "service_binding_unverifiable");
    }
  });

  it("principal other than the configured actAs", async () => {
    const h = harness({ allowedPrincipal: "did:imajin:different" });
    await expectRejected(h, await signedFrame("session.send", send), "principal_mismatch");
    expect(h.resolveServiceOf).not.toHaveBeenCalled();
  });

  it("missing principal countersignature", async () => {
    const h = harness();
    await expectRejected(h, await signedFrame("session.send", send, {}, { principal: null }), "missing_countersignature");
  });

  it("countersignature from a key other than the principal's", async () => {
    const h = harness();
    await expectRejected(h, await signedFrame("session.send", send, {}, { principal: ROGUE_PRIV }), "invalid_countersignature");
  });

  it("countersignature unverifiable when the principal's key cannot be resolved", async () => {
    const h = harness({}, { principalKey: null });
    await expectRejected(h, await signedFrame("session.send", send), "invalid_countersignature");
  });

  it("countersignature can be made optional, but the kernel grant never is", async () => {
    const h = harness({ requirePrincipalCountersignature: false });
    expect(await h.handle(await signedFrame("session.send", send, {}, { principal: null }))).toMatchObject({ ok: true });
    const unsigned = await signedFrame("session.send", send);
    delete unsigned.signature;
    expect(await h.handle(unsigned)).toMatchObject({ ok: false, reason: "unsigned" });
  });

  it.each([
    ["session.approve", "loop.session.approve.failed"],
    ["session.deny", "loop.session.deny.failed"],
    ["session.abort", "loop.session.abort.failed"],
    ["session.spawn", "loop.session.spawn.failed"],
  ] as const)("a misaddressed %s is attested as %s", async (type, eventType) => {
    const h = harness();
    const outcome = await h.handle(await signedFrame(type, {}, { to: "did:imajin:other" }));
    expect(outcome).toMatchObject({ ok: false, reason: "misaddressed", eventType });
    expect(h.attestations[0].eventType).toBe(eventType);
  });

  it("a frame missing its envelope is malformed and still attested (commandId 'unknown')", async () => {
    const h = harness();
    const outcome = await h.handle({ type: "session.send", payload: send });
    expect(outcome).toMatchObject({ ok: false, reason: "malformed", eventType: "loop.session.send.failed" });
    expect(h.attestations[0].payload.commandId).toBe("unknown");
  });

  it("attests even when the attester itself fails (logged, outcome still returned)", async () => {
    const gateway = fakeGateway();
    const error = vi.fn();
    const executor = createSessionCommandExecutor(
      { agentDid: AGENT, kernelPublicKeyHex: kernelPub },
      {
        gateway,
        attest: async () => {
          throw new Error("ws closed");
        },
        resolveServiceOf: async () => [PRINCIPAL],
        resolvePublicKey: async () => principalPub,
        logger: { info: vi.fn(), warn: vi.fn(), error },
        now: () => NOW,
      },
    );
    const outcome = await executor.handleFrame(await signedFrame("session.send", send));
    expect(outcome).toMatchObject({ ok: true });
    expect(error).toHaveBeenCalled();
  });
});

describe("createSessionCommandAttester", () => {
  it("sends a frame typed as the loop event whose attestation verifies against the agent key", async () => {
    const sent: unknown[] = [];
    const attest = createSessionCommandAttester({
      did: AGENT,
      keypairPath: "/fake/keypair.json",
      send: (frame) => sent.push(frame),
    });
    const payload: SessionCommandAttestationPayload = {
      eventType: "loop.session.send.completed",
      commandId: "cmd-1",
      command: "session.send",
      outcome: "completed",
      principal: PRINCIPAL,
      issuer: KERNEL,
      payloadHash: hashPayload({ a: 1 }),
      at: new Date(NOW).toISOString(),
    };

    await attest("loop.session.send.completed", payload);

    expect(sent).toHaveLength(1);
    const frame = sent[0] as { type: string; attestation: SignedMessage<SessionCommandAttestationPayload> };
    expect(frame.type).toBe("loop.session.send.completed");
    expect(frame.attestation.from).toBe(AGENT);
    expect(frame.attestation.type).toBe("agent");
    expect(frame.attestation.payload).toEqual(payload);
    expect(await verifyMessage(frame.attestation, agentPub)).toBe(true);
    expect(await verifyMessage(frame.attestation, kernelPub)).toBe(false);
  });

  it("end to end: a rejection through the real attester yields a verifiable signed failed frame", async () => {
    const sent: unknown[] = [];
    const executor = createSessionCommandExecutor(
      { agentDid: AGENT, kernelPublicKeyHex: kernelPub },
      {
        gateway: fakeGateway(),
        attest: createSessionCommandAttester({ did: AGENT, keypairPath: "/fake", send: (f) => sent.push(f) }),
        resolveServiceOf: async () => [PRINCIPAL],
        resolvePublicKey: async () => principalPub,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        now: () => NOW,
      },
    );
    const frame = await signedFrame("session.send", { sessionKey: "k", message: "m" });
    delete frame.signature;
    await executor.handleFrame(frame);

    const out = sent[0] as { type: string; attestation: SignedMessage<SessionCommandAttestationPayload> };
    expect(out.type).toBe("loop.session.send.failed");
    expect(out.attestation.payload.reason).toBe("unsigned");
    expect(await verifyMessage(out.attestation, agentPub)).toBe(true);
  });
});
