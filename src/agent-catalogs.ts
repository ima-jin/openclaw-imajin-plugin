import { resolve } from "node:path";
import { AgentInferenceAuth, InferenceAuthError } from "./inference-auth.js";
import { createAgentModelsFetcher } from "./inference-discovery.js";
import type { AgentIdentity } from "./agent-identities.js";
import { ImajinCatalogCache, ImajinDiscoveryError, type ImajinCatalogFetcher, type ImajinDiscoveryLogger } from "./imajin-provider.js";

export interface AgentCatalogOptions {
  gatewayAgent?: string;
  agentIds?: string[];
  prepareIdentities?: () => Promise<void>;
  fetcher?: ImajinCatalogFetcher;
  logger?: ImajinDiscoveryLogger;
}
export interface CatalogContext { agentDir?: string; config?: unknown }

/** Agent id, signer generation AND configured selector bound; never share last-good catalogs. */
export class AgentCatalogs {
  private readonly entries = new Map<string, { identity: AgentIdentity; selector?: string; cache: ImajinCatalogCache }>();
  readonly empty: ImajinCatalogCache;

  constructor(
    private readonly auth: AgentInferenceAuth,
    private readonly nodeUrl: string | undefined,
    private readonly modelsPath: string,
    private readonly options: AgentCatalogOptions,
  ) {
    this.empty = this.cache(options.fetcher ?? (() => Promise.reject(
      new ImajinDiscoveryError("unconfigured", "Discovery requires a configured agent identity"),
    )));
  }

  private cache(fetcher: ImajinCatalogFetcher): ImajinCatalogCache {
    return new ImajinCatalogCache(fetcher, 60_000, Date.now, this.options.logger);
  }

  async forAgent(agentId: string): Promise<ImajinCatalogCache> {
    await this.options.prepareIdentities?.();
    const identity = this.auth.identity(agentId);
    let entry = this.entries.get(agentId);
    if (entry?.identity !== identity || entry.selector !== identity.config.actAs) {
      const selector = identity.config.actAs;
      const assertCurrent = () => {
        if (this.auth.identity(agentId) !== identity || identity.config.actAs !== selector
          || this.entries.get(agentId)?.identity !== identity) {
          throw new InferenceAuthError(agentId, "identity runtime changed during discovery");
        }
      };
      entry = { identity, selector: identity.config.actAs,
        cache: new ImajinCatalogCache(this.options.fetcher ?? createAgentModelsFetcher(
          this.auth, agentId, this.nodeUrl, this.modelsPath,
        ), 60_000, Date.now, this.options.logger, assertCurrent) };
      this.entries.set(agentId, entry);
    }
    return entry.cache;
  }

  async signer(ctx?: CatalogContext): Promise<string> {
    if (!ctx?.agentDir) {
      if (!this.options.gatewayAgent) throw new Error("Imajin discovery: gatewayAgent signer required for context-free catalog");
      (this.options.logger ?? console).info(`[imajin-plugin] context-free catalog signer: agents.${this.options.gatewayAgent}`);
      return this.options.gatewayAgent;
    }
    const { resolveAgentDir } = await import("openclaw/plugin-sdk/agent-runtime");
    const ids = (this.options.agentIds ?? []).filter((id) =>
      resolve(resolveAgentDir(ctx.config, id)) === resolve(ctx.agentDir!));
    if (ids.length !== 1) throw new Error("Imajin discovery: agentDir has no unique configured signer");
    return ids[0];
  }

  async models(ctx?: CatalogContext) {
    const cache = this.options.fetcher && !this.options.agentIds
      ? this.empty : await this.forAgent(await this.signer(ctx));
    const state = await cache.get();
    if (state.outcome === "auth-error" || state.outcome === "unconfigured") {
      throw new ImajinDiscoveryError(state.outcome, state.error ?? "Agent catalog unavailable", state.httpStatus);
    }
    return state.models;
  }

  peekGateway(): ImajinCatalogCache {
    return this.entries.get(this.options.gatewayAgent ?? "")?.cache ?? this.empty;
  }

  peekAgent(agentId: string): ImajinCatalogCache { return this.entries.get(agentId)?.cache ?? this.empty; }

  invalidate(agentId: string): void {
    const cache = this.entries.get(agentId)?.cache;
    cache?.invalidate();
    if (cache) void cache.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.options.agentIds) { await this.empty.refresh(); return; }
    await Promise.all(this.options.agentIds.map(async (agentId) => {
      try { await (await this.forAgent(agentId)).refresh(); }
      catch { (this.options.logger ?? console).warn(`[imajin-plugin] agents.${agentId} discovery identity unavailable`); }
    }));
  }

  clear(): void { this.entries.clear(); }
}
