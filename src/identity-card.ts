import type { AgentIdentity } from "./agent-identities.js";
import { signMessage } from "./approval-bridge.js";
import { InferenceAuthError } from "./inference-auth.js";
import {
  channelRows, githubRow, inferenceRow, mcpRow, publicText, record, row,
  type CardContext, type ConnectorRow, type ConfigScope,
} from "./identity-card-facts.js";

interface CardOptions {
  context: CardContext;
  getIdentity: () => AgentIdentity | undefined;
  discoverSelf: (agentId: string) => Promise<unknown>;
  getConfig: () => unknown;
  proxyBaseUrl: string;
  githubStatus?: (agentId: string) => Promise<unknown>;
  assertCurrent?: () => void;
}

function configuredScope(authority: unknown): ConfigScope | null {
  if (authority === "org-held" || authority === "member-grant") return "org";
  if (authority === "own-key") return "agent";
  if (authority === "delegated") return "user";
  return null;
}

function connectorRows(connectors: unknown[], mapping: ConnectorRow): ConnectorRow[] {
  return connectors.map((raw) => {
    const connector = record(raw);
    const provider = publicText(connector.provider) ?? "unknown connector";
    const scope = configuredScope(connector.authority);
    return row(provider, {
      configured: typeof connector.configured === "boolean" ? connector.configured : null,
      configScope: scope ?? "agent", selectedScope: scope ?? "agent",
      owner: publicText(record(connector.billedPrincipal).did ?? connector.ownerDid),
      provider: connector.family === "anthropic" || connector.family === "openai-compatible" ? mapping.provider : null,
      route: connector.family === "anthropic" || connector.family === "openai-compatible" ? mapping.route : null,
      effective: scope ?? "agent",
      reason: "Kernel discovery observed configuration/authority, not outbound service identity or a successful service call",
      details: {
        authority: publicText(connector.authority), family: publicText(connector.family),
        grantStatus: publicText(connector.grantStatus), usable: typeof connector.usable === "boolean" ? connector.usable : null,
        selectedModels: Array.isArray(connector.selectedModels) ? connector.selectedModels.map(publicText).filter(Boolean) : [],
        usableModels: Array.isArray(connector.usableModels) ? connector.usableModels.map(publicText).filter(Boolean) : [],
        reasonCode: publicText(record(connector.reason).code),
        evidence: { kernel: "Observed live", route: mapping.route ? "From config" : "Unverified", outboundIdentity: "Unverified" },
      },
    });
  });
}

async function kernelSnapshot(options: CardOptions, identity: AgentIdentity) {
  try {
    const body = record(await options.discoverSelf(options.context.agentId!));
    const principal = record(body.identity);
    if (principal.did !== identity.config.did || (principal.actAs ?? null) !== (identity.config.actAs ?? null)
      || !Array.isArray(body.connectors) || !Array.isArray(body.usableModels)) {
      return { reason: "Kernel self-discovery identity/context mismatch or malformed response", status: null, body: null };
    }
    return { reason: "Calling-agent app-token self-discovery", status: 200, body };
  } catch (error) {
    const status = error instanceof InferenceAuthError ? error.status ?? null : null;
    return { reason: status ? `Kernel self-discovery unavailable (HTTP ${status})` : "Kernel self-discovery unavailable",
      status, body: null };
  }
}

type KernelSnapshot = Awaited<ReturnType<typeof kernelSnapshot>>;

function mergeKernelRows(rows: ConnectorRow[], snapshot: KernelSnapshot, mapping: ConnectorRow): void {
  const gatewayRows = new Map(rows.map((entry) => [entry.connector.toLowerCase(), entry]));
  for (const connector of connectorRows(snapshot.body?.connectors ?? [], mapping)) {
    const gatewayRow = gatewayRows.get(connector.connector.toLowerCase());
    if (gatewayRow) {
      gatewayRow.details = { ...gatewayRow.details, kernel: {
        configured: connector.configured, owner: connector.owner, ...connector.details,
      } };
    } else {
      rows.push(connector);
    }
  }
  for (const name of ["Warp", "Anthropic"]) {
    if (!rows.some((entry) => entry.connector.toLowerCase() === name.toLowerCase())) {
      rows.push(row(name, { reason: snapshot.body ? "Not advertised by kernel self-discovery" : snapshot.reason,
        details: { status: snapshot.status } }));
    }
  }
}

