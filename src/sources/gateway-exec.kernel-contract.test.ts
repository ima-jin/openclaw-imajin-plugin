import { describe, it, expect, vi } from "vitest";
import { GatewayApprovalsBridge, KernelNotifyError, type KernelNotifyClient } from "../gateway-approvals-bridge.js";
import {
  GATEWAY_EXEC_KIND,
  createGatewayExecSource,
  type GatewayExecApprovalRecord,
  type GatewayExecApprovalsClient,
} from "./gateway-exec.js";

/**
 * #52 root cause. The kernel (`ima-jin/imajin-ai`
 * `apps/kernel/src/lib/notify/exec-command-approvals.ts`,
 * `validateExecCommandDetail`, enforced on ingest by
 * `operator-approvals.ts`) rejects a `gateway-exec:command` card with 400
 * unless EVERY one of these `detail` fields is a non-empty string and
 * `requestedBy` is a DID. This is a read-only mirror of that contract; the
 * kernel is not changed by this repo.
 */
const KERNEL_REQUIRED_STRING_FIELDS = [
  "command",
  "host",
  "cwd",
  "agentId",
  "sessionKey",
  "requestedBy",
  "approvalId",
  "expiresAt",
] as const;

function kernelValidateExecDetail(detail: Record<string, unknown>): string | null {
  for (const field of KERNEL_REQUIRED_STRING_FIELDS) {
    const value = detail[field];
    if (typeof value !== "string" || value.length === 0) {
      return `detail.${field} is required and must be a non-empty string`;
    }
  }
  if (!(detail.requestedBy as string).startsWith("did:")) return "detail.requestedBy must be a DID (did:...)";
  if (Number.isNaN(Date.parse(detail.expiresAt as string))) return "detail.expiresAt must be a valid ISO 8601 timestamp";
  return null;
}

const OPERATOR_DID = "did:imajin:operator";
const AGENT_DID = "did:imajin:agent";
const QUIET_LOGGER = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeClient(records: GatewayExecApprovalRecord[]) {
  let requested: ((record: GatewayExecApprovalRecord) => void) | undefined;
  const client: GatewayExecApprovalsClient = {
    list: vi.fn(async () => records),
    resolve: vi.fn(async () => ({ applied: true })),
    onRequested: (handler) => {
      requested = handler;
    },
    onFinished: () => {},
  };
  return { client, emit: (record: GatewayExecApprovalRecord) => requested?.(record) };
}

/** What OpenClaw really sends for an exec with no explicit workdir / no agent+session binding: absent or null/empty fields. */
const SPARSE_REQUESTS: Array<[string, GatewayExecApprovalRecord["request"]]> = [
  ["cwd null", { command: "echo hi", host: "gateway", cwd: null, agentId: "main", sessionKey: "agent:main:s" }],
  ["cwd absent", { command: "echo hi", host: "gateway", agentId: "main", sessionKey: "agent:main:s" }],
  ["agentId null", { command: "echo hi", host: "gateway", cwd: "/tmp", agentId: null, sessionKey: "agent:main:s" }],
  ["sessionKey null", { command: "echo hi", host: "gateway", cwd: "/tmp", agentId: "main", sessionKey: null }],
  ["host null", { command: "echo hi", host: null, cwd: "/tmp", agentId: "main", sessionKey: "agent:main:s" }],
  ["host empty", { command: "echo hi", host: "", cwd: "/tmp", agentId: "main", sessionKey: "agent:main:s" }],
  ["cwd whitespace", { command: "echo hi", host: "gateway", cwd: "  ", agentId: "main", sessionKey: "s" }],
  ["everything optional absent", { command: "echo hi" }],
];

