/**
 * Imajin WebSocket notification service.
 *
 * Background service that maintains a persistent WebSocket connection to the
 * kernel's chat/notification endpoint. Authenticates via Ed25519 challenge-response
 * (same flow as ImajinClient), handles heartbeat/reconnect/auth-refresh, and parses
 * inbound frames (chat messages + notification pushes from #1645).
 *
 * Prefers the `ws` package (supports a `Cookie` header on the upgrade request, which
 * is how `apps/kernel/ws-server.js`'s `authenticateWithCookie` authenticates before
 * the socket ever opens). When `ws` isn't resolvable in the host's plugin sandbox, it
 * falls back to native WebSocket (Node 22+, no header support) and authenticates
 * post-connect via the kernel's short-lived WS token exchange instead:
 *   1. `GET /chat/api/ws-token` with the session cookie → `{ token }` (30s TTL, one-time use)
 *   2. send `{ type: "auth", token }` — matches `authenticateWsToken` in ws-server.js
 * A prior version of this fallback sent `{ type: "auth", cookie, did }`, which the
 * kernel's deferred-auth branch never recognizes (it only looks at `msg.token`) — that
 * path silently never authenticated. See PR description for details.
 *
 * Registered via api.registerService() in the plugin entry.
 */

import { readFile } from "node:fs/promises";

// --- Types ---

export interface WsServiceConfig {
  nodeUrl: string;
  did?: string;
  keypairPath?: string;
  actAs?: string;
}

export interface NotificationFrame {
  type: "notification";
  id: string;
  scope: string;
  title: string;
  /** The kernel's `notifications.body` column allows null (see `ws-push.ts`). */
  body: string | null;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface ChatMessageFrame {
  type: "chat_message";
  conversationDid: string;
  message: {
    id: string;
    fromDid: string;
    content: unknown;
    createdAt: string;
  };
}

type InboundFrame = NotificationFrame | ChatMessageFrame | { type: string; [k: string]: unknown };

export type FrameHandler = (frame: InboundFrame) => void;

interface Keypair {
  did: string;
  publicKey: string;
  publicKeyHex: string;
  privateKey: string;
}

interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

/**
 * `ws.addEventListener("close", …)` is typed against `CloseEvent`, which lib.dom
 * provides but this project's `lib: ["ES2022"]` tsconfig does not. Both the `ws`
 * package's close event and the native one carry `code`/`reason`, so a small
 * structural type covers both without pulling in DOM lib globals.
 */
interface WsCloseEvent {
  code?: number;
  reason?: string;
}

// --- Pure helpers (exported for unit testing) ---

/**
 * Parse one inbound WS frame. Returns `null` for the heartbeat `pong`/empty
 * frames and anything that isn't a JSON object carrying a string `type` —
 * callers should log-and-ignore on `null` rather than throw, so a malformed
 * frame can never crash the socket.
 */
export function parseFrame(raw: string): InboundFrame | null {
  if (raw === "" || raw === "pong") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { type?: unknown }).type !== "string"
  ) {
    return null;
  }
  return parsed as InboundFrame;
}

/** Narrows a `notification`-typed frame down to one carrying the required fields. */
export function isNotificationFrame(frame: InboundFrame): frame is NotificationFrame {
  const f = frame as Partial<NotificationFrame>;
  return (
    frame.type === "notification" &&
    typeof f.id === "string" &&
    typeof f.scope === "string" &&
    typeof f.title === "string"
  );
}

/** True for the kernel's `auth_required` control frame or an auth-flavored `error` frame. */
export function isAuthFailureFrame(frame: InboundFrame): boolean {
  if (frame.type === "auth_required") return true;
  if (frame.type !== "error") return false;
  const message = (frame as { message?: unknown }).message;
  return typeof message === "string" && /auth/i.test(message);
}

// --- Service ---

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
// The kernel's session JWT is valid for 24h (`JWT_EXPIRY` in `apps/kernel/src/lib/auth/jwt.ts`).
// Refresh well before that so a long-lived connection never rides a cookie all the way to
// expiry and has to discover it's stale only after the kernel rejects it.
export const AUTH_REFRESH_INTERVAL_MS = 20 * 60 * 60_000; // 20h

/** Exponential backoff, capped, for WS reconnect attempts. Exported for unit tests. */
export function computeReconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
}

export class ImajinWsService {
  private ws: WebSocket | null = null;
  private keypair: Keypair | null = null;
  private sessionCookie: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private authRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private handlers: FrameHandler[] = [];
  private logger: Logger;

  constructor(
    private config: WsServiceConfig,
    logger?: Logger,
  ) {
    this.logger = logger ?? {
      info: (msg, ...a) => console.log(`[imajin-ws] ${msg}`, ...a),
      warn: (msg, ...a) => console.warn(`[imajin-ws] ${msg}`, ...a),
      error: (msg, ...a) => console.error(`[imajin-ws] ${msg}`, ...a),
    };
  }

