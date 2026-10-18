import type { AgentEndEvent } from "./turn-usage-attestation.js";
import { compactWakeEndEvent, extractWakeBatchId } from "./wake-report.js";
import { randomUUID } from "node:crypto";

export const DEFAULT_WAKE_DECISION_MODEL = "anthropic/claude-opus-5-5";
const WORKER_TOOLS = ["message", "sessions_spawn", "session_status"];
const MAX_CHILDREN = 32;

export interface WakeHookContext {
  sessionKey?: string;
  runId?: string;
}

export interface WakeToolEvent {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  toolCallId?: string;
  runId?: string;
}

interface DecisionWake {
  batchId: string;
  sessionKey: string;
  children: Set<string>;
  parentEnd?: AgentEndEvent;
  childEnd?: AgentEndEvent;
  failed: boolean;
  delegations: number;
}

export interface SettledWake {
  batchId: string;
  sessionKey: string;
  event: AgentEndEvent;
}

/** Wake workers coordinate only; all substantive tool work runs in pinned children. */
export class WakeDecisionRouter {
  private readonly wakes = new Map<string, DecisionWake>();
  private readonly roots = new Map<string, string>();
  private readonly runners = new Map<string, string>();
  private readonly tickets = new Map<string, string>();

  constructor(
    readonly model: string,
    private readonly reportTo: readonly string[],
    private readonly childAdded: (parent: string, child: string, runId: string | undefined, batchId: string) => void,
  ) {}

  track(sessionKey: string, batchId = sessionKey): void {
    if (this.wakes.has(batchId)) return;
    if (this.wakes.size >= 100) this.untrack(this.wakes.keys().next().value!);
    this.wakes.set(batchId, { batchId, sessionKey, children: new Set(), failed: false, delegations: 0 });
    if (!this.roots.has(sessionKey)) this.roots.set(sessionKey, batchId);
  }

  root(sessionKey?: string): string | undefined {
    return this.find({ sessionKey })?.sessionKey;
  }

  bindRunner(batchId: string, runId: string): void {
    const wake = this.wakes.get(batchId);
    if (!wake) return;
    this.runners.set(runId, batchId);
    this.roots.set(wake.sessionKey, batchId);
  }

  private find(ctx: WakeHookContext): DecisionWake | undefined {
    if (!ctx.sessionKey || !this.roots.has(ctx.sessionKey)) return;
    const id = ctx.runId ? this.runners.get(ctx.runId) : undefined;
    const wake = this.wakes.get(id ?? this.roots.get(ctx.sessionKey) ?? "");
    if (wake && this.roots.get(ctx.sessionKey) === wake.batchId) return wake;
    // A fixed parent may have advanced while a prior accepted child is still working.
    if (wake?.sessionKey === ctx.sessionKey) return wake;
  }

  beforePromptBuild(_event: unknown, ctx: WakeHookContext) {
    const wake = this.find(ctx);
    if (!wake) return;
    const reporting = `Send a concrete outcome using message action=send to every reportTo target: ${JSON.stringify(this.reportTo)}. Final prose and NO_REPLY do not disclose an outcome. If blocked, disclose what did not finish.`;
    if (wake.sessionKey !== ctx.sessionKey) {
      return { appendSystemContext: "This is delegated Warp decision work. Review/merge/enqueue/dispatch here, using live state before acting. Call imajin_wake_report with outcome=completed or blocked and concrete evidence before ending; it sends a real channel message to every configured reportTo target. Subagents do not have the normal message tool." };
    }
    return {
      toolsAllow: [...WORKER_TOOLS],
      appendSystemContext: `Warp wake coordinator: delegate review, merge, enqueue and dispatch work with sessions_spawn, runtime=subagent, model=${this.model}. Pass the entire live-state preamble and relevant horizon/bridge evidence in the task. Do not perform decision work yourself. ${reporting}`,
    };
  }

  beforeModelResolve(event: { prompt?: string }, ctx: WakeHookContext) {
    this.correlateTicket(event.prompt, ctx);
    const wake = this.find(ctx);
    if (!wake || wake.sessionKey === ctx.sessionKey) return;
    const slash = this.model.indexOf("/");
    if (slash < 1) return { modelOverride: this.model };
    return { providerOverride: this.model.slice(0, slash), modelOverride: this.model.slice(slash + 1) };
  }

  beforeToolCall(event: WakeToolEvent, ctx: WakeHookContext) {
    const wake = this.find(ctx);
    if (!wake) return;
    if (event.toolName === "sessions_spawn") {
      if (wake.delegations >= MAX_CHILDREN) return { block: true, blockReason: "Wake decision delegation capacity exceeded; report the blocker." };
      const ticket = randomUUID();
      this.tickets.set(ticket, wake.batchId);
      wake.delegations++;
      return { params: {
        ...event.params, runtime: "subagent", model: this.model,
        task: `Wake decision ticket: ${ticket}\n${String(event.params.task ?? "")}`,
      } };
    }
    if (ctx.sessionKey === wake.sessionKey && !WORKER_TOOLS.includes(event.toolName)) {
      return { block: true, blockReason: `Wake decision actions must run in a sessions_spawn subagent on ${this.model}.` };
    }
  }

