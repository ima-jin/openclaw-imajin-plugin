/**
 * Minimal ambient type declarations for the OpenClaw plugin SDK subpaths this
 * plugin imports (`openclaw/plugin-sdk/plugin-entry`,
 * `openclaw/plugin-sdk/approval-gateway-runtime`).
 *
 * `openclaw` owns these types and is declared as a `peerDependency` (see
 * package.json) — the gateway supplies the real module and its types at
 * runtime, exactly the way OpenClaw's own plugin installer resolves it
 * (`openclaw plugins install` runs with `--omit=peer`, per OpenClaw's plugin
 * dependency-resolution docs). It is not installed here for local
 * type-checking: the published package is very large (100+ MB unpacked) and
 * recent releases gate `npm install` behind a strict Node engine check via a
 * preinstall script, so requiring a full install just to satisfy `tsc` is
 * impractical for this small plugin. These stubs intentionally cover only
 * the handful of exports this plugin actually calls and do not attempt to
 * mirror the SDK's full (very large) type surface. See README.md for the
 * one-line rationale note.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface OpenClawPluginEntryDefinition {
    id: string;
    name: string;
    description: string;
    register: (api: any) => void;
  }
  export function definePluginEntry(
    entry: OpenClawPluginEntryDefinition,
  ): OpenClawPluginEntryDefinition;
}

declare module "openclaw/plugin-sdk/approval-gateway-runtime" {
  export interface ResolveApprovalOverGatewayInput {
    cfg: unknown;
    approvalId: string;
    approvalKind: string;
    decision: "allow-once" | "deny";
    clientDisplayName?: string;
  }
  export interface ResolveApprovalOverGatewayResult {
    applied: boolean;
    approval: { status: string; [key: string]: unknown };
  }
  export function resolveApprovalOverGateway(
    input: ResolveApprovalOverGatewayInput,
  ): Promise<ResolveApprovalOverGatewayResult>;
}
