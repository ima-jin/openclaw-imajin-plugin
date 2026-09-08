import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NotificationDedupStore,
  PendingWakeStore,
  pendingWakeKey,
  resolveStateDir,
  DEFAULT_DEDUP_CAPACITY,
  type PendingWakeRecord,
} from "./notification-state-store.js";
import type { NotificationFrame } from "./ws-service.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "imajin-ws-state-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("resolveStateDir", () => {
  it("prefers an explicitly configured stateDir", () => {
    expect(resolveStateDir("/configured/dir", "/home/agent/.jin-identity.json")).toBe("/configured/dir");
  });

  it("trims a configured stateDir", () => {
    expect(resolveStateDir("  /configured/dir  ", undefined)).toBe("/configured/dir");
  });

  it("falls back to a directory colocated with keypairPath", () => {
    expect(resolveStateDir(undefined, "/home/agent/.jin-identity.json")).toBe(
      "/home/agent/imajin-ws-state",
    );
  });

  it("returns undefined when neither is available", () => {
    expect(resolveStateDir(undefined, undefined)).toBeUndefined();
  });
});

describe("NotificationDedupStore", () => {
  it("has() is false before anything is added", async () => {
    const store = new NotificationDedupStore(join(tmpDir, "dedup.json"));
    await store.load();
    expect(store.has("ntf-1")).toBe(false);
  });

  it("add() then has() recognizes the id, and is idempotent", async () => {
    const store = new NotificationDedupStore(join(tmpDir, "dedup.json"));
    await store.load();
    await store.add("ntf-1");
    expect(store.has("ntf-1")).toBe(true);
    await store.add("ntf-1"); // no-op, must not throw or duplicate
    expect(store.has("ntf-1")).toBe(true);
  });

  it("persists ids to disk and a fresh instance reloads them", async () => {
    const filePath = join(tmpDir, "dedup.json");
    const first = new NotificationDedupStore(filePath);
    await first.load();
    await first.add("ntf-1");
    await first.add("ntf-2");

    const raw = await readFile(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual({ ids: ["ntf-1", "ntf-2"] });

    const second = new NotificationDedupStore(filePath);
    await second.load();
    expect(second.has("ntf-1")).toBe(true);
    expect(second.has("ntf-2")).toBe(true);
    expect(second.has("ntf-3")).toBe(false);
  });

  it("evicts the oldest id once capacity is exceeded", async () => {
    const store = new NotificationDedupStore(join(tmpDir, "dedup.json"), 3);
    await store.load();
    await store.add("a");
    await store.add("b");
    await store.add("c");
    await store.add("d"); // evicts "a"

    expect(store.has("a")).toBe(false);
    expect(store.has("b")).toBe(true);
    expect(store.has("c")).toBe(true);
    expect(store.has("d")).toBe(true);
  });

  it("defaults to a 500-entry capacity", () => {
    expect(DEFAULT_DEDUP_CAPACITY).toBe(500);
  });

  it("treats a missing file as empty state without throwing", async () => {
    const store = new NotificationDedupStore(join(tmpDir, "does-not-exist.json"));
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.has("anything")).toBe(false);
  });

  it("treats a corrupt file as empty state without throwing", async () => {
    const filePath = join(tmpDir, "dedup.json");
    await writeFile(filePath, "{not-json", "utf-8");
    const store = new NotificationDedupStore(filePath);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.has("anything")).toBe(false);
  });

  it("is a pure in-memory no-op when no filePath is provided", async () => {
    const store = new NotificationDedupStore(undefined);
    await store.load();
    await store.add("ntf-1");
    expect(store.has("ntf-1")).toBe(true);
  });
});

function frame(id: string): NotificationFrame {
  return {
    type: "notification",
    id,
    scope: "warp.run.completed",
    title: `run ${id}`,
    body: "",
    createdAt: "",
    data: {},
  };
}

