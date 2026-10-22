import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalize } from "../approval-bridge.js";
import type { LoopIngestRequest, LoopReceiptPayload } from "../loop-publisher.js";
import { saveCursor, type Cursor } from "./cursor.js";
import type { StepRequest } from "./model.js";
import { envelopeHash, isStale, lookupReceipt } from "./receipts.js";
import { createHorizonSync, type HorizonSyncOptions } from "./sync.js";

const START = Date.parse("2026-10-21T12:00:00Z");
const RESTART = START + 10 * 60_000;
type ReceiptRequest = LoopIngestRequest<"loop.receipt", LoopReceiptPayload>;
function envelope(): StepRequest {
  return {
    type: "step.finished",
    payload: {
      loopId: "loop:horizon", principal: "did:imajin:operator", stepId: `horizon:${"a".repeat(32)}`,
      kind: "openclaw.horizon", state: "observed", summary: "harness horizon observation",
      parentLoopId: null, refs: {}, at: new Date(START).toISOString(),
    },
    publisherDid: "did:imajin:publisher",
    signature: { keyId: "AB".repeat(32), alg: "ed25519", sig: "CD".repeat(64) },
  };
}
function accepted(request: StepRequest): Response {
  return Response.json({ status: "accepted", eventId: `signed-loop:${envelopeHash(request)}` });
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "horizon-receipt-"));
  const filePath = join(directory, "horizon.json");
  const keypairPath = join(directory, "identity.json");
  const privateKey = randomBytes(32);
  await writeFile(keypairPath, JSON.stringify({ privateKey: privateKey.toString("hex") }), { mode: 0o600 });
  const snapshot = {
    depthTarget: 12,
    items: [{ id: "task", zone: "tail", title: "Ship horizon", refs: [], addedAt: new Date(START).toISOString() }],
  };
  await writeFile(filePath, JSON.stringify(snapshot));
  const logger = { info: vi.fn(), warn: vi.fn() };
  const ingest: StepRequest[] = [];
  const receipts: ReceiptRequest[] = [];
  // Simulate the durable kernel accepting an event before its response is lost.
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
    ingest.push(JSON.parse(String(init?.body)));
    throw new TypeError("accepted but response lost");
  });
  const options: HorizonSyncOptions = {
    nodeUrl: "https://kernel.test", did: "did:imajin:publisher", principal: "did:imajin:operator",
    keypairPath, logger, fetchImpl: fetchImpl as typeof fetch, now: () => START,
    config: { loopId: "loop:horizon", repository: "ima-jin/imajin-ai", filePath, stateDir: join(directory, "state") },
  };
  const first = createHorizonSync(options);
  await first.sync();
  await first.stop();
  const originalCursor = await readFile(first.cursorPath, "utf8");
  const request = ingest[0]!;
  const restart = (overrides: Partial<HorizonSyncOptions> = {}) => createHorizonSync({
    ...options, now: () => RESTART, ...overrides,
  });
  function respond(reply: () => Response | Promise<Response>) {
    fetchImpl.mockImplementation(async (url, init) => {
      expect(url).toBe("https://kernel.test/api/loops/receipts");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      receipts.push(JSON.parse(String(init?.body)));
      return reply();
    });
  }
  return { directory, filePath, keypairPath, snapshot, logger, ingest, receipts, fetchImpl, options,
    first, originalCursor, request, privateKey, restart, respond };
}

