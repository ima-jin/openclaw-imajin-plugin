import type { SessionGateway, GatewaySession } from "./session-command-gateway.js";
import { isPrimarySessionKey, type LoopTracker } from "./loop-tracker.js";
import type { LoopSender } from "./loop-publisher.js";
import { sessionHistoryOutputs } from "./session-history.js";

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
}): SessionInventory {
  let disposed = false;
  let pending: Promise<void> | undefined;
  let dirty = false;
  const known = new Map<string, string>();
  const scheduled = new Set<string>();
  let historyChain = Promise.resolve();
  const warn = () => opts.warn?.("[imajin-sessions] inventory/history unavailable");
  const history = async (loopId: string): Promise<void> => {
    if (disposed) return;
    const target = opts.tracker.resolveLoop(loopId);
    if (!target) throw new Error("session loop is not active");
    const messages = await opts.gateway.history(target.sessionKey);
    await sessionHistoryOutputs(messages).reduce(async (previous, output) => {
      await previous;
      if (disposed || !opts.tracker.resolveLoop(loopId)) return;
      opts.tracker.publishSessionOutput(loopId, output);
      await opts.sender.idle();
    }, Promise.resolve());
  };
  const observe = async (session: GatewaySession): Promise<(() => void) | undefined> => {
    if (!isPrimarySessionKey(session.key) || session.spawnedBy) return;
    const identity = session.sessionId ?? session.key;
    const first = known.get(session.key) !== identity;
    opts.tracker.onSessionSnapshot(session);
    await opts.sender.idle();
    if (disposed) return;
    if (session.archived) { known.delete(session.key); return; }
    if (first) {
      const target = opts.tracker.lookupSession(session.key);
      if (!target || scheduled.has(target.loopId)) return;
      return () => {
        scheduled.add(target.loopId);
        historyChain = historyChain.then(async () => {
          if (disposed || !opts.tracker.resolveLoop(target.loopId)) return;
          await history(target.loopId);
          known.set(session.key, identity);
        }).catch(warn).finally(() => { scheduled.delete(target.loopId); });
      };
    }
  };
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    dirty = true;
    const reconcile = async (): Promise<void> => {
      if (!dirty || disposed) return;
      dirty = false;
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
    dispose() { disposed = true; known.clear(); scheduled.clear(); },
  };
}
