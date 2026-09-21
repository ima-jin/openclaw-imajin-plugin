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
  /** The grant's own `expiresAt` (ISO string, ms epoch, or Date) — TTL is capped to this. */
  grantExpiresAt: string | number | Date;
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

  const grantExpiresMs = new Date(input.grantExpiresAt).getTime();
  const maxTtlExpiresMs = now + DEFAULT_MAX_TTL_MS;
  const expiresAtMs = Number.isFinite(grantExpiresMs)
    ? Math.min(grantExpiresMs, maxTtlExpiresMs)
    : maxTtlExpiresMs;

  const handle = randomHandleId();
  store.set(handle, { name: input.name, value: input.value, expiresAtMs });
  return { handle, expiresAt: new Date(expiresAtMs).toISOString() };
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
): Promise<T> {
  const entry = store.get(handle);
  // Single-use: delete on first read, whether or not it's still valid.
  store.delete(handle);
  if (!entry || entry.expiresAtMs <= Date.now()) {
    throw new HandleExpiredError();
  }
  try {
    return await fn({ [entry.name]: entry.value });
  } catch {
    // Redact on failure (non-negotiable): never let a callback's own error
    // carry the value forward.
    throw new Error(`withSecretEnv: callback failed for handle (name=${entry.name})`);
  }
}

/** Test-only: clears all stored handles. Not exported from the package's public surface. */
export function _resetSecretHandleStoreForTests(): void {
  store.clear();
}
