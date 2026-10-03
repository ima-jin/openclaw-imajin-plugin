import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createSecretHandle,
  withSecretEnv,
  HandleExpiredError,
  DEFAULT_MAX_TTL_MS,
  containsLiveSecret,
  _resetSecretHandleStoreForTests,
} from "./secret-handle-store.js";

const KNOWN_SECRET = "ghp_super-secret-runner-registration-token-do-not-leak";

describe("createSecretHandle / withSecretEnv", () => {
  beforeEach(() => {
    _resetSecretHandleStoreForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns only a handle + expiresAt, never the value", () => {
    const result = createSecretHandle({
      name: "GH_TOKEN",
      value: KNOWN_SECRET,
      grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(result.handle).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(KNOWN_SECRET);
  });

  it("caps TTL to DEFAULT_MAX_TTL_MS when the grant's own expiry is further out", () => {
    const now = Date.now();
    const farFuture = new Date(now + 60 * 60_000).toISOString(); // 1h out
    const { expiresAt } = createSecretHandle({ name: "X", value: "v", grantExpiresAt: farFuture });
    const expiresMs = new Date(expiresAt).getTime();
    expect(expiresMs).toBeLessThanOrEqual(now + DEFAULT_MAX_TTL_MS + 5);
    expect(expiresMs).toBeGreaterThan(now + DEFAULT_MAX_TTL_MS - 5000);
  });

  it("uses the grant's own expiry when it is sooner than the max TTL", () => {
    const now = Date.now();
    const soon = new Date(now + 5_000).toISOString();
    const { expiresAt } = createSecretHandle({ name: "X", value: "v", grantExpiresAt: soon });
    expect(new Date(expiresAt).getTime()).toBeLessThanOrEqual(now + 5_000 + 5);
  });

  it("treats a null grantExpiresAt (no expiry on the grant) as the max TTL, not an immediately-expired handle", () => {
    const now = Date.now();
    const { expiresAt } = createSecretHandle({ name: "X", value: "v", grantExpiresAt: null });
    const expiresMs = new Date(expiresAt).getTime();
    // A naive `new Date(null)` resolves to the 1970 epoch, which would make
    // this assertion fail by producing an already-expired handle instead.
    expect(expiresMs).toBeGreaterThan(now);
    expect(expiresMs).toBeLessThanOrEqual(now + DEFAULT_MAX_TTL_MS + 5);
    expect(expiresMs).toBeGreaterThan(now + DEFAULT_MAX_TTL_MS - 5000);
  });

  it("withSecretEnv resolves the handle to { [name]: value }", async () => {
    const { handle } = createSecretHandle({
      name: "GH_TOKEN",
      value: KNOWN_SECRET,
      grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const seen = await withSecretEnv(handle, async (env) => {
      expect(env).toEqual({ GH_TOKEN: KNOWN_SECRET });
      return "ok";
    });
    expect(seen).toBe("ok");
  });

  it("is single-use: a second read of the same handle throws handle_expired", async () => {
    const { handle } = createSecretHandle({
      name: "X",
      value: "v",
      grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await withSecretEnv(handle, () => "first read");
    await expect(withSecretEnv(handle, () => "second read")).rejects.toThrow(HandleExpiredError);
    await expect(withSecretEnv(handle, () => "second read")).rejects.toThrow("handle_expired");
  });

  it("reading an unknown handle throws handle_expired", async () => {
    await expect(withSecretEnv("sh_does_not_exist", () => "x")).rejects.toThrow("handle_expired");
  });

  it("reading an expired handle throws handle_expired and removes the entry", async () => {
    vi.useFakeTimers();
    const { handle } = createSecretHandle({
      name: "X",
      value: "v",
      grantExpiresAt: new Date(Date.now() + 1_000).toISOString(),
    });
    vi.advanceTimersByTime(2_000);
    await expect(withSecretEnv(handle, () => "x")).rejects.toThrow("handle_expired");
    // Entry is gone even after expiry — a second attempt is still handle_expired,
    // not some other error.
    await expect(withSecretEnv(handle, () => "x")).rejects.toThrow("handle_expired");
  });

  it("redacts a callback failure — the original error never propagates verbatim", async () => {
    const { handle } = createSecretHandle({
      name: "GH_TOKEN",
      value: KNOWN_SECRET,
      grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    let caught: unknown;
    try {
      await withSecretEnv(handle, (env) => {
        throw new Error(`command failed, env was ${JSON.stringify(env)}`);
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(KNOWN_SECRET);
  });
});

describe("withSecretEnv ack hook / containsLiveSecret", () => {
  beforeEach(() => {
    _resetSecretHandleStoreForTests();
  });

  it("acks 'used' after the callback succeeds, with the grantId and no value", async () => {
    const { handle } = createSecretHandle({ name: "GH_TOKEN", value: KNOWN_SECRET, grantExpiresAt: null, grantId: "vdg_1" });
    const ack = vi.fn();
    await withSecretEnv(handle, () => "ok", { ack });
    expect(ack.mock.calls).toEqual([[{ grantId: "vdg_1", outcome: "used" }]]);
    expect(JSON.stringify(ack.mock.calls)).not.toContain(KNOWN_SECRET);
  });

  it("acks 'failed' when the callback throws, and still re-throws a value-free error", async () => {
    const { handle } = createSecretHandle({ name: "GH_TOKEN", value: KNOWN_SECRET, grantExpiresAt: null, grantId: "vdg_1" });
    const ack = vi.fn();
    await expect(
      withSecretEnv(
        handle,
        () => {
          throw new Error(`boom ${KNOWN_SECRET}`);
        },
        { ack },
      ),
    ).rejects.toThrow(/callback failed/);
    expect(ack.mock.calls).toEqual([[{ grantId: "vdg_1", outcome: "failed" }]]);
  });

  it("swallows a failing ack so it never changes the exec result", async () => {
    const { handle } = createSecretHandle({ name: "N", value: "v", grantExpiresAt: null, grantId: "vdg_1" });
    const ack = vi.fn().mockRejectedValue(new Error("kernel down"));
    await expect(withSecretEnv(handle, () => "result", { ack })).resolves.toBe("result");
  });

  it("does not ack a handle with no grantId, or an expired handle", async () => {
    const ack = vi.fn();
    const { handle } = createSecretHandle({ name: "N", value: "v", grantExpiresAt: null });
    await withSecretEnv(handle, () => 1, { ack });
    await expect(withSecretEnv("sh_missing", () => 1, { ack })).rejects.toThrow(HandleExpiredError);
    expect(ack).not.toHaveBeenCalled();
  });

  it("containsLiveSecret is true only while the handle is live and unread", async () => {
    expect(containsLiveSecret(KNOWN_SECRET)).toBe(false);
    const { handle } = createSecretHandle({ name: "N", value: KNOWN_SECRET, grantExpiresAt: null });
    expect(containsLiveSecret(`prefix ${KNOWN_SECRET} suffix`)).toBe(true);
    expect(containsLiveSecret("harmless")).toBe(false);
    await withSecretEnv(handle, () => 1);
    expect(containsLiveSecret(KNOWN_SECRET)).toBe(false);
  });

  it("containsLiveSecret ignores empty values and expired handles", () => {
    vi.useFakeTimers();
    createSecretHandle({ name: "E", value: "", grantExpiresAt: null });
    createSecretHandle({ name: "N", value: KNOWN_SECRET, grantExpiresAt: null });
    expect(containsLiveSecret("anything")).toBe(false);
    vi.advanceTimersByTime(DEFAULT_MAX_TTL_MS + 1);
    expect(containsLiveSecret(KNOWN_SECRET)).toBe(false);
    vi.useRealTimers();
  });
});
