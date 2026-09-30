/**
 * Imajin OpenClaw model provider (#36, companion of #24's operator-approvals
 * bridge and the kernel/proxy half `ima-jin/imajin-ai#2201`).
 *
 * Registers `imajin` as a text/chat `api.registerProvider` provider
 * (`docs/plugins/sdk-provider-plugins.md`) whose catalog is discovered live
 * from the KERNEL (#55): `GET {nodeUrl}/infer/v1/models/usable`, authenticated
 * with the plugin's existing agent-DID challenge-response session (never a
 * static bearer). Completions still flow through the local passthrough proxy
 * (`inferProxyBaseUrl`, default `http://127.0.0.1:8787/openai/v1`) — that is
 * only the `baseUrl` every discovered `imajin/<id>` model is registered with.
 * (The proxy's own `/openai/v1/models` is not used: it 404s, imajin-ai#2453.)
 * The kernel answers in the OpenAI list shape imajin-ai#2201 specifies:
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
 * ## Live discovery cache, scheduler + WS-driven refresh
 * `ImajinCatalogCache` intentionally does NOT rely on the SDK's built-in
 * `liveModelDiscovery: true` sugar (`openclaw/plugin-sdk/provider-catalog-
 * live-runtime`) because that cache has no plugin-facing invalidation hook,
 * and #36 item 2 requires the catalog to reflect a sealed/unsealed connector
 * within seconds of a kernel WS notification, not just the ~60s TTL. This
 * module owns a small process-local TTL cache instead, with an explicit
 * `invalidate()` the plugin's existing `ImajinWsService` frame handler calls
 * (see `index.ts`) on the three kernel notification scopes named by
 * `IMAJIN_CATALOG_INVALIDATION_SCOPES` below — confirmed against the landed
 * kernel/proxy half `ima-jin/imajin-ai#2219` (closing #2205).
 *
 * ## Why discovery never ran before (#55)
 * The cache was purely lazy — nothing fetched until the SDK happened to call
 * `catalog.run` — so `imajin_status` (which only `peek()`s) reported
 * `outcome: "never"` forever. On top of that the one URL it would have tried
 * was the proxy's `/openai/v1/models` (404, imajin-ai#2453) with no auth.
 * Discovery is now driven by `startImajinModelDiscovery` (initial fetch at
 * plugin start + a periodic refresh) against the kernel route.
 *
 * ## Failure contract (#55)
 * A failed fetch (kernel unreachable, route error, auth rejection, malformed
 * body) NEVER crashes plugin start and NEVER wipes the catalog: the last good
 * catalog keeps being served, `lastDiscovery` records what went wrong, and the
 * failure is logged once per distinct failure (not once per retry). An empty
 * but well-formed list IS authoritative (e.g. the last connector was
 * unsealed) and replaces the catalog.
 */

export const IMAJIN_PROVIDER_ID = "imajin";
export const IMAJIN_PROVIDER_LABEL = "Imajin (kernel seat)";
export const DEFAULT_INFER_PROXY_BASE_URL = "http://127.0.0.1:8787/openai/v1";
export const IMAJIN_HEALTHZ_PATH = "/healthz";
/**
 * Kernel route discovery targets (imajin-ai#2201). NOT `/infer/v1/models`:
 * that exact path is the Anthropic model-catalog passthrough (#1959); the
 * OpenAI-shaped list of the principal's usable brains lives at `.../usable`.
 * Overridable via `modelDiscovery.modelsPath`.
 */
export const DEFAULT_KERNEL_MODELS_PATH = "/infer/v1/models/usable";
/** Default periodic re-discovery interval (5 min). The WS scopes cover the fast path. */
export const DEFAULT_DISCOVERY_REFRESH_INTERVAL_MS = 300_000;
/** Floor for the configurable interval, so a typo can't hammer the kernel. */
export const MIN_DISCOVERY_REFRESH_INTERVAL_MS = 10_000;

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

