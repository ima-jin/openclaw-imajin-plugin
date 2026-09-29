import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  APPROVALS_CURSOR_FILENAME,
  APPROVAL_DECIDED_EVENT_TYPE,
  ApprovalsCursorStore,
  CatchUpHttpError,
  OPERATOR_APPROVALS_CAPABILITY,
  SUBSCRIPTION_CATCHUP_PATH,
  checkApprovalsEntitlement,
  describeMissingApprovalsGrant,
  fetchCatchUpPage,
  runApprovalsCatchUp,
  type CaughtUpEvent,
  type DecisionOutcome,
  type KernelHttp,
} from "./approvals-catchup.js";

const AGENT_DID = "did:imajin:agent";
const OPERATOR_DID = "did:imajin:operator";
const NODE_URL = "https://jin.example";

function decidedEvent(seq: number, proposalId = `p-${seq}`): CaughtUpEvent {
  return {
    id: `evt-${seq}`,
    cursor: String(seq),
    eventType: APPROVAL_DECIDED_EVENT_TYPE,
    issuer: OPERATOR_DID,
    subject: AGENT_DID,
    scope: "operator",
    payload: { proposalId, decision: "approve", decidedBy: OPERATOR_DID },
    correlationId: null,
    occurredAt: new Date(1_700_000_000_000 + seq).toISOString(),
    grantId: "grant-1",
  };
}

function otherEvent(seq: number): CaughtUpEvent {
  return { ...decidedEvent(seq), eventType: "message.send", id: `evt-${seq}` };
}

/** Fake of the kernel's catch-up route: serves rows after `cursor` (max `pageSize` per page), like `catchUpSubscriptionEvents`. */
function fakeKernel(opts: { entitledEventTypes: string[]; events?: CaughtUpEvent[]; pageSize?: number }) {
  const events = opts.events ?? [];
  const requestRaw = vi.fn(async (requestPath: string) => {
    const url = new URL(requestPath, NODE_URL);
    expect(url.pathname).toBe(SUBSCRIPTION_CATCHUP_PATH);
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? opts.pageSize ?? 100);
    const rows = opts.entitledEventTypes.length
      ? events.filter((e) => Number(e.cursor) > cursor).slice(0, Math.min(limit, opts.pageSize ?? limit))
      : [];
    const nextCursor = rows.length ? rows[rows.length - 1].cursor : String(cursor);
    return {
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ events: rows, nextCursor, entitledEventTypes: opts.entitledEventTypes }),
    };
  });
  return { http: { requestRaw } as KernelHttp, requestRaw };
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("checkApprovalsEntitlement (preflight)", () => {
  it("is entitled when operator.approval.decided is in entitledEventTypes", async () => {
    const { http, requestRaw } = fakeKernel({ entitledEventTypes: ["message.send", APPROVAL_DECIDED_EVENT_TYPE] });
    await expect(checkApprovalsEntitlement(http)).resolves.toEqual({ state: "entitled" });
    // Queried as the agent itself (never through an actAs delegation) and cheaply.
    expect(requestRaw).toHaveBeenCalledWith(`${SUBSCRIPTION_CATCHUP_PATH}?cursor=0&limit=1`, {
      onBehalfOf: "self",
    });
  });

  it("is missing when the agent's active grants entitle other types but not operator.approval.decided", async () => {
    const { http } = fakeKernel({ entitledEventTypes: ["message.send", "warp.run.completed"] });
    await expect(checkApprovalsEntitlement(http)).resolves.toEqual({ state: "missing" });
  });

  it("is missing when the agent has no entitlements at all (38 unrelated capabilities case)", async () => {
    const { http } = fakeKernel({ entitledEventTypes: [] });
    await expect(checkApprovalsEntitlement(http)).resolves.toEqual({ state: "missing" });
  });

  it("is unknown (NOT missing) on an HTTP failure, without echoing any response body", async () => {
    const http: KernelHttp = {
      requestRaw: vi.fn().mockResolvedValue({ status: 500, contentType: "text/plain", text: "secret-body" }),
    };
    const result = await checkApprovalsEntitlement(http);
    expect(result.state).toBe("unknown");
    expect(JSON.stringify(result)).toContain("HTTP 500");
    expect(JSON.stringify(result)).not.toContain("secret-body");
  });

  it("is unknown on a network error and on a malformed body", async () => {
    const boom: KernelHttp = { requestRaw: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    await expect(checkApprovalsEntitlement(boom)).resolves.toMatchObject({ state: "unknown" });
    const junk: KernelHttp = {
      requestRaw: vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", text: "{\"nope\":1}" }),
    };
    await expect(checkApprovalsEntitlement(junk)).resolves.toMatchObject({ state: "unknown" });
  });
});

