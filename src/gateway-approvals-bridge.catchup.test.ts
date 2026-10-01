import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_SKILL_WORKSHOP_OPERATOR_SCOPES,
  GatewayApprovalsBridge,
  resolveSkillWorkshopOperatorScopes,
  type KernelBusEventFrame,
  type KernelNotifyClient,
} from "./gateway-approvals-bridge.js";
import {
  APPROVALS_CURSOR_FILENAME,
  APPROVAL_DECIDED_EVENT_TYPE,
  ApprovalsCursorStore,
  SUBSCRIPTION_CATCHUP_PATH,
  type CaughtUpEvent,
  type KernelHttp,
} from "./approvals-catchup.js";
import {
  createSystemAgentSource,
  type GatewayApprovalsClient,
  type GatewayApprovalSnapshot,
  type SystemAgentApprovalRequestRecord,
} from "./sources/system-agent.js";
import type { ApprovalSource } from "./sources/types.js";

if ("hashes" in ed && ed.hashes) {
  (ed.hashes as { sha512?: typeof sha512 }).sha512 = sha512;
}

const OPERATOR_DID = "did:imajin:operator";
const AGENT_DID = "did:imajin:agent";
const NODE_URL = "https://jin.example";
const PROPOSAL_ID = "system-agent:abc123";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function makeRecord(overrides: Partial<SystemAgentApprovalRequestRecord> = {}): SystemAgentApprovalRequestRecord {
  return {
    id: PROPOSAL_ID,
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

function pendingSnapshot(proposalHash: string): GatewayApprovalSnapshot {
  return { status: "pending", presentation: { proposalHash } };
}

function decidedFrame(contentHash: string, overrides: Partial<KernelBusEventFrame> = {}): KernelBusEventFrame {
  return {
    type: "bus_event",
    eventType: APPROVAL_DECIDED_EVENT_TYPE,
    issuer: OPERATOR_DID,
    subject: OPERATOR_DID,
    scope: "operator",
    payload: {
      proposalId: PROPOSAL_ID,
      decision: "approve",
      decidedBy: OPERATOR_DID,
      decidedAt: new Date().toISOString(),
      contentHash,
    },
    ...overrides,
  };
}

function decidedLogRow(seq: number, contentHash: string, subject = AGENT_DID): CaughtUpEvent {
  return {
    id: `evt-${seq}`,
    cursor: String(seq),
    eventType: APPROVAL_DECIDED_EVENT_TYPE,
    issuer: OPERATOR_DID,
    subject,
    scope: "operator",
    payload: {
      proposalId: PROPOSAL_ID,
      decision: "approve",
      decidedBy: OPERATOR_DID,
      decidedAt: new Date().toISOString(),
      contentHash,
    },
    correlationId: null,
    occurredAt: new Date().toISOString(),
    grantId: "grant-1",
  };
}

/** Mock of the kernel catch-up route whose entitlement + event log can change between calls (grant authored later, etc.). */
function mutableKernel(initial: { entitled: boolean; events?: CaughtUpEvent[] }) {
  const state = { entitled: initial.entitled, events: initial.events ?? [] };
  const requestRaw = vi.fn(async (requestPath: string) => {
    const url = new URL(requestPath, NODE_URL);
    expect(url.pathname).toBe(SUBSCRIPTION_CATCHUP_PATH);
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const rows = state.entitled ? state.events.filter((e) => Number(e.cursor) > cursor).slice(0, limit) : [];
    const nextCursor = rows.length ? rows[rows.length - 1].cursor : String(cursor);
    return {
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({
        events: rows,
        nextCursor,
        entitledEventTypes: state.entitled ? [APPROVAL_DECIDED_EVENT_TYPE] : ["message.send"],
      }),
    };
  });
  return { state, requestRaw, http: { requestRaw } as KernelHttp };
}

describe("GatewayApprovalsBridge — #53 preflight, degraded mode, catch-up", () => {
  let dir: string;
  let gateway: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    resolve: ReturnType<typeof vi.fn>;
    onRequested: ReturnType<typeof vi.fn>;
  };
  let kernel: { publishApprovalRequested: ReturnType<typeof vi.fn>; publishMismatch: ReturnType<typeof vi.fn> };
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let notifyOperator: ReturnType<typeof vi.fn>;
  let requestedHandler: ((record: SystemAgentApprovalRequestRecord) => void) | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "approvals-bridge-"));
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
    notifyOperator = vi.fn().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function newBridge(withNotifier = true): Promise<GatewayApprovalsBridge> {
    const privateKey = ed.utils.randomPrivateKey();
    const source = createSystemAgentSource(gateway as unknown as GatewayApprovalsClient);
    return new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: bytesToHex(privateKey) },
      new Map<string, ApprovalSource>([["system-agent", source]]),
      kernel as unknown as KernelNotifyClient,
      logger,
      undefined,
      withNotifier ? notifyOperator : undefined,
    );
  }

  async function newCursorStore(): Promise<ApprovalsCursorStore> {
    const store = new ApprovalsCursorStore(
      path.join(dir, APPROVALS_CURSOR_FILENAME),
      { nodeUrl: NODE_URL, agentDid: AGENT_DID },
      logger,
    );
    await store.load();
    return store;
  }

  async function publishProposal(): Promise<string> {
    requestedHandler!(makeRecord());
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalled());
    const calls = kernel.publishApprovalRequested.mock.calls;
    return calls[calls.length - 1][0].contentHash as string;
  }

  describe("preflight", () => {
    it("with the capability: not degraded, no error logged, nothing sent to the operator", async () => {
      const bridge = await newBridge();
      const { http } = mutableKernel({ entitled: true });
      await expect(bridge.runPreflight(http, OPERATOR_DID)).resolves.toEqual({ state: "entitled" });

      expect(bridge.isDegraded()).toBe(false);
      expect(logger.error).not.toHaveBeenCalled();
      await publishProposal();
      expect(notifyOperator).not.toHaveBeenCalled();
    });

    it("without the capability: logs ONE startup ERROR (agent DID + capability + exact grant) and marks the bridge degraded", async () => {
      const bridge = await newBridge();
      const { http } = mutableKernel({ entitled: false });
      await bridge.runPreflight(http, OPERATOR_DID);

      expect(bridge.isDegraded()).toBe(true);
      expect(logger.error).toHaveBeenCalledTimes(1);
      const message = String(logger.error.mock.calls[0][0]);
      expect(message).toContain(AGENT_DID);
      expect(message).toContain("operator:approvals");
      expect(message).toContain("POST /auth/api/grants");
      expect(message).toContain(OPERATOR_DID);

      // Re-checks while still missing (every reconnect) must not spam more errors.
      await bridge.runPreflight(http, OPERATOR_DID);
      await bridge.runPreflight(http, OPERATOR_DID);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(bridge.isDegraded()).toBe(true);
    });

    it("an inconclusive check (kernel unreachable) does not flip state and is retried later", async () => {
      const bridge = await newBridge();
      const http: KernelHttp = { requestRaw: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
      await expect(bridge.runPreflight(http, OPERATOR_DID)).resolves.toMatchObject({ state: "unknown" });
      expect(bridge.isDegraded()).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not verify operator:approvals"));
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("recovers when the grant is authored later, and clears the degraded warning", async () => {
      const bridge = await newBridge();
      const kernelMock = mutableKernel({ entitled: false });
      await bridge.runPreflight(kernelMock.http, OPERATOR_DID);
      expect(bridge.isDegraded()).toBe(true);

      kernelMock.state.entitled = true;
      await bridge.runPreflight(kernelMock.http, OPERATOR_DID);
      expect(bridge.isDegraded()).toBe(false);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("bridge recovered"));

      await publishProposal();
      expect(notifyOperator).not.toHaveBeenCalled();
    });
  });

  describe("degraded-mode publish", () => {
    it("surfaces the warning on EVERY publish and never alters the signed card (summary/contentHash stay stable)", async () => {
      const bridge = await newBridge();
      await bridge.runPreflight(mutableKernel({ entitled: false }).http, OPERATOR_DID);
      logger.error.mockClear();

      const record = makeRecord();
      requestedHandler!(record);
      await vi.waitFor(() => expect(notifyOperator).toHaveBeenCalledTimes(1));
      requestedHandler!(makeRecord({ id: "system-agent:second" }));
      await vi.waitFor(() => expect(notifyOperator).toHaveBeenCalledTimes(2));

      const warning = String(notifyOperator.mock.calls[0][0]);
      expect(warning).toContain("⚠ bridge cannot apply: agent lacks operator:approvals");
      expect(warning).toContain(PROPOSAL_ID);
      expect(warning).toContain(AGENT_DID);
      expect(String(notifyOperator.mock.calls[1][0])).toContain("system-agent:second");

      // Hash stability: the card is exactly what a non-degraded publish would be.
      const published = kernel.publishApprovalRequested.mock.calls[0][0];
      expect(published.summary).toBe(record.request.description);
      expect(published.summary).not.toContain("⚠");
      // The warning is always in the log too, so it is visible even without directSend.
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("⚠ bridge cannot apply"));
    });

    it("still logs the warning when no notify channel is configured", async () => {
      const bridge = await newBridge(false);
      await bridge.runPreflight(mutableKernel({ entitled: false }).http, OPERATOR_DID);
      logger.error.mockClear();
      await publishProposal();
      await vi.waitFor(() =>
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("⚠ bridge cannot apply")),
      );
    });

    it("a failing notify channel never breaks the publish", async () => {
      notifyOperator.mockRejectedValue(new Error("telegram down"));
      const bridge = await newBridge();
      await bridge.runPreflight(mutableKernel({ entitled: false }).http, OPERATOR_DID);
      await publishProposal();
      await vi.waitFor(() =>
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to send degraded-bridge warning")),
      );
      expect(bridge.isPublished(PROPOSAL_ID)).toBe(true);
    });
  });

  describe("syncWithKernel (connect/reconnect catch-up)", () => {
    it("applies a decision the socket missed (agent-addressed copy), exactly once, and persists the cursor", async () => {
      const bridge = await newBridge();
      const contentHash = await publishProposal();
      gateway.get.mockResolvedValue(pendingSnapshot("a".repeat(64)));
      const kernelMock = mutableKernel({ entitled: true, events: [decidedLogRow(7, contentHash)] });

      const store = await newCursorStore();
      await bridge.syncWithKernel({ http: kernelMock.http, cursorStore: store, operatorDid: OPERATOR_DID });

      expect(gateway.resolve).toHaveBeenCalledTimes(1);
      expect(gateway.resolve).toHaveBeenCalledWith(PROPOSAL_ID, "allow-once");
      expect(store.get()).toBe("7");
      expect(bridge.isPublished(PROPOSAL_ID)).toBe(false);
    });

    it("reconnect replay: the same decision offered again (cursor lost / re-read) is a no-op, not a second apply", async () => {
      const bridge = await newBridge();
      const contentHash = await publishProposal();
      gateway.get.mockResolvedValue(pendingSnapshot("a".repeat(64)));
      const kernelMock = mutableKernel({ entitled: true, events: [decidedLogRow(7, contentHash)] });

      const first = await newCursorStore();
      await bridge.syncWithKernel({ http: kernelMock.http, cursorStore: first, operatorDid: OPERATOR_DID });
      expect(gateway.resolve).toHaveBeenCalledTimes(1);

      // 1) reconnect with the persisted cursor: nothing new is even fetched
      await bridge.syncWithKernel({ http: kernelMock.http, cursorStore: await newCursorStore(), operatorDid: OPERATOR_DID });
      // 2) worst case: cursor file wiped -> the whole window replays, still idempotent
      await rm(path.join(dir, APPROVALS_CURSOR_FILENAME), { force: true });
      await bridge.syncWithKernel({ http: kernelMock.http, cursorStore: await newCursorStore(), operatorDid: OPERATOR_DID });

      expect(gateway.resolve).toHaveBeenCalledTimes(1);
    });

    it("does nothing (and reports degraded) when the grant is still missing", async () => {
      const bridge = await newBridge();
      const contentHash = await publishProposal();
      const kernelMock = mutableKernel({ entitled: false, events: [decidedLogRow(7, contentHash)] });
      const store = await newCursorStore();

      const result = await bridge.syncWithKernel({
        http: kernelMock.http,
        cursorStore: store,
        operatorDid: OPERATOR_DID,
      });

      expect(result.state).toBe("missing");
      expect(bridge.isDegraded()).toBe(true);
      expect(gateway.resolve).not.toHaveBeenCalled();
      expect(store.get()).toBe("0");
    });

    it("grant authored after the decision: the very next reconnect recovers AND applies the stuck decision", async () => {
      const bridge = await newBridge();
      const contentHash = await publishProposal();
      gateway.get.mockResolvedValue(pendingSnapshot("a".repeat(64)));
      const kernelMock = mutableKernel({ entitled: false, events: [decidedLogRow(7, contentHash)] });
      const store = await newCursorStore();

      await bridge.syncWithKernel({ http: kernelMock.http, cursorStore: store, operatorDid: OPERATOR_DID });
      expect(gateway.resolve).not.toHaveBeenCalled();

      kernelMock.state.entitled = true;
      await bridge.syncWithKernel({ http: kernelMock.http, cursorStore: store, operatorDid: OPERATOR_DID });
      expect(bridge.isDegraded()).toBe(false);
      expect(gateway.resolve).toHaveBeenCalledTimes(1);
    });

    it("re-reconciles pending items first, so a decision for an item the startup list() missed is still applied", async () => {
      gateway.list.mockResolvedValue([makeRecord()]);
      gateway.get.mockResolvedValue(pendingSnapshot("a".repeat(64)));
      // The digest is deterministic for the same record, so a throwaway bridge tells us what
      // the real one will publish.
      const probe = await newBridge();
      await probe.reconcile();
      const contentHash = kernel.publishApprovalRequested.mock.calls[0][0].contentHash as string;
      probe.dispose();
      kernel.publishApprovalRequested.mockClear();

      // The bridge under test starts with nothing tracked (as if its startup list() had failed).
      const bridge = await newBridge();
      const kernelMock = mutableKernel({ entitled: true, events: [decidedLogRow(3, contentHash)] });
      await bridge.syncWithKernel({
        http: kernelMock.http,
        cursorStore: await newCursorStore(),
        operatorDid: OPERATOR_DID,
      });

      expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
      expect(gateway.resolve).toHaveBeenCalledWith(PROPOSAL_ID, "allow-once");
    });

    it("a transient source failure defers the decision: the cursor holds and the next reconnect applies it", async () => {
      const bridge = await newBridge();
      const contentHash = await publishProposal();
      const kernelMock = mutableKernel({ entitled: true, events: [decidedLogRow(7, contentHash)] });
      const store = await newCursorStore();

      gateway.get.mockRejectedValueOnce(new Error("gateway restarting"));
      await bridge.syncWithKernel({ http: kernelMock.http, cursorStore: store, operatorDid: OPERATOR_DID });
      expect(gateway.resolve).not.toHaveBeenCalled();
      expect(store.get()).toBe("0");
      expect(bridge.isPublished(PROPOSAL_ID)).toBe(true);

      gateway.get.mockResolvedValue(pendingSnapshot("a".repeat(64)));
      await bridge.syncWithKernel({ http: kernelMock.http, cursorStore: store, operatorDid: OPERATOR_DID });
      expect(gateway.resolve).toHaveBeenCalledTimes(1);
      expect(store.get()).toBe("7");
    });

    it("never throws when the kernel read fails mid-sync", async () => {
      const bridge = await newBridge();
      let n = 0;
      const http: KernelHttp = {
        requestRaw: vi.fn(async () => {
          n += 1;
          if (n === 1) {
            return {
              status: 200,
              contentType: "application/json",
              text: JSON.stringify({ events: [], nextCursor: "0", entitledEventTypes: [APPROVAL_DECIDED_EVENT_TYPE] }),
            };
          }
          return { status: 500, contentType: "text/plain", text: "" };
        }),
      };
      await expect(
        bridge.syncWithKernel({ http, cursorStore: await newCursorStore(), operatorDid: OPERATOR_DID }),
      ).resolves.toEqual({ state: "entitled" });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("approvals catch-up failed"));
    });
  });

  describe("handleKernelDecision", () => {
    it("accepts the agent-addressed copy (subject = agent DID) the kernel publishes per recipient (imajin-ai#2337)", async () => {
      const bridge = await newBridge();
      const contentHash = await publishProposal();
      gateway.get.mockResolvedValue(pendingSnapshot("a".repeat(64)));
      await expect(
        bridge.handleKernelDecision(decidedFrame(contentHash, { subject: AGENT_DID })),
      ).resolves.toBe("applied");
      expect(gateway.resolve).toHaveBeenCalledWith(PROPOSAL_ID, "allow-once");
    });

    it("still rejects a decision addressed to some third DID, or not issued by the operator", async () => {
      const bridge = await newBridge();
      const contentHash = await publishProposal();
      gateway.get.mockResolvedValue(pendingSnapshot("a".repeat(64)));
      await expect(
        bridge.handleKernelDecision(decidedFrame(contentHash, { subject: "did:imajin:stranger" })),
      ).resolves.toBe("rejected");
      await expect(
        bridge.handleKernelDecision(decidedFrame(contentHash, { issuer: "did:imajin:stranger" })),
      ).resolves.toBe("rejected");
      expect(gateway.resolve).not.toHaveBeenCalled();
    });

    it("concurrent live push + catch-up replay of the same decision applies once", async () => {
      const bridge = await newBridge();
      const contentHash = await publishProposal();
      gateway.get.mockResolvedValue(pendingSnapshot("a".repeat(64)));
      let release!: () => void;
      gateway.resolve.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ applied: true });
          }),
      );

      const live = bridge.handleKernelDecision(decidedFrame(contentHash));
      const replay = bridge.handleKernelDecision(decidedFrame(contentHash, { subject: AGENT_DID }));
      await vi.waitFor(() => expect(gateway.resolve).toHaveBeenCalledTimes(1));
      release();

      await expect(Promise.all([live, replay])).resolves.toEqual(["applied", "applied"]);
      expect(gateway.resolve).toHaveBeenCalledTimes(1);
      // A third, later replay finds nothing tracked: a clean no-op.
      await expect(bridge.handleKernelDecision(decidedFrame(contentHash))).resolves.toBe("noop");
      expect(gateway.resolve).toHaveBeenCalledTimes(1);
    });
  });
});

