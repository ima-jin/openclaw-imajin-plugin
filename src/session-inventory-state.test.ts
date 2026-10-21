import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionInventoryState, sessionInventoryStatePath, sessionStateKey } from "./session-inventory-state.js";

describe("session inventory checkpoints", () => {
  it("uses the existing configured/default state directory, with publisher-isolated file names", () => {
    const name = `session-inventory-${sessionStateKey("publisher")}.json`;
    expect(sessionInventoryStatePath("/state", "/keys/key.json", "publisher")).toBe(`/state/${name}`);
    expect(sessionInventoryStatePath(undefined, "/keys/key.json", "publisher")).toBe(`/keys/imajin-ws-state/${name}`);
    expect(sessionInventoryStatePath(undefined, undefined, "publisher")).toBeUndefined();
    expect(sessionInventoryStatePath("/state", "/keys/key.json", "other")).not.toBe(`/state/${name}`);
  });

  it("atomically merges ordered history/archive updates and loads them in a fresh store", async () => {
    const filePath = join(await mkdtemp(join(tmpdir(), "session-state-")), "nested", "state.json");
    const store = new SessionInventoryState(filePath);
    await store.load();
    expect(store.get("native-session")).toEqual({});
    const point = sessionStateKey("event");
    await Promise.all([
      store.set("native-session", { point }),
      store.set("native-session", { archived: true }),
      store.set("another-session", { point: sessionStateKey("other") }),
    ]);
    const fresh = new SessionInventoryState(filePath);
    await fresh.load();
    expect(fresh.get("native-session")).toEqual({ point, archived: true });
    await fresh.set("native-session", { archived: false });
    expect(fresh.get("native-session")).toEqual({ point, archived: false });
    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain("native-session");
    expect(raw).not.toContain("another-session");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((JSON.parse(raw) as { version: number }).version).toBe(1);
  });

  it.each([
    "not-json", "null", "{}", '{"version":2,"sessions":[]}',
    '{"version":1,"sessions":{}}',
    JSON.stringify({ version: 1, sessions: [["not-a-hash", {}]] }),
    JSON.stringify({ version: 1, sessions: [[sessionStateKey("s"), { point: 1 }]] }),
    JSON.stringify({ version: 1, sessions: [[sessionStateKey("s"), { point: "invalid" }]] }),
    JSON.stringify({ version: 1, sessions: [[sessionStateKey("s"), { archived: "true" }]] }),
    JSON.stringify({ version: 1, sessions: [[sessionStateKey("s"), null]] }),
    JSON.stringify({ version: 1, sessions: [[sessionStateKey("s"), []]] }),
  ])("rejects corrupt/unrecognized checkpoints rather than silently replaying history (%#)", async (raw) => {
    const filePath = join(await mkdtemp(join(tmpdir(), "invalid-session-state-")), "state.json");
    await writeFile(filePath, raw);
    await expect(new SessionInventoryState(filePath).load()).rejects.toThrow();
  });

  it("surfaces read/write failures and does not advance an unpersisted checkpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "failed-session-state-"));
    await expect(new SessionInventoryState(directory).load()).rejects.toThrow("unreadable");
    const parentFile = join(directory, "not-a-directory");
    await writeFile(parentFile, "");
    const store = new SessionInventoryState(join(parentFile, "state.json"));
    await expect(store.set("s", { point: sessionStateKey("event") })).rejects.toThrow();
    expect(store.get("s")).toEqual({});
  });

  it("supports isolated in-memory tests without touching a live state directory", async () => {
    const store = new SessionInventoryState();
    await store.load();
    await store.set("s", { point: sessionStateKey("event") });
    const detached = store.get("s");
    detached.archived = true;
    expect(store.get("s").archived).toBeUndefined();
  });
});
