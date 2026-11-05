import { redactWakeText } from "./wake-redaction.js";

export type Grade = "Observed live" | "Verified when access was granted" | "From config" | "Unverified";
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
  verifiedAtMs?: number | null;
  details?: Record<string, unknown>;
}
function hasGithubBinding(config: unknown): boolean {
  return Object.keys(record(record(record(config).tools).github)).length > 0;
}

function githubScope(valid: boolean, source: string | null, bound: boolean): ConfigScope {
  if (valid) return source === "agent-override" ? "agent" : "host fallback";
  return bound ? "agent" : "host fallback";
}

function githubReason(valid: boolean, scope: ConfigScope, apiVerified: boolean): string {
  let prefix = "";
  if (scope === "host fallback") prefix = "host fallback — not own identity; ";
  else if (!valid) prefix = "Agent binding configured; ";
  if (!valid) return prefix + "GitHub status unavailable through this host's plugin gateway SDK";
  if (apiVerified) return prefix + "GitHub identity was verified when access was granted, not in this call; gateway status may be cached";
  return prefix + "Gateway status is unavailable, stale, or not live-verified";
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
function primaryModel(value: unknown): unknown {
  return typeof value === "string" ? value : record(value).primary;
}

function configuredAgent(config: unknown, agentId?: string) {
  return record(record(record(record(config).agents).entries)[agentId ?? ""]);
}

function providerRoute(base: unknown, proxy: string): ConnectorRow["route"] {
  if (typeof base !== "string") return null;
  try {
    if (!["http:", "https:"].includes(new URL(base).protocol)) return null;
    return sameDoorway(base, proxy) ? "passthrough" : "direct";
  } catch {
    return null;
  }
}

function modelParts(ref: unknown): { provider?: string; modelId?: string } {
  if (typeof ref !== "string" || !ref.includes("/")) return {};
  const separator = ref.indexOf("/");
  return { provider: ref.slice(0, separator), modelId: ref.slice(separator + 1) };
}

export function inferenceRow(config: unknown, ctx: CardContext, proxy: string): ConnectorRow {
  const host = record(config);
  const agentModel = primaryModel(configuredAgent(config, ctx.agentId).model);
  const fallback = primaryModel(record(record(host.agents).defaults).model);
  const parts = modelParts(ctx.activeModel?.modelRef ?? agentModel ?? fallback);
  const provider = publicText(ctx.activeModel?.provider ?? parts.provider);
  const model = publicText(ctx.activeModel?.modelId ?? parts.modelId);
  const providers = record(record(host.models).providers);
  const base = record(providers[provider ?? ""]).baseUrl
    ?? (provider === "imajin" ? proxy : undefined);
  const route = providerRoute(base, proxy);
  const scope = agentModel ? "agent" : "host fallback";
  return row("inference", {
    configured: provider !== null && model !== null,
    configScope: scope, selectedScope: scope, effective: scope, provider, route,
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
    configured: config ? false : null, configScope: "agent", selectedScope: "agent",
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
    verifiedAtMs: typeof facts.verifiedAtMs === "number" && Number.isFinite(facts.verifiedAtMs) && facts.verifiedAtMs >= 0
      ? facts.verifiedAtMs : null,
  };
}

export function githubRow(config: unknown, ctx: CardContext, response?: unknown): ConnectorRow {
  const bound = hasGithubBinding(configuredAgent(config, ctx.agentId));
  const selected = record(record(response).selected);
  const effective = githubFacts(record(response).effective);
  const valid = record(response).agentId === ctx.agentId && record(response).selectedScope === "agent"
    && ["agent-override", "system-configured", "system-detected"].includes(effective.source ?? "");
  const scope = githubScope(valid, effective.source, bound);
  const apiVerified = valid && effective.evidence === "github-api" && effective.credentialState === "available"
    && !effective.stale && effective.account.login !== null;
  return row("GitHub", {
    configured: valid ? effective.credentialKind !== "native" : bound || hasGithubBinding(config),
    configScope: scope, selectedScope: "agent", owner: valid ? effective.account.login : null,
    outboundIdentity: valid ? effective.account.login : null,
    effective: valid ? scope : null, grade: apiVerified ? "Verified when access was granted" : "Unverified",
    verifiedAtMs: apiVerified ? effective.verifiedAtMs : null,
    reason: githubReason(valid, scope, apiVerified),
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
    configured: config ? enabled : null, configScope: "host fallback", selectedScope: "host fallback",
    reason: "Gateway MCP registration only; per-request caller identity is not exposed by the SDK",
    details: { serverCount: Object.keys(servers).length },
  });
}
