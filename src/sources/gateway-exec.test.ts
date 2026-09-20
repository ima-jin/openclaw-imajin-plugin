import { describe, it, expect, vi } from "vitest";
import {
  createGatewayExecSource,
  createHttpKernelExecOutcomeClient,
  wireGatewayExecOutcomeReporting,
  GATEWAY_EXEC_KIND,
  type GatewayExecApprovalRecord,
  type GatewayExecApprovalsClient,
  type GatewayExecOutcome,
} from "./gateway-exec.js";
import type { ApprovalDecision } from "./types.js";

const AGENT_DID = "did:imajin:agent";

function makeRecord(overrides: Partial<GatewayExecApprovalRecord> = {}): GatewayExecApprovalRecord {
  return {
    id: "exec-approval-1",
    request: {
      command: "rm -rf /tmp/build && echo done\nls -la",
      commandArgv: ["bash", "-c", "rm -rf /tmp/build && echo done"],
      cwd: "/home/agent/project",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123",
      allowedDecisions: ["allow-once", "deny"],
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 1_800_000,
    ...overrides,
  };
}

function makeClient(): {
  client: GatewayExecApprovalsClient;
  fns: {
    list: ReturnType<typeof vi.fn>;
    resolve: ReturnType<typeof vi.fn>;
    onRequested: ReturnType<typeof vi.fn>;
    onFinished: ReturnType<typeof vi.fn>;
  };
} {
  const fns = {
    list: vi.fn().mockResolvedValue([]),
    resolve: vi.fn().mockResolvedValue({ applied: true }),
    onRequested: vi.fn(),
    onFinished: vi.fn(),
  };
  return { client: fns as unknown as GatewayExecApprovalsClient, fns };
}

describe("createGatewayExecSource", () => {
  it('has id "gateway-exec", onDriftPolicy "leave", and Allow once/Deny decision labels', () => {
    const { client } = makeClient();
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });
    expect(source.id).toBe("gateway-exec");
    expect(source.onDriftPolicy).toBe("leave");
    expect(source.decisionLabels).toEqual({ approve: "Allow once", reject: "Deny" });
  });

  it("list() maps records to the literal exec.command kind with a verbatim, untruncated detail.command", async () => {
    const { client, fns } = makeClient();
    const record = makeRecord();
    fns.list.mockResolvedValue([record]);
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });

    const requests = await source.list();

    expect(requests).toHaveLength(1);
    expect(requests[0].proposalId).toBe("exec-approval-1");
    expect(requests[0].kind).toBe("exec.command");
    expect(requests[0].kind).toBe(GATEWAY_EXEC_KIND);
    // Never namespaced "gateway-exec:..." — see module doc.
    expect(requests[0].kind.includes(":")).toBe(false);
    expect(requests[0].detail).toEqual({
      command: record.request.command,
      host: "gateway",
      cwd: "/home/agent/project",
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123",
      requestedBy: AGENT_DID,
      approvalId: "exec-approval-1",
      expiresAt: new Date(record.expiresAtMs).toISOString(),
    });
    // Chains and multiline structure survive intact — never sanitized/rewritten here.
    expect(requests[0].detail?.command).toBe("rm -rf /tmp/build && echo done\nls -la");
  });

  it("list() defaults host to \"gateway\" when the record omits it", async () => {
    const { client, fns } = makeClient();
    fns.list.mockResolvedValue([makeRecord({ request: { ...makeRecord().request, host: undefined } })]);
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });

    const [request] = await source.list();
    expect(request.detail?.host).toBe("gateway");
  });

  it("list() ignores malformed records (missing command/id/expiresAtMs)", async () => {
    const { client, fns } = makeClient();
    fns.list.mockResolvedValue([
      { id: "", request: { command: "ls" }, createdAtMs: 1, expiresAtMs: 2 },
      { id: "ok", request: {}, createdAtMs: 1, expiresAtMs: 2 },
      { id: "ok2", request: { command: "ls" }, createdAtMs: 1 },
      makeRecord({ id: "valid" }),
    ]);
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });

    const requests = await source.list();
    expect(requests.map((r) => r.proposalId)).toEqual(["valid"]);
  });

  it("subscribe() forwards live exec.approval.requested records", () => {
    const { client, fns } = makeClient();
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });
    const onRequested = vi.fn();
    source.subscribe(onRequested);

    const handler = fns.onRequested.mock.calls[0][0];
    handler(makeRecord({ id: "exec-approval-2" }));

    expect(onRequested).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: "exec-approval-2", kind: "exec.command" }),
    );
  });

  it("subscribe() drops a malformed record without invoking onRequested", () => {
    const { client, fns } = makeClient();
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });
    const onRequested = vi.fn();
    source.subscribe(onRequested);

    const handler = fns.onRequested.mock.calls[0][0];
    handler({ id: "", request: {} });

    expect(onRequested).not.toHaveBeenCalled();
  });

  it("getCurrent() reports pending:true with the current detail for a still-pending approval", async () => {
    const { client, fns } = makeClient();
    const record = makeRecord();
    fns.list.mockResolvedValue([record]);
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });

    const current = await source.getCurrent("exec-approval-1");
    expect(current?.pending).toBe(true);
    expect(current?.sourceRevision).toBe(`exec-approval-1:${record.expiresAtMs}`);
    expect(current?.detail?.command).toBe(record.request.command);
  });

  it("getCurrent() reports pending:false for an unknown/already-resolved/expired approval", async () => {
    const { client, fns } = makeClient();
    fns.list.mockResolvedValue([]);
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });

    await expect(source.getCurrent("exec-approval-1")).resolves.toEqual({ pending: false, sourceRevision: null });
  });

  it("resolve() maps approve -> allow-once and reject -> deny, never allow-always", async () => {
    const { client, fns } = makeClient();
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });

    await source.resolve("exec-approval-1", "approve", "rev");
    expect(fns.resolve).toHaveBeenCalledWith("exec-approval-1", "allow-once");

    await source.resolve("exec-approval-1", "reject", "rev");
    expect(fns.resolve).toHaveBeenCalledWith("exec-approval-1", "deny");

    expect(fns.resolve).not.toHaveBeenCalledWith(expect.anything(), "allow-always");
  });

  it("resolve() is exhaustive over ApprovalDecision and never reaches allow-always for any input", async () => {
    const { client } = makeClient();
    const source = createGatewayExecSource(client, { agentDid: AGENT_DID });
    const decisions: ApprovalDecision[] = ["approve", "reject"];
    for (const decision of decisions) {
      await expect(source.resolve("id", decision, "rev")).resolves.toBeDefined();
    }
    // Any value outside the ApprovalDecision union throws rather than reaching resolve().
    await expect(
      source.resolve("id", "allow-always" as unknown as ApprovalDecision, "rev"),
    ).rejects.toThrow(/unsupported decision/);
  });
});