describe("kernel receipt contract", () => {
  it("hashes canonical parsed ingest with normalized signature hex, retaining null/absent/extensions", () => {
    const request = envelope();
    request.payload.extension = { z: null, a: "asserted fact" };
    const before = structuredClone(request);
    const expected = createHash("sha256").update(canonicalize({
      type: request.type, payload: request.payload, publisherDid: request.publisherDid,
      signature: { keyId: "ab".repeat(32), alg: "ed25519", sig: "cd".repeat(64) },
    })).digest("hex");
    expect(envelopeHash(request)).toBe(expected);
    expect(envelopeHash(request)).not.toBe(createHash("sha256").update(JSON.stringify(request)).digest("hex"));
    const reordered = JSON.parse(JSON.stringify({
      signature: request.signature, publisherDid: request.publisherDid, payload: request.payload, type: request.type,
    })) as StepRequest;
    expect(envelopeHash(reordered)).toBe(expected);
    const absent = structuredClone(request);
    Reflect.deleteProperty(absent.payload, "parentLoopId");
    expect(envelopeHash(absent)).not.toBe(expected);
    const changed = structuredClone(request);
    changed.payload.extension = { a: "different fact", z: null };
    expect(envelopeHash(changed)).not.toBe(expected);
    expect(request).toEqual(before);
  });
  it("uses the documented five-minute boundary and rejects an invalid original timestamp", () => {
    expect(isStale(envelope(), START + 300_000)).toBe(false);
    expect(isStale(envelope(), START + 300_001)).toBe(true);
    const invalid = envelope();
    invalid.payload.at = "invalid";
    expect(() => isStale(invalid, RESTART)).toThrow("invalid outbox timestamp");
  });
  it.each([
    [200, { status: "accepted", eventId: "signed-loop:wrong-hash" }],
    [200, { status: "accepted" }],
    [201, { status: "accepted" }],
    [404, { status: "accepted" }],
    [200, { status: "not_found" }],
    [404, { error: "not found" }],
    [400, { status: "not_found" }],
    [401, { status: "not_found" }],
    [403, { status: "not_found" }],
    [500, { status: "not_found" }],
  ])("does not trust mismatched or unauthorized HTTP %s receipts", async (status, body) => {
    const transport = { receipt: vi.fn(async () => Response.json(body, { status })) };
    expect(await lookupReceipt(transport, envelope(), RESTART)).toBe("unavailable");
  });
  it.each(["{broken", "null", "[]", "", "x".repeat(4097)])("fails closed on malformed or oversized receipt bodies", async body => {
    expect(await lookupReceipt({ receipt: async () => new Response(body) }, envelope(), RESTART)).toBe("unavailable");
  });
  it("fails closed when response streaming breaks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("read failed")); },
    });
    expect(await lookupReceipt({ receipt: async () => new Response(stream) }, envelope(), RESTART)).toBe("unavailable");
  });
});

