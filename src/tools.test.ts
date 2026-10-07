import { writeFileSync, unlinkSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ImajinChat } from "./chat.js";
import type { ImajinClient } from "./client.js";
import { ImajinCatalogCache, ImajinDiscoveryError } from "./imajin-provider.js";
import {
  createMediaTool,
  createAttestTool,
  createChatTool,
  createWarpTool,
  createUsageTool,
  createImajinStatusTool,
} from "./tools.js";

function makeMockClient(): ImajinClient {
  return {
    uploadMedia: vi.fn(),
    listMedia: vi.fn(),
    getMedia: vi.fn(),
    moveMediaToFolder: vi.fn(),
    setMediaAccess: vi.fn(),
    grantMediaAccess: vi.fn(),
    publishMediaAsArticle: vi.fn(),
  } as unknown as ImajinClient;
}

describe("imajin_media tool", () => {
  let client: ReturnType<typeof makeMockClient>;
  let tool: ReturnType<typeof createMediaTool>;

  beforeEach(() => {
    client = makeMockClient();
    tool = createMediaTool(client as unknown as ImajinClient);
  });

  it("supports move-to-folder action", async () => {
    vi.mocked(client.moveMediaToFolder).mockResolvedValue({
      assetId: "asset_123",
      folderIds: ["folder_456"],
    });
    const result = await tool.execute("1", {
      action: "move-to-folder",
      assetId: "asset_123",
      folderId: "folder_456",
    });
    expect(client.moveMediaToFolder).toHaveBeenCalledWith("asset_123", "folder_456", undefined);
    expect(JSON.parse(result.content[0].text)).toEqual({
      assetId: "asset_123",
      folderIds: ["folder_456"],
    });
  });

  it("move-to-folder requires assetId and folderId", async () => {
    const r1 = await tool.execute("1", { action: "move-to-folder" } as never);
    expect(r1.content[0].text).toMatch(/assetId.*required/i);

    const r2 = await tool.execute("1", { action: "move-to-folder", assetId: "a" } as never);
    expect(r2.content[0].text).toMatch(/folderId.*required/i);
  });

  it("supports set-access action", async () => {
    vi.mocked(client.setMediaAccess).mockResolvedValue({
      id: "asset_123",
      access: { type: "public" },
    } as never);
    const result = await tool.execute("1", {
      action: "set-access",
      assetId: "asset_123",
      access: "public",
    });
    expect(client.setMediaAccess).toHaveBeenCalledWith("asset_123", "public", undefined);
    expect(JSON.parse(result.content[0].text).access.type).toBe("public");
  });

  it("set-access requires assetId and access", async () => {
    const r1 = await tool.execute("1", { action: "set-access" } as never);
    expect(r1.content[0].text).toMatch(/assetId.*required/i);

    const r2 = await tool.execute("1", { action: "set-access", assetId: "a" } as never);
    expect(r2.content[0].text).toMatch(/access.*required/i);
  });

  it("supports grant-access action", async () => {
    vi.mocked(client.grantMediaAccess).mockResolvedValue({
      id: "asset_123",
      allowedDids: ["did:imajin:other"],
    } as never);
    const result = await tool.execute("1", {
      action: "grant-access",
      assetId: "asset_123",
      did: "did:imajin:other",
    });
    expect(client.grantMediaAccess).toHaveBeenCalledWith(
      "asset_123",
      "did:imajin:other",
      undefined,
    );
    expect(JSON.parse(result.content[0].text).allowedDids).toContain("did:imajin:other");
  });

  it("grant-access requires assetId and did", async () => {
    const r1 = await tool.execute("1", { action: "grant-access" } as never);
    expect(r1.content[0].text).toMatch(/assetId.*required/i);

    const r2 = await tool.execute("1", { action: "grant-access", assetId: "a" } as never);
    expect(r2.content[0].text).toMatch(/did.*required/i);
  });

  it("supports publish-as-article action", async () => {
    vi.mocked(client.publishMediaAsArticle).mockResolvedValue({
      id: "asset_123",
      metadata: { article: { slug: "hello", title: "Hello World" } },
    } as never);
    const result = await tool.execute("1", {
      action: "publish-as-article",
      assetId: "asset_123",
      slug: "hello",
      title: "Hello World",
      subtitle: "A test article",
      description: "Desc",
      status: "DRAFT",
    });
    expect(client.publishMediaAsArticle).toHaveBeenCalledWith(
      "asset_123",
      {
        slug: "hello",
        title: "Hello World",
        subtitle: "A test article",
        description: "Desc",
        status: "DRAFT",
      },
      undefined,
    );
    expect(JSON.parse(result.content[0].text).metadata.article.slug).toBe("hello");
  });

  it("publish-as-article defaults status to POSTED", async () => {
    vi.mocked(client.publishMediaAsArticle).mockResolvedValue({ id: "asset_123" } as never);
    await tool.execute("1", {
      action: "publish-as-article",
      assetId: "asset_123",
      slug: "hello",
      title: "Hello",
    });
    expect(client.publishMediaAsArticle).toHaveBeenCalledWith(
      "asset_123",
      {
        slug: "hello",
        title: "Hello",
        status: "POSTED",
      },
      undefined,
    );
  });

  it("publish-as-article requires assetId, slug, and title", async () => {
    const r1 = await tool.execute("1", { action: "publish-as-article" } as never);
    expect(r1.content[0].text).toMatch(/assetId.*required/i);

    const r2 = await tool.execute("1", { action: "publish-as-article", assetId: "a" } as never);
    expect(r2.content[0].text).toMatch(/slug.*required/i);

    const r3 = await tool.execute("1", {
      action: "publish-as-article",
      assetId: "a",
      slug: "s",
    } as never);
    expect(r3.content[0].text).toMatch(/title.*required/i);
  });

  it("includes document, outreach, article, essay in context enum", () => {
    const contextProp = tool.parameters.properties.context;
    expect(contextProp.enum).toContain("document");
    expect(contextProp.enum).toContain("outreach");
    expect(contextProp.enum).toContain("article");
    expect(contextProp.enum).toContain("essay");
  });

  it("media upload with onBehalfOf passes to client", async () => {
    // Create a temporary file for readFile to succeed
    const tmpPath = "/tmp/imajin-test-upload.txt";
    writeFileSync(tmpPath, "test-content");

    vi.mocked(client.uploadMedia).mockResolvedValue({
      id: "asset_789",
      url: "https://example.com/asset",
      filename: "imajin-test-upload.txt",
      mimeType: "text/plain",
      size: 12,
      hash: "abc",
      createdAt: "2026-01-01T00:00:00Z",
    });

    await tool.execute("1", {
      action: "upload",
      path: tmpPath,
      onBehalfOf: "did:imajin:principal123",
    });
    expect(client.uploadMedia).toHaveBeenCalledWith(
      expect.any(Buffer),
      "imajin-test-upload.txt",
      "text/plain",
      undefined,
      "did:imajin:principal123",
    );

    // Cleanup
    try {
      unlinkSync(tmpPath);
    } catch {}
  });

  it("media upload with invalid DID returns error without calling client", async () => {
    const result = await tool.execute("1", {
      action: "upload",
      path: "/tmp/test.txt",
      onBehalfOf: "not-a-did",
    });
    expect(result.content[0].text).toMatch(/Invalid DID format/);
    expect(client.uploadMedia).not.toHaveBeenCalled();
  });

  it("read-only actions do not have onBehalfOf requirement", async () => {
    vi.mocked(client.listMedia).mockResolvedValue({ assets: [], count: 0 });
    const result = await tool.execute("1", { action: "list" });
    // Should succeed without onBehalfOf — read actions work fine
    expect(result.content[0].text).toMatch(/No media assets found/);
  });

  it("move-to-folder passes onBehalfOf to client", async () => {
    vi.mocked(client.moveMediaToFolder).mockResolvedValue({
      assetId: "asset_123",
      folderIds: ["folder_456"],
    });
    await tool.execute("1", {
      action: "move-to-folder",
      assetId: "asset_123",
      folderId: "folder_456",
      onBehalfOf: "did:imajin:delegated",
    });
    expect(client.moveMediaToFolder).toHaveBeenCalledWith(
      "asset_123",
      "folder_456",
      "did:imajin:delegated",
    );
  });
});

