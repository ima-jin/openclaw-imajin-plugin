import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { canonicalize } from "./approval-bridge.js";
import { ApprovalsStateStore } from "./approvals-state.js";
import { ApprovalsCursorStore } from "./approvals-catchup.js";
import {
  GatewayApprovalsBridge, buildDigestFields, computeContentHash,
  type KernelApprovalRequestedPayload, type KernelBusEventFrame,
} from "./gateway-approvals-bridge.js";
import { createLoopTracker } from "./loop-tracker.js";
import { createGatewayExecSource, type GatewayExecApprovalRecord } from "./sources/gateway-exec.js";

const agentDid = "did:imajin:agent";
const sessionKey = "agent:main:private-local-destination";
const bridges: GatewayApprovalsBridge[] = [];
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose(); });

async function setup(principal: string, legacy = false, persisted = false) {
  const agentKey = randomBytes(32);
  const operatorKey = randomBytes(32);
  const publicKey = Buffer.from(await ed.getPublicKeyAsync(operatorKey)).toString("hex");
  const record: GatewayExecApprovalRecord = {
    id: "exec-wire", createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    request: { command: "printf approved", host: "gateway", cwd: "/work", agentId: "main", sessionKey },
  };
  let live!: (record: GatewayExecApprovalRecord) => void;
  const client = {
    list: vi.fn(async () => [record]), resolve: vi.fn(async () => ({ applied: true })),
    onRequested: (handler: typeof live) => { live = handler; }, onFinished: () => {},
  };
  const source = createGatewayExecSource(client, { agentDid });
  const [request] = await source.list();
  const tracker = createLoopTracker({ did: agentDid, emit: () => {} });
  tracker.onSessionSnapshot({ key: sessionKey, sessionId: "local-session" });
  const target = tracker.lookupSession(sessionKey)!;
  const scope = { nodeUrl: "https://kernel.test", agentDid, operatorDid: principal };
  const file = join(await mkdtemp(join(tmpdir(), "plugin-wire-")), "state.json");
  const store = new ApprovalsStateStore(file, scope);
  if (legacy || persisted) {
    const detail = { ...request.detail, ...(legacy ? { sessionKey } : {}) };
    const digest = buildDigestFields({ ...request, source: source.id, detail });
    store.proposals.set(record.id, {
      sourceId: source.id, owner: request.owner, kind: request.kind, summary: request.summary,
      detail: digest.detail, sourceRevision: request.sourceRevision,
      contentHash: await computeContentHash(digest), expiresAtMs: record.expiresAtMs,
    });
    await store.persist();
  }
  const restarted = new ApprovalsStateStore(file, scope);
  await restarted.load();
  const kernel = {
    publishApprovalRequested: vi.fn(async (_payload: KernelApprovalRequestedPayload) => {}),
    publishMismatch: vi.fn(async () => {}),
  };
  const publishBinding = vi.fn(async () => {});
  const bridge = new GatewayApprovalsBridge(
    { agentDid, operatorDid: principal, agentPrivateKeyHex: agentKey.toString("hex"), requireOperatorCountersignature: true },
    new Map([[source.id, source]]), kernel,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    { resolveOperatorPublicKey: async () => publicKey }, undefined,
    { stateStore: restarted, loopTracker: tracker, publishApprovalBinding: publishBinding, loopBlockSweepIntervalMs: 0 },
  );
  bridges.push(bridge);
  async function decision(): Promise<KernelBusEventFrame> {
    const contentHash = restarted.proposals.get(record.id)!.contentHash;
    const decidedAt = new Date().toISOString();
    const sig = await ed.signAsync(new TextEncoder().encode(canonicalize({
      contentHash: contentHash.slice("sha256:".length), decision: "approve", decidedAt,
    })), operatorKey);
    return {
      type: "bus_event", eventType: "operator.approval.decided", issuer: principal, subject: agentDid, scope: "operator",
      payload: {
        proposalId: record.id, decidedBy: principal, decision: "approve", decidedAt, contentHash,
        operatorSignature: { keyId: publicKey, alg: "ed25519", sig: Buffer.from(sig).toString("hex") },
      },
    };
  }
  return { bridge, kernel, record, client, source, restarted, target, publishBinding, decision, live: () => live(record) };
}

