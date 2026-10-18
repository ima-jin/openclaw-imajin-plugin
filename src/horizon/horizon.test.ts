import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../approval-bridge.js";
import { loadCursor, planDiff, saveCursor, type Cursor } from "./cursor.js";
import { deriveStepId, mapItem, parseHorizon, type HorizonItem, type StepRequest } from "./model.js";
import { createHorizonSync, registerHorizonSync, type HorizonSyncOptions } from "./sync.js";

const DID = "did:imajin:jin";
const PRINCIPAL = "did:imajin:ryan";
const context = { loopId: "loop:horizon", did: DID, repository: "ima-jin/imajin-ai" };
function item(overrides: Partial<HorizonItem> = {}): HorizonItem {
  return {
    id: "task-2866", zone: "tail", title: "Ship the horizon", refs: ["#2866"],
    addedAt: "2026-10-17T12:00:00Z", ...overrides,
  };
}
function empty(): Cursor {
  return { version: 1, scope: "scope", lastAt: 0, steps: {} };
}
const services: ReturnType<typeof createHorizonSync>[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()));
  vi.useRealTimers();
});
async function setup(overrides: Partial<HorizonSyncOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "horizon-test-"));
  const filePath = join(directory, "horizon.json");
  const keypairPath = join(directory, "identity.json");
  // Ephemeral test key only; never include private keys in source or logs.
  const privateKey = randomBytes(32);
  await writeFile(keypairPath, JSON.stringify({ privateKey: privateKey.toString("hex") }), { mode: 0o600 });
  const requests: StepRequest[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as StepRequest);
    return new Response("{}", { status: 201 });
  });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const options: HorizonSyncOptions = {
    nodeUrl: "https://kernel.test", did: DID, principal: PRINCIPAL, keypairPath, fetchImpl: fetchImpl as typeof fetch,
    logger, now: () => Date.parse("2026-10-18T12:00:00Z"),
    config: { enabled: true, ...context, filePath, stateDir: join(directory, "state"), syncIntervalMs: 1000 },
    ...overrides,
  };
  const write = async (items: HorizonItem[]) => writeFile(filePath, JSON.stringify({ depthTarget: 12, items }));
  await write([item()]);
  const create = (custom: Partial<HorizonSyncOptions> = {}) => {
    const service = createHorizonSync({ ...options, ...custom });
    services.push(service);
    return service;
  };
  return { directory, filePath, keypairPath, requests, fetchImpl, options, logger, write, create, privateKey };
}

describe("bridge mapping", () => {
  it("declares rank and three immutable code exits without authoring a zone or claim", () => {
    const mapped = mapItem(item({ zone: "head", pr: 2909, prDraft: true }), 3, context);
    expect(mapped.declaration).toEqual({
      stepKind: "code", intention: "Ship the horizon", rank: 3, repository: context.repository,
      exitConditions: [
        { id: "issue_closed", kind: "issue_closed" },
        { id: "release_contains", kind: "release_contains" },
        { id: "deployed", kind: "deployed" },
      ],
    });
    expect(mapped.refs).toEqual({ issue: "ima-jin/imajin-ai#2866", pr: "https://github.com/ima-jin/imajin-ai/pull/2909" });
    expect(mapped.update).not.toHaveProperty("issue"); // no invented OUTCOME
    expect(mapped.facts).toEqual({});
    expect(mapped).not.toHaveProperty("zone");
    expect(deriveStepId(context.loopId, DID, item().id)).toBe(mapped.stepId);
    expect(deriveStepId("another-loop", DID, item().id)).not.toBe(mapped.stepId);
  });

  it("maps past to finished plus closure, never a release/deploy assertion", () => {
    const mapped = mapItem(item({ zone: "past", waitingOn: ["release"] }), 0, context);
    expect(Object.keys(mapped.facts)).toEqual(["finished", "closed"]);
    expect(mapped.facts.closed?.data).toEqual({
      observation: { conditionId: "issue_closed", evidence: { kind: "issue_closed", issue: "ima-jin/imajin-ai#2866" } },
    });
  });

  it("sharpening and explicit release/prod evidence match the kernel contract", () => {
    const mapped = mapItem(item({
      closed: true, outcome: "OUTCOME · visible to Ryan", briefRef: "brief:2866",
      provisionRef: "provision:2866", designRef: "design:2866",
      release: { issue: "#2866", mergeCommit: "a".repeat(40), tag: "v1" },
      deployment: { tag: "v1", environment: "prod" },
    }), 0, context);
    expect(mapped.update.issue).toEqual({ ref: "ima-jin/imajin-ai#2866", outcome: "OUTCOME · visible to Ryan" });
    expect(mapped.facts.release?.data).toEqual({
      observation: { conditionId: "release_contains", evidence: {
        kind: "release_contains", repository: context.repository, issue: "ima-jin/imajin-ai#2866",
        mergeCommit: "a".repeat(40), tag: "v1",
      } },
    });
    expect(mapped.facts.deployment?.data).toEqual({
      observation: { conditionId: "deployed", evidence: {
        kind: "deployed", repository: context.repository, tag: "v1", environment: "prod",
      } },
    });
  });

  it("supports ops/human attestations but never impersonates another DID", () => {
    const mapped = mapItem(item({ refs: [], attestation: "Operator checklist complete" }), 0, context);
    expect(mapped.declaration.exitConditions).toEqual([{ id: "attestation", kind: "attestation", attestorDid: DID }]);
    expect(mapped.facts.attestation?.type).toBe("step.attested");
    expect(() => mapItem(item({ refs: [], attestation: "complete", attestorDid: PRINCIPAL }), 0, context)).toThrow();
  });

  it("normalizes qualified and GitHub refs and does not infer closure from a PR", () => {
    const mapped = mapItem(item({ refs: ["https://github.com/other/repo/issues/12"], pr: "https://github.com/other/repo/pull/15" }), 0, context);
    expect(mapped.declaration.repository).toBe("other/repo");
    expect(mapped.refs.issue).toBe("other/repo#12");
    expect(mapped.facts).toEqual({});
    expect(mapItem(item({ refs: ["other/repo#12"] }), 0, context).refs.issue).toBe("other/repo#12");
  });
});

