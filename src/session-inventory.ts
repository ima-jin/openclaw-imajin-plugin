import type { SessionGateway, GatewaySession } from "./session-command-gateway.js";
import { isPrimarySessionKey, type LoopTracker } from "./loop-tracker.js";
import type { LoopSender } from "./loop-publisher.js";
import { sessionHistoryOutputs } from "./session-history.js";

export interface SessionInventory {
  refresh(): Promise<void>;
  onConnected(): void;
  onEvent(event: { event: string; payload?: unknown }): void;
  history(loopId: string): Promise<void>;
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
  const warn = () => opts.warn?.("[imajin-sessions] inventory/history unavailable");
  const history = async (loopId: string): Promise<void> => {
    const target = opts.tracker.resolveLoop(loopId);
    if (!target) throw new Error("session loop is not active");
    const messages = await opts.gateway.history(target.sessionKey);
    for (const output of sessionHistoryOutputs(messages)) {
      if (disposed || !opts.tracker.resolveLoop(loopId)) return;
      opts.tracker.publishSessionOutput(loopId, output);
      await opts.sender.idle();
    }
  };
  const observe = async (session: GatewaySession): Promise<void> => {
    if (!isPrimarySessionKey(session.key) || session.spawnedBy) return;
    const identity = session.sessionId ?? session.key;
    const first = known.get(session.key) !== identity;
    opts.tracker.onSessionSnapshot(session);
    await opts.sender.idle();
    if (disposed) return;
    if (session.archived) { known.delete(session.key); return; }
    if (first) {
      const target = opts.tracker.lookupSession(session.key);
      if (target) {
        try {
          await history(target.loopId);
          known.set(session.key, identity);
        } catch { warn(); }
      }
    }
  };
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    dirty = true;
    pending ??= (async () => {
      while (dirty && !disposed) {
        dirty = false;
        const sessions = await opts.gateway.list();
        for (const session of sessions) {
          if (disposed) return;
          await observe(session);
        }
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  return {
    refresh,
    history,
    onConnected() {
      void opts.gateway.subscribe().then(refresh).catch(warn);
    },
    onEvent(event) {
      if (event.event === "sessions.changed") void refresh().catch(warn);
    },
    dispose() { disposed = true; known.clear(); },
  };
}
