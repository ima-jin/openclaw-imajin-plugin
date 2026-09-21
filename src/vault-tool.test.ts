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

  it("only supports list_grants and fetch — ack_consumed is not a valid action", async () => {
    expect(tool.parameters.properties.action.enum).toEqual(["list_grants", "fetch"]);
    const result = await tool.execute("1", { action: "ack_consumed" } as never);
    expect(result.content[0].text).toMatch(/Unknown action/);
  });

  it("list_grants returns metadata only (subject/field/status/purpose), never a value field", async () => {
    global.fetch = mockFetch({
      grants: [
        {
          grantId: "vdg_1",
          subject: "did:imajin:owner",
          field: "gha-runner-token",
          purpose: "gha-runner-registration",
          oneTime: true,
          status: "active",
          expiresAt: null,
          consumedAt: null,
          createdAt: "2025-12-31T00:00:00Z",
        },
      ],
    });
    const result = await tool.execute("1", { action: "list_grants" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.grants).toHaveLength(1);
    expect(parsed.grants[0]).not.toHaveProperty("value");
    expect(parsed.grants[0]).toMatchObject({ subject: "did:imajin:owner", field: "gha-runner-token" });
    assertNoLeak(result);
  });

  it("fetch returns ONLY a handle + metadata — the JSON-serialized result never contains the secret value", async () => {
    global.fetch = mockFetch({
      ok: true,
      field: "gha-runner-token",
      value: KNOWN_SECRET,
      purpose: "gha-runner-registration",
      oneTime: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await tool.execute("1", {
      action: "fetch",
      grantId: "vdg_1",
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

  it("fetch works when the kernel reports no expiry on the grant (expiresAt: null)", async () => {
    global.fetch = mockFetch({
      ok: true,
      field: "F",
      value: KNOWN_SECRET,
      purpose: null,
      oneTime: false,
      expiresAt: null,
    });
    const result = await tool.execute("1", { action: "fetch", grantId: "vdg_1", name: "GH_TOKEN" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.expiresAt).toEqual(expect.any(String));
    expect(new Date(parsed.expiresAt).getTime()).toBeGreaterThan(Date.now());
    assertNoLeak(result);
  });

  it("fetch requires grantId and name", async () => {
    const r1 = await tool.execute("1", { action: "fetch" } as never);
    expect(r1.content[0].text).toMatch(/grantId/i);

    const r2 = await tool.execute("1", { action: "fetch", grantId: "vdg_1" } as never);
    expect(r2.content[0].text).toMatch(/name/i);
  });

  it("fetch rejects an unsupported 'as' value", async () => {
    const result = await tool.execute("1", {
      action: "fetch",
      grantId: "vdg_1",
      name: "X",
      as: "stdout",
    } as never);
    expect(result.content[0].text).toMatch(/as.*'env'/i);
  });

  it("maps a kernel 410 (already consumed) to a value-free grant_already_consumed error", async () => {
    global.fetch = mockFetch({ error: "gone" }, 410);
    const result = await tool.execute("1", {
      action: "fetch",
      grantId: "vdg_1",
      name: "GH_TOKEN",
    });
    expect(result.content[0].text).toMatch(/grant_already_consumed/);
    assertNoLeak(result);
  });

  it("maps a kernel 404 to grant_not_found (unknown grantId or belongs to another agent)", async () => {
    global.fetch = mockFetch({ error: "not found" }, 404);
    const result = await tool.execute("1", {
      action: "fetch",
      grantId: "vdg_1",
      name: "GH_TOKEN",
    });
    expect(result.content[0].text).toMatch(/grant_not_found/);
  });

  it("maps a kernel 403 to grant_not_active (inactive/expired/revoked)", async () => {
    global.fetch = mockFetch({ error: "forbidden" }, 403);
    const result = await tool.execute("1", {
      action: "fetch",
      grantId: "vdg_1",
      name: "GH_TOKEN",
    });
    expect(result.content[0].text).toMatch(/grant_not_active/);
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
      grantId: "vdg_1",
      name: "GH_TOKEN",
    });
    expect(result.content[0].text).toMatch(/vault_request_failed/);
    expect(result.content[0].text).not.toContain(KNOWN_SECRET);
    expect(result.content[0].text).not.toContain(upstreamBody);
    assertNoLeak(result);
  });
});
