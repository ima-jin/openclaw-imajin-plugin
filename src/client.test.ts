import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ImajinClient, validateDid } from "./client.js";

const BASE_URL = "https://test.imajin.ai";

function mockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(response),
    json: async () => response,
    headers: new Headers(
      status === 200 ? { "set-cookie": "session=abc123; Path=/; HttpOnly" } : {},
    ),
  } as unknown as Response);
}

describe("ImajinClient media extensions", () => {
  let client: ImajinClient;

  beforeEach(() => {
    client = new ImajinClient({ nodeUrl: BASE_URL, did: "did:imajin:test" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moveMediaToFolder PUTs a single folderId array", async () => {
    global.fetch = mockFetch({ assetId: "asset_123", folderIds: ["folder_456"] });
    const result = await client.moveMediaToFolder("asset_123", "folder_456");
    expect(result).toEqual({ assetId: "asset_123", folderIds: ["folder_456"] });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const req = calls[calls.length - 1][0] as string;
    const init = calls[calls.length - 1][1] as RequestInit;
    expect(req).toBe(`${BASE_URL}/media/api/assets/asset_123/folders`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ folderIds: ["folder_456"] });
  });

  it("setMediaAccess PATCHes access level", async () => {
    global.fetch = mockFetch({ id: "asset_123", access: { type: "public" } });
    const result = await client.setMediaAccess("asset_123", "public");
    expect(result).toEqual({ id: "asset_123", access: { type: "public" } });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const req = calls[calls.length - 1][0] as string;
    const init = calls[calls.length - 1][1] as RequestInit;
    expect(req).toBe(`${BASE_URL}/media/api/assets/asset_123/access`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ access: "public" });
  });

  it("grantMediaAccess PATCHes { add: [did] }", async () => {
    global.fetch = mockFetch({ id: "asset_123", allowedDids: ["did:imajin:other"] });
    const result = await client.grantMediaAccess("asset_123", "did:imajin:other");
    expect(result).toEqual({ id: "asset_123", allowedDids: ["did:imajin:other"] });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const req = calls[calls.length - 1][0] as string;
    const init = calls[calls.length - 1][1] as RequestInit;
    expect(req).toBe(`${BASE_URL}/media/api/assets/asset_123/grants`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ add: ["did:imajin:other"] });
  });

  it("revokeMediaAccess PATCHes { remove: [did] }", async () => {
    global.fetch = mockFetch({ id: "asset_123", allowedDids: [] });
    const result = await client.revokeMediaAccess("asset_123", "did:imajin:other");
    expect(result).toEqual({ id: "asset_123", allowedDids: [] });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const req = calls[calls.length - 1][0] as string;
    const init = calls[calls.length - 1][1] as RequestInit;
    expect(req).toBe(`${BASE_URL}/media/api/assets/asset_123/grants`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ remove: ["did:imajin:other"] });
  });

  it("publishMediaAsArticle PATCHes article metadata", async () => {
    global.fetch = mockFetch({
      id: "asset_123",
      metadata: { article: { slug: "hello", title: "Hello" } },
    });
    const result = await client.publishMediaAsArticle("asset_123", {
      slug: "hello",
      title: "Hello",
      subtitle: "World",
      status: "DRAFT",
    });
    expect(result).toEqual({
      id: "asset_123",
      metadata: { article: { slug: "hello", title: "Hello" } },
    });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const req = calls[calls.length - 1][0] as string;
    const init = calls[calls.length - 1][1] as RequestInit;
    expect(req).toBe(`${BASE_URL}/media/api/assets/asset_123/article`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      slug: "hello",
      title: "Hello",
      subtitle: "World",
      status: "DRAFT",
    });
  });

  it("sends X-Acting-For header when actAs is configured", async () => {
    const actingClient = new ImajinClient({
      nodeUrl: BASE_URL,
      did: "did:imajin:agent",
      actAs: "did:imajin:user",
    });
    global.fetch = mockFetch({ ok: true });
    await actingClient.getRaw("/registry/api/search?q=test");

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const init = calls[calls.length - 1][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Acting-For"]).toBe("did:imajin:user");
    expect(headers["X-Agent-DID"]).toBe("did:imajin:agent");
  });

  it("per-call onBehalfOf overrides constructor actAs", async () => {
    const actingClient = new ImajinClient({
      nodeUrl: BASE_URL,
      did: "did:imajin:agent",
      actAs: "did:imajin:default-principal",
    });
    global.fetch = mockFetch({ ok: true });
    await actingClient.getRaw("/registry/api/search?q=test", {
      onBehalfOf: "did:imajin:override-principal",
    });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const init = calls[calls.length - 1][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Acting-For"]).toBe("did:imajin:override-principal");
  });

  it("onBehalfOf with invalid DID format throws", async () => {
    global.fetch = mockFetch({ ok: true });
    await expect(client.getRaw("/test", { onBehalfOf: "not-a-did" })).rejects.toThrow(
      "Invalid DID format for onBehalfOf: not-a-did",
    );
  });

  it('onBehalfOf "self" suppresses actAs — no delegation header (#1545)', async () => {
    const actingClient = new ImajinClient({
      nodeUrl: BASE_URL,
      did: "did:imajin:agent",
      actAs: "did:imajin:user",
    });
    global.fetch = mockFetch({ ok: true });
    await actingClient.getRaw("/registry/api/search?q=test", { onBehalfOf: "self" });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const init = calls[calls.length - 1][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Acting-For"]).toBeUndefined();
    expect(headers["X-Agent-DID"]).toBe("did:imajin:agent");
  });

  it("no delegation header when neither actAs nor onBehalfOf set", async () => {
    global.fetch = mockFetch({ ok: true });
    await client.getRaw("/registry/api/search?q=test");

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const init = calls[calls.length - 1][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Acting-For"]).toBeUndefined();
    expect(headers["X-Acting-As"]).toBeUndefined();
  });
});

describe("validateDid", () => {
  it("accepts valid Imajin DIDs", () => {
    expect(validateDid("did:imajin:abc123")).toBe(true);
    expect(validateDid("did:imajin:6JSKE52ySFid2x7ejUEw6VV1NyJA1idfVKpg3We9b5Nc")).toBe(true);
    expect(validateDid("did:imajin:dm:abc123")).toBe(true);
  });

  it("rejects invalid DID formats", () => {
    expect(validateDid("not-a-did")).toBe(false);
    expect(validateDid("did:other:abc")).toBe(false);
    expect(validateDid("")).toBe(false);
    expect(validateDid("did:imajin:")).toBe(false);
  });
});

describe("ImajinClient attestation + media content", () => {
  let client: ImajinClient;

  beforeEach(() => {
    client = new ImajinClient({ nodeUrl: BASE_URL, did: "did:imajin:test" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getAttestations hits /auth/api/attestations with subject_did and normalizes rows", async () => {
    global.fetch = mockFetch({
      attestations: [
        {
          id: "att_1",
          type: "identity.verified",
          issuer_did: "did:imajin:issuer",
          subject_did: "did:imajin:subject",
          payload: { foo: "bar" },
          signature: "deadbeef",
          issued_at: "2026-08-05T00:00:00Z",
        },
      ],
    });
    const result = await client.getAttestations("did:imajin:subject");
    const [req] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    // Endpoint fix: /auth/api/attestations (NOT /registry/api/attestations, which 404s).
    expect(req).toBe(`${BASE_URL}/auth/api/attestations?subject_did=did%3Aimajin%3Asubject`);
    expect(result).toEqual([
      {
        id: "att_1",
        type: "identity.verified",
        issuer: "did:imajin:issuer",
        subject: "did:imajin:subject",
        claim: { foo: "bar" },
        signature: "deadbeef",
        timestamp: "2026-08-05T00:00:00Z",
      },
    ]);
  });

  it("getAttestations falls back to the queried subject when a row omits subject_did", async () => {
    global.fetch = mockFetch({ attestations: [{ id: "att_2", type: "t" }] });
    const result = await client.getAttestations("cid:Qm123");
    expect(result[0].subject).toBe("cid:Qm123");
  });

  it("createAttestation POSTs to /auth/api/attestations", async () => {
    global.fetch = mockFetch({ id: "att_3" });
    await client.createAttestation({
      type: "t",
      issuer: "did:imajin:issuer",
      subject: "did:imajin:subject",
      claim: {},
    });
    const [req, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(req).toBe(`${BASE_URL}/auth/api/attestations`);
    expect(init.method).toBe("POST");
  });

  it("updateMediaContent PUTs { content } to the asset content route", async () => {
    global.fetch = mockFetch({ ok: true, id: "asset_9", versionCount: 2, cid: "Qm...", updatedAt: "2026-08-05T00:00:00Z" });
    const result = await client.updateMediaContent("asset_9", "new body");
    expect(result).toEqual({ ok: true, id: "asset_9", versionCount: 2, cid: "Qm...", updatedAt: "2026-08-05T00:00:00Z" });
    const [req, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(req).toBe(`${BASE_URL}/media/api/assets/asset_9/content`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ content: "new body" });
  });
});

describe("ImajinClient Warp dispatch (#1428 / #1619)", () => {
  let client: ImajinClient;
  const ACTING = "did:imajin:owner";

  beforeEach(() => {
    // No keypairPath => authHeaders skips the challenge flow; delegation via actAs.
    client = new ImajinClient({ nodeUrl: BASE_URL, did: "did:imajin:agent", actAs: ACTING });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatchWarp POSTs the input to /warp/api/dispatch", async () => {
    const run = { runId: "r1", state: "QUEUED", sessionLink: null, title: null, configName: "owner-jin" };
    global.fetch = mockFetch(run, 201);
    const result = await client.dispatchWarp({ prompt: "do the thing", skillSpec: "ima-jin/x:y" });
    expect(result).toEqual(run);
    const [req, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(req).toBe(`${BASE_URL}/warp/api/dispatch`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ prompt: "do the thing", skillSpec: "ima-jin/x:y" });
    // Delegation header presents the acting principal to the kernel gate.
    expect((init.headers as Record<string, string>)["X-Acting-For"]).toBe(ACTING);
  });

  it("getWarpRun GETs /warp/api/runs/:runId", async () => {
    const run = { runId: "r2", state: "SUCCEEDED", sessionLink: "https://app.warp.dev/x", title: "t", configName: "owner-jin" };
    global.fetch = mockFetch(run);
    const result = await client.getWarpRun("r2");
    expect(result).toEqual(run);
    const [req, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(req).toBe(`${BASE_URL}/warp/api/runs/r2`);
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("sealWarpKey POSTs the key to /warp/api/seal", async () => {
    global.fetch = mockFetch({ ok: true }, 201);
    await client.sealWarpKey("wk_secret");
    const [req, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(req).toBe(`${BASE_URL}/warp/api/seal`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ agentKey: "wk_secret" });
  });

  it("dispatchWarp propagates a kernel 403 (missing grant) as a thrown error", async () => {
    global.fetch = mockFetch({ error: "forbidden" }, 403);
    await expect(client.dispatchWarp({ prompt: "x" })).rejects.toThrow(/403/);
  });

  it("dispatchWarp forwards conversationId/parentRunId (#1939)", async () => {
    const run = { runId: "r1", state: "QUEUED", sessionLink: null, title: null, configName: "owner-jin" };
    global.fetch = mockFetch(run, 201);
    await client.dispatchWarp({
      prompt: "do the thing",
      conversationId: "conv-123",
      parentRunId: "run-parent-1",
    });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: "do the thing",
      conversationId: "conv-123",
      parentRunId: "run-parent-1",
    });
  });
});

describe("ImajinClient Warp post-dispatch run control (#1639, plugin surface #1)", () => {
  let client: ImajinClient;
  const ACTING = "did:imajin:owner";

  beforeEach(() => {
    client = new ImajinClient({ nodeUrl: BASE_URL, did: "did:imajin:agent", actAs: ACTING });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cancelWarpRun POSTs to /warp/api/runs/:runId/cancel with no body fields", async () => {
    const ack = { runId: "r1", cancelled: true as const };
    global.fetch = mockFetch(ack);
    const result = await client.cancelWarpRun("r1");
    expect(result).toEqual(ack);

    const [req, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(req).toBe(`${BASE_URL}/warp/api/runs/r1/cancel`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Acting-For"]).toBe(ACTING);
  });

  it("cancelWarpRun URL-encodes the runId", async () => {
    global.fetch = mockFetch({ runId: "r/1", cancelled: true });
    await client.cancelWarpRun("r/1");
    const [req] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(req).toBe(`${BASE_URL}/warp/api/runs/r%2F1/cancel`);
  });

  it("cancelWarpRun propagates a kernel 409 (still PENDING) as a thrown error", async () => {
    global.fetch = mockFetch({ error: "pending" }, 409);
    await expect(client.cancelWarpRun("r1")).rejects.toThrow(/409/);
  });

  it("sendWarpFollowup POSTs { message } to /warp/api/runs/:runId/followups", async () => {
    const ack = { runId: "r1", accepted: true as const };
    global.fetch = mockFetch(ack, 202);
    const result = await client.sendWarpFollowup("r1", { message: "keep going" });
    expect(result).toEqual(ack);

    const [req, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(req).toBe(`${BASE_URL}/warp/api/runs/r1/followups`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ message: "keep going" });
  });

  it("sendWarpFollowup includes mode when provided", async () => {
    global.fetch = mockFetch({ runId: "r1", accepted: true }, 202);
    await client.sendWarpFollowup("r1", { message: "switch to plan", mode: "plan" });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ message: "switch to plan", mode: "plan" });
  });

  it("sendWarpFollowup includes resume when provided (#1939)", async () => {
    global.fetch = mockFetch({ runId: "r1", accepted: true }, 202);
    await client.sendWarpFollowup("r1", { message: "keep going", resume: true });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ message: "keep going", resume: true });
  });

  it("sendWarpFollowup omits resume entirely when not provided", async () => {
    global.fetch = mockFetch({ runId: "r1", accepted: true }, 202);
    await client.sendWarpFollowup("r1", { message: "keep going" });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ message: "keep going" });
  });

  it("listWarpRuns GETs /warp/api/runs with no query when no filters given", async () => {
    const page = { runs: [], hasNextPage: false, nextCursor: null };
    global.fetch = mockFetch(page);
    const result = await client.listWarpRuns();
    expect(result).toEqual(page);
    const [req, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(req).toBe(`${BASE_URL}/warp/api/runs`);
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("listWarpRuns encodes filters as query params, repeating state per entry", async () => {
    global.fetch = mockFetch({ runs: [], hasNextPage: false, nextCursor: null });
    await client.listWarpRuns({
      name: "owner-jin",
      states: ["QUEUED", "INPROGRESS"],
      environmentId: "env_1",
      createdAfter: "2026-08-01T00:00:00Z",
      limit: 50,
      cursor: "cur_1",
    });
    const [req] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = new URL(req as string);
    expect(url.pathname).toBe("/warp/api/runs");
    expect(url.searchParams.get("name")).toBe("owner-jin");
    expect(url.searchParams.getAll("state")).toEqual(["QUEUED", "INPROGRESS"]);
    expect(url.searchParams.get("environmentId")).toBe("env_1");
    expect(url.searchParams.get("createdAfter")).toBe("2026-08-01T00:00:00Z");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("cursor")).toBe("cur_1");
  });

  it("getWarpRunTranscript GETs /warp/api/runs/:runId/transcript", async () => {
    const transcript = { runId: "r1", content: "hello", contentType: "text/plain", truncated: false };
    global.fetch = mockFetch(transcript);
    const result = await client.getWarpRunTranscript("r1");
    expect(result).toEqual(transcript);
    const [req, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(req).toBe(`${BASE_URL}/warp/api/runs/r1/transcript`);
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("getWarpRunTranscript appends maxChars when provided", async () => {
    global.fetch = mockFetch({ runId: "r1", content: "", contentType: null, truncated: false });
    await client.getWarpRunTranscript("r1", { maxChars: 500 });
    const [req] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(req).toBe(`${BASE_URL}/warp/api/runs/r1/transcript?maxChars=500`);
  });

  it("listWarpRuns encodes ancestorRunId as a query param (#1939)", async () => {
    global.fetch = mockFetch({ runs: [], hasNextPage: false, nextCursor: null });
    await client.listWarpRuns({ ancestorRunId: "run-ancestor-1" });
    const [req] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = new URL(req as string);
    expect(url.searchParams.get("ancestorRunId")).toBe("run-ancestor-1");
  });
});
