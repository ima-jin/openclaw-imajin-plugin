import { describe, expect, it } from "vitest";
import { MAX_HISTORY_OUTPUT_BYTES, sessionHistoryOutputs, sessionHistoryEntries } from "./session-history.js";

describe("redacted typed session history", () => {
  it("keeps native turn/block points stable as the bounded window slides, without collapsing identical distinct turns", () => {
    const messages = Array.from({ length: 21 }, (_, index) => ({ id: `native-${index}`, role: "user", content: "same text" }));
    const first = sessionHistoryEntries(messages.slice(0, 20));
    const next = sessionHistoryEntries(messages);
    expect(next.slice(0, 19)).toEqual(first.slice(1));
    expect(next.at(-1)?.point).not.toBe(first.at(-1)?.point);
    expect(new Set(next.map((entry) => entry.point)).size).toBe(20);
    expect(sessionHistoryEntries([{ role: "user", content: "same" }, { role: "user", content: "same" }])[0].point)
      .not.toBe(sessionHistoryEntries([{ role: "user", content: "same" }, { role: "user", content: "same" }])[1].point);
  });
  it("exports only #2406 text/tool_call/tool_result shapes, with no raw transcript fields", () => {
    const output = sessionHistoryOutputs([
      { role: "system", content: "hidden system text" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "hidden reasoning" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "safe" } },
      ], internal: "hidden metadata" },
      { role: "toolResult", toolCallId: "call-1", content: "result", isError: false },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-2", content: "more", is_error: true }] },
    ]);
    expect(output).toEqual([
      { kind: "text", text: "answer", role: "assistant" },
      { kind: "tool_call", callId: "call-1", name: "read", args: { path: "safe" } },
      { kind: "tool_result", callId: "call-1", result: "result", isError: false },
      { kind: "tool_result", callId: "call-2", result: "more", isError: true },
    ]);
  });

  it("reuses both plugin redactors for secret fields, tokens, bearer headers, quoted assignments and opaque strings", () => {
    const credential = "synthetic-" + "value".repeat(15);
    const output = sessionHistoryOutputs([
      { role: "user", content: `Authorization: Bearer ${credential}\npassword="two words"\ntoken=${credential}\nsk-${credential}` },
      { role: "assistant", content: [{ type: "toolCall", id: "call", name: "query", arguments: {
        nested: { api_key: credential, cookie: credential, safe: `Bearer ${credential}` }, plain: credential,
      } }] },
    ]);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain("two words");
    expect(serialized).toContain("[redacted]");
  });

  it("keeps the last 20 turns and caps block count, strings, nesting and UTF-8 output bytes", () => {
    expect(sessionHistoryOutputs(Array.from({ length: 30 }, (_, n) => ({ role: "user", content: `turn ${n}` })))[0])
      .toMatchObject({ text: "turn 10" });
    const huge = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`key${n}`, Array(20).fill("🍁 ".repeat(3000))]));
    const blocks = Array.from({ length: 12 }, () => ({ type: "toolCall", id: "c", name: "tool", arguments: huge }));
    const output = sessionHistoryOutputs(Array.from({ length: 25 }, () => ({ role: "assistant", content: blocks })));
    expect(output).toHaveLength(80);
    for (const item of output) expect(Buffer.byteLength(JSON.stringify(item), "utf8")).toBeLessThanOrEqual(MAX_HISTORY_OUTPUT_BYTES);
    const escaped = sessionHistoryOutputs([
      { role: "user", content: "\0".repeat(3000) },
      { role: "assistant", content: [{ type: "toolCall", id: "🍁 ".repeat(3000), name: "🍁 ".repeat(3000), arguments: huge }] },
    ]);
    for (const item of escaped) expect(Buffer.byteLength(JSON.stringify(item), "utf8")).toBeLessThanOrEqual(MAX_HISTORY_OUTPUT_BYTES);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => sessionHistoryOutputs([{ role: "tool", content: cycle }])).not.toThrow();
    expect(sessionHistoryOutputs([null, 1, {}, { role: "user", content: null }])).toEqual([{ kind: "text", text: "", role: "user" }]);
  });
});
