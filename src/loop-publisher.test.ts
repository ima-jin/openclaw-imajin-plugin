import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { canonicalize } from "./approval-bridge.js";
import {
  MAX_SUMMARY_LENGTH,
  createLoopSender,
  deriveLoopId,
  sanitizeRefs,
  sanitizeSummary,
  type LoopIngestRequest,
  type LoopTransition,
} from "./loop-publisher.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const NODE_URL = "https://node.test/";
const DID = "did:imajin:agent";
const PRINCIPAL = "did:imajin:operator";
const PRIVATE_KEY_HEX = "11".repeat(32);
const KEYPAIR = JSON.stringify({ did: DID, privateKey: PRIVATE_KEY_HEX });

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
}

async function ed25519() {
  const ed = await import("@noble/ed25519");
  const { sha512 } = await import("@noble/hashes/sha2.js");
  if ("hashes" in ed && ed.hashes) {
    (ed.hashes as { sha512?: typeof sha512 }).sha512 = sha512;
  } else {
    ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
  }
  return ed;
}

const transition = (over: Partial<LoopTransition> = {}): LoopTransition => ({
  type: "loop.started",
  loopId: "openclaw.session:abc",
  kind: "openclaw.session",
  parentLoopId: null,
  refs: {},
  state: "running",
  summary: "session started",
  ...over,
});

function okFetch() {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("{}", { status: 201 }));
}

function bodies(fetchMock: ReturnType<typeof okFetch>): LoopIngestRequest[] {
  return fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as LoopIngestRequest);
}

beforeEach(() => {
  vi.mocked(readFile).mockReset();
  vi.mocked(readFile).mockResolvedValue(KEYPAIR);
});

describe("deriveLoopId", () => {
  it("is deterministic and never embeds the OpenClaw identifier", () => {
    const a = deriveLoopId(DID, "openclaw.session", "agent:main:telegram:direct:42");
    expect(deriveLoopId(DID, "openclaw.session", "agent:main:telegram:direct:42")).toBe(a);
    expect(a).toMatch(/^openclaw\.session:[0-9a-f]{32}$/);
    expect(a).not.toContain("telegram");
  });

  it("separates publishers, kinds and parts", () => {
    const base = deriveLoopId(DID, "openclaw.session", "k");
    expect(deriveLoopId("did:imajin:other", "openclaw.session", "k")).not.toBe(base);
    expect(deriveLoopId(DID, "openclaw.subagent", "k")).not.toBe(base);
    expect(deriveLoopId(DID, "openclaw.session", "k2")).not.toBe(base);
    // part boundaries are unambiguous
    expect(deriveLoopId(DID, "openclaw.automation", "a", "bc")).not.toBe(
      deriveLoopId(DID, "openclaw.automation", "ab", "c"),
    );
  });
});

describe("sanitizeSummary / sanitizeRefs", () => {
  it("redacts secret-shaped substrings", () => {
    const out = sanitizeSummary(
      "failed: Bearer abcdefghijklmnop token=hunter2hunter2 sk-abcdefghijklmnopqrstuv " +
        "deadbeef".repeat(8),
    );
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("sk-abcdef");
    expect(out).not.toContain("deadbeefdeadbeef");
    expect(out).toContain("[redacted]");
  });

  it("caps length, collapses whitespace and never returns empty", () => {
    expect(sanitizeSummary("word ".repeat(1000))).toHaveLength(MAX_SUMMARY_LENGTH);
    expect(sanitizeSummary("a\n\n  b")).toBe("a b");
    expect(sanitizeSummary("   ")).toBe("loop transition");
  });

  it("keeps only the four ref keys the kernel accepts, non-empty", () => {
    const refs = sanitizeRefs({
      sessionKey: "agent:main:main",
      runId: "",
      issue: undefined,
      extra: "nope",
    } as never);
    expect(refs).toEqual({ sessionKey: "agent:main:main" });
  });
});

