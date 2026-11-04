import { redactWakeText } from "./wake-redaction.js";

export type Grade = "Observed live" | "From config" | "Unverified";
export type ConfigScope = "agent" | "org" | "host fallback" | "user";
export interface ConnectorRow {
  connector: string;
  configured: boolean | null;
  configScope: ConfigScope | null;
  owner: string | null;
  outboundIdentity: string | null;
  selectedScope: string | null;
  effective: string | null;
  provider: string | null;
  route: "direct" | "passthrough" | null;
  grade: Grade;
  reason: string;
  flagged: boolean;
  details?: Record<string, unknown>;
}

export function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** Explicit public-field projections only; never serialize config or RPC objects. */
export function publicText(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[/\\\r\n]/.test(value)) return null;
  return redactWakeText(value);
}

export function row(connector: string, fields: Partial<ConnectorRow> = {}): ConnectorRow {
  return {
    connector, configured: null, configScope: null, owner: null, outboundIdentity: null,
    selectedScope: null, effective: null, provider: null, route: null,
    grade: "Unverified", reason: "No evidence available", flagged: false, ...fields,
  };
}

function sameDoorway(base: string, proxy: string): boolean {
  try {
    const current = new URL(base);
    const doorway = new URL(proxy);
    return ["http:", "https:"].includes(current.protocol)
      && current.origin === doorway.origin
      && (current.pathname === doorway.pathname
        || (["127.0.0.1", "localhost", "[::1]"].includes(current.hostname) && current.port === "8787"));
  } catch {
    return false;
  }
}

export interface CardContext {
  agentId?: string;
  sessionKey?: string;
  activeModel?: { provider?: string; modelId?: string; modelRef?: string };
  messageChannel?: string;
  agentAccountId?: string;
}

export function inferenceRow(config: unknown, ctx: CardContext, proxy: string): ConnectorRow {
  const host = record(config);
  const agent = record(record(record(host.agents).entries)[ctx.agentId!]);
  const agentModel = typeof agent.model === "string" ? agent.model : record(agent.model).primary;
  const defaults = record(record(host.agents).defaults);
  const defaultModel = typeof defaults.model === "string" ? defaults.model : record(defaults.model).primary;
  const ref = ctx.activeModel?.modelRef ?? agentModel ?? defaultModel;
  const provider = publicText(ctx.activeModel?.provider ?? (typeof ref === "string" ? ref.split("/")[0] : null));
  const model = publicText(ctx.activeModel?.modelId ?? (typeof ref === "string" ? ref.slice(ref.indexOf("/") + 1) : null));
  const providers = record(record(host.models).providers);
  const base = record(providers[provider ?? ""]).baseUrl
    ?? (provider === "imajin" ? proxy : undefined);
  let route: ConnectorRow["route"] = null;
  try {
    if (typeof base === "string" && ["http:", "https:"].includes(new URL(base).protocol)) {
      route = sameDoorway(base, proxy) ? "passthrough" : "direct";
    }
  } catch { /* Invalid config is not route evidence. */ }
  return row("inference", {
    configured: provider !== null && model !== null,
    configScope: agentModel ? "agent" : "host fallback",
    selectedScope: agentModel ? "agent" : "host fallback",
    provider, route, effective: agentModel ? "agent" : "host fallback",
    grade: provider && model && route ? "From config" : "Unverified",
    reason: route ? "Host-selected model and resolved provider configuration; not proof of provider egress"
      : "Resolved provider URL or active model unavailable; route not inferred from provider name",
    details: { model, modelSource: ctx.activeModel ? "host activeModel" : "gateway config" },
  });
}

