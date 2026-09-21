import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ImajinClient } from "./client.js";
import { createVaultTool } from "./tools.js";
import { _resetSecretHandleStoreForTests, withSecretEnv } from "./vault/secret-handle-store.js";

const KNOWN_SECRET = "ghp_super-secret-runner-registration-token-do-not-leak";

function mockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(response),
    json: async () => response,
  } as unknown as Response);
}

describe("imajin_vault tool — grep-proof value safety", () => {
  let client: ImajinClient;
  let tool: ReturnType<typeof createVaultTool>;
  let consoleSpies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    _resetSecretHandleStoreForTests();
    client = new ImajinClient({
      nodeUrl: "https://test.imajin.ai",
      did: "did:imajin:agent",
    });
    tool = createVaultTool(client);
    consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
    vi.restoreAllMocks();
  });

  function assertNoLeak(result: unknown) {
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(KNOWN_SECRET);
    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(KNOWN_SECRET);
      }
    }
  }

  it("list_grants returns metadata only, never a value field", async () => {
    global.fetch = mockFetch({
      grants: [
        {
          grantId: "g1",
          ownerDid: "did:imajin:owner",
          purpose: "gha-runner-registration",
          expiresAt: "2026-01-01T00:00:00Z",
          oneTime: true,
          consumedAt: null,
          createdAt: "2025-12-31T00:00:00Z",
        },
      ],
    });
    const result = await tool.execute("1", { action: "list_grants" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.grants).toHaveLength(1);
    expect(parsed.grants[0]).not.toHaveProperty("value");
    assertNoLeak(result);
  });

  it("fetch returns ONLY a handle + metadata — the JSON-serialized result never contains the secret value", async () => {
    global.fetch = mockFetch({
      value: KNOWN_SECRET,
      oneTime: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await tool.execute("1", {
      action: "fetch",
      grantId: "g1",
      name: "GH_TOKEN",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      handle: expect.any(String),
      name: "GH_TOKEN",
      expiresAt: expect.any(String),
      oneTime: true,
    });
    assertNoLeak(result);

    // The value IS retrievable via the handle store (by an exec bridge), proving
    // the value was actually captured — just never through the tool result.
    const seen = await withSecretEnv(parsed.handle, (env) => env);
    expect(seen).toEqual({ GH_TOKEN: KNOWN_SECRET });
  });

  it("fetch requires grantId and name", async () => {
    const r1 = await tool.execute("1", { action: "fetch" } as never);
    expect(r1.content[0].text).toMatch(/grantId/i);

    const r2 = await tool.execute("1", { action: "fetch", grantId: "g1" } as never);
    expect(r2.content[0].text).toMatch(/name/i);
  });

  it("fetch rejects an unsupported 'as' value", async () => {
    const result = await tool.execute("1", {
      action: "fetch",
      grantId: "g1",
      name: "X",
      as: "stdout",
    } as never);
    expect(result.content[0].text).toMatch(/as.*'env'/i);
  });

  it("maps a kernel 410 (already consumed) to a value-free grant_already_consumed error", async () => {
    global.fetch = mockFetch({ error: "gone" }, 410);
    const result = await tool.execute("1", {
      action: "fetch",
      grantId: "g1",
      name: "GH_TOKEN",
    });
    expect(result.content[0].text).toMatch(/grant_already_consumed/);
    assertNoLeak(result);
  });

  it("maps a kernel 403 to grant_not_for_this_agent", async () => {
    global.fetch = mockFetch({ error: "forbidden" }, 403);
    const result = await tool.execute("1", {
      action: "fetch",
      grantId: "g1",
      name: "GH_TOKEN",
    });
    expect(result.content[0].text).toMatch(/grant_not_for_this_agent/);
  });

  it("maps a kernel 404 to grant_not_found", async () => {
    global.fetch = mockFetch({ error: "missing" }, 404);
    const result = await tool.execute("1", {
      action: "fetch",
      grantId: "g1",
      name: "GH_TOKEN",
    });
    expect(result.content[0].text).toMatch(/grant_not_found/);
  });

  it("redacts an upstream 500 error — the tool result never contains the raw upstream body", async () => {
    const upstreamBody = `<html>crash dump: ${KNOWN_SECRET}</html>`;
    global.fetch = vi.fn().mockResolvedValue({
      status: 500,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => upstreamBody,
      json: async () => ({}),
    } as unknown as Response);
    const result = await tool.execute("1", {
      action: "fetch",
      grantId: "g1",
      name: "GH_TOKEN",
    });
    expect(result.content[0].text).toMatch(/vault_request_failed/);
    expect(result.content[0].text).not.toContain(KNOWN_SECRET);
    expect(result.content[0].text).not.toContain(upstreamBody);
    assertNoLeak(result);
  });

  it("ack_consumed POSTs to the consume endpoint and returns consumedAt", async () => {
    global.fetch = mockFetch({ consumedAt: "2026-01-01T00:00:00Z" });
    const result = await tool.execute("1", { action: "ack_consumed", grantId: "g1" });
    expect(JSON.parse(result.content[0].text)).toEqual({ consumedAt: "2026-01-01T00:00:00Z" });
  });

  it("ack_consumed requires grantId", async () => {
    const result = await tool.execute("1", { action: "ack_consumed" } as never);
    expect(result.content[0].text).toMatch(/grantId/i);
  });
});