describe("stale durable outbox recovery", () => {
  it("reconciles an accepted envelope after restart with a fresh separately verified signature and no duplicate publish", async () => {
    const test = await fixture();
    test.respond(() => accepted(test.request));
    const service = test.restart();
    await service.sync();
    const lookup = test.receipts[0]!;
    expect(lookup.type).toBe("loop.receipt");
    expect(lookup.publisherDid).toBe(test.request.publisherDid);
    expect(lookup.payload).toEqual({
      loopId: test.request.payload.loopId, principal: test.request.payload.principal,
      envelopeHash: envelopeHash(test.request), at: new Date(RESTART).toISOString(),
    });
    const ed = await import("@noble/ed25519");
    expect(await ed.verifyAsync(
      Buffer.from(lookup.signature.sig, "hex"),
      new TextEncoder().encode(canonicalize({ type: lookup.type, payload: lookup.payload })),
      await ed.getPublicKeyAsync(test.privateKey),
    )).toBe(true);
    expect(lookup.signature).not.toEqual(test.request.signature);
    expect(test.ingest).toHaveLength(1); // The simulated kernel's history has exactly one event.
    expect(JSON.parse(await readFile(service.cursorPath, "utf8"))).not.toHaveProperty("pending");
    expect(test.logger.info).toHaveBeenCalledWith(expect.stringContaining("receipt accepted"));
    await expect(stat(service.deadLetterPath)).rejects.toMatchObject({ code: "ENOENT" });
    await service.stop();
    await test.restart().sync();
    expect(test.receipts).toHaveLength(1);
    expect(test.ingest).toHaveLength(1);
  });
  it.each(["not_found", "unreachable", "server_error", "denied", "wrong_event"] as const)(
    "retains the exact saved batch on %s, blocks changed source facts, and retries only the lookup",
    async outcome => {
      const test = await fixture();
      const privateDiagnostic = randomBytes(24).toString("base64url");
      test.respond(() => {
        if (outcome === "unreachable") throw new TypeError(privateDiagnostic);
        if (outcome === "server_error") return new Response(privateDiagnostic, { status: 500 });
        if (outcome === "denied") return Response.json({ status: "not_found" }, { status: 404 });
        if (outcome === "wrong_event") return Response.json({ status: "accepted", eventId: "signed-loop:other" });
        return Response.json({ status: "not_found" }, { status: 404 });
      });
      test.snapshot.items[0]!.title = "Changed while awaiting receipt";
      await writeFile(test.filePath, JSON.stringify(test.snapshot));
      const service = test.restart();
      await service.sync();
      await service.sync();
      expect(await readFile(service.cursorPath, "utf8")).toBe(test.originalCursor);
      expect(test.ingest).toHaveLength(1);
      expect(test.receipts).toHaveLength(2);
      expect(test.receipts.every(receipt => receipt.payload.envelopeHash === envelopeHash(test.request))).toBe(true);
      const result = outcome === "not_found" || outcome === "denied" ? "not_found" : "unavailable";
      expect(test.logger.warn).toHaveBeenCalledWith(expect.stringContaining(`receipt ${result}; exact envelope retained`));
      expect(test.logger.warn.mock.calls.filter(([message]) => message.includes(`receipt ${result}`))).toHaveLength(1);
      expect(JSON.stringify(test.logger.info.mock.calls)).not.toContain(privateDiagnostic);
      expect(JSON.stringify(test.logger.warn.mock.calls)).not.toContain(privateDiagnostic);
      await expect(stat(service.deadLetterPath)).rejects.toMatchObject({ code: "ENOENT" });
      await service.stop();
    },
  );
  it("recovers from a transient lookup failure with a newer lookup at, never a newer original at", async () => {
    const test = await fixture();
    test.respond(() => new Response(null, { status: 500 }));
    await test.restart().sync();
    expect(await readFile(test.first.cursorPath, "utf8")).toBe(test.originalCursor);
    test.respond(() => accepted(test.request));
    await test.restart({ now: () => RESTART + 60_000 }).sync();
    expect(test.receipts.map(receipt => receipt.payload.at)).toEqual([
      new Date(RESTART).toISOString(), new Date(RESTART + 60_000).toISOString(),
    ]);
    expect(test.ingest).toEqual([test.request]);
    expect(test.request.payload.at).toBe(new Date(START).toISOString());
  });
  it.each(["publisherDid", "loopId", "principal"] as const)("does not look up a cursor with mismatched %s", async field => {
    const test = await fixture();
    const cursor = JSON.parse(test.originalCursor) as Cursor;
    const request = cursor.pending!.requests[0]!;
    if (field === "publisherDid") request.publisherDid = "did:imajin:other";
    else request.payload[field] = "did:imajin:other";
    await saveCursor(test.first.cursorPath, cursor);
    test.fetchImpl.mockClear();
    await test.restart().sync();
    expect(test.fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(test.first.cursorPath, "utf8")).pending.requests).toEqual([request]);
  });
  it("resumes only unacknowledged receipt lookups after a mid-batch failure and restart", async () => {
    const test = await fixture();
    const cursor = JSON.parse(test.originalCursor) as Cursor;
    const second = structuredClone(test.request);
    second.type = "step.finished";
    cursor.pending!.requests.push(second);
    await saveCursor(test.first.cursorPath, cursor);
    test.respond(() => test.receipts.length === 1 ? accepted(test.request) : new Response(null, { status: 503 }));
    await test.restart().sync();
    expect(JSON.parse(await readFile(test.first.cursorPath, "utf8")).pending.requests).toEqual([second]);
    test.respond(() => accepted(second));
    await test.restart().sync();
    expect(test.receipts.map(receipt => receipt.payload.envelopeHash)).toEqual([
      envelopeHash(test.request), envelopeHash(second), envelopeHash(second),
    ]);
    expect(JSON.parse(await readFile(test.first.cursorPath, "utf8"))).not.toHaveProperty("pending");
    expect(test.ingest).toHaveLength(1);
  });
  it("repeats a read-only receipt safely if cursor acknowledgement cannot be persisted", async () => {
    const test = await fixture();
    test.respond(async () => {
      await rename(test.first.cursorPath, `${test.first.cursorPath}.saved`);
      // Make the destination a directory so the atomic cursor rename fails.
      const { mkdir } = await import("node:fs/promises");
      await mkdir(test.first.cursorPath);
      return accepted(test.request);
    });
    await test.restart().sync();
    await rename(test.first.cursorPath, `${test.first.cursorPath}.blocked`);
    await rename(`${test.first.cursorPath}.saved`, test.first.cursorPath);
    test.respond(() => accepted(test.request));
    await test.restart().sync();
    expect(test.receipts).toHaveLength(2);
    expect(test.ingest).toHaveLength(1);
    expect(JSON.parse(await readFile(test.first.cursorPath, "utf8"))).not.toHaveProperty("pending");
  });
  it("reconciles when an ingest 400 crosses the age boundary during the request", async () => {
    const test = await fixture();
    let clock = START + 300_000;
    test.fetchImpl.mockImplementation(async (url, init) => {
      if (url === "https://kernel.test/api/loops") {
        expect(JSON.parse(String(init?.body))).toEqual(test.request);
        clock += 1;
        return new Response(null, { status: 400 });
      }
      expect(url).toBe("https://kernel.test/api/loops/receipts");
      test.receipts.push(JSON.parse(String(init?.body)));
      return accepted(test.request);
    });
    const service = test.restart({ now: () => clock });
    await service.sync();
    expect(test.receipts).toHaveLength(1);
    expect(JSON.parse(await readFile(service.cursorPath, "utf8"))).not.toHaveProperty("pending");
    await expect(stat(service.deadLetterPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
