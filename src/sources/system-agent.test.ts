import { describe, it, expect, vi } from "vitest";
import { createSystemAgentSource, type GatewayApprovalsClient, type SystemAgentApprovalRequestRecord } from "./system-agent.js";

function makeRecord(overrides: Partial<SystemAgentApprovalRequestRecord> = {}): SystemAgentApprovalRequestRecord {
  return {
    id: "system-agent:abc123",
    request: {
      title: "OpenClaw change",
      description: "Restart the gateway to load the updated plugin",
      command: "gateway restart",
      proposalHash: "a".repeat(64),
      allowedDecisions: ["allow-once", "deny"],
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 600_000,
    ...overrides,
  };
}

function makeClient(): {
  client: GatewayApprovalsClient;
  fns: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    resolve: ReturnType<typeof vi.fn>;
    onRequested: ReturnType<typeof vi.fn>;
  };
} {
  const fns = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    resolve: vi.fn().mockResolvedValue({ applied: true }),
    onRequested: vi.fn(),
  };
  return { client: fns as unknown as GatewayApprovalsClient, fns };
}

describe("createSystemAgentSource", () => {
  it("has id \"system-agent\" and onDriftPolicy \"leave\" (#24 parity)", () => {
    const { client } = makeClient();
    const source = createSystemAgentSource(client);
    expect(source.id).toBe("system-agent");
    expect(source.onDriftPolicy).toBe("leave");
  });

  it("list() maps records to namespaced ApprovalSourceRequest entries", async () => {
    const { client, fns } = makeClient();
    fns.list.mockResolvedValue([makeRecord()]);
    const source = createSystemAgentSource(client);

    const requests = await source.list();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      proposalId: "system-agent:abc123",
      kind: "system-agent:restart",
      contentHash: "a".repeat(64),
    });
    expect(requests[0].detail).toBeUndefined();
  });

  it("subscribe() forwards live openclaw.approval.requested records, namespaced", () => {
    const { client, fns } = makeClient();
    const source = createSystemAgentSource(client);
    const onRequested = vi.fn();
    source.subscribe(onRequested);

    const handler = fns.onRequested.mock.calls[0][0];
    handler(makeRecord({ id: "system-agent:xyz" }));

    expect(onRequested).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: "system-agent:xyz", kind: "system-agent:restart" }),
    );
  });

  it("getCurrent() maps a pending snapshot", async () => {
    const { client, fns } = makeClient();
    fns.get.mockResolvedValue({ status: "pending", presentation: { proposalHash: "h" } });
    const source = createSystemAgentSource(client);

    await expect(source.getCurrent("id-1")).resolves.toEqual({ pending: true, contentHash: "h" });
  });

  it("getCurrent() returns null when the Gateway has no record of the proposal", async () => {
    const { client, fns } = makeClient();
    fns.get.mockResolvedValue(null);
    const source = createSystemAgentSource(client);

    await expect(source.getCurrent("id-1")).resolves.toBeNull();
  });

  it("resolve() maps approve/reject to allow-once/deny", async () => {
    const { client, fns } = makeClient();
    const source = createSystemAgentSource(client);

    await source.resolve("id-1", "approve", "h");
    expect(fns.resolve).toHaveBeenCalledWith("id-1", "allow-once");

    await source.resolve("id-1", "reject", "h");
    expect(fns.resolve).toHaveBeenCalledWith("id-1", "deny");
  });
});
