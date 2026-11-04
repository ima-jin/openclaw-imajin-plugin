import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WakeBridgeStore } from "../wake-bridge.js";
import { deriveStepId, mapItem, type HorizonItem, type StepRequest } from "./model.js";
import { createHorizonSync } from "./sync.js";
import type { LoopSenderOptions } from "../loop-publisher.js";
import { readBackHorizon } from "./readback.js";

const DID = "did:imajin:jin";
const PRINCIPAL = "did:imajin:ryan";
const LOOP = "loop:horizon";
const NOW = Date.parse("2026-11-04T12:05:00Z");
const context = { loopId: LOOP, did: DID, repository: "ima-jin/imajin-ai" };
async function fixture(name: string) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "horizon-readback-"));
  const filePath = join(directory, "horizon.json");
  const item: HorizonItem = {
    id: "task-2866", zone: "near", title: "Ship the horizon", refs: ["#2866"],
    addedAt: "2026-10-17T12:00:00Z",
  };
  await writeFile(filePath, JSON.stringify({ depthTarget: 12, note: "keep root fields", items: [{ ...item, note: "keep item fields" }] }));
  const requests: StepRequest[] = [];
  let snapshot = await fixture("claimed");
  const get = vi.fn(async (): Promise<Response> => Response.json(snapshot));
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "GET") return get();
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({}, { status: 201 });
  });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const options: LoopSenderOptions = {
    nodeUrl: "https://kernel.test", did: DID, principal: PRINCIPAL,
    fetchImpl: fetchImpl as typeof fetch, now: () => NOW, logger,
    signer: { did: DID, publicKey: "fixture-public-key", signChallenge: async () => "fixture-signature" },
  };
  const service = createHorizonSync({
    ...options, config: { ...context, filePath, stateDir: join(directory, "state") },
  });
  return {
    filePath, item, options, service, requests, get, fetchImpl, logger,
    snapshot: () => snapshot,
    set: (value: any) => { snapshot = value; },
    read: async () => JSON.parse(await readFile(filePath, "utf8")),
  };
}

