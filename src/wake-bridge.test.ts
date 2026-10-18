import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_WAKE_BRIDGE_FILE_BYTES,
  MAX_WAKE_BRIDGE_PROMPT_BYTES,
  MAX_WAKE_BRIDGE_RECORDS,
  WAKE_BRIDGE_FIELD_BYTES,
  WakeBridgeStore,
  type HorizonWakeAdapter,
  type WakeBridgeRecord,
} from "./wake-bridge.js";
import type { NotificationFrame } from "./ws-service.js";
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "wake-bridge-"));
  filePath = join(directory, "nested", "bridge.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

function frame(runId: string, data: Record<string, unknown> = {}): NotificationFrame {
  return {
    type: "notification",
    id: `notification-${runId}`,
    scope: "warp.run.completed",
    title: "Run completed",
    body: null,
    createdAt: "",
    data: { runId, ...data },
  };
}

function item(runId: string, fields: Partial<WakeBridgeRecord> = {}): WakeBridgeRecord {
  return { runId, status: "open", ...fields };
}

async function writeState(value: unknown): Promise<void> {
  await fs.mkdir(join(directory, "nested"), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value));
}

describe("WakeBridgeStore", () => {
  it("starts empty with missing state and supports in-memory-only operation", async () => {
    const warn = vi.fn();
    const disk = new WakeBridgeStore(filePath, warn);
    await disk.load();
    expect(disk.listOpen()).toEqual([]);
    expect(disk.buildPrompt()).toBe("");
    expect(warn).not.toHaveBeenCalled();

    const memory = new WakeBridgeStore();
    await memory.load();
    await memory.ingest([frame("run-memory")]);
    expect(memory.listOpen()).toEqual([item("run-memory")]);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enriches only allowlisted notification and artifact evidence and survives restart", async () => {
    const store = new WakeBridgeStore(filePath);
    await store.ingest([
      frame("run-a", {
        issue: { url: "https://example.test/issues/79" },
        artifacts: [
          null,
          { type: "PULL_REQUEST", url: "https://example.test/pull/80", branch: "feature" },
        ],
        unrelated: "not retained",
      }),
      frame("run-b", {
        artifacts: [{ type: "issue", url: "https://example.test/issues/81" }],
        expectedPr: "https://example.test/pull/82",
        lastVerdict: "awaiting review",
      }),
    ]);
    const restarted = new WakeBridgeStore(filePath);
    await restarted.load();
    expect(restarted.listOpen()).toEqual([
      item("run-a", {
        issue: "https://example.test/issues/79",
        expectedPr: "https://example.test/pull/80",
      }),
      item("run-b", {
        issue: "https://example.test/issues/81",
        expectedPr: "https://example.test/pull/82",
        lastVerdict: "awaiting review",
      }),
    ]);
    expect(await fs.readFile(filePath, "utf8")).not.toContain("unrelated");
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("merges incremental evidence without losing known fields or exposing mutable state", async () => {
    const store = new WakeBridgeStore(filePath);
    await store.ingest([frame("run-a", { issueUrl: "issue-79", pullRequestUrl: "pr-80" })]);
    await store.ingest([frame("run-a", { lastVerdict: "tests passed" })]);
    await store.merge([item("run-a", { expectedPr: "pr-81" })]);
    const snapshot = store.listOpen();
    snapshot[0].lastVerdict = "changed outside";
    snapshot.push(item("outside"));
    expect(store.listOpen()).toEqual([
      item("run-a", { issue: "issue-79", expectedPr: "pr-81", lastVerdict: "tests passed" }),
    ]);
  });

  it("writes bounded verdict/PR outcomes and explicit per-run status, without prose inference", async () => {
    const store = new WakeBridgeStore(filePath);
    await store.ingest([frame("run-a", { issue: "issue-79" }), frame("run-b")]);
    await store.recordOutcome({
      runIds: ["run-a", "run-b"],
      lastVerdict: "closed according to prose, but not a structured close",
      expectedPr: "pr-80",
      updates: [item("run-b", { status: "closed", lastVerdict: "accepted" })],
    });
    expect(store.listOpen()).toEqual([
      item("run-a", {
        issue: "issue-79",
        expectedPr: "pr-80",
        lastVerdict: "closed according to prose, but not a structured close",
      }),
    ]);
    await store.ingest([frame("run-b")]);
    expect(store.listOpen().map((entry) => entry.runId)).toEqual(["run-a"]);

    const restarted = new WakeBridgeStore(filePath);
    await restarted.load();
    expect(restarted.listOpen()).toEqual(store.listOpen());
    await restarted.recordOutcome({ runIds: ["run-a"], status: "closed" });
    expect(restarted.buildPrompt()).toBe("");
    await restarted.recordOutcome({ runIds: ["run-b"], status: "open" });
    expect(restarted.listOpen()).toEqual([
      item("run-b", { expectedPr: "pr-80", lastVerdict: "accepted" }),
    ]);
  });

  it("defines a small adapter contract for bounded reads and explicit outcome writeback", async () => {
    const store = new WakeBridgeStore(filePath);
    const adapter: HorizonWakeAdapter = {
      readOpenItems: vi.fn(async () => [item("run-a", { issue: "issue-79" })]),
      writeStepEvents: vi.fn(async () => {}),
    };
    await store.merge(await adapter.readOpenItems({ runIds: ["run-a"] }));
    const outcome = { runIds: ["run-a"], lastVerdict: "reviewed", expectedPr: "pr-80" };
    await store.recordOutcome(outcome);
    await adapter.writeStepEvents(outcome);
    expect(adapter.readOpenItems).toHaveBeenCalledWith({ runIds: ["run-a"] });
    expect(adapter.writeStepEvents).toHaveBeenCalledWith(outcome);
    expect(store.buildPrompt()).toContain('"lastVerdict":"reviewed"');
  });

  it("caps open records to 50 with newest evidence retained", async () => {
    const store = new WakeBridgeStore(filePath);
    for (let index = 0; index < 75; index++) {
      await store.ingest([frame(`run-${index}`)]);
    }
    expect(store.listOpen()).toHaveLength(MAX_WAKE_BRIDGE_RECORDS);
    expect(store.listOpen()[0].runId).toBe("run-25");
    expect(store.listOpen().at(-1)?.runId).toBe("run-74");
    const restarted = new WakeBridgeStore(filePath);
    await restarted.load();
    expect(restarted.listOpen()).toEqual(store.listOpen());
  });

  it("evicts closed records before open records", async () => {
    const store = new WakeBridgeStore(filePath);
    await store.merge(Array.from({ length: 50 }, (_, index) => item(`run-${index}`)));
    await store.recordOutcome({ runIds: ["run-49"], status: "closed" });
    await store.ingest([frame("run-new")]);
    expect(store.listOpen()).toHaveLength(50);
    expect(store.listOpen()[0].runId).toBe("run-0");
    const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(persisted.records.find((entry: WakeBridgeRecord) => entry.runId === "run-49"))
      .toBeUndefined();
  });

  it.each(["x", "🙂", "\u0001"])(
    "enforces field, serialized file, and prompt byte caps for %j input",
    async (character) => {
      const store = new WakeBridgeStore(filePath);
      const huge = character.repeat(10_000);
      await store.merge(Array.from({ length: 50 }, (_, index) => item(`run-${index}`, {
        issue: huge,
        expectedPr: huge,
        lastVerdict: huge,
      })));
      for (const entry of store.listOpen()) {
        for (const field of ["issue", "expectedPr", "lastVerdict"] as const) {
          expect(Buffer.byteLength(entry[field] ?? "")).toBeLessThanOrEqual(WAKE_BRIDGE_FIELD_BYTES[field]);
        }
      }
      expect(Buffer.byteLength(await fs.readFile(filePath, "utf8"))).toBeLessThanOrEqual(MAX_WAKE_BRIDGE_FILE_BYTES);
      const prompt = store.buildPrompt();
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(MAX_WAKE_BRIDGE_PROMPT_BYTES);
      expect(prompt).toContain("untrusted evidence");
      expect(prompt).toContain("[Additional continuity omitted]");
      expect(store.listOpen().at(-1)?.runId).toBe("run-49");
    },
  );

  it("bounds huge outcome text and does not stringify unrelated notification data", async () => {
    const store = new WakeBridgeStore(filePath);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await store.ingest([frame("run-a", { unrelated: circular })]);
    await store.recordOutcome({ runIds: ["run-a"], lastVerdict: "a".repeat(100_000) });
    expect(store.listOpen()[0].lastVerdict).toHaveLength(WAKE_BRIDGE_FIELD_BYTES.lastVerdict);
  });

  it.each([null, [], {}, { version: 2, records: [] }, { version: 1, records: {} }])(
    "gracefully ignores invalid state shape %j",
    async (raw) => {
      await writeState(raw);
      const store = new WakeBridgeStore(filePath);
      await expect(store.load()).resolves.toBeUndefined();
      expect(store.listOpen()).toEqual([]);
      await store.ingest([frame("recovered")]);
      expect(JSON.parse(await fs.readFile(filePath, "utf8")).records).toEqual([item("recovered")]);
    },
  );

  it("validates individual loaded records, drops extra fields, and deduplicates by run", async () => {
    await writeState({
      version: 1,
      records: [
        null,
        [],
        { runId: 1, status: "open" },
        { runId: "x".repeat(129), status: "open" },
        { runId: "line\nbreak", status: "open" },
        { runId: "bad-status", status: "pending" },
        { runId: "run-valid", status: "open", issue: 1, ignored: "discard" },
        { runId: "run-valid", status: "open", lastVerdict: "newer" },
        { runId: "__proto__", status: "closed" },
      ],
    });
    const store = new WakeBridgeStore(filePath);
    await store.load();
    expect(store.listOpen()).toEqual([item("run-valid", { lastVerdict: "newer" })]);
    expect(store.buildPrompt()).not.toContain("discard");
  });

  it("caps loaded records and rejects non-regular state without throwing", async () => {
    await writeState({
      version: 1,
      records: Array.from({ length: 70 }, (_, index) => item(`run-${index}`)),
    });
    const store = new WakeBridgeStore(filePath);
    await store.load();
    expect(store.listOpen()).toHaveLength(50);
    expect(store.listOpen()[0].runId).toBe("run-20");
    const notFile = new WakeBridgeStore(directory);
    await expect(notFile.load()).resolves.toBeUndefined();
    expect(notFile.listOpen()).toEqual([]);
  });

  it("ignores malformed incoming evidence and scans only a bounded artifact prefix", async () => {
    const store = new WakeBridgeStore(filePath);
    await store.ingest([
      frame("", { artifacts: [] }),
      frame("bad\nidentifier"),
      frame("run-a", {
        issue: 79,
        expectedPr: {},
        artifacts: Array.from({ length: 33 }, (_, index) => ({
          type: index === 32 ? "PULL_REQUEST" : "other",
          url: "outside-scanned-prefix",
        })),
      }),
    ]);
    expect(store.listOpen()).toEqual([item("run-a")]);
  });

  it("leaves the previous complete snapshot intact if atomic replacement fails", async () => {
    const store = new WakeBridgeStore(filePath);
    await store.ingest([frame("run-a")]);
    const before = await fs.readFile(filePath, "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("injected rename failure"));
    await store.ingest([frame("run-b")]);
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
    expect(store.listOpen()).toHaveLength(2);
    expect(await fs.readdir(join(directory, "nested"))).toEqual(["bridge.json"]);
    await store.recordOutcome({ runIds: ["run-b"], lastVerdict: "retry persisted" });
    expect(JSON.parse(await fs.readFile(filePath, "utf8")).records).toHaveLength(2);
  });

  it("ignores malformed/oversized files and recovers with a capped next write", async () => {
    await fs.mkdir(join(directory, "nested"));
    for (const raw of ["{broken", "x".repeat(MAX_WAKE_BRIDGE_FILE_BYTES + 1)]) {
      await fs.writeFile(filePath, raw);
      const warn = vi.fn();
      const store = new WakeBridgeStore(filePath, warn);
      await expect(store.load()).resolves.toBeUndefined();
      expect(store.listOpen()).toEqual([]);
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.flat().join(" ")).not.toContain(raw);
      await store.ingest([frame("run-recovered")]);
      expect((await fs.stat(filePath)).size).toBeLessThanOrEqual(MAX_WAKE_BRIDGE_FILE_BYTES);
    }
  });

  it("retains in-memory state and recovers after I/O failure without leaking error details", async () => {
    const warn = vi.fn();
    await fs.writeFile(join(directory, "blocked"), "");
    const store = new WakeBridgeStore(join(directory, "blocked", "bridge.json"), warn);
    await expect(store.ingest([frame("run-a")])).resolves.toBeUndefined();
    expect(store.listOpen()).toEqual([item("run-a")]);
    expect(warn.mock.calls).toEqual([
      ["[imajin-ws] wake bridge could not persist state; retaining in-memory continuity"],
    ]);
    const working = new WakeBridgeStore(filePath, () => { throw new Error("logger unavailable"); });
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("injected I/O error"));
    await expect(working.ingest([frame("run-a")])).resolves.toBeUndefined();
    expect(await fs.readdir(join(directory, "nested"))).toEqual([]);
    await working.ingest([frame("run-b")]);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await fs.readFile(filePath, "utf8")).records).toHaveLength(2);
  });

  it("serializes concurrent load/mutations and atomically replaces snapshots", async () => {
    const store = new WakeBridgeStore(filePath);
    const originalRename = fs.rename;
    const originalWrite = fs.writeFile;
    let active = 0;
    let maximumActive = 0;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      active++;
      maximumActive = Math.max(active, maximumActive);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        return await originalWrite(...args);
      } finally {
        active--;
      }
    });
    const snapshots: unknown[] = [];
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      expect(String(source)).toMatch(/\.tmp$/);
      expect(String(destination)).toBe(filePath);
      snapshots.push(JSON.parse(await fs.readFile(source, "utf8")));
      await originalRename(source, destination);
    });
    await Promise.all([
      store.load(),
      ...Array.from({ length: 20 }, (_, index) => store.ingest([frame(`run-${index}`)])),
      store.recordOutcome({ runIds: ["run-0"], lastVerdict: "final review" }),
    ]);
    expect(maximumActive).toBe(1);
    expect(snapshots).toHaveLength(21);
    expect(store.listOpen()).toHaveLength(20);
    expect(store.listOpen().at(-1)?.lastVerdict).toBe("final review");
    const restarted = new WakeBridgeStore(filePath);
    await restarted.load();
    expect(restarted.listOpen()).toEqual(store.listOpen());
    expect(await fs.readdir(join(directory, "nested"))).toEqual(["bridge.json"]);
  });

  it("serializes atomic writes across separate instances using the same normalized path", async () => {
    const first = new WakeBridgeStore(filePath);
    const second = new WakeBridgeStore(join(directory, "nested", "..", "nested", "bridge.json"));
    const originalWrite = fs.writeFile;
    let active = 0;
    let maximumActive = 0;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      active++;
      maximumActive = Math.max(active, maximumActive);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return await originalWrite(...args);
      } finally {
        active--;
      }
    });
    await Promise.all([first.ingest([frame("run-a")]), second.ingest([frame("run-b")])]);
    expect(maximumActive).toBe(1);
    expect(JSON.parse(await fs.readFile(filePath, "utf8")).records).toEqual([item("run-b")]);
  });
});
