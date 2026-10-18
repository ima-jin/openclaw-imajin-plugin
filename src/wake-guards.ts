import { createHash } from "node:crypto";
import { redactWakeText, SECRET_KEY } from "./wake-redaction.js";

export const DEFAULT_WAKE_TOKEN_BUDGET = 80_000;
const MAX_BATCHES = 100;
const MAX_CALLS = 128;
const MAX_SEEN = 2_048;
const MAX_TEXT = 1_024;

export interface GuardWakeBatch {
  batchId: string;
  sessionKey: string;
  subject: string;
  uniqueSession?: boolean;
}

export interface WakeGuardAlert extends GuardWakeBatch {
  tokens: number;
  contextSessionKey?: string;
  lastAssistantLine?: string;
  lastTool?: { toolName: string; args: string; result: string };
}

export interface WakeGuardContext {
  sessionKey?: string;
  runId?: string;
  /** Explicit plugin-owned correlation for synthetic terminal events. */
  batchId?: string;
}

export interface WakeGuardToolEvent extends WakeGuardContext {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
}

export interface WakeGuardOptions {
  maxTokens?: number;
  reportTo?: readonly { sessionKey: string }[];
  alert: (batch: WakeGuardAlert, reason: string) => Promise<void>;
  abort: (sessionKey: string, runId?: string) => Promise<void>;
}

interface Correlation {
  sessionKey: string;
  runId?: string;
  admissionId?: string;
  unique: boolean;
  contextTokens: number;
}

interface CallState {
  result: string;
  count: number;
}

interface Pending {
  batch: GuardWakeBatch;
  sessions: Map<string, Correlation>;
  calls: Map<string, CallState>;
  seenCalls: Set<string>;
  seenMessages: Set<string>;
  objects: WeakSet<object>;
  sent: Set<string>;
  alert: WakeGuardAlert;
  reason?: string;
  effects?: Promise<void>;
}

