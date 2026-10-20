import { describe, it, expect, vi, beforeEach } from "vitest";

// #35: `openclaw` is an optional peerDependency not installed in this repo's
// dev environment — mocked the same way `notification-injector.test.ts`
// mocks other plugin-sdk subpaths, so this file never needs the real
// (unpublished-in-this-repo) `openclaw` package resolvable on disk.
const fakeGatewayClient = {
  request: vi.fn(),
  stop: vi.fn(),
  stopAndWait: vi.fn(),
};
const createOperatorApprovalsGatewayClientMock = vi.hoisted(() => vi.fn());
const startGatewayClientWhenEventLoopReadyMock = vi.hoisted(() => vi.fn());
const createOperatorGatewayClientMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  createOperatorApprovalsGatewayClient: createOperatorApprovalsGatewayClientMock,
  startGatewayClientWhenEventLoopReady: startGatewayClientWhenEventLoopReadyMock,
}));
vi.mock("../gateway-operator-client.js", () => ({
  createOperatorGatewayClient: createOperatorGatewayClientMock,
}));

import { createLiveSkillWorkshopConnection, createLiveSkillWorkshopGatewayClient } from "./skill-workshop.js";

describe("createLiveSkillWorkshopGatewayClient", () => {
  it.each([undefined, "ops"])("wires inspect/list/apply/reject for agent %j", async (agentId) => {
    const inspected = { revisionHash: "top-level-revision", proposal: { revisionHash: "not-this-one" } };
    const request = vi.fn().mockImplementation(async (method) => {
      if (method === "skills.proposals.inspect") return inspected;
      if (method === "skills.proposals.list") return { proposals: [{ id: "p-1" }] };
      return { applied: true };
    });
    const client = createLiveSkillWorkshopGatewayClient({ request });
    const scope = agentId ? { agentId } : {};
    await expect(client.inspect!("p-1", agentId)).resolves.toBe(inspected);
    expect(request).toHaveBeenLastCalledWith("skills.proposals.inspect", { proposalId: "p-1", ...scope });
    await expect(client.list(agentId)).resolves.toEqual({ proposals: [{ id: "p-1" }] });
    expect(request).toHaveBeenLastCalledWith("skills.proposals.list", scope);
    await client.apply("p-1", "top-level-revision", agentId);
    expect(request).toHaveBeenLastCalledWith("skills.proposals.apply", {
      proposalId: "p-1", expectedRevisionHash: "top-level-revision", ...scope,
    });
    await client.reject("p-1", "top-level-revision", agentId);
    expect(request).toHaveBeenLastCalledWith("skills.proposals.reject", {
      proposalId: "p-1", expectedRevisionHash: "top-level-revision", ...scope,
    });
  });

  it("propagates inspect failures so the source can withhold only the affected proposal", async () => {
    const client = createLiveSkillWorkshopGatewayClient({
      request: vi.fn().mockRejectedValue(new Error("inspect failed")),
    });
    await expect(client.inspect!("p-1")).rejects.toThrow("inspect failed");
  });

  it("handles missing list/agent results and filters malformed agent ids", async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const client = createLiveSkillWorkshopGatewayClient({ request });
    await expect(client.list()).resolves.toEqual({ proposals: [] });
    await expect(client.listAgentIds!()).resolves.toEqual([]);
    request.mockResolvedValue({ agents: [{ id: "main" }, {}, { id: 2 }, { id: "ops" }] });
    await expect(client.listAgentIds!()).resolves.toEqual(["main", "ops"]);
    expect(request).toHaveBeenLastCalledWith("agents.list", {});
  });
});

describe("createLiveSkillWorkshopConnection", () => {
  beforeEach(() => {
    createOperatorApprovalsGatewayClientMock.mockReset().mockResolvedValue(fakeGatewayClient);
    createOperatorGatewayClientMock.mockReset().mockResolvedValue(fakeGatewayClient);
    startGatewayClientWhenEventLoopReadyMock.mockReset().mockResolvedValue({ ready: true });
    fakeGatewayClient.stop.mockReset();
  });

  const api = { runtime: { config: { current: () => ({}) } } };

  it("uses the SDK default client when operatorScopes is omitted", async () => {
    await createLiveSkillWorkshopConnection(api, { clientDisplayName: "skill-workshop" });

    expect(createOperatorApprovalsGatewayClientMock).toHaveBeenCalledTimes(1);
    expect(createOperatorGatewayClientMock).not.toHaveBeenCalled();
  });

  it("uses the SDK default client when operatorScopes is an empty array", async () => {
    await createLiveSkillWorkshopConnection(api, { clientDisplayName: "skill-workshop", operatorScopes: [] });

    expect(createOperatorApprovalsGatewayClientMock).toHaveBeenCalledTimes(1);
    expect(createOperatorGatewayClientMock).not.toHaveBeenCalled();
  });

  it("uses the #35 scoped client when operatorScopes is non-empty, passing the scopes through", async () => {
    await createLiveSkillWorkshopConnection(api, {
      clientDisplayName: "skill-workshop",
      operatorScopes: ["operator.read", "operator.admin"],
    });

    expect(createOperatorGatewayClientMock).toHaveBeenCalledTimes(1);
    expect(createOperatorGatewayClientMock.mock.calls[0][0]).toMatchObject({
      scopes: ["operator.read", "operator.admin"],
      clientDisplayName: "skill-workshop",
    });
    expect(createOperatorApprovalsGatewayClientMock).not.toHaveBeenCalled();
  });

  it("passes bootstrap config/token override and starts/stops the connection", async () => {
    const connection = await createLiveSkillWorkshopConnection({
      runtime: { config: { current: () => ({ gateway: { port: 1234, auth: { mode: "token" } } }) } },
    }, { clientDisplayName: "workshop", gatewayTokenOverride: "test-token" });
    expect(createOperatorApprovalsGatewayClientMock).toHaveBeenCalledWith(expect.objectContaining({
      config: { gateway: { port: 1234, auth: { mode: "token", token: "test-token" } } },
    }));
    await connection.start();
    expect(startGatewayClientWhenEventLoopReadyMock).toHaveBeenCalledWith(fakeGatewayClient, { clientOptions: {} });
    connection.stop();
    expect(fakeGatewayClient.stop).toHaveBeenCalledTimes(1);
  });

  it("fails startup when the gateway never becomes ready", async () => {
    startGatewayClientWhenEventLoopReadyMock.mockResolvedValue({ ready: false });
    const connection = await createLiveSkillWorkshopConnection({}, { clientDisplayName: "workshop" });
    await expect(connection.start()).rejects.toThrow("skill-workshop gateway client failed to start");
  });
});
