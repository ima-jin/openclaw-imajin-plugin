/**
 * Imajin OpenClaw model provider (#36, companion of #24's operator-approvals
 * bridge and the kernel/proxy half `ima-jin/imajin-ai#2201`).
 *
 * Registers `imajin` as a text/chat `api.registerProvider` provider
 * (`docs/plugins/sdk-provider-plugins.md`) whose catalog is discovered live
 * from the local kernel inference proxy: `GET {inferProxyBaseUrl}/models`
 * (default `http://127.0.0.1:8787/openai/v1`, so the effective endpoint is
 * `.../openai/v1/models`), in the OpenAI list shape imajin-ai#2201 specifies:
 *
 * ```json
 * {
 *   "object": "list",
 *   "data": [
 *     { "id": "grok-4", "object": "model", "owned_by": "xai", "created": 0,
 *       "imajin": { "connector": "xai", "credentialDid": "did:...", "servable": true } }
 *   ]
 * }
 * ```
 *
 * Sealing a connector card on `/jin` becomes the whole provisioning act:
 * every usable (connector, model) pair the kernel returns appears here as
 * `imajin/<id>`, projected as a text/chat model named `<id> (via
 * <connector>)` when `imajin.connector` metadata is present.
 *
 * ## Auth (no user credential)
 * The proxy authenticates to the kernel with its own app key — there is no
 * user-entered credential for this provider, ever. `IMAJIN_SYNTHETIC_API_KEY`
 * is a non-secret placeholder marker in the same posture as bundled local
 * providers with no real credential (Ollama's `ollama-local` marker,
 * `resolveSyntheticAuth`, `extensions/ollama/index.ts`): the SDK's
 * placeholder/no-key auth mode for this class of provider is `auth: []`
 * (nothing to prompt for) plus `resolveSyntheticAuth` supplying the marker
 * so auth resolution never fails closed on "no API key found".
 *
 * ## Live discovery cache + WS-driven refresh
 * `ImajinCatalogCache` intentionally does NOT rely on the SDK's built-in
 * `liveModelDiscovery: true` sugar (`openclaw/plugin-sdk/provider-catalog-
 * live-runtime`) because that cache has no plugin-facing invalidation hook,
 * and #36 item 2 requires the catalog to reflect a sealed/unsealed connector
 * within seconds of a kernel WS notification, not just the ~60s TTL. This
 * module owns a small process-local TTL cache instead, with an explicit
 * `invalidate()` the plugin's existing `ImajinWsService` frame handler calls
 * (see `index.ts`) — see `IMAJIN_CATALOG_INVALIDATION_SCOPES` below for the
 * documented candidate scope names.
 *
 * A failed or empty fetch NEVER serves a previously-cached (now stale) list
 * past its own TTL: a proxy outage degrades straight to "no models", never
 * to a stale-but-wrong catalog (#36 spec).
 */

export const IMAJIN_PROVIDER_ID = "imajin";
export const IMAJIN_PROVIDER_LABEL = "Imajin (kernel seat)";
export const DEFAULT_INFER_PROXY_BASE_URL = "http://127.0.0.1:8787/openai/v1";
export const IMAJIN_MODELS_ENDPOINT_PATH = "models";
export const IMAJIN_HEALTHZ_PATH = "/healthz";

/**
 * Non-secret placeholder marker for the imajin provider's synthetic
 * credential (see module doc "Auth"). Never a real secret, never resolved
 * from an env var or SecretRef, and never logged as sensitive — it exists
 * only so the SDK's normal "no API key found for provider" fail-closed path
 * never fires for a provider that legitimately has no user credential.
 */
export const IMAJIN_SYNTHETIC_API_KEY = "imajin-local-proxy";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

// --- Wire types (kernel side, ima-jin/imajin-ai#2201) ---

export interface ImajinCatalogRowMetadata {
  connector?: string;
  credentialDid?: string;
  servable?: boolean;
}

export interface ImajinCatalogRow {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
  imajin?: ImajinCatalogRowMetadata;
  [key: string]: unknown;
}

export interface ImajinModelsListResponse {
  object?: string;
  data?: ImajinCatalogRow[];
}

// --- Projection (kernel row -> OpenClaw runtime model) ---

export interface ImajinRuntimeModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly ["text"];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  /** The kernel-reported connector id, when present — used by policy/approval matching and status output. */
  connector?: string;
}

