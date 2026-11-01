import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImajinClient } from "./client.js";
import { buildStatusIdentity } from "./status-identity.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("held identity authentication metadata", () => {
  const did = "did:imajin:caller";
  const publicKey = "ab".repeat(32);

  it("reads a short public-key hash without authentication or key-file IO", () => {
    const transport = vi.fn();
    const client = new ImajinClient({
      nodeUrl: "https://kernel.invalid", did, keypairPath: "/must-not-read", transport,
      signer: { did, publicKey, signChallenge: vi.fn() },
    });
    expect(client.identityStatus()).toEqual({
      did, actAs: undefined, auth: null,
      publicKey: createHash("sha256").update(Buffer.from(publicKey, "hex")).digest("hex").slice(0, 12),
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("records one successful challenge-response, not cached reads, and returns copies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T22:00:00Z"));
    const cookie = randomUUID();
    const transport = vi.fn()
      .mockResolvedValueOnce(Response.json({
        challengeId: "challenge", challenge: "public-challenge",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }))
      .mockResolvedValueOnce(Response.json({}, { headers: { "set-cookie": `session=${cookie}` } }));
    const client = new ImajinClient({
      nodeUrl: "https://kernel.invalid", did, transport,
      signer: { did, publicKey, signChallenge: vi.fn(async () => "test-signature") },
    });
    await Promise.all([client.authenticate(), client.authenticate()]);
    const expected = { ok: true, at: new Date().toISOString() };
    expect(client.identityStatus().auth).toEqual(expected);
    vi.advanceTimersByTime(1000);
    await client.authenticate();
    expect(client.identityStatus().auth).toEqual(expected);
    expect(transport).toHaveBeenCalledTimes(2);
    client.identityStatus().auth!.ok = false;
    expect(client.identityStatus().auth).toEqual(expected);
    expect(JSON.stringify(client.identityStatus())).not.toContain(cookie);
    client.invalidateAuthentication();
    transport.mockResolvedValueOnce(Response.json({}, { status: 403 }));
    await expect(client.authenticate()).rejects.toThrow();
    expect(client.identityStatus().auth).toMatchObject({ ok: false, error: "Authentication failed" });
    transport.mockResolvedValueOnce(Response.json({
      challengeId: "retry", challenge: "retry", expiresAt: new Date(Date.now() + 300_000).toISOString(),
    })).mockResolvedValueOnce(Response.json({}, { headers: { "set-cookie": `session=${cookie}` } }));
    await client.authenticate();
    expect(client.identityStatus().auth).toEqual({ ok: true, at: new Date().toISOString() });
  });

  it.each(["challenge", "verify", "signer", "cookie"])("records safe %s failures without protected data", async (failure) => {
    const protectedValue = randomUUID();
    const transport = vi.fn(async (url: string | URL | Request) => {
      if (failure === "challenge" || (failure === "verify" && String(url).endsWith("/verify"))) {
        return new Response(protectedValue, { status: 403 });
      }
      return Response.json({ challengeId: "challenge", challenge: "public-challenge" });
    });
    const client = new ImajinClient({
      nodeUrl: "https://kernel.invalid", did, transport,
      signer: {
        did, publicKey, signChallenge: async () => {
          if (failure === "signer") throw new Error(protectedValue);
          return "test-signature";
        },
      },
    });
    await expect(client.authenticate()).rejects.toThrow();
    const status = buildStatusIdentity({
      mode: "map", agentId: "caller", did, isGatewayAgent: false, client,
    });
    expect(status.auth).toEqual({
      ok: false, at: expect.any(String), error: "Authentication failed",
    });
    expect(JSON.stringify(status)).not.toContain(protectedValue);
    expect(JSON.stringify(status)).not.toMatch(/privateKey|seed|token|sessionCookie|signChallenge/);
  });

  it("does not throw when a legacy keypair cannot be loaded", async () => {
    const client = new ImajinClient({ nodeUrl: "https://kernel.invalid", did, keypairPath: "/missing-identity.json" });
    await expect(client.authenticate()).rejects.toThrow();
    expect(() => client.identityStatus()).not.toThrow();
    expect(client.identityStatus()).toMatchObject({ did, publicKey: null, auth: { ok: false } });
  });
});
