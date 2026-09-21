/**
 * Imajin catalog `ApprovalSource` (#36 item 3), an OPT-IN alternative to the
 * one-time `imajin/*` `modelPolicy.allow` wildcard documented in the
 * README's "Kernel brains as OpenClaw models" section.
 *
 * #36's spec asks: does `agents.defaults.modelPolicy.allow` accept a
 * wildcard like `imajin/*`? Yes — confirmed directly against OpenClaw's own
 * docs/schema (`docs/gateway/config-agents/models.md`:
 * "`modelPolicy.allow`: explicit override allowlist. Accepts aliases, exact
 * `provider/model` refs, and trailing prefix wildcards such as `openai/*`";
 * `AgentModelPolicyConfig.allow` in `src/config/types.agent-defaults.ts`).
 * The documented one-time operator setting is therefore that wildcard (see
 * README) — this source exists for operators who explicitly do NOT want a
 * blanket `imajin/*` grant and prefer to approve each newly discovered
 * kernel brain individually from /jin, reusing the exact same generic
 * `ApprovalSource` contract (`./types.ts`) and `GatewayApprovalsBridge`
 * (`../gateway-approvals-bridge.ts`) #24/#33 already built for system-agent
 * and Skill Workshop proposals. Off by default: only active when an
 * operator adds `"imajin-catalog"` to `approvals.sources`.
 *
 * `isModelAllowed` (injected) treats an OMITTED/EMPTY `modelPolicy.allow` as
 * "allow any" — matching OpenClaw's own semantics exactly (see
 * `isImajinModelAllowedByPolicy` below) — so this source only ever proposes
 * anything once the operator has configured a NON-empty allow list that
 * does not already cover the model. An installation with no policy
 * configured at all (the common case) never sees an imajin-catalog card.
 *
 * `resolve()` is the ONLY call site in this plugin that ever mutates
 * `agents.defaults.modelPolicy.allow`, and it is reached exclusively via
 * `GatewayApprovalsBridge.handleKernelDecision` — which has ALREADY verified
 * the operator's signed `operator.approval.decided` (issuer/subject/
 * decidedBy identity match + `contentHash` recomputation, see
 * `../gateway-approvals-bridge.ts`) before ever calling a source's
 * `resolve`. There is no other path in this module that writes config.
 */
import type {
  ApprovalDecision,
  ApprovalSource,
  ApprovalSourceCurrentState,
  ApprovalSourceRequest,
} from "./types.js";
import { IMAJIN_PROVIDER_ID, type ImajinRuntimeModel } from "../imajin-provider.js";

const PROPOSAL_PREFIX = "imajin-catalog:";

function proposalIdForModel(modelId: string): string {
  return `${PROPOSAL_PREFIX}${modelId}`;
}

function modelIdFromProposalId(proposalId: string): string | null {
  return proposalId.startsWith(PROPOSAL_PREFIX) ? proposalId.slice(PROPOSAL_PREFIX.length) : null;
}

/** Builds the `imajin/<modelId>` ref this source proposes adding to the allow list. */
export function buildImajinModelRef(modelId: string): string {
  return `${IMAJIN_PROVIDER_ID}/${modelId}`;
}

/**
 * `agents.defaults.modelPolicy.allow` matcher, mirroring OpenClaw's own
 * documented contract: omitted/empty allows any model; entries are exact
 * refs or trailing `provider/*`-style wildcards.
 */
export function isImajinModelAllowedByPolicy(
  allow: readonly string[] | undefined,
  modelId: string,
): boolean {
  if (!allow || allow.length === 0) return true;
  const ref = buildImajinModelRef(modelId);
  for (const rawEntry of allow) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (entry === ref) return true;
    if (entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      if (ref.startsWith(prefix)) return true;
    }
  }
  return false;
}

function toApprovalSourceRequest(model: ImajinRuntimeModel): ApprovalSourceRequest {
  const ref = buildImajinModelRef(model.id);
  return {
    proposalId: proposalIdForModel(model.id),
    kind: "imajin-catalog:new-model",
    summary: `Enable ${ref} for agents?`,
    // Stable identifier, never changes for the life of one model id — this
    // source's own drift signal is purely "still discovered and still not
    // allowed" (see `getCurrent` below), not a revision counter.
    sourceRevision: model.id,
    detail: {
      modelId: model.id,
      ref,
      displayName: model.name,
      ...(model.connector ? { connector: model.connector } : {}),
    },
  };
}

