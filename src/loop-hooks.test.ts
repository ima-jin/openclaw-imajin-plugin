import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { registerLoopLifecycle } from "./loop-hooks.js";
import { deriveLoopId, type LoopIngestRequest } from "./loop-publisher.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const DID = "did:imajin:agent";
const OPERATOR = "did:imajin:operator";
const KEYPAIR = JSON.stringify({ did: DID, privateKey: "22".repeat(32) });
const MAIN = "agent:main:telegram:direct:42";
const CHILD = "agent:main:subagent:aaaa-1111";

type Handler = (...args: any[]) => unknown;

function fakeApi() {
  const handlers = new Map<string, Handler>();
  const api = {
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, handler);
    }),
  };
  return { api, handlers };
}

const logger = () => ({ info: vi.fn(), warn: vi.fn() });

function okFetch() {
  return vi.fn(async (_url: unknown, _init?: RequestInit) => new Response("{}", { status: 201 }));
}

const sent = (fetchMock: ReturnType<typeof okFetch>): LoopIngestRequest[] =>
  fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body)) as LoopIngestRequest);

const baseDeps = (over: Record<string, unknown> = {}) => ({
  nodeUrl: "https://node.test",
  did: DID,
  keypairPath: "/k.json",
  ...over,
});

beforeEach(() => {
  vi.mocked(readFile).mockReset();
  vi.mocked(readFile).mockResolvedValue(KEYPAIR);
});