interface Destination {
  channel: string;
  target: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
function scalarIdentity(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
}

/** Only a single assistant call's usage, never llm_output's attempt aggregate. */
function usageTokens(value: unknown): number | undefined {
  const usage = record(value);
  if (!usage) return;
  const values = ["input", "output", "cacheRead", "cacheWrite"].map((key) => usage[key]);
  if (!values.some((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return;
  return values.reduce<number>((total, value) => total + finite(value), 0);
}

/** Full sorted-key hashes, but never retain full arguments/results or cyclic input. */
function signature(value: unknown): string | undefined {
  const hash = createHash("sha256");
  const ancestors = new Set<object>();
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 10_000 || depth > 32) throw new Error("signature bound");
    if (item === null || typeof item !== "object") {
      hash.update(`${typeof item}:${String(JSON.stringify(item))};`);
      return;
    }
    if (ancestors.has(item)) throw new Error("cyclic signature");
    ancestors.add(item);
    hash.update(Array.isArray(item) ? "[" : "{");
    for (const key of Object.keys(item).sort((a, b) => a.localeCompare(b))) {
      hash.update(JSON.stringify(key));
      visit((item as Record<string, unknown>)[key], depth + 1);
    }
    hash.update(Array.isArray(item) ? "]" : "}");
    ancestors.delete(item);
  }
  try {
    visit(value, 0);
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

/** Stable visible outcome only; transport/per-call telemetry is not progress. */
function resultSignature(event: WakeGuardToolEvent): string | undefined {
  const result = record(event.result);
  const details = record(result?.details);
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const content = blocks.flatMap((block) => {
    const text = record(block);
    return text?.type === "text" && typeof text.text === "string" ? [text.text] : [];
  });
  if (typeof event.result === "string") content.push(event.result);
  const error = event.error ?? result?.error;
  if (!content.length && error === undefined && result?.isError === undefined
    && details?.exitCode === undefined && details?.status === undefined) return;
  return signature({ content, isError: result?.isError, error, exitCode: details?.exitCode, status: details?.status });
}

function runningProcess(event: WakeGuardToolEvent): boolean {
  return event.toolName === "process" && (event.params.action === "poll" || event.params.action === "log")
    && record(record(event.result)?.details)?.status === "running";
}

/** Redacted, bounded evidence, never written to ordinary logs. */
function preview(value: unknown): string {
  let remaining = MAX_TEXT;
  const seen = new WeakSet<object>();
  const parts: string[] = [];
  function append(text: string): void {
    const part = text.slice(0, Math.max(0, remaining));
    remaining -= part.length;
    parts.push(part);
  }

  function visit(item: unknown, depth: number): void {
    if (remaining <= 0) return;
    if (!item || typeof item !== "object") {
      append(redactWakeText(String(item)));
      return;
    }
    if (seen.has(item) || depth > 8) {
      append("[omitted]");
      return;
    }
    seen.add(item);
    append("{");
    for (const key in item) {
      if (remaining <= 0) break;
      if (!Object.hasOwn(item, key)) continue;
      append(`${key}:`);
      if (SECRET_KEY.test(key)) append("[redacted]");
      else visit((item as Record<string, unknown>)[key], depth + 1);
      append(",");
    }
    append("}");
  }
  try { visit(value, 0); } catch { append("[unavailable]"); }
  return parts.join("");
}

function destination(sessionKey: string): Destination | undefined {
  const match = /^agent:[^:]+:([^:]+):(?:direct|dm|group|channel):(.+)$/.exec(sessionKey);
  if (!match) return;
  return { channel: match[1].toLowerCase(), target: match[2] };
}

function sentDestination(params: Record<string, unknown>, required: Destination): boolean {
  const target = params.target ?? params.to;
  if (typeof target !== "string") return false;
  const channel = params.channel;
  if (channel !== undefined && channel !== required.channel) return false;
  return target === required.target || target === `${required.channel}:${required.target}`;
}
function failedReceipt(result: Record<string, unknown>): boolean {
  return Boolean(result.error) || result.isError === true || result.ok === false
    || result.success === false || result.status === "error";
}

function positiveReceipt(result: Record<string, unknown>): boolean {
  return result.ok === true || result.success === true
    || (typeof result.messageId === "string" && result.messageId.length > 0);
}

function parsedReceipt(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value.length > 16_384) return;
  try { return record(JSON.parse(value)); } catch { return; }
}

function successful(event: WakeGuardToolEvent): boolean {
  if (event.error) return false;
  const result = record(event.result) ?? parsedReceipt(event.result);
  if (!result) return false;
  const receipts = [result];
  const details = record(result.details);
  if (details) receipts.push(details);
  const content = Array.isArray(result.content) ? result.content.slice(0, 32) : [];
  for (const block of content) {
    const receipt = parsedReceipt(record(block)?.text);
    if (receipt) receipts.push(receipt);
  }
  return !receipts.some(failedReceipt) && receipts.some(positiveReceipt);
}

function assistantLine(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return lastLine(content);
  if (!Array.isArray(content)) return "";
  for (let index = content.length - 1; index >= 0; index--) {
    const block = record(content[index]);
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) return lastLine(block.text);
  }
  return "";
}

function lastLine(text: string): string {
  const trimmed = redactWakeText(text).trimEnd();
  return trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim().slice(0, MAX_TEXT);
}

/**
 * Exact per-wake ownership. Reused sessions require bindRunner; the synchronous
 * write hook has no run ID, so it uses dedicated or explicitly active ownership.
 * No transcripts, tool payloads, or exception details enter normal logs.
 */
export class WakeGuards {
  private readonly pending = new Map<string, Pending>();
  private readonly finished = new Set<string>();
  private readonly writeOwners = new Map<string, string>();
  private readonly targets: readonly { key: string; destination?: Destination }[];
  private readonly targetOverflow: boolean;
  private readonly maxTokens: number;

  constructor(private readonly options: WakeGuardOptions) {
    this.maxTokens = finite(options.maxTokens) || DEFAULT_WAKE_TOKEN_BUDGET;
    const targets = [...new Set(options.reportTo?.map((target) => target.sessionKey) ?? [])];
    this.targetOverflow = targets.length > MAX_CALLS;
    this.targets = targets
      .slice(0, MAX_CALLS).map((key) => ({ key, destination: destination(key) }));
  }

  track(batch: GuardWakeBatch): boolean {
    if (this.pending.has(batch.batchId) || this.finished.has(batch.batchId)) return false;
    if (this.pending.size >= MAX_BATCHES) return false;
    const safe = { ...batch, subject: redactWakeText(batch.subject).slice(0, MAX_TEXT) };
    this.pending.set(batch.batchId, {
      batch: safe,
      sessions: new Map([[batch.sessionKey, {
        sessionKey: batch.sessionKey, unique: batch.uniqueSession === true, contextTokens: 0,
      }]]),
      calls: new Map(), seenCalls: new Set(), seenMessages: new Set(),
      objects: new WeakSet(), sent: new Set(), alert: { ...safe, tokens: 0 },
    });
    return true;
  }

  bindRun(batchId: string, runId?: string): void {
    const pending = this.pending.get(batchId);
    const session = pending?.sessions.get(pending.batch.sessionKey);
    if (!session || !runId) return;
    session.admissionId = runId;
    if (!session.unique) session.runId = runId;
  }

  /** Fixed-session callers must prove this runner from their current wake input. */
  bindRunner(batchId: string, runId: string): void {
    const pending = this.pending.get(batchId);
    const session = pending?.sessions.get(pending.batch.sessionKey);
    if (!session) return;
    session.runId = runId;
    this.writeOwners.set(session.sessionKey, batchId);
  }

  async stop(batchId: string, reason: string): Promise<void> {
    const pending = this.pending.get(batchId);
    if (pending) await this.trip(pending, reason.slice(0, MAX_TEXT) || "wake guard stopped");
  }
  /** Call only after the plugin's deterministic channel send has succeeded. */
  recordDisclosure(batchId: string, targetSessionKey: string): void {
    const pending = this.pending.get(batchId);
    if (!pending || pending.reason) return;
    if (this.targets.some((target) => target.key === targetSessionKey)) pending.sent.add(targetSessionKey);
  }
  /** Plugin-owned effect checks do not receive the host runner identity. */
  isStopped(batchId: string): boolean {
    const pending = this.pending.get(batchId);
    return !pending || Boolean(pending.reason);
  }

  hasReported(batchId: string): boolean {
    const pending = this.pending.get(batchId);
    return Boolean(pending && this.targets.length && this.reported(pending));
  }

  aliasSession(parentSessionKey: string, childSessionKey: string, runId?: string, batchId?: string): boolean {
    const matches = [...this.pending.values()].filter((pending) =>
      pending.batch.sessionKey === parentSessionKey && (!batchId || pending.batch.batchId === batchId));
    if (matches.length !== 1 || matches[0].sessions.size >= MAX_CALLS) return false;
    const pending = matches[0];
    if (pending.sessions.has(childSessionKey) || pending.reason) return false;
    pending.sessions.set(childSessionKey, { sessionKey: childSessionKey, runId, unique: true, contextTokens: 0 });
    return true;
  }

  beforeToolCall(event: WakeGuardToolEvent, ctx?: WakeGuardContext): { block: true; blockReason: string } | undefined {
    const match = this.match(event, ctx);
    if (!match?.pending.reason) return;
    return { block: true, blockReason: match.pending.reason };
  }

  async afterToolCall(event: WakeGuardToolEvent, ctx?: WakeGuardContext): Promise<void> {
    const match = this.match(event, ctx);
    if (!match) return;
    const { pending } = match;
    if (pending.reason) return pending.effects;
    const callId = event.toolCallId && `${match.session.sessionKey}:${event.toolCallId}`;
    if (callId && pending.seenCalls.has(callId)) return;
    if (callId) this.remember(pending.seenCalls, callId);
    pending.alert.lastTool = {
      toolName: event.toolName.slice(0, 128), args: preview(event.params),
      result: event.toolName === "imajin_vault" ? "[vault result omitted]" : preview(event.result),
    };
    this.disclosure(pending, event);
    const args = signature(event.params);
    if (!args) return;
    const key = `${event.toolName}:${args}`;
    if (runningProcess(event)) {
      pending.calls.delete(key);
      return;
    }
    const result = resultSignature(event);
    if (!result) return;
    const previous = pending.calls.get(key);
    const count = previous?.result === result ? previous.count + 1 : 1;
    pending.calls.delete(key);
    pending.calls.set(key, { result, count });
    if (pending.calls.size > MAX_CALLS) pending.calls.delete(pending.calls.keys().next().value!);
    if (count >= 3) await this.trip(pending, "repeated tool call without progress");
  }

  onBeforeMessageWrite(event: { message: unknown; sessionKey?: string }, ctx?: WakeGuardContext): void {
    const match = this.match(event, ctx, true);
    const message = record(event.message);
    if (!match || message?.role !== "assistant" || match.pending.reason) return;
    const { pending, session } = match;
    pending.alert.lastAssistantLine = assistantLine(message);
    if (!this.newMessage(pending, session, message)) return;
    this.observeContext(pending, session, message.usage);
  }

  async onLlmOutput(event: WakeGuardContext & { usage?: unknown; lastAssistant?: unknown; assistantTexts?: string[] },
    ctx?: WakeGuardContext): Promise<void> {
    const match = this.match(event, ctx);
    if (!match) return;
    const { pending, session } = match;
    // event.usage is billed usage over an entire attempt. Only lastAssistant is per-call.
    const assistant = record(event.lastAssistant);
    if (assistant) pending.alert.lastAssistantLine = assistantLine(assistant);
    if (assistant && this.newMessage(pending, session, assistant)) this.observeContext(pending, session, assistant.usage);
    await pending.effects;
  }

  async end(event: WakeGuardContext & { messages?: unknown[] }, ctx?: WakeGuardContext): Promise<string | undefined> {
    const match = this.match(event, ctx, false, true);
    if (!match) return;
    const { pending } = match;
    const messages = event.messages ?? [];
    let stopReason: unknown;
    for (let index = messages.length - 1; index >= 0; index--) {
      const raw = messages[index];
      const message = record(raw);
      if (message?.role !== "assistant") continue;
      pending.alert.lastAssistantLine = assistantLine(message);
      stopReason = message.stopReason;
      break;
    }
    if (!pending.reason && !this.reported(pending)) {
      const suffix = stopReason === "length" ? "; stopReason=length (truncated reply)" : "";
      await this.trip(pending, `wake ended without reporting${suffix}`);
    }
    await pending.effects;
    this.untrack(pending.batch.batchId);
    this.remember(this.finished, pending.batch.batchId);
    return pending.reason;
  }

  untrack(batchId: string): void {
    for (const [sessionKey, owner] of this.writeOwners) {
      if (owner === batchId) this.writeOwners.delete(sessionKey);
    }
    this.pending.delete(batchId);
  }

  dispose(): void {
    this.pending.clear();
    this.finished.clear();
    this.writeOwners.clear();
  }

  private match(event: WakeGuardContext, ctx?: WakeGuardContext, messageWrite = false, ending = false):
    { pending: Pending; session: Correlation } | undefined {
    const sessionKey = event.sessionKey ?? ctx?.sessionKey;
    const runId = event.runId ?? ctx?.runId;
    const batchId = event.batchId ?? ctx?.batchId;
    if (!sessionKey) return;
    if (event.sessionKey && ctx?.sessionKey && event.sessionKey !== ctx.sessionKey) return;
    if (event.runId && ctx?.runId && event.runId !== ctx.runId) return;
    const candidates = [...this.pending.values()].filter((pending) => {
      if (batchId && pending.batch.batchId !== batchId) return false;
      const session = pending.sessions.get(sessionKey);
      if (!session) return false;
      if (messageWrite) return session.unique || this.writeOwners.get(sessionKey) === pending.batch.batchId;
      return session.runId === runId || (!session.runId && session.unique) || (ending && Boolean(batchId) && !runId);
    });
    if (candidates.length !== 1) return;
    const pending = candidates[0];
    const session = pending.sessions.get(sessionKey)!;
    if (messageWrite) return { pending, session };
    if (!runId) return ending && batchId ? { pending, session } : undefined;
    if (session.runId && session.runId !== runId) return;
    if (!session.runId && !session.unique) return;
    session.runId ??= runId;
    return { pending, session };
  }

  private newMessage(pending: Pending, session: Correlation, message: Record<string, unknown>): boolean {
    if (pending.objects.has(message)) return false;
    pending.objects.add(message);
    const id = scalarIdentity(message.id) ?? scalarIdentity(message.timestamp);
    if (id === undefined) return true;
    let key = `${session.sessionKey}:${id}`;
    if (message.id === undefined) key += `:${signature(message)}`;
    if (pending.seenMessages.has(key)) return false;
    this.remember(pending.seenMessages, key);
    return true;
  }

  private disclosure(pending: Pending, event: WakeGuardToolEvent): void {
    if (event.toolName !== "message" || event.params.action !== "send" || !successful(event)) return;
    const matches = this.targets.filter((target) =>
      target.destination && sentDestination(event.params, target.destination));
    if (event.params.channel === undefined && new Set(matches.map((target) => target.destination?.channel)).size > 1) return;
    for (const target of matches) {
      pending.sent.add(target.key);
    }
  }

  private reported(pending: Pending): boolean {
    return !this.targetOverflow && this.targets.every((target) => pending.sent.has(target.key));
  }

  private observeContext(pending: Pending, session: Correlation, usage: unknown): void {
    const tokens = usageTokens(usage);
    if (tokens === undefined) return;
    session.contextTokens = tokens;
    pending.alert.tokens = Math.max(...[...pending.sessions.values()].map((item) => item.contextTokens));
    if (tokens > this.maxTokens) {
      pending.alert.contextSessionKey = session.sessionKey;
      void this.trip(pending, "wake per-session context ceiling exceeded");
    }
  }

  private trip(pending: Pending, reason: string): Promise<void> {
    if (pending.effects) return pending.effects;
    pending.reason = reason; // Synchronous latch: the next tool cannot slip past I/O.
    const effects = [...pending.sessions.values()].map((session) =>
      Promise.resolve().then(() => this.options.abort(session.sessionKey, session.runId ?? session.admissionId)));
    effects.push(Promise.resolve().then(() => this.options.alert({ ...pending.alert }, reason)));
    pending.effects = Promise.allSettled(effects).then(() => {});
    return pending.effects;
  }

  private remember(set: Set<string>, key: string): void {
    set.add(key);
    if (set.size > MAX_SEEN) set.delete(set.values().next().value!);
  }
}
