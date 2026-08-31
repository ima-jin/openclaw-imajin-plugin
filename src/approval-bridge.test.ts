import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  ApprovalBridge,
  buildApprovalRequestedFrame,
  canonicalize,
  isApprovalDecisionFrame,
  signMessage,
  verifyApprovalDecision,
  verifyMessage,
  type ApprovalDecisionFrame,
  type GatewayApprovalRequest,
} from "./approval-bridge.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

if ("hashes" in ed && ed.hashes) {
  (ed.hashes as { sha512?: typeof sha512 }).sha512 = sha512;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const REQUESTER_DID = "did:imajin:agent";
const APPROVER_DID = "did:imajin:human-owner";

async function generateKeypairHex(): Promise<{ privateKeyHex: string; publicKeyHex: string }> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKeyHex: bytesToHex(privateKey), publicKeyHex: bytesToHex(publicKey) };
}

async function buildSignedDecisionFrame(params: {
  requestId: string;
  decision: "approve" | "reject";
  approverPrivateKeyHex: string;
  approverDid?: string;
  overridePayloadRequestId?: string;
}): Promise<ApprovalDecisionFrame> {
  const attestation = await signMessage(
    {
      requestId: params.overridePayloadRequestId ?? params.requestId,
      decision: params.decision,
    },
    { did: params.approverDid ?? APPROVER_DID, type: "human", privateKeyHex: params.approverPrivateKeyHex },
  );
  return { type: "approval.decision", requestId: params.requestId, attestation };
}

describe("canonicalize", () => {
  it("sorts object keys deterministically regardless of input order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("handles arrays, null, and nested objects", () => {
    expect(canonicalize([1, "x", null])).toBe('[1,"x",null]');
    expect(canonicalize({ z: { y: 1 }, a: [1, 2] })).toBe('{"a":[1,2],"z":{"y":1}}');
  });
});

describe("signMessage / verifyMessage roundtrip", () => {
  it("verifies a message signed with the matching private key", async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeypairHex();
    const signed = await signMessage({ hello: "world" }, { did: REQUESTER_DID, type: "agent", privateKeyHex });
    expect(await verifyMessage(signed, publicKeyHex)).toBe(true);
  });

  it("rejects a message verified against an unrelated public key", async () => {
    const signer = await generateKeypairHex();
    const other = await generateKeypairHex();
    const signed = await signMessage({ hello: "world" }, { did: REQUESTER_DID, type: "agent", privateKeyHex: signer.privateKeyHex });
    expect(await verifyMessage(signed, other.publicKeyHex)).toBe(false);
  });

  it("rejects a tampered payload even with a structurally valid signature field", async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeypairHex();
    const signed = await signMessage({ amount: 1 }, { did: REQUESTER_DID, type: "agent", privateKeyHex });
    const tampered = { ...signed, payload: { amount: 999 } };
    expect(await verifyMessage(tampered, publicKeyHex)).toBe(false);
  });

  it("rejects malformed/unsigned values without throwing", async () => {
    expect(await verifyMessage(null, "aa")).toBe(false);
    expect(await verifyMessage({ from: "x" }, "aa")).toBe(false);
    expect(await verifyMessage({ from: "x", type: "agent", timestamp: 1, payload: {}, signature: "" }, "aa")).toBe(
      false,
    );
  });
});

describe("buildApprovalRequestedFrame", () => {
  it("produces a stable-request-id, expiry-carrying, verifiably signed frame", async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeypairHex();
    const request: GatewayApprovalRequest = {
      requestId: "appr_123",
      kind: "exec",
      summary: "rm -rf /tmp/scratch",
      requesterDid: REQUESTER_DID,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const frame = await buildApprovalRequestedFrame(request, { did: REQUESTER_DID, privateKeyHex });
    expect(frame.type).toBe("openclaw.approval.requested");
    expect(frame.attestation.payload).toEqual(request);
    expect(frame.attestation.from).toBe(REQUESTER_DID);
    expect(await verifyMessage(frame.attestation, publicKeyHex)).toBe(true);
  });
});

