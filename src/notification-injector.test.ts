import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImajinWsService, type NotificationFrame } from "./ws-service.js";
import {
  createNotificationInjector,
  buildWakeTurnMessage,
  DEFAULT_WAKE_COALESCE_MS,
  DEFAULT_WAKE_OWED_MAX_AGE_MS,
  DEFAULT_WAKE_SETTLE_MS,
  HOOK_REQUEST_TIMEOUT_MS,
  HOOK_RETRY_DELAYS_MS,
  HOOK_TOKEN_ENV,
  type WsNotificationsConfig,
} from "./notification-injector.js";
import { PENDING_WAKES_FILENAME, PendingWakeStore, resolveStateDir } from "./notification-state-store.js";

// Sum of the retry backoff schedule (#26) — enough fake-timer advancement to
// run every retry attempt (each of which can itself time out after
// HOOK_REQUEST_TIMEOUT_MS) through to the final Telegram-fallback escalation.
const TOTAL_RETRY_WINDOW_MS =
  HOOK_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0) +
  (HOOK_RETRY_DELAYS_MS.length + 1) * HOOK_REQUEST_TIMEOUT_MS;

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const execFileMock = vi.mocked(execFile);

// #20: `resolveHookToken`'s SecretRef branch dynamically `import()`s these two
// plugin-sdk specifiers — mocked here so the SecretRef-shaped `hookToken`
// tests below never need the real (unpublished-in-this-repo) `openclaw`
// package resolvable on disk. Every other test in this file configures
// `hookToken` as a plain string, so it never touches these mocks at all.
const isSecretRefMock = vi.hoisted(() =>
  vi.fn(
    (value: unknown) =>
      !!value &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).source === "string" &&
      typeof (value as Record<string, unknown>).provider === "string" &&
      typeof (value as Record<string, unknown>).id === "string",
  ),
);
const resolveSecretRefValuesMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({ isSecretRef: isSecretRefMock }));
vi.mock("openclaw/plugin-sdk/secret-ref-runtime", () => ({
  resolveSecretRefValues: resolveSecretRefValuesMock,
}));

// We test the batching logic by re-implementing the coalesce behaviour
// in plain JS to avoid needing the full plugin SDK types.

type Batch = { timeout: ReturnType<typeof setTimeout>; frames: NotificationFrame[] };

function createBatcher(
  coalesceMs: number,
  onFlush: (frames: NotificationFrame[]) => void,
) {
  const batches = new Map<string, Batch>();
  return {
    push(scope: string, frame: NotificationFrame) {
      const existing = batches.get(scope);
      if (existing) {
        existing.frames.push(frame);
        return;
      }
      const timeout = setTimeout(() => {
        const buf = batches.get(scope);
        if (buf) {
          batches.delete(scope);
          onFlush(buf.frames);
        }
      }, coalesceMs);
      batches.set(scope, { timeout, frames: [frame] });
    },
    dispose() {
      for (const [, buf] of batches) clearTimeout(buf.timeout);
      batches.clear();
    },
    size(scope: string) {
      return batches.get(scope)?.frames.length ?? 0;
    },
  };
}

describe("Warp wake batching", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces two events within the window into one flush", () => {
    const flushed: NotificationFrame[][] = [];
    const batcher = createBatcher(300_000, (frames) => flushed.push(frames));

    const f1 = { id: "1", scope: "warp.run.completed", title: "run A", body: "", createdAt: "", data: {} } as NotificationFrame;
    const f2 = { id: "2", scope: "warp.run.completed", title: "run B", body: "", createdAt: "", data: {} } as NotificationFrame;

    batcher.push("warp.run.completed", f1);
    expect(batcher.size("warp.run.completed")).toBe(1);

    batcher.push("warp.run.completed", f2);
    expect(batcher.size("warp.run.completed")).toBe(2);
    expect(flushed).toHaveLength(0);

    vi.advanceTimersByTime(300_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(2);
    expect(batcher.size("warp.run.completed")).toBe(0);

    batcher.dispose();
  });

  it("starts a new batch after the window fires", () => {
    const flushed: NotificationFrame[][] = [];
    const batcher = createBatcher(300_000, (frames) => flushed.push(frames));

    const f1 = { id: "1", scope: "warp.run.completed", title: "run A", body: "", createdAt: "", data: {} } as NotificationFrame;
    batcher.push("warp.run.completed", f1);
    vi.advanceTimersByTime(300_000);
    expect(flushed).toHaveLength(1);

    const f2 = { id: "2", scope: "warp.run.completed", title: "run B", body: "", createdAt: "", data: {} } as NotificationFrame;
    batcher.push("warp.run.completed", f2);
    vi.advanceTimersByTime(300_000);
    expect(flushed).toHaveLength(2);

    batcher.dispose();
  });
});

// ---------------------------------------------------------------------------
// Real `inject()` path (#18). Regression for 2026-09-05: with directSend
// configured and healthy, an early `return` after the successful ping meant
// the wake turn was never fired — the human got the Telegram ping, the agent
// never acted.
// ---------------------------------------------------------------------------

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

function stubExecFile(outcome: "ok" | "fail") {
  execFileMock.mockImplementation(((_cli: string, _args: string[], _opts: unknown, cb: ExecCb) => {
    cb(outcome === "ok" ? null : new Error("openclaw message send: boom"), "", "");
    return {} as never;
  }) as never);
}

type FetchResponse = { status: number; text: () => Promise<string>; json: () => Promise<unknown> };
type FetchInit = { headers: Record<string, string>; body: string; signal: AbortSignal };

/** Builds a `global.fetch` mock and a way to inspect/override its behavior. */
function makeFetchMock() {
  const calls: Array<[string, FetchInit]> = [];
  let impl: (url: string, init: FetchInit) => Promise<FetchResponse> = async () => ({
    status: 200,
    text: async () => "",
    json: async () => ({}),
  });
  const fetchMock = vi.fn(async (url: string, init: unknown) => {
    calls.push([url, init as FetchInit]);
    return impl(url, init as FetchInit);
  });
  return {
    fetchMock,
    calls,
    setImpl(next: typeof impl) {
      impl = next;
    },
  };
}

function jsonResponse(status: number, body: unknown = {}): FetchResponse {
  return { status, text: async () => JSON.stringify(body), json: async () => body };
}

function makeApi(gatewayPort?: number) {
  const enqueueSystemEvent = vi.fn((_text: string, _opts: { sessionKey: string; contextKey?: string }) => true);
  const api = {
    runtime: {
      system: { enqueueSystemEvent },
      config: {
        current: () => (gatewayPort === undefined ? {} : { gateway: { port: gatewayPort } }),
      },
    },
  };
  return { api, enqueueSystemEvent };
}

const SESSION = "agent:main:telegram:direct:1";
// Existing tests below exercise a single frame per window and advance by
// COALESCE_MS, expecting exactly one wake — so `wakeSettleMs` (the knob that
// now actually gates a single frame's wake, #25) is set to the same value as
// `wakeCoalesceMs` here, keeping their timing assertions valid unchanged.
const COALESCE_MS = 1_000;
const HOOK_TOKEN = "test-hook-token-do-not-log";
const CONFIG: WsNotificationsConfig = {
  injectScopes: ["warp.run.completed"],
  targetSession: SESSION,
  wakeSettleMs: COALESCE_MS,
  wakeCoalesceMs: COALESCE_MS,
  hookToken: HOOK_TOKEN,
  directSend: { channel: "telegram", target: "1", cliPath: "/usr/bin/openclaw" },
};