describe.each(["did:imajin:personal", "did:imajin:org"])("exec wire under %s", (principal) => {
  it.each(["live", "reconcile"])("publishes and resolves a public-only %s card with a native binding", async (mode) => {
    const h = await setup(principal);
    if (mode === "live") h.live();
    else await h.bridge.reconcile();
    await vi.waitFor(() => expect(h.kernel.publishApprovalRequested).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.publishBinding).toHaveBeenCalledOnce());
    const wire = h.kernel.publishApprovalRequested.mock.calls[0][0];
    expect(wire.detail).not.toHaveProperty("sessionKey");
    expect(JSON.stringify(wire)).not.toContain(sessionKey);
    const { contentHash, signature, signerDid, ...digest } = wire;
    expect(contentHash).toBe(`sha256:${createHash("sha256").update(canonicalize(digest)).digest("hex")}`);
    expect(signerDid).toBe(agentDid);
    expect(signature).toMatch(/^[a-f0-9]{128}$/);
    expect(h.restarted.proposals.get(h.record.id)?.owner).toEqual({ sessionKey });
    expect(await h.bridge.handleKernelDecision(await h.decision())).toBe("applied");
    expect(h.client.resolve).toHaveBeenCalledWith(h.record.id, "allow-once");
  });

  it.each([false, true])("replays a restarted card (legacy=%s) without a kernel session echo", async (legacy) => {
    const h = await setup(principal, legacy, true);
    await h.bridge.reconcile();
    const frame = await h.decision();
    const http = { requestRaw: vi.fn(async () => ({
      status: 200, contentType: "application/json", text: JSON.stringify({
        entitledEventTypes: ["operator.approval.decided"], nextCursor: "1",
        events: [{ ...frame, id: "decision", cursor: "1", occurredAt: new Date().toISOString() }],
      }),
    })) };
    const cursorStore = new ApprovalsCursorStore(undefined, { nodeUrl: "https://kernel.test", agentDid });
    await h.bridge.syncWithKernel({ http, cursorStore, operatorDid: principal });
    expect(h.client.resolve).toHaveBeenCalledWith(h.record.id, "allow-once");
    await h.bridge.handleKernelDecision(frame);
    expect(h.client.resolve).toHaveBeenCalledOnce();
    expect(h.kernel.publishApprovalRequested).not.toHaveBeenCalled();
    expect(cursorStore.get()).toBe("1");
  });

  it.each(["hash", "command", "cwd", "expiry", "issuer", "countersignature"])(
    "rejects %s drift on a restarted legacy card before execution", async (drift) => {
      const h = await setup(principal, true);
      const frame = await h.decision();
      if (drift === "hash") frame.payload!.contentHash = "sha256:tampered";
      if (drift === "command") h.record.request.command = "different command";
      if (drift === "cwd") h.record.request.cwd = "/different";
      if (drift === "expiry") h.record.expiresAtMs += 1000;
      if (drift === "issuer") frame.issuer = "did:imajin:foreign";
      if (drift === "countersignature") frame.payload!.operatorSignature = { invalid: true };
      expect(await h.bridge.handleKernelDecision(frame)).toBe("rejected");
      expect(h.client.resolve).not.toHaveBeenCalled();
    },
  );
});

it("documents publisher-first release ordering and the private harness map", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf-8");
  expect(readme).toContain("ship the clean loop/exec publisher before deploying imajin-ai PR #3265");
  expect(readme).toContain("newly started loops retain native command authority");
  expect(readme).toContain("keep the session-to-loop map private to the harness");
});
