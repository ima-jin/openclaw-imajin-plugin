/**
 * Scope-parameterized loopback Gateway operator client (#35).
 *
 * ## Why this file exists
 *
 * The OpenClaw plugin SDK's only loopback-operator-connection factory,
 * `createOperatorApprovalsGatewayClient` (`openclaw/plugin-sdk/gateway-
 * runtime`), hardcodes `scopes: ["operator.approvals"]` and takes no scope
 * parameter (verified directly against the installed `openclaw@2026.8.2`
 * and `openclaw@2026.9.5` packages' `dist/operator-approvals-client-*.mjs`,
 * `src/gateway/operator-approvals-client.ts` — not guessed). The Gateway's
 * own method-scope table (`dist/method-scopes-*.mjs`,
 * `src/gateway/method-scopes.ts`) requires `operator.read` for
 * `skills.proposals.list` and `operator.admin` for `skills.proposals.
 * apply`/`reject`. A token-mode Gateway enforces the connection's DECLARED
 * scope set strictly, so `sources/skill-workshop.ts`'s Gateway connection
 * (built via that factory) can never successfully call any of those three
 * methods on such a deployment — every poll fails closed with `FORBIDDEN:
 * missing scope: operator.read` (#35).
 *
 * `openclaw/plugin-sdk/gateway-runtime` DOES publicly export the raw
 * `GatewayClient` class and `resolveGatewayAuth` (both re-exported straight
 * through from `src/gateway/client.ts` / `src/gateway/auth-resolve.ts`,
 * confirmed against the installed package's `dist/plugin-sdk/gateway-
 * runtime.d.ts`), so this module builds its own loopback connection with
 * the scopes the caller actually needs, resolving credentials the SAME way
 * the SDK's own factory does internally (`resolveGatewayAuth` over
 * `config.gateway.auth`) — the "same shared-token bootstrap" every other
 * source in this bridge already uses via `approvals.gatewayToken`.
 *
 * ## Deliberate, disclosed differences from `createOperatorApprovalsGatewayClient`
 *
 * 1. **Loopback URL only.** The SDK's full URL-resolution bootstrap
 *    (`resolveGatewayClientBootstrap`, `src/gateway/client-bootstrap.ts` —
 *    remote-mode targets, TLS-fingerprint pinning, CLI/env URL overrides)
 *    is NOT exported anywhere in the public plugin SDK surface; only
 *    `resolveGatewayAuth` (credentials) is. This client therefore always
 *    connects to `ws(s)://127.0.0.1:<port>` — the exact local-loopback URL
 *    shape `buildGatewayConnectionDetailsWithResolvers`
 *    (`src/gateway/connection-details.ts`) builds for the non-remote case —
 *    using the publicly-exported, typed `resolveGatewayPort`
 *    (`openclaw/plugin-sdk/core`) for the port and `config.gateway.tls
 *    .enabled` for the scheme. It never attempts `gateway.mode: "remote"`.
 *    This is an interim, LOOPBACK-ONLY escalation for a plugin process
 *    already colocated with its own Gateway (see the security note in
 *    `docs/approvals-bridge.md`), not a general-purpose replacement client.
 * 2. **No operator-approval-runtime-token shortcut.** The SDK factory's
 *    local-loopback fast path additionally sends a derived
 *    `approvalRuntimeToken` (`getOperatorApprovalRuntimeToken`,
 *    `src/gateway/operator-approval-runtime-token.ts`) that is NOT exported
 *    anywhere in the public plugin SDK. This client authenticates purely
 *    via the resolved `gateway.auth` token/password (`resolveGatewayAuth`)
 *    — exactly like every other credential this bridge already resolves
 *    (the `approvals.gatewayToken` override, or the host's own
 *    `gateway.auth`) — so it needs a real, valid Gateway credential either
 *    way.
 * 3. **`clientName`/`mode` are the same verified literals the SDK's own
 *    factory uses** (`"gateway-client"` / `"backend"` —
 *    `dist/client-info-*.mjs`'s `GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT` /
 *    `GATEWAY_CLIENT_MODES.BACKEND`, not guessed, not re-exported from the
 *    public SDK so hardcoded here as verified literals) — a connection
 *    opened by this client is indistinguishable from one opened by
 *    `createOperatorApprovalsGatewayClient`, other than its scopes.
 *
 * DELETE THIS FILE once OpenClaw ships a scope-parameterized loopback
 * factory upstream (tracked as `openclaw/openclaw#TBD`, filed alongside
 * #35) — replace every caller with that factory instead.
 *
 * Never logs the resolved token/password: `resolveGatewayAuth`'s result
 * flows straight into the `GatewayClient` constructor and nowhere else in
 * this file.
 */
import type { GatewayClient, GatewayClientEvent } from "openclaw/plugin-sdk/gateway-runtime";

