/**
 * Kernel contract for the `imajin_vault` tool — plugin half of the remote
 * human -> agent credential handoff (`ima-jin/openclaw-imajin-plugin#40`;
 * kernel half `ima-jin/imajin-ai#2231`, implemented in
 * `ima-jin/imajin-ai` PR #2234, branch `feat/2231-vault-agent-credential-handoff`,
 * commit `85dcd14102d8da66dabef70e3d8ee069d5371d6d`).
 *
 * ALL kernel route paths + wire shapes for the grant-fetch flow live in this
 * ONE module so a future kernel-side contract change only requires editing
 * this file — `../tools.ts` and `./secret-handle-store.ts` never reference a
 * kernel path directly.
 *
 * Confirmed against `ima-jin/imajin-ai` PR #2234
 * (`apps/kernel/app/api/vault/delegation/grants/route.ts` +
 * `apps/kernel/app/api/vault/delegation/grants/[grantId]/fetch/route.ts`):
 *
 *   GET  /api/vault/delegation/grants?purpose=<string>
 *     -> { grants: [{ grantId, subject, field, purpose, oneTime, status,
 *                      expiresAt, consumedAt, createdAt }] }   (metadata only, ever)
 *     no `status` filter param exists — the kernel returns every grant for
 *     the authenticated grantee DID regardless of status.
 *   POST /api/vault/delegation/grants/{grantId}/fetch
 *     -> { ok: true, field, value, purpose, oneTime, expiresAt }
 *        expiresAt may be `null` (no expiry on the grant itself).
 *        404 grant unknown OR belongs to a different agent (deliberately
 *             indistinguishable — anti-enumeration; the kernel's
 *             `not_found`/`not_grantee` outcomes both map to 404)
 *        403 grant inactive, expired, or revoked
 *        410 one-time grant already consumed
 *   There is NO separate consume endpoint: a `oneTime` grant is consumed
 *   atomically inside `fetch` itself (the kernel claims it with a
 *   `consumedAt IS NULL` guard before decrypting), so every fetch after the
 *   first successful one returns 410.
 *
 *   POST /api/vault/delegation/grants/{grantId}/ack   (kernel `imajin-ai#2235`, PR #2236)
 *     body { outcome: 'used'|'failed'|'discarded', note?: string (<=280),
 *            evidence?: { kind: string (<=100), ref: string (<=120) } }
 *     -> { ok: true, grantId, outcome, ackedAt }
 *        Idempotent per grant+outcome (same outcome again -> 200, original ackedAt).
 *        404 grant unknown OR belongs to a different agent (same anti-enumeration as fetch)
 *        409 `grant_not_fetched` (never fetched by this agent) OR `ack_conflict`
 *            (already acked with a DIFFERENT outcome; body carries ackOutcome/ackedAt)
 *        400 invalid body (never reached for input this module validated first)
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

/** One grant's metadata, as surfaced by `GET /api/vault/delegation/grants`. Never carries a value. */
export interface VaultGrantMeta {
  grantId: string;
  subject: string;
  field: string;
  purpose: string | null;
  oneTime: boolean;
  status: string;
  expiresAt: string | null;
  consumedAt: string | null;
  createdAt: string;
}

/** The sealed value + its metadata, as surfaced by `POST /api/vault/delegation/grants/{grantId}/fetch`. */
export interface VaultGrantValue {
  value: string;
  field: string;
  purpose: string | null;
  oneTime: boolean;
  expiresAt: string | null;
}

/** What the agent did with a fetched grant, as recorded by `POST .../ack`. */
export type VaultAckOutcome = "used" | "failed" | "discarded";

export const VAULT_ACK_OUTCOMES: readonly VaultAckOutcome[] = ["used", "failed", "discarded"];

/** Kernel limits for the ack body (`ack/route.ts`); validated client-side so a bad call never leaves the process. */
export const ACK_MAX_NOTE_LENGTH = 280;
export const ACK_MAX_EVIDENCE_KIND_LENGTH = 100;
export const ACK_MAX_EVIDENCE_REF_LENGTH = 120;