describe("createHttpKernelExecOutcomeClient", () => {
  const outcome: GatewayExecOutcome = {
    approvalId: "exec-approval-1",
    exitCode: 0,
    durationMs: 4200,
    outputHash: "sha256:" + "a".repeat(64),
  };

  it("POSTs the outcome to /notify/api/send with the webhook secret and operator.approval.exec.outcome scope", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    const client = createHttpKernelExecOutcomeClient({
      nodeUrl: "https://jin.example/",
      webhookSecret: "secret-1",
      operatorDid: "did:imajin:operator",
    });

    await client.publishExecOutcome(outcome);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://jin.example/notify/api/send",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-webhook-secret": "secret-1" }),
      }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({
      to: "did:imajin:operator",
      scope: "operator.approval.exec.outcome",
      data: outcome,
    });
    vi.unstubAllGlobals();
  });

  it("throws when the kernel responds with a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }));
    const client = createHttpKernelExecOutcomeClient({
      nodeUrl: "https://jin.example",
      webhookSecret: "secret-1",
      operatorDid: "did:imajin:operator",
    });

    await expect(client.publishExecOutcome(outcome)).rejects.toThrow(/failed \(500\)/);
    vi.unstubAllGlobals();
  });
});

describe("wireGatewayExecOutcomeReporting", () => {
  it("publishes an outcome reported by the client's onFinished handler", () => {
    const { client, fns } = makeClient();
    const kernel = { publishExecOutcome: vi.fn().mockResolvedValue(undefined) };
    wireGatewayExecOutcomeReporting(client, kernel);

    const handler = fns.onFinished.mock.calls[0][0];
    const outcome: GatewayExecOutcome = {
      approvalId: "exec-approval-1",
      exitCode: 1,
      durationMs: 100,
      outputHash: "sha256:" + "b".repeat(64),
    };
    handler(outcome);

    expect(kernel.publishExecOutcome).toHaveBeenCalledWith(outcome);
  });

  it("logs, never throws, when publishing the outcome fails", async () => {
    const { client, fns } = makeClient();
    const kernel = { publishExecOutcome: vi.fn().mockRejectedValue(new Error("network down")) };
    const logger = { error: vi.fn() };
    wireGatewayExecOutcomeReporting(client, kernel, logger);

    const handler = fns.onFinished.mock.calls[0][0];
    handler({ approvalId: "exec-approval-1", exitCode: null, durationMs: 1, outputHash: "sha256:" + "c".repeat(64) });

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("exec-approval-1")));
  });
});
