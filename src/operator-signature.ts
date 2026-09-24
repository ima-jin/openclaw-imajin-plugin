/**
 * Operator countersignature verification (#44, plugin half of
 * `ima-jin/imajin-ai#2082`/kernel PR `ima-jin/imajin-ai#2158`).
 *
 * `operator.approval.decided` may carry `operatorSignature` — a signature
 * by the OPERATOR's own key (produced client-side on /jin, NEVER the
 * kernel's node/witness key) over `canonicalize({contentHash, decision,
 * decidedAt})`. Before #44, this bridge trusted only the kernel's witness
 * signature on the WS envelope (`issuer`/`subject`/`decidedBy` ==
 * `approvals.operatorDid`) — that proves the kernel RECORDED a decision,
 * never that the operator actually MADE it, so a compromised kernel alone
 * could forge an approval. This module verifies the operator's signature
 * directly against the operator DID's registered Ed25519 public key,
 * resolved via the kernel's EXISTING DID resolver
 * (`ImajinClient.getIdentity`, `GET /registry/api/identity/:did` —
 * ima-jin/imajin-ai's public did:imajin resolver) — never a value embedded
 * in the event itself.
 *
 * Field shapes and the exact canonicalized message mirror the kernel's own
 * `apps/kernel/src/lib/notify/operator-countersign.ts` /
 * `operator-approvals.ts` byte-for-byte (see
 * `docs/notify-operator-approvals-contract.md` in `ima-jin/imajin-ai`), so
 * a signature the kernel accepts is exactly the signature this module
 * accepts. `canonicalize` (`./approval-bridge.js`) already mirrors
 * `@imajin/auth`'s canonical JSON.
 *
 * This module has NO top-level `openclaw` plugin-sdk imports, so it (and
 * every function in it) can be unit tested with plain fakes — matching the
 * existing pattern in `gateway-approvals-bridge.ts`.
 */
import { canonicalize } from "./approval-bridge.js";

export type OperatorSignatureAlg = "ed25519";

/** Mirrors the kernel's `OperatorCountersignature` shape exactly. */
export interface OperatorCountersignature {
  /** Hex-encoded Ed25519 public key that produced `sig`. */
  keyId: string;
  alg: OperatorSignatureAlg;
  /** Hex-encoded Ed25519 signature over canonicalize({contentHash, decision, decidedAt}). */
  sig: string;
}

/** The exact fields the operator's countersignature covers (kernel contract, #2082). */
export interface OperatorCountersignFields {
  contentHash: string;
  decision: string;
  decidedAt: string;
}

export type ParsedOperatorSignature =
  | { ok: true; value: OperatorCountersignature | undefined }
  | { ok: false; error: string };

export type OperatorSignatureVerification = { ok: true } | { ok: false; error: string };

const ED25519_PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/i;
const ED25519_SIGNATURE_HEX = /^[0-9a-f]{128}$/i;

/**
 * Shape-validates an `operatorSignature` object parsed from an untrusted
 * kernel `bus_event` payload. Mirrors the kernel's own `parseOperatorSignature`
 * (`apps/kernel/src/lib/notify/operator-countersign.ts`) exactly — same
 * field names, same hex-length requirements — so a malformed signature is
 * rejected here with the same shape of error the kernel itself would give.
 * Purely structural; cryptographic verification is
 * {@link verifyOperatorSignature}, which needs a resolved public key and so
 * stays separate and async.
 */
export function parseOperatorSignature(raw: unknown): ParsedOperatorSignature {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "operatorSignature must be an object" };
  }
  const { keyId, alg, sig } = raw as Record<string, unknown>;
  if (typeof keyId !== "string" || !ED25519_PUBLIC_KEY_HEX.test(keyId)) {
    return { ok: false, error: "operatorSignature.keyId must be a 64-char hex Ed25519 public key" };
  }
  if (alg !== "ed25519") {
    return { ok: false, error: "operatorSignature.alg must be 'ed25519'" };
  }
  if (typeof sig !== "string" || !ED25519_SIGNATURE_HEX.test(sig)) {
    return { ok: false, error: "operatorSignature.sig must be a 128-char hex Ed25519 signature" };
  }
  return { ok: true, value: { keyId: keyId.toLowerCase(), alg, sig: sig.toLowerCase() } };
}

/** Resolves an operator DID to its currently registered Ed25519 public key (hex), or `null` when unresolvable. */
export interface OperatorKeyResolver {
  resolveOperatorPublicKey(operatorDid: string): Promise<string | null>;
}

/** Duck-typed subset of `ImajinClient` — the plugin's EXISTING DID resolver (`client.ts`'s `getIdentity`, `GET /registry/api/identity/:did`). Never a new resolver. */
export interface IdentityLookupClient {
  getIdentity(did: string): Promise<{ publicKey?: string } | null>;
}

/**
 * Wraps this plugin's existing `ImajinClient.getIdentity` as an
 * {@link OperatorKeyResolver} — reuses the same DID resolution every other
 * tool in this plugin already goes through rather than adding a second
 * one. Fails closed to `null` (never throws) on any lookup error, so a
 * transient registry hiccup causes a *supplied* signature to be rejected
 * as unverifiable rather than silently accepted.
 */
export function createIdentityClientOperatorKeyResolver(client: IdentityLookupClient): OperatorKeyResolver {
  return {
    async resolveOperatorPublicKey(operatorDid: string): Promise<string | null> {
      try {
        const identity = await client.getIdentity(operatorDid);
        const key = identity?.publicKey;
        return typeof key === "string" && key.length > 0 ? key : null;
      } catch {
        return null;
      }
    },
  };
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) {
    throw new Error("invalid hex string");
  }
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

async function loadEd25519() {
  const ed = await import("@noble/ed25519");
  const { sha512 } = await import("@noble/hashes/sha2.js");
  if ("hashes" in ed && ed.hashes) {
    (ed.hashes as { sha512?: typeof sha512 }).sha512 = sha512;
  } else {
    try {
      ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed.etc.concatBytes(...messages));
    } catch {
      // A host may have configured the hash implementation already.
    }
  }
  return ed;
}

/**
 * Verifies `signature` over `fields` against `operatorPublicKeyHex` — the
 * operator DID's CURRENT registered key, resolved by the caller (never a
 * value embedded in the event itself). Fails closed: never throws, so a
 * caller can map straight to "reject, do not apply" without persisting or
 * resolving anything.
 */
export async function verifyOperatorSignature(
  fields: OperatorCountersignFields,
  signature: OperatorCountersignature,
  operatorPublicKeyHex: string,
): Promise<OperatorSignatureVerification> {
  if (signature.alg !== "ed25519") {
    return { ok: false, error: "unsupported operator signature algorithm" };
  }
  if (signature.keyId.toLowerCase() !== operatorPublicKeyHex.toLowerCase()) {
    return {
      ok: false,
      error:
        "operatorSignature.keyId does not match the operator DID's current registered key (unknown or revoked key)",
    };
  }
  try {
    const ed = await loadEd25519();
    const message = new TextEncoder().encode(canonicalize(fields));
    const valid = await ed.verifyAsync(
      hexToBytes(signature.sig),
      message,
      hexToBytes(operatorPublicKeyHex),
    );
    if (!valid) return { ok: false, error: "invalid operator signature" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `operator signature verification failed: ${String(err)}` };
  }
}
