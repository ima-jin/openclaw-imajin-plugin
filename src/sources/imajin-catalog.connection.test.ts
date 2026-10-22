import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(), start: vi.fn(), stop: vi.fn(),
  request: vi.fn(),
}));
vi.mock("../gateway-operator-client.js", () => ({ createOperatorGatewayClient: mocks.create }));
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  startGatewayClientWhenEventLoopReady: mocks.start,
}));

import { createLiveImajinCatalogConnection } from "./imajin-catalog.js";

describe("opt-in catalog connection (#105)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({ request: mocks.request, stop: mocks.stop });
    mocks.start.mockResolvedValue({ ready: true });
    mocks.request.mockResolvedValue({ hash: "h", config: {} });
  });

  it("uses its own config-authorized loopback connection without widening other source scopes", async () => {
    const config = { gateway: { port: 18789 } };
    const connection = await createLiveImajinCatalogConnection(
      { runtime: { config: { current: () => config } } }, { clientDisplayName: "Catalog approvals" },
    );
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      config, scopes: ["operator.admin"], clientDisplayName: "Catalog approvals",
    }));
    await connection.start();
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(await connection.client.getConfig()).toEqual({ hash: "h", allow: [] });
    connection.stop();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it("refuses an unready Gateway instead of claiming the source can apply decisions", async () => {
    mocks.start.mockResolvedValue({ ready: false });
    const connection = await createLiveImajinCatalogConnection({}, { clientDisplayName: "Catalog approvals" });
    await expect(connection.start()).rejects.toThrow("failed to start");
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