function buildCard(options: CardOptions, identity: AgentIdentity, config: unknown, snapshot: KernelSnapshot, github: unknown) {
  const inference = inferenceRow(config, options.context, options.proxyBaseUrl);
  // Registered kernel connectors map through imajin, not an unrelated direct provider.
  const mapping = inferenceRow(config, {
    agentId: options.context.agentId, activeModel: { provider: "imajin" },
  }, options.proxyBaseUrl);
  const picked = snapshot.body?.usableModels.find((model: unknown) => record(model).picked === true);
  inference.details = { ...inference.details, kernelPick: picked ? {
    model: publicText(record(picked).id), connector: publicText(record(picked).connector),
    owner: publicText(record(picked).credentialDid),
    evidence: "Kernel catalog pick, not observed provider egress",
  } : null };
  const rows = [
    row("Imajin kernel", {
      configured: true, configScope: "agent", selectedScope: "agent",
      owner: snapshot.body ? identity.config.actAs ?? identity.config.did : null,
      outboundIdentity: snapshot.body ? identity.config.did : null,
      effective: snapshot.body ? "agent" : null,
      grade: snapshot.body ? "Observed live" : "Unverified",
      reason: snapshot.reason, details: { status: snapshot.status },
    }),
    inference, mcpRow(config), githubRow(config, options.context, github),
    ...channelRows(config, options.context),
  ];
  mergeKernelRows(rows, snapshot, mapping);
  const principal = record(snapshot.body?.identity);
  return {
    kind: "imajin.identity-card",
    agentId: options.context.agentId,
    identity: {
      did: publicText(principal.did), handle: publicText(principal.handle), kind: publicText(principal.kind),
      tier: publicText(principal.tier), actAs: publicText(principal.actAs),
      grade: snapshot.body ? "Observed live" : "Unverified", reason: snapshot.reason,
    },
    rows: rows.map((entry) => ({
      ...entry,
      flagged: entry.flagged || (entry.outboundIdentity !== null && entry.outboundIdentity !== identity.config.did)
        || (entry.selectedScope !== null && entry.effective !== null && entry.selectedScope !== entry.effective),
    })),
  };
}
/** Data only: no chat card, receipts, credential reads, config writes or shell. */
export function createIdentityCardTool(options: CardOptions) {
  return {
    name: "imajin_identity_card",
    label: "Imajin Identity Card",
    description: "One calling-agent signed identity card: kernel self-discovery, connector authority, gateway provider/route, channel bindings and GitHub selected versus effective identity. Grades never imply unobserved egress.",
    parameters: { type: "object" as const, properties: {}, additionalProperties: false },
    async execute(_id?: string, params: unknown = {}) {
      try {
        if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length) {
          return result({ error: "This tool accepts no arguments" });
        }
        options.assertCurrent?.();
        const identity = options.getIdentity();
        const { agentId, sessionKey } = options.context;
        if (!agentId || !identity || identity.signer.did !== identity.config.did
          || (sessionKey !== undefined && !sessionKey.startsWith(`agent:${agentId}:`))) {
          return result({ error: "Calling-agent signing identity unavailable" });
        }
        const config = options.getConfig();
        const snapshot = await kernelSnapshot(options, identity);
        let github: unknown;
        try { github = await options.githubStatus?.(agentId); } catch { /* Never return RPC exception details. */ }
        const payload = buildCard(options, identity, config, snapshot, github);
        options.assertCurrent?.();
        if (options.getIdentity() !== identity) return result({ error: "Calling-agent signing identity changed" });
        const signed = await signMessage(payload, { did: identity.config.did, type: "agent", signer: identity.signer });
        options.assertCurrent?.();
        if (options.getIdentity() !== identity) return result({ error: "Calling-agent signing identity changed" });
        return result(signed);
      } catch {
        return result({ error: "Identity card unavailable" });
      }
    },
  };
}

function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: data };
}
