/**
 * Approvals bridge → loops rail (#64): marks the loop that owns a pending
 * approval as blocked while it waits on an operator, and returns it to running
 * once the approval is settled or has expired.
 *
 * Observe-only: nothing here ever throws or returns a value the approval flow
 * depends on. A failing `tracker.block` / `tracker.unblock` is logged and
 * dropped.
 *
 * Several approvals can be pending for one session at once, so the loop is
 * blocked on the first and only unblocked when the last one is released —
 * otherwise settling one approval would flip a still-waiting loop to running.
 */

import type { LoopRef } from "./loop-tracker.js";

/** The subset of `LoopTracker` this module drives. */
export interface ApprovalLoopTracker {
  block(ref: LoopRef, reason: string): void;
  unblock(ref: LoopRef): void;
}

export interface ApprovalLoopBlockerLogger {
  warn: (message: string) => void;
}

export interface ApprovalLoopBlocker {
  /** Marks `owner`'s loop blocked on `proposalId`. Idempotent per proposal. */
  block(proposalId: string, owner: LoopRef | undefined, reason: string, expiresAtMs?: number): void;
  /** The approval was decided, expired or evicted: unblock once nothing else is pending for the owner. */
  release(proposalId: string): void;
  /** Cancels expiry timers. Does not unblock. */
  dispose(): void;
  /** Number of approvals currently holding a loop blocked. Exposed for tests. */
  pendingCount(): number;
}

interface Held {
  ownerKey: string;
  owner: LoopRef;
  timer?: ReturnType<typeof setTimeout>;
}

/** `setTimeout` fires immediately for delays above 2^31-1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function ownerKeyOf(owner: LoopRef | undefined): string | undefined {
  if (owner?.sessionKey) return `session:${owner.sessionKey}`;
  if (owner?.jobId) return `job:${owner.jobId}`;
  return undefined;
}

export function createApprovalLoopBlocker(
  tracker: ApprovalLoopTracker,
  logger?: ApprovalLoopBlockerLogger,
): ApprovalLoopBlocker {
  const warn = logger?.warn ?? ((m: string) => console.warn(m));
  const held = new Map<string, Held>();
  const perOwner = new Map<string, number>();

  const safely = (name: string, fn: () => void): void => {
    try {
      fn();
    } catch (err: unknown) {
      warn(`[imajin-loops] approval ${name} ignored (${err instanceof Error ? err.name : "error"})`);
    }
  };

  const release = (proposalId: string): void => {
    const entry = held.get(proposalId);
    if (!entry) return;
    held.delete(proposalId);
    if (entry.timer) clearTimeout(entry.timer);
    const remaining = (perOwner.get(entry.ownerKey) ?? 1) - 1;
    if (remaining > 0) {
      perOwner.set(entry.ownerKey, remaining);
      return;
    }
    perOwner.delete(entry.ownerKey);
    safely("unblock", () => tracker.unblock(entry.owner));
  };

  const block = (
    proposalId: string,
    owner: LoopRef | undefined,
    reason: string,
    expiresAtMs?: number,
  ): void => {
    safely("block", () => {
      const ownerKey = ownerKeyOf(owner);
      if (!owner || !ownerKey || held.has(proposalId)) return;
      const entry: Held = { ownerKey, owner };
      held.set(proposalId, entry);
      const count = (perOwner.get(ownerKey) ?? 0) + 1;
      perOwner.set(ownerKey, count);
      if (count === 1) safely("block", () => tracker.block(owner, reason));
      // An expired approval is never decided, so the bridge would otherwise
      // never learn the loop resumed. Expiry unblocks it.
      if (typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs)) {
        const delay = Math.min(Math.max(expiresAtMs - Date.now(), 0), MAX_TIMER_MS);
        entry.timer = setTimeout(() => release(proposalId), delay);
        entry.timer.unref?.();
      }
    });
  };

  return {
    block,
    release: (proposalId) => safely("unblock", () => release(proposalId)),
    dispose: () => {
      for (const entry of held.values()) if (entry.timer) clearTimeout(entry.timer);
    },
    pendingCount: () => held.size,
  };
}