/** Abstracts the plugin's own loopback Gateway operator connection for `config.get`/`config.patch` (#36). */
export interface ImajinModelPolicyGatewayClient {
  /** `config.get` — current config hash + effective `agents.defaults.modelPolicy.allow`. */
  getConfig(): Promise<{ hash: string; allow: string[] }>;
  /** `config.patch` — replaces `agents.defaults.modelPolicy.allow` wholesale with `nextAllow`, gated on `baseHash`. */
  patchModelPolicyAllow(nextAllow: string[], baseHash: string): Promise<void>;
}

export interface ImajinCatalogSourceDeps {
  /** Current discovered catalog snapshot (typically `ImajinCatalogCache.peek()?.models ?? []`). */
  listDiscoveredModels: () => readonly ImajinRuntimeModel[];
  /** True when `imajin/<modelId>` is already covered by the configured allow list. */
  isModelAllowed: (modelId: string) => boolean;
  gateway: ImajinModelPolicyGatewayClient;
}

/**
 * Wraps catalog discovery + the Gateway config API as a generic
 * `ApprovalSource` (#33's model, reused for #36). `onDriftPolicy` is
 * `"restage"`: if a model is no longer pending by the time the operator
 * decides (already allowed some other way, or dropped from discovery),
 * `getCurrent` reports `pending: false` and the bridge treats it as an
 * idempotent no-op rather than a drift — there is no real "drift" case for
 * a stable model id, so `restage` only matters for the rare race where a
 * NEW row appears with the exact same id windowed against a decision.
 */
