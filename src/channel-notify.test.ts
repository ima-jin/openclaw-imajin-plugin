import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIRECT_SEND_TIMEOUT_MS, sendDirectChannelMessage, type DirectChannelApi } from "./channel-notify.js";

const childProcessImported = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => {
  childProcessImported();
  throw new Error("channel delivery must never import child_process");
});

function harness() {
  const cfg = { channels: { telegram: { enabled: true } } };
  const sendText = vi.fn(async (_ctx: {
    cfg: Record<string, unknown>; to: string; text: string; signal?: AbortSignal;
  }) => ({ outcome: undefined as string | undefined }));
  const loadAdapter = vi.fn(async (_channel: string) => ({ sendText }));
  const api = { runtime: { config: { current: () => cfg }, channel: { outbound: { loadAdapter } } } };
  return { api, cfg, sendText, loadAdapter };
}

afterEach(() => {
  expect(childProcessImported).not.toHaveBeenCalled();
  vi.useRealTimers();
});

describe("in-process direct channel delivery (#89)", () => {
  it.each([undefined, "telegram", "slack"])("loads channel %s and sends exact text/target using current host config", async (channel) => {
    const h = harness();
    await sendDirectChannelMessage({ channel, target: "recipient", cliPath: "/ignored/legacy-cli" }, "literal $text\n`no shell`", h.api);
    expect(h.loadAdapter).toHaveBeenCalledWith(channel ?? "telegram");
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText).toHaveBeenCalledWith({
      cfg: h.cfg, to: "recipient", text: "literal $text\n`no shell`", signal: expect.any(AbortSignal),
    });
  });

  it("reads current config on each send, falling back to registration config", async () => {
    const h = harness();
    const api: DirectChannelApi = { ...h.api, config: { registered: true } };
    await sendDirectChannelMessage({ target: "one" }, "first", api);
    api.runtime!.config = undefined;
    await sendDirectChannelMessage({ target: "two" }, "second", api);
    expect(h.sendText.mock.calls.map(([ctx]) => ctx.cfg)).toEqual([h.cfg, api.config]);
  });

  it.each([undefined, {}, { channel: "telegram" }])("rejects missing recipient %j before adapter lookup", async (ds) => {
    const h = harness();
    await expect(sendDirectChannelMessage(ds, "private", h.api)).rejects.toThrow("directSend not configured");
    expect(h.loadAdapter).not.toHaveBeenCalled();
  });

  it("fails explicitly when the host lacks the verified outbound runtime", async () => {
    await expect(sendDirectChannelMessage({ target: "one" }, "text", {})).rejects.toThrow("outbound runtime unavailable");
  });

  it.each([undefined, {}])("rejects missing text adapter %j without a fallback send", async (adapter) => {
    const api: DirectChannelApi = { runtime: { channel: { outbound: { loadAdapter: async () => adapter } } } };
    await expect(sendDirectChannelMessage({ target: "one" }, "text", api)).rejects.toThrow("text adapter unavailable");
  });

  it("propagates loading and send failures without retrying or sending elsewhere", async () => {
    const h = harness();
    h.loadAdapter.mockRejectedValueOnce(new Error("load failed"));
    await expect(sendDirectChannelMessage({ target: "one" }, "text", h.api)).rejects.toThrow("load failed");
    h.sendText.mockRejectedValueOnce(new Error("send failed"));
    await expect(sendDirectChannelMessage({ target: "one" }, "text", h.api)).rejects.toThrow("send failed");
    expect(h.sendText).toHaveBeenCalledTimes(1);
  });

  it("does not report intentionally omitted delivery as success", async () => {
    const h = harness();
    h.sendText.mockResolvedValueOnce({ outcome: "not_sent" });
    await expect(sendDirectChannelMessage({ target: "one" }, "text", h.api)).rejects.toThrow("delivery refused");
  });

  it("bounds sending to 20 seconds and aborts its adapter signal", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sendText.mockImplementationOnce(async () => new Promise(() => {}));
    const result = expect(sendDirectChannelMessage({ target: "one" }, "text", h.api)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(DIRECT_SEND_TIMEOUT_MS);
    await result;
    expect(h.sendText.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not send after an adapter load completes beyond the deadline", async () => {
    vi.useFakeTimers();
    const h = harness();
    let resolve!: (adapter: { sendText: typeof h.sendText }) => void;
    h.loadAdapter.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const result = expect(sendDirectChannelMessage({ target: "one" }, "text", h.api)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(DIRECT_SEND_TIMEOUT_MS);
    await result;
    resolve({ sendText: h.sendText });
    await Promise.resolve();
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it("keeps the shared send module free of child_process imports", async () => {
    const source = await readFile(new URL("./channel-notify.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/(?:node:)?child_process/);
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(manifest.configSchema.properties.wsNotifications.properties.directSend.properties.cliPath)
      .toMatchObject({ type: "string", deprecated: true });
  });
});