describe("gateway-exec card satisfies the kernel's exec detail contract (#52)", () => {
  it.each(SPARSE_REQUESTS)("%s -> a card the kernel accepts", async (_label, request) => {
    const record: GatewayExecApprovalRecord = {
      id: "approval-1",
      request,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    const { client } = makeClient([record]);
    const [card] = await createGatewayExecSource(client, { agentDid: AGENT_DID }).list();

    expect(card.kind).toBe(GATEWAY_EXEC_KIND);
    expect(kernelValidateExecDetail(card.detail ?? {})).toBeNull();
    // The verbatim command is never altered by the fallbacks.
    expect(card.detail?.command).toBe("echo hi");
  });

  it("does not invent values: real fields pass through untouched", async () => {
    const record: GatewayExecApprovalRecord = {
      id: "approval-2",
      request: { command: "ls", host: "node-7", cwd: "/srv", agentId: "ops", sessionKey: "agent:ops:1" },
      createdAtMs: 1,
      expiresAtMs: Date.now() + 60_000,
    };
    const { client } = makeClient([record]);
    const [card] = await createGatewayExecSource(client, { agentDid: AGENT_DID }).list();
    expect(card.detail).toMatchObject({ host: "node-7", cwd: "/srv", agentId: "ops", sessionKey: "agent:ops:1" });
  });

  it("the bridge publishes a card the kernel accepts for a sparse request (end to end, kernel mock enforces the contract)", async () => {
    const record: GatewayExecApprovalRecord = {
      id: "approval-3",
      request: { command: "echo hi", cwd: null, agentId: null, sessionKey: null },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    const { client, emit } = makeClient([record]);
    const kernel: KernelNotifyClient = {
      publishApprovalRequested: vi.fn(async (payload) => {
        const problem = kernelValidateExecDetail(payload.detail);
        if (problem) throw new KernelNotifyError(400, `kernel notify operator.approval.requested failed (400): ${problem}`);
      }),
      publishMismatch: vi.fn().mockResolvedValue(undefined),
    };
    new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: "11".repeat(32) },
      new Map([["gateway-exec", createGatewayExecSource(client, { agentDid: AGENT_DID })]]),
      kernel,
      QUIET_LOGGER,
    );
    emit(record);
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1));
    await expect(vi.mocked(kernel.publishApprovalRequested).mock.results[0].value).resolves.toBeUndefined();
    expect(client.resolve).not.toHaveBeenCalled();
  });
});

