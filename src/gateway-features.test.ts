import { afterEach, describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerGatewayFeatures } from "./gateway-features.js";
import { RegistrationLifecycle } from "./registration-lifecycle.js";
import { signMessage, verifyMessage } from "./approval-bridge.js";
import { buildSessionCommandBody, signSessionCommandBody } from "./session-commands.js";
import { ImajinClient } from "./client.js";
import type { ImajinWsService } from "./ws-service.js";
import type { LoopLifecycle } from "./loop-hooks.js";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), startBridge: vi.fn() }));
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({ resolveApprovalOverGateway: mocks.resolve }));
vi.mock("./gateway-approvals-bridge.js", () => ({ startGatewayApprovalsBridge: mocks.startBridge }));

const lifecycles: RegistrationLifecycle[] = [];
afterEach(() => {
  for (const lifecycle of lifecycles.splice(0)) lifecycle.dispose();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("shared gateway features", () => {
  it.each(["legacy", "sealed"])("preserves verified approval resolution and shared session claims with %s signing", async (mode) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const privateKey = ed.utils.randomPrivateKey();
    const privateHex = Buffer.from(privateKey).toString("hex");
    const publicHex = Buffer.from(await ed.getPublicKeyAsync(privateKey)).toString("hex");
    const did = "did:imajin:gateway";
    const dir = await mkdtemp(join(tmpdir(), "gateway-features-"));
    const keypairPath = join(dir, "ephemeral.json");
    if (mode === "legacy") await writeFile(keypairPath, JSON.stringify({ did, privateKey: privateHex }), { mode: 0o600 });
    const signer = {
      did, signChallenge: async (message: string) =>
        Buffer.from(await ed.signAsync(new TextEncoder().encode(message), privateKey)).toString("hex"),
    };
    const client = new ImajinClient({ nodeUrl: "https://kernel.invalid", did, signer });
    vi.spyOn(client, "getServiceOf").mockResolvedValue(["did:imajin:operator"]);
    vi.spyOn(client, "getIdentity").mockResolvedValue({
      did: "did:imajin:operator", scope: "actor", subtype: "human", publicKey: publicHex,
    });
    const send = vi.fn();
    const socket = { send, onConnected: vi.fn() };
    const gatewayResolve = vi.fn(async () => ({ applied: true, kind: "exec" }));
    const lifecycle = new RegistrationLifecycle();
    lifecycles.push(lifecycle);
    mocks.startBridge.mockResolvedValue(undefined);
    mocks.resolve.mockResolvedValue({ applied: true, approval: { status: "allowed" } });
    const features = registerGatewayFeatures({ config: {} }, {
      nodeUrl: "https://kernel.invalid", did,
      ...(mode === "legacy" ? { keypairPath } : { signer, keypairPath: "/must-not-read" }),
      approvalBridge: { pinnedApproverPublicKeyHex: publicHex },
      sessionCommands: { enabled: true, kernelPublicKeyHex: publicHex },
    }, client, socket as unknown as ImajinWsService, lifecycle, {
      loopLifecycle: { tracker: {} } as LoopLifecycle,
      sessionGateway: { gateway: { resolveApproval: gatewayResolve } } as any,
    });
    await features.approvalBridge!.publishRequest({
      requestId: "native", requesterDid: did, kind: "exec", summary: "test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await verifyMessage(send.mock.calls[0][0].attestation, publicHex)).toBe(true);
    const attestation = await signMessage({ requestId: "native", decision: "approve" }, {
      did: "did:imajin:operator", type: "human", privateKeyHex: privateHex,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    features.handleFrame({
      type: "approval.decision", requestId: "native",
      attestation: { ...attestation, payload: { requestId: "native", decision: "reject" } },
    });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(mocks.resolve).not.toHaveBeenCalled();
    features.handleFrame({ type: "approval.decision", requestId: "native", attestation });
    await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledOnce());
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "native", approvalKind: "exec", decision: "allow-once",
    }));
    const frame: any = {
      type: "session.approve", commandId: "command", to: did, principal: "did:imajin:operator",
      issuer: "did:imajin:kernel", issuedAt: new Date().toISOString(), payload: { approvalId: "native" },
    };
    frame.signature = await signSessionCommandBody(buildSessionCommandBody(frame), privateHex);
    frame.countersignature = frame.signature;
    features.handleFrame(frame);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0].attestation.payload.reason).toBe("approval_already_executed");
    expect(await verifyMessage(send.mock.calls[1][0].attestation, publicHex)).toBe(true);
    expect(gatewayResolve).not.toHaveBeenCalled();
    lifecycle.dispose();
    expect(features.handleFrame(frame)).toBe(false);
  });

  it("requires loop tracking for legacy commands and never constructs a new command-only gateway", () => {
    const lifecycle = new RegistrationLifecycle();
    lifecycles.push(lifecycle);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.startBridge.mockResolvedValue(undefined);
    const features = registerGatewayFeatures({}, {
      nodeUrl: "https://kernel.invalid", did: "did:imajin:legacy", keypairPath: "/must-not-read",
      sessionCommands: { enabled: true, kernelPublicKeyHex: "public-only" },
    }, {} as ImajinClient, { onConnected: vi.fn() } as unknown as ImajinWsService, lifecycle);
    expect(warn).toHaveBeenCalledOnce();
    expect(features.handleFrame({ type: "session.send" })).toBe(false);
    for (const frame of [null, {}, 1, { type: "unknown" }]) expect(features.handleFrame(frame)).toBe(false);
  });
});
