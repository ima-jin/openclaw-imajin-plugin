import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImajinClient } from "./client.js";
import { createCloudflareTool } from "./tools.js";

vi.mock("node:fs/promises", async (original) => ({
  ...await original<object>(),
  // Synthetic signing fixture only; no credential is read from disk.
  readFile: vi.fn(async () => JSON.stringify({
    did: "did:imajin:fixture-agent",
    privateKey: "11".repeat(32),
  })),
}));

const BASE = { zoneId: "a".repeat(32), domain: "example.com" };
const RECORD_ID = "b".repeat(32);
const HOSTNAME_ID = "0d89c70d-ad9f-4843-b99f-6cc0252bcd0c";
const RULE = {
  expression: "true", action: "set_cache_settings", enabled: true,
  action_parameters: { cache: true },
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

describe("imajin_cloudflare runtime safeguards", () => {
  let client: ImajinClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    client = new ImajinClient({ nodeUrl: "https://kernel.example.test", did: "did:imajin:fixture-agent" });
    fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected network request"));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const INVALID = [
    { action: "dns_create", record: null },
    { action: "dns_create", record: [] },
    { action: "dns_update", recordId: RECORD_ID, record: { ttl: 0 } },
    { action: "dns_update", recordId: RECORD_ID, record: { ttl: 1.5 } },
    { action: "dns_list", domain: "a".repeat(254) },
    { action: "dns_list", token: "not-a-credential" },
    { action: "dns_update", recordId: RECORD_ID, record: { token: "not-a-credential" } },
    { action: "dns_update", recordId: RECORD_ID, record: JSON.parse('{"constructor":1}') },
    { action: "dns_update", recordId: RECORD_ID, record: JSON.parse('{"__proto__":1}') },
    { action: "dns_update", recordId: RECORD_ID, record: { toString: 1 } },
    { action: "bulk_proxy", changes: {} },
    { action: "bulk_proxy", changes: [{ recordId: RECORD_ID, proxied: true, token: "not-a-credential" }] },
    { action: "cache_rules_replace", rules: [null] },
    { action: "cache_rules_replace", rules: [{ ...RULE, enabled: "true" }] },
    { action: "cache_rules_replace", rules: [{ ...RULE, expression: "" }] },
    { action: "cache_rules_replace", rules: [{ ...RULE, ref: "x".repeat(65) }] },
    { action: "cache_rules_replace", rules: [{ ...RULE, action_parameters: null }] },
    { action: "cache_rules_replace", rules: [{ ...RULE, action_parameters: { edge_ttl: {} } }] },
    { action: "cache_rules_replace", rules: [{ ...RULE, action_parameters: { token: "not-a-credential" } }] },
    { action: "hostname_create", hostname: "customer.example.net", ssl: null },
    { action: "hostname_create", hostname: "customer.example.net", ssl: { type: "dv" } },
    { action: "dns_create", record: { type: "A", name: "www.example.com", content: "192.0.2.1", ttl: 1 }, dryRun: true },
    { action: "dns_delete", recordId: RECORD_ID, dryRun: true },
    { action: "proxy_set", recordId: RECORD_ID, proxied: true, dryRun: false },
    { action: "hostname_delete", hostnameId: HOSTNAME_ID, dryRun: true },
  ];

  it.each(INVALID)("rejects malformed or unsupported input before any request: %j", async (params) => {
    const result = await createCloudflareTool(client).execute("invalid", { ...BASE, ...params } as never);
    expect(result.details).toMatchObject({ error: true, status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["capability_required", "zone_audience_required", "zone_not_verified"])(
    "maps the actual kernel 403 code %s without retry", async (code) => {
      fetchMock.mockResolvedValueOnce(json({ error: code }, 403));
      const result = await createCloudflareTool(client).execute("forbidden", { ...BASE, action: "dns_list" });
      expect(result.content[0].text).toContain("no Cloudflare authority for this zone — grant it on /jin");
      expect(result.details).toMatchObject({ status: 403, code });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["not-json", "null", "[]", "42"])("rejects malformed envelopes without echoing %s", async (body) => {
    fetchMock.mockResolvedValueOnce(new Response(body));
    const result = await createCloudflareTool(client).execute("envelope", { ...BASE, action: "history" });
    expect(result.details).toMatchObject({ error: true, code: "invalid_response" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { approval: null }, { approval: {} }, { approval: { proposalId: 1 } }, { approval: { proposalId: "" } }])(
    "never claims application or follows up a malformed 202: %j", async (body) => {
      fetchMock.mockResolvedValueOnce(json(body, 202));
      const result = await createCloudflareTool(client).execute("proposal", {
        ...BASE, action: "cache_rules_replace", rules: [], dryRun: false,
      });
      expect(result.details).toMatchObject({ error: true, code: "invalid_proposal_response" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry an uncertain mutation or echo a network exception", async () => {
    fetchMock.mockRejectedValueOnce(new Error("private transport detail"));
    const result = await createCloudflareTool(client).execute("network", {
      ...BASE, action: "proxy_set", recordId: RECORD_ID, proxied: true,
    });
    expect(result.details?.error).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private transport detail");
    expect(result.content[0].text).not.toContain("Nothing has changed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not let an irrelevant hostnameId change a DNS list path", async () => {
    fetchMock.mockResolvedValueOnce(json({ records: [] }));
    await createCloudflareTool(client).execute("suffix", { ...BASE, action: "dns_list", hostnameId: HOSTNAME_ID });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://kernel.example.test/cloudflare/api/zones/${BASE.zoneId}/dns?domain=example.com`,
    );
  });

  it("authenticates the plugin agent session and keeps delegation separate from the session cookie", async () => {
    const authenticated = new ImajinClient({
      nodeUrl: "https://kernel.example.test", keypairPath: "/synthetic/fixture.json", actAs: "did:imajin:owner",
    });
    fetchMock
      .mockResolvedValueOnce(json({ challengeId: "fixture", challenge: "abcd", expiresAt: "2099-01-01T00:00:00Z" }))
      .mockResolvedValueOnce(new Response("{}", { headers: { "set-cookie": "imajin_session=fixture-session; HttpOnly" } }))
      .mockResolvedValueOnce(json({ records: [] }));
    const result = await createCloudflareTool(authenticated).execute("session", { ...BASE, action: "dns_list" });
    expect(result.details?.error).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [challengeUrl, challengeInit] = fetchMock.mock.calls[0];
    expect(String(challengeUrl)).toBe("https://kernel.example.test/auth/api/login/challenge");
    expect(JSON.parse(String(challengeInit?.body))).toEqual({ did: "did:imajin:fixture-agent" });
    const [, verifyInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(String(verifyInit?.body))).toMatchObject({ challengeId: "fixture", signature: expect.any(String) });
    const headers = new Headers(fetchMock.mock.calls[2][1]?.headers);
    expect(headers.get("Cookie")).toBe("imajin_session=fixture-session");
    expect(headers.get("X-Agent-DID")).toBe("did:imajin:fixture-agent");
    expect(headers.get("X-Acting-For")).toBe("did:imajin:owner");
  });

  it("rejects invalid delegation before attempting session authentication", async () => {
    const authenticated = new ImajinClient({ nodeUrl: "https://kernel.example.test", keypairPath: "/synthetic/fixture.json" });
    const result = await createCloudflareTool(authenticated).execute("bad-did", {
      ...BASE, action: "dns_list", onBehalfOf: "not-a-did",
    });
    expect(result.details).toMatchObject({ error: true, status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("declares the tool and has no Cloudflare credential, environment, or provider dependency", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(manifest.contracts.tools).toContain("imajin_cloudflare");
    const source = readFileSync(new URL("./cloudflare-tool.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/process\.env|api\.cloudflare\.com|vault\//);
  });
});
