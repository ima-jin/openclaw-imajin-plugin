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

/**
 * SecretRef contract + shape-guard (#20). Verified directly against the real
 * installed `openclaw@2026.9.1` package (satisfies this plugin's
 * `">=2026.8.1"` peerDependency) — not guessed:
 * - Shape (`node_modules/openclaw/dist/types.secrets-*.d.ts`, compiled from
 *   `src/config/types.secrets.ts`):
 *   `type SecretRefSource = "env" | "file" | "exec" | "store";`
 *   `type SecretRef = { source: SecretRefSource; provider: string; id: string };`
 *   `type SecretInput = string | SecretRef;`
 *   `declare function isSecretRef(value: unknown): value is SecretRef;`
 * - Export surface (`node_modules/openclaw/dist/plugin-sdk/secret-input-runtime.d.ts`):
 *   ```ts
 *   export { type SecretInput, type SecretInputStringResolution,
 *     type SecretInputStringResolutionMode, coerceSecretRef,
 *     hasConfiguredSecretInput, isSecretRef, normalizeResolvedSecretInputString,
 *     normalizeSecretInputString, resolveConfiguredSecretInputString,
 *     resolveConfiguredSecretInputWithFallback,
 *     resolveRequiredConfiguredSecretRefInputString, resolveSecretInputString };
 *   ```
 *   Only the members this plugin actually calls (`isSecretRef`, the
 *   `SecretRef`/`SecretInput` types) are declared here.
 */
declare module "openclaw/plugin-sdk/secret-input-runtime" {
  export type SecretRefSource = "env" | "file" | "exec" | "store";
  export interface SecretRef {
    source: SecretRefSource;
    provider: string;
    id: string;
  }
  export type SecretInput = string | SecretRef;
  export function isSecretRef(value: unknown): value is SecretRef;
}

/**
 * SecretRef resolution (#20). `openclaw/plugin-sdk/secret-ref-runtime` is the
 * real subpath that exports `resolveSecretRefValues` in the installed
 * `openclaw@2026.9.1` package — confirmed directly from
 * `node_modules/openclaw/dist/plugin-sdk/secret-ref-runtime.d.ts`
 * (`package.json`'s `exports` map has no `runtime-secret-resolution` entry at
 * this version; `secret-ref-runtime` is the one that resolves):
 *   `export declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;`
 * where (`node_modules/openclaw/dist/types.secrets-*.d.ts` /
 * `src/secrets/resolve.d.ts` region of the same file):
 *   `type ResolveSecretRefOptions = { config: OpenClawConfig; env?: NodeJS.ProcessEnv; cache?: SecretRefResolveCache; manifestRegistry?: Pick<PluginManifestRegistry, "plugins"> };`
 * `config` is loosely typed here (`unknown`) since this plugin has no local
 * `OpenClawConfig` type — the same posture as `resolveGatewayPort`'s
 * `api.runtime.config.current()` read in `notification-injector.ts`.
 */
declare module "openclaw/plugin-sdk/secret-ref-runtime" {
  import type { SecretRef } from "openclaw/plugin-sdk/secret-input-runtime";

  export interface SecretRefResolveCache {
    resolvedByRefKey?: Map<string, Promise<unknown>>;
    filePayloadByProvider?: Map<string, Promise<unknown>>;
  }
  export function resolveSecretRefValues(
    refs: SecretRef[],
    options: { config: unknown; env?: NodeJS.ProcessEnv; cache?: SecretRefResolveCache },
  ): Promise<Map<string, unknown>>;
}
