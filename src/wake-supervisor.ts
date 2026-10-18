import { createHash, randomUUID } from "node:crypto";
import type { AgentEndEvent } from "./turn-usage-attestation.js";
import { extractFinalAssistantOutput, type WakeBatch } from "./wake-report.js";
import { findFinalAssistantMessage } from "./turn-usage-attestation.js";

export const DEFAULT_WAKE_SESSION = "agent:main:warp-events";
export const DEFAULT_WAKE_MAX_TOKENS = 50_000;
export const DEFAULT_WAKE_TIMEOUT_MS = 35_000;

/** Batch hashes keep external run IDs out of session keys and distinguish coalesced runs. */
export function deriveWakeSessionKey(
  base: string,
  batchId: string,
  runIds: readonly string[],
  sessionPerWake = true,
): string {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
  const batch = hash(batchId);
  const templated = base.includes("{batchId}") || base.includes("{runId}");
  const key = base.replaceAll("{batchId}", batch).replaceAll("{runId}", `${hash(runIds.join("\n"))}-${batch}`);
  return sessionPerWake && !templated ? `${key}:${batch}` : key;
}

export function rotateWakeSessionKey(base: string): string {
  return `${base}:rotated-${randomUUID()}`;
}

/** Context snapshot, NOT sum of per-call token usage across a tool loop. */
export function wakeEventTokens(event: AgentEndEvent): number | undefined {
  const last = findFinalAssistantMessage(event.messages);
  const context = last?.usage?.contextUsage as { state?: unknown; totalTokens?: unknown } | undefined;
  if (context?.state === "available" && typeof context.totalTokens === "number"
    && Number.isFinite(context.totalTokens) && context.totalTokens >= 0) return context.totalTokens;
  const usage = last?.usage;
  const values = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite];
  if (!values.some((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  return values.reduce<number>((sum, n) => sum + (typeof n === "number" && Number.isFinite(n) ? n : 0), 0);
}

export function wakeFailureReason(event: AgentEndEvent): string | undefined {
  const last = findFinalAssistantMessage(event.messages);
  const stop = last?.stopReason ?? event.stopReason;
  if (stop === "length") return "stopReason=length (truncated reply)";
  if (stop === "error" || stop === "aborted" || event.success === false || event.error) return "wake turn failed";
  if (!extractFinalAssistantOutput(event.messages, 1_024)) return "empty wake reply";
  return undefined;
}

export interface SupervisedWake extends WakeBatch {
  sessionKey: string;
  hookRunId?: string;
}

interface PendingWake extends SupervisedWake {
  timer: ReturnType<typeof setTimeout>;
  alerted: boolean;
}

export interface WakeSupervisorOptions {
  timeoutMs?: number;
  maxTokens?: number;
  alert: (batch: SupervisedWake, reason: string) => Promise<void>;
  complete: (batch: SupervisedWake, event: AgentEndEvent, tokens?: number) => Promise<void>;
  sessionTokens: (sessionKey: string) => Promise<number | undefined>;
}

/** Watches turn completion independently of hook admission or reportTo configuration. */
export class WakeSupervisor {
  private readonly pending = new Map<string, PendingWake>();
  private readonly handledRuns = new Set<string>();

  constructor(private readonly options: WakeSupervisorOptions) {}

  track(batch: SupervisedWake): void {
    if (this.pending.has(batch.batchId)) return;
    // Bound resource usage; eviction is loud, never silent.
    if (this.pending.size >= 100) {
      const oldest = this.pending.values().next().value;
      if (oldest) {
        this.expire(oldest, "wake supervision capacity exceeded");
        this.untrack(oldest.batchId);
      }
    }
    // directSend has a 20s delivery timeout: <=40s leaves the one-minute alert budget.
    const configured = this.options.timeoutMs;
    const timeout = typeof configured === "number" && Number.isFinite(configured)
      ? Math.min(40_000, Math.max(1, configured)) : DEFAULT_WAKE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      const pending = this.pending.get(batch.batchId);
      if (pending) this.expire(pending, "wake completion timeout");
    }, timeout);
    timer.unref?.();
    this.pending.set(batch.batchId, { ...batch, timer, alerted: false });
  }

  bindRun(batchId: string, runId?: string): void {
    const batch = this.pending.get(batchId);
    if (batch && runId) batch.hookRunId = runId;
  }

  async alert(batchId: string, reason: string): Promise<void> {
    const batch = this.pending.get(batchId);
    if (!batch || batch.alerted) return;
    batch.alerted = true;
    await this.options.alert(batch, reason);
  }

  untrack(batchId: string): void {
    const batch = this.pending.get(batchId);
    if (batch) clearTimeout(batch.timer);
    this.pending.delete(batchId);
  }

  async onAgentEnd(event: AgentEndEvent, ctx?: { sessionKey?: string; runId?: string }): Promise<void> {
    const runId = event.runId ?? ctx?.runId;
    if (runId && this.handledRuns.has(runId)) return;
    const session = (event.sessionKey ?? ctx?.sessionKey)?.toLowerCase();
    if (!session) return;
    const candidates = [...this.pending.values()].filter((b) => b.sessionKey.toLowerCase() === session);
    const batch = (runId ? candidates.find((b) => b.hookRunId === runId) : candidates[0])
      ?? candidates.find((b) => !b.hookRunId);
    if (!batch) return;
    // Claim synchronously before any I/O, so duplicate hooks cannot consume another batch.
    clearTimeout(batch.timer);
    this.pending.delete(batch.batchId);
    if (runId) {
      this.handledRuns.add(runId);
      if (this.handledRuns.size > 500) this.handledRuns.delete(this.handledRuns.values().next().value!);
    }
    const reason = wakeFailureReason(event);
    if (reason && !batch.alerted) {
      batch.alerted = true;
      await this.options.alert(batch, reason);
    }
    const tokens = wakeEventTokens(event);
    console.log(`[imajin-ws] wake ended batch=${batch.batchId} sessionTokens=${tokens ?? "unavailable"} source=final-assistant limit=${this.options.maxTokens ?? DEFAULT_WAKE_MAX_TOKENS}`);
    if (tokens !== undefined && tokens > (this.options.maxTokens ?? DEFAULT_WAKE_MAX_TOKENS) && !batch.alerted) {
      await this.options.alert(batch, `session size ${tokens} tokens exceeds wake limit`);
    }
    await this.options.complete(batch, event, tokens);
  }

  dispose(): void {
    for (const batch of this.pending.values()) clearTimeout(batch.timer);
    this.pending.clear();
  }

  private expire(batch: PendingWake, reason: string): void {
    console.log(`[imajin-ws] wake ended batch=${batch.batchId} sessionTokens=unavailable reason=timeout`);
    void this.alert(batch.batchId, reason).catch(() => {
      console.error("[imajin-ws] wake timeout alert delivery failed");
    });
    // Keep bounded correlation after timeout: a late successful turn still updates continuity.
    void this.options.complete(batch, { success: false, error: reason, messages: [], wakeWatchdog: true }).catch(() => {
      console.error("[imajin-ws] wake timeout bridge writeback failed");
    });
  }
}