/**
 * The Gateway's full operator scope vocabulary (verified against the
 * installed `openclaw@2026.9.5` package's `dist/operator-scopes-*.mjs`,
 * `src/gateway/operator-scopes.ts` — not exported anywhere in the public
 * plugin SDK, hence hardcoded here) is actually eight scopes: `operator.
 * admin`, `operator.read`, `operator.write`, `operator.approvals`,
 * `operator.questions`, `operator.pairing`, `operator.talk`, and
 * `operator.talk.secrets`. This plugin only ever needs the first four for
 * any loopback connection it opens on its own behalf (system-agent /
 * skill-workshop / gateway-exec proposals) — `operator.questions`,
 * `operator.pairing`, `operator.talk`, and `operator.talk.secrets` are
 * unrelated to this bridge's job and are deliberately EXCLUDED from what an
 * operator can configure here, so a config typo can never widen this
 * plugin's own authority beyond what #35's decision actually calls for.
 */
export const KNOWN_OPERATOR_GATEWAY_SCOPES = [
  "operator.read",
  "operator.admin",
  "operator.approvals",
  "operator.write",
] as const;

export type OperatorGatewayScope = (typeof KNOWN_OPERATOR_GATEWAY_SCOPES)[number];

const KNOWN_SCOPE_SET: ReadonlySet<string> = new Set(KNOWN_OPERATOR_GATEWAY_SCOPES);

export function isKnownOperatorGatewayScope(value: unknown): value is OperatorGatewayScope {
  return typeof value === "string" && KNOWN_SCOPE_SET.has(value);
}

/**
 * Throws a clear, actionable startup error when `scopes` contains anything
 * outside `KNOWN_OPERATOR_GATEWAY_SCOPES` — called once at config-parse
 * time (see `gateway-approvals-bridge.ts`'s skill-workshop startup block)
 * so a typo'd scope fails loudly at plugin startup rather than silently
 * opening a connection with a scope the Gateway will reject anyway.
 */
export function assertKnownOperatorGatewayScopes(scopes: readonly string[], configPath: string): void {
  const unknown = scopes.filter((scope) => !isKnownOperatorGatewayScope(scope));
  if (unknown.length === 0) return;
  throw new Error(
    `${configPath}: unknown operator scope(s) ${unknown.map((scope) => JSON.stringify(scope)).join(", ")} — ` +
      `expected a subset of ${KNOWN_OPERATOR_GATEWAY_SCOPES.map((scope) => JSON.stringify(scope)).join(", ")}`,
  );
}

interface GatewayConfigShape {
  gateway?: {
    port?: number;
    tls?: { enabled?: boolean };
    auth?: Record<string, unknown>;
  };
}

export interface CreateOperatorGatewayClientParams {
  /** The plugin's already-resolved runtime config — same shape passed to `createOperatorApprovalsGatewayClient`, including any `gatewayTokenOverride` already layered onto `config.gateway.auth.token` by the caller. */
  config: GatewayConfigShape & Record<string, unknown>;
  /** Requested operator scopes, e.g. `["operator.read", "operator.admin"]`. Validate with `assertKnownOperatorGatewayScopes` before calling this — kept out of this function so it stays a pure connection builder. */
  scopes: string[];
  clientDisplayName: string;
  onEvent?: (event: GatewayClientEvent) => void;
  onHelloOk?: () => void;
  onConnectError?: (err: unknown) => void;
  onReconnectPaused?: (info: unknown) => void;
  onClose?: (code?: number, reason?: string) => void;
}

/**
 * Builds a loopback `GatewayClient` authorized for exactly `params.scopes`
 * — see the module doc for why this exists and its disclosed differences
 * from `createOperatorApprovalsGatewayClient`. Callers start it the SAME
 * way as that factory's result (`startGatewayClientWhenEventLoopReady`,
 * imported directly from `openclaw/plugin-sdk/gateway-runtime` by the
 * caller) — this module has no opinion on startup sequencing.
 */
export async function createOperatorGatewayClient(
  params: CreateOperatorGatewayClientParams,
): Promise<GatewayClient> {
  const [{ GatewayClient: GatewayClientCtor, resolveGatewayAuth }, { resolveGatewayPort }] = await Promise.all([
    import("openclaw/plugin-sdk/gateway-runtime"),
    import("openclaw/plugin-sdk/core"),
  ]);

  const gatewayConfig = params.config.gateway ?? {};
  const auth = resolveGatewayAuth({ authConfig: gatewayConfig.auth, env: process.env });
  const port = resolveGatewayPort(params.config, process.env);
  const scheme = gatewayConfig.tls?.enabled === true ? "wss" : "ws";

  return new GatewayClientCtor({
    url: `${scheme}://127.0.0.1:${port}`,
    token: auth.token,
    password: auth.password,
    // Verified literals matching createOperatorApprovalsGatewayClient's own
    // GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT / GATEWAY_CLIENT_MODES.BACKEND —
    // see module doc point 3.
    clientName: "gateway-client",
    clientDisplayName: params.clientDisplayName,
    mode: "backend",
    scopes: params.scopes,
    onEvent: params.onEvent,
    onHelloOk: params.onHelloOk,
    onConnectError: params.onConnectError,
    onReconnectPaused: params.onReconnectPaused,
    onClose: params.onClose,
  });
}