describe("createLoopSender", () => {
  it("POSTs the kernel envelope to /api/loops, signed over canonicalize({type,payload})", async () => {
    const fetchMock = okFetch();
    const sender = createLoopSender({
      nodeUrl: NODE_URL,
      did: DID,
      principal: PRINCIPAL,
      keypairPath: "/k.json",
      fetchImpl: fetchMock as never,
      now: () => Date.parse("2026-09-27T10:00:00.000Z"),
    });

    sender.publish(
      transition({
        type: "loop.progress",
        parentLoopId: "openclaw.session:parent",
        refs: { sessionKey: "agent:main:main", runId: "run-1" },
        state: "running",
        summary: "turn ended (ok)",
      }),
    );
    await sender.idle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://node.test/api/loops");
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");

    const [request] = bodies(fetchMock);
    expect(request!.type).toBe("loop.progress");
    expect(request!.publisherDid).toBe(DID);
    expect(request!.payload).toEqual({
      loopId: "openclaw.session:abc",
      kind: "openclaw.session",
      principal: PRINCIPAL,
      parentLoopId: "openclaw.session:parent",
      refs: { sessionKey: "agent:main:main", runId: "run-1" },
      state: "running",
      summary: "turn ended (ok)",
      at: "2026-09-27T10:00:00.000Z",
    });
    expect(request!.signature.alg).toBe("ed25519");

    const ed = await ed25519();
    const publicKey = await ed.getPublicKeyAsync(hexToBytes(PRIVATE_KEY_HEX));
    expect(request!.signature.keyId).toBe(Buffer.from(publicKey).toString("hex"));
    const message = new TextEncoder().encode(
      canonicalize({ type: request!.type, payload: request!.payload }),
    );
    await expect(
      ed.verifyAsync(hexToBytes(request!.signature.sig), message, publicKey),
    ).resolves.toBe(true);
  });

  it("always sends parentLoopId (null) and refs ({}) so the signed bytes match the kernel's parsed payload", async () => {
    const fetchMock = okFetch();
    const sender = createLoopSender({
      nodeUrl: NODE_URL,
      did: DID,
      keypairPath: "/k.json",
      fetchImpl: fetchMock as never,
    });
    sender.publish(transition());
    await sender.idle();

    const [request] = bodies(fetchMock);
    expect(request!.payload.parentLoopId).toBeNull();
    expect(request!.payload.refs).toEqual({});
    expect(request!.payload.principal).toBe(DID); // defaults to the agent DID
    expect(Object.keys(request!.payload).sort()).toEqual(
      ["at", "kind", "loopId", "parentLoopId", "principal", "refs", "state", "summary"],
    );
    const canonical = canonicalize({ type: request!.type, payload: request!.payload });
    expect(canonical).toContain('"refs":{}');
    expect(canonical).toContain('"parentLoopId":null');
    expect(canonical).not.toContain("undefined");
  });

  it("never puts key material in the request", async () => {
    const fetchMock = okFetch();
    const sender = createLoopSender({
      nodeUrl: NODE_URL,
      did: DID,
      keypairPath: "/k.json",
      fetchImpl: fetchMock as never,
    });
    sender.publish(transition());
    await sender.idle();
    expect(String(fetchMock.mock.calls[0]![1]?.body)).not.toContain(PRIVATE_KEY_HEX);
  });

  it("sends strictly in publish order even when an earlier POST is slow", async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { type } = JSON.parse(String(init?.body)) as { type: string };
      if (type === "loop.started") await new Promise((r) => setTimeout(r, 25));
      order.push(type);
      return new Response("{}", { status: 201 });
    });
    const sender = createLoopSender({
      nodeUrl: NODE_URL,
      did: DID,
      keypairPath: "/k.json",
      fetchImpl: fetchMock as never,
    });
    sender.publish(transition({ type: "loop.started" }));
    sender.publish(transition({ type: "loop.finished", state: "succeeded" }));
    await sender.idle();
    expect(order).toEqual(["loop.started", "loop.finished"]);
  });

  describe("publish failures never escape", () => {
    it("network error: publish() does not throw, nothing rejects, failure is logged", async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const sender = createLoopSender({
        nodeUrl: NODE_URL,
        did: DID,
        keypairPath: "/k.json",
        fetchImpl: vi.fn().mockRejectedValue(new TypeError("fetch failed")) as never,
        logger,
      });
      expect(() => sender.publish(transition())).not.toThrow();
      await expect(sender.idle()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0]![0]).toContain("loop.started failed");
    });

    it("kernel rejection (400/403/500): dropped, not retried, status logged without payload", async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const fetchMock = vi.fn(async () => new Response("nope", { status: 403 }));
      const sender = createLoopSender({
        nodeUrl: NODE_URL,
        did: DID,
        keypairPath: "/k.json",
        fetchImpl: fetchMock as never,
        logger,
      });
      sender.publish(transition({ summary: "super secret summary" }));
      await sender.idle();
      expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
      const logged = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("HTTP 403");
      expect(logged).not.toContain("super secret summary");
    });

    it("unreadable keypair: dropped quietly, and a later publish retries loading it", async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const fetchMock = okFetch();
      vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT"));
      const sender = createLoopSender({
        nodeUrl: NODE_URL,
        did: DID,
        keypairPath: "/k.json",
        fetchImpl: fetchMock as never,
        logger,
      });
      sender.publish(transition());
      await sender.idle();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);

      sender.publish(transition({ type: "loop.finished" }));
      await sender.idle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rate-limits the failure log instead of storming it", async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      let clock = 1_000_000;
      const sender = createLoopSender({
        nodeUrl: NODE_URL,
        did: DID,
        keypairPath: "/k.json",
        fetchImpl: vi.fn().mockRejectedValue(new Error("down")) as never,
        logger,
        now: () => clock,
      });
      for (let i = 0; i < 10; i += 1) sender.publish(transition());
      await sender.idle();
      expect(logger.warn).toHaveBeenCalledTimes(1);

      clock += 61_000;
      sender.publish(transition());
      await sender.idle();
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("bounds the queue when the kernel is unreachable", async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const fetchMock = vi.fn(() => new Promise<Response>(() => undefined)); // hangs forever
      const sender = createLoopSender({
        nodeUrl: NODE_URL,
        did: DID,
        keypairPath: "/k.json",
        fetchImpl: fetchMock as never,
        logger,
      });
      for (let i = 0; i < 400; i += 1) {
        expect(() => sender.publish(transition())).not.toThrow();
      }
      expect(logger.warn.mock.calls.some((c) => String(c[0]).includes("queue full"))).toBe(true);
    });
  });
});
