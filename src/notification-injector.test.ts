import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import type { NotificationFrame } from "./ws-service.js";
import {
  createNotificationInjector,
  HOOK_REQUEST_TIMEOUT_MS,
  HOOK_TOKEN_ENV,
  type WsNotificationsConfig,
} from "./notification-injector.js";

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
const COALESCE_MS = 1_000;
const HOOK_TOKEN = "test-hook-token-do-not-log";
const CONFIG: WsNotificationsConfig = {
  injectScopes: ["warp.run.completed"],
  targetSession: SESSION,
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
    expect(String(body.message)).toContain("Warp runs completed (3) — 1 need attention");
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
    expect(String(body.message)).toContain("Warp runs completed (2)");
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
    expect(init.headers["Idempotency-Key"]).toMatch(/^imajin-wake:warp\.run\.completed:\d+$/);

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

  it("401 → Telegram fallback fires", async () => {
    setImpl(async () => jsonResponse(401, { error: "unauthorized" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(wakeFailureCalls()).toHaveLength(1);
    expect(String(wakeFailureCalls()[0][1])).toContain("automatic wake failed");
    dispose();
  });

  it("500 → Telegram fallback fires", async () => {
    setImpl(async () => jsonResponse(500, { error: "boom" }));
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(wakeFailureCalls()).toHaveLength(1);
    dispose();
  });

  it("ECONNREFUSED → Telegram fallback fires", async () => {
    setImpl(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18789"), { code: "ECONNREFUSED" });
    });
    const { api } = makeApi();
    const { inject, dispose } = createNotificationInjector(api, CONFIG);

    await inject(frame("1"));
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(wakeFailureCalls()).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
    dispose();
  });

  it("timeout (~10s, no response) → Telegram fallback fires", async () => {
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
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    await vi.advanceTimersByTimeAsync(HOOK_REQUEST_TIMEOUT_MS);

    expect(wakeFailureCalls()).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`timed out after ${HOOK_REQUEST_TIMEOUT_MS}ms`));
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