describe("imajin_attest tool with onBehalfOf", () => {
  it("create passes onBehalfOf to client", async () => {
    const mockClient = {
      getAttestations: vi.fn(),
      createAttestation: vi.fn().mockResolvedValue({
        id: "att_1",
        type: "test",
        issuer: "did:imajin:agent",
        subject: "did:imajin:target",
        claim: { verified: true },
        signature: "sig",
        timestamp: "2026-01-01T00:00:00Z",
      }),
    } as unknown as ImajinClient;
    const tool = createAttestTool(mockClient);

    await tool.execute("1", {
      action: "create",
      did: "did:imajin:target",
      type: "test",
      claim: { verified: true },
      onBehalfOf: "did:imajin:principal",
    });
    expect(mockClient.createAttestation).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "did:imajin:target" }),
      "did:imajin:principal",
    );
  });
});

describe("imajin_warp tool post-dispatch control (#1639, plugin surface #1)", () => {
  function makeMockWarpClient(): ImajinClient {
    return {
      dispatchWarp: vi.fn(),
      getWarpRun: vi.fn(),
      cancelWarpRun: vi.fn(),
      sendWarpFollowup: vi.fn(),
      listWarpRuns: vi.fn(),
      getWarpRunTranscript: vi.fn(),
      sealWarpKey: vi.fn(),
    } as unknown as ImajinClient;
  }

  let client: ReturnType<typeof makeMockWarpClient>;
  let tool: ReturnType<typeof createWarpTool>;

  beforeEach(() => {
    client = makeMockWarpClient();
    tool = createWarpTool(client as unknown as ImajinClient);
  });

  it("exposes the new actions in the schema enum", () => {
    const actionProp = tool.parameters.properties.action as { enum: string[] };
    expect(actionProp.enum).toEqual(
      expect.arrayContaining(["cancel_run", "send_followup", "list_runs", "get_transcript"]),
    );
  });

  it("cancel_run calls client.cancelWarpRun with runId and onBehalfOf", async () => {
    vi.mocked(client.cancelWarpRun).mockResolvedValue({ runId: "r1", cancelled: true });
    const result = await tool.execute("1", {
      action: "cancel_run",
      runId: "r1",
      onBehalfOf: "did:imajin:principal",
    });
    expect(client.cancelWarpRun).toHaveBeenCalledWith("r1", "did:imajin:principal");
    expect(JSON.parse(result.content[0].text)).toEqual({ runId: "r1", cancelled: true });
  });

  it("cancel_run requires runId", async () => {
    const result = await tool.execute("1", { action: "cancel_run" } as never);
    expect(result.content[0].text).toMatch(/runId.*required|requires 'runId'/i);
    expect(client.cancelWarpRun).not.toHaveBeenCalled();
  });

  it("send_followup calls client.sendWarpFollowup with message and optional mode", async () => {
    vi.mocked(client.sendWarpFollowup).mockResolvedValue({ runId: "r1", accepted: true });
    const result = await tool.execute("1", {
      action: "send_followup",
      runId: "r1",
      message: "keep going",
      mode: "plan",
    });
    expect(client.sendWarpFollowup).toHaveBeenCalledWith(
      "r1",
      { message: "keep going", mode: "plan" },
      undefined,
    );
    expect(JSON.parse(result.content[0].text)).toEqual({ runId: "r1", accepted: true });
  });

  it("send_followup omits mode when not provided", async () => {
    vi.mocked(client.sendWarpFollowup).mockResolvedValue({ runId: "r1", accepted: true });
    await tool.execute("1", { action: "send_followup", runId: "r1", message: "hi" });
    expect(client.sendWarpFollowup).toHaveBeenCalledWith("r1", { message: "hi" }, undefined);
  });

  it("send_followup forwards resume: true (#1939)", async () => {
    vi.mocked(client.sendWarpFollowup).mockResolvedValue({ runId: "r1", accepted: true });
    await tool.execute("1", {
      action: "send_followup",
      runId: "r1",
      message: "keep going",
      resume: true,
    });
    expect(client.sendWarpFollowup).toHaveBeenCalledWith(
      "r1",
      { message: "keep going", resume: true },
      undefined,
    );
  });

  it("send_followup omits resume when not provided", async () => {
    vi.mocked(client.sendWarpFollowup).mockResolvedValue({ runId: "r1", accepted: true });
    await tool.execute("1", { action: "send_followup", runId: "r1", message: "hi" });
    expect(client.sendWarpFollowup).toHaveBeenCalledWith("r1", { message: "hi" }, undefined);
  });

  it("surfaces a terminal-run refusal from the kernel (#1939)", async () => {
    vi.mocked(client.sendWarpFollowup).mockRejectedValue(
      new Error("warp_run_terminal: run has already ended"),
    );
    const result = await tool.execute("1", {
      action: "send_followup",
      runId: "r1",
      message: "keep going",
    });
    expect(result.content[0].text).toMatch(/warp_run_terminal/);
  });

  it("send_followup requires runId and message", async () => {
    const r1 = await tool.execute("1", { action: "send_followup" } as never);
    expect(r1.content[0].text).toMatch(/runId/i);

    const r2 = await tool.execute("1", { action: "send_followup", runId: "r1" } as never);
    expect(r2.content[0].text).toMatch(/message/i);
    expect(client.sendWarpFollowup).not.toHaveBeenCalled();
  });

  it("list_runs calls client.listWarpRuns with the given filters", async () => {
    vi.mocked(client.listWarpRuns).mockResolvedValue({
      runs: [{ runId: "r1", state: "SUCCEEDED", sessionLink: null, title: null, configName: "o-jin" }],
      hasNextPage: false,
      nextCursor: null,
    });
    const result = await tool.execute("1", {
      action: "list_runs",
      name: "o-jin",
      states: ["SUCCEEDED"],
      limit: 10,
    });
    expect(client.listWarpRuns).toHaveBeenCalledWith(
      { name: "o-jin", states: ["SUCCEEDED"], limit: 10 },
      undefined,
    );
    expect(JSON.parse(result.content[0].text).runs).toHaveLength(1);
  });

  it("list_runs reports when there are no runs", async () => {
    vi.mocked(client.listWarpRuns).mockResolvedValue({ runs: [], hasNextPage: false, nextCursor: null });
    const result = await tool.execute("1", { action: "list_runs" });
    expect(result.content[0].text).toMatch(/No Warp runs found/);
  });

  describe("list_runs compact (#72)", () => {
    const fullRun = {
      runId: "r1",
      state: "SUCCEEDED",
      sessionLink: null,
      title: "t",
      configName: "o-jin",
      requestUsage: { inferenceCost: 1.5, computeCost: 0.5, platformCost: null },
      statusMessage: { message: "x".repeat(3000), errorCode: null, retryable: null },
      artifacts: [
        { artifactType: "PULL_REQUEST", createdAt: "2026-10-07T00:00:00Z", data: { url: "https://x" } },
      ],
    };

    it("drops statusMessage and artifact data but keeps the rest", async () => {
      vi.mocked(client.listWarpRuns).mockResolvedValue({
        runs: [fullRun as never],
        hasNextPage: true,
        nextCursor: "cur",
      });
      const result = await tool.execute("1", { action: "list_runs", compact: true, limit: 500 });
      const body = JSON.parse(result.content[0].text);
      expect(body.runs[0]).not.toHaveProperty("statusMessage");
      expect(body.runs[0].artifacts).toEqual([
        { artifactType: "PULL_REQUEST", createdAt: "2026-10-07T00:00:00Z", data: null },
      ]);
      expect(body.runs[0].requestUsage).toEqual(fullRun.requestUsage);
      expect(body.runs[0].runId).toBe("r1");
      expect(body.nextCursor).toBe("cur");
      expect(result.content[0].text.length).toBeLessThan(JSON.stringify(fullRun).length);
    });

    it("does not pass `compact` to the kernel call", async () => {
      vi.mocked(client.listWarpRuns).mockResolvedValue({ runs: [], hasNextPage: false, nextCursor: null });
      await tool.execute("1", { action: "list_runs", compact: true, limit: 5 });
      expect(client.listWarpRuns).toHaveBeenCalledWith({ limit: 5 }, undefined);
    });

    it("is off by default: full runs are returned", async () => {
      vi.mocked(client.listWarpRuns).mockResolvedValue({
        runs: [fullRun as never],
        hasNextPage: false,
        nextCursor: null,
      });
      const result = await tool.execute("1", { action: "list_runs" });
      expect(JSON.parse(result.content[0].text).runs[0]).toEqual(fullRun);
    });

    it("shows more than the default 20-run cap when compact", async () => {
      const runs = Array.from({ length: 30 }, (_, i) => ({ ...fullRun, runId: `r${i}` }));
      vi.mocked(client.listWarpRuns).mockResolvedValue({
        runs: runs as never,
        hasNextPage: false,
        nextCursor: null,
      });
      const compact = await tool.execute("1", { action: "list_runs", compact: true });
      expect(JSON.parse(compact.content[0].text).runs).toHaveLength(30);
      const full = await tool.execute("1", { action: "list_runs" });
      expect(JSON.parse(full.content[0].text).runs).toHaveLength(21); // 20 + truncation marker
    });

    it("exposes compact in the schema", () => {
      expect(tool.parameters.properties.compact).toMatchObject({ type: "boolean" });
    });
  });

  it("list_runs forwards ancestorRunId (#1939)", async () => {
    vi.mocked(client.listWarpRuns).mockResolvedValue({ runs: [], hasNextPage: false, nextCursor: null });
    await tool.execute("1", { action: "list_runs", ancestorRunId: "run-ancestor-1" });
    expect(client.listWarpRuns).toHaveBeenCalledWith(
      { ancestorRunId: "run-ancestor-1" },
      undefined,
    );
  });

  it("get_transcript calls client.getWarpRunTranscript with runId and maxChars", async () => {
    vi.mocked(client.getWarpRunTranscript).mockResolvedValue({
      runId: "r1",
      content: "log output",
      contentType: "text/plain",
      truncated: false,
    });
    const result = await tool.execute("1", { action: "get_transcript", runId: "r1", maxChars: 100 });
    expect(client.getWarpRunTranscript).toHaveBeenCalledWith("r1", { maxChars: 100 }, undefined);
    expect(JSON.parse(result.content[0].text).content).toBe("log output");
  });

  it("get_transcript requires runId", async () => {
    const result = await tool.execute("1", { action: "get_transcript" } as never);
    expect(result.content[0].text).toMatch(/runId/i);
    expect(client.getWarpRunTranscript).not.toHaveBeenCalled();
  });

  it("dispatch forwards conversationId/parentRunId (#1939)", async () => {
    vi.mocked(client.dispatchWarp).mockResolvedValue({
      runId: "r1",
      state: "QUEUED",
      sessionLink: null,
      title: null,
      configName: "o-jin",
    });
    await tool.execute("1", {
      action: "dispatch",
      prompt: "go",
      conversationId: "conv-123",
      parentRunId: "run-parent-1",
    });
    expect(client.dispatchWarp).toHaveBeenCalledWith(
      { prompt: "go", conversationId: "conv-123", parentRunId: "run-parent-1" },
      undefined,
    );
  });
});

