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

  it("only supports list_grants, fetch and ack — ack_consumed is not a valid action", async () => {
    expect(tool.parameters.properties.action.enum).toEqual(["list_grants", "fetch", "ack"]);
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

describe("imajin_vault ack", () => {
  let client: ImajinClient;
  let tool: ReturnType<typeof createVaultTool>;
  let consoleSpies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    _resetSecretHandleStoreForTests();
    client = new ImajinClient({ nodeUrl: "https://test.imajin.ai", did: "did:imajin:agent" });
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

  function ackCall(): { url: string; init: RequestInit } {
    const calls = vi.mocked(global.fetch).mock.calls;
    const [url, init] = calls[calls.length - 1];
    return { url: String(url), init: (init ?? {}) as RequestInit };
  }

  it("POSTs { outcome, evidence, note } to the ack path and returns only the receipt", async () => {
    global.fetch = mockFetch({ ok: true, grantId: "vdg_1", outcome: "used", ackedAt: "2026-09-22T00:00:00.000Z" });
    const result = await tool.execute("1", {
      action: "ack",
      grantId: "vdg_1",
      outcome: "used",
      evidence: { kind: "gha-runner", ref: "imajin-gx10" },
      note: "runner registered",
    });
    const { url, init } = ackCall();
    expect(url).toBe("https://test.imajin.ai/api/vault/delegation/grants/vdg_1/ack");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      outcome: "used",
      note: "runner registered",
      evidence: { kind: "gha-runner", ref: "imajin-gx10" },
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      grantId: "vdg_1",
      outcome: "used",
      ackedAt: "2026-09-22T00:00:00.000Z",
    });
  });

  it("requires grantId and outcome, and rejects an unknown outcome without a kernel call", async () => {
    global.fetch = mockFetch({});
    expect((await tool.execute("1", { action: "ack", outcome: "used" })).content[0].text).toMatch(/requires 'grantId'/);
    expect((await tool.execute("1", { action: "ack", grantId: "vdg_1" })).content[0].text).toMatch(/requires 'outcome'/);
    const bad = await tool.execute("1", { action: "ack", grantId: "vdg_1", outcome: "consumed" });
    expect(bad.content[0].text).toMatch(/invalid_ack/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("enforces the kernel's note / evidence limits client-side", async () => {
    global.fetch = mockFetch({});
    const longNote = await tool.execute("1", { action: "ack", grantId: "g", outcome: "used", note: "x".repeat(281) });
    expect(longNote.content[0].text).toMatch(/invalid_ack/);
    const badEvidence = await tool.execute("1", {
      action: "ack",
      grantId: "g",
      outcome: "used",
      evidence: { kind: "k", ref: "" },
    });
    expect(badEvidence.content[0].text).toMatch(/invalid_ack/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("maps 404 to grant_not_found, 409 to grant_not_fetched / ack_conflict, 500 to vault_request_failed", async () => {
    global.fetch = mockFetch({ error: "grant_not_found" }, 404);
    expect((await tool.execute("1", { action: "ack", grantId: "g", outcome: "used" })).content[0].text).toMatch(
      /grant_not_found/,
    );
    global.fetch = mockFetch({ error: "grant_not_fetched" }, 409);
    expect((await tool.execute("1", { action: "ack", grantId: "g", outcome: "used" })).content[0].text).toMatch(
      /grant_not_fetched/,
    );
    global.fetch = mockFetch({ error: "ack_conflict", ackOutcome: "failed", ackedAt: "2026-09-22T00:00:00.000Z" }, 409);
    expect((await tool.execute("1", { action: "ack", grantId: "g", outcome: "used" })).content[0].text).toMatch(
      /ack_conflict/,
    );
    global.fetch = mockFetch({ error: `boom ${KNOWN_SECRET}` }, 500);
    const r = await tool.execute("1", { action: "ack", grantId: "g", outcome: "used" });
    expect(r.content[0].text).toMatch(/vault_request_failed/);
    expect(r.content[0].text).not.toContain(KNOWN_SECRET);
  });

  it("refuses a note or evidence containing a live handle's value, and never calls the kernel", async () => {
    global.fetch = mockFetch({ ok: true, field: "F", value: KNOWN_SECRET, purpose: null, oneTime: true, expiresAt: null });
    await tool.execute("1", { action: "fetch", grantId: "vdg_1", name: "GH_TOKEN" });
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    for (const args of [
      { note: `registered with ${KNOWN_SECRET}` },
      { evidence: { kind: "gha-runner", ref: KNOWN_SECRET } },
      { evidence: { kind: KNOWN_SECRET, ref: "r" } },
    ]) {
      const result = await tool.execute("1", { action: "ack", grantId: "vdg_1", outcome: "used", ...args });
      expect(result.content[0].text).toMatch(/ack refused/);
      expect(JSON.stringify(result)).not.toContain(KNOWN_SECRET);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetch -> exec -> ack: the whole flow never leaks the value into results, requests or logs", async () => {
    global.fetch = mockFetch({ ok: true, field: "F", value: KNOWN_SECRET, purpose: null, oneTime: true, expiresAt: null });
    const fetched = JSON.parse((await tool.execute("1", { action: "fetch", grantId: "vdg_1", name: "GH_TOKEN" })).content[0].text);
    await withSecretEnv(fetched.handle, (env) => env.GH_TOKEN.length);

    global.fetch = mockFetch({ ok: true, grantId: "vdg_1", outcome: "used", ackedAt: "2026-09-22T00:00:00.000Z" });
    const result = await tool.execute("1", {
      action: "ack",
      grantId: "vdg_1",
      outcome: "used",
      evidence: { kind: "gha-runner", ref: "imajin-gx10" },
      note: "runner registered",
    });
    expect(JSON.stringify(result)).not.toContain(KNOWN_SECRET);
    expect(String(ackCall().init.body)).not.toContain(KNOWN_SECRET);
    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(KNOWN_SECRET);
    }
  });

  it("has no parameter that could carry a value, and its description says it signs what the agent did, never the value", () => {
    expect(Object.keys(tool.parameters.properties)).not.toContain("value");
    expect(tool.description).toMatch(/SIGN what you did/);
    expect(tool.description).toMatch(/NEVER the value/);
  });
});