describe("cursor diff", () => {
  it("queues once, sends sparse rank/title updates and retains removed items", () => {
    const first = mapItem(item(), 0, context);
    const planned = planDiff([first], empty());
    expect(planned.events.map(event => event.type)).toEqual(["step.queued"]);
    const cursor = { ...empty(), steps: planned.steps };
    expect(planDiff([first], cursor).events).toEqual([]);
    const change = planDiff([mapItem(item({ title: "Sharper intention" }), 2, context)], cursor);
    expect(change.events.map(event => event.data)).toEqual([{ update: { rank: 2, intention: "Sharper intention" } }]);
    expect(planDiff([], cursor).steps).toEqual(cursor.steps);
    expect(planDiff([first], { ...empty(), steps: planDiff([], cursor).steps }).events).toEqual([]);
  });
  it("does not erase sharpening and rejects immutable exit/kind changes", () => {
    const first = mapItem(item({ outcome: "OUTCOME · shipped" }), 0, context);
    const cursor = { ...empty(), steps: planDiff([first], empty()).steps };
    expect(planDiff([mapItem(item(), 0, context)], cursor).events).toEqual([]);
    expect(() => planDiff([mapItem(item({ stepKind: "human" }), 0, context)], cursor)).toThrow("immutable");
  });
});

