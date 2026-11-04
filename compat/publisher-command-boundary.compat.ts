import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";
import { canonicalize } from "../src/approval-bridge.js";
import { createLoopSender, type LoopIngestRequest } from "../src/loop-publisher.js";
import { createLoopTracker } from "../src/loop-tracker.js";
import { GatewayApprovalsBridge } from "../src/gateway-approvals-bridge.js";
import { createGatewayExecSource } from "../src/sources/gateway-exec.js";

// Same seams as PR #3265's publisher-command-boundary.test.ts. Ingest,
// recognized-ref projection, origin authority and binding intake are REAL.
const mocks = vi.hoisted(() => ({
  verify: vi.fn(), authorize: vi.fn(), sql: vi.fn(), publish: vi.fn(),
  readProof: vi.fn(), resolver: vi.fn(), service: vi.fn(),
  append: vi.fn(), getEvent: vi.fn(),
}));
vi.mock("@imajin/db", () => ({ getClient: () => mocks.sql }));
vi.mock("@/src/db", () => ({ db: {}, identities: {} }));
vi.mock("@imajin/auth/resolve-db", () => ({ createDbResolver: () => mocks.resolver }));
vi.mock("@/src/lib/auth/agent-service", () => ({ listServiceOf: mocks.service }));
vi.mock("kernel/jin/session-command-store", () => ({
  readLoopCommandProof: mocks.readProof, appendSessionEvent: mocks.append,
  getSessionEvent: mocks.getEvent, persistSessionOutcome: vi.fn(),
  readBindingEvents: vi.fn(), readSessionLoopIdentity: vi.fn(),
}));
vi.mock("kernel/loops/verify-publisher-signature", () => ({ verifyLoopPublisherSignature: mocks.verify }));
vi.mock("kernel/loops/authorize-publisher", () => ({ authorizeLoopPublisher: mocks.authorize }));
vi.mock("@imajin/bus", () => ({ publish: mocks.publish }));
vi.mock("kernel/loops/surface-lease", () => ({
  projectSurfaceLease: vi.fn().mockResolvedValue(null), loopObservationId: () => "plugin-origin",
}));

// @ts-expect-error Alias supplied by this compatibility suite's config.
import { ingestLoopEvent } from "kernel/loops/ingest";
// @ts-expect-error Alias supplied by this compatibility suite's config.
import { kernelLoopRefs } from "kernel/loops/types";
// @ts-expect-error Alias supplied by this compatibility suite's config.
import { resolveSessionCommandTarget } from "kernel/jin/session-command-authority";
// @ts-expect-error Alias supplied by this compatibility suite's config.
import { ingestSessionCommandFrame } from "kernel/jin/session-command-intake";

const agent = "did:imajin:agent";
const key = randomBytes(32);
const publicKey = Buffer.from(await ed.getPublicKeyAsync(key)).toString("hex");
const signer = {
  did: agent, publicKey,
  signChallenge: async (message: string) =>
    Buffer.from(await ed.signAsync(new TextEncoder().encode(message), key)).toString("hex"),
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sql.mockResolvedValue([{ loop_id: "loop" }]);
  mocks.authorize.mockResolvedValue({ authorized: true });
  mocks.resolver.mockImplementation(async (did: string) => did === agent ? { publicKey } : null);
  mocks.service.mockResolvedValue(["did:imajin:personal", "did:imajin:org"]);
  mocks.append.mockResolvedValue(true);
  mocks.getEvent.mockResolvedValue(null);
  mocks.verify.mockImplementation(async (did: string, wire: object, signature: { sig: string }) => ({
    ok: did === agent && await ed.verifyAsync(Buffer.from(signature.sig, "hex"),
      new TextEncoder().encode(canonicalize(wire)), Buffer.from(publicKey, "hex")),
    error: "Invalid signature",
  }));
});

describe.each(["did:imajin:personal", "did:imajin:org"])("exact plugin / kernel boundary under %s", (principal) => {
  async function origin() {
    const requests: LoopIngestRequest[] = [];
    const sender = createLoopSender({
      did: agent, principal, signer, nodeUrl: "https://kernel.test",
      fetchImpl: vi.fn(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 201 });
      }),
    });
    const tracker = createLoopTracker({ did: agent, emit: sender.publish });
    tracker.onSessionStart({ sessionKey: "agent:main:local", sessionId: "session" });
    await sender.idle();
    const request = requests[0];
    expect(kernelLoopRefs(request.payload.refs)).toEqual(request.payload.refs);
    expect(await ingestLoopEvent(request)).toEqual({ ok: true });
    const published = mocks.publish.mock.calls[0][1].payload;
    expect(published.publisherProof).toEqual(request);
    expect(JSON.stringify(published)).not.toContain("sessionKey");
    mocks.readProof.mockResolvedValue({
      loop: { state: "running", parent_loop_id: null },
      proofs: [{ type: request.type, issuer: agent, proof: published.publisherProof }],
    });
    return { tracker, request, published };
  }

  it("preserves the exact origin and authorizes the plugin's native approvalId + loopId binding", async () => {
    const h = await origin();
    expect(await resolveSessionCommandTarget(h.request.payload.loopId, principal)).toBe(agent);
    const source = createGatewayExecSource({
      list: async () => [{
        id: "approval", createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
        request: { command: "printf approved", sessionKey: "agent:main:local" },
      }],
      onRequested: () => {}, onFinished: () => {}, resolve: vi.fn(),
    }, { agentDid: agent });
    const bind = vi.fn(async (attestation) => {
      expect(JSON.stringify(attestation)).not.toContain("sessionKey");
      expect(attestation.payload).toEqual({
        approvalId: "approval", loopId: h.request.payload.loopId, principalDid: principal, agentDid: agent,
      });
      expect(await ingestSessionCommandFrame(agent, { type: "loop.approval.bound", attestation }))
        .toEqual({ accepted: true, duplicate: false });
      await expect(ingestSessionCommandFrame("did:imajin:foreign", { type: "loop.approval.bound", attestation }))
        .rejects.toThrow("Socket publisher mismatch");
    });
    const bridge = new GatewayApprovalsBridge(
      { agentDid: agent, operatorDid: principal, agentSigner: signer },
      new Map([[source.id, source]]),
      { publishApprovalRequested: vi.fn(async () => {}), publishMismatch: vi.fn() },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, undefined, undefined,
      { loopTracker: h.tracker, publishApprovalBinding: bind, loopBlockSweepIntervalMs: 0 },
    );
    try {
      await bridge.reconcile();
      expect(bind).toHaveBeenCalledOnce();
      expect(mocks.append).toHaveBeenCalledOnce();
    } finally { bridge.dispose(); }
  });

  it.each(["tampered", "foreign-issuer"])("refuses %s origin evidence before native binding", async (failure) => {
    const h = await origin();
    if (failure === "tampered") h.published.publisherProof.payload.summary = "altered";
    else mocks.readProof.mockResolvedValue({
      loop: { state: "running", parent_loop_id: null },
      proofs: [{ type: h.request.type, issuer: "did:imajin:foreign", proof: h.published.publisherProof }],
    });
    await expect(resolveSessionCommandTarget(h.request.payload.loopId, principal)).rejects.toThrow();
    expect(mocks.append).not.toHaveBeenCalled();
  });
});
