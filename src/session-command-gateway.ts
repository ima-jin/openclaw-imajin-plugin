/**
 * Local-gateway adapter for the session command executor (#51).
 *
 * Maps the five DID-addressed session commands onto the OpenClaw gateway's own
 * RPC methods. Method names, params and required operator scopes were verified
 * against the published `openclaw@2026.9.5` package (`dist/method-scopes-*.mjs`,
 * `ChatSendParamsSchema` / `ChatAbortParamsSchema` / `SessionsCreateParamsSchema`
 * / `ExecApprovalResolveParamsSchema` / `PluginApprovalResolveParamsSchema`):
 *
 *   session.send    -> chat.send              (operator.write)   { sessionKey, message, idempotencyKey }
 *   session.abort   -> chat.abort             (operator.write)   { sessionKey, runId? }
 *   session.spawn   -> sessions.create        (operator.write)   { parentSessionKey?, task, label?, agentId?, idempotencyKey }
 *   session.approve -> exec|plugin.approval.resolve (operator.approvals) { id, decision: "allow-once" }
 *   session.deny    -> exec|plugin.approval.resolve (operator.approvals) { id, decision: "deny" }
 *
 * `sessions.create` is only ever sent params that keep it on `operator.write`
 * (never `permissionMode`, `toolOverrides`, `execNode`, `incognito`), so a
 * remote command can never request the broader `operator.admin` scope.
 * `allow-always` is intentionally unreachable: a standing approval is a
 * separate delegation-grant feature, never a one-shot remote command.
 *
 * This module has no top-level `openclaw` imports, so everything except
 * {@link createLoopbackSessionGateway} is unit-testable with a fake `request`.
 */
import { createOperatorGatewayClient } from "./gateway-operator-client.js";
/**
 * Verified against published openclaw@2026.9.5 and @2026.10.5:
 * sessions.list/subscribe, chat.history: operator.read (implied by write);
 * sessions.patch {key, archived|label, expectedSessionId}: operator.write;
 * sessions.reset {key, reason:"reset", expectedSessionId}: operator.admin.
 * Sources: dist/method-scopes-*.mjs, session-method-scopes-base-*.mjs,
 * dist/src-*.mjs and schema-*.mjs. Never widen the connection for reset.
 */
export const SESSION_GATEWAY_SCOPES = ["operator.write", "operator.approvals"] as const;
export class SessionGatewayFailure extends Error {
  constructor(readonly reason: "missing_scope" | "session_not_found", message: string) {
    super(message);
  }
}
export interface GatewaySession {
  key: string;
  sessionId?: string;
  label?: string;
  agentId?: string;
  updatedAt?: number;
  lastActivityAt?: number;
  archived?: boolean;
  spawnedBy?: string;
}

export type GatewayRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type SessionApprovalKind = "exec" | "plugin";

