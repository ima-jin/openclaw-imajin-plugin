/**
 * Exec-approval rail preflight (#52).
 *
 * The `gateway-exec` source (#38) can only forward what the OpenClaw Gateway
 * actually raises as an `exec.approval.requested` broadcast. Three
 * configuration conditions make an ask-gated `exec` silently produce NO
 * approval (and therefore no /jin card), and none of them is visible from the
 * plugin's own connection:
 *
 *   1. `gateway-exec` is not listed in `approvals.sources` (it is opt-in only,
 *      so the plugin never subscribes).
 *   2. The exec host resolves to the sandbox (`tools.exec.host: "sandbox"`, or
 *      `"auto"`/unset while an agent sandbox is active). OpenClaw only
 *      evaluates host approvals for `gateway`/`node` execution.
 *   3. The effective baseline `ask` is `off` (no `tools.exec.mode`/`ask`
 *      configured, `mode: "full"`, or `mode: "allowlist"`). OpenClaw ignores a
 *      per-call `ask` for channel-origin calls when the effective host ask is
 *      `off`, and a per-call `ask` can only ever harden a baseline.
 *
 * Source of truth for (2) and (3): OpenClaw docs "Exec tool" and "Exec
 * approvals" (docs.openclaw.ai/tools/exec, /tools/exec-approvals). They are
 * Gateway behaviours that cannot be verified from the plugin process, so this
 * module only reads the already-loaded config and reports what it can see; it
 * never writes Gateway config.
 */

interface SandboxShape {
  mode?: unknown;
}

interface ExecPolicyShape {
  host?: unknown;
  mode?: unknown;
  ask?: unknown;
}

interface GatewayConfigShape {
  tools?: { exec?: ExecPolicyShape };
  agents?: {
    defaults?: { sandbox?: SandboxShape };
    entries?: Record<string, { sandbox?: SandboxShape } | undefined>;
  };
}

export interface PreflightLogger {
  warn: (message: string) => void;
}

/** The one-line config the rail needs on the Gateway side (also documented in the README). */
export const REQUIRED_EXEC_CONFIG_HINT =
  'tools.exec.host: "gateway" (or "node") and tools.exec.mode: "ask" ' +
  '(or the legacy pair security: "full", ask: "always" without `mode`)';

export const GATEWAY_EXEC_NOT_ENABLED_MESSAGE =
  'approvals.sources does not include "gateway-exec" — OpenClaw host-exec approvals (ask-gated exec) ' +
  "will NOT be forwarded to /jin and an ask-gated exec will wait on the Gateway's own approval route only. " +
  'Add "gateway-exec" to plugins.entries.imajin.config.approvals.sources (see README "gateway-exec source").';

const SANDBOX_ACTIVE_MODES: ReadonlySet<unknown> = new Set(["non-main", "all"]);
const ASK_CAPABLE_MODES: ReadonlySet<unknown> = new Set(["ask", "auto"]);
const ASK_CAPABLE_ASK_VALUES: ReadonlySet<unknown> = new Set(["on-miss", "always"]);

function isSandboxConfigured(config: GatewayConfigShape): boolean {
  const sandboxes = [
    config.agents?.defaults?.sandbox,
    ...Object.values(config.agents?.entries ?? {}).map((entry) => entry?.sandbox),
  ];
  return sandboxes.some((sandbox) => SANDBOX_ACTIVE_MODES.has(sandbox?.mode));
}

function describeSandboxHostProblem(config: GatewayConfigShape): string | undefined {
  const host = config.tools?.exec?.host;
  if (host === "sandbox") {
    return 'tools.exec.host is "sandbox": sandboxed exec never raises a host approval, so ask-gated commands produce no /jin card.';
  }
  const inheritsAuto = host === undefined || host === "auto";
  if (inheritsAuto && isSandboxConfigured(config)) {
    return 'an agent sandbox is active and tools.exec.host is unset/"auto": exec resolves to the sandbox, which never raises a host approval.';
  }
  return undefined;
}

function describeAskBaselineProblem(config: GatewayConfigShape): string | undefined {
  const { mode, ask } = config.tools?.exec ?? {};
  if (ASK_CAPABLE_MODES.has(mode) || ASK_CAPABLE_ASK_VALUES.has(ask)) return undefined;
  return (
    `tools.exec has no ask-capable baseline (mode=${JSON.stringify(mode ?? null)}, ask=${JSON.stringify(ask ?? null)}): ` +
    "OpenClaw ignores a per-call ask:\"always\" for channel-origin calls when the effective host ask is off."
  );
}

/** Problems visible in the loaded Gateway config that stop an ask-gated exec from raising an approval. */
export function diagnoseExecApprovalConfig(gatewayConfig: unknown): string[] {
  const config = (gatewayConfig ?? {}) as GatewayConfigShape;
  return [describeSandboxHostProblem(config), describeAskBaselineProblem(config)].filter(
    (problem): problem is string => problem !== undefined,
  );
}

/**
 * Logs ONE warning at bridge start when the exec rail cannot work: either
 * `gateway-exec` is not enabled, or the Gateway config cannot raise an
 * approval. Silent when everything checks out.
 */
export function logExecApprovalPreflight(
  enabledSourceIds: ReadonlySet<string>,
  gatewayConfig: unknown,
  logger: PreflightLogger,
): void {
  const problems = enabledSourceIds.has("gateway-exec")
    ? diagnoseExecApprovalConfig(gatewayConfig)
    : [GATEWAY_EXEC_NOT_ENABLED_MESSAGE];
  if (problems.length === 0) return;
  logger.warn(
    `[imajin-approvals-bridge] exec approval rail will not surface ask-gated exec on /jin:\n` +
      problems.map((problem) => `  - ${problem}`).join("\n") +
      `\n  Required Gateway config: ${REQUIRED_EXEC_CONFIG_HINT}.`,
  );
}
