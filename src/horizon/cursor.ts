import { open, readFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { canonicalize } from "../approval-bridge.js";
import { digest, record, type MappedItem, type StepFact, type StepRequest } from "./model.js";

interface ItemCursor {
  immutable: string;
  update: Record<string, unknown>;
  facts: Record<string, string>;
}
export interface Cursor {
  version: 1;
  scope: string;
  lastAt: number;
  steps: Record<string, ItemCursor>;
  pending?: {
    requests: StepRequest[];
    steps: Record<string, ItemCursor>;
    at: number;
  };
}
export interface PlannedFact extends StepFact {
  item: MappedItem;
}
function immutable(item: MappedItem): string {
  const { intention: _intention, rank: _rank, ...fields } = item.declaration;
  return canonicalize(fields);
}
export function planDiff(items: MappedItem[], cursor: Cursor) {
  const steps: Cursor["steps"] = structuredClone(cursor.steps);
  const events: PlannedFact[] = [];
  for (const item of items) {
    const previous = cursor.steps[item.stepId];
    if (previous && previous.immutable !== immutable(item)) throw new Error("immutable declaration changed");
    if (!previous) events.push({ type: "step.queued", data: { step: item.declaration }, item });
    const update: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(item.update)) {
      if (canonicalize(value) !== canonicalize(previous?.update[field] ?? null)) update[field] = value;
    }
    // A new declaration already carries rank and intention.
    if (!previous) {
      delete update.rank;
      delete update.intention;
    }
    if (Object.keys(update).length) events.push({ type: "step.updated", data: { update }, item });
    const facts = { ...previous?.facts };
    for (const [name, fact] of Object.entries(item.facts)) {
      const fingerprint = digest(fact);
      if (facts[name] !== fingerprint) events.push({ ...fact, item });
      facts[name] = fingerprint;
    }
    steps[item.stepId] = {
      immutable: immutable(item),
      update: { ...previous?.update, ...item.update },
      facts,
    };
  }
  return { steps, events };
}
export async function loadCursor(path: string, scope: string): Promise<Cursor> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, scope, lastAt: 0, steps: {} };
    throw error;
  }
  const cursor = record(JSON.parse(raw));
  if (cursor.version !== 1 || cursor.scope !== scope || !Number.isFinite(cursor.lastAt)) throw new Error("invalid cursor");
  const steps = record(cursor.steps);
  for (const item of Object.values(steps)) {
    const entry = record(item);
    if (typeof entry.immutable !== "string") throw new Error("invalid cursor item");
    record(entry.update);
    record(entry.facts);
  }
  if (cursor.pending !== undefined) {
    const pending = record(cursor.pending);
    if (!Array.isArray(pending.requests) || !Number.isFinite(pending.at)) throw new Error("invalid outbox");
    record(pending.steps);
    for (const request of pending.requests) {
      const envelope = record(request);
      record(envelope.payload);
      record(envelope.signature);
      if (typeof envelope.type !== "string" || typeof envelope.publisherDid !== "string") throw new Error("invalid outbox event");
    }
  }
  return cursor as unknown as Cursor;
}
/** fsync + same-directory rename: no partially written cursor, even after a crash. */
export async function saveCursor(path: string, cursor: Cursor): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(cursor));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
