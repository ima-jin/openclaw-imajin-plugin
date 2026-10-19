import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createLoopTransport, type LoopSenderOptions } from "../loop-publisher.js";
import { loadCursor, planDiff, saveCursor, type Cursor } from "./cursor.js";
import { digest, mapItem, parseHorizon, text, type StepEnvelope, type StepRequest } from "./model.js";
import { deliveryResult, rejectedStepWarning, saveDeadLetter } from "./outbox.js";

export interface HorizonConfig {
  enabled?: boolean;
  /** Existing owning kernel loop; this service never invents a loop lifecycle. */
  loopId?: string;
  repository?: string;
  filePath?: string;
  stateDir?: string;
  syncIntervalMs?: number;
}
export interface HorizonSyncOptions extends LoopSenderOptions {
  config: HorizonConfig;
}
function expandPath(path: string): string {
  return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}
// One live plugin process per cursor. Separate instances within that process
// share serialization; no persistent lock can strand a restarted harness.
const writers = new Map<string, Promise<void>>();
function withLock(path: string, work: () => Promise<void>): Promise<void> {
  const previous = writers.get(path) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(work);
  const guarded = result.finally(() => {
    if (writers.get(path) === guarded) writers.delete(path);
  });
  writers.set(path, guarded);
  return guarded;
}
export function createHorizonSync(options: HorizonSyncOptions) {
  const loopId = text(options.config.loopId);
  const repository = text(options.config.repository);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("invalid repository");
  if (!/^did:[^\s:]+:\S+$/.test(options.did)) throw new Error("invalid publisher DID");
  const principal = options.principal ?? options.did;
  if (!/^did:[^\s:]+:\S+$/.test(principal)) throw new Error("invalid principal DID");
  const nodeUrl = new URL(options.nodeUrl);
  if (!["http:", "https:"].includes(nodeUrl.protocol) || nodeUrl.username || nodeUrl.password || nodeUrl.search || nodeUrl.hash) {
    throw new Error("invalid kernel URL");
  }
  const filePath = expandPath(options.config.filePath ?? "~/.openclaw/workspace/horizon/horizon.json");
  const stateDir = expandPath(options.config.stateDir ?? join(dirname(expandPath(options.keypairPath)), "horizon-sync"));
  const scope = digest([options.nodeUrl.replace(/\/$/, ""), loopId, options.did, principal]);
  const cursorPath = join(stateDir, `${scope}.json`);
  const deadLetterPath = `${cursorPath}.dead-letter.json`;
  if (filePath === cursorPath) throw new Error("horizon must not be its own cursor");
  const transport = createLoopTransport({ ...options, keypairPath: expandPath(options.keypairPath) });
  const log = options.logger ?? { info: console.log, warn: console.warn };
  const now = options.now ?? Date.now;
  const interval = options.config.syncIntervalMs ?? 30_000;
  if (!Number.isInteger(interval) || interval < 1000 || interval > 2_147_483_647) throw new Error("invalid sync interval");
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let rerun = false;
  let stopped = false;
  let lastWarning = -Infinity;
  let lastIncompleteWarning = -Infinity;

  function warn(): void {
    if (now() - lastWarning < 60_000) return;
    lastWarning = now();
    log.warn("[imajin-horizon] sync failed; no cursor reset; pending facts retained (check file, config, identity and kernel contract)");
  }
  async function drain(cursor: Cursor): Promise<Cursor> {
    if (!cursor.pending || stopped) return cursor;
    const pending = cursor.pending;
    const request = pending.requests[0];
    if (request) {
      if (request.publisherDid !== options.did || request.payload.loopId !== loopId || request.payload.principal !== principal) {
        throw new Error("outbox identity mismatch");
      }
      const response = await transport.post(request);
      const result = await deliveryResult(response);
      if (result === "retry") throw new Error("kernel delivery is transient");
      if (result === "dead-letter") {
        await saveDeadLetter(deadLetterPath, request, response.status, now());
        log.warn(rejectedStepWarning(request, response.status));
      }
      cursor = { ...cursor, pending: { ...pending, requests: pending.requests.slice(1) } };
      await saveCursor(cursorPath, cursor);
      // Each acknowledgement depends on the preceding POST and durable write.
      return drain(cursor);
    }
    const complete: Cursor = { version: 1, scope, lastAt: pending.at, steps: pending.steps };
    await saveCursor(cursorPath, complete);
    return complete;
  }
  async function tick(): Promise<void> {
    // Parse AND map every item before publishing anything, even an earlier outbox.
    const file = parseHorizon(await readFile(filePath, "utf8"));
    const items = file.items.map((item, rank) => mapItem(item, rank, { loopId, did: options.did, repository }));
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await withLock(cursorPath, async () => {
      let cursor = await loadCursor(cursorPath, scope);
      // Validate immutable changes against the pending target before retrying it.
      planDiff(items, { ...cursor, steps: cursor.pending?.steps ?? cursor.steps });
      cursor = await drain(cursor);
      if (stopped) return;
      const plan = planDiff(items, cursor);
      const missingOutcome = items.some(item => item.facts.closed && !plan.steps[item.stepId]?.update.issue);
      if (missingOutcome && now() - lastIncompleteWarning >= 60_000) {
        lastIncompleteWarning = now();
        log.warn("[imajin-horizon] closure has no issue OUTCOME; kernel past projection needs explicit outcome or gap(kernel) #2931 resolved");
      }
      if (!plan.events.length) return;
      const at = Math.max(now(), cursor.lastAt + 1);
      const requests: StepRequest[] = await Promise.all(plan.events.map(async fact => {
        const payload: StepEnvelope = {
          loopId, kind: "openclaw.horizon", principal, parentLoopId: null,
          refs: fact.item.refs, stepId: fact.item.stepId,
          state: fact.type === "step.queued" ? "queued" : "observed",
          summary: "harness horizon observation", at: new Date(at).toISOString(),
          ...fact.data,
        };
        if (Buffer.byteLength(JSON.stringify(payload)) > 16_000) throw new Error("step metadata too large");
        return transport.sign(fact.type, payload);
      }));
      cursor = { ...cursor, pending: { requests, steps: plan.steps, at } };
      await saveCursor(cursorPath, cursor); // write ahead of the very first network call
      await drain(cursor);
    });
  }
  /** Public one-way seam for a future wake horizon-read hook; never applies claims. */
  function sync(): Promise<void> {
    if (stopped) return Promise.resolve();
    rerun = true;
    running ??= runQueued().finally(() => { running = undefined; });
    return running;
  }
  async function runQueued(): Promise<void> {
    rerun = false;
    await tick().catch(warn);
    if (rerun && !stopped) return runQueued();
  }
  return {
    sync,
    cursorPath,
    deadLetterPath,
    start(): void {
      if (timer) return;
      stopped = false;
      void sync();
      // Parent watch survives the bridge's write-temp/rename replacement pattern.
      try {
        watcher = watch(dirname(filePath), (_event, name) => {
          if (!name || String(name) === basename(filePath)) void sync();
        });
        watcher.on("error", () => { watcher?.close(); watcher = undefined; warn(); });
      } catch {
        warn(); // missing directory is recoverable through the periodic tick
      }
      timer = setInterval(() => { void sync(); }, interval);
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      watcher?.close();
      watcher = undefined;
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}

export function registerHorizonSync(
  api: { registerService(service: { id: string; start(): void; stop(): Promise<void> }): void },
  options: Omit<HorizonSyncOptions, "did" | "keypairPath" | "config"> & {
    did?: string; keypairPath?: string; config?: HorizonConfig;
  },
) {
  if (options.config?.enabled !== true) return undefined;
  try {
    const sync = createHorizonSync({ ...options, did: text(options.did), keypairPath: text(options.keypairPath), config: options.config });
    api.registerService({ id: "imajin-horizon-sync", start: sync.start, stop: sync.stop });
    return sync;
  } catch {
    (options.logger?.warn ?? console.warn)("[imajin-horizon] disabled: invalid or missing horizon configuration");
    return undefined;
  }
}
