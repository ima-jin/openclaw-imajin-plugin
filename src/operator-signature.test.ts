import { describe, it, expect } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  parseOperatorSignature,
  verifyOperatorSignature,
  createIdentityClientOperatorKeyResolver,
  type OperatorCountersignFields,
} from "./operator-signature.js";
import { canonicalize } from "./approval-bridge.js";

if ("hashes" in ed && ed.hashes) {
  (ed.hashes as { sha512?: typeof sha512 }).sha512 = sha512;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function generateKeypairHex(): Promise<{ privateKeyHex: string; publicKeyHex: string }> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKeyHex: bytesToHex(privateKey), publicKeyHex: bytesToHex(publicKey) };
}

async function signFields(fields: OperatorCountersignFields, privateKeyHex: string): Promise<string> {
  const message = new TextEncoder().encode(canonicalize(fields));
  const sig = await ed.signAsync(message, Uint8Array.from(Buffer.from(privateKeyHex, "hex")));
  return Buffer.from(sig).toString("hex");
}

describe("parseOperatorSignature", () => {
  it("accepts undefined as absent", () => {
    expect(parseOperatorSignature(undefined)).toEqual({ ok: true, value: undefined });
  });

  it("rejects a non-object", () => {
    const result = parseOperatorSignature("not-an-object");
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed keyId/alg/sig", () => {
    expect(parseOperatorSignature({ keyId: "short", alg: "ed25519", sig: "a".repeat(128) }).ok).toBe(false);
    expect(parseOperatorSignature({ keyId: "a".repeat(64), alg: "rsa", sig: "a".repeat(128) }).ok).toBe(false);
    expect(parseOperatorSignature({ keyId: "a".repeat(64), alg: "ed25519", sig: "short" }).ok).toBe(false);
  });

  it("accepts and lowercases a well-formed signature", () => {
    const result = parseOperatorSignature({ keyId: "A".repeat(64), alg: "ed25519", sig: "B".repeat(128) });
    expect(result).toEqual({
      ok: true,
      value: { keyId: "a".repeat(64), alg: "ed25519", sig: "b".repeat(128) },
    });
  });
});

describe("verifyOperatorSignature", () => {
  it("verifies a valid signature over the exact canonicalized fields", async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeypairHex();
    const fields: OperatorCountersignFields = {
      contentHash: "sha256:" + "a".repeat(64),
      decision: "approve",
      decidedAt: new Date().toISOString(),
    };
    const sig = await signFields(fields, privateKeyHex);
    const result = await verifyOperatorSignature(
      fields,
      { keyId: publicKeyHex, alg: "ed25519", sig },
      publicKeyHex,
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects when keyId does not match the resolved operator public key", async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeypairHex();
    const other = await generateKeypairHex();
    const fields: OperatorCountersignFields = {
      contentHash: "sha256:" + "a".repeat(64),
      decision: "approve",
      decidedAt: new Date().toISOString(),
    };
    const sig = await signFields(fields, privateKeyHex);
    const result = await verifyOperatorSignature(
      fields,
      { keyId: publicKeyHex, alg: "ed25519", sig },
      other.publicKeyHex,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a tampered contentHash even when keyId matches", async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeypairHex();
    const fields: OperatorCountersignFields = {
      contentHash: "sha256:" + "a".repeat(64),
      decision: "approve",
      decidedAt: new Date().toISOString(),
    };
    const sig = await signFields(fields, privateKeyHex);
    const tampered = { ...fields, contentHash: "sha256:" + "b".repeat(64) };
    const result = await verifyOperatorSignature(tampered, { keyId: publicKeyHex, alg: "ed25519", sig }, publicKeyHex);
    expect(result).toEqual({ ok: false, error: "invalid operator signature" });
  });

  it("rejects a tampered decision even when keyId matches", async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeypairHex();
    const fields: OperatorCountersignFields = {
      contentHash: "sha256:" + "a".repeat(64),
      decision: "approve",
      decidedAt: new Date().toISOString(),
    };
    const sig = await signFields(fields, privateKeyHex);
    const tampered = { ...fields, decision: "reject" };
    const result = await verifyOperatorSignature(tampered, { keyId: publicKeyHex, alg: "ed25519", sig }, publicKeyHex);
    expect(result).toEqual({ ok: false, error: "invalid operator signature" });
  });

  it("rejects a tampered decidedAt even when keyId matches", async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeypairHex();
    const fields: OperatorCountersignFields = {
      contentHash: "sha256:" + "a".repeat(64),
      decision: "approve",
      decidedAt: new Date(0).toISOString(),
    };
    const sig = await signFields(fields, privateKeyHex);
    const tampered = { ...fields, decidedAt: new Date().toISOString() };
    const result = await verifyOperatorSignature(tampered, { keyId: publicKeyHex, alg: "ed25519", sig }, publicKeyHex);
    expect(result).toEqual({ ok: false, error: "invalid operator signature" });
  });
});

describe("createIdentityClientOperatorKeyResolver", () => {
  it("resolves the publicKey field from the identity client", async () => {
    const resolver = createIdentityClientOperatorKeyResolver({
      getIdentity: async (did) => (did === "did:imajin:operator" ? { publicKey: "abc123" } : null),
    });
    expect(await resolver.resolveOperatorPublicKey("did:imajin:operator")).toBe("abc123");
    expect(await resolver.resolveOperatorPublicKey("did:imajin:someone-else")).toBeNull();
  });

  it("fails closed to null when the identity client throws", async () => {
    const resolver = createIdentityClientOperatorKeyResolver({
      getIdentity: async () => {
        throw new Error("network error");
      },
    });
    expect(await resolver.resolveOperatorPublicKey("did:imajin:operator")).toBeNull();
  });

  it("treats a missing/empty publicKey as unresolved", async () => {
    const resolver = createIdentityClientOperatorKeyResolver({
      getIdentity: async () => ({ publicKey: "" }),
    });
    expect(await resolver.resolveOperatorPublicKey("did:imajin:operator")).toBeNull();
  });
});