describe("PendingWakeStore", () => {
  it("all() is empty before anything is set", async () => {
    const store = new PendingWakeStore(join(tmpDir, "pending.json"));
    await store.load();
    expect(store.all()).toEqual([]);
  });

  it("set() then all() returns the record, and persists it to disk", async () => {
    const filePath = join(tmpDir, "pending.json");
    const store = new PendingWakeStore(filePath);
    await store.load();
    const record: PendingWakeRecord = { scope: "warp.run.completed", sinceTs: 1000, frames: [frame("1")] };
    await store.set(pendingWakeKey("warp.run.completed", 1000), record);

    expect(store.all()).toEqual([[pendingWakeKey("warp.run.completed", 1000), record]]);
    const raw = JSON.parse(await readFile(filePath, "utf-8"));
    expect(raw.wakes[pendingWakeKey("warp.run.completed", 1000)]).toEqual(record);
  });

  it("delete() clears one key and leaves the rest, persisting the change", async () => {
    const filePath = join(tmpDir, "pending.json");
    const store = new PendingWakeStore(filePath);
    await store.load();
    await store.set("scope-a:1", { scope: "scope-a", sinceTs: 1, frames: [frame("1")] });
    await store.set("scope-b:2", { scope: "scope-b", sinceTs: 2, frames: [frame("2")] });

    await store.delete("scope-a:1");

    expect(store.all()).toEqual([["scope-b:2", { scope: "scope-b", sinceTs: 2, frames: [frame("2")] }]]);

    const second = new PendingWakeStore(filePath);
    await second.load();
    expect(second.all().map(([key]) => key)).toEqual(["scope-b:2"]);
  });

  it("delete() on a missing key is a no-op", async () => {
    const store = new PendingWakeStore(join(tmpDir, "pending.json"));
    await store.load();
    await expect(store.delete("missing")).resolves.toBeUndefined();
    expect(store.all()).toEqual([]);
  });

  it("a fresh instance reloads persisted wakes across a simulated restart", async () => {
    const filePath = join(tmpDir, "pending.json");
    const first = new PendingWakeStore(filePath);
    await first.load();
    await first.set("warp.run.completed:5000", {
      scope: "warp.run.completed",
      sinceTs: 5000,
      frames: [frame("1"), frame("2")],
    });

    const second = new PendingWakeStore(filePath);
    await second.load();
    const [[key, record]] = second.all();
    expect(key).toBe("warp.run.completed:5000");
    expect(record.frames).toHaveLength(2);
  });

  it("treats a missing or corrupt file as empty state without throwing", async () => {
    const missing = new PendingWakeStore(join(tmpDir, "does-not-exist.json"));
    await expect(missing.load()).resolves.toBeUndefined();
    expect(missing.all()).toEqual([]);

    const corruptPath = join(tmpDir, "corrupt.json");
    await writeFile(corruptPath, "not json at all", "utf-8");
    const corrupt = new PendingWakeStore(corruptPath);
    await expect(corrupt.load()).resolves.toBeUndefined();
    expect(corrupt.all()).toEqual([]);
  });

  it("creates the state directory recursively on first write", async () => {
    const nestedDir = join(tmpDir, "a", "b", "c");
    const filePath = join(nestedDir, "pending.json");
    const store = new PendingWakeStore(filePath);
    await store.load();
    await store.set("scope:1", { scope: "scope", sinceTs: 1, frames: [] });

    const stat = await mkdir(nestedDir, { recursive: true }); // must not throw — dir already exists
    expect(stat).toBeUndefined();
    const raw = await readFile(filePath, "utf-8");
    expect(JSON.parse(raw).wakes["scope:1"]).toBeDefined();
  });

  it("is a pure in-memory no-op when no filePath is provided", async () => {
    const store = new PendingWakeStore(undefined);
    await store.load();
    await store.set("scope:1", { scope: "scope", sinceTs: 1, frames: [] });
    expect(store.all()).toHaveLength(1);
    await store.delete("scope:1");
    expect(store.all()).toHaveLength(0);
  });
});

describe("pendingWakeKey", () => {
  it("formats as scope:windowStart", () => {
    expect(pendingWakeKey("warp.run.completed", 12345)).toBe("warp.run.completed:12345");
  });
});
