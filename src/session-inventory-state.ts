import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveStateDir } from "./notification-state-store.js";

export interface SessionCheckpoint {
  point?: string;
  archived?: boolean;
}

/** Hash local identity; never store harness keys, native IDs or transcript text. */
export function sessionStateKey(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

export function sessionInventoryStatePath(stateDir: string | undefined, keypairPath: string | undefined, publisherScope: string): string | undefined {
  const directory = resolveStateDir(stateDir, keypairPath);
  return directory ? join(directory, `session-inventory-${sessionStateKey(publisherScope)}.json`) : undefined;
}

/** Same private state directory / atomic rename pattern as PendingWakeStore. */
export class SessionInventoryState {
  private readonly sessions = new Map<string, SessionCheckpoint>();
  private writes = Promise.resolve();
  private loaded?: Promise<void>;

  constructor(private readonly filePath?: string) {}

  load(): Promise<void> {
    this.loaded ??= this.read();
    return this.loaded;
  }

  private async read(): Promise<void> {
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("session checkpoint unreadable");
    }
    const parsed = JSON.parse(raw) as { version?: unknown; sessions?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error("invalid session checkpoint");
    for (const entry of parsed.sessions) {
      if (!validEntry(entry)) throw new Error("invalid session checkpoint entry");
      this.sessions.set(entry[0], entry[1]);
    }
  }

  get(identity: string): SessionCheckpoint {
    return { ...this.sessions.get(sessionStateKey(identity)) };
  }

  async set(identity: string, update: SessionCheckpoint): Promise<void> {
    const key = sessionStateKey(identity);
    // Serialize writes across metadata refresh and history checkpoint updates.
    const write = this.writes.then(async () => {
      const next = { ...this.sessions.get(key), ...update };
      if (this.filePath) {
        const sessions = new Map(this.sessions);
        sessions.set(key, next);
        await mkdir(dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ version: 1, sessions: [...sessions] }), { mode: 0o600 });
        await rename(temporary, this.filePath);
      }
      this.sessions.set(key, next);
    });
    this.writes = write.catch(() => undefined);
    await write;
  }
}

function validEntry(value: unknown): value is [string, SessionCheckpoint] {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || !/^[a-f0-9]{64}$/.test(value[0])) return false;
  const checkpoint = value[1] as SessionCheckpoint | null;
  return !!checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)
    && (checkpoint.point === undefined || (typeof checkpoint.point === "string" && /^[a-f0-9]{64}$/.test(checkpoint.point)))
    && (checkpoint.archived === undefined || typeof checkpoint.archived === "boolean");
}