describe("isApprovalDecisionFrame", () => {
  it("accepts a well-formed decision frame and rejects unrelated shapes", async () => {
    const { privateKeyHex } = await generateKeypairHex();
    const frame = await buildSignedDecisionFrame({
      requestId: "appr_1",
      decision: "approve",
      approverPrivateKeyHex: privateKeyHex,
    });
    expect(isApprovalDecisionFrame(frame)).toBe(true);
    expect(isApprovalDecisionFrame({ type: "notification" })).toBe(false);
    expect(isApprovalDecisionFrame({ type: "approval.decision" })).toBe(false);
    expect(isApprovalDecisionFrame(null)).toBe(false);
  });
});

describe("verifyApprovalDecision", () => {
  const pending = { requestId: "appr_1", expiresAtMs: Date.now() + 60_000, kind: "exec" as const };

  it("happy path: valid signature, matching request id, not expired", async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeypairHex();
    const frame = await buildSignedDecisionFrame({
      requestId: pending.requestId,
      decision: "approve",
      approverPrivateKeyHex: privateKeyHex,
    });
    const result = await verifyApprovalDecision(frame, pending, publicKeyHex);
    expect(result).toEqual({
      ok: true,
      requestId: pending.requestId,
      decision: "approve",
      approverDid: APPROVER_DID,
    });
  });

  it("rejects a decision signed by a key other than the pinned approver key (channel-trust != signature-trust)", async () => {
    const attacker = await generateKeypairHex();
    const pinned = await generateKeypairHex();
    const frame = await buildSignedDecisionFrame({
      requestId: pending.requestId,
      decision: "approve",
      approverPrivateKeyHex: attacker.privateKeyHex,
    });
    const result = await verifyApprovalDecision(frame, pending, pinned.publicKeyHex);
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a decision whose signed payload references a different request id", async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeypairHex();
    // Outer routing field matches pending, but the SIGNED payload references another request.
    const frame = await buildSignedDecisionFrame({
      requestId: pending.requestId,
      decision: "approve",
      approverPrivateKeyHex: privateKeyHex,
      overridePayloadRequestId: "appr_other",
    });
    const result = await verifyApprovalDecision(frame, pending, publicKeyHex);
    expect(result).toEqual({ ok: false, reason: "request_id_mismatch" });
  });

  it("rejects a decision that arrives after the original request's expiry", async () => {
    const { privateKeyHex, publicKeyHex } = await generateKeypairHex();
    const frame = await buildSignedDecisionFrame({
      requestId: pending.requestId,
      decision: "approve",
      approverPrivateKeyHex: privateKeyHex,
    });
    const result = await verifyApprovalDecision(frame, pending, publicKeyHex, pending.expiresAtMs + 1);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an unsigned/malformed frame", async () => {
    const { publicKeyHex } = await generateKeypairHex();
    expect(await verifyApprovalDecision({ type: "approval.decision", requestId: "appr_1" }, pending, publicKeyHex)).toEqual(
      { ok: false, reason: "unsigned" },
    );
    expect(await verifyApprovalDecision(null, pending, publicKeyHex)).toEqual({
      ok: false,
      reason: "unsigned",
    });
  });
});