describe("fetchCatchUpPage", () => {
  it("throws a status-only CatchUpHttpError on non-200", async () => {
    const http: KernelHttp = {
      requestRaw: vi.fn().mockResolvedValue({ status: 401, contentType: "application/json", text: "{}" }),
    };
    await expect(fetchCatchUpPage(http, "0")).rejects.toBeInstanceOf(CatchUpHttpError);
  });

  it("drops malformed event rows instead of crashing", async () => {
    const http: KernelHttp = {
      requestRaw: vi.fn().mockResolvedValue({
        status: 200,
        contentType: "application/json",
        text: JSON.stringify({
          events: [decidedEvent(1), { id: 5 }, null],
          nextCursor: "1",
          entitledEventTypes: [APPROVAL_DECIDED_EVENT_TYPE],
        }),
      }),
    };
    const page = await fetchCatchUpPage(http, "0");
    expect(page.events).toHaveLength(1);
  });
});

describe("describeMissingApprovalsGrant", () => {
  it("names the agent DID, the missing capability, and the exact grant the owner must author", () => {
    const text = describeMissingApprovalsGrant({ agentDid: AGENT_DID, operatorDid: OPERATOR_DID });
    expect(text).toContain(AGENT_DID);
    expect(text).toContain(OPERATOR_APPROVALS_CAPABILITY);
    expect(text).toContain("POST /auth/api/grants");
    expect(text).toContain(
      JSON.stringify({
        agentDid: AGENT_DID,
        capabilities: [OPERATOR_APPROVALS_CAPABILITY],
        audience: { type: "dids", values: [OPERATOR_DID, AGENT_DID] },
      }),
    );
    expect(text).toContain(`PUT /auth/api/grants/{grantId}/capabilities/${OPERATOR_APPROVALS_CAPABILITY}`);
  });
});

describe("ApprovalsCursorStore (cursor persistence)", () => {
  let dir: string;
  let file: string;
  const scope = { nodeUrl: NODE_URL, agentDid: AGENT_DID };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "approvals-cursor-"));
    file = path.join(dir, "nested", APPROVALS_CURSOR_FILENAME);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists across instances (survives a restart)", async () => {
    const first = new ApprovalsCursorStore(file, scope, silentLogger);
    await first.load();
    expect(first.get()).toBe("0");
    await first.advance("42");

    const second = new ApprovalsCursorStore(file, scope, silentLogger);
    await second.load();
    expect(second.get()).toBe("42");
    const onDisk = JSON.parse(await readFile(file, "utf-8"));
    expect(onDisk).toEqual({ version: 1, nodeUrl: NODE_URL, agentDid: AGENT_DID, cursor: "42" });
  });

  it("never rewinds", async () => {
    const store = new ApprovalsCursorStore(file, scope, silentLogger);
    await store.advance("100");
    await store.advance("7");
    await store.advance("100");
    expect(store.get()).toBe("100");
  });

  it("handles seqs beyond Number.MAX_SAFE_INTEGER (bigint sequence)", async () => {
    const store = new ApprovalsCursorStore(file, scope, silentLogger);
    await store.advance("9007199254740993");
    await store.advance("9007199254740994");
    expect(store.get()).toBe("9007199254740994");
  });

  it("ignores a file written for a different agent DID or node", async () => {
    await new ApprovalsCursorStore(file, scope, silentLogger).advance("55");
    const otherAgent = new ApprovalsCursorStore(file, { ...scope, agentDid: "did:imajin:other" }, silentLogger);
    await otherAgent.load();
    expect(otherAgent.get()).toBe("0");
    const otherNode = new ApprovalsCursorStore(file, { ...scope, nodeUrl: "https://elsewhere" }, silentLogger);
    await otherNode.load();
    expect(otherNode.get()).toBe("0");
  });

  it("degrades to 0 on a corrupt file and keeps working in-memory without a path", async () => {
    await new ApprovalsCursorStore(file, scope, silentLogger).advance("9");
    await writeFile(file, "{not json", "utf-8");
    const corrupt = new ApprovalsCursorStore(file, scope, silentLogger);
    await corrupt.load();
    expect(corrupt.get()).toBe("0");

    const memoryOnly = new ApprovalsCursorStore(undefined, scope, silentLogger);
    await memoryOnly.load();
    await memoryOnly.advance("3");
    expect(memoryOnly.get()).toBe("3");
  });

  it("logs (never throws) when the state dir is unwritable", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // A path whose parent is an existing FILE cannot be created.
    await writeFile(path.join(dir, "blocker"), "x", "utf-8");
    const store = new ApprovalsCursorStore(path.join(dir, "blocker", "cursor.json"), scope, logger);
    await expect(store.advance("5")).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to persist approvals cursor"));
    expect(store.get()).toBe("5");
  });
});

