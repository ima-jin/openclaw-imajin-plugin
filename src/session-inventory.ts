import type { SessionGateway, GatewaySession } from "./session-command-gateway.js";
import { isPrimarySessionKey, type LoopTracker } from "./loop-tracker.js";
import type { LoopSender } from "./loop-publisher.js";
import { sessionHistoryEntries } from "./session-history.js";
import { SessionInventoryState } from "./session-inventory-state.js";

export interface SessionInventory {
  refresh(): Promise<void>;
  onConnected(): void;
  onEvent(event: { event: string; payload?: unknown }): void;
  history(loopId: string): Promise<void>;
  idle(): Promise<void>;
  dispose(): void;
}

/** All reads are local to this plugin. Only signed loop envelopes reach the kernel. */
export function createSessionInventory(opts: {
  gateway: SessionGateway;
  tracker: LoopTracker;
  sender: LoopSender;
  warn?: (message: string) => void;
  statePath?: string;
}): SessionInventory {
  let disposed = false;
  let pending: Promise<void> | undefined;
  let dirty = false;
  const identities = new Map<string, string>();
  const state = new SessionInventoryState(opts.statePath);
  const scheduled = new Set<string>();
  let historyChain = Promise.resolve();
  const warn = () => opts.warn?.("[imajin-sessions] inventory/history unavailable");
  const publishHistory = async (loopId: string): Promise<void> => {
    if (disposed) return;
    await state.load();
    const target = opts.tracker.resolveLoop(loopId);
    if (!target) throw new Error("session loop is not active");
    let identity = identities.get(target.sessionKey);
    if (!identity) {
      const row = (await opts.gateway.list()).find((s) => s.key === target.sessionKey);
      identity = row?.sessionId ?? target.sessionKey;
    }
    const messages = await opts.gateway.history(target.sessionKey);
    const entries = sessionHistoryEntries(messages);
    const point = state.get(identity).point;
    const last = entries.findIndex((entry) => entry.point === point);
    await entries.slice(last + 1).reduce(async (previous, entry) => {
      await previous;
      if (disposed || !opts.tracker.resolveLoop(loopId)) return;
      opts.tracker.publishSessionOutput(loopId, entry.output);
      await opts.sender.idle();
      await state.set(identity, { point: entry.point });
    }, Promise.resolve());
  };
  const history = (loopId: string): Promise<void> => {
    // Manual opens and automatic backfills share the same cursor/write order.
    const work = historyChain.then(() => publishHistory(loopId));
    historyChain = work.catch(() => undefined);
    return work;
  };
  const observe = async (session: GatewaySession): Promise<(() => void) | undefined> => {
    if (!isPrimarySessionKey(session.key) || session.spawnedBy) return;
    const identity = session.sessionId ?? session.key;
    identities.set(session.key, identity);
    const checkpoint = state.get(identity);
    opts.tracker.onSessionSnapshot(session, checkpoint.archived === true);
    await opts.sender.idle();
    if (disposed) return;
    if (session.archived) {
      if (!checkpoint.archived) await state.set(identity, { archived: true });
      return;
    }
    if (checkpoint.archived) await state.set(identity, { archived: false });
    const target = opts.tracker.lookupSession(session.key);
    if (!target || scheduled.has(target.loopId)) return;
    return () => {
      scheduled.add(target.loopId);
      void history(target.loopId).catch(warn).finally(() => { scheduled.delete(target.loopId); });
    };
  };
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    dirty = true;
    const reconcile = async (): Promise<void> => {
      if (!dirty || disposed) return;
      dirty = false;
      await state.load();
      const sessions = await opts.gateway.list();
      const backfills: Array<() => void> = [];
      await sessions.reduce(async (previous, session) => {
        await previous;
        if (disposed) return;
        const backfill = await observe(session);
        if (backfill) backfills.push(backfill);
      }, Promise.resolve());
      // Inventory takes priority over slow chat.history backfill.
      for (const backfill of backfills) backfill();
      return reconcile();
    };
    pending ??= reconcile().finally(() => { pending = undefined; });
    return pending;
  };
  return {
    refresh,
    history,
    async idle() { await pending; await historyChain; await opts.sender.idle(); },
    onConnected() {
      if (disposed) return;
      void opts.gateway.subscribe().then(refresh).catch(warn);
    },
    onEvent(event) {
      if (event.event === "sessions.changed") void refresh().catch(warn);
    },
    dispose() { disposed = true; identities.clear(); scheduled.clear(); },
  };
}