  /** Register a handler for inbound frames. */
  onFrame(handler: FrameHandler): void {
    this.handlers.push(handler);
  }

  /** Start the WebSocket connection (called by plugin service lifecycle). */
  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempt = 0;
    await this.connect();
  }

  /** Stop the WebSocket connection and cancel reconnects. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, "service stopping");
      this.ws = null;
    }
    this.logger.info("stopped");
  }

  // --- Auth (mirrors ImajinClient) ---

  private async loadKeypair(): Promise<Keypair> {
    if (this.keypair) return this.keypair;
    if (!this.config.keypairPath) {
      throw new Error("No keypairPath configured — cannot authenticate WS");
    }
    const raw = await readFile(this.config.keypairPath, "utf-8");
    const parsed = JSON.parse(raw);
    this.keypair = {
      did: parsed.did,
      publicKey: parsed.publicKey || parsed.keypair?.publicKey || "",
      publicKeyHex: parsed.publicKeyHex || parsed.keypair?.publicKey || "",
      privateKey: parsed.privateKey || parsed.keypair?.privateKey || "",
    };
    return this.keypair;
  }

  private async signChallenge(challengeHex: string, privateKeyHex: string): Promise<string> {
    const ed = await import("@noble/ed25519");
    const { sha512 } = await import("@noble/hashes/sha2.js");

    if ("hashes" in ed && ed.hashes) {
      (ed.hashes as any).sha512 = sha512;
    } else {
      try {
        ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
      } catch {}
    }

    const messageBytes = new TextEncoder().encode(challengeHex);
    const privKeyBytes = hexToBytes(privateKeyHex);
    const signature = await ed.signAsync(messageBytes, privKeyBytes);
    return bytesToHex(signature);
  }

  /** Authenticate via HTTP challenge-response, extract session token. */
  private async authenticate(): Promise<string> {
    const keypair = await this.loadKeypair();
    const baseUrl = this.config.nodeUrl.replace(/\/$/, "");

    const challengeRes = await fetch(`${baseUrl}/auth/api/login/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: keypair.did }),
    });

    if (!challengeRes.ok) {
      throw new Error(`WS auth challenge failed (${challengeRes.status})`);
    }

    const { challengeId, challenge } = (await challengeRes.json()) as {
      challengeId: string;
      challenge: string;
    };

    const signature = await this.signChallenge(challenge, keypair.privateKey);

    const verifyRes = await fetch(`${baseUrl}/auth/api/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, signature }),
    });

    if (!verifyRes.ok) {
      throw new Error(`WS auth verify failed (${verifyRes.status})`);
    }

    // Extract session cookie — format: "name=value; Path=...; HttpOnly; ..."
    const setCookie = verifyRes.headers.get("set-cookie");
    if (!setCookie) {
      throw new Error("WS auth: no session cookie in response");
    }
    const match = setCookie.match(/([^=]+)=([^;]+)/);
    if (!match) {
      throw new Error("WS auth: could not parse session cookie");
    }

    this.sessionCookie = `${match[1]}=${match[2]}`;
    return this.sessionCookie;
  }

  /**
   * Exchange the session cookie for a short-lived, one-time WS auth token
   * (`GET /chat/api/ws-token`, `apps/kernel/app/chat/api/ws-token/route.ts`).
   * Only needed on the native-WebSocket fallback, which cannot send a `Cookie`
   * header on the initial upgrade the way the `ws` package can.
   */
  private async fetchWsToken(cookie: string): Promise<string> {
    const baseUrl = this.config.nodeUrl.replace(/\/$/, "");
    const res = await fetch(`${baseUrl}/chat/api/ws-token`, {
      headers: { Cookie: cookie },
    });
    if (!res.ok) {
      throw new Error(`WS token fetch failed (${res.status})`);
    }
    const { token } = (await res.json()) as { token?: string };
    if (!token) {
      throw new Error("WS token fetch: empty token in response");
    }
    return token;
  }

  // --- WebSocket lifecycle ---

  private async connect(): Promise<void> {
    if (this.stopped) return;

    try {
      const cookie = this.sessionCookie ?? (await this.authenticate());

      // Derive WS URL from nodeUrl
      const baseUrl = this.config.nodeUrl.replace(/\/$/, "");
      const wsUrl = baseUrl.replace(/^http/, "ws") + "/chat/ws";

      this.logger.info(`connecting to ${wsUrl}`);

      // Strategy: try the `ws` package first — it supports a `Cookie` header on
      // the upgrade request, which `ws-server.js`'s `authenticateWithCookie`
      // reads before the socket even opens. When `ws` can't be resolved (some
      // plugin sandboxes don't hoist it), fall back to native WebSocket
      // (Node 22+) and authenticate post-connect with a short-lived WS token
      // instead — native WebSocket cannot set a `Cookie` header at all, so
      // sending the raw session cookie in a post-connect message (as a prior
      // version of this file did) is never recognized by the kernel's
      // deferred-auth branch, which only accepts `{ type: "auth", token }`.
      let ws: WebSocket;
      let wsToken: string | null = null;
      try {
        const { default: WsClient } = await import("ws" as string);
        ws = new WsClient(wsUrl, {
          headers: {
            Cookie: cookie,
            ...(this.config.did ? { "X-Agent-DID": this.config.did } : {}),
          },
        }) as unknown as WebSocket;
      } catch {
        wsToken = await this.fetchWsToken(cookie);
        ws = new WebSocket(wsUrl);
      }

      ws.addEventListener("open", () => {
        this.logger.info("connected");
        this.reconnectAttempt = 0;

        // Native fallback: exchange the short-lived token for an authenticated
        // session on this socket (see fetchWsToken above for why).
        if (wsToken) {
          ws.send(JSON.stringify({ type: "auth", token: wsToken }));
        }

        // Register for actAs DID notifications too (#1545 pattern).
        // When the agent acts on behalf of a principal, it needs to
        // receive that principal's notifications.
        if (this.config.actAs) {
          this.logger.info(`registering actAs DID: ${this.config.actAs}`);
          ws.send(JSON.stringify({
            type: "register_also",
            did: this.config.actAs,
          }));
        }

        this.startHeartbeat(ws);
        this.scheduleAuthRefresh();
      });

      ws.addEventListener("message", (event: MessageEvent | { data: unknown }) => {
        this.resetHeartbeatTimeout();
        const raw = typeof event === "object" && "data" in event
          ? String(event.data)
          : String(event);

        const frame = parseFrame(raw);
        if (!frame) {
          if (raw !== "" && raw !== "pong") {
            this.logger.warn(`failed to parse WS frame: ${raw.slice(0, 200)}`);
          }
          return;
        }

        if (frame.type === "connected") {
          this.logger.info("auth ok");
          return;
        }

        if (isAuthFailureFrame(frame)) {
          const reason = (frame as { message?: string }).message ?? frame.type;
          this.logger.warn(`auth rejected by kernel (${reason}) — refreshing session and reconnecting`);
          // Force a fresh challenge-response on the next connect() rather than
          // retrying with a cookie the kernel just told us is no longer valid.
          this.sessionCookie = null;
          ws.close(4001, "auth refresh");
          return;
        }

        this.dispatchFrame(frame);
      });

      ws.addEventListener("close", (event: WsCloseEvent) => {
        const code = event.code ?? 0;
        const reason = event.reason ?? "";
        this.logger.warn(`disconnected (code=${code}, reason=${reason})`);
        this.clearTimers();
        this.ws = null;
        this.scheduleReconnect();
      });

      ws.addEventListener("error", (event: Event | { message?: string }) => {
        const msg = "message" in event ? event.message : "unknown error";
        this.logger.error(`ws error: ${msg}`);
        // close event will fire after error, which triggers reconnect
      });

      this.ws = ws;
    } catch (err) {
      this.logger.error(`connect failed: ${err}`);
      this.sessionCookie = null; // Force re-auth on next attempt
      this.scheduleReconnect();
    }
  }

  private dispatchFrame(frame: InboundFrame): void {
    // A malformed notification frame (missing id/scope/title) must never reach
    // a handler that assumes the full shape — log-and-drop instead of crashing
    // the socket or a downstream injector.
    if (frame.type === "notification" && !isNotificationFrame(frame)) {
      this.logger.warn(`dropped malformed notification frame: ${JSON.stringify(frame).slice(0, 200)}`);
      return;
    }
    for (const handler of this.handlers) {
      try {
        handler(frame);
      } catch (err) {
        this.logger.error(`frame handler error: ${err}`);
      }
    }
  }

  // --- Heartbeat ---

  private startHeartbeat(ws: WebSocket): void {
    this.clearTimers();
    this.heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
        this.heartbeatTimeout = setTimeout(() => {
          this.logger.warn("heartbeat timeout — closing connection");
          ws.close();
        }, HEARTBEAT_TIMEOUT_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private resetHeartbeatTimeout(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  // --- Reconnect ---

  private scheduleReconnect(): void {
    if (this.stopped) return;

    const delay = computeReconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt++;

    this.logger.info(`reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // --- Auth refresh ---

  /**
   * Proactively re-authenticate before the kernel's 24h session JWT expires,
   * rather than only discovering it's stale when the kernel closes the socket
   * or rejects a reconnect. Clearing `sessionCookie` and closing forces the
   * existing reconnect path to run a fresh challenge-response.
   */
  private scheduleAuthRefresh(): void {
    if (this.authRefreshTimer) {
      clearTimeout(this.authRefreshTimer);
    }
    this.authRefreshTimer = setTimeout(() => {
      this.logger.info("refreshing session ahead of expiry");
      this.sessionCookie = null;
      this.ws?.close(4000, "auth refresh");
    }, AUTH_REFRESH_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.authRefreshTimer) {
      clearTimeout(this.authRefreshTimer);
      this.authRefreshTimer = null;
    }
  }
}

// --- Hex utilities ---

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
