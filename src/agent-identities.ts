import { join } from "node:path";
import { homedir } from "node:os";
import type { SecretRef } from "openclaw/plugin-sdk/secret-input-runtime";
import { ImajinClient, validateDid, type ImajinSigner } from "./client.js";
import type { WsNotificationsConfig } from "./notification-injector.js";
import type { WarpToolConfig } from "./tools.js";

export const AGENT_TOOL_NAMES = [
  "imajin_status", "imajin_identity", "imajin_attest", "imajin_transact",
  "imajin_fair", "imajin_discover", "imajin_media", "imajin_warp",
  "imajin_infer", "imajin_usage", "imajin_vault", "imajin_cloudflare",
  "imajin_chat", "imajin_wake_report",
] as const;

export interface AgentIdentityConfig {
  did: string;
  keypair: SecretRef;
  actAs?: string;
  /** Omitted permits all primitive tools; [] permits none. */
  tools?: string[];
  warp?: WarpToolConfig;
  wsNotifications?: WsNotificationsConfig;
}

export interface AgentIdentity {
  config: AgentIdentityConfig;
  client: ImajinClient;
}

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Kernel key-backed DIDs are did:imajin:base58(publicKey), not config labels. */
export function publicKeyDid(publicKey: string): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = BigInt(`0x${publicKey}`);
  let encoded = "";
  while (number > 0n) {
    encoded = alphabet[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  const leadingZeros = /^(?:00)*/.exec(publicKey)?.[0].length ?? 0;
  return `did:imajin:${"1".repeat(leadingZeros / 2)}${encoded}`;
}

/** Only sealed store / vault-backed exec providers, never inline/env/file keys. */
export function isSealedKeyRef(value: unknown): value is SecretRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return Object.keys(ref).every((key) => ["source", "provider", "id"].includes(key))
    && (ref.source === "store" || ref.source === "exec")
    && typeof ref.provider === "string" && ref.provider.trim().length > 0
    && typeof ref.id === "string" && ref.id.trim().length > 0;
}

export function validAgentConfig(agentId: string, value: unknown): value is AgentIdentityConfig {
  if (!AGENT_ID.test(agentId) || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).every((key) => ["did", "keypair", "actAs", "tools", "warp", "wsNotifications"].includes(key))
    && typeof entry.did === "string" && validateDid(entry.did)
    && isSealedKeyRef(entry.keypair)
    && (entry.actAs === undefined || (typeof entry.actAs === "string" && validateDid(entry.actAs)))
    && (entry.tools === undefined || (Array.isArray(entry.tools)
      && entry.tools.every((name) => AGENT_TOOL_NAMES.includes(name))
      && new Set(entry.tools).size === entry.tools.length));
}

/** Resolve once per service start; catch at the caller without logging SDK errors/values. */
export async function resolveAgentSigner(
  config: unknown, ref: SecretRef, did: string,
): Promise<ImajinSigner> {
  if (!isSealedKeyRef(ref)) throw new Error("Sealed identity reference required");
  const { resolveSecretRefValues } = await import("openclaw/plugin-sdk/secret-ref-runtime");
  const resolved = await resolveSecretRefValues([ref], { config, env: process.env });
  if (resolved.size !== 1) throw new Error("Identity reference unavailable");
  const raw = resolved.values().next().value;
  return signerFromValue(raw, did);
}

/** Validate private material without allowing parser/provider diagnostics to escape. */
export async function signerFromValue(raw: unknown, did: string): Promise<ImajinSigner> {
  try {
    return await parseSigner(raw, did);
  } catch {
    throw new Error("Identity keypair unavailable");
  }
}

async function parseSigner(raw: unknown, did: string): Promise<ImajinSigner> {
  const key = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (key?.did !== did || !/^[a-f0-9]{64}$/i.test(key.privateKey)
    || !/^[a-f0-9]{64}$/i.test(key.publicKey)) {
    throw new Error("Identity reference does not match configured DID/keypair");
  }
  if (publicKeyDid(key.publicKey) !== did) throw new Error("Identity public key does not match DID");
  const ed = await import("@noble/ed25519");
  const privateBytes = Buffer.from(key.privateKey, "hex");
  const publicBytes = await ed.getPublicKeyAsync(privateBytes);
  if (Buffer.from(publicBytes).toString("hex") !== key.publicKey.toLowerCase()) {
    privateBytes.fill(0);
    throw new Error("Identity reference public key mismatch");
  }
  return {
    did,
    signChallenge: async (challenge) =>
      Buffer.from(await ed.signAsync(new TextEncoder().encode(challenge), privateBytes)).toString("hex"),
  };
}

/** Never merges top-level identity, targets, reports, approvals, or state into an agent. */
export function agentNotifications(agentId: string, config: AgentIdentityConfig): WsNotificationsConfig {
  const notifications = config.wsNotifications;
  const scope = (key: string) => `agent:${agentId}:${key.replace(/^agent:[^:]*:/, "")}`;
  const targetSession = scope(notifications?.targetSession?.trim() || `agent:${agentId}:warp-events`);
  const stateRoot = notifications?.stateDir ?? join(homedir(), ".openclaw", "imajin-agents");
  return {
    ...notifications,
    targetSession,
    wakeSessionKey: scope(notifications?.wakeSessionKey?.trim() || targetSession),
    hookAgentId: agentId,
    stateDir: join(stateRoot, agentId),
  };
}

export class AgentIdentities {
  private readonly identities = new Map<string, AgentIdentity>();

  async prepare(
    nodeUrl: string,
    agents: Record<string, AgentIdentityConfig>,
    hostConfig: unknown,
    resolveSigner = resolveAgentSigner,
    active = () => true,
  ): Promise<void> {
    this.identities.clear();
    // Do not let two configured agents share a DID or reference accidentally.
    const didCounts = new Map<string, number>();
    const refCounts = new Map<string, number>();
    const entries = Object.entries(agents).filter(([id, entry]) => validAgentConfig(id, entry));
    const refKey = (entry: AgentIdentityConfig) => JSON.stringify([entry.keypair.source, entry.keypair.provider, entry.keypair.id]);
    for (const [, entry] of entries) {
      didCounts.set(entry.did, (didCounts.get(entry.did) ?? 0) + 1);
      refCounts.set(refKey(entry), (refCounts.get(refKey(entry)) ?? 0) + 1);
    }
    for (const [id, entry] of entries) {
      if (didCounts.get(entry.did) !== 1 || refCounts.get(refKey(entry)) !== 1) continue;
      try {
        const signer = await resolveSigner(hostConfig, entry.keypair, entry.did);
        if (!active()) return;
        this.identities.set(id, {
          config: entry,
          client: new ImajinClient({ nodeUrl, did: entry.did, actAs: entry.actAs, signer }),
        });
      } catch {
        // Provider errors can contain secret values. Deliberately value-free.
        console.warn("[imajin-plugin] agent identity unavailable; tools disabled");
      }
    }
  }

  get(agentId: string | undefined): AgentIdentity | undefined {
    return agentId ? this.identities.get(agentId) : undefined;
  }

  entries(): IterableIterator<[string, AgentIdentity]> {
    return this.identities.entries();
  }

  clear(): void {
    this.identities.clear();
  }
}