describe("runApprovalsCatchUp", () => {
  let dir: string;
  let file: string;
  const scope = { nodeUrl: NODE_URL, agentDid: AGENT_DID };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "approvals-catchup-"));
    file = path.join(dir, APPROVALS_CURSOR_FILENAME);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function newStore(): Promise<ApprovalsCursorStore> {
    const store = new ApprovalsCursorStore(file, scope, silentLogger);
    await store.load();
    return store;
  }

  it("applies every missed decided event exactly once, in order, across pages, and persists the cursor", async () => {
    const { http } = fakeKernel({
      entitledEventTypes: [APPROVAL_DECIDED_EVENT_TYPE, "message.send"],
      events: [decidedEvent(3), otherEvent(4), decidedEvent(5), decidedEvent(9)],
      pageSize: 2,
    });
    const applied: string[] = [];
    const applyDecision = vi.fn(async (frame): Promise<DecisionOutcome> => {
      applied.push(String((frame.payload as { proposalId: string }).proposalId));
      return "applied";
    });

    const store = await newStore();
    const summary = await runApprovalsCatchUp({ http, store, applyDecision, logger: silentLogger, pageSize: 2 });

    expect(applied).toEqual(["p-3", "p-5", "p-9"]);
    expect(summary).toMatchObject({ decided: 3, applied: 3, deferred: 0, scanned: 4, cursor: "9" });
    expect(store.get()).toBe("9");
    // The frame handed to the live handler has the live bus_event shape.
    expect(applyDecision.mock.calls[0][0]).toMatchObject({
      type: "bus_event",
      eventType: APPROVAL_DECIDED_EVENT_TYPE,
      issuer: OPERATOR_DID,
      subject: AGENT_DID,
    });
  });

  it("reconnect replay: a second run resumes from the persisted cursor and does not re-apply", async () => {
    const events = [decidedEvent(3), decidedEvent(5)];
    const first = fakeKernel({ entitledEventTypes: [APPROVAL_DECIDED_EVENT_TYPE], events });
    const applyDecision = vi.fn().mockResolvedValue("applied" satisfies DecisionOutcome);
    await runApprovalsCatchUp({ http: first.http, store: await newStore(), applyDecision, logger: silentLogger });
    expect(applyDecision).toHaveBeenCalledTimes(2);

    // "Reconnect" (even a full process restart): fresh store instance reads the persisted cursor.
    const second = fakeKernel({
      entitledEventTypes: [APPROVAL_DECIDED_EVENT_TYPE],
      events: [...events, decidedEvent(8)],
    });
    const reconnectStore = await newStore();
    expect(reconnectStore.get()).toBe("5");
    await runApprovalsCatchUp({ http: second.http, store: reconnectStore, applyDecision, logger: silentLogger });

    expect(second.requestRaw.mock.calls[0][0]).toContain("cursor=5");
    expect(applyDecision).toHaveBeenCalledTimes(3); // only the new one
    expect(reconnectStore.get()).toBe("8");
  });

  it("advances the cursor over non-decided and audience-filtered rows", async () => {
    const { http } = fakeKernel({
      entitledEventTypes: [APPROVAL_DECIDED_EVENT_TYPE, "message.send"],
      events: [otherEvent(2), otherEvent(3)],
    });
    const applyDecision = vi.fn();
    const store = await newStore();
    await runApprovalsCatchUp({ http, store, applyDecision, logger: silentLogger });
    expect(applyDecision).not.toHaveBeenCalled();
    expect(store.get()).toBe("3");
  });

  it("does not advance past a deferred (transient-failure) decision, so the next reconnect retries it", async () => {
    const events = [decidedEvent(2), decidedEvent(4), decidedEvent(6)];
    const { http } = fakeKernel({ entitledEventTypes: [APPROVAL_DECIDED_EVENT_TYPE], events });
    const applyDecision = vi.fn(async (frame): Promise<DecisionOutcome> => {
      return (frame.payload as { proposalId: string }).proposalId === "p-4" ? "deferred" : "applied";
    });
    const store = await newStore();
    const summary = await runApprovalsCatchUp({ http, store, applyDecision, logger: silentLogger });

    expect(summary).toMatchObject({ applied: 2, deferred: 1 });
    // Later events are still attempted, but the durable cursor stops right before the deferred one.
    expect(applyDecision).toHaveBeenCalledTimes(3);
    expect(store.get()).toBe("2");

    // Next reconnect: p-4 now succeeds; p-6 is re-offered and is a (handler-level) no-op.
    applyDecision.mockImplementation(async (frame) =>
      (frame.payload as { proposalId: string }).proposalId === "p-6" ? "noop" : "applied",
    );
    await runApprovalsCatchUp({ http, store: await newStore(), applyDecision, logger: silentLogger });
    expect((await newStore()).get()).toBe("6");
  });

  it("stops after maxPages and resumes from the persisted cursor on the next run", async () => {
    const events = [1, 2, 3, 4, 5, 6].map((n) => decidedEvent(n));
    const { http } = fakeKernel({ entitledEventTypes: [APPROVAL_DECIDED_EVENT_TYPE], events, pageSize: 2 });
    const applyDecision = vi.fn().mockResolvedValue("applied" satisfies DecisionOutcome);

    const store = await newStore();
    const first = await runApprovalsCatchUp({ http, store, applyDecision, logger: silentLogger, pageSize: 2, maxPages: 1 });
    expect(first.pages).toBe(1);
    expect(store.get()).toBe("2");

    await runApprovalsCatchUp({ http, store, applyDecision, logger: silentLogger, pageSize: 2 });
    expect(applyDecision).toHaveBeenCalledTimes(6);
    expect(store.get()).toBe("6");
  });

  it("persists progress made before a mid-run fetch failure, then rethrows", async () => {
    const good = fakeKernel({
      entitledEventTypes: [APPROVAL_DECIDED_EVENT_TYPE],
      events: [decidedEvent(1), decidedEvent(2), decidedEvent(3)],
      pageSize: 1,
    });
    let calls = 0;
    const flaky: KernelHttp = {
      requestRaw: vi.fn(async (p: string) => {
        calls += 1;
        if (calls === 3) return { status: 503, contentType: "text/plain", text: "" };
        return good.http.requestRaw(p);
      }),
    };
    const store = await newStore();
    const applyDecision = vi.fn().mockResolvedValue("applied" satisfies DecisionOutcome);
    await expect(
      runApprovalsCatchUp({ http: flaky, store, applyDecision, logger: silentLogger, pageSize: 1 }),
    ).rejects.toBeInstanceOf(CatchUpHttpError);
    expect(applyDecision).toHaveBeenCalledTimes(2);
    expect((await newStore()).get()).toBe("2");
  });

  it("is a no-op when not entitled (kernel returns nothing)", async () => {
    const { http } = fakeKernel({ entitledEventTypes: [], events: [decidedEvent(1)] });
    const applyDecision = vi.fn();
    const store = await newStore();
    const summary = await runApprovalsCatchUp({ http, store, applyDecision, logger: silentLogger });
    expect(applyDecision).not.toHaveBeenCalled();
    expect(summary.cursor).toBe("0");
  });
});
