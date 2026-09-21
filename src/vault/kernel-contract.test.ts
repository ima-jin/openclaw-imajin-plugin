import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ImajinClient } from "../client.js";
import { listGrantsMine, fetchGrantValue, consumeGrant, VaultError } from "./kernel-contract.js";

const KNOWN_SECRET = "ghp_super-secret-runner-registration-token-do-not-leak";

function makeMockClient(): ImajinClient {
  return { requestRaw: vi.fn() } as unknown as ImajinClient;
}

describe("listGrantsMine", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient();
  });

  it("GETs /auth/api/grants/mine?status=active and returns grants verbatim", async () => {
    const grants = [
      {
        grantId: "g1",
        ownerDid: "did:imajin:owner",
        purpose: "gha-runner-registration",
        expiresAt: "2026-01-01T00:00:00Z",
        oneTime: true,
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
    expect(path).toBe("/auth/api/grants/mine?status=active");
    expect(opts).toEqual({ onBehalfOf: undefined });
  });

  it("includes a purpose filter when provided", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ grants: [] }),
    });
    await listGrantsMine(client, { purpose: "gha-runner-registration" });
    const [path] = vi.mocked(client.requestRaw).mock.calls[0];
    expect(path).toBe("/auth/api/grants/mine?status=active&purpose=gha-runner-registration");
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

  it("POSTs to /auth/api/grants/{grantId}/fetch and returns the value", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ value: KNOWN_SECRET, oneTime: true, expiresAt: "2026-01-01T00:00:00Z" }),
    });
    const result = await fetchGrantValue(client, "g1");
    expect(result.value).toBe(KNOWN_SECRET);
    expect(result.oneTime).toBe(true);
    const [path, opts] = vi.mocked(client.requestRaw).mock.calls[0];
    expect(path).toBe("/auth/api/grants/g1/fetch");
    expect(opts).toMatchObject({ method: "POST" });
  });

  it("URL-encodes the grantId", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ value: "v", oneTime: false, expiresAt: "2026-01-01T00:00:00Z" }),
    });
    await fetchGrantValue(client, "g/1");
    const [path] = vi.mocked(client.requestRaw).mock.calls[0];
    expect(path).toBe("/auth/api/grants/g%2F1/fetch");
  });

  it("maps 403 to grant_not_for_this_agent (value-free)", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 403,
      contentType: "text/plain",
      text: `forbidden, would-be value: ${KNOWN_SECRET}`,
    });
    let caught: unknown;
    try {
      await fetchGrantValue(client, "g1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VaultError);
    expect((caught as VaultError).code).toBe("grant_not_for_this_agent");
    expect((caught as VaultError).message).not.toContain(KNOWN_SECRET);
  });

  it("maps 404 to grant_not_found", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({ status: 404, contentType: "", text: "" });
    await expect(fetchGrantValue(client, "g1")).rejects.toMatchObject({ code: "grant_not_found" });
  });

  it("maps 410 to grant_already_consumed", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({ status: 410, contentType: "", text: "" });
    await expect(fetchGrantValue(client, "g1")).rejects.toMatchObject({ code: "grant_already_consumed" });
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
      await fetchGrantValue(client, "g1");
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
      text: JSON.stringify({ oneTime: true }),
    });
    await expect(fetchGrantValue(client, "g1")).rejects.toMatchObject({ code: "vault_request_failed" });
  });
});

describe("consumeGrant", () => {
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    client = makeMockClient();
  });

  it("POSTs to /auth/api/grants/{grantId}/consume and returns consumedAt", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ consumedAt: "2026-01-01T00:00:00Z" }),
    });
    const result = await consumeGrant(client, "g1");
    expect(result).toEqual({ consumedAt: "2026-01-01T00:00:00Z" });
    const [path, opts] = vi.mocked(client.requestRaw).mock.calls[0];
    expect(path).toBe("/auth/api/grants/g1/consume");
    expect(opts).toMatchObject({ method: "POST" });
  });

  it("maps 404 to grant_not_found", async () => {
    vi.mocked(client.requestRaw).mockResolvedValue({ status: 404, contentType: "", text: "" });
    await expect(consumeGrant(client, "g1")).rejects.toMatchObject({ code: "grant_not_found" });
  });
});
