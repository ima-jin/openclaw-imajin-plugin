import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { ApprovalsStateStore } from "./approvals-state.js";

const scope = { nodeUrl: "https://kernel.example", agentDid: "did:imajin:agent", operatorDid: "did:imajin:operator" };
const revision = createHash("sha256").update("catalog delta").digest("hex");

describe("catalog proposal persistence (#105)", () => {
  it("restores pending identity and dismissal without losing proposal/outcome history", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "catalog-state-")), "state.json");
    const store = new ApprovalsStateStore(file, scope);
    Object.assign(store.catalog, { revision, proposalId: `imajin-catalog:${randomUUID()}`, dismissed: true });
    store.outcomes.set("old-card", "applied");
    await store.persist();
    const restored = new ApprovalsStateStore(file, scope);
    await restored.load();
    expect(restored.catalog).toEqual(store.catalog);
    expect(restored.outcomes.get("old-card")).toBe("applied");
    expect(JSON.parse(await readFile(file, "utf8")).catalog).toEqual(store.catalog);
  });

  it.each([
    { revision: "bad", proposalId: `imajin-catalog:${randomUUID()}`, dismissed: false },
    { revision, proposalId: "another-source:1", dismissed: false },
    { revision, proposalId: `imajin-catalog:${randomUUID()}`, dismissed: "yes" },
  ])("ignores invalid catalog state %j", async (catalog) => {
    const file = join(await mkdtemp(join(tmpdir(), "catalog-state-")), "state.json");
    await writeFile(file, JSON.stringify({ version: 1, ...scope, catalog }));
    const store = new ApprovalsStateStore(file, scope);
    await store.load();
    expect(store.catalog).toEqual({ revision: null, proposalId: null, dismissed: false });
  });

  it("does not restore a different operator's catalog consent state", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "catalog-state-")), "state.json");
    const store = new ApprovalsStateStore(file, scope);
    Object.assign(store.catalog, { revision, proposalId: `imajin-catalog:${randomUUID()}`, dismissed: true });
    await store.persist();
    const other = new ApprovalsStateStore(file, { ...scope, operatorDid: "did:imajin:other" });
    await other.load();
    expect(other.catalog.proposalId).toBeNull();
    expect(other.catalog.dismissed).toBe(false);
  });
});
