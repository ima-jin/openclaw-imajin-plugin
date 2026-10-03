import { describe, expect, it, vi } from "vitest";
import {
  buildMcpAllowlistGuidance,
  buildMcpStatusBlock,
  classifyGoogleMcpTool,
  inspectMcpRegistration,
  probeKernelMcp,
  resolveImajinMcpUrl,
  toolPassesFilter,
} from "./kernel-mcp.js";

const URL_ = "http://127.0.0.1:8787/mcp";

const KERNEL_GOOGLE_TOOLS = [
  "google_gmail_list_threads",
  "google_gmail_get_message",
  "google_gmail_send",
  "google_gmail_watch",
  "google_calendar_list_events",
  "google_calendar_free_busy",
  "google_calendar_create_event",
  "google_drive_list_files",
  "google_drive_get_file",
  "google_drive_get_file_content",
  "google_drive_list_changes",
  "google_meet_list_conference_records",
  "google_meet_list_transcripts",
];

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function sse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });
}

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function fakeKernel(
  tools: string[],
  opts: { sse?: boolean; sessionId?: string; pageSize?: number } = {},
) {
  const calls: Call[] = [];
  const reply = opts.sse ? sse : json;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), init: init ?? {}, body });
    if (body.method === "initialize") {
      return reply(
        { jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "imajin-kernel" } } },
        opts.sessionId ? { headers: { "content-type": opts.sse ? "text/event-stream" : "application/json", "Mcp-Session-Id": opts.sessionId } } : {},
      );
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const cursor = (body.params as { cursor?: string } | undefined)?.cursor;
    const start = cursor ? Number(cursor) : 0;
    const size = opts.pageSize ?? tools.length;
    const page = tools.slice(start, start + size);
    const next = start + size < tools.length ? String(start + size) : undefined;
    return reply({
      jsonrpc: "2.0",
      id: body.id,
      result: { tools: page.map((name) => ({ name })), ...(next ? { nextCursor: next } : {}) },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("resolveImajinMcpUrl", () => {
  it("derives from the proxy root", () => {
    expect(resolveImajinMcpUrl(undefined, "http://127.0.0.1:8787/openai/v1")).toBe(URL_);
    expect(resolveImajinMcpUrl({}, "http://127.0.0.1:9000/openai/v1/")).toBe(
      "http://127.0.0.1:9000/mcp",
    );
  });
  it("honours an explicit override", () => {
    expect(resolveImajinMcpUrl({ mcpUrl: " http://127.0.0.1:1/mcp/ " }, "http://x/openai/v1")).toBe(
      "http://127.0.0.1:1/mcp",
    );
  });
});

describe("classifyGoogleMcpTool", () => {
  it("keeps read verbs on and gates send/write/side-effect tools", () => {
    const gated = KERNEL_GOOGLE_TOOLS.filter((n) => classifyGoogleMcpTool(n) === "gated");
    expect(gated).toEqual([
      "google_gmail_send",
      "google_gmail_watch",
      "google_calendar_create_event",
    ]);
  });
  it("is default-deny for unrecognised google verbs and ignores non-google tools", () => {
    expect(classifyGoogleMcpTool("google_gmail_frobnicate")).toBe("gated");
    expect(classifyGoogleMcpTool("google_gmail_get_and_delete")).toBe("gated");
    expect(classifyGoogleMcpTool("google_gmail")).toBe("gated");
    expect(classifyGoogleMcpTool("media_list")).toBeUndefined();
  });
});

describe("buildMcpAllowlistGuidance", () => {
  it("suggests an include list without the gated tools", () => {
    const g = buildMcpAllowlistGuidance([...KERNEL_GOOGLE_TOOLS, "media_list"]);
    expect(g.gatedTools).toContain("google_gmail_send");
    expect(g.suggestedToolFilter.include).toContain("google_gmail_get_message");
    expect(g.suggestedToolFilter.include).toContain("media_list");
    expect(g.suggestedToolFilter.include).not.toContain("google_gmail_send");
    expect(g.googleReadTools).toHaveLength(KERNEL_GOOGLE_TOOLS.length - 3);
  });
});

describe("toolPassesFilter", () => {
  it("applies include/exclude with * globs", () => {
    expect(toolPassesFilter("a", undefined)).toBe(true);
    expect(toolPassesFilter("google_gmail_send", { include: ["google_gmail_*"] })).toBe(true);
    expect(toolPassesFilter("google_drive_get_file", { include: ["google_gmail_*"] })).toBe(false);
    expect(
      toolPassesFilter("google_gmail_send", { include: ["google_*"], exclude: ["*_send"] }),
    ).toBe(false);
    expect(toolPassesFilter("a.b", { include: ["a.b"] })).toBe(true);
    expect(toolPassesFilter("axb", { include: ["a.b"] })).toBe(false);
  });
});

describe("inspectMcpRegistration", () => {
  it("reports not registered when absent", () => {
    expect(inspectMcpRegistration(undefined, URL_)).toEqual({ registered: false, warnings: [] });
    expect(inspectMcpRegistration({ mcp: { servers: {} } }, URL_).registered).toBe(false);
  });
  it("finds the entry by URL and reads the toolFilter", () => {
    const report = inspectMcpRegistration(
      {
        mcp: {
          servers: {
            other: { url: "https://example.com/mcp" },
            imajin: {
              url: `${URL_}/`,
              transport: "streamable-http",
              toolFilter: { include: ["google_gmail_*"], exclude: ["x"] },
            },
          },
        },
      },
      URL_,
    );
    expect(report).toMatchObject({
      registered: true,
      name: "imajin",
      enabled: true,
      hasHeaders: false,
      warnings: [],
      toolFilter: { include: ["google_gmail_*"], exclude: ["x"] },
    });
  });
  it("flags headers without ever surfacing their values", () => {
    const report = inspectMcpRegistration(
      { mcp: { servers: { imajin: { url: URL_, headers: { Authorization: "Bearer s3cret-value" } } } } },
      URL_,
    );
    expect(report.hasHeaders).toBe(true);
    expect(report.warnings.join(" ")).toMatch(/remove them/);
    expect(JSON.stringify(report)).not.toContain("s3cret-value");
  });
  it("flags a non-streamable-http transport and respects enabled:false", () => {
    const report = inspectMcpRegistration(
      { mcp: { servers: { imajin: { url: URL_, transport: "sse", enabled: false } } } },
      URL_,
    );
    expect(report.enabled).toBe(false);
    expect(report.warnings.join(" ")).toMatch(/streamable-http/);
  });
});

describe("probeKernelMcp", () => {
  it("initializes, lists tools, and never sends credentials", async () => {
    const { fetchImpl, calls } = fakeKernel(KERNEL_GOOGLE_TOOLS);
    const result = await probeKernelMcp(URL_, { fetchImpl });
    expect(result).toMatchObject({
      ok: true,
      outcome: "ok",
      toolCount: KERNEL_GOOGLE_TOOLS.length,
      serverName: "imajin-kernel",
    });
    expect(calls.map((c) => c.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    for (const call of calls) {
      expect(call.url).toBe(URL_);
      const headers = Object.keys(call.init.headers as Record<string, string>).map((h) =>
        h.toLowerCase(),
      );
      expect(headers).not.toContain("authorization");
      expect(headers).not.toContain("x-imajin-app-did");
    }
  });

  it("echoes Mcp-Session-Id after initialize", async () => {
    const { fetchImpl, calls } = fakeKernel(["a"], { sessionId: "sess-1" });
    await probeKernelMcp(URL_, { fetchImpl });
    const first = calls[0].init.headers as Record<string, string>;
    expect(first["Mcp-Session-Id"]).toBeUndefined();
    for (const call of calls.slice(1)) {
      expect((call.init.headers as Record<string, string>)["Mcp-Session-Id"]).toBe("sess-1");
    }
  });

  it("reads SSE replies", async () => {
    const { fetchImpl } = fakeKernel(["google_gmail_get_message"], { sse: true });
    const result = await probeKernelMcp(URL_, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual(["google_gmail_get_message"]);
  });

  it("follows tools/list pagination", async () => {
    const { fetchImpl, calls } = fakeKernel(["a", "b", "c", "d", "e"], { pageSize: 2 });
    const result = await probeKernelMcp(URL_, { fetchImpl });
    expect(result.tools).toEqual(["a", "b", "c", "d", "e"]);
    expect(calls.filter((c) => c.body.method === "tools/list")).toHaveLength(3);
  });

  it("reports unreachable when fetch rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const result = await probeKernelMcp(URL_, { fetchImpl });
    expect(result).toMatchObject({ ok: false, outcome: "unreachable", toolCount: 0 });
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it("maps the proxy's typed errors", async () => {
    const respond = (status: number, error: string, message = "m") =>
      (vi.fn(async () => json({ error, message }, { status })) as unknown) as typeof fetch;

    expect(
      await probeKernelMcp(URL_, { fetchImpl: respond(422, "no_route_configured") }),
    ).toMatchObject({ outcome: "not-configured", httpStatus: 422, errorCode: "no_route_configured" });
    expect(
      await probeKernelMcp(URL_, { fetchImpl: respond(403, "insufficient_scope") }),
    ).toMatchObject({ outcome: "auth-error", httpStatus: 403, errorCode: "insufficient_scope" });
    expect(
      await probeKernelMcp(URL_, { fetchImpl: respond(502, "kernel_unavailable") }),
    ).toMatchObject({ outcome: "unreachable", httpStatus: 502 });
    expect(await probeKernelMcp(URL_, { fetchImpl: respond(500, "boom") })).toMatchObject({
      outcome: "route-error",
      httpStatus: 500,
    });
  });

  it("reports malformed bodies and JSON-RPC errors", async () => {
    const notJson = (vi.fn(async () => new Response("<html>", { status: 200 })) as unknown) as typeof fetch;
    expect((await probeKernelMcp(URL_, { fetchImpl: notJson })).outcome).toBe("malformed");

    const rpcError = (vi.fn(async () =>
      json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope" } }),
    ) as unknown) as typeof fetch;
    expect(await probeKernelMcp(URL_, { fetchImpl: rpcError })).toMatchObject({
      outcome: "route-error",
    });

    const noTools = (vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return json({ jsonrpc: "2.0", id: body.id, result: {} });
    }) as unknown) as typeof fetch;
    expect((await probeKernelMcp(URL_, { fetchImpl: noTools })).outcome).toBe("malformed");
  });
});

describe("buildMcpStatusBlock", () => {
  const okProbe = {
    url: URL_,
    outcome: "ok" as const,
    ok: true,
    toolCount: KERNEL_GOOGLE_TOOLS.length,
    tools: KERNEL_GOOGLE_TOOLS,
  };

  it("reports reachability, tool count and google tool count", () => {
    const block = buildMcpStatusBlock({
      mcpUrl: URL_,
      probe: okProbe,
      config: {
        mcp: { servers: { imajin: { url: URL_, transport: "streamable-http" } } },
      },
    });
    expect(block).toMatchObject({
      reachable: true,
      toolCount: KERNEL_GOOGLE_TOOLS.length,
      googleToolCount: KERNEL_GOOGLE_TOOLS.length,
    });
    expect(block.identityNote).toMatch(/two agent identities/i);
  });

  it("warns that send/write tools are exposed when no filter is set", () => {
    const block = buildMcpStatusBlock({
      mcpUrl: URL_,
      probe: okProbe,
      config: { mcp: { servers: { imajin: { url: URL_ } } } },
    });
    expect(block.allowlist.gatedToolsExposed).toEqual([
      "google_gmail_send",
      "google_gmail_watch",
      "google_calendar_create_event",
    ]);
    expect(block.warnings.join(" ")).toMatch(/send\/write tools are exposed/);
  });

  it("is quiet about write tools once the operator allowlists reads only", () => {
    const guidance = buildMcpAllowlistGuidance(KERNEL_GOOGLE_TOOLS);
    const block = buildMcpStatusBlock({
      mcpUrl: URL_,
      probe: okProbe,
      config: { mcp: { servers: { imajin: { url: URL_, toolFilter: guidance.suggestedToolFilter } } } },
    });
    expect(block.allowlist.gatedToolsExposed).toEqual([]);
    expect(block.warnings).toEqual([]);
  });

  it("explains how to register when no entry exists, and when config is unreadable", () => {
    const missing = buildMcpStatusBlock({ mcpUrl: URL_, probe: okProbe, config: {} });
    expect(missing.registration.registered).toBe(false);
    expect(missing.warnings.join(" ")).toContain(
      `openclaw mcp add imajin --url ${URL_} --transport streamable-http`,
    );
    const unknown = buildMcpStatusBlock({ mcpUrl: URL_, probe: okProbe });
    expect(unknown.registration.registered).toBeNull();
    expect(unknown.allowlist.gatedToolsExposed).toEqual([]);
  });

  it("carries probe failures through", () => {
    const block = buildMcpStatusBlock({
      mcpUrl: URL_,
      probe: {
        url: URL_,
        outcome: "not-configured",
        ok: false,
        httpStatus: 422,
        errorCode: "no_route_configured",
        error: "passthrough has no mcp route",
        toolCount: 0,
        tools: [],
      },
      config: {},
    });
    expect(block).toMatchObject({ reachable: false, outcome: "not-configured", toolCount: 0 });
    expect(block.warnings.join(" ")).toMatch(/not-configured/);
  });
});
