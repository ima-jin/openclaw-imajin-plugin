import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import {
  ImajinWsService,
  parseFrame,
  isNotificationFrame,
  isAuthFailureFrame,
  computeReconnectDelayMs,
  AUTH_REFRESH_INTERVAL_MS,
  type NotificationFrame,
  type FrameHandler,
} from "./ws-service.js";

const NODE_URL = "https://test.imajin.ai";
const KEYPAIR_PATH = "/fake/.jin-identity.json";
const KEYPAIR_JSON = JSON.stringify({
  did: "did:imajin:agent",
  publicKey: "aa".repeat(32),
  privateKey: "11".repeat(32),
});

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

// The `ws` package is a real dependency, so an unmocked dynamic `import("ws")`
// would construct a real socket that tries to reach the network. Forcing it to
// fail exercises the native-WebSocket fallback deterministically — the exact
// path the auth handshake bug lived in (see ws-service.ts's connect()).
vi.mock("ws", () => {
  throw new Error("ws not available in this sandbox");
});

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private listeners: Record<string, Array<(evt: any) => void>> = {};

  constructor(
    public url: string,
    public opts?: { headers?: Record<string, string> },
  ) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (evt: any) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.closedWith = { code, reason };
    this.emit("close", { code: code ?? 1000, reason: reason ?? "" });
  }

  emit(type: string, evt: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(evt);
  }

  triggerOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open", {});
  }

  triggerMessage(data: string): void {
    this.emit("message", { data });
  }
}

function mockFetchRoutes(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const key = `${method} ${new URL(url).pathname}`;

    if (overrides[key]) return overrides[key]();
    if (key === "POST /auth/api/login/challenge") {
      return jsonResponse({ challengeId: "chal_1", challenge: "deadbeef" });
    }
    if (key === "POST /auth/api/login/verify") {
      return jsonResponse(
        { did: "did:imajin:agent" },
        { "set-cookie": "imajin_session=sess_abc123; Path=/; HttpOnly" },
      );
    }
    if (key === "GET /chat/api/ws-token") {
      return jsonResponse({ token: "wstok_123" });
    }
    throw new Error(`unhandled fetch: ${key}`);
  });
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(headers),
  } as unknown as Response;
}

