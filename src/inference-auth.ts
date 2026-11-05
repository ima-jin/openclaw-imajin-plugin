import { randomBytes } from "node:crypto";
import { validAgentConfig, type AgentIdentity } from "./agent-identities.js";

const AUDIENCE = "imajin:apps";
const REFRESH_SKEW_MS = 60_000;

export class InferenceAuthError extends Error {
  constructor(agentId: string, detail: string, readonly status?: number) {
    super(`Imajin inference agents.${agentId}: ${detail}`);
    this.name = "InferenceAuthError";
  }
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

export interface InferenceCredential {
  token: string;
  expiresAt: number;
}

interface TokenEntry {
  identity: AgentIdentity;
  cached?: InferenceCredential;
  pending?: Promise<InferenceCredential>;
}

/** Tokens never enter provider config, diagnostics or the gateway client/session. */
export class AgentInferenceAuth {
  private readonly entries = new Map<string, TokenEntry>();

  constructor(
    private readonly nodeUrl: string | undefined,
    private readonly getIdentity: (agentId: string) => AgentIdentity | undefined,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = Date.now,
  ) {}

  identity(agentId: string | undefined): AgentIdentity {
    if (!agentId || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)) {
      throw new InferenceAuthError("<agentId>", "calling agentId is required; configure agents.<id>");
    }
    const identity = this.getIdentity(agentId);
    if (!identity || !validAgentConfig(agentId, identity.config)
      || identity.signer.did !== identity.config.did) {
      throw new InferenceAuthError(agentId, "identity unavailable; configure did, sealed keypair and valid actAs");
    }
    return identity;
  }

  async credential(agentId: string, rejectedToken?: string): Promise<InferenceCredential> {
    const identity = this.identity(agentId);
    const { did, actAs } = identity.config;
    const key = JSON.stringify([did, actAs ?? null, AUDIENCE]);
    let entry = this.entries.get(key);
    if (entry?.identity !== identity) {
      entry = { identity };
      this.entries.set(key, entry);
    }
    // A late 401 must not evict a newer credential minted by another call.
    if (rejectedToken && entry.cached?.token === rejectedToken) entry.cached = undefined;
    if ((entry.cached?.expiresAt ?? 0) - REFRESH_SKEW_MS > this.now()) return entry.cached!;
    const current = entry;
    current.pending ??= this.mint(agentId, identity).then((credential) => {
      if (this.identity(agentId) !== identity || this.entries.get(key) !== current) {
        throw new InferenceAuthError(agentId, "identity runtime changed during token mint");
      }
      current.cached = credential;
      return credential;
    }).finally(() => { current.pending = undefined; });
    return current.pending;
  }

  clear(): void {
    this.entries.clear();
  }
  /** Evict only the consenting agent, including any old in-flight mint. */
  forget(agentId: string): void {
    const identity = this.identity(agentId);
    this.entries.delete(JSON.stringify([identity.config.did, identity.config.actAs ?? null, AUDIENCE]));
  }

  /** Same caller/key/token path as inference; never a gateway session cookie. */
  async discoverSelf(agentId: string): Promise<unknown> {
    const identity = this.identity(agentId);
    try {
      const credential = await this.credential(agentId);
      if (this.identity(agentId) !== identity) throw new Error("Identity changed");
      const response = await this.fetcher(`${trimTrailingSlashes(this.nodeUrl!)}/infer/v1/self`, {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${credential.token}`,
          "Cache-Control": "no-store",
          ...(identity.config.actAs ? { "x-acting-as": identity.config.actAs } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new InferenceAuthError(agentId, "self-discovery refused", response.status);
      }
      const body: unknown = await response.json();
      if (this.identity(agentId) !== identity) throw new Error("Identity changed");
      return body;
    } catch (error) {
      if (error instanceof InferenceAuthError) throw error;
      throw new InferenceAuthError(agentId, "self-discovery unavailable");
    }
  }

  invalidate(agentId: string, token: string): void {
    const identity = this.identity(agentId);
    const entry = this.entries.get(JSON.stringify([identity.config.did, identity.config.actAs ?? null, AUDIENCE]));
    if (entry?.cached?.token === token) entry.cached = undefined;
  }

  private async mint(agentId: string, identity: AgentIdentity): Promise<InferenceCredential> {
    if (!this.nodeUrl) throw new InferenceAuthError(agentId, "nodeUrl is required");
    const appDid = identity.config.did;
    // The kernel verifies assignments from the agent's own subject context.
    // actAs is carried only as x-acting-as by the stream wrapper, never as sub.
    const principalDid = appDid;
    try {
      const nonce = randomBytes(16).toString("hex");
      const timestamp = new Date(this.now()).toISOString();
      const signature = await identity.signer.signChallenge(`${appDid}:${principalDid}:${nonce}:${timestamp}`);
      const response = await this.fetcher(`${trimTrailingSlashes(this.nodeUrl)}/auth/api/apps/token`, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appDid, principalDid, scope: "infer:completions", nonce, timestamp, signature }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new InferenceAuthError(agentId, "app-token mint refused; requires this agent's app registration and self-context app.authorized grant", response.status);
      }
      const minted = await response.json() as { token?: unknown; expiresIn?: unknown; scopes?: unknown };
      return validateMintedCredential(minted, appDid, this.now());
    } catch (error) {
      if (error instanceof InferenceAuthError) throw error;
      // Fetch, JSON and secret-provider errors can echo credentials. Never retain causes.
      throw new InferenceAuthError(agentId, "app-token mint unavailable or invalid response");
    }
  }
}

function validateMintedCredential(
  minted: { token?: unknown; expiresIn?: unknown; scopes?: unknown },
  appDid: string, now: number,
): InferenceCredential {
  if (typeof minted?.token !== "string" || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(minted.token)
    || typeof minted.expiresIn !== "number" || !Number.isFinite(minted.expiresIn) || minted.expiresIn <= 0
    || !Array.isArray(minted.scopes) || !minted.scopes.every((scope) => typeof scope === "string")
    || !minted.scopes.includes("infer:completions")) {
    throw new Error("Invalid mint response");
  }
  const [head, payload] = minted.token.split(".");
  const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (header?.typ !== "app+jwt" || header.alg !== "EdDSA"
    || claims?.azp !== appDid || claims.sub !== appDid || claims.aud !== AUDIENCE
    || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now) {
    throw new Error("Invalid agent app token");
  }
  // Signature verification/authorization remains with the kernel, not decoded claims.
  return { token: minted.token, expiresAt: Math.min(claims.exp * 1000, now + minted.expiresIn * 1000) };
}