/** Discovery config (`plugins.entries.imajin.config.modelDiscovery`, #55). */
export interface ImajinModelDiscoveryConfig {
  /** Periodic refresh interval in ms. `0` disables the periodic refresh (start-up discovery still runs). */
  refreshIntervalMs?: number;
  /** Kernel route to discover against. Default {@link DEFAULT_KERNEL_MODELS_PATH}. */
  modelsPath?: string;
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
    // The kernel only lists servable rows today; honour an explicit `false`.
    if (row.imajin?.servable === false) continue;
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

// --- Discovery outcomes + errors (#55) ---

/**
 * Why a discovery attempt failed. `unreachable` (transport: connection
 * refused / DNS / timeout / gateway 502-504) is deliberately distinct from
 * `route-error` (the kernel answered, but with a non-2xx such as the 404/500
 * of imajin-ai#2453) so an operator can tell "kernel down" from "kernel up,
 * route broken".
 */
export type ImajinDiscoveryFailureKind =
  | "unreachable"
  | "route-error"
  | "auth-error"
  | "malformed"
  | "unconfigured";

export type ImajinCatalogOutcome = "ok" | "empty" | ImajinDiscoveryFailureKind;

export class ImajinDiscoveryError extends Error {
  constructor(
    readonly kind: ImajinDiscoveryFailureKind,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ImajinDiscoveryError";
  }
}

/** True when `body` is a well-formed OpenAI list (`data` is an array). */
export function isImajinModelsListResponse(body: unknown): body is ImajinModelsListResponse {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Array.isArray((body as { data?: unknown }).data)
  );
}

// --- Live-discovery cache (manual TTL + invalidate, last-good on failure) ---

export interface ImajinCatalogCacheState {
  /** The LAST GOOD catalog — kept across failed attempts (#55). */
  models: ImajinRuntimeModel[];
  /** When the most recent attempt (success or failure) finished. */
  fetchedAtMs: number;
  /** Outcome of the most recent attempt. */
  outcome: ImajinCatalogOutcome;
  error?: string;
  /** HTTP status of the failing response, when the kernel answered. */
  httpStatus?: number;
  /** When `models` was last refreshed from a good response (null = never). */
  lastGoodAtMs: number | null;
}

export type ImajinCatalogFetcher = () => Promise<unknown>;

export interface ImajinDiscoveryLogger {
  info(message: string): void;
  warn(message: string): void;
}

const consoleLogger: ImajinDiscoveryLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
};

/**
 * Process-local cache over one `ImajinCatalogFetcher`, with a manual
 * `invalidate()` the WS notification handler calls for sub-TTL refresh (#36
 * item 2). See module doc for why this isn't the SDK's `liveModelDiscovery`
 * sugar, and for the failure contract.
 */
export class ImajinCatalogCache {
  private state: ImajinCatalogCacheState | null = null;
  private stale = false;
  private inFlight: Promise<ImajinCatalogCacheState> | null = null;
  private lastFailureSignature: string | null = null;
  private lastLoggedModelIds: string | null = null;

  constructor(
    private readonly fetcher: ImajinCatalogFetcher,
    private readonly ttlMs: number = DEFAULT_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly logger: ImajinDiscoveryLogger = consoleLogger,
  ) {}

  /** Forces the next `get()`/`refresh()` to refetch, regardless of remaining TTL. The last good catalog is kept until then. */
  invalidate(): void {
    this.stale = true;
  }

  /** The last resolved state, if any, without forcing a fetch (used by status/doctor and the approvals source). */
  peek(): ImajinCatalogCacheState | null {
    return this.state;
  }

  async get(): Promise<ImajinCatalogCacheState> {
    if (this.state && !this.stale && this.now() - this.state.fetchedAtMs < this.ttlMs) {
      return this.state;
    }
    return this.refresh();
  }

