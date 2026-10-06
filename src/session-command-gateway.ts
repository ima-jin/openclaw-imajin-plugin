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

export type GatewayRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type SessionApprovalKind = "exec" | "plugin";

export interface SessionGateway {
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
    idempotencyKey: string;
  }): Promise<{ sessionKey?: string }>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createSessionGateway(request: GatewayRequest): SessionGateway {
  const resolveOne = async (
    kind: SessionApprovalKind,
    id: string,
    decision: "allow-once" | "deny",
  ): Promise<boolean> => {
    const result = asRecord(await request(`${kind}.approval.resolve`, { id, decision }));
    return result.applied === true;
  };

  return {
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

    async spawn({ parentSessionKey, task, label, agentId, idempotencyKey }) {
      const result = asRecord(
        await request("sessions.create", {
          task,
          idempotencyKey,
          ...(parentSessionKey ? { parentSessionKey } : {}),
          ...(label ? { label } : {}),
          ...(agentId ? { agentId } : {}),
        }),
      );
      return { sessionKey: optionalString(result.key) ?? optionalString(result.sessionKey) };
    },
  };
}

export interface LoopbackSessionGateway {
  gateway: SessionGateway;
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
      scopes: ["operator.write", "operator.approvals"],
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
    dispose: () => {
      const pending = started;
      started = undefined;
      void pending?.then((s) => s.stop()).catch(() => undefined);
    },
  };
}
