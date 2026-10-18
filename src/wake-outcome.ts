import type { WakeBridgeOutcome, WakeBridgeRecord } from "./wake-bridge.js";
import type { AgentEndEvent } from "./turn-usage-attestation.js";
import { extractFinalAssistantOutput } from "./wake-report.js";
import { wakeFailureReason } from "./wake-supervisor.js";

function bounded(value: unknown, bytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return Buffer.from(value.slice(0, bytes)).subarray(0, bytes).toString("utf8").replace(/\uFFFD+$/, "").trim() || undefined;
}

function structuredUpdates(output: string, runIds: readonly string[]): WakeBridgeRecord[] {
  // Optional explicit protocol; prose never closes work. Only this wake's runs can change.
  if (Buffer.byteLength(output) > 4_096) return [];
  let updates: unknown;
  try { updates = JSON.parse(output).updates; } catch { return []; }
  if (!Array.isArray(updates)) return [];
  return updates.slice(0, 50).flatMap((raw: unknown) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.runId !== "string" || !runIds.includes(item.runId)
      || (item.status !== "open" && item.status !== "closed")) return [];
    return [{
      runId: item.runId,
      status: item.status,
      issue: bounded(item.issue, 256),
      expectedPr: bounded(item.expectedPr, 512),
      lastVerdict: bounded(item.lastVerdict, 768),
    }];
  });
}

export function buildWakeOutcome(runIds: readonly string[], event: AgentEndEvent): WakeBridgeOutcome {
  const output = extractFinalAssistantOutput(event.messages) ?? "";
  const failure = wakeFailureReason(event);
  return {
    runIds: runIds.slice(0, 50).map((id) => id.slice(0, 128)),
    lastVerdict: bounded(failure ?? output, 768),
    updates: failure ? [] : structuredUpdates(output, runIds),
  };
}
