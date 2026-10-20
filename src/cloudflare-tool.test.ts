import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImajinClient } from "./client.js";
import { createCloudflareTool } from "./tools.js";

const NODE_URL = "https://kernel.example.test";
const ZONE_ID = "023e105f4ecef8ad9ca31a8372d0c353";
const RECORD_ID = "372e67954025e0ba6aaa6d586b9e0b59";
const HOSTNAME_ID = "0d89c70d-ad9f-4843-b99f-6cc0252bcd0c";
const DOMAIN = "example.com";
const ACTOR = "did:imajin:cloudflare-agent";
const OWNER = "did:imajin:zone-owner";
const BASE = { zoneId: ZONE_ID, domain: DOMAIN };
const NEXT = "A human must countersign on /jin (Operator approvals). Nothing has changed.";
const RAW_MARKER = "PRIVATE_PROVIDER_ERROR_FIXTURE_DO_NOT_DISCLOSE";
const RECORD = {
  type: "A",
  name: "www.example.com",
  content: "192.0.2.1",
  ttl: 1,
  proxied: false,
};
const CHANGES = [{ recordId: RECORD_ID, proxied: true }];
const RULES = [{
  ref: "static-assets",
  description: "Cache static assets",
  expression: '(http.host eq "www.example.com")',
  action: "set_cache_settings",
  action_parameters: { cache: true, edge_ttl: { mode: "override_origin", default: 3600 } },
  enabled: true,
}];
const SSL = { method: "txt", type: "dv" };
const ACTIONS = [
  "dns_list", "dns_create", "dns_update", "dns_delete", "proxy_set", "bulk_proxy",
  "settings", "ssl", "cache_rules_list", "cache_rules_replace", "hostnames_list",
  "hostname_create", "hostname_status", "hostname_delete", "history",
];

type Params = Record<string, unknown> & { action: string };
type RouteCase = {
  action: string;
  method: string;
  path: string;
  params?: Record<string, unknown>;
  body?: unknown;
  response: unknown;
  status?: number;
};

const ROUTES: RouteCase[] = [
  { action: "dns_list", method: "GET", path: "/dns", response: { records: [{ id: RECORD_ID, ...RECORD }] } },
  {
    action: "dns_create", method: "POST", path: "/dns", params: { record: RECORD },
    body: RECORD, response: { record: { id: RECORD_ID, ...RECORD } }, status: 201,
  },
  {
    action: "dns_update", method: "PATCH", path: `/dns/${RECORD_ID}`,
    params: { recordId: RECORD_ID, record: { content: "192.0.2.2", ttl: 300, proxied: false } },
    body: { content: "192.0.2.2", ttl: 300, proxied: false },
    response: { before: { id: RECORD_ID, ...RECORD }, after: { id: RECORD_ID, ...RECORD, content: "192.0.2.2" } },
  },
  {
    action: "dns_delete", method: "DELETE", path: `/dns/${RECORD_ID}`,
    params: { recordId: RECORD_ID }, response: { deleted: true, recordId: RECORD_ID },
  },
  {
    action: "proxy_set", method: "PATCH", path: `/dns/${RECORD_ID}`,
    params: { recordId: RECORD_ID, proxied: false }, body: { proxied: false },
    response: { before: { id: RECORD_ID, ...RECORD, proxied: true }, after: { id: RECORD_ID, ...RECORD } },
  },
  {
    action: "bulk_proxy", method: "POST", path: "/bulk", params: { changes: CHANGES },
    body: { domain: DOMAIN, changes: CHANGES, dryRun: true },
    response: { dryRun: true, before: [{ id: RECORD_ID, ...RECORD }], after: [{ id: RECORD_ID, ...RECORD, proxied: true }] },
  },
  { action: "settings", method: "GET", path: "/settings", response: { settings: [{ id: "ssl", value: "strict" }] } },
  { action: "ssl", method: "GET", path: "/ssl", response: { ssl: "strict", min_tls_version: "1.2" } },
  { action: "cache_rules_list", method: "GET", path: "/cache-rules", response: { rules: RULES } },
  {
    action: "cache_rules_replace", method: "PUT", path: "/cache-rules", params: { rules: RULES },
    body: { domain: DOMAIN, rules: RULES, dryRun: true },
    response: { dryRun: true, before: [], after: RULES },
  },
  { action: "hostnames_list", method: "GET", path: "/custom-hostnames", response: { hostnames: [{ id: HOSTNAME_ID, hostname: "customer.example.net" }] } },
  {
    action: "hostname_create", method: "POST", path: "/custom-hostnames",
    params: { hostname: "customer.example.net", ssl: SSL },
    body: { hostname: "customer.example.net", ssl: SSL },
    response: { hostname: { id: HOSTNAME_ID, hostname: "customer.example.net", ssl: { status: "pending_validation" } } },
    status: 201,
  },
  {
    action: "hostname_status", method: "GET", path: `/custom-hostnames/${HOSTNAME_ID}`,
    params: { hostnameId: HOSTNAME_ID }, response: { hostname: { id: HOSTNAME_ID, ssl: { status: "active" } } },
  },
  {
    action: "hostname_delete", method: "DELETE", path: `/custom-hostnames/${HOSTNAME_ID}`,
    params: { hostnameId: HOSTNAME_ID }, response: { deleted: true, hostnameId: HOSTNAME_ID },
  },
  { action: "history", method: "GET", path: "/history", response: { history: [] } },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Inspect schema property names, not prose descriptions or unrelated plugin tokens.
function propertyPaths(schema: unknown, path: string[] = []): string[] {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema)) return schema.flatMap((value) => propertyPaths(value, path));
  const object = schema as Record<string, unknown>;
  const paths: string[] = [];
  for (const [key, value] of Object.entries(object)) {
    if (key === "properties" && value && typeof value === "object") {
      for (const [name, child] of Object.entries(value)) {
        const next = [...path, name];
        paths.push(next.join("."));
        paths.push(...propertyPaths(child, next));
      }
    } else {
      paths.push(...propertyPaths(value, path));
    }
  }
  return paths;
}