  onSubagentSpawned(
    event: { childSessionKey?: string; runId?: string },
    ctx: { requesterSessionKey?: string; runId?: string },
  ): void {
    const wake = this.find({ sessionKey: ctx.requesterSessionKey, runId: ctx.runId });
    const child = event.childSessionKey;
    if (!wake || !child || this.roots.has(child)) return;
    wake.children.add(child);
    this.roots.set(child, wake.batchId);
    if (event.runId) this.runners.set(event.runId, wake.batchId);
    this.childAdded(wake.sessionKey, child, event.runId, wake.batchId);
  }

  /** The native child can start before subagent_spawned is emitted. */
  private correlateTicket(prompt: string | undefined, ctx: WakeHookContext): void {
    if (!ctx.sessionKey?.includes(":subagent:") || !prompt) return;
    const ticket = /Wake decision ticket: ([a-f0-9-]{36})/.exec(prompt)?.[1];
    const batchId = ticket ? this.tickets.get(ticket) : undefined;
    const wake = batchId ? this.wakes.get(batchId) : undefined;
    if (!wake) return;
    this.tickets.delete(ticket!);
    this.onSubagentSpawned({ childSessionKey: ctx.sessionKey, runId: ctx.runId },
      { requesterSessionKey: wake.sessionKey, runId: this.runnerFor(wake.batchId) });
  }

  private runnerFor(batchId: string): string | undefined {
    for (const [runId, id] of this.runners) if (id === batchId) return runId;
  }

  batch(ctx: WakeHookContext): string | undefined {
    return this.find(ctx)?.batchId;
  }

  wrongDecisionModel(event: { provider?: string; model?: string }, ctx: WakeHookContext): string | undefined {
    const wake = this.find(ctx);
    if (!wake || ctx.sessionKey === wake.sessionKey || !event.model) return;
    const actual = `${event.provider}/${event.model}`;
    if (event.model !== this.model && actual !== this.model) return wake.batchId;
  }

  /** Fallback correlation for hosts whose spawn tool result precedes the spawn hook. */
  afterToolCall(event: WakeToolEvent, ctx: WakeHookContext): void {
    if (event.toolName !== "sessions_spawn" || event.error) return;
    const result = spawnResult(event.result);
    if (result?.childSessionKey) {
      this.onSubagentSpawned(result, { requesterSessionKey: ctx.sessionKey, runId: ctx.runId });
    }
  }

  /** Parent endings wait for accepted children; neither NO_REPLY nor delegation is success. */
  end(event: AgentEndEvent, ctx: WakeHookContext): SettledWake | undefined {
    const session = event.sessionKey ?? ctx.sessionKey;
    const batchId = extractWakeBatchId(event.messages);
    const wake = batchId ? this.wakes.get(batchId) : this.find({ sessionKey: session, runId: event.runId ?? ctx.runId });
    if (!wake || !session) return;
    if (session !== wake.sessionKey && this.roots.get(session) !== wake.batchId) return;
    wake.failed ||= event.success === false;
    if (session === wake.sessionKey) wake.parentEnd = { ...compactWakeEndEvent(event), runId: event.runId ?? ctx.runId };
    else {
      wake.childEnd = compactWakeEndEvent(event);
      wake.children.delete(session);
    }
    if (!wake.parentEnd || wake.children.size) return;
    const parent = wake.parentEnd;
    const output = wake.childEnd ?? parent;
    return {
      batchId: wake.batchId,
      sessionKey: wake.sessionKey,
      event: {
        ...parent,
        messages: [{ role: "user", content: `Wake batch ID: ${wake.batchId}` }, ...(output.messages ?? [])],
        success: !wake.failed, sessionKey: wake.sessionKey,
      },
    };
  }

  untrack(batchId: string): void {
    for (const [ticket, value] of this.tickets) if (value === batchId) this.tickets.delete(ticket);
    for (const map of [this.roots, this.runners]) {
      for (const [key, value] of map) if (value === batchId) map.delete(key);
    }
    this.wakes.delete(batchId);
    for (const [id, wake] of this.wakes) {
      if (!this.roots.has(wake.sessionKey)) this.roots.set(wake.sessionKey, id);
    }
  }

  dispose(): void {
    this.wakes.clear();
    this.roots.clear();
    this.runners.clear();
    this.tickets.clear();
  }
}

function spawnResult(value: unknown): { childSessionKey?: string; runId?: string } | undefined {
  if (!value || typeof value !== "object") return;
  const result = value as Record<string, unknown>;
  if (result.isError === true) return;
  if (result.status !== undefined && result.status !== "accepted") return;
  if (typeof result.childSessionKey === "string") return result as { childSessionKey: string; runId?: string };
  if (result.details && typeof result.details === "object") return spawnResult(result.details);
  if (!Array.isArray(result.content)) return;
  for (const block of result.content) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    try {
      const parsed = JSON.parse(block.text);
      const spawn = spawnResult(parsed);
      if (spawn) return spawn;
    } catch { /* A non-JSON tool result is not spawn evidence. */ }
  }
}