describe("kernel horizon readback", () => {
  it.each([DID, "did:imajin:business"])("reads as the effective principal %s with the existing session", async principal => {
    const test = await setup();
    test.snapshot().loop.principal = principal;
    const authenticatedCookie = vi.fn(async () => `imajin_session=${randomBytes(16).toString("hex")}`);
    await readBackHorizon({ ...test.options, principal, client: { authenticatedCookie } }, LOOP, test.filePath);
    expect(authenticatedCookie).toHaveBeenCalledOnce();
    expect(test.fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = test.fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://kernel.test/api/loops/loop%3Ahorizon?includeExited=true");
    expect(init).toMatchObject({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) });
    expect(init?.body).toBeUndefined();
    const headers = init?.headers as Record<string, string>;
    expect(headers.Cookie).toMatch(/^imajin_session=/);
    expect(headers["X-Acting-For"]).toBe(principal === DID ? undefined : principal);
    expect((await test.read()).items[0].claimedBy).toBe("did:imajin:claimant");
  });

  it("copies a live claim, preserves unknown fields, and repeats without any write or publish", async () => {
    const test = await setup();
    await test.service.sync();
    const result = await test.read();
    expect(result).toMatchObject({
      depthTarget: 12, note: "keep root fields",
      items: [{ ...test.item, note: "keep item fields", claimedBy: "did:imajin:claimant",
        claimExpiresAt: "2026-11-04T12:15:00Z", kernelState: "claimed", kernelZone: "head" }],
    });
    const before = await stat(test.filePath);
    const cursor = await stat(test.service.cursorPath);
    const published = structuredClone(test.requests);
    await test.service.sync();
    expect((await stat(test.filePath)).mtimeMs).toBe(before.mtimeMs);
    expect((await stat(test.service.cursorPath)).mtimeMs).toBe(cursor.mtimeMs);
    expect(test.requests).toEqual(published);
    expect(test.requests.map(entry => entry.type)).toEqual(["step.queued"]);
    expect(test.logger.warn).not.toHaveBeenCalled();
  });

  it.each(["expired", "released", "elapsed TTL"])("clears %s claims without interpreting local head/depth as authority", async kind => {
    const test = await setup();
    await test.service.sync();
    if (kind === "elapsed TTL") {
      test.snapshot().horizon.steps[0].claim.acquiredAt = "2026-11-04T11:00:00Z";
      test.snapshot().horizon.steps[0].claim.expiresAt = new Date(NOW).toISOString();
    } else test.set(await fixture("expired"));
    await test.service.sync();
    expect((await test.read()).items[0]).toMatchObject({ zone: "near" });
    expect((await test.read()).items[0]).not.toHaveProperty("claimedBy");
    expect((await test.read()).items[0]).not.toHaveProperty("claimExpiresAt");
    expect(test.requests.map(entry => entry.type)).toEqual(["step.queued"]);
    const mapped = mapItem({ ...test.item, zone: "head", claimedBy: DID }, 0, context);
    expect(mapped.facts).toEqual({});
    expect(mapped).not.toHaveProperty("zone");
    expect(JSON.stringify(test.requests)).not.toMatch(/claimedBy|claimExpiresAt|kernelState|kernelZone|depthTarget|"zone"|step.claimed/);
  });

  it.each(["exited", "past", "done"])("records kernel %s as done, with no completion echo on repeat or restart", async kind => {
    const test = await setup();
    await test.service.sync();
    const snapshot = await fixture("exited");
    if (kind === "past") Object.assign(snapshot.horizon.steps[0], { state: "finished", zone: "past" });
    if (kind === "done") snapshot.horizon.steps[0].state = "finished";
    test.set(snapshot);
    await test.service.sync();
    expect((await test.read()).items[0]).toMatchObject({ zone: "done", kernelZone: snapshot.horizon.steps[0].zone });
    expect((await test.read()).items[0]).not.toHaveProperty("claimedBy");
    const raw = await readFile(test.filePath, "utf8");
    const before = await stat(test.filePath);
    const published = structuredClone(test.requests);
    await test.service.sync();
    const restart = createHorizonSync({
      ...test.options, config: { ...context, filePath: test.filePath, stateDir: join(test.filePath, "..", "state") },
    });
    await restart.sync();
    expect(await readFile(test.filePath, "utf8")).toBe(raw);
    expect((await stat(test.filePath)).mtimeMs).toBe(before.mtimeMs);
    expect(test.requests).toEqual(published);
    expect(test.requests.map(entry => entry.type)).toEqual(["step.queued"]);
  });

  it("the wake read seam returns claim and exit fields without publishing or losing them in continuity", async () => {
    const test = await setup();
    await test.service.sync();
    const before = test.fetchImpl.mock.calls.length;
    const claimed = await test.service.readOpenItems();
    expect(claimed[0]).toMatchObject({ runId: test.item.id, claimedBy: "did:imajin:claimant",
      claimExpiresAt: "2026-11-04T12:15:00Z", kernelState: "claimed", kernelZone: "head", status: "open" });
    expect(test.fetchImpl).toHaveBeenCalledTimes(before);
    const continuity = new WakeBridgeStore();
    await continuity.merge(claimed);
    expect(continuity.buildPrompt()).toContain('"claimedBy":"did:imajin:claimant"');
    test.set(await fixture("expired"));
    await test.service.sync();
    await continuity.merge(await test.service.readOpenItems());
    expect(continuity.buildPrompt()).not.toContain("claimedBy");
    test.set(await fixture("exited"));
    await test.service.sync();
    const exited = await test.service.readOpenItems();
    expect(exited[0]).toMatchObject({ status: "closed", kernelState: "exited", kernelZone: "done" });
    await continuity.merge(exited);
    expect(continuity.buildPrompt()).toBe("");
  });

  it("does not touch unmatched local items, foreign publishers, or absent steps", async () => {
    const test = await setup();
    test.snapshot().horizon.steps[0].publisher = "did:imajin:other";
    const before = await readFile(test.filePath, "utf8");
    await readBackHorizon(test.options, LOOP, test.filePath);
    expect(await readFile(test.filePath, "utf8")).toBe(before);
    test.snapshot().horizon.steps[0].publisher = DID;
    test.snapshot().horizon.steps[0].stepId = deriveStepId(LOOP, DID, "unmatched");
    test.snapshot().horizon.steps[0].claim.leaseId = `step:${test.snapshot().horizon.steps[0].stepId}`;
    await readBackHorizon(test.options, LOOP, test.filePath);
    expect(await readFile(test.filePath, "utf8")).toBe(before);
    test.snapshot().horizon.steps = [];
    await readBackHorizon(test.options, LOOP, test.filePath);
    expect(await readFile(test.filePath, "utf8")).toBe(before);
  });

  it.each([
    ["wrong principal", (s: any) => { s.loop.principal = DID; }],
    ["wrong loop", (s: any) => { s.loop.loopId = "foreign"; }],
    ["missing horizon", (s: any) => { delete s.horizon; }],
    ["invalid steps", (s: any) => { s.horizon.steps = {}; }],
    ["duplicate ids", (s: any) => { s.horizon.steps.push(s.horizon.steps[0]); }],
    ["invalid publisher", (s: any) => { s.horizon.steps[0].publisher = "not-a-did"; }],
    ["invalid state", (s: any) => { s.horizon.steps[0].state = "unknown"; }],
    ["invalid zone", (s: any) => { s.horizon.steps[0].zone = "unknown"; }],
    ["invalid holder", (s: any) => { s.horizon.steps[0].claim.holderDid = "not-a-did"; }],
    ["wrong lease", (s: any) => { s.horizon.steps[0].claim.leaseId = "step:other"; }],
    ["invalid acquired date", (s: any) => { s.horizon.steps[0].claim.acquiredAt = "invalid"; }],
    ["invalid expiry", (s: any) => { s.horizon.steps[0].claim.expiresAt = "invalid"; }],
    ["reversed window", (s: any) => { s.horizon.steps[0].claim.expiresAt = "2026-11-04T11:00:00Z"; }],
  ] as const)("rejects %s atomically, including an otherwise valid claim", async (_name, change) => {
    const test = await setup();
    change(test.snapshot());
    const before = await readFile(test.filePath, "utf8");
    await readBackHorizon(test.options, LOOP, test.filePath);
    expect(await readFile(test.filePath, "utf8")).toBe(before);
  });

  it.each(["{broken", "[]", "null", "", "x".repeat(4 * 1024 * 1024 + 1)])("rejects malformed/oversized response %# without writes", async raw => {
    const test = await setup();
    test.get.mockImplementation(async () => new Response(raw));
    const before = await readFile(test.filePath, "utf8");
    await readBackHorizon(test.options, LOOP, test.filePath);
    expect(await readFile(test.filePath, "utf8")).toBe(before);
  });

  it("preserves concurrent bridge edits made while the GET is pending", async () => {
    const test = await setup();
    test.get.mockImplementationOnce(async () => {
      const file = await test.read();
      file.items[0].title = "Edited during read";
      file.items.push({ ...test.item, id: "new-item" });
      await writeFile(test.filePath, JSON.stringify(file));
      return Response.json(test.snapshot());
    });
    await readBackHorizon(test.options, LOOP, test.filePath);
    expect((await test.read()).items).toMatchObject([
      { title: "Edited during read", claimedBy: "did:imajin:claimant" }, { id: "new-item" },
    ]);
  });
});

