import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as ed from "@noble/ed25519";
import {
  ENTITLEMENT_CHECK_INTERVAL_MS,
  GatewayApprovalsBridge,
  signCanonicalPayload,
  type KernelApprovalRequestedPayload,
  type KernelBusEventFrame,
} from "./gateway-approvals-bridge.js";
import { ApprovalsCursorStore, type CaughtUpEvent } from "./approvals-catchup.js";
import { ApprovalsStateStore } from "./approvals-state.js";
import { sendDirectChannelMessage } from "./channel-notify.js";
import { createSystemAgentSource, type SystemAgentApprovalRequestRecord } from "./sources/system-agent.js";
import { createGatewayExecSource, type GatewayExecApprovalRecord } from "./sources/gateway-exec.js";

const scope = { nodeUrl: "https://kernel.invalid", agentDid: "did:imajin:agent", operatorDid: "did:imajin:operator" };
const bridges: GatewayApprovalsBridge[] = [];
const operatorKey = ed.utils.randomPrivateKey();

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  vi.useRealTimers();
});

function record(id = "system-agent:restart"): SystemAgentApprovalRequestRecord {
  return {
    id, createdAtMs: Date.now(), expiresAtMs: Date.now() + 3_600_000,
    request: {
      title: "Restart", description: "Restart the Gateway", command: "gateway restart",
      proposalHash: "a".repeat(64), allowedDecisions: ["allow-once", "deny"],
    },
  };
}

async function harness(statePath?: string, sourceId = "system-agent") {
  const publicKey = Buffer.from(await ed.getPublicKeyAsync(operatorKey)).toString("hex");
  const privateKeyHex = Buffer.from(operatorKey).toString("hex");
  const store = new ApprovalsStateStore(statePath, scope);
  await store.load();
  const state = {
    entitled: true,
    records: [record()],
    events: [] as CaughtUpEvent[],
    now: Date.now(),
  };
  const list = vi.fn(async () => state.records);
  const resolve = vi.fn(async () => ({ applied: true }));
  const source = createSystemAgentSource({
    list, resolve, onRequested: vi.fn(),
    get: vi.fn(async (id) => {
      const live = (await list()).find((r) => r.id === id);
      return live ? {
        status: "pending" as const, expiresAtMs: live.expiresAtMs,
        presentation: { proposalHash: live.request.proposalHash },
      } : null;
    }),
  });
  const execSource = createGatewayExecSource({
    list: async () => state.records.map((r): GatewayExecApprovalRecord => ({
      ...r, request: { command: "printf safe", host: "gateway" },
    })),
    resolve, onRequested: vi.fn(), onFinished: vi.fn(),
  }, { agentDid: scope.agentDid });
  const publishApprovalRequested = vi.fn(async (_payload: KernelApprovalRequestedPayload) => {});
  const sendText = vi.fn(async (_ctx: { to: string; text: string }) => ({ outcome: "sent" }));
  const notify = (text: string) => sendDirectChannelMessage({ channel: "telegram", target: "operator-test" }, text, {
    runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText }) } } },
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const bridge = new GatewayApprovalsBridge({
    ...scope, agentPrivateKeyHex: privateKeyHex, requireOperatorCountersignature: true,
  }, new Map([[sourceId, sourceId === "gateway-exec" ? execSource : source]]),
  { publishApprovalRequested, publishMismatch: vi.fn() }, logger,
  { resolveOperatorPublicKey: async () => publicKey }, notify, { stateStore: store, now: () => state.now });
  bridges.push(bridge);
  const requestRaw = vi.fn(async (url: string) => {
    expect(url).toMatch(/^\/auth\/api\/events\/subscriptions\/catchup\?/);
    const cursor = Number(new URL(url, scope.nodeUrl).searchParams.get("cursor"));
    const events = state.entitled ? state.events.filter((e) => Number(e.cursor) > cursor) : [];
    return {
      status: 200, contentType: "application/json",
      text: JSON.stringify({
        events, nextCursor: events.at(-1)?.cursor ?? String(cursor),
        entitledEventTypes: state.entitled ? ["operator.approval.decided"] : [],
      }),
    };
  });
  const deps = {
    http: { requestRaw }, cursorStore: new ApprovalsCursorStore(undefined, scope), operatorDid: scope.operatorDid,
  };
  const payload = () => publishApprovalRequested.mock.calls.at(-1)![0];
  const signedFrame = async (decision = "approve", hash = payload().contentHash): Promise<KernelBusEventFrame> => {
    const fields = { contentHash: hash.replace(/^sha256:/, ""), decision, decidedAt: new Date(state.now).toISOString() };
    return {
      type: "bus_event", eventType: "operator.approval.decided",
      issuer: scope.operatorDid, subject: scope.agentDid, scope: "operator",
      payload: {
        ...fields, proposalId: payload().proposalId, contentHash: hash, decidedBy: scope.operatorDid,
        operatorSignature: { alg: "ed25519", keyId: publicKey, sig: await signCanonicalPayload(fields, privateKeyHex) },
      },
    };
  };
  return { bridge, state, store, list, resolve, publishApprovalRequested, sendText, logger, requestRaw, deps, payload, signedFrame };
}