function frame(id: string, title = `Warp run ${id} SUCCEEDED`): NotificationFrame {
  return { id, scope: "warp.run.completed", title, body: "", createdAt: "", data: {} } as NotificationFrame;
}

function wakeFailureCalls() {
  return execFileMock.mock.calls.filter((call) => String((call[1] as string[])[7] ?? "").includes("automatic wake failed"));
}

describe("createNotificationInjector.inject — direct send AND wake hook", () => {
  let fetchMock: ReturnType<typeof makeFetchMock>["fetchMock"];
  let calls: ReturnType<typeof makeFetchMock>["calls"];
  let setImpl: ReturnType<typeof makeFetchMock>["setImpl"];

  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    ({ fetchMock, calls, setImpl } = makeFetchMock());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls the wake hook even when direct send succeeds (regression)", async () => {
    stubExecFile("ok");
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const { api, enqueueSystemEvent } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));

    // Instant ping went out via the CLI…
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe("/usr/bin/openclaw");
    expect(execFileMock.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["message", "send", "--channel", "telegram", "--target", "1"]),
    );
    // …durable context was queued…
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent.mock.calls[0][1]).toMatchObject({ sessionKey: SESSION, contextKey: "imajin-ws:warp.run.completed" });
    // …and the wake is batched, not fired yet.
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    void calls; // referenced by the request-shape describe block below
    dispose();
  });

  it("still calls the wake hook when direct send fails", async () => {
    stubExecFile("fail");
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("coalesces several successful-ping completions into one wake hook call", async () => {
    stubExecFile("ok");
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await inject(frame("2", "Warp run 2 FAILED"));
    await inject(frame("3"));

    expect(execFileMock).toHaveBeenCalledTimes(3); // one ping per completion
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1); // one wake hook call for all three
    const body = JSON.parse(calls[0][1].body);
    expect(String(body.message)).toContain("warp.run.completed × 3");
    dispose();
  });

  it("calls the wake hook when directSend is not configured", async () => {
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const { api } = makeApi();
    const { directSend: _omit, ...noDirect } = CONFIG;
    const { inject, dispose } = createNotificationInjector(api, noDirect);

    await inject(frame("1"));
    expect(execFileMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("ignores frames outside injectScopes", async () => {
    stubExecFile("ok");
    const { api, enqueueSystemEvent } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject({ ...frame("1"), scope: "warp.run.started" } as NotificationFrame);
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    dispose();
  });

  it("keeps the newest notification when coalescing three completions", async () => {
    stubExecFile("ok");
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1", "Warp run 1 SUCCEEDED"));
    await inject(frame("2", "Warp run 2 SUCCEEDED"));
    await inject(frame("3", "Warp run 3 SUCCEEDED"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    // The 5-minute coalesce buffer must retain every frame pushed into it,
    // including the last one — a naive "replace, don't append" batcher would
    // silently drop the newest notification.
    const body = JSON.parse(calls[0][1].body);
    expect(String(body.message)).toContain("warp.run.completed × 3");
    expect(String(body.message)).toContain("Warp run 1 SUCCEEDED");
    expect(String(body.message)).toContain("Warp run 2 SUCCEEDED");
    expect(String(body.message)).toContain("Warp run 3 SUCCEEDED");
    dispose();
  });

  it("does not dedupe a resumed run's completion (same runId, new sessionId)", async () => {
    stubExecFile("ok");
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    const segment1: NotificationFrame = {
      ...frame("1", "Warp run X SUCCEEDED"),
      data: { runId: "run-x", sessionId: "session-a" },
    } as NotificationFrame;
    const segment2: NotificationFrame = {
      ...frame("2", "Warp run X SUCCEEDED (resumed)"),
      data: { runId: "run-x", sessionId: "session-b" },
    } as NotificationFrame;

    await inject(segment1);
    await inject(segment2);

    // Same runId, different sessionId (a resumed segment) — both notifications
    // must reach the human and both must be coalesced into the wake hook call.
    expect(execFileMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    const body = JSON.parse(calls[0][1].body);
    expect(String(body.message)).toContain("warp.run.completed × 2");
    expect(String(body.message)).toContain("Warp run X SUCCEEDED");
    expect(String(body.message)).toContain("Warp run X SUCCEEDED (resumed)");
    dispose();
  });
});

// ---------------------------------------------------------------------------
// #18: request shape, gateway port resolution, admitted/fallback outcomes,
// idempotency keys, and token-never-logged.
// ---------------------------------------------------------------------------

describe("createNotificationInjector — wake hook request shape", () => {
  let fetchMock: ReturnType<typeof makeFetchMock>["fetchMock"];
  let calls: ReturnType<typeof makeFetchMock>["calls"];
  let setImpl: ReturnType<typeof makeFetchMock>["setImpl"];

  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    ({ fetchMock, calls, setImpl } = makeFetchMock());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs to the resolved gateway port with the documented body shape and headers", async () => {
    setImpl(async () => jsonResponse(200, { runId: "run-42" }));
    const { api } = makeApi(19001);
    const { inject, dispose } = createNotificationInjector(api, {
      ...CONFIG,
      wakeSessionKey: "agent:main:telegram:direct:owner",
    });

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = calls[0];
    expect(url).toBe("http://127.0.0.1:19001/hooks/agent");
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${HOOK_TOKEN}`,
      "Content-Type": "application/json",
    });
    expect(init.headers["Idempotency-Key"]).toMatch(/^imajin-wake:warp\.run\.completed:\d+:leading$/);

    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      agentId: "main",
      sessionMode: "persistent",
      sessionKey: "agent:main:telegram:direct:owner",
      deliver: true,
      name: "imajin-wake",
    });
    expect(typeof body.message).toBe("string");
    dispose();
  });

  it("defaults the gateway port to 18789 when runtime config has no gateway.port", async () => {
    setImpl(async () => jsonResponse(200, {}));
    const { api } = makeApi(); // no gateway.port in runtime config
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    const [url] = calls[0];
    expect(url).toBe("http://127.0.0.1:18789/hooks/agent");
    dispose();
  });

  it("uses the configured hooksPath and hookAgentId", async () => {
    setImpl(async () => jsonResponse(200, {}));
    const { api } = makeApi(18789);
    const { inject, dispose } = createNotificationInjector(api, {
      ...CONFIG,
      hooksPath: "/custom-hooks/",
      hookAgentId: "hooks",
    });

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    const [url, init] = calls[0];
    expect(url).toBe("http://127.0.0.1:18789/custom-hooks/agent");
    const body = JSON.parse(init.body);
    expect(body.agentId).toBe("hooks");
    dispose();
  });

  it("falls back to IMAJIN_WAKE_HOOK_TOKEN when wsNotifications.hookToken is omitted", async () => {
    setImpl(async () => jsonResponse(200, {}));
    process.env[HOOK_TOKEN_ENV] = "env-sourced-token";
    try {
      const { api } = makeApi();
      const { hookToken: _omit, ...noToken } = CONFIG;
      const { inject, dispose } = createNotificationInjector(api, noToken);

      await inject(frame("1"));
      await vi.advanceTimersByTimeAsync(COALESCE_MS);

      const [, init] = calls[0];
      expect(init.headers.Authorization).toBe("Bearer env-sourced-token");
      dispose();
    } finally {
      delete process.env[HOOK_TOKEN_ENV];
    }
  });
});

describe("createNotificationInjector — wake hook outcomes (#18)", () => {
  let fetchMock: ReturnType<typeof makeFetchMock>["fetchMock"];
  let setImpl: ReturnType<typeof makeFetchMock>["setImpl"];

  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    ({ fetchMock, setImpl } = makeFetchMock());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("200 → admitted, logs the runId, no Telegram fallback", async () => {
    setImpl(async () => jsonResponse(200, { runId: "run-99" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("wake admitted runId=run-99"));
    expect(wakeFailureCalls()).toHaveLength(0);
    dispose();
  });

  it("401 → retries are exhausted, then the Telegram fallback fires (#26)", async () => {
    setImpl(async () => jsonResponse(401, { error: "unauthorized" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(wakeFailureCalls()).toHaveLength(0); // not yet — still retrying

    await vi.advanceTimersByTimeAsync(TOTAL_RETRY_WINDOW_MS);

    expect(fetchMock).toHaveBeenCalledTimes(HOOK_RETRY_DELAYS_MS.length + 1);
    expect(wakeFailureCalls()).toHaveLength(1);
    expect(String(wakeFailureCalls()[0][1])).toContain("automatic wake failed");
    dispose();
  });

  it("500 → retries are exhausted, then the Telegram fallback fires (#26)", async () => {
    setImpl(async () => jsonResponse(500, { error: "boom" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    await vi.advanceTimersByTimeAsync(TOTAL_RETRY_WINDOW_MS);

    expect(fetchMock).toHaveBeenCalledTimes(HOOK_RETRY_DELAYS_MS.length + 1);
    expect(wakeFailureCalls()).toHaveLength(1);
    dispose();
  });

  it("a retry that returns 200 clears the failure path — no Telegram fallback (#26)", async () => {
    let call = 0;
    setImpl(async () => {
      call += 1;
      return call <= 2 ? jsonResponse(502, { error: "bad gateway" }) : jsonResponse(200, { runId: "run-ok" });
    });
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS + HOOK_RETRY_DELAYS_MS[0] + HOOK_RETRY_DELAYS_MS[1]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(wakeFailureCalls()).toHaveLength(0);
    dispose();
  });

  it("ECONNREFUSED → retries are exhausted, then the Telegram fallback fires (#26)", async () => {
    setImpl(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18789"), { code: "ECONNREFUSED" });
    });
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    await vi.advanceTimersByTimeAsync(TOTAL_RETRY_WINDOW_MS);

    expect(fetchMock).toHaveBeenCalledTimes(HOOK_RETRY_DELAYS_MS.length + 1);
    expect(wakeFailureCalls()).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
    dispose();
  });

  it("timeout (~10s, no response) classifies as wake-pending (#31): a single attempt, no retry ladder, no Telegram fallback", async () => {
    setImpl(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS + HOOK_REQUEST_TIMEOUT_MS);

    // Exactly one attempt — the retry ladder is never walked for a pending
    // outcome (#31), unlike every other failure mode above.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wakeFailureCalls()).toHaveLength(0);

    // Advancing well past the old retry window must not add further attempts.
    await vi.advanceTimersByTimeAsync(TOTAL_RETRY_WINDOW_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wakeFailureCalls()).toHaveLength(0);
    dispose();
  });

  it("falls back to the Telegram message (never throws) when no hook token is configured", async () => {
    const { api } = makeApi();
    const { hookToken: _omit, ...noToken } = CONFIG;
    const { inject, dispose } = createNotificationInjector(api, noToken);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wakeFailureCalls()).toHaveLength(1);
    dispose();
  });
});

describe("createNotificationInjector — idempotency key (#18)", () => {
  let fetchMock: ReturnType<typeof makeFetchMock>["fetchMock"];
  let calls: ReturnType<typeof makeFetchMock>["calls"];
  let setImpl: ReturnType<typeof makeFetchMock>["setImpl"];

  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    ({ fetchMock, calls, setImpl } = makeFetchMock());
    vi.stubGlobal("fetch", fetchMock);
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is stable for every notification coalesced into the same window", async () => {
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await inject(frame("2"));
    await inject(frame("3"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("differs across two separate coalesce windows", async () => {
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstKey = calls[0][1].headers["Idempotency-Key"];

    await inject(frame("2"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondKey = calls[1][1].headers["Idempotency-Key"];

    expect(secondKey).not.toBe(firstKey);
    dispose();
  });
});

describe("createNotificationInjector — hook token is never logged (#18)", () => {
  let fetchMock: ReturnType<typeof makeFetchMock>["fetchMock"];
  let setImpl: ReturnType<typeof makeFetchMock>["setImpl"];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    ({ fetchMock, setImpl } = makeFetchMock());
    vi.stubGlobal("fetch", fetchMock);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function allLoggedText(): string {
    const all = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    return all.map((call) => call.map((arg) => String(arg)).join(" ")).join("\n");
  }

  it("never appears in logs on the admitted path", async () => {
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(allLoggedText()).not.toContain(HOOK_TOKEN);
    dispose();
  });

  it("never appears in logs on the failure/fallback path", async () => {
    setImpl(async () => jsonResponse(401, { error: "unauthorized" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(allLoggedText()).not.toContain(HOOK_TOKEN);
    dispose();
  });
});

// ---------------------------------------------------------------------------
// #20: `wsNotifications.hookToken` as a SecretRef, resolved via
// `openclaw/plugin-sdk/secret-input-runtime`'s `isSecretRef` +
// `openclaw/plugin-sdk/secret-ref-runtime`'s `resolveSecretRefValues`.
// Resolution order: config SecretRef -> config plain string -> the
// IMAJIN_WAKE_HOOK_TOKEN env var -> none (single startup warning).
// ---------------------------------------------------------------------------

const SECRET_REF = { source: "env", provider: "default", id: "WAKE_HOOK_TOKEN" } as const;
const SECRET_REF_RESOLVED_TOKEN = "secret-ref-resolved-token-do-not-log";

describe("createNotificationInjector — wsNotifications.hookToken as a SecretRef (#20)", () => {
  let fetchMock: ReturnType<typeof makeFetchMock>["fetchMock"];
  let calls: ReturnType<typeof makeFetchMock>["calls"];
  let setImpl: ReturnType<typeof makeFetchMock>["setImpl"];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  function allLoggedText(): string {
    const all = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    return all.map((call) => call.map((arg) => String(arg)).join(" ")).join("\n");
  }

  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    isSecretRefMock.mockClear();
    resolveSecretRefValuesMock.mockReset();
    ({ fetchMock, calls, setImpl } = makeFetchMock());
    vi.stubGlobal("fetch", fetchMock);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves a SecretRef hookToken via resolveSecretRefValues and uses it as the Bearer token", async () => {
    resolveSecretRefValuesMock.mockResolvedValue(new Map([["env:default:WAKE_HOOK_TOKEN", SECRET_REF_RESOLVED_TOKEN]]));
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, { ...CONFIG, hookToken: SECRET_REF });
    // The SecretRef branch dynamically `import()`s two plugin-sdk specifiers;
    // fake timers don't advance that real module-loader promise on their own.
    await vi.dynamicImportSettled();

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(resolveSecretRefValuesMock).toHaveBeenCalledTimes(1);
    expect(resolveSecretRefValuesMock.mock.calls[0][0]).toEqual([SECRET_REF]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = calls[0];
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET_REF_RESOLVED_TOKEN}`);
    dispose();
  });

  it("resolves the SecretRef only once for injector construction, not once per wake", async () => {
    resolveSecretRefValuesMock.mockResolvedValue(new Map([["k", SECRET_REF_RESOLVED_TOKEN]]));
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, { ...CONFIG, hookToken: SECRET_REF });
    await vi.dynamicImportSettled();

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await inject(frame("2"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Two separate wake hook calls, but the SecretRef was only resolved once.
    expect(resolveSecretRefValuesMock).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("an unresolvable SecretRef warns, falls back to the env var, and never throws", async () => {
    resolveSecretRefValuesMock.mockRejectedValue(new Error("SECRET_PROVIDER_NOT_CONFIGURED"));
    process.env[HOOK_TOKEN_ENV] = "env-fallback-after-secretref-failure";
    try {
      setImpl(async () => jsonResponse(200, {}));
      const { api } = makeApi();
      const { inject, dispose } = createNotificationInjector(api, { ...CONFIG, hookToken: SECRET_REF });
      await vi.dynamicImportSettled();

      await expect(inject(frame("1"))).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(COALESCE_MS);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = calls[0];
      expect(init.headers.Authorization).toBe("Bearer env-fallback-after-secretref-failure");
      expect(allLoggedText()).toContain("SecretRef failed to resolve");
      dispose();
    } finally {
      delete process.env[HOOK_TOKEN_ENV];
    }
  });

  it("an unresolvable SecretRef with no env fallback logs the single startup warning and still falls back to the direct-send escalation (no throw)", async () => {
    resolveSecretRefValuesMock.mockRejectedValue(new Error("SECRET_PROVIDER_NOT_CONFIGURED"));
    setImpl(async () => jsonResponse(200, {}));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, { ...CONFIG, hookToken: SECRET_REF });
    await vi.dynamicImportSettled();

    await expect(inject(frame("1"))).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wakeFailureCalls()).toHaveLength(1);
    expect(allLoggedText()).toContain("wake hook token not configured; wake disabled, fallback only");
    dispose();
  });

  it("never logs the SecretRef-resolved token", async () => {
    resolveSecretRefValuesMock.mockResolvedValue(new Map([["k", SECRET_REF_RESOLVED_TOKEN]]));
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, { ...CONFIG, hookToken: SECRET_REF });
    await vi.dynamicImportSettled();

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(allLoggedText()).not.toContain(SECRET_REF_RESOLVED_TOKEN);
    dispose();
  });
});

// ---------------------------------------------------------------------------
// #22: the wake message is evidence (runId, state, title, runTime, artifacts,
// notificationId, errorCode/statusMessage excerpt), not instructions. The
// data projected here is exactly the `{ runId, state, title, runTime,
// statusMessage, artifacts[] }` shape the WS push carries in `nf.data`, plus
// `nf.id` as `notificationId` — no Warp/kernel API calls.
// ---------------------------------------------------------------------------

const NO_INSTRUCTIONS_RE = /react now|merge|report to/i;

function evidenceFrame(id: string, title: string, data: Record<string, unknown>): NotificationFrame {
  return { id, scope: "warp.run.completed", title, body: "", createdAt: "", data } as NotificationFrame;
}

describe("buildWakeTurnMessage — evidence, not instructions (#22)", () => {
  it("renders a single SUCCEEDED run's runId, state, title, runTime, artifacts, and notificationId", () => {
    const nf = evidenceFrame("ntf-1", "#2028 README rebuild — replay 1", {
      runId: "01a077c9-69ad-7335-ab12-a3a022077894",
      state: "SUCCEEDED",
      runTime: "PT20M17S",
      artifacts: [
        {
          type: "PULL_REQUEST",
          url: "https://github.com/ima-jin/imajin-ai/pull/2051",
          branch: "docs/2028-readme-replay-1",
        },
        {
          type: "github_comment",
          url: "https://github.com/ima-jin/imajin-ai/issues/2028#issuecomment-5561026109",
        },
      ],
    });

    const message = buildWakeTurnMessage("warp.run.completed", [nf]);

    expect(message).toContain("warp.run.completed × 1");
    expect(message).toContain("runId: 01a077c9-69ad-7335-ab12-a3a022077894");
    expect(message).toContain("state: SUCCEEDED");
    expect(message).toContain("title: #2028 README rebuild — replay 1");
    expect(message).toContain("runTime: PT20M17S");
    expect(message).toContain(
      "PULL_REQUEST https://github.com/ima-jin/imajin-ai/pull/2051 (docs/2028-readme-replay-1)",
    );
    expect(message).toContain(
      "github_comment https://github.com/ima-jin/imajin-ai/issues/2028#issuecomment-5561026109",
    );
    expect(message).toContain("notificationId: ntf-1");
    expect(message).not.toMatch(NO_INSTRUCTIONS_RE);
  });

  it("renders a FAILED run's errorCode and a ~300-char statusMessage excerpt", () => {
    const nf = evidenceFrame("ntf-2", "#2030 deploy FAILED", {
      runId: "run-failed-1",
      state: "FAILED",
      errorCode: "BUILD_TIMEOUT",
      statusMessage: "x".repeat(500),
    });

    const message = buildWakeTurnMessage("warp.run.completed", [nf]);

    expect(message).toContain("state: FAILED");
    expect(message).toContain("errorCode: BUILD_TIMEOUT");
    expect(message).toContain(`statusMessage: ${"x".repeat(300)}`);
    expect(message).not.toContain("x".repeat(301));
    expect(message).toContain("notificationId: ntf-2");
    expect(message).not.toMatch(NO_INSTRUCTIONS_RE);
  });

  it("renders one evidence entry per run in a batch of two, FAILED first, no instruction text", () => {
    const succeeded = evidenceFrame("ntf-3", "#2031 run A SUCCEEDED", {
      runId: "run-a",
      state: "SUCCEEDED",
    });
    const failed = evidenceFrame("ntf-4", "#2032 run B FAILED", {
      runId: "run-b",
      state: "FAILED",
      errorCode: "OOM",
    });

    const message = buildWakeTurnMessage("warp.run.completed", [succeeded, failed]);

    expect(message).toContain("warp.run.completed × 2");
    expect(message).toContain("runId: run-a");
    expect(message).toContain("runId: run-b");
    expect(message).toContain("errorCode: OOM");
    expect(message).toContain("notificationId: ntf-3");
    expect(message).toContain("notificationId: ntf-4");
    // FAILED/CANCELLED sorts before SUCCEEDED.
    expect(message.indexOf("runId: run-b")).toBeLessThan(message.indexOf("runId: run-a"));
    expect(message).not.toMatch(NO_INSTRUCTIONS_RE);
  });

  // The kernel's actual wire shape (verified in ima-jin/imajin-ai,
  // apps/kernel/src/lib/warp/dispatch.ts's `WarpRunStatusMessage` +
  // packages/bus/src/reactors/notify.ts's payload spread): `statusMessage`
  // arrives as `{ message, errorCode, retryable }`, not a flat string, and
  // there is no top-level `data.errorCode` from the kernel today.
  it("renders a FAILED run's errorCode and statusMessage excerpt when statusMessage is an object", () => {
    const nf = evidenceFrame("ntf-5", "#2033 deploy FAILED", {
      runId: "run-failed-2",
      state: "FAILED",
      statusMessage: { message: "x".repeat(500), errorCode: "BUILD_TIMEOUT", retryable: false },
    });

    const message = buildWakeTurnMessage("warp.run.completed", [nf]);

    expect(message).toContain("state: FAILED");
    expect(message).toContain("errorCode: BUILD_TIMEOUT");
    expect(message).toContain(`statusMessage: ${"x".repeat(300)}`);
    expect(message).not.toContain("x".repeat(301));
    expect(message).toContain("notificationId: ntf-5");
    expect(message).not.toMatch(NO_INSTRUCTIONS_RE);
  });

  it("prefers a top-level data.errorCode over an object statusMessage's errorCode when both are present", () => {
    const nf = evidenceFrame("ntf-6", "#2034 deploy FAILED", {
      runId: "run-failed-3",
      state: "FAILED",
      errorCode: "TOP_LEVEL_CODE",
      statusMessage: { message: "nested message", errorCode: "NESTED_CODE", retryable: true },
    });

    const message = buildWakeTurnMessage("warp.run.completed", [nf]);

    expect(message).toContain("errorCode: TOP_LEVEL_CODE");
    expect(message).not.toContain("NESTED_CODE");
    expect(message).toContain("statusMessage: nested message");
  });

  it("collapses embedded newlines in a title to a single space", () => {
    const nf = evidenceFrame("ntf-7", "#2035 multi-line\ntitle here\r\nsecond line", {
      runId: "run-multiline",
      state: "SUCCEEDED",
    });

    const message = buildWakeTurnMessage("warp.run.completed", [nf]);

    expect(message).toContain("title: #2035 multi-line title here second line");
    expect(message).not.toMatch(/title:.*\n.*here/);
  });
});

describe("createNotificationInjector.inject — wake hook message is evidence (#22)", () => {
  let fetchMock: ReturnType<typeof makeFetchMock>["fetchMock"];
  let calls: ReturnType<typeof makeFetchMock>["calls"];
  let setImpl: ReturnType<typeof makeFetchMock>["setImpl"];

  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    ({ fetchMock, calls, setImpl } = makeFetchMock());
    vi.stubGlobal("fetch", fetchMock);
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs a body whose message carries the SUCCEEDED run's evidence and no instructions", async () => {
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(
      evidenceFrame("ntf-1", "#2028 README rebuild — replay 1", {
        runId: "01a077c9-69ad-7335-ab12-a3a022077894",
        state: "SUCCEEDED",
        runTime: "PT20M17S",
        artifacts: [
          { type: "PULL_REQUEST", url: "https://github.com/ima-jin/imajin-ai/pull/2051", branch: "docs/2028-readme-replay-1" },
          { type: "github_comment", url: "https://github.com/ima-jin/imajin-ai/issues/2028#issuecomment-5561026109" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    const body = JSON.parse(calls[0][1].body);
    const message = String(body.message);
    expect(message).toContain("runId: 01a077c9-69ad-7335-ab12-a3a022077894");
    expect(message).toContain("PULL_REQUEST https://github.com/ima-jin/imajin-ai/pull/2051 (docs/2028-readme-replay-1)");
    expect(message).toContain("github_comment https://github.com/ima-jin/imajin-ai/issues/2028#issuecomment-5561026109");
    expect(message).toContain("notificationId: ntf-1");
    expect(message).not.toMatch(NO_INSTRUCTIONS_RE);
    dispose();
  });

  it("POSTs a body whose message carries a FAILED run's errorCode and no instructions", async () => {
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(
      evidenceFrame("ntf-2", "#2030 deploy FAILED", {
        runId: "run-failed-1",
        state: "FAILED",
        errorCode: "BUILD_TIMEOUT",
      }),
    );
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    const body = JSON.parse(calls[0][1].body);
    const message = String(body.message);
    expect(message).toContain("state: FAILED");
    expect(message).toContain("errorCode: BUILD_TIMEOUT");
    expect(message).toContain("notificationId: ntf-2");
    expect(message).not.toMatch(NO_INSTRUCTIONS_RE);
    dispose();
  });

  it("POSTs a body whose message carries both runs of a coalesced batch and no instructions", async () => {
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(evidenceFrame("ntf-3", "#2031 run A SUCCEEDED", { runId: "run-a", state: "SUCCEEDED" }));
    await inject(evidenceFrame("ntf-4", "#2032 run B FAILED", { runId: "run-b", state: "FAILED", errorCode: "OOM" }));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    const body = JSON.parse(calls[0][1].body);
    const message = String(body.message);
    expect(message).toContain("warp.run.completed × 2");
    expect(message).toContain("notificationId: ntf-3");
    expect(message).toContain("notificationId: ntf-4");
    expect(message).not.toMatch(NO_INSTRUCTIONS_RE);
    dispose();
  });
});

// ---------------------------------------------------------------------------
// #26: `notification_ack` is sent only after the durable enqueue step, a
// replayed id is re-acked without re-injecting, and an owed wake persists
// across a simulated restart with a hook retry/backoff before the Telegram
// fallback.
// ---------------------------------------------------------------------------

describe("createNotificationInjector — notification_ack (#26)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends notification_ack right after the durable enqueue succeeds, before the wake hook ever fires", async () => {
    const { fetchMock, setImpl } = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const sendFrame = vi.fn();
    const { api, enqueueSystemEvent } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG, { sendFrame });

    await inject(frame("1"));

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(sendFrame).toHaveBeenCalledWith({ type: "notification_ack", id: "1" });
    expect(fetchMock).not.toHaveBeenCalled(); // the wake hook hasn't fired yet — ack precedes it
    dispose();
  });

  it("never acks when the durable enqueue throws", async () => {
    const enqueueSystemEvent = vi.fn(() => {
      throw new Error("queue full");
    });
    const api = { runtime: { system: { enqueueSystemEvent }, config: { current: () => ({}) } } };
    const sendFrame = vi.fn();
    const { directSend: _omit, ...noDirect } = CONFIG;
    const { inject, dispose } = createNotificationInjector(api, noDirect, { sendFrame });

    await inject(frame("1"));

    expect(sendFrame).not.toHaveBeenCalled();
    dispose();
  });

  it("never acks when no enqueueSystemEvent API is available at all", async () => {
    const api = { runtime: { config: { current: () => ({}) } } };
    const sendFrame = vi.fn();
    const { directSend: _omit, ...noDirect } = CONFIG;
    const { inject, dispose } = createNotificationInjector(api, noDirect, { sendFrame });

    await inject(frame("1"));

    expect(sendFrame).not.toHaveBeenCalled();
    dispose();
  });

  it("drops the ack when the socket is not open, via the real ImajinWsService.send", async () => {
    const service = new ImajinWsService(
      { nodeUrl: "https://test.imajin.ai", keypairPath: "/fake/.jin-identity.json" },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG, {
      sendFrame: (f) => service.send(f),
    });

    await expect(inject(frame("1"))).resolves.toBeUndefined(); // no socket assigned — must not throw
    dispose();
  });
});

describe("createNotificationInjector — dedup by id across a kernel replay (#26)", () => {
  let fetchMock: ReturnType<typeof makeFetchMock>["fetchMock"];
  let setImpl: ReturnType<typeof makeFetchMock>["setImpl"];

  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    ({ fetchMock, setImpl } = makeFetchMock());
    vi.stubGlobal("fetch", fetchMock);
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("re-acks a replayed id without re-injecting, re-pinging, or re-batching it", async () => {
    const sendFrame = vi.fn();
    const { api, enqueueSystemEvent } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG, { sendFrame });
    const f = frame("dup-1");

    await inject(f);
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    sendFrame.mockClear();

    await inject(f); // the kernel replays the same id (e.g. after a reconnect)

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1); // still just once
    expect(execFileMock).toHaveBeenCalledTimes(1); // not re-pinged
    expect(sendFrame).toHaveBeenCalledWith({ type: "notification_ack", id: "dup-1" });

    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1); // not re-batched into a second wake
    dispose();
  });
});

