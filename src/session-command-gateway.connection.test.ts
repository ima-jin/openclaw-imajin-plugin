import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoopbackSessionGateway } from "./session-command-gateway.js";

const mocks = vi.hoisted(() => ({
  create: vi.fn(), ready: vi.fn(), request: vi.fn(), stop: vi.fn(),
}));
vi.mock("./gateway-operator-client.js", () => ({ createOperatorGatewayClient: mocks.create }));
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({ startGatewayClientWhenEventLoopReady: mocks.ready }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ request: mocks.request, stop: mocks.stop });
  mocks.ready.mockResolvedValue({ ready: true });
  mocks.request.mockResolvedValue({ sessions: [] });
});

describe("session inventory loopback connection", () => {
  it("starts only explicitly, preserves scopes, forwards reconnect/change callbacks and stops once", async () => {
    const onConnected = vi.fn();
    const onEvent = vi.fn();
    const gateway = createLoopbackSessionGateway({ getConfig: () => ({}), onConnected, onEvent });
    expect(mocks.create).not.toHaveBeenCalled();
    await gateway.start();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0][0].scopes).toEqual(["operator.write", "operator.approvals"]);
    const connection = mocks.create.mock.calls[0][0];
    connection.onHelloOk(); connection.onHelloOk();
    connection.onEvent({ event: "sessions.changed" });
    expect(onConnected).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledWith({ event: "sessions.changed" });
    await gateway.gateway.list();
    expect(mocks.create).toHaveBeenCalledOnce();
    gateway.dispose();
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
    connection.onHelloOk(); connection.onEvent({ event: "sessions.changed" });
    expect(onConnected).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledOnce();
    await expect(gateway.start()).rejects.toThrow("disposed");
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it("retries a failed connection without requesting broader scopes", async () => {
    mocks.ready.mockResolvedValueOnce({ ready: false });
    const gateway = createLoopbackSessionGateway({ getConfig: () => ({}) });
    await expect(gateway.start()).rejects.toThrow("failed to start");
    expect(mocks.stop).toHaveBeenCalledOnce();
    await gateway.start();
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls[1][0].scopes).not.toContain("operator.admin");
    gateway.dispose();
  });

  it("stops a connection that finishes startup after disposal", async () => {
    let resolve!: (value: { ready: boolean }) => void;
    mocks.ready.mockReturnValueOnce(new Promise<{ ready: boolean }>((done) => { resolve = done; }));
    const gateway = createLoopbackSessionGateway({ getConfig: () => ({}) });
    const pending = gateway.start();
    await vi.waitFor(() => expect(mocks.ready).toHaveBeenCalledOnce());
    gateway.dispose();
    resolve({ ready: true });
    await expect(pending).rejects.toThrow("disposed");
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