describe("approvals lifecycle (#103/#89)", () => {
  it("lapses mid-connection, marks the next card and warns once; renewal catches up within 5 min without reconnect", async () => {
    vi.useFakeTimers();
    const h = await harness();
    await h.bridge.runPreflight(h.deps.http, scope.operatorDid);
    h.bridge.startEntitlementMonitoring(h.deps);
    await h.bridge.reconcile();
    h.state.entitled = false;
    h.state.now += ENTITLEMENT_CHECK_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(ENTITLEMENT_CHECK_INTERVAL_MS);
    expect(h.bridge.isDegraded()).toBe(true);
    h.state.records.push(record("system-agent:config"));
    await h.bridge.reconcile();
    expect(h.payload().detail.bridge).toEqual({
      degraded: true, reason: "agent lacks operator:approvals", fix: "/auth/agents",
    });
    await h.bridge.reconcile();
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText.mock.calls[0][0]).toMatchObject({ to: "operator-test", text: expect.stringContaining("/auth/agents") });
    const frame = await h.signedFrame();
    h.state.events = [{
      id: "decision-1", cursor: "1", eventType: frame.eventType, issuer: frame.issuer, subject: frame.subject,
      scope: frame.scope, payload: frame.payload!, correlationId: null, occurredAt: new Date().toISOString(), grantId: "grant-1",
    }];
    h.state.entitled = true;
    h.state.now += ENTITLEMENT_CHECK_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(ENTITLEMENT_CHECK_INTERVAL_MS);
    await h.bridge.syncWithKernel(h.deps);
    expect(h.bridge.isDegraded()).toBe(false);
    expect(h.resolve).toHaveBeenCalledWith("system-agent:config", "allow-once");
    expect(h.deps.cursorStore.get()).toBe("1");
    expect(h.sendText).toHaveBeenCalledTimes(1);
    h.bridge.dispose();
    const reads = h.requestRaw.mock.calls.length;
    await vi.advanceTimersByTimeAsync(ENTITLEMENT_CHECK_INTERVAL_MS);
    expect(h.requestRaw).toHaveBeenCalledTimes(reads);
  });

  it("rechecks stale entitlement before publishing even if the interval has not fired", async () => {
    const h = await harness();
    await h.bridge.runPreflight(h.deps.http, scope.operatorDid);
    h.bridge.startEntitlementMonitoring(h.deps);
    h.state.entitled = false;
    h.state.now += ENTITLEMENT_CHECK_INTERVAL_MS;
    await h.bridge.reconcile();
    expect(h.requestRaw).toHaveBeenCalledTimes(2);
    expect(h.payload().detail.bridge).toMatchObject({ degraded: true, fix: "/auth/agents" });
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("T-24h/T-1h warnings unavailable"));
  });

  it("the first publish checks entitlement even before startup preflight has completed", async () => {
    const h = await harness();
    h.state.entitled = false;
    h.bridge.startEntitlementMonitoring(h.deps);
    await h.bridge.reconcile();
    expect(h.requestRaw).toHaveBeenCalledTimes(1);
    expect(h.payload().detail.bridge).toMatchObject({ degraded: true });
  });

  it("pre-publish renewal detection immediately reconciles and catches up without a timer tick or reservation deadlock", async () => {
    const h = await harness();
    h.state.entitled = false;
    h.bridge.startEntitlementMonitoring(h.deps);
    await h.bridge.runPreflight(h.deps.http, scope.operatorDid);
    await h.bridge.reconcile();
    const frame = await h.signedFrame();
    h.state.events = [{
      id: "decision-1", cursor: "1", eventType: frame.eventType, issuer: frame.issuer, subject: frame.subject,
      scope: frame.scope, payload: frame.payload!, correlationId: null, occurredAt: new Date().toISOString(), grantId: "grant-1",
    }];
    h.state.entitled = true;
    h.state.now += ENTITLEMENT_CHECK_INTERVAL_MS;
    h.state.records.push(record("system-agent:next"));
    await h.bridge.reconcile();
    await h.bridge.syncWithKernel(h.deps);
    expect(h.bridge.isDegraded()).toBe(false);
    expect(h.resolve).toHaveBeenCalledWith("system-agent:restart", "allow-once");
    expect(h.payload().detail.bridge).toBeUndefined();
  });

  it.each(["system-agent", "gateway-exec"])("%s publishes the Gateway record's exact expiry and never resolves past it", async (sourceId) => {
    const h = await harness(undefined, sourceId);
    await h.bridge.reconcile();
    expect(h.payload().detail.expiresAt).toBe(new Date(h.state.records[0].expiresAtMs).toISOString());
    const frame = await h.signedFrame();
    h.state.now = h.state.records[0].expiresAtMs;
    await expect(h.bridge.handleKernelDecision(frame)).resolves.toBe("noop");
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.store.outcomes.get(h.payload().proposalId)).toBe("expired/superseded");
    expect(h.sendText).toHaveBeenCalledTimes(1);
  });

  it("stage restart → Gateway restarts/source empty → valid signed approve: zero resolve calls and expired outcome (route gap)", async () => {
    const h = await harness();
    await h.bridge.reconcile();
    const frame = await h.signedFrame();
    h.state.records = [];
    await expect(h.bridge.handleKernelDecision(frame)).resolves.toBe("noop");
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.store.outcomes.get("system-agent:restart")).toBe("expired/superseded");
    await h.bridge.handleKernelDecision(frame);
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText.mock.calls[0][0]).toMatchObject({ text: expect.stringContaining("imajin-ai#3019") });
  });

  it("boot and reconnect reconcile retire persisted orphans even while entitlement is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "approvals-lifecycle-"));
    const file = path.join(dir, "state.json");
    const first = await harness(file);
    await first.bridge.reconcile();
    const frame = await first.signedFrame();
    await first.store.persist();
    first.bridge.dispose();
    const boot = await harness(file);
    boot.state.records = [];
    boot.state.entitled = false;
    await boot.bridge.syncWithKernel(boot.deps);
    expect(boot.bridge.isPublished("system-agent:restart")).toBe(false);
    expect(boot.store.outcomes.get("system-agent:restart")).toBe("expired/superseded");
    await boot.bridge.handleKernelDecision(frame);
    await boot.bridge.syncWithKernel(boot.deps);
    expect(boot.resolve).not.toHaveBeenCalled();
    expect(boot.sendText).toHaveBeenCalledTimes(1);
  });

  it("failed source lists preserve tracked cards; expired live discoveries never publish or resolve", async () => {
    const h = await harness();
    await h.bridge.reconcile();
    h.list.mockRejectedValueOnce(new Error("Gateway offline"));
    await h.bridge.reconcile();
    expect(h.bridge.isPublished("system-agent:restart")).toBe(true);
    expect(h.sendText).not.toHaveBeenCalled();
    h.state.now = h.state.records[0].expiresAtMs;
    await h.bridge.reconcile();
    expect(h.publishApprovalRequested).toHaveBeenCalledTimes(1);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.sendText).toHaveBeenCalledTimes(1);
  });

  it("a concurrent reconcile retirement cannot be undone by an earlier in-flight source read", async () => {
    const h = await harness();
    await h.bridge.reconcile();
    const frame = await h.signedFrame();
    h.list.mockImplementationOnce(async () => {
      const previous = h.state.records;
      h.state.records = [];
      await h.bridge.reconcile();
      return previous;
    });
    await expect(h.bridge.handleKernelDecision(frame)).resolves.toBe("noop");
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.store.outcomes.get("system-agent:restart")).toBe("expired/superseded");
  });

  it("dedupes degraded warnings across publish attempts and two boots", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "approvals-dedupe-"));
    const file = path.join(dir, "state.json");
    const first = await harness(file);
    first.bridge.markDegraded("missing grant");
    await first.bridge.reconcile();
    await first.bridge.reconcile();
    await vi.waitFor(() => expect(first.store.warnings.has("degraded:system-agent:restart")).toBe(true));
    await first.store.persist();
    first.bridge.dispose();
    // Force a republish on the next boot, retaining the durable warning ledger.
    const saved = JSON.parse(await readFile(file, "utf-8"));
    saved.proposals = {};
    await writeFile(file, JSON.stringify(saved));
    const second = await harness(file);
    second.bridge.markDegraded("missing grant");
    await second.bridge.reconcile();
    await second.bridge.reconcile();
    expect(first.sendText).toHaveBeenCalledTimes(1);
    expect(second.publishApprovalRequested).toHaveBeenCalledTimes(1);
    expect(second.sendText).not.toHaveBeenCalled();
  });
});