  /**
   * Runs one discovery attempt now (concurrent callers share it). NEVER
   * rejects — a failure is recorded in the returned state instead.
   */
  refresh(): Promise<ImajinCatalogCacheState> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const attempt = this.runAttempt().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = attempt;
    return attempt;
  }

  private async runAttempt(): Promise<ImajinCatalogCacheState> {
    const previous = this.state;
    try {
      const body = await this.fetcher();
      if (!isImajinModelsListResponse(body)) {
        throw new ImajinDiscoveryError(
          "malformed",
          "kernel models response is not an OpenAI list (expected an object with a `data` array)",
        );
      }
      const models = projectImajinCatalogRows(body);
      const at = this.now();
      this.stale = false;
      this.state = {
        models,
        fetchedAtMs: at,
        outcome: models.length > 0 ? "ok" : "empty",
        lastGoodAtMs: at,
      };
      this.logSuccess(models);
      return this.state;
    } catch (err) {
      const failure =
        err instanceof ImajinDiscoveryError
          ? err
          : new ImajinDiscoveryError(
              "unreachable",
              err instanceof Error ? err.message : String(err),
            );
      this.stale = false;
      this.state = {
        models: previous?.models ?? [],
        fetchedAtMs: this.now(),
        outcome: failure.kind,
        error: failure.message,
        ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
        lastGoodAtMs: previous?.lastGoodAtMs ?? null,
      };
      this.logFailure(failure, this.state.models.length);
      return this.state;
    }
  }

  private logSuccess(models: readonly ImajinRuntimeModel[]): void {
    const ids = models.map((model) => model.id).join(",");
    if (this.lastFailureSignature !== null) {
      this.logger.info(
        `[imajin-plugin] model discovery recovered: ${models.length} model(s) via the kernel`,
      );
    } else if (this.lastLoggedModelIds !== ids) {
      this.logger.info(
        `[imajin-plugin] model discovery: ${models.length} model(s) [${ids}]`,
      );
    }
    this.lastFailureSignature = null;
    this.lastLoggedModelIds = ids;
  }

  /** Log once per distinct failure — a steady-state outage does not spam every refresh. */
  private logFailure(failure: ImajinDiscoveryError, keptModels: number): void {
    const signature = `${failure.kind}:${failure.httpStatus ?? ""}`;
    if (signature === this.lastFailureSignature) return;
    this.lastFailureSignature = signature;
    const status = failure.httpStatus === undefined ? "" : ` ${failure.httpStatus}`;
    this.logger.warn(
      `[imajin-plugin] model discovery failed (${failure.kind}${status}): ${failure.message} — ` +
        `keeping last good catalog (${keptModels} model(s)); will keep retrying`,
    );
  }
}

// --- Scheduler (#55): discovery at plugin start + periodic refresh ---

export function resolveDiscoveryRefreshIntervalMs(
  config: ImajinModelDiscoveryConfig | undefined,
): number {
  const raw = config?.refreshIntervalMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_DISCOVERY_REFRESH_INTERVAL_MS;
  }
  if (raw <= 0) return 0;
  return Math.max(MIN_DISCOVERY_REFRESH_INTERVAL_MS, Math.floor(raw));
}

export interface ImajinDiscoveryHandle {
  stop(): void;
}

/**
 * Runs one discovery immediately (fire-and-forget; `refresh()` never
 * rejects, so plugin start can never crash on it) and, unless
 * `intervalMs === 0`, re-runs it on an unref'd interval. Overlapping runs
 * coalesce inside the cache.
 */
