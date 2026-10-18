import { watch, type FSWatcher } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createLoopTransport, type LoopSenderOptions } from "../loop-publisher.js";
import { loadCursor, planDiff, saveCursor, type Cursor } from "./cursor.js";
import { digest, mapItem, parseHorizon, text, type StepEnvelope, type StepRequest } from "./model.js";

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
async function withLock(path: string, work: () => Promise<void>): Promise<void> {
  const lockPath = `${path}.lock`;
  try {
    const lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(String(process.pid));
    await lock.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(await readFile(lockPath, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid lock");
    try {
      process.kill(pid, 0);
    } catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") throw probeError;
      // A dead writer cannot hold the cursor. Serialize contenders with wx again.
      await unlink(lockPath);
      return withLock(path, work);
    }
    throw new Error("cursor already in use");
  }
  try {
    await work();
  } finally {
    await unlink(lockPath);
  }
}
export function createHorizonSync(options: HorizonSyncOptions) {
  const loopId = text(options.config.loopId);
  const repository = text(options.config.repository);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("invalid repository");
  if (!/^did:[^\s:]+:\S+$/.test(options.did)) throw new Error("invalid publisher DID");
  const principal = options.principal ?? options.did;
  if (!/^did:[^\s:]+:\S+$/.test(principal)) throw new Error("invalid principal DID");
  const filePath = expandPath(options.config.filePath ?? "~/.openclaw/workspace/horizon/horizon.json");
  const stateDir = expandPath(options.config.stateDir ?? join(dirname(expandPath(options.keypairPath)), "horizon-sync"));
  const scope = digest([options.nodeUrl.replace(/\/$/, ""), loopId, options.did, principal, repository, filePath]);
  const cursorPath = join(stateDir, `${scope}.json`);
  if (filePath === cursorPath) throw new Error("horizon must not be its own cursor");
  const transport = createLoopTransport({ ...options, keypairPath: expandPath(options.keypairPath) });
  const log = options.logger ?? { info: console.log, warn: console.warn };
  const now = options.now ?? Date.now;
  const interval = options.config.syncIntervalMs ?? 30_000;
  if (!Number.isFinite(interval) || interval < 1000 || interval > 2_147_483_647) throw new Error("invalid sync interval");
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  let lastWarning = -Infinity;

  function warn(): void {
    if (now() - lastWarning < 60_000) return;
    lastWarning = now();
    log.warn("[imajin-horizon] sync failed; no cursor reset; pending facts retained (check file, config, identity and kernel contract)");
  }
  async function drain(cursor: Cursor): Promise<Cursor> {
    if (!cursor.pending) return cursor;
    let pending = cursor.pending;
    while (pending.requests.length) {
      const request = pending.requests[0]!;
      if (request.publisherDid !== options.did || request.payload.loopId !== loopId || request.payload.principal !== principal) {
        throw new Error("outbox identity mismatch");
      }
      const response = await transport.post(request);
      // Never log server bodies or free-text input; either could contain secrets.
      await response.body?.cancel();
      if (!response.ok) throw new Error("kernel rejected event");
      pending = { ...pending, requests: pending.requests.slice(1) };
      cursor = { ...cursor, pending };
      await saveCursor(cursorPath, cursor);
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
      const plan = planDiff(items, cursor);
      if (!plan.events.length) return;
      const at = Math.max(now(), cursor.lastAt + 1);
      const requests: StepRequest[] = [];
      for (const fact of plan.events) {
        const payload: StepEnvelope = {
          loopId, kind: "openclaw.horizon", principal, parentLoopId: null,
          refs: fact.item.refs, stepId: fact.item.stepId,
          state: fact.type === "step.queued" ? "queued" : "observed",
          summary: "harness horizon observation", at: new Date(at).toISOString(),
          ...fact.data,
        };
        requests.push(await transport.sign(fact.type, payload));
      }
      cursor = { ...cursor, pending: { requests, steps: plan.steps, at } };
      await saveCursor(cursorPath, cursor); // write ahead of the very first network call
      await drain(cursor);
    });
  }
  /** Public one-way seam for a future wake horizon-read hook; never applies claims. */
  function sync(): Promise<void> {
    if (stopped) return Promise.resolve();
    running ??= tick().catch(warn).finally(() => { running = undefined; });
    return running;
  }
  return {
    sync,
    cursorPath,
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