describe("a gateway-exec card that cannot be published fails loud, not silent (#52)", () => {
  function setup(opts: { publish: () => Promise<void>; notify?: (text: string) => Promise<void> }) {
    const record: GatewayExecApprovalRecord = {
      id: "approval-fail",
      request: { command: "rm -rf /secret-command-text", host: "gateway", cwd: "/tmp", agentId: "main", sessionKey: "s" },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    const { client, emit } = makeClient([record]);
    const kernel: KernelNotifyClient = {
      publishApprovalRequested: vi.fn(opts.publish),
      publishMismatch: vi.fn().mockResolvedValue(undefined),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const notify = vi.fn(opts.notify ?? (async () => {}));
    const bridge = new GatewayApprovalsBridge(
      { operatorDid: OPERATOR_DID, agentDid: AGENT_DID, agentPrivateKeyHex: "11".repeat(32) },
      new Map([["gateway-exec", createGatewayExecSource(client, { agentDid: AGENT_DID })]]),
      kernel,
      logger,
      undefined,
      notify,
      { publishRetryDelaysMs: [0, 0] },
    );
    return { bridge, client, emit, kernel, logger, notify, record };
  }

  it("denies the pending gateway approval (clean refusal, no wait-until-SIGTERM) and tells the operator, without leaking the command", async () => {
    const { client, emit, kernel, logger, notify, bridge } = setup({
      publish: async () => {
        throw new KernelNotifyError(400, "kernel notify operator.approval.requested failed (400): detail.cwd is required");
      },
    });
    emit({
      id: "approval-fail",
      request: { command: "rm -rf /secret-command-text", host: "gateway", cwd: "/tmp", agentId: "main", sessionKey: "s" },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });

    await vi.waitFor(() => expect(client.resolve).toHaveBeenCalledWith("approval-fail", "deny"));
    // 400 is deterministic: not retried.
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(1);
    expect(bridge.isPublished("approval-fail")).toBe(false);

    const errors = logger.error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errors).toMatch(/approval-fail/);
    expect(errors).toMatch(/denied/i);
    expect(errors).not.toContain("secret-command-text");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0]).toMatch(/approval-fail/);
    expect(notify.mock.calls[0][0]).not.toContain("secret-command-text");
  });

  const FAILING_RECORD: GatewayExecApprovalRecord = {
    id: "approval-fail",
    request: { command: "rm -rf /secret-command-text", host: "gateway", cwd: "/tmp", agentId: "main", sessionKey: "s" },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  };
  const rejectPublish = async () => {
    throw new KernelNotifyError(400, "kernel notify operator.approval.requested failed (400): detail.cwd is required");
  };

  it("does NOT report DENIED when the deny did not take effect (already resolved elsewhere, applied: false)", async () => {
    const { client, emit, logger, notify } = setup({ publish: rejectPublish });
    vi.mocked(client.resolve).mockResolvedValue({ applied: false });
    emit(FAILING_RECORD);

    await vi.waitFor(() => expect(client.resolve).toHaveBeenCalledWith("approval-fail", "deny"));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const errors = logger.error.mock.calls.map((c) => String(c[0])).join("\n");
    for (const text of [errors, String(notify.mock.calls[0][0])]) {
      expect(text).toMatch(/already resolved elsewhere/);
      expect(text).toMatch(/not denied by the bridge/);
      expect(text).not.toMatch(/DENIED/);
      expect(text).not.toContain("refusal");
      expect(text).not.toContain("secret-command-text");
    }
  });

  it("reports the deny as failed and left pending when resolve throws", async () => {
    const { client, emit, logger, notify } = setup({ publish: rejectPublish });
    vi.mocked(client.resolve).mockRejectedValue(new Error("gateway down"));
    emit(FAILING_RECORD);

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const text = String(notify.mock.calls[0][0]);
    expect(text).toMatch(/left pending/);
    expect(text).toMatch(/deny failed/);
    expect(text).not.toMatch(/DENIED/);
    expect(logger.error.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/could not deny/);
  });

  it("does not hold the publish reservation on a slow operator notify", async () => {
    const { bridge, client, emit, notify } = setup({
      publish: rejectPublish,
      notify: () => new Promise<void>(() => {}), // never settles
    });
    emit(FAILING_RECORD);

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    // A second event for the same proposal must not be parked behind the hung notify:
    // the reservation is released, so it is handled (and denied) for real.
    emit(FAILING_RECORD);
    await vi.waitFor(() => expect(client.resolve).toHaveBeenCalledTimes(2));
    expect(bridge.isPublished("approval-fail")).toBe(false);
  });

  it("logs (does not throw) when the operator notify itself fails", async () => {
    const { emit, logger, notify } = setup({
      publish: rejectPublish,
      notify: async () => {
        throw new Error("notify cli exploded");
      },
    });
    emit(FAILING_RECORD);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(logger.error.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/failed to notify the operator/),
    );
  });

  it("retries a transient (5xx / network) publish failure, then publishes with no deny", async () => {
    let calls = 0;
    const { client, emit, kernel } = setup({
      publish: async () => {
        calls += 1;
        if (calls < 3) throw new KernelNotifyError(503, "kernel notify operator.approval.requested failed (503): unavailable");
      },
    });
    emit({
      id: "approval-fail",
      request: { command: "echo hi", host: "gateway", cwd: "/tmp", agentId: "main", sessionKey: "s" },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });
    await vi.waitFor(() => expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(3));
    expect(client.resolve).not.toHaveBeenCalled();
  });

  it("denies after the retries are exhausted on a persistent transient failure", async () => {
    const { client, emit, kernel } = setup({
      publish: async () => {
        throw new TypeError("fetch failed");
      },
    });
    emit({
      id: "approval-fail",
      request: { command: "echo hi", host: "gateway", cwd: "/tmp", agentId: "main", sessionKey: "s" },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });
    await vi.waitFor(() => expect(client.resolve).toHaveBeenCalledWith("approval-fail", "deny"));
    expect(kernel.publishApprovalRequested).toHaveBeenCalledTimes(3);
  });
});