/**
 * Projects a kernel `/models` body into text/chat runtime models. Rows
 * missing a usable string `id` are dropped; duplicate ids keep the first
 * occurrence (the kernel's own resolution order, per imajin-ai#2201, so
 * `data[0]` for a given id is authoritative). Never throws — a malformed
 * body (missing/non-array `data`) simply projects to an empty catalog,
 * matching the "degrade to no models" contract.
 */
export function projectImajinCatalogRows(
  response: ImajinModelsListResponse | null | undefined,
): ImajinRuntimeModel[] {
  const rows = Array.isArray(response?.data) ? (response!.data as ImajinCatalogRow[]) : [];
  const models: ImajinRuntimeModel[] = [];
  const seenIds = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.id !== "string") continue;
    const id = row.id.trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const connector =
      typeof row.imajin?.connector === "string" ? row.imajin.connector.trim() : "";
    models.push({
      id,
      name: connector ? `${id} (via ${connector})` : id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      ...(connector ? { connector } : {}),
    });
  }
  return models;
}

// --- Config resolution ---

export function resolveImajinInferProxyBaseUrl(
  config: { inferProxyBaseUrl?: string } | undefined,
): string {
  const trimmed = config?.inferProxyBaseUrl?.trim();
  return trimmed && trimmed.length > 0
    ? trimmed.replace(/\/$/, "")
    : DEFAULT_INFER_PROXY_BASE_URL;
}

export function resolveImajinModelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${IMAJIN_MODELS_ENDPOINT_PATH}`;
}

/** The proxy's `/healthz` lives at the proxy root, not under `/openai/v1`. */
export function resolveImajinHealthzUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/openai\/v1\/?$/, "");
  return `${root.replace(/\/$/, "")}${IMAJIN_HEALTHZ_PATH}`;
}

// --- Provider config builder ---

export interface ImajinProviderConfig {
  api: "openai-completions";
  baseUrl: string;
  apiKey: string;
  models: ImajinRuntimeModel[];
}

export function buildImajinProviderConfig(params: {
  baseUrl: string;
  models: readonly ImajinRuntimeModel[];
}): ImajinProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: params.baseUrl,
    apiKey: IMAJIN_SYNTHETIC_API_KEY,
    models: params.models.map((model) => ({ ...model })),
  };
}

// --- Live-discovery cache (manual TTL + invalidate) ---

export type ImajinCatalogOutcome = "live" | "empty" | "error";

export interface ImajinCatalogCacheState {
  models: ImajinRuntimeModel[];
  fetchedAtMs: number;
  outcome: ImajinCatalogOutcome;
  error?: string;
}

export type ImajinCatalogFetcher = () => Promise<ImajinModelsListResponse>;

/**
 * Process-local TTL cache over one `ImajinCatalogFetcher`, with a manual
 * `invalidate()` the WS notification handler calls for sub-TTL refresh (#36
 * item 2). See module doc for why this isn't the SDK's `liveModelDiscovery`
 * sugar.
 */
export class ImajinCatalogCache {
  private state: ImajinCatalogCacheState | null = null;
  private inFlight: Promise<ImajinCatalogCacheState> | null = null;

  constructor(
    private readonly fetcher: ImajinCatalogFetcher,
    private readonly ttlMs: number = DEFAULT_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Forces the next `get()` to refetch, regardless of remaining TTL. */
  invalidate(): void {
    this.state = null;
  }

  /** The last resolved state, if any, without forcing a fetch (used by status/doctor and the approvals source). */
  peek(): ImajinCatalogCacheState | null {
    return this.state;
  }

  async get(): Promise<ImajinCatalogCacheState> {
    if (this.state && this.now() - this.state.fetchedAtMs < this.ttlMs) {
      return this.state;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.refresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async refresh(): Promise<ImajinCatalogCacheState> {
    try {
      const response = await this.fetcher();
      const models = projectImajinCatalogRows(response);
      const state: ImajinCatalogCacheState = {
        models,
        fetchedAtMs: this.now(),
        outcome: models.length > 0 ? "live" : "empty",
      };
      this.state = state;
      return state;
    } catch (err) {
      // Advisory failure: degrade to "no models" and do NOT keep serving a
      // previously successful (now-expired) catalog as if it were current.
      const state: ImajinCatalogCacheState = {
        models: [],
        fetchedAtMs: this.now(),
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
      };
      this.state = state;
      return state;
    }
  }
}

// --- WS-driven invalidation (#36 item 2) ---

/**
 * Documented candidate kernel notification scopes that should invalidate
 * the catalog cache (connector sealed / unsealed / model-changed). As of
 * this writing the kernel/proxy half (`ima-jin/imajin-ai#2201`) does not yet
 * document emitting any of these over the existing `wsNotifications` bridge
 * — this list is this plugin's documented reaction contract; confirming (or
 * renaming) the exact emitted scope(s) is a kernel-side follow-up (see the
 * PR body).
 */