export function createImajinCatalogSource(
  deps: ImajinCatalogSourceDeps,
  opts: { pollIntervalMs?: number } = {},
): ApprovalSource {
  const pollIntervalMs = opts.pollIntervalMs ?? 15_000;
  // A rejected model must never be immediately re-proposed on the next
  // list()/poll — "Ignore" is a decision, not a transient miss.
  const dismissed = new Set<string>();

  function pendingModels(): ImajinRuntimeModel[] {
    return deps
      .listDiscoveredModels()
      .filter((model) => !deps.isModelAllowed(model.id) && !dismissed.has(model.id));
  }

  return {
    id: "imajin-catalog",
    onDriftPolicy: "restage",
    decisionLabels: { approve: "Enable", reject: "Ignore" },

    async list(): Promise<ApprovalSourceRequest[]> {
      return pendingModels().map(toApprovalSourceRequest);
    },

    subscribe(onRequested) {
      const known = new Set(pendingModels().map((model) => model.id));
      const timer = setInterval(() => {
        for (const model of pendingModels()) {
          if (known.has(model.id)) continue;
          known.add(model.id);
          onRequested(toApprovalSourceRequest(model));
        }
      }, pollIntervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },

    async getCurrent(proposalId: string): Promise<ApprovalSourceCurrentState | null> {
      const modelId = modelIdFromProposalId(proposalId);
      if (!modelId) return null;
      const match = pendingModels().find((model) => model.id === modelId);
      if (!match) {
        return { pending: false, sourceRevision: null };
      }
      const { detail } = toApprovalSourceRequest(match);
      return { pending: true, sourceRevision: modelId, detail };
    },

    async resolve(
      proposalId: string,
      decision: ApprovalDecision,
      _expectedSourceRevision: string,
    ): Promise<{ applied: boolean }> {
      const modelId = modelIdFromProposalId(proposalId);
      if (!modelId) return { applied: false };

      if (decision === "reject") {
        dismissed.add(modelId);
        return { applied: true };
      }

      // #36 hard requirement: NEVER write gateway config without a verified
      // decision. This line only runs after `GatewayApprovalsBridge` has
      // already verified the operator's signed decision (see module doc) —
      // it is the sole write path for `modelPolicy.allow` in this plugin.
      const current = await deps.gateway.getConfig();
      const ref = buildImajinModelRef(modelId);
      if (current.allow.includes(ref)) {
        return { applied: true };
      }
      await deps.gateway.patchModelPolicyAllow([...current.allow, ref], current.hash);
      return { applied: true };
    },
  };
}

// --- Live wiring (SDK/network — isolated from the pure adapter above) ---

/**
 * Live `ImajinModelPolicyGatewayClient` over an existing Gateway connection.
 * `config.get`/`config.patch` require `operator.admin` (`config-rpc.md`,
 * `CORE_GATEWAY_METHOD_SPECS`), while the plugin SDK's only exported
 * loopback-operator-connection factory (`createOperatorApprovalsGatewayClient`,
 * used by the `system-agent`/`skill-workshop` sources too) declares
 * `scopes: ["operator.approvals"]` — the SAME disclosed limitation those
 * sources already carry (see `system-agent.ts` / `skill-workshop.ts` module
 * docs and the README's "Known limitation"). If a deployment's Gateway
 * enforces per-connection scope checks strictly, `config.patch` surfaces as
 * a logged, swallowed RPC error (never crashing the bridge) rather than
 * succeed — flagged as the same SDK follow-up.
 */
export function createLiveImajinModelPolicyGatewayClient(gatewayClient: {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}): ImajinModelPolicyGatewayClient {
  return {
    async getConfig() {
      const result = await gatewayClient.request<{
        hash?: string;
        config?: { agents?: { defaults?: { modelPolicy?: { allow?: string[] } } } };
      }>("config.get", {});
      return {
        hash: result?.hash ?? "",
        allow: result?.config?.agents?.defaults?.modelPolicy?.allow ?? [],
      };
    },
    async patchModelPolicyAllow(nextAllow, baseHash) {
      const raw = JSON.stringify({
        agents: { defaults: { modelPolicy: { allow: nextAllow } } },
      });
      await gatewayClient.request("config.patch", {
        raw,
        baseHash,
        // `config.patch` replaces arrays wholesale; an explicit shrink is
        // never produced by this source (it only ever appends), but
        // `replacePaths` is required whenever the JSON merge patch touches
        // an existing array path at all (`docs/gateway/configuration/
        // config-rpc.md`).
        replacePaths: ["agents.defaults.modelPolicy.allow"],
      });
    },
  };
}

/**
 * Opens this source's OWN Gateway connection (independent of the other
 * sources' connections), via the same bootstrap helper `system-agent.ts` /
 * `skill-workshop.ts` use.
 */
export async function createLiveImajinCatalogConnection(
  api: { runtime?: { config?: { current?: () => Record<string, unknown> } } },
  opts: { gatewayTokenOverride?: string; clientDisplayName: string },
): Promise<{ client: ImajinModelPolicyGatewayClient; start: () => Promise<void>; stop: () => void }> {
  const { createOperatorApprovalsGatewayClient, startGatewayClientWhenEventLoopReady } = await import(
    "openclaw/plugin-sdk/gateway-runtime"
  );

  const baseConfig = (api.runtime?.config?.current?.() ?? {}) as Record<string, unknown> & {
    gateway?: Record<string, unknown> & { auth?: Record<string, unknown> };
  };
  const bootstrapConfig = opts.gatewayTokenOverride
    ? {
        ...baseConfig,
        gateway: {
          ...baseConfig.gateway,
          auth: { ...baseConfig.gateway?.auth, token: opts.gatewayTokenOverride },
        },
      }
    : baseConfig;

  const gatewayClient = await createOperatorApprovalsGatewayClient({
    config: bootstrapConfig,
    clientDisplayName: opts.clientDisplayName,
    onConnectError: (err) => {
      console.error(`[imajin-approvals-bridge] imajin-catalog gateway connect error: ${String(err)}`);
    },
    onClose: (code, reason) => {
      console.warn(
        `[imajin-approvals-bridge] imajin-catalog gateway connection closed (${code}): ${reason ?? ""}`,
      );
    },
  });

  return {
    client: createLiveImajinModelPolicyGatewayClient(gatewayClient),
    start: async () => {
      const readiness = await startGatewayClientWhenEventLoopReady(gatewayClient, { clientOptions: {} });
      if (!readiness.ready) {
        throw new Error("gateway approvals bridge: imajin-catalog gateway client failed to start");
      }
    },
    stop: () => gatewayClient.stop(),
  };
}