/** Free-form pointer to what the agent did with the value, e.g. `{ kind: "gha-runner", ref: "imajin-gx10" }`. Never the value. */
export interface VaultAckEvidence {
  kind: string;
  ref: string;
}

/** Kernel's receipt for a recorded ack. Carries no secret material. */
export interface VaultAckReceipt {
  grantId: string;
  outcome: VaultAckOutcome;
  ackedAt: string | null;
}

export type VaultErrorCode =
  | "grant_not_found"
  | "grant_not_active"
  | "grant_already_consumed"
  | "grant_not_fetched"
  | "ack_conflict"
  | "invalid_ack"
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

const GRANTS_PATH = "/api/vault/delegation/grants";
const grantFetchPath = (grantId: string): string =>
  `/api/vault/delegation/grants/${encodeURIComponent(grantId)}/fetch`;

/**
 * Maps a non-2xx status to a value-free `VaultError`. Deliberately never
 * accepts or embeds the response body — see module doc's "Value-safety
 * invariant".
 *
 * 404 covers BOTH an unknown grantId and a grantId that belongs to a
 * different agent — the kernel deliberately returns the same status for
 * both (anti-enumeration, see module doc). 403 is inactive/expired/revoked.
 */
function errorForStatus(status: number, action: string): VaultError {
  switch (status) {
    case 404:
      return new VaultError("grant_not_found", "Grant not found or not issued to this agent.");
    case 403:
      return new VaultError("grant_not_active", "Grant is inactive, expired, or revoked.");
    case 410:
      return new VaultError("grant_already_consumed", "One-time grant has already been consumed.");
    default:
      return new VaultError("vault_request_failed", `Vault ${action} request failed (${status}).`);
  }
}

const grantAckPath = (grantId: string): string =>
  `/api/vault/delegation/grants/${encodeURIComponent(grantId)}/ack`;

/**
 * Maps a non-2xx ack status to a value-free `VaultError`. The kernel returns
 * 409 for two distinct reasons (`grant_not_fetched`, `ack_conflict`); the body
 * is consulted ONLY to pick between those two fixed codes — it is matched
 * against a whitelist and never copied into the message.
 */
function errorForAckStatus(status: number, text: string): VaultError {
  if (status === 409) {
    const parsed = safeJsonParse(text) as { error?: unknown } | null;
    if (parsed?.error === "grant_not_fetched") {
      return new VaultError("grant_not_fetched", "Grant has not been fetched by this agent; nothing to acknowledge yet.");
    }
    return new VaultError("ack_conflict", "Grant was already acknowledged with a different outcome.");
  }
  return errorForStatus(status, "ack");
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
 * to accidentally forward). There is no `status` filter param on the real
 * route — every grant for the caller is returned regardless of status.
 */
export async function listGrantsMine(
  client: ImajinClient,
  opts: { purpose?: string; onBehalfOf?: string } = {},
): Promise<VaultGrantMeta[]> {
  const params = new URLSearchParams();
  if (opts.purpose) params.set("purpose", opts.purpose);
  const query = params.toString();
  const { status, text } = await client.requestRaw(`${GRANTS_PATH}${query ? `?${query}` : ""}`, {
    onBehalfOf: opts.onBehalfOf,
  });
  if (status < 200 || status >= 300) throw errorForStatus(status, "list_grants");
  const parsed = safeJsonParse(text) as { grants?: unknown } | null;
  return Array.isArray(parsed?.grants) ? (parsed!.grants as VaultGrantMeta[]) : [];
}