export function startImajinModelDiscovery(
  cache: Pick<ImajinCatalogCache, "refresh">,
  intervalMs: number,
): ImajinDiscoveryHandle {
  void cache.refresh();
  if (intervalMs <= 0) {
    return { stop: () => {} };
  }
  const timer = setInterval(() => {
    void cache.refresh();
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

// --- WS-driven invalidation (#36 item 2) ---

/**
 * Kernel notification scopes that invalidate the catalog cache, confirmed
 * against the landed kernel/proxy half (`ima-jin/imajin-ai#2219`, closing
 * `ima-jin/imajin-ai#2205`): `connector.credential.sealed` and
 * `connector.credential.unsealed` fire on a connector's credential being
 * sealed/unsealed, `connector.models.changed` fires when the usable model
 * set for a connector changes. All three arrive as the kernel's existing
 * generic notification envelope (`type: "notification"`, `scope`, `data`,
 * `createdAt`) over the plugin's existing `wsNotifications` bridge — the
 * same `NotificationFrame` shape `index.ts` already dispatches on via
 * `nf.scope`. `data` carries `{ provider }` for the two credential scopes
 * and `{ provider, hint }` for `connector.models.changed`; neither is
 * consulted here since invalidation only needs the scope match.
 */
export const IMAJIN_CATALOG_INVALIDATION_SCOPES: readonly string[] = [
  "connector.credential.sealed",
  "connector.credential.unsealed",
  "connector.models.changed",
];

export function isImajinCatalogInvalidationScope(scope: string): boolean {
  return IMAJIN_CATALOG_INVALIDATION_SCOPES.includes(scope);
}

// --- Doctor/status snapshot (#36 item 4, #55) ---

export interface ImajinProxyHealthz {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

export interface ImajinStatusSnapshot {
  baseUrl: string;
  /** Kernel route discovery targets, and how often it is re-run (0 = start-up only). */
  discovery?: { modelsUrl: string; refreshIntervalMs: number };
  catalog: Array<{ ref: string; id: string; name: string; connector?: string }>;
  lastDiscovery: {
    fetchedAt: string | null;
    outcome: ImajinCatalogOutcome | "never";
    error?: string;
    /** HTTP status when the kernel answered with an error (route-error / auth-error). */
    httpStatus?: number;
    /** When the catalog was last refreshed from a good response. */
    lastGoodAt?: string | null;
    modelCount: number;
  };
  healthz: ImajinProxyHealthz;
}

export function buildImajinStatusSnapshot(params: {
  baseUrl: string;
  cacheState: ImajinCatalogCacheState | null;
  healthz: ImajinProxyHealthz;
  discovery?: { modelsUrl: string; refreshIntervalMs: number };
}): ImajinStatusSnapshot {
  const { cacheState } = params;
  return {
    baseUrl: params.baseUrl,
    ...(params.discovery ? { discovery: params.discovery } : {}),
    catalog: (cacheState?.models ?? []).map((model) => ({
      ref: `${IMAJIN_PROVIDER_ID}/${model.id}`,
      id: model.id,
      name: model.name,
      ...(model.connector ? { connector: model.connector } : {}),
    })),
    lastDiscovery: {
      fetchedAt: cacheState ? new Date(cacheState.fetchedAtMs).toISOString() : null,
      outcome: cacheState?.outcome ?? "never",
      ...(cacheState?.error ? { error: cacheState.error } : {}),
      ...(cacheState?.httpStatus === undefined ? {} : { httpStatus: cacheState.httpStatus }),
      ...(cacheState
        ? {
            lastGoodAt:
              cacheState.lastGoodAtMs === null
                ? null
                : new Date(cacheState.lastGoodAtMs).toISOString(),
          }
        : {}),
      modelCount: cacheState?.models.length ?? 0,
    },
    healthz: params.healthz,
  };
}

// --- Live wiring (network — isolated from the pure helpers above) ---

/** The one method of `ImajinClient` discovery needs (DID challenge-response auth lives there). */
export interface ImajinKernelRequester {
  requestRaw(
    path: string,
    opts?: { method?: "GET"; onBehalfOf?: string },
  ): Promise<{ status: number; contentType: string; text: string }>;
}

export function resolveImajinKernelModelsPath(
  config: ImajinModelDiscoveryConfig | undefined,
): string {
  const trimmed = config?.modelsPath?.trim();
  if (!trimmed) return DEFAULT_KERNEL_MODELS_PATH;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Full kernel discovery URL, for status output. */
export function resolveImajinKernelModelsUrl(nodeUrl: string | undefined, modelsPath: string): string {
  return `${(nodeUrl ?? "").replace(/\/$/, "")}${modelsPath}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ImajinDiscoveryError("unreachable", `kernel did not answer within ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Maps an error thrown by the authenticated client (`requestRaw` ->
 * `authenticate()` / `fetch`) onto a discovery failure kind. A problem
 * obtaining the session (bad/missing keypair, challenge/verify rejected) is
 * an `auth-error`; everything else thrown is transport (`unreachable`).
 */
export function classifyImajinTransportError(err: unknown): ImajinDiscoveryError {
  if (err instanceof ImajinDiscoveryError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (
    /^Auth (challenge|verify) failed/.test(message) ||
    /^No keypairPath configured/.test(message) ||
    code === "ENOENT" ||
    code === "EACCES" ||
    err instanceof SyntaxError
  ) {
    return new ImajinDiscoveryError("auth-error", message);
  }
  return new ImajinDiscoveryError("unreachable", message);
}

/**
 * Fetcher for `GET {nodeUrl}{modelsPath}` through the plugin's own
 * authenticated kernel client (agent DID challenge-response session +
 * `X-Acting-For`) — never a static bearer. Pass `undefined` for an
 * unconfigured install (no nodeUrl / keypair): every attempt then fails with
 * kind `unconfigured` instead of throwing at start-up.
 */
export function createImajinKernelModelsFetcher(
  client: ImajinKernelRequester | undefined,
  options: { modelsPath?: string; timeoutMs?: number } = {},
): ImajinCatalogFetcher {
  const path = options.modelsPath ?? DEFAULT_KERNEL_MODELS_PATH;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  return async () => {
    if (!client) {
      throw new ImajinDiscoveryError(
        "unconfigured",
        "model discovery needs plugins.entries.imajin.config.nodeUrl and keypairPath",
      );
    }
    let res: Awaited<ReturnType<ImajinKernelRequester["requestRaw"]>>;
    try {
      res = await withTimeout(client.requestRaw(path), timeoutMs);
    } catch (err) {
      throw classifyImajinTransportError(err);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ImajinDiscoveryError(
        "auth-error",
        `kernel rejected the agent session for GET ${path} (${res.status})`,
        res.status,
      );
    }
    // A reverse proxy in front of a dead kernel answers 502/503/504 — that is
    // "kernel unreachable", not a broken route.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new ImajinDiscoveryError(
        "unreachable",
        `kernel unavailable for GET ${path} (${res.status})`,
        res.status,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      const snippet = res.text.trim().slice(0, 200);
      throw new ImajinDiscoveryError(
        "route-error",
        `GET ${path} returned ${res.status}${snippet ? `: ${snippet}` : ""}`,
        res.status,
      );
    }
    try {
      return JSON.parse(res.text) as unknown;
    } catch {
      throw new ImajinDiscoveryError("malformed", `GET ${path} returned a non-JSON body`);
    }
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
  /** Kernel discovery URL + refresh interval, surfaced by `imajin_status`. */
  discovery: { modelsUrl: string; refreshIntervalMs: number };
  /** Starts the start-up + periodic discovery (#55). Idempotent until `stop()`. */
  startDiscovery(): ImajinDiscoveryHandle;
}

export interface RegisterImajinProviderOptions {
  /** Authenticated kernel client. Omit on an unconfigured install: discovery then reports `unconfigured`. */
  client?: ImajinKernelRequester;
  nodeUrl?: string;
  /** Overrides the kernel fetcher (tests). */
  fetcher?: ImajinCatalogFetcher;
  logger?: ImajinDiscoveryLogger;
}

/**
 * Registers the `imajin` provider (#36 item 1). `api` is loosely typed
 * (`registerProvider` accepts an arbitrary shape per the SDK), matching this
 * plugin's existing convention (see `index.ts`'s `register(api: any)`).
 */
export function registerImajinProvider(
  api: { registerProvider: (definition: Record<string, unknown>) => void },
  config:
    | { inferProxyBaseUrl?: string; modelDiscovery?: ImajinModelDiscoveryConfig }
    | undefined,
  options: RegisterImajinProviderOptions = {},
): RegisteredImajinProvider {
  const baseUrl = resolveImajinInferProxyBaseUrl(config);
  const modelsPath = resolveImajinKernelModelsPath(config?.modelDiscovery);
  const refreshIntervalMs = resolveDiscoveryRefreshIntervalMs(config?.modelDiscovery);
  const fetcher =
    options.fetcher ?? createImajinKernelModelsFetcher(options.client, { modelsPath });
  const cache = new ImajinCatalogCache(fetcher, DEFAULT_CACHE_TTL_MS, Date.now, options.logger);

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
    // Static seed is intentionally EMPTY (#36 spec): before the first
    // successful discovery there is nothing to advertise.
    staticCatalog: {
      order: "simple",
      run: async () => ({ provider: buildImajinProviderConfig({ baseUrl, models: [] }) }),
    },
  });

  return {
    cache,
    baseUrl,
    discovery: {
      modelsUrl: resolveImajinKernelModelsUrl(options.nodeUrl, modelsPath),
      refreshIntervalMs,
    },
    startDiscovery: () => startImajinModelDiscovery(cache, refreshIntervalMs),
  };
}