describe("ApprovalBridge", () => {
  const KEYPAIR_PATH = "/fake/.jin-identity.json";
  let requester: { privateKeyHex: string; publicKeyHex: string };
  let approver: { privateKeyHex: string; publicKeyHex: string };
  let sent: unknown[];
  let send: (frame: unknown) => void;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    requester = await generateKeypairHex();
    approver = await generateKeypairHex();
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ did: REQUESTER_DID, privateKey: requester.privateKeyHex }),
    );
    sent = [];
    send = (frame) => sent.push(frame);
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function newBridge(): ApprovalBridge {
    return new ApprovalBridge(
      { did: REQUESTER_DID, keypairPath: KEYPAIR_PATH, pinnedApproverPublicKeyHex: approver.publicKeyHex },
      send,
      logger,
    );
  }

  function newRequest(overrides: Partial<GatewayApprovalRequest> = {}): GatewayApprovalRequest {
    return {
      requestId: "appr_1",
      kind: "exec",
      summary: "rm -rf /tmp/scratch",
      requesterDid: REQUESTER_DID,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    };
  }

  it("publishRequest signs and sends the request, tracking it as pending", async () => {
    const bridge = newBridge();
    await bridge.publishRequest(newRequest());
    expect(sent).toHaveLength(1);
    expect((sent[0] as { type: string }).type).toBe("openclaw.approval.requested");
    expect(bridge.hasPending("appr_1")).toBe(true);
  });

  it("resolves the approval and clears the pending entry on a valid approve decision", async () => {
    const bridge = newBridge();
    await bridge.publishRequest(newRequest());
    const resolved = vi.fn();
    bridge.onResolved(resolved);

    const frame = await buildSignedDecisionFrame({
      requestId: "appr_1",
      decision: "approve",
      approverPrivateKeyHex: approver.privateKeyHex,
    });
    await bridge.handleFrame(frame);

    expect(resolved).toHaveBeenCalledWith("appr_1", "approve", "exec");
    expect(bridge.hasPending("appr_1")).toBe(false);
  });

  it("never resolves on WS-authenticated-but-unsigned-correctly decisions (channel-trust != signature-trust)", async () => {
    const bridge = newBridge();
    await bridge.publishRequest(newRequest());
    const resolved = vi.fn();
    bridge.onResolved(resolved);

    // Signed by an attacker key, not the pinned approver key.
    const attacker = await generateKeypairHex();
    const frame = await buildSignedDecisionFrame({
      requestId: "appr_1",
      decision: "approve",
      approverPrivateKeyHex: attacker.privateKeyHex,
    });
    await bridge.handleFrame(frame);

    expect(resolved).not.toHaveBeenCalled();
    expect(bridge.hasPending("appr_1")).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("invalid_signature"));
  });

  it("rejects and logs a request-id-mismatched decision without resolving", async () => {
    const bridge = newBridge();
    await bridge.publishRequest(newRequest());
    const resolved = vi.fn();
    bridge.onResolved(resolved);

    const frame = await buildSignedDecisionFrame({
      requestId: "appr_1",
      decision: "reject",
      approverPrivateKeyHex: approver.privateKeyHex,
      overridePayloadRequestId: "appr_forged",
    });
    await bridge.handleFrame(frame);

    expect(resolved).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("request_id_mismatch"));
  });

  it("rejects and prunes an expired decision without resolving", async () => {
    const bridge = newBridge();
    await bridge.publishRequest(newRequest({ expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    const resolved = vi.fn();
    bridge.onResolved(resolved);

    const frame = await buildSignedDecisionFrame({
      requestId: "appr_1",
      decision: "approve",
      approverPrivateKeyHex: approver.privateKeyHex,
    });
    await bridge.handleFrame(frame);

    expect(resolved).not.toHaveBeenCalled();
    expect(bridge.hasPending("appr_1")).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("expired"));
  });

  it("drops a decision for a request id that was never published", async () => {
    const bridge = newBridge();
    const frame = await buildSignedDecisionFrame({
      requestId: "appr_unknown",
      decision: "approve",
      approverPrivateKeyHex: approver.privateKeyHex,
    });
    await expect(bridge.handleFrame(frame)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("unknown request"));
  });

  it("ignores frames of unrelated types without throwing", async () => {
    const bridge = newBridge();
    await expect(bridge.handleFrame({ type: "notification" })).resolves.toBeUndefined();
    await expect(bridge.handleFrame(null)).resolves.toBeUndefined();
  });

  it("pruneExpired removes stale pending requests that never received a decision", async () => {
    const bridge = newBridge();
    await bridge.publishRequest(newRequest({ expiresAt: new Date(Date.now() + 10).toISOString() }));
    bridge.pruneExpired(Date.now() + 20);
    expect(bridge.hasPending("appr_1")).toBe(false);
  });
});
