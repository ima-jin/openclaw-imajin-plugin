/**
 * Kernel MCP tools through the local passthrough `/mcp` (#50, proxy half
 * `ima-jin/imajin-ai#2368`).
 *
 * Architecture (do not bend):
 *  - The kernel never calls into the gateway. OpenClaw's own MCP client talks
 *    to the loopback passthrough (`http://127.0.0.1:8787/mcp` by default);
 *    the passthrough mints the user-delegated app token per call and forwards
 *    to the kernel's `/mcp`. Credentials stay kernel/proxy-side.
 *  - This plugin therefore NEVER sends an `Authorization` header (or any
 *    credential) to `/mcp`, never reads one from config, and never logs one.
 *    Its MCP footprint is (a) a read-only probe for `imajin_status`
 *    (`initialize` + `tools/list`), and (b) inspecting — never writing — the
 *    operator's `mcp.servers` entry so status can flag a misregistration.
 *  - Registering the server is an operator step (`mcp.servers.imajin`,
 *    OpenClaw's own MCP registry). The plugin does not write Gateway config
 *    (same posture as the model allow-list, see README).
 */

export const IMAJIN_MCP_PATH = "/mcp";
/** Suggested `mcp.servers.<name>` key. Status matches by URL, not by name. */
export const IMAJIN_MCP_SERVER_NAME = "imajin";
export const DEFAULT_MCP_PROBE_TIMEOUT_MS = 5_000;
const MAX_TOOL_PAGES = 20;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "openclaw-imajin-plugin", version: "0.1.0" };

// --- URL resolution ---

/** Proxy root + `/mcp`, or an explicit `mcpUrl` override (trailing slash trimmed). */
export function resolveImajinMcpUrl(
  config: { mcpUrl?: string } | undefined,
  proxyBaseUrl: string,
): string {
  const override = config?.mcpUrl?.trim();
  if (override) return override.replace(/\/+$/, "");
  const root = proxyBaseUrl.replace(/\/openai\/v1\/?$/, "").replace(/\/+$/, "");
  return `${root}${IMAJIN_MCP_PATH}`;
}

// --- Tool classification (allowlist guidance) ---

export type McpToolAccess = "read" | "gated";

const READ_VERBS = new Set(["get", "list", "search", "read", "find", "query", "free"]);
// Anything that sends, mutates, shares, or arms a side effect (e.g. gmail
// `watch` registers a push subscription although its scope is `read`).
const WRITE_VERBS = new Set([
  "send",
  "create",
  "update",
  "delete",
  "trash",
  "untrash",
  "modify",
  "move",
  "copy",
  "share",
  "insert",
  "patch",
  "draft",
  "reply",
  "forward",
  "archive",
  "label",
  "upload",
  "import",
  "append",
  "set",
  "add",
  "remove",
  "cancel",
  "accept",
  "decline",
  "watch",
  "stop",
  "write",
]);

/**
 * `google_*` tools only. Default-deny: a write verb anywhere in the name, or a
 * name with no recognised read verb, is `gated` (needs explicit operator
 * enable). Returns `undefined` for non-google tools — they are not covered by
 * the #50 guidance and are never classified or gated by this plugin.
 */
export function classifyGoogleMcpTool(name: string): McpToolAccess | undefined {
  if (!name.startsWith("google_")) return undefined;
  const [, , ...verbTokens] = name.split("_"); // google, <service>, verb...
  if (verbTokens.some((token) => WRITE_VERBS.has(token))) return "gated";
  return verbTokens.length > 0 && READ_VERBS.has(verbTokens[0]) ? "read" : "gated";
}

