import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ImajinClient } from "../client.js";
import { listGrantsMine, fetchGrantValue, VaultError } from "./kernel-contract.js";

const KNOWN_SECRET = "ghp_super-secret-runner-registration-token-do-not-leak";

function makeMockClient(): ImajinClient {
  return { requestRaw: vi.fn() } as unknown as ImajinClient;
}

describe("listGrantsMine", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient();
  });

  it("GETs /api/vault/delegation/grants with no query params and returns grants verbatim", async () => {
    const grants = [
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
    ];
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ grants }),
    });
    const result = await listGrantsMine(client);
    expect(result).toEqual(grants);
    const [path, opts] = vi.mocked(client.requestRaw).mock.calls[0];
    expect(path).toBe("/api/vault/delegation/grants");
    expect(opts).toEqual({ onBehalfOf: undefined });
  });

  it("includes a purpose filter when provided, and no other params", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ grants: [] }),
    });
    await listGrantsMine(client, { purpose: "gha-runner-registration" });
    const [path] = vi.mocked(client.requestRaw).mock.calls[0];
    expect(path).toBe("/api/vault/delegation/grants?purpose=gha-runner-registration");
  });

  it("returns an empty array when grants is missing or malformed", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 200,
      contentType: "application/json",
      text: "not json",
    });
    expect(await listGrantsMine(client)).toEqual([]);
  });

  it("throws vault_request_failed on a non-2xx status", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 500,
      contentType: "text/plain",
      text: "internal error, secret was: " + KNOWN_SECRET,
    });
    let caught: unknown;
    try {
      await listGrantsMine(client);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VaultError);
    expect((caught as VaultError).code).toBe("vault_request_failed");
    expect((caught as VaultError).message).not.toContain(KNOWN_SECRET);
  });
});

describe("fetchGrantValue", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient();
  });

  it("POSTs to /api/vault/delegation/grants/{grantId}/fetch and returns the value + metadata", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({
        ok: true,
        field: "gha-runner-token",
        value: KNOWN_SECRET,
        purpose: "gha-runner-registration",
        oneTime: true,
        expiresAt: "2026-01-01T00:00:00Z",
      }),
    });
    const result = await fetchGrantValue(client, "vdg_1");
    expect(result).toEqual({
      value: KNOWN_SECRET,
      field: "gha-runner-token",
      purpose: "gha-runner-registration",
      oneTime: true,
      expiresAt: "2026-01-01T00:00:00Z",
    });
    const [path, opts] = vi.mocked(client.requestRaw).mock.calls[0];
    expect(path).toBe("/api/vault/delegation/grants/vdg_1/fetch");
    expect(opts).toMatchObject({ method: "POST" });
  });

  it("passes a null expiresAt straight through (no expiry on the grant) instead of fabricating one", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ ok: true, field: "F", value: "v", purpose: null, oneTime: false, expiresAt: null }),
    });
    const result = await fetchGrantValue(client, "vdg_1");
    expect(result.expiresAt).toBeNull();
    expect(result.purpose).toBeNull();
  });

  it("URL-encodes the grantId", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ ok: true, field: "F", value: "v", purpose: null, oneTime: false, expiresAt: null }),
    });
    await fetchGrantValue(client, "g/1");
    const [path] = vi.mocked(client.requestRaw).mock.calls[0];
    expect(path).toBe("/api/vault/delegation/grants/g%2F1/fetch");
  });

  it("maps 404 to grant_not_found (covers both unknown grantId and a grant belonging to another agent)", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 404,
      contentType: "text/plain",
      text: `not found, would-be value: ${KNOWN_SECRET}`,
    });
    let caught: unknown;
    try {
      await fetchGrantValue(client, "vdg_1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VaultError);
    expect((caught as VaultError).code).toBe("grant_not_found");
    expect((caught as VaultError).message).not.toContain(KNOWN_SECRET);
  });

  it("maps 403 to grant_not_active (inactive/expired/revoked)", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({ status: 403, contentType: "", text: "" });
    await expect(fetchGrantValue(client, "vdg_1")).rejects.toMatchObject({ code: "grant_not_active" });
  });

  it("maps 410 to grant_already_consumed", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({ status: 410, contentType: "", text: "" });
    await expect(fetchGrantValue(client, "vdg_1")).rejects.toMatchObject({ code: "grant_already_consumed" });
  });

  it("redacts an upstream 500 error message (never includes the response body)", async () => {
    const upstreamBody = `<html>internal server crash, dump: ${KNOWN_SECRET}</html>`;
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 500,
      contentType: "text/html",
      text: upstreamBody,
    });
    let caught: unknown;
    try {
      await fetchGrantValue(client, "vdg_1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VaultError);
    expect((caught as VaultError).code).toBe("vault_request_failed");
    const message = (caught as VaultError).message;
    expect(message).not.toContain(KNOWN_SECRET);
    expect(message).not.toContain(upstreamBody);
  });

  it("throws vault_request_failed when a 2xx body is missing a value", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ ok: true, oneTime: true }),
    });
    await expect(fetchGrantValue(client, "vdg_1")).rejects.toMatchObject({ code: "vault_request_failed" });
  });
});
