import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #35: `openclaw` is an optional peerDependency not installed in this repo's
// dev environment (see `src/types/openclaw-plugin-sdk.d.ts`'s module doc) —
// mocked here the same way `notification-injector.test.ts` mocks the
// SecretRef plugin-sdk subpaths, so these tests never need the real
// (unpublished-in-this-repo) `openclaw` package resolvable on disk.
const gatewayClientCtorMock = vi.hoisted(() => vi.fn());
const resolveGatewayAuthMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  GatewayClient: gatewayClientCtorMock,
  resolveGatewayAuth: resolveGatewayAuthMock,
}));
vi.mock("openclaw/plugin-sdk/core", () => ({
  resolveGatewayPort: resolveGatewayPortMock,
}));

import {
  KNOWN_OPERATOR_GATEWAY_SCOPES,
  isKnownOperatorGatewayScope,
  assertKnownOperatorGatewayScopes,
  createOperatorGatewayClient,
} from "./gateway-operator-client.js";

const SECRET_TOKEN = "super-secret-loopback-token-do-not-log";

describe("KNOWN_OPERATOR_GATEWAY_SCOPES / isKnownOperatorGatewayScope", () => {
  it("includes exactly the four scopes this plugin allows configuring", () => {
    expect(KNOWN_OPERATOR_GATEWAY_SCOPES).toEqual([
      "operator.read",
      "operator.admin",
      "operator.approvals",
      "operator.write",
    ]);
  });

  it("accepts every known scope and rejects unknown strings", () => {
    for (const scope of KNOWN_OPERATOR_GATEWAY_SCOPES) {
      expect(isKnownOperatorGatewayScope(scope)).toBe(true);
    }
    expect(isKnownOperatorGatewayScope("operator.talk")).toBe(false);
    expect(isKnownOperatorGatewayScope("operator.pairing")).toBe(false);
    expect(isKnownOperatorGatewayScope("not-a-scope")).toBe(false);
    expect(isKnownOperatorGatewayScope(123)).toBe(false);
  });
});

describe("assertKnownOperatorGatewayScopes", () => {
  it("accepts an empty list and a list of only known scopes", () => {
    expect(() => assertKnownOperatorGatewayScopes([], "approvals.skillWorkshop.operatorScopes")).not.toThrow();
    expect(() =>
      assertKnownOperatorGatewayScopes(["operator.read", "operator.admin"], "approvals.skillWorkshop.operatorScopes"),
    ).not.toThrow();
  });

  it("throws a clear, actionable error naming the config path and the offending scope(s)", () => {
    expect(() =>
      assertKnownOperatorGatewayScopes(["operator.read", "operator.talk"], "approvals.skillWorkshop.operatorScopes"),
    ).toThrowError(/approvals\.skillWorkshop\.operatorScopes.*"operator\.talk"/s);
  });
});

describe("createOperatorGatewayClient", () => {
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    gatewayClientCtorMock.mockReset();
    resolveGatewayAuthMock.mockReset();
    resolveGatewayPortMock.mockReset();
    resolveGatewayAuthMock.mockReturnValue({ mode: "token", token: SECRET_TOKEN, password: undefined });
    resolveGatewayPortMock.mockReturnValue(18789);
    consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
  });

  it("passes the requested scopes straight into the GatewayClient constructor", async () => {
    await createOperatorGatewayClient({
      config: { gateway: {} },
      scopes: ["operator.read", "operator.admin"],
      clientDisplayName: "test-client",
    });

    expect(gatewayClientCtorMock).toHaveBeenCalledTimes(1);
    const ctorArgs = gatewayClientCtorMock.mock.calls[0][0];
    expect(ctorArgs.scopes).toEqual(["operator.read", "operator.admin"]);
    expect(ctorArgs.clientDisplayName).toBe("test-client");
    expect(ctorArgs.clientName).toBe("gateway-client");
    expect(ctorArgs.mode).toBe("backend");
  });

  it("builds a ws:// loopback URL from resolveGatewayPort when TLS is not enabled", async () => {
    resolveGatewayPortMock.mockReturnValue(4321);
    await createOperatorGatewayClient({
      config: { gateway: {} },
      scopes: ["operator.read"],
      clientDisplayName: "test-client",
    });
    const ctorArgs = gatewayClientCtorMock.mock.calls[0][0];
    expect(ctorArgs.url).toBe("ws://127.0.0.1:4321");
  });

  it("builds a wss:// loopback URL when gateway.tls.enabled is true", async () => {
    resolveGatewayPortMock.mockReturnValue(4321);
    await createOperatorGatewayClient({
      config: { gateway: { tls: { enabled: true } } },
      scopes: ["operator.read"],
      clientDisplayName: "test-client",
    });
    const ctorArgs = gatewayClientCtorMock.mock.calls[0][0];
    expect(ctorArgs.url).toBe("wss://127.0.0.1:4321");
  });

  it("passes resolveGatewayAuth's resolved token/password through to the client but never logs them", async () => {
    await createOperatorGatewayClient({
      config: { gateway: { auth: { token: SECRET_TOKEN } } },
      scopes: ["operator.read"],
      clientDisplayName: "test-client",
    });

    const ctorArgs = gatewayClientCtorMock.mock.calls[0][0];
    expect(ctorArgs.token).toBe(SECRET_TOKEN);

    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(SECRET_TOKEN);
        }
      }
    }
  });
});
