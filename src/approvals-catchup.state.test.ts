import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ApprovalsStateStore } from "./approvals-state.js";

const scope = { nodeUrl: "https://kernel.invalid", agentDid: "did:imajin:test", operatorDid: "did:imajin:human" };
const proposal = {
  sourceId: "system-agent", kind: "system-agent:restart", summary: "Restart",
  sourceRevision: "a".repeat(64), contentHash: `sha256:${"b".repeat(64)}`,
  detail: { expiresAt: "2030-01-01T00:00:00.000Z" }, expiresAtMs: Date.parse("2030-01-01"),
};

describe("durable approvals state", () => {
  it("serializes concurrent atomic writes and scopes warnings/proposals/outcomes to node, agent and operator", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "approvals-state-"));
    const file = path.join(dir, "state.json");
    const store = new ApprovalsStateStore(file, scope);
    store.proposals.set("restart", proposal);
    const first = store.persist();
    store.warnings.add("degraded:restart");
    store.outcomes.set("old", "expired/superseded");
    const second = store.persist();
    await Promise.all([first, second]);
    const restored = new ApprovalsStateStore(file, scope);
    await restored.load();
    expect(restored.proposals.get("restart")).toEqual(proposal);
    expect(restored.warnings.has("degraded:restart")).toBe(true);
    expect(restored.outcomes.get("old")).toBe("expired/superseded");
    for (const key of Object.keys(scope) as (keyof typeof scope)[]) {
      const foreign = new ApprovalsStateStore(file, { ...scope, [key]: "foreign" });
      await foreign.load();
      expect(foreign.proposals.size).toBe(0);
      expect(foreign.warnings.size).toBe(0);
    }
    expect(JSON.parse(await readFile(file, "utf-8")).version).toBe(1);
  });

  it("ignores malformed records and corrupt files without enabling a resolve path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "approvals-corrupt-"));
    const file = path.join(dir, "state.json");
    await writeFile(file, JSON.stringify({
      version: 1, ...scope,
      proposals: { valid: proposal, invalid: { ...proposal, contentHash: "not-a-digest" }, null: null },
      warnings: ["degraded:valid", 33], outcomes: { old: "applied", malicious: "pending" },
    }));
    const store = new ApprovalsStateStore(file, scope);
    await store.load();
    expect([...store.proposals.keys()]).toEqual(["valid"]);
    expect([...store.warnings]).toEqual(["degraded:valid"]);
    expect([...store.outcomes]).toEqual([["old", "applied"]]);
    await writeFile(file, "{broken");
    const corrupt = new ApprovalsStateStore(file, scope);
    await expect(corrupt.load()).resolves.toBeUndefined();
    expect(corrupt.proposals.size).toBe(0);
    await expect(new ApprovalsStateStore(undefined, scope).persist()).resolves.toBeUndefined();
  });

  it("logs persistence errors and keeps in-memory safety state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "approvals-error-"));
    const logger = { error: vi.fn() };
    const store = new ApprovalsStateStore(dir, scope, logger);
    store.warnings.add("stale:restart");
    await expect(store.persist()).resolves.toBeUndefined();
    expect(store.warnings.has("stale:restart")).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to persist bridge state"));
  });
});
