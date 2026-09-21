/**
 * Kernel contract for the `imajin_vault` tool — plugin half of the remote
 * human -> agent credential handoff (`ima-jin/openclaw-imajin-plugin#40`;
 * kernel half `ima-jin/imajin-ai#2231`).
 *
 * ALL kernel route paths + wire shapes for the grant-fetch flow live in this
 * ONE module so a follow-up PR (once `ima-jin/imajin-ai#2231` actually lands
 * and its real routes/shapes are known) can re-point them here without
 * touching `../tools.ts` or `./secret-handle-store.ts` at all.
 *
 * At the time this was written, no `ima-jin/imajin-ai#2231` PR existed yet,
 * so the contract below is an ASSUMPTION (see this repo's PR body's "Wire
 * contract" section for the exact assumed paths/shapes):
 *
 *   GET  /auth/api/grants/mine?purpose=<string>&status=active
 *     -> { grants: [{ grantId, ownerDid, purpose, expiresAt, oneTime,
 *                      consumedAt, createdAt }] }   (metadata only, ever)
 *   POST /auth/api/grants/{grantId}/fetch
 *     -> { value, contentType?, oneTime, expiresAt }
 *        403 grant not scoped to this agent DID
 *        404 unknown/revoked grant
 *        410 one-time grant already consumed
 *   POST /auth/api/grants/{grantId}/consume
 *     -> { consumedAt }   (idempotent)
 *
 * Every function here authenticates via the SAME `ImajinClient` challenge-
 * response session every other tool uses (`client.requestRaw`, which reuses
 * `authHeaders`/`X-Acting-For`) — there is no separate auth path for vault
 * grants.
 *
 * Value-safety invariant: NONE of the functions below ever put a raw
 * upstream response body into a thrown error message. A non-2xx status is
 * mapped to one of a small, fixed set of value-free messages
 * (`errorForStatus`) — this is what keeps a kernel 500 (or any other
 * unexpected body) from ever leaking through an error message, a tool
 * result, or a log line.
 */
import type { ImajinClient } from "../client.js";

/** One grant's metadata, as surfaced by `GET /auth/api/grants/mine`. Never carries a value. */
export interface VaultGrantMeta {
  grantId: string;
  ownerDid: string;
  purpose: string;
  expiresAt: string;
  oneTime: boolean;
  consumedAt: string | null;
  createdAt: string;
}

/** The sealed value + its metadata, as surfaced by `POST /auth/api/grants/{grantId}/fetch`. */
export interface VaultGrantValue {
  value: string;
  contentType?: string;
  oneTime: boolean;
  expiresAt: string;
}

/** Result of `POST /auth/api/grants/{grantId}/consume`. */
export interface VaultConsumeResult {
  consumedAt: string;
}

export type VaultErrorCode =
  | "grant_not_found"
  | "grant_not_for_this_agent"
  | "grant_already_consumed"
  | "vault_request_failed";

/** A clear, value-free error for every vault kernel-request failure mode. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

const GRANTS_MINE_PATH = "/auth/api/grants/mine";
const grantFetchPath = (grantId: string): string =>
  `/auth/api/grants/${encodeURIComponent(grantId)}/fetch`;
const grantConsumePath = (grantId: string): string =>
  `/auth/api/grants/${encodeURIComponent(grantId)}/consume`;

/**
 * Maps a non-2xx status to a value-free `VaultError`. Deliberately never
 * accepts or embeds the response body — see module doc's "Value-safety
 * invariant".
 */
function errorForStatus(status: number, action: string): VaultError {
  switch (status) {
    case 403:
      return new VaultError("grant_not_for_this_agent", "Grant is not scoped to this agent DID.");
    case 404:
      return new VaultError("grant_not_found", "Grant not found or revoked.");
    case 410:
      return new VaultError("grant_already_consumed", "One-time grant has already been consumed.");
    default:
      return new VaultError("vault_request_failed", `Vault ${action} request failed (${status}).`);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * List grants issued to the authenticated agent DID, optionally filtered by
 * `purpose`. Metadata only — the kernel route never returns values, and
 * this function passes the response through as-is (no value field exists
 * to accidentally forward).
 */
export async function listGrantsMine(
  client: ImajinClient,
  opts: { purpose?: string; onBehalfOf?: string } = {},
): Promise<VaultGrantMeta[]> {
  const params = new URLSearchParams({ status: "active" });
  if (opts.purpose) params.set("purpose", opts.purpose);
  const { status, text } = await client.requestRaw(`${GRANTS_MINE_PATH}?${params.toString()}`, {
    onBehalfOf: opts.onBehalfOf,
  });
  if (status < 200 || status >= 300) throw errorForStatus(status, "list_grants");
  const parsed = safeJsonParse(text) as { grants?: unknown } | null;
  return Array.isArray(parsed?.grants) ? (parsed!.grants as VaultGrantMeta[]) : [];
}

/**
 * Fetches the sealed value for a grant. Callers MUST immediately hand the
 * returned `value` to `secret-handle-store.ts`'s `createSecretHandle` and
 * never let it reach a tool result, a log line, or a rethrown error — this
 * function itself never logs or wraps the value in anything other than the
 * plain returned object.
 */
export async function fetchGrantValue(
  client: ImajinClient,
  grantId: string,
  opts: { onBehalfOf?: string } = {},
): Promise<VaultGrantValue> {
  const { status, text } = await client.requestRaw(grantFetchPath(grantId), {
    method: "POST",
    body: {},
    onBehalfOf: opts.onBehalfOf,
  });
  if (status < 200 || status >= 300) throw errorForStatus(status, "fetch");
  const parsed = safeJsonParse(text) as Partial<VaultGrantValue> | null;
  if (!parsed || typeof parsed.value !== "string") {
    // Deliberately does not include `text` — a malformed 2xx body is still
    // never an acceptable place to leak whatever the kernel actually sent.
    throw new VaultError("vault_request_failed", "Vault fetch response was missing a value.");
  }
  return {
    value: parsed.value,
    ...(typeof parsed.contentType === "string" ? { contentType: parsed.contentType } : {}),
    oneTime: parsed.oneTime === true,
    expiresAt:
      typeof parsed.expiresAt === "string" ? parsed.expiresAt : new Date(Date.now() + 900_000).toISOString(),
  };
}

/** Marks a one-time grant consumed. Idempotent on the kernel side. */
export async function consumeGrant(
  client: ImajinClient,
  grantId: string,
  opts: { onBehalfOf?: string } = {},
): Promise<VaultConsumeResult> {
  const { status, text } = await client.requestRaw(grantConsumePath(grantId), {
    method: "POST",
    body: {},
    onBehalfOf: opts.onBehalfOf,
  });
  if (status < 200 || status >= 300) throw errorForStatus(status, "ack_consumed");
  const parsed = safeJsonParse(text) as Partial<VaultConsumeResult> | null;
  return {
    consumedAt: typeof parsed?.consumedAt === "string" ? parsed.consumedAt : new Date().toISOString(),
  };
}