describe("imajin_chat tool with onBehalfOf", () => {
  it("send_dm passes onBehalfOf through", async () => {
    const mockChat = {
      sendDM: vi.fn().mockResolvedValue({
        id: "msg_1",
        conversationDid: "did:imajin:dm:abc",
        fromDid: "did:imajin:agent",
        content: { type: "text", text: "hello" },
        contentType: "text",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      getDMs: vi.fn(),
      listConversations: vi.fn(),
      sendMessage: vi.fn(),
      getMessages: vi.fn(),
    } as unknown as ImajinChat;
    const tool = createChatTool(mockChat);

    await tool.execute("1", {
      action: "send_dm",
      to: "did:imajin:recipient",
      text: "hello",
      onBehalfOf: "did:imajin:principal",
    });
    expect(mockChat.sendDM).toHaveBeenCalledWith(
      "did:imajin:recipient",
      "hello",
      undefined,
      "did:imajin:principal",
    );
  });
});

describe("imajin_status tool (#55)", () => {
  const quiet = { info: vi.fn(), warn: vi.fn() };
  const discovery = { modelsUrl: "https://k.example/infer/v1/models/usable", refreshIntervalMs: 300_000 };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: "ok" }) }));
  });

  it("runs one discovery attempt when none has happened yet, and reports ok + imajin/<id> refs", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      object: "list",
      data: [{ id: "grok-4", imajin: { connector: "xai", servable: true } }],
    });
    const cache = new ImajinCatalogCache(fetcher, 60_000, Date.now, quiet);
    const tool = createImajinStatusTool({ baseUrl: "http://127.0.0.1:8787/openai/v1", cache, discovery });

    const result = await tool.execute();
    const body = JSON.parse(result.content[0].text);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(body.lastDiscovery).toMatchObject({ outcome: "ok", modelCount: 1 });
    expect(body.catalog[0]).toMatchObject({ ref: "imajin/grok-4", connector: "xai" });
    expect(body.discovery).toEqual(discovery);
  });

  it("does not refetch when a state already exists, and reports a route-error with its status", async () => {
    const fetcher = vi.fn().mockRejectedValue(new ImajinDiscoveryError("route-error", "GET x returned 404", 404));
    const cache = new ImajinCatalogCache(fetcher, 60_000, Date.now, quiet);
    await cache.refresh();
    const tool = createImajinStatusTool({ baseUrl: "http://127.0.0.1:8787/openai/v1", cache });

    const body = JSON.parse((await tool.execute()).content[0].text);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(body.lastDiscovery).toMatchObject({ outcome: "route-error", httpStatus: 404, modelCount: 0 });
  });

  describe("mcp block (#50)", () => {
    const mcpUrl = "http://127.0.0.1:8787/mcp";
    const okProbe = {
      url: mcpUrl,
      outcome: "ok" as const,
      ok: true,
      toolCount: 3,
      tools: ["google_gmail_get_message", "google_gmail_send", "media_list"],
    };
    const makeCache = () =>
      new ImajinCatalogCache(vi.fn().mockResolvedValue({ data: [] }), 60_000, Date.now, quiet);

    it("omits the mcp block when no mcpUrl is wired (unchanged behaviour)", async () => {
      const tool = createImajinStatusTool({ baseUrl: "http://127.0.0.1:8787/openai/v1", cache: makeCache() });
      const body = JSON.parse((await tool.execute()).content[0].text);
      expect(body.mcp).toBeUndefined();
    });

    it("reports MCP reachability + tool count alongside the model catalog", async () => {
      const probeMcp = vi.fn().mockResolvedValue(okProbe);
      const tool = createImajinStatusTool({
        baseUrl: "http://127.0.0.1:8787/openai/v1",
        cache: makeCache(),
        mcpUrl,
        probeMcp,
        getConfig: () => ({ mcp: { servers: { imajin: { url: mcpUrl, transport: "streamable-http" } } } }),
      });
      const body = JSON.parse((await tool.execute()).content[0].text);
      expect(probeMcp).toHaveBeenCalledWith(mcpUrl);
      expect(body.lastDiscovery).toBeDefined();
      expect(body.mcp).toMatchObject({
        url: mcpUrl,
        reachable: true,
        toolCount: 3,
        googleToolCount: 2,
        registration: { registered: true, name: "imajin" },
        allowlist: { gatedToolsExposed: ["google_gmail_send"] },
      });
    });

    it("survives an unreadable config and a failed probe", async () => {
      const tool = createImajinStatusTool({
        baseUrl: "http://127.0.0.1:8787/openai/v1",
        cache: makeCache(),
        mcpUrl,
        probeMcp: vi.fn().mockResolvedValue({
          url: mcpUrl,
          outcome: "unreachable",
          ok: false,
          error: "ECONNREFUSED",
          toolCount: 0,
          tools: [],
        }),
        getConfig: () => {
          throw new Error("no config");
        },
      });
      const body = JSON.parse((await tool.execute()).content[0].text);
      expect(body.mcp).toMatchObject({
        reachable: false,
        outcome: "unreachable",
        registration: { registered: null },
      });
    });
  });
});

