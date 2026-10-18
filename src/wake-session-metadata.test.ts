import { beforeEach, describe, expect, it, vi } from "vitest";
import { readWakeSessionMetadata, readWakeSessionTokens } from "./wake-session-metadata.js";

const sdk = vi.hoisted(() => ({
  getSessionEntry: vi.fn(),
  resolveStorePath: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => sdk);

const request = { agentId: "worker", sessionKey: "agent:worker:wake:test" };
const fresh = { sessionId: "sample-session", totalTokens: 42, totalTokensFresh: true, totalTokensVersion: 1 };

describe("readWakeSessionMetadata", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sdk.resolveStorePath.mockReturnValue("/tmp/sample-store");
    sdk.getSessionEntry.mockReturnValue({ ...fresh });
  });

  it("uses explicit scope, latest metadata and the configured store", async () => {
    expect(await readWakeSessionMetadata({
      ...request,
      config: { session: { store: "/tmp/custom-store" } },
    })).toEqual({ status: "known", sessionId: fresh.sessionId, tokens: 42 });
    expect(sdk.resolveStorePath).toHaveBeenCalledWith("/tmp/custom-store", { agentId: "worker" });
    expect(sdk.getSessionEntry).toHaveBeenCalledWith({
      ...request,
      storePath: "/tmp/sample-store",
      readConsistency: "latest",
      hydrateSkillPromptRefs: false,
    });
  });

  it("resolves the default store without guessing a filesystem path", async () => {
    await readWakeSessionMetadata(request);
    expect(sdk.resolveStorePath).toHaveBeenCalledWith(undefined, { agentId: "worker" });
  });

  it("does not treat missing metadata as a zero-sized session", async () => {
    sdk.getSessionEntry.mockReturnValue(undefined);
    expect(await readWakeSessionMetadata(request)).toEqual({ status: "missing" });
  });

  it("accepts a fresh zero snapshot and positive capacity", async () => {
    sdk.getSessionEntry.mockReturnValue({ ...fresh, totalTokens: 0, contextTokens: 50000 });
    expect(await readWakeSessionMetadata(request)).toEqual({
      status: "known", sessionId: fresh.sessionId, tokens: 0, contextTokens: 50000,
    });
  });

  it.each([
    { totalTokensFresh: false }, { totalTokensFresh: undefined },
    { totalTokensVersion: undefined }, { totalTokensVersion: 2 },
  ])("rejects stale or incompatible snapshots: %j", async (patch) => {
    sdk.getSessionEntry.mockReturnValue({ ...fresh, ...patch });
    expect(await readWakeSessionMetadata(request)).toEqual({ status: "unknown", reason: "stale-tokens" });
  });

  it.each([undefined, -1, NaN, Infinity, "42"])("rejects invalid token counts: %s", async (totalTokens) => {
    sdk.getSessionEntry.mockReturnValue({ ...fresh, totalTokens });
    expect(await readWakeSessionMetadata(request)).toEqual({ status: "unknown", reason: "invalid-tokens" });
  });

  it.each([undefined, 0, -1, NaN, Infinity, "50000"])("omits invalid or absent capacity: %s", async (contextTokens) => {
    sdk.getSessionEntry.mockReturnValue({ ...fresh, contextTokens });
    expect(await readWakeSessionMetadata(request)).toEqual({ status: "known", sessionId: fresh.sessionId, tokens: 42 });
  });

  it.each([
    { agentId: "", sessionKey: request.sessionKey },
    { agentId: " worker", sessionKey: request.sessionKey },
    { agentId: "other", sessionKey: request.sessionKey },
    { agentId: "worker", sessionKey: "" },
  ])("rejects ambiguous identity before reading: %j", async (identity) => {
    expect(await readWakeSessionMetadata(identity)).toEqual({ status: "unknown", reason: "invalid-identity" });
    expect(sdk.getSessionEntry).not.toHaveBeenCalled();
  });

  it("fences a terminal read against a replaced session", async () => {
    expect(await readWakeSessionMetadata({ ...request, expectedSessionId: "previous-session" }))
      .toEqual({ status: "unknown", reason: "session-changed" });
  });

  it("rejects a malformed entry identity", async () => {
    sdk.getSessionEntry.mockReturnValue({ ...fresh, sessionId: "" });
    expect(await readWakeSessionMetadata(request)).toEqual({ status: "unknown", reason: "invalid-identity" });
  });

  it("does not fall back to a default store for malformed custom configuration", async () => {
    expect(await readWakeSessionMetadata({ ...request, config: { session: { store: 1 } } }))
      .toEqual({ status: "unknown", reason: "read-failed" });
    expect(sdk.getSessionEntry).not.toHaveBeenCalled();
  });

  it.each(["getSessionEntry", "resolveStorePath"] as const)("contains SDK failure from %s without logging", async (method) => {
    const log = vi.spyOn(console, "error");
    sdk[method].mockImplementation(() => { throw new Error("simulated failure"); });
    expect(await readWakeSessionMetadata(request)).toEqual({ status: "unknown", reason: "read-failed" });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("wrapper reads live config and derives the agent from the scoped key", async () => {
    expect(await readWakeSessionTokens({
      runtime: { config: { current: () => ({ session: { store: "/tmp/live-store" } }) } },
      config: { session: { store: "/tmp/registration-store" } },
    }, request.sessionKey)).toBe(42);
    expect(sdk.resolveStorePath).toHaveBeenCalledWith("/tmp/live-store", { agentId: "worker" });
  });

  it("wrapper falls back to registration config when live config throws", async () => {
    expect(await readWakeSessionTokens({
      runtime: { config: { current: () => { throw new Error("simulated failure"); } } },
      config: { session: { store: "/tmp/registration-store" } },
      pluginConfig: { wsNotifications: { hookAgentId: "worker" } },
    }, "wake:test")).toBe(42);
    expect(sdk.resolveStorePath).toHaveBeenCalledWith("/tmp/registration-store", { agentId: "worker" });
  });

  it("wrapper uses the hook default and distinguishes absent from failed reads", async () => {
    sdk.getSessionEntry.mockReturnValue(undefined);
    expect(await readWakeSessionTokens({}, "wake:test")).toBeUndefined();
    expect(sdk.resolveStorePath).toHaveBeenCalledWith(undefined, { agentId: "main" });
    sdk.getSessionEntry.mockImplementation(() => { throw new Error("simulated failure"); });
    expect(await readWakeSessionTokens({}, "wake:test")).toBeUndefined();
  });
});