describe("createNotificationInjector — persisted state across a simulated restart (#26)", () => {
  let tmpDir: string;
  let fetchMock: ReturnType<typeof makeFetchMock>["fetchMock"];
  let setImpl: ReturnType<typeof makeFetchMock>["setImpl"];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "imajin-ws-injector-test-"));
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    ({ fetchMock, setImpl } = makeFetchMock());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("keeps the owed wake marker after a crash and replays it immediately on the next construction (no fresh coalesce wait)", async () => {
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const keypairPath = join(tmpDir, ".jin-identity.json");
    const { api } = makeApi();

    const first = createNotificationInjector(api, CONFIG, { sendFrame: vi.fn(), keypairPath });
    await first.ready;
    await first.inject(frame("r1"));
    // Simulated crash: never advance the coalesce timer, never call dispose().
    expect(fetchMock).not.toHaveBeenCalled();

    const second = createNotificationInjector(api, CONFIG, { sendFrame: vi.fn(), keypairPath });
    await second.ready;

    expect(fetchMock).toHaveBeenCalledTimes(1); // replayed immediately on the "next start"
    second.dispose();
  });

  it("clears the owed marker once the wake is confirmed delivered — no replay on a later restart", async () => {
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const keypairPath = join(tmpDir, ".jin-identity.json");
    const { api } = makeApi();

    const first = createNotificationInjector(api, CONFIG, { sendFrame: vi.fn(), keypairPath });
    await first.ready;
    await first.inject(frame("r1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS); // flush succeeds, marker cleared
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.dispose();

    fetchMock.mockClear();
    const second = createNotificationInjector(api, CONFIG, { sendFrame: vi.fn(), keypairPath });
    await second.ready;

    expect(fetchMock).not.toHaveBeenCalled(); // nothing owed anymore
    second.dispose();
  });

  it("retries a failing hook with backoff and clears the owed marker once a retry succeeds", async () => {
    const keypairPath = join(tmpDir, ".jin-identity.json");
    let call = 0;
    setImpl(async () => {
      call += 1;
      return call < 2 ? jsonResponse(502, { error: "bad gateway" }) : jsonResponse(200, { runId: "run-ok" });
    });
    const { api } = makeApi();
    const { inject, ready, dispose } = createNotificationInjector(api, CONFIG, {
      sendFrame: vi.fn(),
      keypairPath,
    });
    await ready;

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS + HOOK_RETRY_DELAYS_MS[0]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wakeFailureCalls()).toHaveLength(0);
    dispose();

    fetchMock.mockClear();
    const restarted = createNotificationInjector(api, CONFIG, { sendFrame: vi.fn(), keypairPath });
    await restarted.ready;
    expect(fetchMock).not.toHaveBeenCalled(); // cleared on success — nothing to replay
    restarted.dispose();
  });

  it("retains the owed marker after retries are exhausted, and replays it on the next restart", async () => {
    const keypairPath = join(tmpDir, ".jin-identity.json");
    setImpl(async () => jsonResponse(500, { error: "boom" }));
    const { api } = makeApi();
    const { inject, ready, dispose } = createNotificationInjector(api, CONFIG, {
      sendFrame: vi.fn(),
      keypairPath,
    });
    await ready;

    await inject(frame("1"));
    const totalRetryMs = HOOK_RETRY_DELAYS_MS.reduce((sum, d) => sum + d, 0);
    await vi.advanceTimersByTimeAsync(COALESCE_MS + totalRetryMs + 1_000);

    expect(fetchMock).toHaveBeenCalledTimes(HOOK_RETRY_DELAYS_MS.length + 1);
    expect(wakeFailureCalls()).toHaveLength(1); // Telegram fallback fired
    dispose();

    fetchMock.mockClear();
    execFileMock.mockClear();
    const restarted = createNotificationInjector(api, CONFIG, { sendFrame: vi.fn(), keypairPath });
    await restarted.ready;

    expect(fetchMock).toHaveBeenCalledTimes(1); // marker retained -> replayed on the next start
    restarted.dispose();
  });
});