/** `*`-glob match, the same simple form OpenClaw's `toolFilter` uses. */
function globMatches(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const parts = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`).test(name);
}

export interface McpToolFilter {
  include?: string[];
  exclude?: string[];
}

export function toolPassesFilter(name: string, filter: McpToolFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.include && !filter.include.some((p) => globMatches(p, name))) return false;
  if (filter.exclude?.some((p) => globMatches(p, name))) return false;
  return true;
}

export interface McpAllowlistGuidance {
  /** google_* tools that are safe to leave on (read verbs only). */
  googleReadTools: string[];
  /** google_* tools needing explicit operator enable (send/write/side-effect/unrecognised). */
  gatedTools: string[];
  /** Default-deny `toolFilter`: everything except the gated tools, by exact name. */
  suggestedToolFilter: { include: string[] };
}

export function buildMcpAllowlistGuidance(toolNames: readonly string[]): McpAllowlistGuidance {
  const googleReadTools: string[] = [];
  const gatedTools: string[] = [];
  const include: string[] = [];
  for (const name of toolNames) {
    const access = classifyGoogleMcpTool(name);
    if (access === "gated") {
      gatedTools.push(name);
      continue;
    }
    if (access === "read") googleReadTools.push(name);
    include.push(name);
  }
  return { googleReadTools, gatedTools, suggestedToolFilter: { include } };
}

// --- Registration inspection (read-only) ---

export interface McpRegistrationReport {
  registered: boolean;
  /** `mcp.servers` key of the matching entry. */
  name?: string;
  enabled?: boolean;
  transport?: string;
  /**
   * True when the entry carries `headers`: the proxy owns identity, so this is
   * a misconfiguration (a credential would live in openclaw.json). Header
   * VALUES are never read into the report.
   */
  hasHeaders?: boolean;
  warnings: string[];
  /** The entry's `toolFilter`, when present (tool-name patterns only, no secrets). */
  toolFilter?: McpToolFilter;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

/** Finds the `mcp.servers` entry whose `url` is `mcpUrl` in an OpenClaw config object. */
export function inspectMcpRegistration(cfg: unknown, mcpUrl: string): McpRegistrationReport {
  const servers = (cfg as { mcp?: { servers?: unknown } } | undefined)?.mcp?.servers;
  if (typeof servers !== "object" || servers === null) {
    return { registered: false, warnings: [] };
  }
  const target = normalizeUrl(mcpUrl);
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    const server = entry as Record<string, unknown> | null;
    if (typeof server?.url !== "string" || normalizeUrl(server.url) !== target) continue;
    const warnings: string[] = [];
    const headers = server.headers;
    const hasHeaders =
      typeof headers === "object" && headers !== null && Object.keys(headers).length > 0;
    if (hasHeaders) {
      warnings.push(
        "mcp.servers entry sets headers — remove them: the passthrough mints the app token, " +
          "no credential belongs in openclaw.json",
      );
    }
    const enabled = server.enabled !== false;
    const transport = typeof server.transport === "string" ? server.transport : undefined;
    if (transport !== undefined && transport !== "streamable-http") {
      warnings.push(`mcp.servers transport is "${transport}" — use "streamable-http"`);
    }
    const rawFilter = server.toolFilter as { include?: unknown; exclude?: unknown } | undefined;
    const include = stringArray(rawFilter?.include);
    const exclude = stringArray(rawFilter?.exclude);
    return {
      registered: true,
      name,
      enabled,
      ...(transport === undefined ? {} : { transport }),
      hasHeaders,
      warnings,
      ...(include || exclude
        ? { toolFilter: { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) } }
        : {}),
    };
  }
  return { registered: false, warnings: [] };
}

// --- Probe ---

export type McpProbeOutcome =
  | "ok"
  | "unreachable"
  /** Proxy up but no `mcp` route configured (HTTP 422 `no_route_configured`). */
  | "not-configured"
  /** 401/403: attestation rejected / carries no MCP scope. */
  | "auth-error"
  | "route-error"
  | "malformed";

export interface McpProbeResult {
  url: string;
  outcome: McpProbeOutcome;
  ok: boolean;
  httpStatus?: number;
  /** Proxy error code (`insufficient_scope`, `attestation_rejected`, …) when it sent one. */
  errorCode?: string;
  error?: string;
  toolCount: number;
  tools: string[];
  serverName?: string;
}

class McpProbeError extends Error {
  constructor(
    readonly outcome: Exclude<McpProbeOutcome, "ok">,
    message: string,
    readonly httpStatus?: number,
    readonly errorCode?: string,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

interface RpcReply {
  status: number;
  sessionId?: string;
  message?: { result?: unknown; error?: { code?: number; message?: string } };
}

/** Pulls the JSON-RPC reply for `id` out of a JSON body or an SSE stream. */
function parseRpcBody(text: string, contentType: string, id: number): RpcReply["message"] {
  if (contentType.includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as { id?: unknown };
        if (parsed.id === id) return parsed as RpcReply["message"];
      } catch {
        // ignore non-JSON events
      }
    }
    return undefined;
  }
  try {
    return JSON.parse(text) as RpcReply["message"];
  } catch {
    return undefined;
  }
}

function classifyHttpFailure(status: number, text: string): McpProbeError {
  let code: string | undefined;
  let detail = text.trim().slice(0, 200);
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string") code = body.error;
    if (typeof body.message === "string") detail = body.message.slice(0, 200);
  } catch {
    // keep the text snippet
  }
  const suffix = detail ? `: ${detail}` : "";
  if (status === 422 && code === "no_route_configured") {
    return new McpProbeError("not-configured", `passthrough has no mcp route${suffix}`, status, code);
  }
  if (status === 401 || status === 403) {
    return new McpProbeError("auth-error", `passthrough refused MCP (${status})${suffix}`, status, code);
  }
  if (status === 502 || status === 503 || status === 504) {
    return new McpProbeError("unreachable", `kernel unavailable via passthrough (${status})${suffix}`, status, code);
  }
  return new McpProbeError("route-error", `POST /mcp returned ${status}${suffix}`, status, code);
}

/**
 * Read-only reachability probe: `initialize` -> `notifications/initialized` ->
 * `tools/list` (paginated). Never sends credentials; `Mcp-Session-Id` is
 * echoed back as the transport requires. Never throws — failures are
 * reported in the returned shape.
 */
export async function probeKernelMcp(
  url: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<McpProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_PROBE_TIMEOUT_MS;
  let nextId = 1;
  let sessionId: string | undefined;

  const post = async (body: Record<string, unknown>, expectReply: boolean): Promise<RpcReply> => {
    const id = body.id as number | undefined;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new McpProbeError("unreachable", err instanceof Error ? err.message : String(err));
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw classifyHttpFailure(res.status, text);
    const newSession = res.headers.get("mcp-session-id") ?? undefined;
    if (!expectReply) return { status: res.status, sessionId: newSession };
    const message = parseRpcBody(text, res.headers.get("content-type") ?? "", id as number);
    if (!message) throw new McpProbeError("malformed", "POST /mcp returned no JSON-RPC reply", res.status);
    if (message.error) {
      throw new McpProbeError(
        "route-error",
        `MCP error ${message.error.code ?? ""}: ${message.error.message ?? "unknown"}`.slice(0, 240),
        res.status,
      );
    }
    return { status: res.status, sessionId: newSession, message };
  };

  try {
    const init = await post(
      {
        jsonrpc: "2.0",
        id: nextId++,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      },
      true,
    );
    sessionId = init.sessionId;
    const serverInfo = (init.message?.result as { serverInfo?: { name?: unknown } } | undefined)
      ?.serverInfo;
    const serverName = typeof serverInfo?.name === "string" ? serverInfo.name : undefined;
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, false).catch(() => undefined);

    const tools: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const reply = await post(
        {
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/list",
          ...(cursor ? { params: { cursor } } : {}),
        },
        true,
      );
      const result = reply.message?.result as { tools?: unknown; nextCursor?: unknown } | undefined;
      if (!Array.isArray(result?.tools)) {
        throw new McpProbeError("malformed", "tools/list result has no `tools` array", reply.status);
      }
      for (const tool of result.tools as Array<{ name?: unknown }>) {
        if (typeof tool?.name === "string") tools.push(tool.name);
      }
      if (typeof result.nextCursor !== "string" || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return {
      url,
      outcome: "ok",
      ok: true,
      toolCount: tools.length,
      tools,
      ...(serverName ? { serverName } : {}),
    };
  } catch (err) {
    const failure =
      err instanceof McpProbeError
        ? err
        : new McpProbeError("unreachable", err instanceof Error ? err.message : String(err));
    return {
      url,
      outcome: failure.outcome,
      ok: false,
      ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
      ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
      error: failure.message,
      toolCount: 0,
      tools: [],
    };
  }
}

// --- Status block ---

export interface McpStatusBlock {
  url: string;
  reachable: boolean;
  outcome: McpProbeOutcome;
  httpStatus?: number;
  errorCode?: string;
  error?: string;
  toolCount: number;
  googleToolCount: number;
  serverName?: string;
  registration: McpRegistrationReport | { registered: null; note: string };
  allowlist: McpAllowlistGuidance & {
    /** Gated tools the current `mcp.servers` toolFilter would expose (needs explicit enable). */
    gatedToolsExposed: string[];
  };
  /** Operator-facing nudges: not registered, headers present, write tools exposed. */
  warnings: string[];
  identityNote: string;
}

export const MCP_IDENTITY_NOTE =
  "Two agent identities today: MCP/proxy calls use the app-token lane (azp=<app>, sub=<principal>), " +
  "while chat/media/warp use this plugin's agent DID. Flagged for unification (out of scope for #50).";

export function buildMcpStatusBlock(params: {
  mcpUrl: string;
  probe: McpProbeResult;
  /** Live OpenClaw config (`api.runtime.config.current()`), when available. */
  config?: unknown;
}): McpStatusBlock {
  const { probe, mcpUrl } = params;
  const registration =
    params.config === undefined
      ? ({
          registered: null,
          note: "OpenClaw config not readable from the plugin; run `openclaw mcp show` to verify registration",
        } as const)
      : inspectMcpRegistration(params.config, mcpUrl);
  const guidance = buildMcpAllowlistGuidance(probe.tools);
  const filter = "toolFilter" in registration ? registration.toolFilter : undefined;
  const gatedToolsExposed =
    registration.registered === true
      ? guidance.gatedTools.filter((name) => toolPassesFilter(name, filter))
      : [];

  const warnings: string[] = [];
  if (registration.registered === false) {
    warnings.push(
      `no mcp.servers entry points at ${mcpUrl} — register it: ` +
        `openclaw mcp add ${IMAJIN_MCP_SERVER_NAME} --url ${mcpUrl} --transport streamable-http`,
    );
  }
  if (registration.registered === true) warnings.push(...registration.warnings);
  if (gatedToolsExposed.length > 0) {
    warnings.push(
      `send/write tools are exposed to the agent (${gatedToolsExposed.join(", ")}) — ` +
        "set the mcp.servers toolFilter to allowlist.suggestedToolFilter unless that is intended",
    );
  }
  if (!probe.ok) warnings.push(`MCP probe ${probe.outcome}: ${probe.error ?? "no detail"}`);

  return {
    url: mcpUrl,
    reachable: probe.ok,
    outcome: probe.outcome,
    ...(probe.httpStatus === undefined ? {} : { httpStatus: probe.httpStatus }),
    ...(probe.errorCode ? { errorCode: probe.errorCode } : {}),
    ...(probe.error ? { error: probe.error } : {}),
    toolCount: probe.toolCount,
    googleToolCount: probe.tools.filter((name) => name.startsWith("google_")).length,
    ...(probe.serverName ? { serverName: probe.serverName } : {}),
    registration,
    allowlist: { ...guidance, gatedToolsExposed },
    warnings,
    identityNote: MCP_IDENTITY_NOTE,
  };
}
