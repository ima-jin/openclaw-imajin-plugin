import { describe, expect, it, vi } from "vitest";
import { createSessionGateway } from "./session-command-gateway.js";

describe("createSessionGateway", () => {
  it("send -> chat.send with the command id as idempotency key", async () => {
    const request = vi.fn(async () => ({ runId: "run-1", status: "started" }));
    const result = await createSessionGateway(request).send({
      sessionKey: "agent:main:main",
      message: "hi",
      idempotencyKey: "cmd-1",
    });
    expect(request).toHaveBeenCalledWith("chat.send", {
      sessionKey: "agent:main:main",
      message: "hi",
      idempotencyKey: "cmd-1",
    });
    expect(result).toEqual({ runId: "run-1" });
  });

  it("send includes agentId only when given", async () => {
    const request = vi.fn(async () => ({}));
    await createSessionGateway(request).send({ sessionKey: "k", message: "m", agentId: "ops", idempotencyKey: "i" });
    expect(request).toHaveBeenCalledWith("chat.send", expect.objectContaining({ agentId: "ops" }));
  });

  it("abort -> chat.abort; aborted:false means nothing was running", async () => {
    const request = vi.fn(async () => ({ ok: true, aborted: false }));
    const gateway = createSessionGateway(request);
    expect(await gateway.abort({ sessionKey: "k", runId: "r" })).toEqual({ aborted: false });
    expect(request).toHaveBeenCalledWith("chat.abort", { sessionKey: "k", runId: "r" });
    request.mockResolvedValueOnce({ ok: true, aborted: true });
    expect(await gateway.abort({ sessionKey: "k" })).toEqual({ aborted: true });
    expect(request).toHaveBeenLastCalledWith("chat.abort", { sessionKey: "k" });
  });

  it("resolveApproval with a stated kind targets exactly that namespace", async () => {
    const request = vi.fn(async () => ({ applied: true }));
    const gateway = createSessionGateway(request);
    expect(await gateway.resolveApproval({ id: "a", kind: "plugin", decision: "deny" })).toEqual({
      applied: true,
      kind: "plugin",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("plugin.approval.resolve", { id: "a", decision: "deny" });
  });

  it("resolveApproval without a kind tries exec, then plugin", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "exec.approval.resolve") throw new Error("unknown approval id");
      return { applied: true };
    });
    const result = await createSessionGateway(request).resolveApproval({ id: "p-1", decision: "allow-once" });
    expect(result).toEqual({ applied: true, kind: "plugin" });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "exec.approval.resolve",
      "plugin.approval.resolve",
    ]);
  });

  it("resolveApproval without a kind stops at exec when it applied", async () => {
    const request = vi.fn(async () => ({ applied: true }));
    const result = await createSessionGateway(request).resolveApproval({ id: "e-1", decision: "allow-once" });
    expect(result).toEqual({ applied: true, kind: "exec" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never sends allow-always or admin-scope session params", async () => {
    const request = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({ key: "child" }));
    const gateway = createSessionGateway(request);
    await gateway.spawn({ task: "t", idempotencyKey: "i" });
    const params = request.mock.calls[0][1];
    for (const forbidden of ["permissionMode", "toolOverrides", "execNode", "incognito"]) {
      expect(params).not.toHaveProperty(forbidden);
    }
  });

  it("spawn -> sessions.create with parent lineage; returns the created key", async () => {
    const request = vi.fn(async () => ({ key: "agent:main:child-7" }));
    const result = await createSessionGateway(request).spawn({
      task: "do the thing",
      parentSessionKey: "agent:main:main",
      label: "thing",
      agentId: "ops",
      idempotencyKey: "cmd-7",
    });
    expect(request).toHaveBeenCalledWith("sessions.create", {
      task: "do the thing",
      idempotencyKey: "cmd-7",
      parentSessionKey: "agent:main:main",
      label: "thing",
      agentId: "ops",
    });
    expect(result).toEqual({ sessionKey: "agent:main:child-7" });
  });
});