/**
 * Fetches the sealed value for a grant, consuming it atomically kernel-side
 * when the grant is `oneTime` (there is no separate consume step — see
 * module doc). Callers MUST immediately hand the returned `value` to
 * `secret-handle-store.ts`'s `createSecretHandle` and never let it reach a
 * tool result, a log line, or a rethrown error — this function itself never
 * logs or wraps the value in anything other than the plain returned object.
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
    field: typeof parsed.field === "string" ? parsed.field : "",
    purpose: typeof parsed.purpose === "string" ? parsed.purpose : null,
    oneTime: parsed.oneTime === true,
    // `null` is a real, meaningful value here (no expiry on the grant) — it is
    // passed straight through to the handle store rather than fabricated into
    // a fake timestamp; the handle store's own 15-min cap is the fallback TTL.
    expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null,
  };
}

/**
 * Validates and normalizes the ack body against the kernel's limits. Throws a
 * value-free `invalid_ack` error (messages name the field only, never echo
 * the offending input).
 */
export function validateAckInput(input: {
  outcome: unknown;
  note?: unknown;
  evidence?: unknown;
}): { outcome: VaultAckOutcome; note?: string; evidence?: VaultAckEvidence } {
  if (typeof input.outcome !== "string" || !(VAULT_ACK_OUTCOMES as readonly string[]).includes(input.outcome)) {
    throw new VaultError("invalid_ack", "ack requires 'outcome' to be one of 'used', 'failed', 'discarded'.");
  }
  const result: { outcome: VaultAckOutcome; note?: string; evidence?: VaultAckEvidence } = {
    outcome: input.outcome as VaultAckOutcome,
  };
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== "string" || input.note.length === 0 || input.note.length > ACK_MAX_NOTE_LENGTH) {
      throw new VaultError("invalid_ack", `ack 'note' must be a non-empty string of at most ${ACK_MAX_NOTE_LENGTH} characters.`);
    }
    result.note = input.note;
  }
  if (input.evidence !== undefined && input.evidence !== null) {
    const ev = input.evidence;
    if (typeof ev !== "object" || Array.isArray(ev)) {
      throw new VaultError("invalid_ack", "ack 'evidence' must be an object with 'kind' and 'ref'.");
    }
    const { kind, ref } = ev as Record<string, unknown>;
    if (typeof kind !== "string" || kind.length === 0 || kind.length > ACK_MAX_EVIDENCE_KIND_LENGTH) {
      throw new VaultError("invalid_ack", `ack 'evidence.kind' must be a non-empty string of at most ${ACK_MAX_EVIDENCE_KIND_LENGTH} characters.`);
    }
    if (typeof ref !== "string" || ref.length === 0 || ref.length > ACK_MAX_EVIDENCE_REF_LENGTH) {
      throw new VaultError("invalid_ack", `ack 'evidence.ref' must be a non-empty string of at most ${ACK_MAX_EVIDENCE_REF_LENGTH} characters.`);
    }
    result.evidence = { kind, ref };
  }
  return result;
}

/**
 * Signs what the agent did with a grant it already fetched: the agent-side
 * companion to `fetchGrantValue` (`openclaw-imajin-plugin#42`, kernel
 * `imajin-ai#2235`). Sends ONLY `{ outcome, note?, evidence? }` — it takes no
 * value parameter, so a secret cannot be forwarded by construction. The caller
 * (`../tools.ts`) additionally rejects a note/evidence that contains a live
 * handle value. Returns the kernel's receipt, whitelisted field-by-field.
 */
export async function ackGrant(
  client: ImajinClient,
  grantId: string,
  input: { outcome: unknown; note?: unknown; evidence?: unknown },
  opts: { onBehalfOf?: string } = {},
): Promise<VaultAckReceipt> {
  const body = validateAckInput(input);
  const { status, text } = await client.requestRaw(grantAckPath(grantId), {
    method: "POST",
    body,
    onBehalfOf: opts.onBehalfOf,
  });
  if (status < 200 || status >= 300) throw errorForAckStatus(status, text);
  const parsed = safeJsonParse(text) as { outcome?: unknown; ackedAt?: unknown } | null;
  return {
    grantId,
    outcome: (VAULT_ACK_OUTCOMES as readonly unknown[]).includes(parsed?.outcome)
      ? (parsed!.outcome as VaultAckOutcome)
      : body.outcome,
    ackedAt: typeof parsed?.ackedAt === "string" ? parsed.ackedAt : null,
  };
}