describe("imajin_usage tool (#72, read-only)", () => {
  const PRINCIPAL = "did:imajin:principal";

  function makeMockUsageClient(): ImajinClient {
    return {
      getUsageSummary: vi.fn(),
      getUsageRollup: vi.fn(),
      resolveActingDid: vi.fn(),
    } as unknown as ImajinClient;
  }

  let client: ReturnType<typeof makeMockUsageClient>;
  let tool: ReturnType<typeof createUsageTool>;

  beforeEach(() => {
    client = makeMockUsageClient();
    tool = createUsageTool(client as unknown as ImajinClient);
    vi.useRealTimers();
  });

  it("is read-only: only summary and rollup actions exist", () => {
    const actionProp = tool.parameters.properties.action as { enum: string[] };
    expect(actionProp.enum).toEqual(["summary", "rollup"]);
  });

  it("summary (totals only) calls the kernel once with the range window and onBehalfOf", async () => {
    vi.mocked(client.getUsageSummary).mockResolvedValue({
      incurred: { total: 12.5, byProvider: { anthropic: 10, warp: 2.5 } },
      billed: { total: 9, byVendor: { anthropic: 9 }, bySource: { api: 9 } },
      drift: 3.5,
      currency: "USD",
    });
    const result = await tool.execute("1", {
      action: "summary",
      from: "2026-10-01",
      to: "2026-10-07",
      daily: false,
      onBehalfOf: PRINCIPAL,
    });
    expect(client.getUsageSummary).toHaveBeenCalledTimes(1);
    expect(client.getUsageSummary).toHaveBeenCalledWith("2026-10-01..2026-10-07", PRINCIPAL);
    const body = JSON.parse(result.content[0].text);
    expect(body.totals.incurred.byProvider).toEqual({ anthropic: 10, warp: 2.5 });
    expect(body.totals.incurred.label).toMatch(/^INCURRED/);
    expect(body.totals.billed.byVendor).toEqual({ anthropic: 9 });
    expect(body.totals.billed.label).toMatch(/^BILLED/);
    expect(body.totals.drift).toBe(3.5);
    expect(body).not.toHaveProperty("days");
  });

  it("summary defaults to a per-day breakdown, one single-day window per elapsed day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    vi.mocked(client.getUsageSummary).mockImplementation(async (window: string) => ({
      incurred: { total: window === "2026-10-06..2026-10-06" ? 4 : 0, byProvider: {} },
      billed: { total: 0, byVendor: {}, bySource: {} },
      drift: 0,
    }));
    const result = await tool.execute("1", { action: "summary", from: "2026-10-05" });
    const calledWindows = vi.mocked(client.getUsageSummary).mock.calls.map((c) => c[0]);
    expect(calledWindows).toEqual([
      "2026-10-05..2026-10-07",
      "2026-10-05..2026-10-05",
      "2026-10-06..2026-10-06",
      "2026-10-07..2026-10-07",
    ]);
    const body = JSON.parse(result.content[0].text);
    expect(body.days.map((d: { date: string }) => d.date)).toEqual(["2026-10-06"]);
    expect(body.daysWithNoUsage).toBe(2);
  });

  it("summary with no params reads the current UTC month and never sends a did", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    vi.mocked(client.getUsageSummary).mockResolvedValue({});
    await tool.execute("1", { action: "summary", daily: false });
    expect(client.getUsageSummary).toHaveBeenCalledWith("2026-10-01..2026-10-31", undefined);
  });

  it("summary rejects bad ranges without calling the kernel", async () => {
    const result = await tool.execute("1", { action: "summary", from: "nope" });
    expect(result.content[0].text).toMatch(/Invalid 'from'/);
    expect(result.details).toEqual({ error: true });
    expect(client.getUsageSummary).not.toHaveBeenCalled();
  });

  it("rejects an invalid onBehalfOf DID", async () => {
    const result = await tool.execute("1", { action: "summary", onBehalfOf: "nope" });
    expect(result.content[0].text).toMatch(/Invalid DID format for onBehalfOf/);
    expect(client.getUsageSummary).not.toHaveBeenCalled();
  });

  it("surfaces a kernel 403 (agent not delegated) with a delegation hint", async () => {
    vi.mocked(client.getUsageSummary).mockRejectedValue(
      new Error('Imajin API 403: {"error":"Forbidden - can only access your own usage summary"}'),
    );
    const result = await tool.execute("1", { action: "summary", daily: false });
    expect(result.content[0].text).toMatch(/^Error: Imajin API 403/);
    expect(result.content[0].text).toMatch(/actingFor/);
    expect(result.details).toEqual({ error: true });
  });

  it("surfaces a non-auth kernel error verbatim", async () => {
    vi.mocked(client.getUsageSummary).mockRejectedValue(new Error("Imajin API 500: unavailable"));
    const result = await tool.execute("1", { action: "summary", daily: false });
    expect(result.content[0].text).toBe("Error: Imajin API 500: unavailable");
  });

  it("rollup defaults did to the acting principal", async () => {
    vi.mocked(client.resolveActingDid).mockResolvedValue(PRINCIPAL);
    vi.mocked(client.getUsageRollup).mockResolvedValue({ id: "att_1", type: "usage.rollup" });
    const result = await tool.execute("1", { action: "rollup", day: "2026-10-06" });
    expect(client.resolveActingDid).toHaveBeenCalledWith(undefined);
    expect(client.getUsageRollup).toHaveBeenCalledWith(PRINCIPAL, "2026-10-06", undefined);
    expect(JSON.parse(result.content[0].text).id).toBe("att_1");
  });

  it("rollup honors an explicit did and skips resolution", async () => {
    vi.mocked(client.getUsageRollup).mockResolvedValue({ id: "att_2" });
    await tool.execute("1", { action: "rollup", did: "did:imajin:other", onBehalfOf: PRINCIPAL });
    expect(client.resolveActingDid).not.toHaveBeenCalled();
    expect(client.getUsageRollup).toHaveBeenCalledWith("did:imajin:other", undefined, PRINCIPAL);
  });

  it("rollup validates did and day, and needs a resolvable DID", async () => {
    const badDid = await tool.execute("1", { action: "rollup", did: "nope" });
    expect(badDid.content[0].text).toMatch(/Invalid DID format for did/);
    const badDay = await tool.execute("1", { action: "rollup", did: PRINCIPAL, day: "yesterday" });
    expect(badDay.content[0].text).toMatch(/Invalid day/);
    vi.mocked(client.resolveActingDid).mockResolvedValue(undefined);
    const none = await tool.execute("1", { action: "rollup" });
    expect(none.content[0].text).toMatch(/requires 'did'/);
    expect(client.getUsageRollup).not.toHaveBeenCalled();
  });

  it("rollup surfaces a kernel 404", async () => {
    vi.mocked(client.resolveActingDid).mockResolvedValue(PRINCIPAL);
    vi.mocked(client.getUsageRollup).mockRejectedValue(new Error("Imajin API 404: none"));
    const result = await tool.execute("1", { action: "rollup" });
    expect(result.content[0].text).toMatch(/404/);
  });

  it("rejects an unknown action", async () => {
    const result = await tool.execute("1", { action: "record" });
    expect(result.content[0].text).toMatch(/Unknown action: record/);
  });
});