describe("registerLoopLifecycle — gating", () => {
  it.each([
    ["nodeUrl", { nodeUrl: undefined }],
    ["did", { did: undefined }],
    ["keypairPath", { keypairPath: undefined }],
  ])("missing %s: registers nothing and logs one line", (_name, over) => {
    const { api } = fakeApi();
    const log = logger();
    expect(registerLoopLifecycle(api, baseDeps({ ...over, logger: log }))).toBeUndefined();
    expect(api.on).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("loops.enabled=false opts out silently", () => {
    const { api } = fakeApi();
    const log = logger();
    expect(
      registerLoopLifecycle(api, baseDeps({ config: { enabled: false }, logger: log })),
    ).toBeUndefined();
    expect(api.on).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("is on by default once nodeUrl + did + keypairPath are configured", () => {
    const { api, handlers } = fakeApi();
    expect(registerLoopLifecycle(api, baseDeps({ logger: logger() }))).toBeDefined();
    expect([...handlers.keys()].sort()).toEqual(
      [
        "agent_end",
        "cron_changed",
        "cron_reconciled",
        "session_end",
        "session_start",
        "subagent_ended",
        "subagent_progress",
        "subagent_spawned",
      ].sort(),
    );
  });

  it("a hook the runtime refuses to register does not break plugin start", () => {
    const api = {
      on: vi.fn(() => {
        throw new Error("unknown hook");
      }),
    };
    const log = logger();
    expect(() => registerLoopLifecycle(api, baseDeps({ logger: log }))).not.toThrow();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("registerLoopLifecycle — end to end", () => {
  it("publishes signed loop.* events for a session → subagent → cron lifecycle under the actAs principal", async () => {
    const { api, handlers } = fakeApi();
    const fetchMock = okFetch();
    const lifecycle = registerLoopLifecycle(
      api,
      baseDeps({ actAs: OPERATOR, fetchImpl: fetchMock, logger: logger() }),
    )!;

    handlers.get("session_start")!({ sessionId: "s1", sessionKey: MAIN }, { sessionKey: MAIN });
    handlers.get("subagent_spawned")!(
      { childSessionKey: CHILD, runId: "r1", agentId: "scout", mode: "run" },
      { requesterSessionKey: MAIN, runId: "r1", childSessionKey: CHILD },
    );
    handlers.get("subagent_ended")!({ targetSessionKey: CHILD, targetKind: "subagent", reason: "done", outcome: "ok", runId: "r1" });
    handlers.get("cron_changed")!({ action: "started", jobId: "digest", job: { id: "digest", name: "Digest" }, runAtMs: 10 });
    handlers.get("cron_changed")!({ action: "finished", jobId: "digest", runAtMs: 10, status: "ok" });
    handlers.get("session_end")!({ sessionId: "s1", reason: "idle" }, { sessionKey: MAIN });
    await lifecycle.sender.idle();

    const requests = sent(fetchMock);
    expect(requests.map((r) => `${r.type}|${r.payload.kind}|${r.payload.state}`)).toEqual([
      "loop.started|openclaw.session|running",
      "loop.started|openclaw.subagent|running",
      "loop.finished|openclaw.subagent|succeeded",
      "loop.started|openclaw.automation|running",
      "loop.finished|openclaw.automation|succeeded",
      "loop.finished|openclaw.session|succeeded",
    ]);
    for (const r of requests) {
      expect(r.publisherDid).toBe(DID);
      expect(r.payload.principal).toBe(OPERATOR);
      expect(r.signature.sig).toMatch(/^[0-9a-f]{128}$/);
    }
    // lineage survives the wire: the subagent's parent is the session loop
    expect(requests[1]!.payload.parentLoopId).toBe(requests[0]!.payload.loopId);
    expect(requests[0]!.payload.loopId).toBe(deriveLoopId(DID, "openclaw.session", "s1"));
    // session_end took the session key from ctx when the event omitted it
    expect(requests[5]!.payload.refs).toEqual({ sessionKey: MAIN });
  });

  it("cron_reconciled lists cron jobs and closes orphaned runs", async () => {
    const { api, handlers } = fakeApi();
    const fetchMock = okFetch();
    const lifecycle = registerLoopLifecycle(api, baseDeps({ fetchImpl: fetchMock, logger: logger() }))!;

    const list = vi.fn().mockResolvedValue([{ id: "stuck", state: { runningAtMs: 99 } }]);
    await handlers.get("cron_reconciled")!(
      { reason: "startup", enabled: true },
      { getCron: () => ({ list }), abortSignal: new AbortController().signal },
    );
    await lifecycle.sender.idle();

    expect(list).toHaveBeenCalledWith({ includeDisabled: true });
    const [request] = sent(fetchMock);
    expect(request).toMatchObject({ type: "loop.finished", payload: { state: "interrupted" } });
  });

  it("cron_reconciled: a superseded scheduler snapshot (aborted) publishes nothing", async () => {
    const { api, handlers } = fakeApi();
    const fetchMock = okFetch();
    const lifecycle = registerLoopLifecycle(api, baseDeps({ fetchImpl: fetchMock, logger: logger() }))!;

    const controller = new AbortController();
    const list = vi.fn(async () => {
      controller.abort();
      return [{ id: "stuck", state: { runningAtMs: 99 } }];
    });
    await handlers.get("cron_reconciled")!(
      { reason: "startup", enabled: true },
      { getCron: () => ({ list }), abortSignal: controller.signal },
    );
    await lifecycle.sender.idle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cron_reconciled: cron service errors or is absent never throw", async () => {
    const { api, handlers } = fakeApi();
    const log = logger();
    registerLoopLifecycle(api, baseDeps({ fetchImpl: okFetch(), logger: log }));
    const handler = handlers.get("cron_reconciled")!;

    await expect(
      handler({ reason: "startup" }, { getCron: () => ({ list: () => Promise.reject(new Error("down")) }) }),
    ).resolves.toBeUndefined();
    await expect(handler({ reason: "startup" }, undefined)).resolves.toBeUndefined();
    await expect(handler(undefined, {})).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  describe("a publish failure never breaks the loop", () => {
    it("kernel down: every hook handler returns synchronously with no result and nothing rejects", async () => {
      const { api, handlers } = fakeApi();
      const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      const log = logger();
      const lifecycle = registerLoopLifecycle(api, baseDeps({ fetchImpl: fetchMock, logger: log }))!;

      const results = [
        handlers.get("session_start")!({ sessionId: "s", sessionKey: MAIN }, {}),
        handlers.get("agent_end")!({ success: true }, { sessionKey: MAIN }),
        handlers.get("subagent_spawned")!({ childSessionKey: CHILD }, { requesterSessionKey: MAIN }),
        handlers.get("subagent_progress")!({ phase: "started", childSessionKey: CHILD }, {}),
        handlers.get("subagent_ended")!({ targetSessionKey: CHILD, outcome: "error" }),
        handlers.get("cron_changed")!({ action: "started", jobId: "j", runAtMs: 1 }),
        handlers.get("cron_changed")!({ action: "finished", jobId: "j", status: "ok" }),
        handlers.get("session_end")!({ sessionId: "s", sessionKey: MAIN, reason: "idle" }, {}),
      ];
      // Observe hooks must hand control straight back: no promise to await, no value.
      expect(results.every((r) => r === undefined)).toBe(true);

      await expect(lifecycle.sender.idle()).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledTimes(1); // rate-limited, not one line per event
    });

    it("kernel rejects (403 unauthorized publisher): handlers unaffected, no retry storm", async () => {
      const { api, handlers } = fakeApi();
      const fetchMock = vi.fn(async () => new Response("{}", { status: 403 }));
      const lifecycle = registerLoopLifecycle(api, baseDeps({ fetchImpl: fetchMock, logger: logger() }))!;

      handlers.get("session_start")!({ sessionId: "s", sessionKey: MAIN }, {});
      handlers.get("session_end")!({ sessionId: "s", sessionKey: MAIN, reason: "idle" }, {});
      await lifecycle.sender.idle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("hook handlers survive hostile payloads", () => {
      const { api, handlers } = fakeApi();
      registerLoopLifecycle(api, baseDeps({ fetchImpl: okFetch(), logger: logger() }));
      for (const [name, handler] of handlers) {
        if (name === "cron_reconciled") continue; // async; covered above
        expect(() => handler(undefined, undefined)).not.toThrow();
        expect(() => handler(null, null)).not.toThrow();
        expect(() => handler("junk", 42)).not.toThrow();
      }
    });
  });

  it("never sends transcript content or secrets over the wire", async () => {
    const { api, handlers } = fakeApi();
    const fetchMock = okFetch();
    const lifecycle = registerLoopLifecycle(api, baseDeps({ fetchImpl: fetchMock, logger: logger() }))!;
    const secret = "TOP-SECRET-TRANSCRIPT-TEXT";

    handlers.get("session_start")!({ sessionId: "s", sessionKey: MAIN }, {});
    handlers.get("agent_end")!({ success: true, messages: [{ role: "assistant", content: secret }] }, { sessionKey: MAIN });
    handlers.get("subagent_spawned")!({ childSessionKey: CHILD, task: secret }, { requesterSessionKey: MAIN });
    await lifecycle.sender.idle();

    const wire = fetchMock.mock.calls.map((c) => String(c[1]?.body)).join("\n");
    expect(wire).toContain("loop.progress");
    expect(wire).not.toContain(secret);
    expect(wire).not.toContain("22".repeat(32));
  });
});