export const IMAJIN_CATALOG_INVALIDATION_SCOPES: readonly string[] = [
  "imajin.connector.sealed",
  "imajin.connector.unsealed",
  "imajin.connector.model_changed",
  "imajin.connector.model-changed",
  "connector.sealed",
  "connector.unsealed",
  "connector.model_changed",
];

export function isImajinCatalogInvalidationScope(scope: string): boolean {
  return IMAJIN_CATALOG_INVALIDATION_SCOPES.includes(scope);
}

// --- Doctor/status snapshot (#36 item 4) ---

export interface ImajinProxyHealthz {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

export interface ImajinStatusSnapshot {
  baseUrl: string;
  catalog: Array<{ id: string; name: string; connector?: string }>;
  lastDiscovery: {
    fetchedAt: string | null;
    outcome: ImajinCatalogOutcome | "never";
    error?: string;
    modelCount: number;
  };
  healthz: ImajinProxyHealthz;
}

export function buildImajinStatusSnapshot(params: {
  baseUrl: string;
  cacheState: ImajinCatalogCacheState | null;
  healthz: ImajinProxyHealthz;
}): ImajinStatusSnapshot {
  const { cacheState } = params;
  return {
    baseUrl: params.baseUrl,
    catalog: (cacheState?.models ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.connector ? { connector: model.connector } : {}),
    })),
    lastDiscovery: {
      fetchedAt: cacheState ? new Date(cacheState.fetchedAtMs).toISOString() : null,
      outcome: cacheState?.outcome ?? "never",
      ...(cacheState?.error ? { error: cacheState.error } : {}),
      modelCount: cacheState?.models.length ?? 0,
    },
    healthz: params.healthz,
  };
}

// --- Live wiring (network — isolated from the pure helpers above) ---

/** Guarded-ish fetch: bounded timeout, no credential header (see module doc "Auth"). */
export function createImajinModelsFetcher(baseUrl: string): ImajinCatalogFetcher {
  const url = resolveImajinModelsUrl(baseUrl);
  return async () => {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`imajin proxy models fetch failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as ImajinModelsListResponse;
  };
}

/** `GET {proxyRoot}/healthz` for doctor/status (#36 item 4). Never throws — failures are reported in the returned shape. */
export async function fetchImajinProxyHealthz(baseUrl: string): Promise<ImajinProxyHealthz> {
  const url = resolveImajinHealthzUrl(baseUrl);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => undefined);
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface RegisteredImajinProvider {
  cache: ImajinCatalogCache;
  baseUrl: string;
}

/**
 * Registers the `imajin` provider (#36 item 1). `api` is loosely typed
 * (`registerProvider` accepts an arbitrary shape per the SDK), matching this
 * plugin's existing convention (see `index.ts`'s `register(api: any)`).
 */
export function registerImajinProvider(
  api: { registerProvider: (definition: Record<string, unknown>) => void },
  config: { inferProxyBaseUrl?: string } | undefined,
): RegisteredImajinProvider {
  const baseUrl = resolveImajinInferProxyBaseUrl(config);
  const cache = new ImajinCatalogCache(createImajinModelsFetcher(baseUrl));

  api.registerProvider({
    id: IMAJIN_PROVIDER_ID,
    label: IMAJIN_PROVIDER_LABEL,
    docsPath: "/providers/imajin",
    // No user-entered credential exists for this provider (see module doc
    // "Auth") — never prompt for one.
    auth: [],
    // Local/self-hosted-style synthetic credential (mirrors Ollama's
    // `resolveSyntheticAuth` posture, `extensions/ollama/index.ts`) so the
    // generic "no API key found for provider" fail-closed path never fires.
    resolveSyntheticAuth: () => ({
      apiKey: IMAJIN_SYNTHETIC_API_KEY,
      source: "imajin kernel proxy (no user credential — proxy authenticates to the kernel itself)",
      mode: "api-key",
    }),
    catalog: {
      order: "simple",
      run: async () => {
        const state = await cache.get();
        return { provider: buildImajinProviderConfig({ baseUrl, models: state.models }) };
      },
    },
    // Static seed is intentionally EMPTY (#36 spec): a proxy outage must
    // degrade to "no models", never to a stale/wrong catalog.
    staticCatalog: {
      order: "simple",
      run: async () => ({ provider: buildImajinProviderConfig({ baseUrl, models: [] }) }),
    },
  });

  return { cache, baseUrl };
}