describe("read failures", () => {
  it("warns once per process across instances and failures, leaves the bridge untouched, and still publishes upward", async () => {
    // Isolate only the module-level once-per-process warning, not production state.
    vi.resetModules();
    const { createHorizonSync: create } = await import("./sync.js");
    const failures = await fixture("read-failure");
    let warnings = 0;
    for (const failure of failures) {
      const test = await setup();
      test.get.mockImplementation(async () => {
        if (failure.throws) throw new TypeError("private network diagnostic");
        return new Response("private server diagnostic", { status: failure.status });
      });
      const service = create({ ...test.options,
        config: { ...context, filePath: test.filePath, stateDir: join(test.filePath, "..", "state") } });
      const before = await readFile(test.filePath, "utf8");
      await service.sync();
      await service.sync();
      expect(await readFile(test.filePath, "utf8")).toBe(before);
      expect(test.requests.map(entry => entry.type)).toEqual(["step.queued"]);
      expect(test.get).toHaveBeenCalledTimes(2);
      warnings += test.logger.warn.mock.calls.filter(([message]) => message.includes("kernel read unavailable")).length;
      expect(JSON.stringify(test.logger.warn.mock.calls)).not.toContain("private");
      await service.stop();
    }
    expect(warnings).toBe(1);
  });
});
