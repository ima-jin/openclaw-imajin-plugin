import { describe, it, expect, vi, beforeEach } from "vitest";

// `openclaw` is an optional peerDependency not installed in this repo's dev
// environment — mocked the same way skill-workshop.live-wiring.test.ts does.
interface CapturedGatewayOptions {
  onEvent: (evt: { event: string; payload?: unknown }) => void;
  onHelloOk: () => void;
}
const gatewayMock = vi.hoisted(() => ({
  options: undefined as unknown as CapturedGatewayOptions,
  pending: [] as unknown[],
  client: { request: vi.fn(), stop: vi.fn() },
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  createOperatorApprovalsGatewayClient: vi.fn(async (options: CapturedGatewayOptions) => {
    gatewayMock.options = options;
    return gatewayMock.client;
  }),
  startGatewayClientWhenEventLoopReady: vi.fn().mockResolvedValue({ ready: true }),
}));

import { GatewayApprovalsBridge } from "../gateway-approvals-bridge.js";
import {
  GATEWAY_EXEC_KIND,
  createGatewayExecSource,
  createLiveGatewayExecConnection,
  type GatewayExecApprovalRecord,
} from "./gateway-exec.js";

const OPERATOR_DID = "did:imajin:operator";
const AGENT_DID = "did:imajin:agent";
const QUIET_LOGGER = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeRecord(id: string, host: string): GatewayExecApprovalRecord {
  return {
    id,
    request: {
      command: "echo hi",
      host,
      cwd: "/tmp",
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:1",
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 1_800_000,
  };
}

/** Wires the real live connection + source + bridge against the mocked Gateway socket. */
async function startRail(onReconnected?: () => void) {
  const live = await createLiveGatewayExecConnection(
    { runtime: { config: { current: () => ({}) } } },
    { clientDisplayName: "test", onReconnected },
  );
  await live.start();
  const kernel = {
    publishApprovalRequested: vi.fn().mockResolvedValue(undefined),
    publishMismatch: vi.fn().mockResolvedValue(undefined),
  };
  const bridge = new GatewayApprovalsBridge(
    { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: "11".repeat(32) },
    new Map([["gateway-exec", createGatewayExecSource(live.client, { agentDid: AGENT_DID })]]),
    kernel,
    QUIET_LOGGER,
  );
  return { bridge, kernel };
}

function emitRequested(record: GatewayExecApprovalRecord): void {
  gatewayMock.options.onEvent({ event: "exec.approval.requested", payload: record });
}

describe("ask-gated exec rail (#52), mocked Gateway", () => {
  beforeEach(() => {
    gatewayMock.pending = [];
    gatewayMock.client.request.mockReset().mockImplementation(async () => gatewayMock.pending);
  });

  it.each([["auto"], ["gateway"]])(
    "a host=%s ask-gated exec produces exactly one forwarded gateway-exec:command card",
    async (host) => {
      const { bridge, kernel } = await startRail();
      const record = makeRecord(`approval-${host}`, host);

      // The live broadcast, a duplicate broadcast, and a racing reconcile all
      // describe the same pending approval.
      gatewayMock.pending = [record];
      emitRequested(record);
      emitRequested(record);
      await bridge.reconcile();
      await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1));

      expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
      const card = kernel.publishApprovalRequested.mock.calls[0][0];
      expect(card).toMatchObject({ proposalId: record.id, source: "gateway-exec", kind: GATEWAY_EXEC_KIND });
      expect(card.detail).toMatchObject({ command: "echo hi", host, approvalId: record.id });
    },
  );

  it("an approval missed while the socket was down is picked up by the post-reconnect reconcile", async () => {
    const onReconnected = vi.fn();
    const { bridge, kernel } = await startRail(onReconnected);

    gatewayMock.options.onHelloOk();
    expect(onReconnected).not.toHaveBeenCalled();
    gatewayMock.options.onHelloOk();
    expect(onReconnected).toHaveBeenCalledTimes(1);

    gatewayMock.pending = [makeRecord("missed", "auto")];
    await bridge.reconcile();
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
  });

  it("a malformed exec.approval.requested payload is logged loudly once, not dropped silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { kernel } = await startRail();

    gatewayMock.options.onEvent({ event: "exec.approval.requested", payload: { id: "x", request: { argv: ["ls"] } } });
    gatewayMock.options.onEvent({ event: "exec.approval.requested", payload: { id: "y", request: {} } });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/will NOT appear on \/jin/);
    expect(String(warn.mock.calls[0][0])).toContain("request.keys=[argv]");
    expect(kernel.publishApprovalRequested).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
