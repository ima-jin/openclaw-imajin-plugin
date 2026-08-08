import { writeFileSync, unlinkSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ImajinChat } from "./chat.js";
import type { ImajinClient } from "./client.js";
import { createMediaTool, createAttestTool, createChatTool } from "./tools.js";

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
