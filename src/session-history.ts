import { redactLoopText, type SessionLoopOutput } from "./loop-publisher.js";
import { redactWakeText, SECRET_KEY } from "./wake-redaction.js";

export const MAX_HISTORY_TURNS = 20;
export const MAX_HISTORY_OUTPUTS = 80;
export const MAX_HISTORY_OUTPUT_BYTES = 12 * 1024;
const MAX_TEXT_CHARS = 2048;

function text(value: unknown): string {
  return typeof value === "string"
    ? redactLoopText(redactWakeText(value)).slice(0, MAX_TEXT_CHARS) : "";
}

/** Allowlisted, bounded JSON; redact keys and strings BEFORE clipping. */
function json(value: unknown, depth = 0, budget = { left: 200 }): unknown {
  if (depth >= 6 || budget.left-- <= 0) return "[truncated]";
  if (typeof value === "string") return text(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => json(item, depth + 1, budget));
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) =>
    [text(key), SECRET_KEY.test(key) ? "[redacted]" : json(item, depth + 1, budget)]));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bounded(output: SessionLoopOutput): SessionLoopOutput {
  if (Buffer.byteLength(JSON.stringify(output), "utf8") <= MAX_HISTORY_OUTPUT_BYTES) return output;
  if (output.kind === "tool_call") return { ...output, args: "[truncated]" };
  if (output.kind === "tool_result") return { ...output, result: "[truncated]" };
  return output;
}

function turnOutputs(raw: unknown): SessionLoopOutput[] {
  const message = record(raw);
  if (!["user", "assistant", "toolResult", "tool"].includes(String(message.role))) return [];
  if (message.role === "toolResult" || message.role === "tool") {
    return [{
      kind: "tool_result", callId: text(message.toolCallId ?? message.tool_call_id),
      result: json(message.content), isError: message.isError === true,
    }];
  }
  const blocks = Array.isArray(message.content) ? message.content.slice(0, 8) : [{ type: "text", text: message.content }];
  return blocks.flatMap((rawBlock): SessionLoopOutput[] => {
    const block = record(rawBlock);
    if (block.type === "text") return [{ kind: "text", text: text(block.text), role: String(message.role) }];
    if (block.type === "toolCall" || block.type === "tool_use") {
      return [{ kind: "tool_call", callId: text(block.id), name: text(block.name), args: json(block.arguments ?? block.input) }];
    }
    if (block.type === "tool_result") {
      return [{ kind: "tool_result", callId: text(block.tool_use_id), result: json(block.content), isError: block.is_error === true }];
    }
    // Never export thinking, system messages, images, or arbitrary raw fields.
    return [];
  });
}

/** Last 20 Gateway message entries, at most 80 output blocks, 12 KiB each. */
export function sessionHistoryOutputs(messages: readonly unknown[]): SessionLoopOutput[] {
  return messages.slice(-MAX_HISTORY_TURNS).flatMap(turnOutputs).slice(-MAX_HISTORY_OUTPUTS).map(bounded);
}