describe("imajin_cloudflare — kernel-only contract", () => {
  let client: ImajinClient;
  let tool: ReturnType<typeof createCloudflareTool>;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    client = new ImajinClient({ nodeUrl: NODE_URL, did: ACTOR });
    tool = createCloudflareTool(client);
    // Every test starts with a network-blocking stub, including validation tests.
    fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected mocked fetch"));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function execute(params: Params) {
    return tool.execute("cloudflare-contract-test", params as never);
  }

  function request() {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    const url = new URL(input instanceof Request ? input.url : String(input));
    return { url, init: init ?? {}, headers: new Headers(init?.headers) };
  }

  function assertKernelOnly() {
    for (const [input] of fetchMock.mock.calls) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe(NODE_URL);
      expect(url.pathname).toMatch(new RegExp(`^/cloudflare/api/zones/${ZONE_ID}/`));
      expect(url.searchParams.get("domain")).toBe(DOMAIN);
      expect(url.hostname).not.toBe("api.cloudflare.com");
      expect(url.pathname).not.toMatch(/approval|proposal|decision|vault|seal/);
    }
  }

  it("advertises exactly the agreed action and parameter surface", () => {
    expect(tool.name).toBe("imajin_cloudflare");
    expect([...tool.parameters.properties!.action.enum!].sort()).toEqual([...ACTIONS].sort());
    expect(Object.keys(tool.parameters.properties!).sort()).toEqual([
      "action", "zoneId", "domain", "onBehalfOf", "recordId", "record", "proxied",
      "changes", "rules", "dryRun", "hostnameId", "hostname", "ssl",
    ].sort());
    expect(tool.parameters.required).toEqual(expect.arrayContaining(["action", "zoneId", "domain"]));
  });

  it.each(ROUTES)("$action uses $method $path and preserves the kernel response", async (route) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(route.response, route.status));
    const result = await execute({ ...BASE, action: route.action, ...route.params });
    expect(result.content).toEqual([{ type: "text", text: expect.any(String) }]);
    expect(result.details?.error).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual(route.response);
    const { url, init, headers } = request();
    expect(url.pathname).toBe(`/cloudflare/api/zones/${ZONE_ID}${route.path}`);
    expect([...url.searchParams.entries()]).toEqual([["domain", DOMAIN]]);
    expect(init.method ?? "GET").toBe(route.method);
    expect(init.body == null ? undefined : JSON.parse(String(init.body))).toEqual(route.body);
    expect(headers.get("X-Agent-DID")).toBe(ACTOR);
    expect(headers.has("X-Acting-For")).toBe(false);
    if (route.body !== undefined) expect(headers.get("Content-Type")).toMatch(/application\/json/);
    assertKernelOnly();
  });

  it.each(["bulk_proxy", "cache_rules_replace"])("%s honors an explicit dryRun=true without staging", async (action) => {
    const fields = action === "bulk_proxy" ? { changes: CHANGES } : { rules: RULES };
    const preview = { dryRun: true, before: [], after: [], applied: false };
    fetchMock.mockResolvedValueOnce(jsonResponse(preview));
    expect(JSON.parse((await execute({ ...BASE, action, ...fields, dryRun: true })).content[0].text)).toEqual(preview);
    expect(JSON.parse(String(request().init.body))).toEqual({ domain: DOMAIN, ...fields, dryRun: true });
    assertKernelOnly();
  });

  it.each(["bulk_proxy", "cache_rules_replace"])("%s stages once and never follows a proposal or approval-decision route", async (action) => {
    const fields = action === "bulk_proxy" ? { changes: CHANGES } : { rules: RULES };
    fetchMock.mockResolvedValueOnce(jsonResponse({
      approval: { proposalId: "proposal_cloudflare_98" },
    }, 202));
    const result = await execute({ ...BASE, action, ...fields, dryRun: false });
    expect(JSON.parse(result.content[0].text)).toEqual({
      status: "pending_approval", proposalId: "proposal_cloudflare_98", next: NEXT,
    });
    expect(result.details?.error).not.toBe(true);
    expect(JSON.parse(String(request().init.body))).toEqual({ domain: DOMAIN, ...fields, dryRun: false });
    // Flush queued work too: returning a proposal must not schedule an automatic approval.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    assertKernelOnly();
  });

  it.each(ROUTES.flatMap((route) => [
    { ...route, onBehalfOf: undefined, expected: OWNER },
    { ...route, onBehalfOf: "did:imajin:explicit-owner", expected: "did:imajin:explicit-owner" },
    { ...route, onBehalfOf: "self", expected: null },
  ]))("$action delegates with $onBehalfOf while authenticating the actual actor", async ({ action, params, response, status, onBehalfOf, expected }) => {
    tool = createCloudflareTool(new ImajinClient({ nodeUrl: NODE_URL, did: ACTOR, actAs: OWNER }));
    fetchMock.mockResolvedValueOnce(jsonResponse(response, status));
    const result = await execute({ ...BASE, action, ...params, ...(onBehalfOf === undefined ? {} : { onBehalfOf }) });
    expect(result.details?.error).not.toBe(true);
    const { headers, url } = request();
    expect(headers.get("X-Agent-DID")).toBe(ACTOR);
    expect(headers.get("X-Acting-For")).toBe(expected);
    expect(headers.has("X-Acting-As")).toBe(false);
    expect(url.searchParams.has("actorDid")).toBe(false);
    expect(url.searchParams.has("onBehalfOf")).toBe(false);
    assertKernelOnly();
  });

  it("preserves signed history, distinct actor/owner, before/after, and unknown outcomes without claiming verification", async () => {
    const history = {
      history: ["intent", "outcome"].map((phase, index) => ({
        id: `att_cloudflare_${index}`,
        type: "cloudflare.dns.updated",
        actor: ACTOR,
        issuerDid: "did:imajin:kernel",
        issuedAt: "2026-10-20T20:00:00.000Z",
        signature: "ab".repeat(64),
        payload: {
          actorDid: ACTOR, onBehalfOf: OWNER, zoneId: ZONE_ID,
          operation: "dns_update", phase,
          before: { id: RECORD_ID, ...RECORD },
          after: { id: RECORD_ID, ...RECORD, content: "192.0.2.2" },
          ...(phase === "outcome" ? { outcome: "unknown" } : {}),
        },
      })),
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(history));
    const result = await execute({ ...BASE, action: "history", onBehalfOf: OWNER });
    expect(JSON.parse(result.content[0].text)).toEqual(history);
    expect(request().headers.get("X-Agent-DID")).toBe(ACTOR);
    expect(request().headers.get("X-Acting-For")).toBe(OWNER);
    assertKernelOnly();
  });

  it.each([
    { status: 403, code: "forbidden", text: "no Cloudflare authority for this zone — grant it on /jin" },
    { status: 409, code: "credential_unavailable", text: "token not sealed for this zone — seal it on /jin" },
    { status: 409, code: "stale_before_state" },
    { status: 409, code: "approval_replayed" },
    { status: 400, code: "invalid_request" },
    { status: 503, code: "cloudflare_unavailable" },
  ])("redacts $status/$code, retains status/code, and never retries", async ({ status, code, text }) => {
    const spies = ["log", "warn", "error", "info", "debug"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => {}),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: code, message: RAW_MARKER,
      provider: { errors: [{ message: RAW_MARKER }] },
      token: RAW_MARKER,
    }, status));
    const result = await execute({ ...BASE, action: "dns_create", record: RECORD });
    expect(result.details).toMatchObject({ error: true, status, code });
    if (text) expect(result.content[0].text).toContain(text);
    if (status === 409 && code !== "credential_unavailable") {
      expect(result.content[0].text).not.toMatch(/token not sealed|seal it on \/jin/);
    }
    expect(JSON.stringify(result)).not.toContain(RAW_MARKER);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(RAW_MARKER);
    request();
    assertKernelOnly();
  });

  it("does not leak a non-JSON 503 body or retry a potentially applied mutation", async () => {
    fetchMock.mockResolvedValueOnce(new Response(`<html>${RAW_MARKER}</html>`, {
      status: 503, headers: { "Content-Type": "text/html" },
    }));
    const result = await execute({ ...BASE, action: "dns_update", recordId: RECORD_ID, record: { proxied: true } });
    expect(result.details).toMatchObject({ error: true, status: 503 });
    expect(JSON.stringify(result)).not.toContain(RAW_MARKER);
    expect(result.content[0].text).not.toMatch(/nothing (has )?changed|not applied/i);
    request();
    assertKernelOnly();
  });

  it.each(["approve", "zones", "seal", "approval_decision", "settings_update"])("refuses unsupported %s with no network call", async (action) => {
    const result = await execute({ ...BASE, action });
    expect(result.details?.error).toBe(true);
    expect(result.content[0].text).toMatch(/unknown|unsupported|invalid/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const INVALID: Array<{ name: string; params: Params }> = [
    ...["", "a".repeat(31), "a".repeat(33), "A".repeat(32), "g".repeat(32), "../zones"].map((zoneId) => ({
      name: `invalid zoneId ${JSON.stringify(zoneId)}`, params: { ...BASE, action: "dns_list", zoneId },
    })),
    { name: "missing zoneId", params: { action: "dns_list", domain: DOMAIN } },
    { name: "missing domain", params: { action: "dns_list", zoneId: ZONE_ID } },
    ...["", "Example.com", " example.com", "example.com.", "https://example.com", "example.com/path"].map((domain) => ({
      name: `noncanonical domain ${JSON.stringify(domain)}`, params: { ...BASE, action: "dns_list", domain },
    })),
    { name: "missing create record", params: { ...BASE, action: "dns_create" } },
    { name: "empty create record", params: { ...BASE, action: "dns_create", record: {} } },
    { name: "missing create content", params: { ...BASE, action: "dns_create", record: { type: "A", name: "www.example.com" } } },
    { name: "missing update record", params: { ...BASE, action: "dns_update", recordId: RECORD_ID } },
    { name: "empty update record", params: { ...BASE, action: "dns_update", recordId: RECORD_ID, record: {} } },
    ...["dns_update", "dns_delete", "proxy_set"].map((action) => ({
      name: `${action} missing recordId`, params: { ...BASE, action, record: { proxied: true }, proxied: true },
    })),
    ...["A".repeat(32), HOSTNAME_ID, "../dns"].map((recordId) => ({
      name: `invalid recordId ${recordId}`, params: { ...BASE, action: "dns_delete", recordId },
    })),
    { name: "missing proxied", params: { ...BASE, action: "proxy_set", recordId: RECORD_ID } },
    { name: "string proxied", params: { ...BASE, action: "proxy_set", recordId: RECORD_ID, proxied: "false" } },
    { name: "missing bulk changes", params: { ...BASE, action: "bulk_proxy" } },
    { name: "empty bulk changes", params: { ...BASE, action: "bulk_proxy", changes: [] } },
    { name: "too many bulk changes", params: { ...BASE, action: "bulk_proxy", changes: Array.from({ length: 21 }, () => CHANGES[0]) } },
    { name: "bulk missing proxied", params: { ...BASE, action: "bulk_proxy", changes: [{ recordId: RECORD_ID }] } },
    { name: "bulk invalid recordId", params: { ...BASE, action: "bulk_proxy", changes: [{ recordId: "invalid", proxied: true }] } },
    { name: "bulk nonboolean dryRun", params: { ...BASE, action: "bulk_proxy", changes: CHANGES, dryRun: "false" } },
    { name: "missing cache rules", params: { ...BASE, action: "cache_rules_replace" } },
    { name: "too many cache rules", params: { ...BASE, action: "cache_rules_replace", rules: Array.from({ length: 21 }, () => RULES[0]) } },
    { name: "invalid cache action", params: { ...BASE, action: "cache_rules_replace", rules: [{ ...RULES[0], action: "execute" }] } },
    { name: "cache nonboolean dryRun", params: { ...BASE, action: "cache_rules_replace", rules: RULES, dryRun: 0 } },
    { name: "missing hostname", params: { ...BASE, action: "hostname_create", ssl: SSL } },
    { name: "missing hostname SSL", params: { ...BASE, action: "hostname_create", hostname: "customer.example.net" } },
    { name: "invalid SSL method", params: { ...BASE, action: "hostname_create", hostname: "customer.example.net", ssl: { method: "email", type: "dv" } } },
    { name: "invalid SSL type", params: { ...BASE, action: "hostname_create", hostname: "customer.example.net", ssl: { method: "txt", type: "ov" } } },
    ...["hostname_status", "hostname_delete"].flatMap((action) => [
      { name: `${action} missing hostnameId`, params: { ...BASE, action } },
      { name: `${action} non-UUID hostnameId`, params: { ...BASE, action, hostnameId: RECORD_ID } },
    ]),
    { name: "invalid onBehalfOf", params: { ...BASE, action: "dns_list", onBehalfOf: "not-a-did" } },
  ];

  it.each(INVALID)("rejects $name before fetch", async ({ params }) => {
    const result = await execute(params);
    expect(result.details?.error).toBe(true);
    expect(result.content[0].text).toMatch(/error|invalid|required|requires/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires exact zone and domain binding on every action, not only reads", async () => {
    for (const route of ROUTES) {
      const result = await execute({ ...BASE, action: route.action, ...route.params, domain: "" });
      expect(result.details?.error).toBe(true);
      const invalidZone = await execute({ ...BASE, action: route.action, ...route.params, zoneId: "invalid" });
      expect(invalidZone.details?.error).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows empty cache replacement, HTTP DV validation and a partial DNS update", async () => {
    const cases = [
      { action: "cache_rules_replace", rules: [] },
      { action: "hostname_create", hostname: "customer.example.net", ssl: { method: "http", type: "dv" } },
      { action: "dns_update", recordId: RECORD_ID, record: { proxied: false } },
    ];
    for (const params of cases) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      expect((await execute({ ...BASE, ...params })).details?.error).not.toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    assertKernelOnly();
  });

  it("offers no Cloudflare credential field in tool or config JSON schemas", () => {
    const toolPaths = propertyPaths(tool.parameters);
    expect(toolPaths.filter((path) => /token|secret|credential|api.?key/i.test(path))).toEqual([]);
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const configPaths = propertyPaths(manifest.configSchema);
    // Existing unrelated gateway/hook tokens are intentionally not prohibited.
    expect(configPaths.filter((path) => /cloudflare/i.test(path) && /token|secret|credential|api.?key/i.test(path))).toEqual([]);
    expect(configPaths.filter((path) => /(^|\.)cf[_-]?(api[_-]?)?(token|key|secret)/i.test(path))).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
