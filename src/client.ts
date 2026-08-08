/**
 * Imajin Node API client.
 *
 * Authenticates via Ed25519 challenge-response (no API keys).
 * Signs challenges with the agent's keypair to get a session cookie.
 */

import { readFile } from "node:fs/promises";

const DID_PATTERN = /^did:imajin:[A-Za-z0-9:_-]+$/;

export function validateDid(did: string): boolean {
  return DID_PATTERN.test(did);
}

export interface ImajinClientConfig {
  nodeUrl: string;
  did?: string;
  keypairPath?: string;
  actAs?: string;
}

interface Keypair {
  did: string;
  publicKey: string;
  publicKeyHex: string;
  privateKey: string;
}

export interface ImajinIdentity {
  did: string;
  handle?: string;
  scope: string;
  subtype: string;
  displayName?: string;
  tier?: string;
}

export interface ImajinAttestation {
  id: string;
  type: string;
  issuer: string;
  subject: string;
  claim: Record<string, unknown>;
  signature: string;
  timestamp: string;
}

export interface ImajinTransaction {
  id: string;
  amount: number;
  currency: string;
  from: string;
  to: string;
  fairManifest?: FairManifest;
  timestamp: string;
}

export interface FairManifest {
  shares: Array<{
    did: string;
    label: string;
    amount: number;
    percentage: number;
  }>;
  fees: Array<{
    type: string;
    amount: number;
    recipient: string;
  }>;
}

export interface SearchResult {
  did: string;
  type: string;
  displayName?: string;
  handle?: string;
  scope: string;
  subtype: string;
  relevance: number;
}

export interface MediaAsset {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  hash: string;
  createdAt: string;
  classification?: string;
}

// --- Warp Cloud Agent dispatch (#1428 / #1619) ---

/** A per-server MCP config passed through to Warp verbatim (Warp owns the schema). */
export interface WarpMcpServer {
  url: string;
  headers?: Record<string, string>;
}

/**
 * Input for a Warp cloud-agent dispatch. Mirrors the kernel `/warp/api/dispatch`
 * body. Only `prompt` is required; everything else is optional passthrough.
 */
export interface WarpDispatchInput {
  prompt: string;
  title?: string;
  /** Overrides the `{username}-jin` run tag. */
  name?: string;
  modelId?: string;
  basePrompt?: string;
  environmentId?: string;
  /** Versioned SKILL.md as the agent payload, e.g. "owner/repo:skill". */
  skillSpec?: string;
  /** Map keyed by server name (NOT an array), per Warp's schema. */
  mcpServers?: Record<string, WarpMcpServer>;
  /** Attach the OAuth-protected mcp.imajin.ai server (defaults off server-side). */
  attachImajinMcp?: boolean;
  computerUseEnabled?: boolean;
}

/** A Warp cloud-agent run as surfaced by the kernel (lifecycle + link, never the key). */
export interface WarpAgentRun {
  runId: string;
  state: string;
  sessionLink: string | null;
  title: string | null;
  configName: string | null;
}

export class ImajinClient {
  private baseUrl: string;
  private did?: string;
  private keypairPath?: string;
  private actAs?: string;
  private keypair?: Keypair;
  private sessionCookie?: string;
  private sessionExpiresAt?: number;

  constructor(config: ImajinClientConfig) {
    this.baseUrl = config.nodeUrl.replace(/\/$/, "");
    this.did = config.did;
    this.keypairPath = config.keypairPath;
    this.actAs = config.actAs;
  }

  // --- Auth ---

  /**
   * Load the Ed25519 keypair from the configured path.
   */
  private async loadKeypair(): Promise<Keypair> {
    if (this.keypair) return this.keypair;
    if (!this.keypairPath) {
      throw new Error("No keypairPath configured — cannot authenticate");
    }
    const raw = await readFile(this.keypairPath, "utf-8");
    const parsed = JSON.parse(raw);
    // Support both flat { did, privateKey, publicKey } and
    // nested { did, keypair: { privateKey, publicKey } } formats
    this.keypair = {
      did: parsed.did,
      publicKey: parsed.publicKey || parsed.keypair?.publicKey || "",
      publicKeyHex: parsed.publicKeyHex || parsed.keypair?.publicKey || "",
      privateKey: parsed.privateKey || parsed.keypair?.privateKey || "",
    };
    // Derive DID from keypair if not explicitly set
    if (!this.did) {
      this.did = this.keypair.did;
    }
    return this.keypair;
  }