export interface SessionGateway {
  list(): Promise<GatewaySession[]>;
  subscribe(): Promise<void>;
  history(sessionKey: string): Promise<unknown[]>;
  archive(params: { sessionKey: string }): Promise<void>;
  reset(params: { sessionKey: string }): Promise<void>;
  label(params: { sessionKey: string; label: string }): Promise<void>;
  send(params: {
    sessionKey: string;
    message: string;
    agentId?: string;
    idempotencyKey: string;
  }): Promise<{ runId?: string }>;
  abort(params: { sessionKey: string; runId?: string }): Promise<{ aborted: boolean }>;
  resolveApproval(params: {
    id: string;
    kind?: SessionApprovalKind;
    decision: "allow-once" | "deny";
  }): Promise<{ applied: boolean; kind: SessionApprovalKind }>;
  spawn(params: {
    parentSessionKey?: string;
    task: string;
    label?: string;
    agentId?: string;
    group?: string;
    model?: string;
    idempotencyKey: string;
  }): Promise<{ sessionKey?: string }>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createSessionGateway(
  request: GatewayRequest,
  scopes: readonly string[] = SESSION_GATEWAY_SCOPES,
): SessionGateway {
  const list = async (): Promise<GatewaySession[]> => {
    const sessions: GatewaySession[] = [];
    const limit = 200;
    for (let offset = 0; ; offset += limit) {
      const page = asRecord(await request("sessions.list", {
        limit, offset, archived: "all", includeGlobal: true, includeUnknown: true,
      }));
      if (!Array.isArray(page.sessions)) throw new Error("invalid sessions.list response");
      for (const row of page.sessions) {
        const s = asRecord(row);
        if (typeof s.key === "string" && s.key.length > 0 && s.key.length <= 512) {
          sessions.push(s as unknown as GatewaySession);
        }
      }
      if (page.sessions.length < limit) return sessions;
    }
  };
  const existing = async (key: string): Promise<GatewaySession> => {
    const session = (await list()).find((s) => s.key === key && s.archived !== true);
    if (!session?.sessionId) throw new SessionGatewayFailure("session_not_found", "session is not active on this Gateway");
    return session;
  };
  const patch = async (key: string, mutation: Record<string, unknown>): Promise<void> => {
    const session = await existing(key);
    await request("sessions.patch", { key, expectedSessionId: session.sessionId, ...mutation });
  };
  const resolveOne = async (
    kind: SessionApprovalKind,
    id: string,
    decision: "allow-once" | "deny",
  ): Promise<boolean> => {
    const result = asRecord(await request(`${kind}.approval.resolve`, { id, decision }));
    return result.applied === true;
  };

  return {
    list,
    async subscribe() { await request("sessions.subscribe", {}); },
    async history(sessionKey) {
      const result = asRecord(await request("chat.history", { sessionKey, limit: 20, maxBytes: 65536 }));
      if (!Array.isArray(result.messages)) throw new Error("invalid chat.history response");
      return result.messages.slice(-20);
    },
    async archive({ sessionKey }) { await patch(sessionKey, { archived: true }); },
    async label({ sessionKey, label }) { await patch(sessionKey, { label }); },
    async reset({ sessionKey }) {
      if (!scopes.includes("operator.admin")) {
        throw new SessionGatewayFailure("missing_scope", "sessions.reset requires operator.admin; session client holds operator.write + operator.approvals");
      }
      const session = await existing(sessionKey);
      await request("sessions.reset", { key: sessionKey, expectedSessionId: session.sessionId, reason: "reset" });
    },
    async send({ sessionKey, message, agentId, idempotencyKey }) {
      const result = asRecord(
        await request("chat.send", {
          sessionKey,
          message,
          idempotencyKey,
          ...(agentId ? { agentId } : {}),
        }),
      );
      return { runId: optionalString(result.runId) };
    },

    async abort({ sessionKey, runId }) {
      const result = asRecord(await request("chat.abort", { sessionKey, ...(runId ? { runId } : {}) }));
      // The gateway reports `aborted: false` when there was no active run to cancel.
      return { aborted: result.aborted !== false };
    },

    async resolveApproval({ id, kind, decision }) {
      if (kind) return { applied: await resolveOne(kind, id, decision), kind };
      // Kind not stated by the command: exec approvals first (the common
      // case), then plugin approvals. A gateway "unknown approval" error on
      // the first leg falls through to the second; anything else propagates.
      try {
        if (await resolveOne("exec", id, decision)) return { applied: true, kind: "exec" };
      } catch {
        // fall through to the plugin approval namespace
      }
      return { applied: await resolveOne("plugin", id, decision), kind: "plugin" };
    },

    async spawn({ parentSessionKey, task, label, agentId, group, model, idempotencyKey }) {
      const result = asRecord(
        await request("sessions.create", {
          task,
          idempotencyKey,
          ...(parentSessionKey ? { parentSessionKey } : {}),
          ...(label ? { label } : {}),
          ...(agentId ? { agentId } : {}),
          ...(group ? { group } : {}),
          ...(model ? { model } : {}),
        }),
      );
      return { sessionKey: optionalString(result.key) ?? optionalString(result.sessionKey) };
    },
  };
}

export interface LoopbackSessionGateway {
  gateway: SessionGateway;
  start(): Promise<void>;
  dispose(): void;
}

/**
 * Lazily-connected loopback gateway client with exactly the scopes the five
 * commands need (`operator.write` + `operator.approvals`). Connects on the
 * first command rather than at plugin start, so an install that never
 * receives a command never opens the extra connection.
 */
export function createLoopbackSessionGateway(opts: {
  getConfig: () => Record<string, unknown>;
  gatewayTokenOverride?: string;
  clientDisplayName?: string;
  onConnected?: () => void;
  onEvent?: (event: { event: string; payload?: unknown }) => void;
}): LoopbackSessionGateway {
  type Started = { request: GatewayRequest; stop: () => void };
  let started: Promise<Started> | undefined;

  const connect = async (): Promise<Started> => {
    const { startGatewayClientWhenEventLoopReady } = await import("openclaw/plugin-sdk/gateway-runtime");
    const baseConfig = opts.getConfig() as Record<string, unknown> & {
      gateway?: Record<string, unknown> & { auth?: Record<string, unknown> };
    };
    const config = opts.gatewayTokenOverride
      ? {
          ...baseConfig,
          gateway: {
            ...baseConfig.gateway,
            auth: { ...baseConfig.gateway?.auth, token: opts.gatewayTokenOverride },
          },
        }
      : baseConfig;
    const client = await createOperatorGatewayClient({
      config,
      scopes: [...SESSION_GATEWAY_SCOPES],
      onHelloOk: opts.onConnected,
      onEvent: opts.onEvent,
      clientDisplayName: opts.clientDisplayName ?? "Imajin session commands",
      onConnectError: (err) => {
        console.error(`[imajin-session-commands] gateway connect error: ${String(err)}`);
      },
    });
    const readiness = await startGatewayClientWhenEventLoopReady(client, { clientOptions: {} });
    if (!readiness.ready) {
      client.stop();
      throw new Error("session commands: gateway client failed to start");
    }
    return {
      request: (method, params) => client.request(method, params),
      stop: () => client.stop(),
    };
  };

  const request: GatewayRequest = async (method, params) => {
    started ??= connect().catch((err: unknown) => {
      started = undefined; // let the next command retry the connection
      throw err;
    });
    return (await started).request(method, params);
  };

  return {
    gateway: createSessionGateway(request),
    start: async () => { await request("sessions.subscribe", {}); },
    dispose: () => {
      const pending = started;
      started = undefined;
      void pending?.then((s) => s.stop()).catch(() => undefined);
    },
  };
}
