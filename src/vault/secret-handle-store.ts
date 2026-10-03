/**
 * In-process, single-use, short-lived handle store for `imajin_vault fetch`
 * (`ima-jin/openclaw-imajin-plugin#40`).
 *
 * A fetched grant value is NEVER returned from the `imajin_vault` tool
 * directly — it is stored here behind an opaque handle id, and only
 * `{ handle, name, expiresAt, oneTime }` is ever returned to the caller
 * (model context / chat / tool-call log). The value itself only ever
 * leaves this module through `withSecretEnv`, which is meant to be called
 * by an exec bridge immediately before running the one command that needs
 * it (see `docs/vault-handoff.md`).
 *
 * Invariants:
 *  - TTL is `min(grant expiresAt, DEFAULT_MAX_TTL_MS)` (15 min).
 *  - Single-use: the entry is deleted on first `withSecretEnv` read,
 *    whether or not the caller's callback succeeds.
 *  - The value is NEVER serialized by this module — `createSecretHandle`'s
 *    return value and every thrown error here are handle/name/timestamp
 *    only.
 */
import { randomBytes } from "node:crypto";

/** Hard cap on a handle's lifetime, regardless of the grant's own TTL. */
export const DEFAULT_MAX_TTL_MS = 15 * 60_000;

export class HandleExpiredError extends Error {
  constructor() {
    super("handle_expired");
    this.name = "HandleExpiredError";
  }
}

interface HandleEntry {
  name: string;
  value: string;
  expiresAtMs: number;
  /** Grant this value came from, so an exec bridge can ack the outcome. Not a secret. */
  grantId?: string;
}

const store = new Map<string, HandleEntry>();

function pruneExpired(now: number): void {
  for (const [handle, entry] of store) {
    if (entry.expiresAtMs <= now) store.delete(handle);
  }
}

function randomHandleId(): string {
  return `sh_${randomBytes(24).toString("hex")}`;
}

export interface CreateSecretHandleInput {
  /** The env-var-style name this value will be exposed as via `withSecretEnv`. */
  name: string;
  /** The raw secret value. Never logged, never echoed back by this function. */
  value: string;
  /**
   * The grant's own `expiresAt` (ISO string, ms epoch, or Date) — TTL is
   * capped to this. `null` means the grant itself has no expiry, in which
   * case `DEFAULT_MAX_TTL_MS` alone determines the handle's TTL.
   */
  grantExpiresAt: string | number | Date | null;
  /** Optional grant id, used only by `withSecretEnv`'s `ack` hook. */
  grantId?: string;
}

export interface CreateSecretHandleResult {
  handle: string;
  expiresAt: string;
}

/**
 * Stores a secret value behind a new opaque handle. TTL is
 * `min(grantExpiresAt, now + DEFAULT_MAX_TTL_MS)`. Returns only the handle
 * id and the resolved ISO expiry — never the value.
 */
export function createSecretHandle(input: CreateSecretHandleInput): CreateSecretHandleResult {
  const now = Date.now();
  pruneExpired(now);

  // `new Date(null)` resolves to the 1970 epoch (a finite, very-much-expired
  // timestamp), NOT "no expiry" — so `null` must be special-cased to NaN
  // before the finiteness check below, or a no-expiry grant would produce an
  // already-expired handle instead of falling back to the max TTL.
  const grantExpiresMs = input.grantExpiresAt === null ? Number.NaN : new Date(input.grantExpiresAt).getTime();
  const maxTtlExpiresMs = now + DEFAULT_MAX_TTL_MS;
  const expiresAtMs = Number.isFinite(grantExpiresMs)
    ? Math.min(grantExpiresMs, maxTtlExpiresMs)
    : maxTtlExpiresMs;

  const handle = randomHandleId();
  store.set(handle, { name: input.name, value: input.value, expiresAtMs, grantId: input.grantId });
  return { handle, expiresAt: new Date(expiresAtMs).toISOString() };
}

/** Outcome an exec bridge reports for a handle redemption. Value-free by construction. */
export interface SecretUseAck {
  grantId: string;
  outcome: "used" | "failed";
}

export interface WithSecretEnvOptions {
  /**
   * Called after the callback settles, only for a handle created with a
   * `grantId`: `used` when it succeeded, `failed` when it threw. Wire it to
   * `ackGrant` so the agent's signed record of use never depends on anyone
   * remembering (`openclaw-imajin-plugin#42`). Best effort: an ack failure is
   * swallowed so it can never change the exec result or surface a value.
   */
  ack?: (ack: SecretUseAck) => Promise<void> | void;
}

async function bestEffortAck(
  entry: HandleEntry,
  outcome: SecretUseAck["outcome"],
  ack: WithSecretEnvOptions["ack"],
): Promise<void> {
  if (!ack || !entry.grantId) return;
  try {
    await ack({ grantId: entry.grantId, outcome });
  } catch {
    // Deliberately ignored — see `WithSecretEnvOptions.ack`.
  }
}

/**
 * Resolves a handle to `{ [name]: value }` for a caller — intended for the
 * Gateway exec bridge (or a follow-up in this plugin, see
 * `docs/vault-handoff.md`'s "Follow-ups") to run exactly one command with
 * the value injected as an env var. The entry is deleted on this first
 * read regardless of outcome (single-use). Throws `HandleExpiredError`
 * (`handle_expired`) for an unknown, already-read, or TTL-expired handle.
 * On a callback failure, re-throws a new, value-free error — the original
 * error is never propagated verbatim, since a caller-supplied callback
 * could otherwise embed the value in its own error message (e.g. a shell
 * command whose stderr echoes its environment).
 */
export async function withSecretEnv<T>(
  handle: string,
  fn: (env: Record<string, string>) => Promise<T> | T,
  options: WithSecretEnvOptions = {},
): Promise<T> {
  const entry = store.get(handle);
  // Single-use: delete on first read, whether or not it's still valid.
  store.delete(handle);
  if (!entry || entry.expiresAtMs <= Date.now()) {
    throw new HandleExpiredError();
  }
  let result: T;
  try {
    result = await fn({ [entry.name]: entry.value });
  } catch {
    await bestEffortAck(entry, "failed", options.ack);
    // Redact on failure (non-negotiable): never let a callback's own error
    // carry the value forward.
    throw new Error(`withSecretEnv: callback failed for handle (name=${entry.name})`);
  }
  await bestEffortAck(entry, "used", options.ack);
  return result;
}

/**
 * True when `text` contains the value of any live (unexpired, unread) handle.
 * Used by `imajin_vault ack` to refuse a note/evidence that would carry a
 * secret into the signed record. Never returns or logs the value itself.
 */
export function containsLiveSecret(text: string): boolean {
  const now = Date.now();
  for (const entry of store.values()) {
    if (entry.expiresAtMs > now && entry.value.length > 0 && text.includes(entry.value)) return true;
  }
  return false;
}

/** Test-only: clears all stored handles. Not exported from the package's public surface. */
export function _resetSecretHandleStoreForTests(): void {
  store.clear();
}