  /**
   * Sign a hex-encoded challenge with the agent's Ed25519 private key.
   * Uses @noble/ed25519 (same as the Imajin server).
   */
  private async signChallenge(challengeHex: string, privateKeyHex: string): Promise<string> {
    // Dynamic import — @noble/ed25519 is ESM
    const ed = await import("@noble/ed25519");
    const { sha512 } = await import("@noble/hashes/sha2.js");

    // Configure sha512 sync (same as server)
    // Configure sha512 — v2+: ed.hashes.sha512, v1: ed.etc.sha512Sync
    if ("hashes" in ed && ed.hashes) {
      (ed.hashes as any).sha512 = sha512;
    } else {
      try {
        ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
      } catch {}
    }

    const messageBytes = new TextEncoder().encode(challengeHex);
    const privKeyBytes = hexToBytes(privateKeyHex);
    const signature = await ed.signAsync(messageBytes, privKeyBytes);
    return bytesToHex(signature);
  }

  /**
   * Authenticate with the Imajin node via challenge-response.
   * 1. POST /auth/api/login/challenge with our DID
   * 2. Sign the challenge with our private key
   * 3. POST /auth/api/login/verify with challengeId + signature
   * 4. Extract session cookie from response
   */
  async authenticate(): Promise<void> {
    // Skip if session is still valid (with 5 min buffer)
    if (
      this.sessionCookie &&
      this.sessionExpiresAt &&
      Date.now() < this.sessionExpiresAt - 300_000
    ) {
      return;
    }

    const keypair = await this.loadKeypair();

    // Step 1: Request challenge
    const challengeRes = await fetch(`${this.baseUrl}/auth/api/login/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: keypair.did }),
    });

    if (!challengeRes.ok) {
      const err = await challengeRes.text();
      throw new Error(`Auth challenge failed (${challengeRes.status}): ${err}`);
    }

    const { challengeId, challenge, expiresAt } = (await challengeRes.json()) as {
      challengeId: string;
      challenge: string;
      expiresAt: string;
    };

    // Step 2: Sign the challenge
    const signature = await this.signChallenge(challenge, keypair.privateKey);

    // Step 3: Verify signature
    const verifyRes = await fetch(`${this.baseUrl}/auth/api/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId, signature }),
    });

    if (!verifyRes.ok) {
      const err = await verifyRes.text();
      throw new Error(`Auth verify failed (${verifyRes.status}): ${err}`);
    }

    // Step 4: Extract session cookie
    const setCookie = verifyRes.headers.get("set-cookie");
    if (setCookie) {
      // Extract the session token from set-cookie header
      const match = setCookie.match(/([^=]+)=([^;]+)/);
      if (match) {
        this.sessionCookie = `${match[1]}=${match[2]}`;
      }
    }

    // Session expires when the challenge would have expired (5 min),
    // but the JWT likely has a longer TTL. Refresh conservatively.
    this.sessionExpiresAt = new Date(expiresAt).getTime() + 3600_000; // assume 1hr session
  }

  /**
   * Ensure we're authenticated, then return headers with session cookie.
   */
  private async authHeaders(opts?: { onBehalfOf?: string }): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.keypairPath) {
      await this.authenticate();
      if (this.sessionCookie) {
        headers["Cookie"] = this.sessionCookie;
      }
    }
    if (this.did) {
      headers["X-Agent-DID"] = this.did;
    }
    // "self" sentinel suppresses actAs for this one call — the request
    // authenticates as the agent's bare session with no delegation header.
    // This is authoring-as-self, not a delegation (#1545).
    const delegationTarget = opts?.onBehalfOf === "self"
      ? undefined
      : (opts?.onBehalfOf ?? this.actAs);
    if (delegationTarget) {
      if (!validateDid(delegationTarget)) {
        throw new Error(`Invalid DID format for onBehalfOf: ${delegationTarget}`);
      }
      headers["X-Acting-For"] = delegationTarget;
    }
    return headers;
  }

  // --- Identity ---

  async lookupIdentity(query: string): Promise<ImajinIdentity | null> {
    const res = await this.get(`/registry/api/identity/lookup?q=${encodeURIComponent(query)}`);
    return ((res as Record<string, unknown>).identity as ImajinIdentity) ?? null;
  }

  async getIdentity(did: string): Promise<ImajinIdentity | null> {
    const res = await this.get(`/registry/api/identity/${encodeURIComponent(did)}`);
    return ((res as Record<string, unknown>).identity as ImajinIdentity) ?? null;
  }

  async getConnections(did: string): Promise<ImajinIdentity[]> {
    const res = await this.get(`/connections/api/connections/${encodeURIComponent(did)}`);
    return ((res as Record<string, unknown>).connections as ImajinIdentity[]) ?? [];
  }

  // --- Attestation ---

  /**
   * List attestations for a subject.
   *
   * Endpoint is `/auth/api/attestations` (NOT `/registry/api/attestations` — that
   * route does not exist and 404s). The query param is `subject_did`, and the server
   * returns rows keyed `subject_did`/`issuer_did`; we normalize to the client's
   * `subject`/`issuer` shape. `subject_did` is NOT DID-validated server-side, so a
   * raw CID string is an accepted subject (this is what makes attest-to-CID work).
   */
  async getAttestations(subject: string): Promise<ImajinAttestation[]> {
    const res = await this.get(
      `/auth/api/attestations?subject_did=${encodeURIComponent(subject)}`,
    );
    const rows = ((res as Record<string, unknown>).attestations as Record<string, unknown>[]) ?? [];
    return rows.map((r) => ({
      id: (r.id as string) ?? "",
      type: (r.type as string) ?? "",
      issuer: (r.issuer_did as string) ?? (r.issuerDid as string) ?? "",
      subject: (r.subject_did as string) ?? (r.subjectDid as string) ?? subject,
      claim: (r.payload as Record<string, unknown>) ?? (r.claim as Record<string, unknown>) ?? {},
      signature: (r.signature as string) ?? "",
      timestamp:
        (r.issued_at as string) ?? (r.issuedAt as string) ?? (r.timestamp as string) ?? "",
    }));
  }

  /**
   * Create an attestation.
   *
   * ⚠️ NOT a simple POST. The server (`POST /auth/api/attestations`) requires a body
   * of `{ issuer_did, subject_did, type, context_id?, context_type?, payload?, signature,
   * issued_at? }` where `signature` is an Ed25519 hex signature by the ISSUER over
   * `canonicalize({ subject_did, type, context_id, context_type, payload, issued_at })`,
   * verified against the issuer's registered public key. `type` MUST be one of the
   * server's ATTESTATION_TYPES enum. The old body (`{type, issuer:"", subject, claim}`
   * with no signature) 400s. Wiring the client-side signing (mirroring the auth
   * login-challenge signer) is a follow-up; do NOT call this for a real write until then.
   */
  async createAttestation(
    attestation: Omit<ImajinAttestation, "id" | "signature" | "timestamp">,
    onBehalfOf?: string,
  ): Promise<ImajinAttestation> {
    return this.post("/auth/api/attestations", attestation, {
      onBehalfOf,
    }) as Promise<ImajinAttestation>;
  }

  // --- Settlement ---

  async getBalance(did?: string): Promise<{ mjnx: number; mjn: number }> {
    const target = did ?? this.did;
    if (!target) throw new Error("No DID available for balance check");
    const res = await this.get(`/pay/api/balance/${encodeURIComponent(target)}`);
    return (
      ((res as Record<string, unknown>).balance as { mjnx: number; mjn: number }) ?? {
        mjnx: 0,
        mjn: 0,
      }
    );
  }

  async getTransactions(did?: string, limit = 20): Promise<ImajinTransaction[]> {
    const target = did ?? this.did;
    if (!target) throw new Error("No DID available for transaction lookup");
    const res = await this.get(
      `/pay/api/transactions/${encodeURIComponent(target)}?limit=${limit}`,
    );
    return ((res as Record<string, unknown>).transactions as ImajinTransaction[]) ?? [];
  }

  // --- Discovery ---

  async search(query: string, type?: string): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (type) params.set("type", type);
    const res = await this.get(`/registry/api/search?${params}`);
    return ((res as Record<string, unknown>).results as SearchResult[]) ?? [];
  }

  // --- Fair ---

  async getFairManifest(transactionId: string): Promise<FairManifest | null> {
    const res = await this.get(`/pay/api/fair/${encodeURIComponent(transactionId)}`);
    return ((res as Record<string, unknown>).manifest as FairManifest) ?? null;
  }

  // --- Media ---

  /**
   * Upload a file to the Imajin media service.
   * Returns the asset metadata including public URL.
   */
  async uploadMedia(
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
    context?: { app?: string; feature?: string; access?: string },
    onBehalfOf?: string,
  ): Promise<MediaAsset> {
    const headers = await this.authHeaders({ onBehalfOf });
    // Remove Accept header — multipart needs different handling
    delete headers["Accept"];

    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: mimeType });
    formData.append("file", blob, filename);
    if (context) {
      formData.append("context", JSON.stringify(context));
    }

    const res = await fetch(`${this.baseUrl}/media/api/assets`, {
      method: "POST",
      headers: {
        Cookie: headers["Cookie"] || "",
        ...(headers["X-Agent-DID"] ? { "X-Agent-DID": headers["X-Agent-DID"] } : {}),
        ...(headers["X-Acting-For"] ? { "X-Acting-For": headers["X-Acting-For"] } : {}),
      },
      body: formData,
    });

    if (!res.ok) {
      throw new Error(`Media upload failed (${res.status}): ${await res.text()}`);
    }

    return (await res.json()) as MediaAsset;
  }

  /**
   * List media assets for the authenticated agent (or a specific DID).
   */
  async listMedia(opts?: {
    search?: string;
    type?: string;
    limit?: number;
    offset?: number;
    onBehalfOf?: string;
  }): Promise<{ assets: MediaAsset[]; count: number }> {
    const params = new URLSearchParams();
    if (opts?.search) params.set("search", opts.search);
    if (opts?.type) params.set("type", opts.type);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const res = await this.get(`/media/api/assets?${params}`, { onBehalfOf: opts?.onBehalfOf });
    const data = res as Record<string, unknown>;
    return {
      assets: (data.assets as MediaAsset[]) ?? [],
      count: (data.count as number) ?? 0,
    };
  }

  /**
   * Get a single media asset by ID.
   *
   * The `/media/api/assets/[id]` route renders an HTML article page for text/article
   * assets (it ignores `Accept: application/json`), so a blind `res.json()` throws on the
   * `<!DOCTYPE html>` body. We therefore fetch raw and branch on content-type:
   *  - JSON  -> parse and return the asset object.
   *  - HTML  -> a renderable text/article asset; surface a minimal descriptor and point
   *             callers at getMediaContent() / the /content endpoint for the body.
   * Errors are NO LONGER swallowed into `null` -- a real auth/permission/transport failure
   * now throws with the upstream status, instead of masquerading as "not found". (A genuine
   * 404 is the only thing that yields null.)
   */
  async getMedia(assetId: string, onBehalfOf?: string): Promise<MediaAsset | null> {
    const path = `/media/api/assets/${encodeURIComponent(assetId)}`;
    const { status, contentType, text } = await this.getRawResponse(path, { onBehalfOf });
    if (status === 404) return null;
    if (status < 200 || status >= 300) {
      throw new Error(`Imajin API ${status} fetching ${path}: ${text.slice(0, 300)}`);
    }
    if (contentType.includes("application/json")) {
      return JSON.parse(text) as MediaAsset;
    }
    // HTML render (text/article asset). Return a descriptor; the body lives at /content.
    return {
      id: assetId,
      mediaType: "text",
      renderedHtml: true,
      note: "Text/article asset: HTML render returned. Use getMediaContent() (the /content endpoint) for the raw body.",
    } as unknown as MediaAsset;
  }

  /**
   * Read the raw content body of a text asset (`GET /media/api/assets/[id]/content`,
   * returns `{ content: "..." }`). This is the correct endpoint for reading the actual
   * text of an article/essay/document asset, since the base asset route returns HTML.
   */
  async getMediaContent(assetId: string, onBehalfOf?: string): Promise<{ content: string }> {
    return this.get(`/media/api/assets/${encodeURIComponent(assetId)}/content`, {
      onBehalfOf,
    }) as Promise<{ content: string }>;
  }

  /**
   * Overwrite the text content of an EXISTING asset in place
   * (`PUT /media/api/assets/[id]/content`, body `{ content }`, owner-only).
   *
   * The asset id is a STABLE ALIAS for one logical artifact: each call mints a
   * new content hash + CID + Lore revision + re-signed `.fair` and bumps
   * versionCount, all under the SAME asset id. This is how you version a
   * document without minting orphan asset ids — create ONCE (uploadMedia),
   * then update forward with this method. Text/* only (server 415s on binary).
   */
  async updateMediaContent(
    assetId: string,
    content: string,
    onBehalfOf?: string,
  ): Promise<{ ok: boolean; id?: string; versionCount?: number; cid?: string; updatedAt?: string }> {
    return this.put(`/media/api/assets/${encodeURIComponent(assetId)}/content`, { content }, {
      onBehalfOf,
    }) as Promise<{
      ok: boolean;
      id?: string;
      versionCount?: number;
      cid?: string;
      updatedAt?: string;
    }>;
  }

  /**
   * Transcribe an audio/video asset via Whisper. Owner-gated; runs server-side on the LAN.
   * Transcript is pinned to asset.metadata.transcript. Re-calls return cached result.
   */
  async transcribeMedia(assetId: string, onBehalfOf?: string): Promise<Record<string, unknown>> {
    // NOTE: prod route is exported as GET (see kernel transcribe/route.ts); existing UI
    // callers (AssetDetail, useVoiceRecording) use GET. Skill doc-comment says POST —
    // tracked mismatch. Call GET to match deployed behavior.
    return this.get(`/media/api/assets/${encodeURIComponent(assetId)}/transcribe`, { onBehalfOf });
  }

  /**
   * Move an asset to a folder (replaces all folder assignments).
   */
  async moveMediaToFolder(
    assetId: string,
    folderId: string,
    onBehalfOf?: string,
  ): Promise<{ assetId: string; folderIds: string[] }> {
    return this.put(
      `/media/api/assets/${encodeURIComponent(assetId)}/folders`,
      {
        folderIds: [folderId],
      },
      { onBehalfOf },
    ) as Promise<{ assetId: string; folderIds: string[] }>;
  }

  /**
   * Set the access level on an asset's .fair manifest.
   * NOTE: Kernel endpoint PATCH /media/api/assets/[id]/access may not exist yet.
   */
  async setMediaAccess(
    assetId: string,
    access: "public" | "private" | "conversation",
    onBehalfOf?: string,
  ): Promise<MediaAsset> {
    return this.patch(
      `/media/api/assets/${encodeURIComponent(assetId)}/access`,
      {
        access,
      },
      { onBehalfOf },
    ) as Promise<MediaAsset>;
  }

  /**
   * Grant access to a specific DID on an asset (adds to .fair manifest allowedDids).
   */
  async grantMediaAccess(assetId: string, did: string, onBehalfOf?: string): Promise<MediaAsset> {
    return this.patch(
      `/media/api/assets/${encodeURIComponent(assetId)}/grants`,
      { add: [did] },
      { onBehalfOf },
    ) as Promise<MediaAsset>;
  }

  /**
   * Revoke access from a specific DID on an asset (removes from .fair manifest allowedDids).
   */
  async revokeMediaAccess(assetId: string, did: string, onBehalfOf?: string): Promise<MediaAsset> {
    return this.patch(
      `/media/api/assets/${encodeURIComponent(assetId)}/grants`,
      { remove: [did] },
      { onBehalfOf },
    ) as Promise<MediaAsset>;
  }

  /**
   * Publish an asset as an article (adds metadata.article block).
   * NOTE: Kernel endpoint PATCH /media/api/assets/[id]/article may not exist yet.
   */
  async publishMediaAsArticle(
    assetId: string,
    articleMeta: {
      slug: string;
      title: string;
      subtitle?: string;
      description?: string;
      status?: "POSTED" | "REVIEW" | "DRAFT";
    },
    onBehalfOf?: string,
  ): Promise<MediaAsset> {
    return this.patch(`/media/api/assets/${encodeURIComponent(assetId)}/article`, articleMeta, {
      onBehalfOf,
    }) as Promise<MediaAsset>;
  }

  // --- HTTP helpers (public for chat/other modules) ---

  async getRaw(path: string, opts?: { onBehalfOf?: string }): Promise<Record<string, unknown>> {
    return this.get(path, opts);
  }

  async postRaw(
    path: string,
    body: unknown,
    opts?: { onBehalfOf?: string },
  ): Promise<Record<string, unknown>> {
    return this.post(path, body, opts);
  }

  // --- Warp Cloud Agent dispatch (#1428 / #1619) ---

  /**
   * Dispatch a Warp cloud agent as the acting principal. Routes to the kernel
   * `POST /warp/api/dispatch`; the kernel resolves the acting DID, enforces the
   * `warp:dispatch` grant, and unwraps that principal's sealed Warp Agent key.
   * This method carries NO authority of its own — it presents the delegation
   * (via authHeaders `X-Acting-For`) and the kernel adjudicates. A missing grant
   * fails 403, a missing/revoked key fails 409 — surfaced as thrown errors.
   */
  async dispatchWarp(input: WarpDispatchInput, onBehalfOf?: string): Promise<WarpAgentRun> {
    return this.post(`/warp/api/dispatch`, input, { onBehalfOf }) as Promise<WarpAgentRun>;
  }

  /** Read a Warp run's lifecycle state + session link. Gated by the same grant as dispatch. */
  async getWarpRun(runId: string, onBehalfOf?: string): Promise<WarpAgentRun> {
    return this.get(`/warp/api/runs/${encodeURIComponent(runId)}`, {
      onBehalfOf,
    }) as Promise<WarpAgentRun>;
  }

  /**
   * Seal a Warp Agent API key for the acting principal as a v2 delegation-grant
   * vault field (`POST /warp/api/seal`). Owner-authored key material — the key is
   * never logged, echoed, or returned. Prefer having the owner seal directly; this
   * exists so the flow is scriptable end-to-end when the owner delegates it.
   */
  async sealWarpKey(agentKey: string, onBehalfOf?: string): Promise<Record<string, unknown>> {
    return this.post(`/warp/api/seal`, { secret: agentKey }, { onBehalfOf });
  }

  // --- Intention inference (#1620 / the app-as-inference-engine primitive) ---

  /**
   * Capture a gesture (audio/photo/file) and run the kernel's intention-inference
   * pipeline as the acting principal. Routes to `POST /api/inference/capture`
   * (multipart). The kernel resolves the acting DID, runs
   * capture -> context(transcribe/telemetry) -> infer(LLM) -> consent gate, and
   * this is the seam where `policy.ts:getModel()` resolves the principal's sealed
   * `gemini:infer` credential (falling back to env only when unsealed).
   *
   * This method carries NO authority of its own -- it presents the delegation
   * (via authHeaders `X-Acting-For`) and the kernel adjudicates.
   *
   * Returns `{ sessionId, assetId, status, candidateIntents? }`. `status` is
   * `'resolved'` for silent intents (done) or `'pending_confirm'` for deliberate
   * intents -- which REQUIRE an explicit `confirmInference` call (the human's tap
   * IS the consent gate; nothing is sent/spent/disclosed without it).
   */
  async captureInference(
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
    vocabulary = "imajin",
    onBehalfOf?: string,
  ): Promise<Record<string, unknown>> {
    const headers = await this.authHeaders({ onBehalfOf });
    // Remove Accept header -- multipart needs different handling.
    delete headers["Accept"];

    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: mimeType });
    formData.append("file", blob, filename);
    formData.append("vocabulary", vocabulary);
    formData.append("filename", filename);

    const res = await fetch(`${this.baseUrl}/api/inference/capture`, {
      method: "POST",
      headers: {
        Cookie: headers["Cookie"] || "",
        ...(headers["X-Agent-DID"] ? { "X-Agent-DID": headers["X-Agent-DID"] } : {}),
        ...(headers["X-Acting-For"] ? { "X-Acting-For": headers["X-Acting-For"] } : {}),
      },
      body: formData,
    });

    if (!res.ok) {
      throw new Error(`Inference capture failed (${res.status}): ${await res.text()}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * The human deliberate-consent tap for a `pending_confirm` session. Routes to
   * `POST /api/inference/confirm/:sessionId`; advances the session
   * `pending_confirm -> resolving -> resolved` and returns the attestation.
   *
   * ONLY call this on an explicit human confirmation of a deliberate intent --
   * this call IS the consent event.
   */
  async confirmInference(sessionId: string, onBehalfOf?: string): Promise<Record<string, unknown>> {
    return this.post(`/api/inference/confirm/${encodeURIComponent(sessionId)}`, {}, { onBehalfOf });
  }

  /**
   * List the acting principal's recent inference sessions
   * (`GET /api/inference/sessions`).
   */
  async listInferenceSessions(onBehalfOf?: string): Promise<Record<string, unknown>> {
    return this.get(`/api/inference/sessions`, { onBehalfOf });
  }

  private async get(
    path: string,
    opts?: { onBehalfOf?: string },
  ): Promise<Record<string, unknown>> {
    const headers = await this.authHeaders(opts);
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    if (!res.ok) {
      throw new Error(`Imajin API ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Low-level authenticated GET that does NOT assume a JSON body. Returns the raw
   * status, content-type, and text so callers can branch on content-type (e.g. routes
   * that render HTML for some asset kinds). Does not throw on non-2xx -- the caller
   * decides how to handle status. Use this instead of get() when a route may return
   * HTML, and never swallow the result into a bland null.
   *
   * NB: distinct from the existing public getRaw() (a JSON passthrough); this one is
   * content-type-agnostic and returns the unparsed response.
   */
  private async getRawResponse(
    path: string,
    opts?: { onBehalfOf?: string },
  ): Promise<{ status: number; contentType: string; text: string }> {
    const headers = await this.authHeaders(opts);
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      text: await res.text(),
    };
  }

  private async post(
    path: string,
    body: unknown,
    opts?: { onBehalfOf?: string },
  ): Promise<Record<string, unknown>> {
    const headers = await this.authHeaders(opts);
    headers["Content-Type"] = "application/json";
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Imajin API ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  private async put(
    path: string,
    body: unknown,
    opts?: { onBehalfOf?: string },
  ): Promise<Record<string, unknown>> {
    const headers = await this.authHeaders(opts);
    headers["Content-Type"] = "application/json";
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Imajin API ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  private async patch(
    path: string,
    body: unknown,
    opts?: { onBehalfOf?: string },
  ): Promise<Record<string, unknown>> {
    const headers = await this.authHeaders(opts);
    headers["Content-Type"] = "application/json";
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Imajin API ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }
}

// --- Hex utilities (same as Imajin server) ---

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
