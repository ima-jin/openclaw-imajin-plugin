/**
 * Persisted state for the WS-notification → agent injector (#26): a small,
 * best-effort on-disk store for two related durability guarantees the
 * in-memory injector alone cannot provide across a gateway restart:
 *
 * 1. **Ack dedup** (`NotificationDedupStore`) — the kernel now re-offers an
 *    un-acked notification on reconnect, up to 3 times
 *    (`ima-jin/imajin-ai#2099`). A small LRU of the last
 *    `DEFAULT_DEDUP_CAPACITY` durably-injected notification ids lets
 *    `inject()` recognize a replay and re-ack it without running the
 *    durable-enqueue / direct-send / wake-coalesce path a second time.
 * 2. **Pending wake markers** (`PendingWakeStore`) — the in-memory
 *    `coalesceByScope` buffer in `notification-injector.ts` is wiped by a
 *    process restart inside the coalesce window (#2098 Candidate B). Every
 *    mutation of that buffer is mirrored here, keyed by `scope:windowStart`
 *    (matching the wake hook's own `Idempotency-Key`), so a restart can
 *    immediately replay any wake that was owed but never confirmed
 *    delivered — instead of silently losing it.
 *
 * Both stores are best-effort: a missing or corrupt file degrades to empty
 * state (first run / fresh install) rather than throwing, and a write
 * failure is logged, never thrown — persistence is a durability
 * improvement, not a hard dependency for the injector's in-memory behavior.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { NotificationFrame } from "./ws-service.js";

/** Last-N notification ids retained for ack-replay dedup (#26). */
export const DEFAULT_DEDUP_CAPACITY = 500;

export const DEDUP_STATE_FILENAME = "notification-ack-dedup.json";
export const PENDING_WAKES_FILENAME = "pending-wakes.json";

/** One coalesce window's worth of not-yet-confirmed-delivered wake evidence. */
export interface PendingWakeRecord {
  scope: string;
  /** `Date.now()` when the coalesce window opened — the same value used in the wake hook's `Idempotency-Key`. */
  sinceTs: number;
  frames: NotificationFrame[];
  /**
   * Whether every frame in this record already reached `enqueueSystemEvent`
   * successfully (#30) — true for every record this injector itself writes,
   * since a frame only ever joins the coalesce buffer (and therefore this
   * store) after its durable enqueue succeeded. Optional/absent on records
   * written before this field existed; treated as `true` in that case (the
   * same guarantee held then too — see `wakeOwedMaxAgeMs` in
   * `notification-injector.ts`).
   */
  injected?: boolean;
}

interface DedupFileShape {
  ids: string[];
}

interface PendingWakeFileShape {
  wakes: Record<string, PendingWakeRecord>;
}

/**
 * Resolves the on-disk directory for this injector's persisted state.
 * `configuredStateDir` (`wsNotifications.stateDir`) always wins; otherwise
 * the state dir is colocated next to the plugin's existing `keypairPath`
 * file — the only per-install file path this plugin already has (see
 * README's "Real-time notifications" section) — so an install doesn't need
 * a brand-new config value just to get durable acks. Returns `undefined`
 * (persistence disabled, in-memory-only dedup/coalesce) when neither is
 * available.
 */
export function resolveStateDir(
  configuredStateDir: string | undefined,
  keypairPath: string | undefined,
): string | undefined {
  const trimmed = configuredStateDir?.trim();
  if (trimmed) {
    return trimmed;
  }
  if (!keypairPath) {
    return undefined;
  }
  return path.join(path.dirname(keypairPath), "imajin-ws-state");
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/** Persisted LRU of the last `capacity` notification ids this injector has durably enqueued (#26). */
export class NotificationDedupStore {
  private ids: string[] = [];
  private idSet = new Set<string>();

  constructor(
    private readonly filePath: string | undefined,
    private readonly capacity: number = DEFAULT_DEDUP_CAPACITY,
  ) {}

  async load(): Promise<void> {
    if (!this.filePath) {
      return;
    }
    const parsed = await readJsonFile<DedupFileShape>(this.filePath, { ids: [] });
    const ids = Array.isArray(parsed.ids) ? parsed.ids.filter((id) => typeof id === "string") : [];
    this.ids = ids.slice(-this.capacity);
    this.idSet = new Set(this.ids);
  }

  has(id: string): boolean {
    return this.idSet.has(id);
  }

  /** Records `id` as seen and persists the updated LRU. A no-op when `id` is already recorded. */
  async add(id: string): Promise<void> {
    if (this.idSet.has(id)) {
      return;
    }
    this.ids.push(id);
    this.idSet.add(id);
    if (this.ids.length > this.capacity) {
      const evicted = this.ids.shift();
      if (evicted) {
        this.idSet.delete(evicted);
      }
    }
    if (!this.filePath) {
      return;
    }
    const shape: DedupFileShape = { ids: this.ids };
    try {
      await writeJsonFile(this.filePath, shape);
    } catch (err: unknown) {
      console.error(
        `[imajin-ws] failed to persist notification dedup store: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

/** Persisted "wake owed" markers, keyed by `scope:windowStart` (#26). */
export class PendingWakeStore {
  private wakes: Record<string, PendingWakeRecord> = {};

  constructor(private readonly filePath: string | undefined) {}

  async load(): Promise<void> {
    if (!this.filePath) {
      return;
    }
    const parsed = await readJsonFile<PendingWakeFileShape>(this.filePath, { wakes: {} });
    this.wakes = parsed.wakes && typeof parsed.wakes === "object" ? parsed.wakes : {};
  }

  /** All owed wakes — e.g. to replay immediately on injector construction. */
  all(): Array<[string, PendingWakeRecord]> {
    return Object.entries(this.wakes);
  }

  async set(key: string, record: PendingWakeRecord): Promise<void> {
    this.wakes[key] = record;
    await this.persist();
  }

  /** Clears an owed marker — call only once its wake has been durably confirmed delivered. */
  async delete(key: string): Promise<void> {
    if (!(key in this.wakes)) {
      return;
    }
    delete this.wakes[key];
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.filePath) {
      return;
    }
    const shape: PendingWakeFileShape = { wakes: this.wakes };
    try {
      await writeJsonFile(this.filePath, shape);
    } catch (err: unknown) {
      console.error(
        `[imajin-ws] failed to persist pending wake store: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

/** Builds the persisted-marker key for one coalesce window — matches the wake hook's own `Idempotency-Key` shape. */
export function pendingWakeKey(scope: string, windowStart: number): string {
  return `${scope}:${windowStart}`;
}