describe("resolveSkillWorkshopOperatorScopes (#53 default)", () => {
  it("defaults an omitted or empty list to operator.read + operator.admin", () => {
    expect(resolveSkillWorkshopOperatorScopes(undefined)).toEqual({
      scopes: ["operator.read", "operator.admin"],
      defaulted: true,
    });
    expect(resolveSkillWorkshopOperatorScopes([])).toEqual({
      scopes: ["operator.read", "operator.admin"],
      defaulted: true,
    });
    expect([...DEFAULT_SKILL_WORKSHOP_OPERATOR_SCOPES]).toEqual(["operator.read", "operator.admin"]);
  });

  it("returns an explicit list untouched, including the opt-out", () => {
    expect(resolveSkillWorkshopOperatorScopes(["operator.approvals"])).toEqual({
      scopes: ["operator.approvals"],
      defaulted: false,
    });
    expect(resolveSkillWorkshopOperatorScopes(["operator.read"])).toEqual({
      scopes: ["operator.read"],
      defaulted: false,
    });
  });

  it("does not mutate the shared default across calls", () => {
    const a = resolveSkillWorkshopOperatorScopes(undefined).scopes;
    a.push("operator.write");
    expect(resolveSkillWorkshopOperatorScopes(undefined).scopes).toEqual(["operator.read", "operator.admin"]);
  });
});