/** Scope/account facts, not tokens, targets, credential paths, or bot secrets. */
export function channelRows(config: unknown, ctx: CardContext): ConnectorRow[] {
  const bindings = record(config).bindings;
  const matching = Array.isArray(bindings) ? bindings.filter((binding) =>
    record(binding).agentId === ctx.agentId) : [];
  return matching.map((binding) => {
    const match = record(record(binding).match);
    return row("channels", {
      configured: true, configScope: "agent", selectedScope: "agent",
      provider: publicText(match.channel), outboundIdentity: publicText(match.accountId),
      effective: "agent", grade: "From config", reason: "Gateway binding for this agent; account ID is not an Imajin DID",
      details: { channel: publicText(match.channel), accountId: publicText(match.accountId) },
    });
  }).concat(matching.length ? [] : [row("channels", {
    configured: false, configScope: "agent", selectedScope: "agent",
    reason: "No explicit channel binding for this agent in the available gateway config",
    details: { currentChannel: publicText(ctx.messageChannel), currentAccountId: publicText(ctx.agentAccountId) },
  })]);
}

function githubFacts(value: unknown) {
  const facts = record(value);
  return {
    source: publicText(facts.source),
    credentialKind: publicText(facts.credentialKind),
    credentialState: publicText(facts.credentialState),
    refreshState: publicText(facts.refreshState),
    evidence: publicText(facts.evidence),
    repositoryGrants: publicText(facts.repositoryGrants),
    account: { login: publicText(record(facts.account).login) },
    gitAuthor: { name: publicText(record(facts.gitAuthor).name), email: publicText(record(facts.gitAuthor).email) },
    accessExpiresAtMs: typeof facts.accessExpiresAtMs === "number" && Number.isFinite(facts.accessExpiresAtMs)
      ? facts.accessExpiresAtMs : null,
    oauthScopes: Array.isArray(facts.oauthScopes) ? facts.oauthScopes.map(publicText).filter(Boolean) : [],
    stale: facts.stale === true,
  };
}

export function githubRow(config: unknown, ctx: CardContext, response?: unknown): ConnectorRow {
  const host = record(config);
  const agent = record(record(record(host.agents).entries)[ctx.agentId!]);
  const bound = Object.keys(record(record(agent.tools).github)).length > 0;
  const selected = record(record(response).selected);
  const effective = githubFacts(record(response).effective);
  const valid = record(response).agentId === ctx.agentId && record(response).selectedScope === "agent"
    && ["agent-override", "system-configured", "system-detected"].includes(effective.source ?? "");
  const scope = valid ? (effective.source === "agent-override" ? "agent" : "host fallback")
    : (bound ? "agent" : "host fallback");
  const live = valid && effective.evidence === "github-api" && effective.credentialState === "available"
    && !effective.stale && effective.account.login !== null;
  return row("GitHub", {
    configured: valid ? effective.credentialKind !== "native" : bound || Object.keys(record(record(host.tools).github)).length > 0,
    configScope: scope, selectedScope: "agent", owner: valid ? effective.account.login : null,
    outboundIdentity: valid ? effective.account.login : null,
    effective: valid ? scope : null, grade: live ? "Observed live" : "Unverified",
    reason: valid ? (scope === "host fallback" ? "host fallback — not own identity; " : "")
      + (live ? "Gateway status reports a current GitHub API account verification"
        : "Gateway status is unavailable, stale, or not live-verified")
      : (bound ? "Agent binding configured; " : "host fallback — not own identity; ")
        + "GitHub status unavailable through this host's plugin gateway SDK",
    flagged: scope === "host fallback",
    ...(valid ? { details: {
      selected: { scope: "agent", configured: selected.configured === true,
        identity: selected.identity ? githubFacts(selected.identity) : null },
      effective,
    } } : {}),
  });
}

export function mcpRow(config: unknown): ConnectorRow {
  const servers = record(record(record(config).mcp).servers);
  const enabled = Object.values(servers).some((entry) => record(entry).enabled !== false);
  return row("MCP", {
    configured: enabled, configScope: "host fallback", selectedScope: "host fallback",
    reason: "Gateway MCP registration only; per-request caller identity is not exposed by the SDK",
    details: { serverCount: Object.keys(servers).length },
  });
}
