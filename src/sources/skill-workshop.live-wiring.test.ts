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

import { createLiveSkillWorkshopConnection } from "./skill-workshop.js";

describe("createLiveSkillWorkshopConnection", () => {
  beforeEach(() => {
    createOperatorApprovalsGatewayClientMock.mockReset().mockResolvedValue(fakeGatewayClient);
    createOperatorGatewayClientMock.mockReset().mockResolvedValue(fakeGatewayClient);
    startGatewayClientWhenEventLoopReadyMock.mockReset().mockResolvedValue({ ready: true });
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
});
