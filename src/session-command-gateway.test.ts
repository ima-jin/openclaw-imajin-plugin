import { describe, expect, it, vi } from "vitest";
import { createSessionGateway, SESSION_GATEWAY_SCOPES } from "./session-command-gateway.js";

describe("createSessionGateway", () => {
  it("archives and labels existing records without ever deleting a session or transcript", async () => {
    const row = { key: "k", sessionId: "s", archived: false, label: "before" };
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "sessions.list") return { sessions: [row] };
      if (method === "sessions.patch") Object.assign(row, params);
      return {};
    });
    const gateway = createSessionGateway(request);
    await gateway.label({ sessionKey: "k", label: "after" });
    expect(request).toHaveBeenCalledWith("sessions.patch", { key: "k", expectedSessionId: "s", label: "after" });
    await gateway.archive({ sessionKey: "k" });
    expect(request).toHaveBeenCalledWith("sessions.patch", { key: "k", expectedSessionId: "s", archived: true });
    expect(row).toMatchObject({ sessionId: "s", archived: true, label: "after" });
    expect(request.mock.calls.some(([method]) => method === "sessions.delete")).toBe(false);
  });

  it.each(["archive", "label"] as const)("rejects %s for nonexistent or archived sessions before patch can create a row", async (operation) => {
    for (const sessions of [[], [{ key: "k", sessionId: "s", archived: true }], [{ key: "k" }]]) {
      const request = vi.fn(async () => ({ sessions }));
      await expect(createSessionGateway(request)[operation]({ sessionKey: "k", label: "new" })).rejects.toMatchObject({ reason: "session_not_found" });
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects reset with a static scope failure and never escalates the production connection", async () => {
    const request = vi.fn();
    await expect(createSessionGateway(request).reset({ sessionKey: "k" })).rejects.toMatchObject({
      reason: "missing_scope", message: expect.stringContaining("requires operator.admin"),
    });
    expect(request).not.toHaveBeenCalled();
    expect(SESSION_GATEWAY_SCOPES).toEqual(["operator.write", "operator.approvals"]);
  });

  it("maps reset on an already authorized fake client, with an existence and replacement guard", async () => {
    const request = vi.fn(async (method: string) => method === "sessions.list" ? { sessions: [{ key: "k", sessionId: "s" }] } : {});
    await createSessionGateway(request, ["operator.admin"]).reset({ sessionKey: "k" });
    expect(request).toHaveBeenLastCalledWith("sessions.reset", { key: "k", expectedSessionId: "s", reason: "reset" });
  });

  it("paginates the entire cross-agent inventory, including archived rows and non-dashboard channels", async () => {
    const first = Array.from({ length: 200 }, (_, n) => ({ key: `agent:a:thread-${n}` }));
    const request = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
      sessions: params.offset === 0 ? first : [{ key: "agent:b:telegram:direct:1" }, { key: "agent:b:warp-events", archived: true }],
    }));
    expect(await createSessionGateway(request).list()).toHaveLength(202);
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      limit: 200, offset: 200, archived: "all", includeGlobal: true, includeUnknown: true,
    });
  });

  it("subscribes to change events and asks only for bounded recent history", async () => {
    const messages = Array.from({ length: 30 }, (_, n) => ({ role: "user", content: `${n}` }));
    const request = vi.fn(async () => ({ messages }));
    const gateway = createSessionGateway(request);
    await gateway.subscribe();
    expect(request).toHaveBeenCalledWith("sessions.subscribe", {});
    expect(await gateway.history("k")).toEqual(messages.slice(-20));
    expect(request).toHaveBeenCalledWith("chat.history", { sessionKey: "k", limit: 20, maxBytes: 65536 });
  });

  it("fails closed for malformed Gateway read responses", async () => {
    const gateway = createSessionGateway(vi.fn(async () => ({})));
    await expect(gateway.list()).rejects.toThrow("invalid sessions.list");
    await expect(gateway.history("k")).rejects.toThrow("invalid chat.history");
  });
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
      group: "operators",
      model: "imajin/model",
      idempotencyKey: "cmd-7",
    });
    expect(request).toHaveBeenCalledWith("sessions.create", {
      task: "do the thing",
      idempotencyKey: "cmd-7",
      parentSessionKey: "agent:main:main",
      label: "thing",
      agentId: "ops",
      group: "operators",
      model: "imajin/model",
    });
    expect(result).toEqual({ sessionKey: "agent:main:child-7" });
  });
});