describe("signed durable sync", () => {
  it("publishes through /api/loops under configured DID and verifies the exact signature", async () => {
    const test = await setup();
    const service = test.create();
    await service.sync();
    expect(test.requests).toHaveLength(1);
    const request = test.requests[0]!;
    expect(test.fetchImpl.mock.calls[0]?.[0]).toBe("https://kernel.test/api/loops");
    expect(request.publisherDid).toBe(DID);
    expect(request.payload).toMatchObject({
      loopId: context.loopId, principal: PRINCIPAL, state: "queued", parentLoopId: null,
      stepId: deriveStepId(context.loopId, DID, item().id),
    });
    expect(request.payload).not.toHaveProperty("zone");
    const ed = await import("@noble/ed25519");
    const publicKey = await ed.getPublicKeyAsync(test.privateKey);
    const message = new TextEncoder().encode(canonicalize({ type: request.type, payload: request.payload }));
    expect(await ed.verifyAsync(Buffer.from(request.signature.sig, "hex"), message, publicKey)).toBe(true);
    expect(request.signature.keyId).toBe(Buffer.from(publicKey).toString("hex"));
    expect(JSON.stringify(request)).not.toContain(test.privateKey.toString("hex"));
    expect((await stat(service.cursorPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(service.cursorPath, "utf8")).not.toContain(test.privateKey.toString("hex"));
  });

  it("does not republish on a second tick, restart, remove/re-add, or duplicate callbacks", async () => {
    const test = await setup();
    const first = test.create();
    await Promise.all([first.sync(), first.sync(), first.sync()]);
    await first.sync();
    await first.stop();
    const restart = test.create();
    await restart.sync();
    await test.write([]);
    await restart.sync();
    await test.write([item()]);
    await restart.sync();
    expect(test.requests).toHaveLength(1);
  });

  it("persists before network I/O and replays byte-identical requests after an ambiguous failure", async () => {
    const test = await setup();
    const first = test.create();
    test.fetchImpl.mockImplementationOnce(async (_url, init) => {
      const persisted = JSON.parse(await readFile(first.cursorPath, "utf8")) as Cursor;
      expect(JSON.stringify(persisted.pending?.requests[0])).toBe(String(init?.body));
      test.requests.push(JSON.parse(String(init?.body)) as StepRequest);
      throw new TypeError("response lost");
    });
    await first.sync();
    await first.stop();
    const restart = test.create({ now: () => Date.parse("2026-10-18T12:01:00Z") });
    await restart.sync();
    expect(test.requests).toHaveLength(2);
    expect(test.requests[1]).toEqual(test.requests[0]);
    await restart.sync();
    expect(test.requests).toHaveLength(2);
    expect(JSON.parse(await readFile(restart.cursorPath, "utf8"))).not.toHaveProperty("pending");
  });

  it("acks successful events individually and resumes only the remaining batch", async () => {
    const test = await setup();
    await test.write([item({ closed: true, outcome: "OUTCOME · closed" })]);
    test.fetchImpl.mockImplementationOnce(async (_url, init) => {
      test.requests.push(JSON.parse(String(init?.body)) as StepRequest);
      return new Response("{}", { status: 201 });
    }).mockImplementationOnce(async (_url, init) => {
      test.requests.push(JSON.parse(String(init?.body)) as StepRequest);
      return new Response("not authorized", { status: 403 });
    });
    const first = test.create();
    await first.sync();
    await first.stop();
    await test.create().sync();
    expect(test.requests.map(request => request.type)).toEqual([
      "step.queued", "step.updated", "step.updated", "step.finished", "step.observed",
    ]);
    expect(test.requests[2]).toEqual(test.requests[1]);
  });

  it("isolates two publisher DIDs in one loop even with the same item id and state directory", async () => {
    const test = await setup();
    const otherPath = join(test.directory, "other-identity.json");
    const otherKey = randomBytes(32);
    await writeFile(otherPath, JSON.stringify({ privateKey: otherKey.toString("hex") }), { mode: 0o600 });
    const first = test.create();
    const second = test.create({ did: "did:imajin:second", keypairPath: otherPath });
    await Promise.all([first.sync(), second.sync()]);
    expect(first.cursorPath).not.toBe(second.cursorPath);
    expect(new Set(test.requests.map(request => request.payload.stepId)).size).toBe(2);
    expect(new Set(test.requests.map(request => request.publisherDid))).toEqual(new Set([DID, "did:imajin:second"]));
    expect(new Set(test.requests.map(request => request.signature.keyId)).size).toBe(2);
    expect(test.requests.every(request => request.payload.loopId === context.loopId && request.payload.principal === PRINCIPAL)).toBe(true);
    const ed = await import("@noble/ed25519");
    for (const request of test.requests) {
      expect(await ed.verifyAsync(
        Buffer.from(request.signature.sig, "hex"),
        new TextEncoder().encode(canonicalize({ type: request.type, payload: request.payload })),
        await ed.getPublicKeyAsync(request.publisherDid === DID ? test.privateKey : otherKey),
      )).toBe(true);
    }
    await first.stop();
    await second.stop();
    await test.create().sync();
    await test.create({ did: "did:imajin:second", keypairPath: otherPath }).sync();
    expect(test.requests).toHaveLength(2);
  });

  it("publishes reorder and past facts once; ignores local near/head as authority", async () => {
    const test = await setup();
    const second = item({ id: "second", refs: ["#22"] });
    await test.write([item(), second]);
    const service = test.create();
    await service.sync();
    await test.write([second, item({ zone: "past", outcome: "OUTCOME · complete", waitingOn: ["release"] })]);
    await service.sync();
    await service.sync();
    expect(test.requests.map(request => request.type)).toEqual([
      "step.queued", "step.queued", "step.updated", "step.updated", "step.finished", "step.observed",
    ]);
    expect(test.requests[2]?.payload.update).toEqual({ rank: 0 });
    expect(test.requests[3]?.payload.update).toEqual({
      rank: 1, issue: { ref: "ima-jin/imajin-ai#2866", outcome: "OUTCOME · complete" },
    });
    expect(Date.parse(test.requests[2]!.payload.at)).toBeGreaterThan(Date.parse(test.requests[0]!.payload.at));
    expect(JSON.stringify(test.requests)).not.toContain('"zone"');
    expect(JSON.stringify(test.requests)).not.toContain('"claim"');
  });
});

describe("safe failures and service lifecycle", () => {
  it.each([
    "{broken",
    JSON.stringify({ depthTarget: 12, items: [item(), item()] }),
    JSON.stringify({ depthTarget: 12, items: [item(), item({ id: "bad", title: "" })] }),
    JSON.stringify({ depthTarget: 12, items: [item({ outcome: "not an outcome" })] }),
    JSON.stringify({ depthTarget: 12, items: [item({ deployment: { tag: "v1", environment: "dev" as "prod" } })] }),
  ])("logs but never publishes a malformed complete snapshot", async raw => {
    const test = await setup();
    await writeFile(test.filePath, raw);
    await test.create().sync();
    expect(test.fetchImpl).not.toHaveBeenCalled();
    expect(test.logger.warn).toHaveBeenCalledTimes(1);
    expect(String(test.logger.warn.mock.calls)).not.toContain(raw);
  });

  it("blocks pending retries while file is malformed and resumes once repaired", async () => {
    const test = await setup();
    test.fetchImpl.mockResolvedValueOnce(new Response("error", { status: 500 }));
    const service = test.create();
    await service.sync();
    await writeFile(test.filePath, "{broken");
    await service.sync();
    expect(test.fetchImpl).toHaveBeenCalledTimes(1);
    await test.write([item()]);
    await service.sync();
    expect(test.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not reset a corrupt cursor, or publish without a readable signing identity", async () => {
    const test = await setup();
    const service = test.create();
    await service.sync();
    await writeFile(service.cursorPath, "{broken");
    await service.sync();
    expect(test.fetchImpl).toHaveBeenCalledTimes(1);
    const noKey = test.create({ keypairPath: join(test.directory, "missing"), did: "did:imajin:no-key" });
    await noKey.sync();
    expect(test.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed for a wrong cursor scope and invalid configuration", async () => {
    const test = await setup();
    const service = test.create();
    await service.sync();
    await expect(loadCursor(service.cursorPath, "different-scope")).rejects.toThrow();
    expect(() => test.create({ config: { loopId: "", repository: context.repository } })).toThrow();
    expect(() => test.create({ config: { ...test.options.config, syncIntervalMs: 0 } })).toThrow();
    const api = { registerService: vi.fn() };
    expect(registerHorizonSync(api, { ...test.options, config: undefined })).toBeUndefined();
    expect(registerHorizonSync(api, { ...test.options, config: { enabled: true } })).toBeUndefined();
    expect(api.registerService).not.toHaveBeenCalled();
  });

  it("registers startup/tick/watch sync and closes cleanly on stop", async () => {
    const test = await setup();
    const api = { registerService: vi.fn() };
    const service = registerHorizonSync(api, test.options)!;
    services.push(service);
    expect(api.registerService.mock.calls[0]?.[0].id).toBe("imajin-horizon-sync");
    service.start();
    await vi.waitFor(() => expect(test.requests).toHaveLength(1));
    const replacement = `${test.filePath}.new`;
    await writeFile(replacement, JSON.stringify({ depthTarget: 12, items: [item(), item({ id: "atomic-new" })] }));
    await rename(replacement, test.filePath);
    await vi.waitFor(() => expect(test.requests).toHaveLength(2));
    await service.stop();
    await test.write([item(), item({ id: "after-stop" })]);
    await service.sync();
    expect(test.requests).toHaveLength(2);
  });

  it("persists empty completed outboxes as committed cursors", async () => {
    const test = await setup();
    const service = test.create();
    await service.sync();
    const cursor = await loadCursor(service.cursorPath, JSON.parse(await readFile(service.cursorPath, "utf8")).scope);
    await saveCursor(service.cursorPath, { ...cursor, pending: { requests: [], steps: cursor.steps, at: cursor.lastAt } });
    await service.sync();
    expect(test.requests).toHaveLength(1);
    expect(JSON.parse(await readFile(service.cursorPath, "utf8"))).not.toHaveProperty("pending");
  });

  it("rejects oversized or wrong-shaped inputs and mismatched release evidence", () => {
    expect(() => parseHorizon(" ".repeat(1_048_577))).toThrow();
    expect(() => parseHorizon("[]")).toThrow();
    expect(() => parseHorizon(JSON.stringify({ depthTarget: 0, items: [] }))).toThrow();
    expect(() => mapItem(item({ release: { issue: "#99", mergeCommit: "a".repeat(40), tag: "v1" } }), 0, context)).toThrow();
  });
});
