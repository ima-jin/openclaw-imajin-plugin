/**
 * Imajin Chat client.
 *
 * Send and receive messages on the Imajin network.
 * Uses the DID-keyed conversation API (v2).
 */

import { createHash } from "node:crypto";
import type { ImajinClient } from "./client.js";

export interface ChatMessage {
  id: string;
  conversationDid: string;
  fromDid: string;
  content: { type: string; text: string } | string;
  contentType: string;
  replyToMessageId?: string | null;
  replyToDid?: string | null;
  mediaType?: string | null;
  mediaPath?: string | null;
  mediaAssetId?: string | null;
  mediaMeta?: Record<string, unknown> | null;
  signature?: string | null;
  createdAt: string;
  reactions?: Array<{ emoji: string; did: string }>;
}

export interface Conversation {
  did: string;
  name: string;
  createdBy: string;
  lastMessageAt?: string;
}

/**
 * Derive a stable DM conversation DID from two party DIDs.
 * Same algorithm as the Imajin server: sort, join with ':', SHA-256, take first 16 hex chars.
 */
export function dmDid(did1: string, did2: string): string {
  const sorted = [did1, did2].sort();
  const hash = createHash("sha256").update(sorted.join(":")).digest("hex").slice(0, 16);
  return `did:imajin:dm:${hash}`;
}

export class ImajinChat {
  constructor(
    private client: ImajinClient,
    private agentDid: string,
  ) {}

  /**
   * Send a text message to a DID-keyed conversation.
   */
  async sendMessage(
    conversationDid: string,
    text: string,
    opts?: {
      replyToMessageId?: string;
      recipientDid?: string;
      onBehalfOf?: string;
    },
  ): Promise<ChatMessage> {
    // Ensure authenticated
    await this.client.authenticate();

    const body: Record<string, unknown> = {
      content: { type: "text", text },
      contentType: "text",
    };
    if (opts?.replyToMessageId) {
      body.replyToMessageId = opts.replyToMessageId;
    }
    if (opts?.recipientDid) {
      body.recipientDid = opts.recipientDid;
    }

    const res = await this.client.postRaw(
      `/chat/api/d/${encodeURIComponent(conversationDid)}/messages`,
      body,
      { onBehalfOf: opts?.onBehalfOf },
    );
    return res.message as ChatMessage;
  }

  /**
   * Send a DM to another DID. Derives the conversation DID automatically.
   */
  async sendDM(
    recipientDid: string,
    text: string,
    replyToMessageId?: string,
    onBehalfOf?: string,
  ): Promise<ChatMessage> {
    const convDid = dmDid(this.agentDid, recipientDid);
    return this.sendMessage(convDid, text, { replyToMessageId, recipientDid, onBehalfOf });
  }

  /**
   * Get messages from a conversation. Returns newest first.
   */
  async getMessages(
    conversationDid: string,
    opts?: { limit?: number; before?: string },
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    await this.client.authenticate();

    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.before) params.set("before", opts.before);

    const res = await this.client.getRaw(
      `/chat/api/d/${encodeURIComponent(conversationDid)}/messages?${params}`,
    );
    return {
      messages: (res.messages as ChatMessage[]) ?? [],
      hasMore: (res.hasMore as boolean) ?? false,
    };
  }

  /**
   * Get DM messages with a specific DID.
   */
  async getDMs(
    recipientDid: string,
    opts?: { limit?: number; before?: string },
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const convDid = dmDid(this.agentDid, recipientDid);
    return this.getMessages(convDid, opts);
  }

  /**
   * List all conversations the agent participates in.
   */
  async listConversations(): Promise<Conversation[]> {
    await this.client.authenticate();
    const res = await this.client.getRaw("/chat/api/conversations");
    return (res.conversations as Conversation[]) ?? [];
  }

  /**
   * Mark a conversation as read up to now.
   */
  async markRead(conversationDid: string): Promise<void> {
    await this.client.authenticate();
    await this.client.postRaw(`/chat/api/d/${encodeURIComponent(conversationDid)}/read`, {});
  }

  /**
   * Send a media message (image, audio, etc.) to a conversation.
   */
  async sendMedia(
    conversationDid: string,
    assetId: string,
    caption?: string,
    opts?: { recipientDid?: string; onBehalfOf?: string },
  ): Promise<ChatMessage> {
    await this.client.authenticate();

    const body: Record<string, unknown> = {
      content: { type: "media", text: caption || "" },
      contentType: "media",
      mediaAssetId: assetId,
    };
    if (opts?.recipientDid) {
      body.recipientDid = opts.recipientDid;
    }

    const res = await this.client.postRaw(
      `/chat/api/d/${encodeURIComponent(conversationDid)}/messages`,
      body,
      { onBehalfOf: opts?.onBehalfOf },
    );
    return res.message as ChatMessage;
  }
}