// ---------------------------------------------------------------------------
// #25: leading-edge + trailing wake coalescing. The old trailing-only
// DEFAULT_WAKE_COALESCE_MS (5 min) was the *entire* observed wake lag for a
// single completion (measured 5m10s / 5m09s on two separate runs, both
// batches n=1). Leading-edge + trailing surfaces a single completion in
// ~wakeSettleMs while still capping a burst at two wake turns.
// ---------------------------------------------------------------------------

describe("createNotificationInjector — leading-edge + trailing wake coalescing (#25)", () => {
  const SETTLE_MS = 500;
  const TRAILING_MS = 2_000;
  const LT_CONFIG: WsNotificationsConfig = {
    ...CONFIG,
    wakeSettleMs: SETTLE_MS,
    wakeCoalesceMs: TRAILING_MS,
  };

  let fetchMock: ReturnType<typeof makeFetchMock>["fetchMock"];
  let calls: ReturnType<typeof makeFetchMock>["calls"];
  let setImpl: ReturnType<typeof makeFetchMock>["setImpl"];

  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    ({ fetchMock, calls, setImpl } = makeFetchMock());
    vi.stubGlobal("fetch", fetchMock);
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("defaults wakeSettleMs to 10s and wakeCoalesceMs to 30s (was 300s)", () => {
    expect(DEFAULT_WAKE_SETTLE_MS).toBe(10_000);
    expect(DEFAULT_WAKE_COALESCE_MS).toBe(30_000);
  });

  it("a single frame fires exactly one wake after wakeSettleMs, with no trailing wake", async () => {
    const { inject, dispose } = createNotificationInjector(makeApi().api, LT_CONFIG);

    await inject(frame("1"));
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1); // leading wake
    expect(calls[0][1].headers["Idempotency-Key"]).toMatch(/:leading$/);

    // Nothing else arrives — the trailing window must not produce a second wake.
    await vi.advanceTimersByTimeAsync(TRAILING_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("a burst batches into the leading wake during settle, and later arrivals batch into exactly one trailing wake", async () => {
    const { inject, dispose } = createNotificationInjector(makeApi().api, LT_CONFIG);

    await inject(frame("1", "Warp run 1 SUCCEEDED"));
    await inject(frame("2", "Warp run 2 SUCCEEDED")); // joins the leading batch (still within settle)
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const leadingMessage = String(JSON.parse(calls[0][1].body).message);
    expect(leadingMessage).toContain("× 2");
    expect(leadingMessage).toContain("Warp run 1 SUCCEEDED");
    expect(leadingMessage).toContain("Warp run 2 SUCCEEDED");

    // Arrive during the trailing window — must batch together, not each fire its own wake.
    await inject(frame("3", "Warp run 3 SUCCEEDED"));
    await inject(frame("4", "Warp run 4 SUCCEEDED"));
    await vi.advanceTimersByTimeAsync(TRAILING_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2); // exactly leading + one trailing wake
    expect(calls[1][1].headers["Idempotency-Key"]).toMatch(/:trailing$/);
    const trailingMessage = String(JSON.parse(calls[1][1].body).message);
    expect(trailingMessage).toContain("× 2");
    expect(trailingMessage).toContain("Warp run 3 SUCCEEDED");
    expect(trailingMessage).toContain("Warp run 4 SUCCEEDED");
    expect(trailingMessage).not.toContain("Warp run 1 SUCCEEDED");
    expect(trailingMessage).not.toContain("Warp run 2 SUCCEEDED");
    dispose();
  });

  it("a frame arriving after the trailing window closes starts a brand-new leading wake", async () => {
    const { inject, dispose } = createNotificationInjector(makeApi().api, LT_CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(SETTLE_MS); // leading wake #1
    await vi.advanceTimersByTimeAsync(TRAILING_MS); // trailing window closes with nothing pending
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstKey = calls[0][1].headers["Idempotency-Key"];

    await inject(frame("2")); // scope is idle again — a brand-new leading window
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondKey = calls[1][1].headers["Idempotency-Key"];
    expect(secondKey).toMatch(/:leading$/);
    expect(secondKey).not.toBe(firstKey); // fresh windowStart

    // And it too must not produce a stray trailing wake on its own.
    await vi.advanceTimersByTimeAsync(TRAILING_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("a replayed duplicate frame during the settle window does not add an extra wake", async () => {
    const { inject, dispose } = createNotificationInjector(makeApi().api, LT_CONFIG);
    const f = frame("dup-1");

    await inject(f);
    await inject(f); // kernel replay of the same id, still inside the settle window
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const message = String(JSON.parse(calls[0][1].body).message);
    expect(message).toContain("× 1"); // the duplicate must not be counted twice
    dispose();
  });

  it("a replayed duplicate frame during the trailing window does not add an extra wake", async () => {
    const { inject, dispose } = createNotificationInjector(makeApi().api, LT_CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(SETTLE_MS); // leading wake fires, trailing window opens
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const f2 = frame("2");
    await inject(f2);
    await inject(f2); // replay during the trailing window
    await vi.advanceTimersByTimeAsync(TRAILING_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2); // leading + exactly one trailing wake
    const trailingMessage = String(JSON.parse(calls[1][1].body).message);
    expect(trailingMessage).toContain("× 1");
    dispose();
  });

  it("honours a config override of both wakeSettleMs and wakeCoalesceMs", async () => {
    const CUSTOM_SETTLE_MS = 300;
    const CUSTOM_TRAILING_MS = 700;
    const { inject, dispose } = createNotificationInjector(makeApi().api, {
      ...CONFIG,
      wakeSettleMs: CUSTOM_SETTLE_MS,
      wakeCoalesceMs: CUSTOM_TRAILING_MS,
    });

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(CUSTOM_SETTLE_MS - 100);
    expect(fetchMock).not.toHaveBeenCalled(); // settle hasn't elapsed yet
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(1); // leading wake at exactly wakeSettleMs

    await inject(frame("2"));
    await vi.advanceTimersByTimeAsync(CUSTOM_TRAILING_MS - 100);
    expect(fetchMock).toHaveBeenCalledTimes(1); // trailing window hasn't elapsed yet
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(2); // trailing wake at exactly wakeCoalesceMs
    dispose();
  });
});

function frameWithScope(id: string, scope: string): NotificationFrame {
  return { id, scope, title: `run ${id}`, body: "", createdAt: "", data: {} } as NotificationFrame;
}

// ---------------------------------------------------------------------------
// #31: `wake-pending` classification. A client-side timeout or a 503 whose
// JSON body carries a `runId` means the gateway already has (or is about to
// have) a real turn running/queued for this session — not a rejection. These
// outcomes log one info line, skip the retry ladder entirely, and keep the
// owed marker so a later 2xx (this run or a replay after restart) clears it.
// A runId-less 503 (and every other non-2xx/network failure) is unaffected
// and keeps walking `HOOK_RETRY_DELAYS_MS` exactly as before (#26).
// ---------------------------------------------------------------------------

describe("createNotificationInjector — wake-pending classification (#31)", () => {
  let fetchMock: ReturnType<typeof makeFetchMock>["fetchMock"];
  let setImpl: ReturnType<typeof makeFetchMock>["setImpl"];

  beforeEach(() => {
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    ({ fetchMock, setImpl } = makeFetchMock());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("503 with a runId in the JSON body classifies as wake-pending: one attempt, no retry, no Telegram fallback", async () => {
    setImpl(async () =>
      jsonResponse(503, {
        ok: false,
        error: "hook agent run did not start before admission timeout",
        runId: "run-queued-1",
      }),
    );
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wakeFailureCalls()).toHaveLength(0);
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining("wake pending for warp.run.completed: 1 notification(s), 1 frame(s) durable"),
    );

    await vi.advanceTimersByTimeAsync(TOTAL_RETRY_WINDOW_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still just one attempt
    dispose();
  });

  it("503 without a runId in the body keeps the existing retry ladder (#26 unchanged)", async () => {
    setImpl(async () => jsonResponse(503, { ok: false, error: "service unavailable" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(wakeFailureCalls()).toHaveLength(0); // still retrying

    await vi.advanceTimersByTimeAsync(TOTAL_RETRY_WINDOW_MS);

    expect(fetchMock).toHaveBeenCalledTimes(HOOK_RETRY_DELAYS_MS.length + 1);
    expect(wakeFailureCalls()).toHaveLength(1);
    dispose();
  });

  it("a 503 with a non-JSON body is not classified as pending and keeps the retry ladder", async () => {
    setImpl(async () => ({ status: 503, text: async () => "upstream connect error", json: async () => { throw new Error("not json"); } }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS + TOTAL_RETRY_WINDOW_MS);

    expect(fetchMock).toHaveBeenCalledTimes(HOOK_RETRY_DELAYS_MS.length + 1);
    expect(wakeFailureCalls()).toHaveLength(1);
    dispose();
  });

  it("caps concurrent wake POSTs at one per session: a second scope's completion waits for the first to settle (#30)", async () => {
    let resolveFirst!: (value: FetchResponse) => void;
    const firstResponse = new Promise<FetchResponse>((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    setImpl(async () => {
      callCount += 1;
      return callCount === 1 ? firstResponse : jsonResponse(200, { runId: "run-2" });
    });
    const { api } = makeApi();
    const TWO_SCOPE_CONFIG: WsNotificationsConfig = {
      ...CONFIG,
      injectScopes: ["warp.run.completed", "warp.run.failed"],
    };
    const { inject, dispose } = createNotificationInjector(api, TWO_SCOPE_CONFIG);

    await inject(frame("1")); // scope warp.run.completed
    await vi.advanceTimersByTimeAsync(COALESCE_MS); // its leading wake fires, fetch #1 in flight (unresolved)
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await inject(frameWithScope("2", "warp.run.failed")); // a second, independent completion
    await vi.advanceTimersByTimeAsync(COALESCE_MS); // its own leading wake elapses too
    expect(fetchMock).toHaveBeenCalledTimes(1); // queued behind #1 — same session, in-flight cap 1

    resolveFirst(jsonResponse(200, { runId: "run-1" }));
    await vi.advanceTimersByTimeAsync(0); // let the queue advance to the next task

    expect(fetchMock).toHaveBeenCalledTimes(2); // #2 now proceeds
    dispose();
  });
});

// ---------------------------------------------------------------------------
// #30: owed-wake replay drains sequentially instead of fanning out. Several
// markers accumulated for the same scope before a restart merge into ONE
// leading-phase wake (union of frames, earliest sinceTs); a marker older
// than `wakeOwedMaxAgeMs` is dropped (its frames already reached the agent
// via `enqueueSystemEvent`) instead of firing a stale wake turn.
// ---------------------------------------------------------------------------

describe("createNotificationInjector — owed-wake replay drains, doesn't fan out (#30)", () => {
  let tmpDir: string;
  let fetchMock: ReturnType<typeof makeFetchMock>["fetchMock"];
  let calls: ReturnType<typeof makeFetchMock>["calls"];
  let setImpl: ReturnType<typeof makeFetchMock>["setImpl"];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "imajin-ws-owed-replay-test-"));
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    ({ fetchMock, calls, setImpl } = makeFetchMock());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("merges 5 owed markers for the same scope into exactly one wake with the union of frames", async () => {
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const keypairPath = join(tmpDir, ".jin-identity.json");
    const stateDir = resolveStateDir(undefined, keypairPath)!;
    const seedStore = new PendingWakeStore(join(stateDir, PENDING_WAKES_FILENAME));
    await seedStore.load();
    const baseTs = Date.now() - 5_000;
    for (let i = 0; i < 5; i += 1) {
      await seedStore.set(`warp.run.completed:${baseTs + i}:leading`, {
        scope: "warp.run.completed",
        sinceTs: baseTs + i,
        frames: [frame(`r${i}`)],
        injected: true,
      });
    }

    const { api } = makeApi();
    const { ready, dispose } = createNotificationInjector(api, CONFIG, {
      sendFrame: vi.fn(),
      keypairPath,
    });
    await ready;
    // The merged replay's flush is fire-and-forget from `ready`'s point of
    // view (it never blocks startup on a wake's outcome) — give its promise
    // chain (fetch -> json() -> persisted delete) a tick to finish.
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1); // one drained wake, not five
    const body = JSON.parse(calls[0][1].body);
    expect(String(body.message)).toContain("warp.run.completed × 5");
    // Merged replay always fires as "leading", keyed by the earliest sinceTs.
    expect(calls[0][1].headers["Idempotency-Key"]).toBe(`imajin-wake:warp.run.completed:${baseTs}:leading`);

    // Consolidated to a single persisted marker (cleared on the 2xx above).
    const reloaded = new PendingWakeStore(join(stateDir, PENDING_WAKES_FILENAME));
    await reloaded.load();
    expect(reloaded.all()).toEqual([]);
    dispose();
  });

  it("drops an owed marker older than wakeOwedMaxAgeMs without waking, and clears it", async () => {
    const keypairPath = join(tmpDir, ".jin-identity.json");
    const stateDir = resolveStateDir(undefined, keypairPath)!;
    const seedStore = new PendingWakeStore(join(stateDir, PENDING_WAKES_FILENAME));
    await seedStore.load();
    const staleTs = Date.now() - (DEFAULT_WAKE_OWED_MAX_AGE_MS + 60_000);
    await seedStore.set(`warp.run.completed:${staleTs}:leading`, {
      scope: "warp.run.completed",
      sinceTs: staleTs,
      frames: [frame("stale-1")],
      injected: true,
    });

    const { api } = makeApi();
    const { ready, dispose } = createNotificationInjector(api, CONFIG, {
      sendFrame: vi.fn(),
      keypairPath,
    });
    await ready;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("owed wake expired for warp.run.completed (1 frame(s)"),
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("injected only"));

    const reloaded = new PendingWakeStore(join(stateDir, PENDING_WAKES_FILENAME));
    await reloaded.load();
    expect(reloaded.all()).toEqual([]); // cleared — nothing left to replay on a further restart
    dispose();
  });

  it("a fresh (non-expired) marker for a different scope still replays normally alongside an expired one", async () => {
    setImpl(async () => jsonResponse(200, { runId: "run-1" }));
    const keypairPath = join(tmpDir, ".jin-identity.json");
    const stateDir = resolveStateDir(undefined, keypairPath)!;
    const seedStore = new PendingWakeStore(join(stateDir, PENDING_WAKES_FILENAME));
    await seedStore.load();
    const staleTs = Date.now() - (DEFAULT_WAKE_OWED_MAX_AGE_MS + 60_000);
    await seedStore.set(`warp.run.completed:${staleTs}:leading`, {
      scope: "warp.run.completed",
      sinceTs: staleTs,
      frames: [frame("stale-1")],
      injected: true,
    });
    const freshTs = Date.now() - 1_000;
    await seedStore.set(`warp.run.failed:${freshTs}:leading`, {
      scope: "warp.run.failed",
      sinceTs: freshTs,
      frames: [frameWithScope("fresh-1", "warp.run.failed")],
      injected: true,
    });

    const { api } = makeApi();
    const TWO_SCOPE_CONFIG: WsNotificationsConfig = {
      ...CONFIG,
      injectScopes: ["warp.run.completed", "warp.run.failed"],
    };
    const { ready, dispose } = createNotificationInjector(api, TWO_SCOPE_CONFIG, {
      sendFrame: vi.fn(),
      keypairPath,
    });
    await ready;

    expect(fetchMock).toHaveBeenCalledTimes(1); // only the fresh scope woke
    const body = JSON.parse(calls[0][1].body);
    expect(String(body.message)).toContain("warp.run.failed");
    dispose();
  });
});

// ---------------------------------------------------------------------------
// #31 + #30 interaction: a wake-pending outcome keeps the owed marker across
// a restart, and a later 2xx (on that replay) clears it — same contract as
// the pre-existing #26 retry-then-clear restart tests.
// ---------------------------------------------------------------------------

describe("createNotificationInjector — wake-pending marker survives a restart and clears on a later 2xx (#31)", () => {
  let tmpDir: string;
  let fetchMock: ReturnType<typeof makeFetchMock>["fetchMock"];
  let setImpl: ReturnType<typeof makeFetchMock>["setImpl"];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "imajin-ws-pending-restart-test-"));
    vi.useFakeTimers();
    execFileMock.mockReset();
    stubExecFile("ok");
    ({ fetchMock, setImpl } = makeFetchMock());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("keeps the marker after a wake-pending outcome, then clears it on a 2xx replay after restart", async () => {
    const keypairPath = join(tmpDir, ".jin-identity.json");
    setImpl(async () =>
      jsonResponse(503, { ok: false, error: "admission timeout", runId: "run-queued-1" }),
    );
    const { api } = makeApi();
    const { inject, ready, dispose } = createNotificationInjector(api, CONFIG, {
      sendFrame: vi.fn(),
      keypairPath,
    });
    await ready;

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wakeFailureCalls()).toHaveLength(0); // pending, not a failure
    dispose();

    fetchMock.mockClear();
    setImpl(async () => jsonResponse(200, { runId: "run-ok" }));
    const restarted = createNotificationInjector(api, CONFIG, { sendFrame: vi.fn(), keypairPath });
    await restarted.ready;

    expect(fetchMock).toHaveBeenCalledTimes(1); // marker retained -> replayed on the next start
    // Same as above: let the replay's 2xx flush finish persisting the delete
    // before tearing down and reading the file again.
    await vi.advanceTimersByTimeAsync(0);
    restarted.dispose();

    fetchMock.mockClear();
    const restartedAgain = createNotificationInjector(api, CONFIG, {
      sendFrame: vi.fn(),
      keypairPath,
    });
    await restartedAgain.ready;

    expect(fetchMock).not.toHaveBeenCalled(); // cleared by the prior 2xx — nothing left to replay
    restartedAgain.dispose();
  });
});