beforeEach(() => {
  FakeSocket.instances = [];
  (global as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  global.fetch = mockFetchRoutes() as unknown as typeof fetch;
  // `afterEach`'s `vi.restoreAllMocks()` clears any `mockResolvedValue` set on
  // this `vi.fn()` (it has no "real" implementation to restore to), so it has
  // to be re-armed before every test rather than once in the `vi.mock` factory.
  vi.mocked(readFile).mockResolvedValue(KEYPAIR_JSON);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("parseFrame", () => {
  it("parses a well-formed JSON object frame", () => {
    expect(parseFrame('{"type":"notification","id":"ntf_1"}')).toEqual({
      type: "notification",
      id: "ntf_1",
    });
  });

  it("returns null for heartbeat and empty frames", () => {
    expect(parseFrame("pong")).toBeNull();
    expect(parseFrame("")).toBeNull();
  });

  it("returns null for invalid JSON and values without a string type", () => {
    expect(parseFrame("{not-json")).toBeNull();
    expect(parseFrame("42")).toBeNull();
    expect(parseFrame("null")).toBeNull();
    expect(parseFrame('{"id":"x"}')).toBeNull();
    expect(parseFrame('{"type":123}')).toBeNull();
  });
});

describe("isNotificationFrame", () => {
  const base: NotificationFrame = {
    type: "notification",
    id: "ntf_1",
    scope: "warp.run.completed",
    title: "Run SUCCEEDED",
    body: "Nightly build succeeded",
    data: { runId: "run_1", state: "SUCCEEDED" },
    createdAt: "2026-08-31T00:00:00.000Z",
  };

  it("accepts a well-formed notification frame, including a null body", () => {
    expect(isNotificationFrame(base)).toBe(true);
    expect(isNotificationFrame({ ...base, body: null })).toBe(true);
  });

  it("rejects frames missing id, scope, or title", () => {
    const { id: _id, ...noId } = base;
    expect(isNotificationFrame(noId as unknown as NotificationFrame)).toBe(false);
    expect(isNotificationFrame({ ...base, scope: undefined } as unknown as NotificationFrame)).toBe(
      false,
    );
    expect(isNotificationFrame({ ...base, title: 5 } as unknown as NotificationFrame)).toBe(false);
  });

  it("rejects non-notification frames", () => {
    expect(isNotificationFrame({ type: "chat_message" } as any)).toBe(false);
  });
});

describe("isAuthFailureFrame", () => {
  it("recognizes the kernel's auth_required and auth error frames", () => {
    expect(isAuthFailureFrame({ type: "auth_required" })).toBe(true);
    expect(isAuthFailureFrame({ type: "error", message: "Authentication failed" })).toBe(true);
  });

  it("ignores unrelated error and data frames", () => {
    expect(isAuthFailureFrame({ type: "error", message: "Invalid message" })).toBe(false);
    expect(isAuthFailureFrame({ type: "connected" })).toBe(false);
    expect(isAuthFailureFrame({ type: "notification" })).toBe(false);
  });
});

describe("computeReconnectDelayMs", () => {
  it("doubles from the base delay on each attempt", () => {
    expect(computeReconnectDelayMs(0)).toBe(2_000);
    expect(computeReconnectDelayMs(1)).toBe(4_000);
    expect(computeReconnectDelayMs(2)).toBe(8_000);
    expect(computeReconnectDelayMs(3)).toBe(16_000);
  });

  it("caps at the max reconnect delay", () => {
    expect(computeReconnectDelayMs(10)).toBe(60_000);
    expect(computeReconnectDelayMs(100)).toBe(60_000);
  });
});

describe("ImajinWsService native WebSocket auth", () => {
  it("fetches a ws-token with the session cookie and sends the token, never the raw cookie", async () => {
    vi.useFakeTimers();
    const service = new ImajinWsService(
      { nodeUrl: NODE_URL, did: "did:imajin:agent", keypairPath: KEYPAIR_PATH },
      silentLogger(),
    );

    await service.start();

    const socket = FakeSocket.instances[0];
    expect(socket).toBeDefined();
    socket.triggerOpen();
    const authMsg = JSON.parse(socket.sent[0]);
    expect(authMsg).toEqual({ type: "auth", token: "wstok_123" });
    expect(authMsg.cookie).toBeUndefined();
    service.stop();
  });

  it("never authenticates by echoing the raw session cookie back over the socket", async () => {
    vi.useFakeTimers();
    const service = new ImajinWsService({ nodeUrl: NODE_URL, keypairPath: KEYPAIR_PATH }, silentLogger());
    await service.start();

    const socket = FakeSocket.instances[0];
    socket.triggerOpen();
    expect(socket.sent.some((m) => m.includes("sess_abc123"))).toBe(false);
    service.stop();
  });
});

describe("ImajinWsService frame routing", () => {
  async function startedService(logger = silentLogger()) {
    const service = new ImajinWsService({ nodeUrl: NODE_URL, keypairPath: KEYPAIR_PATH }, logger);
    // Inject a fake socket and exercise the private dispatch method through a
    // narrow test-only structural cast; the service's public onFrame contract
    // is the behavior under test, not the transport constructor.
    const serviceInternal = service as unknown as {
      dispatchFrame: (frame: unknown) => void;
    };
    return { service, serviceInternal, logger };
  }

  it("delivers a well-formed notification frame to registered handlers", async () => {
    const { service, serviceInternal } = await startedService();
    const handler: FrameHandler = vi.fn();
    service.onFrame(handler);
    const frame: NotificationFrame = {
      type: "notification",
      id: "ntf_1",
      scope: "warp.run.completed",
      title: "Run SUCCEEDED",
      body: "Nightly build succeeded",
      data: { runId: "run_1" },
      createdAt: "2026-08-31T00:00:00.000Z",
    };

    serviceInternal.dispatchFrame(frame);
    expect(handler).toHaveBeenCalledWith(frame);
  });

  it("drops a malformed notification without invoking handlers or crashing", async () => {
    const { service, serviceInternal, logger } = await startedService();
    const handler: FrameHandler = vi.fn();
    service.onFrame(handler);

    expect(() => serviceInternal.dispatchFrame({ type: "notification", id: "ntf_1" })).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("dropped malformed notification"));
  });

  it("passes unknown frame types through for graceful log-and-ignore by the caller", async () => {
    const { service, serviceInternal } = await startedService();
    const handler: FrameHandler = vi.fn();
    service.onFrame(handler);
    const chatFrame = { type: "chat_message", conversationDid: "did:imajin:dm:1" };

    serviceInternal.dispatchFrame(chatFrame);
    expect(handler).toHaveBeenCalledWith(chatFrame);
  });

  it("isolates handler exceptions so they never crash the socket", async () => {
    const { service, serviceInternal, logger } = await startedService();
    service.onFrame(() => {
      throw new Error("boom");
    });

    expect(() =>
      serviceInternal.dispatchFrame({
        type: "notification",
        id: "ntf_1",
        scope: "s",
        title: "t",
      }),
    ).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("frame handler error"));
  });
});

describe("ImajinWsService reconnect and shutdown", () => {
  it("uses increasing delays when reconnects repeatedly fail", () => {
    vi.useFakeTimers();
    const logger = silentLogger();
    const service = new ImajinWsService({ nodeUrl: NODE_URL, keypairPath: KEYPAIR_PATH }, logger);
    const serviceInternal = service as unknown as {
      reconnectAttempt: number;
      scheduleReconnect: () => void;
    };

    serviceInternal.scheduleReconnect();
    serviceInternal.scheduleReconnect();
    expect(logger.info).toHaveBeenCalledWith("reconnecting in 2000ms (attempt 1)");
    expect(logger.info).toHaveBeenCalledWith("reconnecting in 4000ms (attempt 2)");
    service.stop();
  });

  it("stop cancels pending reconnect and auth-refresh timers", () => {
    vi.useFakeTimers();
    const service = new ImajinWsService({ nodeUrl: NODE_URL, keypairPath: KEYPAIR_PATH }, silentLogger());
    const serviceInternal = service as unknown as {
      scheduleReconnect: () => void;
      scheduleAuthRefresh: () => void;
    };
    serviceInternal.scheduleReconnect();
    serviceInternal.scheduleAuthRefresh();

    service.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("auth refresh clears the cookie and closes the live socket", async () => {
    vi.useFakeTimers();
    const service = new ImajinWsService({ nodeUrl: NODE_URL, keypairPath: KEYPAIR_PATH }, silentLogger());
    const socket = new FakeSocket("wss://test.imajin.ai/chat/ws");
    socket.readyState = FakeSocket.OPEN;
    const serviceInternal = service as unknown as {
      ws: WebSocket;
      sessionCookie: string;
      scheduleAuthRefresh: () => void;
    };
    serviceInternal.ws = socket as unknown as WebSocket;
    serviceInternal.sessionCookie = "imajin_session=old";
    serviceInternal.scheduleAuthRefresh();

    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_INTERVAL_MS);
    expect(serviceInternal.sessionCookie).toBeNull();
    expect(socket.closedWith).toEqual({ code: 4000, reason: "auth refresh" });
    service.stop();
  });
});
