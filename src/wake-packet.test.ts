import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildWakePacket, DEFAULT_PACKET_MAX_BYTES, DEFAULT_PACKET_TIMEOUT_MS, LIGHT_WAKE_BOOTSTRAP,
  MAX_PACKET_BYTES, MAX_PACKET_TIMEOUT_MS, MAX_WAKE_FIRST_TURN_BYTES, packetUnavailable,
  packetWakeMessage, recordPacketFirstAssistant, type WakePacketConfig,
} from "./wake-packet.js";

const fixtureBuilder = fileURLToPath(new URL("./fixtures/wake-packet-builder.mjs", import.meta.url));
const command = (mode = "packet"): string[] => [process.execPath, fixtureBuilder, mode];

describe("bounded wake packet builder", () => {
  it("builds exactly the same packet from fixed live-state fixtures and sorted unique run IDs", async () => {
    const first = await buildWakePacket({ command: command() }, ["run-b", "run-a", "run-a"]);
    const second = await buildWakePacket({ command: command() }, ["run-a", "run-b"]);
    expect(first).toEqual(second);
    expect(first.metrics.source).toBe("packet");
    expect(first.text).toContain("Runs: run-a, run-b");
    const fixture = JSON.parse(await readFile(new URL("./fixtures/wake-packet-state.json", import.meta.url), "utf8"));
    for (const [section, state] of Object.entries(fixture)) {
      expect(first.text).toContain(`${section}: ${JSON.stringify(state)}`);
    }
    expect(first.metrics.packetBytes).toBe(Buffer.byteLength(first.text));
    expect(Buffer.byteLength(first.text + LIGHT_WAKE_BOOTSTRAP)).toBeLessThan(MAX_WAKE_FIRST_TURN_BYTES);
  });

  it.each([
    ["fail", "nonzero exit"], ["overflow", "maxBytes exceeded"], ["empty", "empty output"],
    ["timeout", "timeout"], ["inherited-pipe", "timeout"], ["invalid-utf8", "invalid UTF-8 output"],
  ])("fails open for %s without leaking diagnostics", async (mode, reason) => {
    const result = await buildWakePacket({
      command: command(mode), timeoutMs: mode === "timeout" || mode === "inherited-pipe" ? 250 : 5_000,
      maxBytes: mode === "invalid-utf8" ? 1 : undefined,
    }, ["run-a"]);
    expect(result).toEqual(packetUnavailable(reason));
    expect(result.text).not.toContain("fixture-private-diagnostic");
  });

  it("fails open on an absent executable", async () => {
    expect(await buildWakePacket({ command: ["/fixture/nonexistent-builder"] }, ["run-a"]))
      .toEqual(packetUnavailable("execution failed"));
  });

  it.each([
    undefined, null, {}, { command: "node script" }, { command: [] }, { command: ["relative"] },
    { command: [process.execPath, ""] }, { command: [process.execPath, "\0"] },
    { command: Array(33).fill(process.execPath) }, { command: [process.execPath, "x".repeat(4097)] },
    ...["timeoutMs", "maxBytes"].flatMap((key) => [0, -1, 1.5, Number.NaN, Infinity, "5"].map((value) => ({
      command: command(), [key]: value,
    }))),
    { command: command(), timeoutMs: MAX_PACKET_TIMEOUT_MS + 1 },
    { command: command(), maxBytes: MAX_PACKET_BYTES + 1 },
  ])("rejects invalid executable/limits without running it: %j", async (config) => {
    expect(await buildWakePacket(config as WakePacketConfig, ["run-a"]))
      .toEqual(packetUnavailable("invalid configuration"));
  });

  it.each([[], ["--flag"], ["run;touch file"], ["$(command)"], ["a\nb"], ["a".repeat(129)], Array(51).fill(0).map((_, i) => `r-${i}`)].map((ids) => [ids]))(
    "rejects invalid event-derived arguments: %j", async (ids) => {
      expect(await buildWakePacket({ command: command() }, ids)).toEqual(packetUnavailable("invalid run IDs"));
    },
  );

  it("cancels both an active builder and a builder not yet spawned", async () => {
    const signal = new AbortController();
    const pending = buildWakePacket({ command: command("timeout") }, ["run-a"], signal.signal);
    signal.abort();
    expect(await pending).toEqual(packetUnavailable("cancelled"));
    expect(await buildWakePacket({ command: command() }, ["run-a"], signal.signal))
      .toEqual(packetUnavailable("cancelled"));
  });

  it("does not silently truncate a packet to meet the combined first-turn budget", async () => {
    const packet = await buildWakePacket({ command: command() }, ["run-a"]);
    const evidence = "e".repeat(MAX_WAKE_FIRST_TURN_BYTES - Buffer.byteLength(LIGHT_WAKE_BOOTSTRAP) - 400);
    const message = packetWakeMessage("batch", evidence, packet);
    expect(packet.metrics.gap).toContain("first-turn byte budget exceeded");
    expect(message).toContain(evidence);
    expect(message).not.toContain("# Wake packet");
    expect(Buffer.byteLength(message + LIGHT_WAKE_BOOTSTRAP)).toBeLessThanOrEqual(MAX_WAKE_FIRST_TURN_BYTES);
  });

  it("records only the first assistant's actual input including cache, not output or later usage", () => {
    const packet = packetUnavailable("fixture");
    recordPacketFirstAssistant(packet, { role: "tool", usage: { input: 999 } });
    recordPacketFirstAssistant(packet, { role: "assistant", usage: { input: 100, cacheRead: 20, cacheWrite: 3, output: 500 } });
    recordPacketFirstAssistant(packet, { role: "assistant", usage: { input: 999 } });
    expect(packet.metrics.firstTurnInputTokens).toBe(123);
  });

  it("fails open when execution permission is denied", async () => {
    const nonExecutable = fileURLToPath(new URL("./fixtures/wake-packet-state.json", import.meta.url));
    expect(await buildWakePacket({ command: [nonExecutable] }, ["run-a"]))
      .toEqual(packetUnavailable("execution failed"));
  });

  it("accepts exactly maxBytes and rejects one byte less without truncation", async () => {
    const packet = await buildWakePacket({ command: command() }, ["run-a"]);
    expect(await buildWakePacket({ command: command(), maxBytes: packet.metrics.packetBytes }, ["run-a"])).toEqual(packet);
    expect(await buildWakePacket({ command: command(), maxBytes: packet.metrics.packetBytes - 1 }, ["run-a"]))
      .toEqual(packetUnavailable("maxBytes exceeded"));
  });
  it("prefers authoritative prompt tokens and never labels later usage as first when first is unavailable", () => {
    const packet = packetUnavailable("fixture");
    recordPacketFirstAssistant(packet, { role: "assistant", usage: {
      input: 999, contextUsage: { state: "available", promptTokens: 123 },
    } });
    expect(packet.metrics.firstTurnInputTokens).toBe(123);
    const missing = packetUnavailable("fixture");
    recordPacketFirstAssistant(missing, { role: "assistant" });
    recordPacketFirstAssistant(missing, { role: "assistant", usage: { input: 999 } });
    expect(missing.metrics.firstTurnInputTokens).toBeUndefined();
  });
  it.each([Number.NaN, Infinity, -1, "123"])("does not invent usage from invalid first-call metrics (%s)", (input) => {
    const packet = packetUnavailable("fixture");
    recordPacketFirstAssistant(packet, { role: "assistant", usage: { input } });
    expect(packet.metrics.firstTurnInputTokens).toBeUndefined();
  });

  it("keeps schema defaults and hard limits aligned with runtime", async () => {
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const schema = manifest.configSchema.properties.wsNotifications.properties.wakePacket;
    expect(schema.required).toEqual(["command"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.command).toMatchObject({ minItems: 1, maxItems: 32 });
    expect(schema.properties.timeoutMs).toMatchObject({ default: DEFAULT_PACKET_TIMEOUT_MS, minimum: 1, maximum: MAX_PACKET_TIMEOUT_MS });
    expect(schema.properties.maxBytes).toMatchObject({ default: DEFAULT_PACKET_MAX_BYTES, minimum: 1, maximum: MAX_PACKET_BYTES });
  });
});
