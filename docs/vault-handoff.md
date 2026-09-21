# Vault handoff (`imajin_vault`, #40)

Plugin half of the remote human → agent credential handoff. Kernel half:
`ima-jin/imajin-ai#2231`. Companion: vault v2 (#1242), static-secret
framework (#1439).

## Why

The owner is often remote (phone only). The agent sometimes needs a
short-lived secret from them — e.g. a GitHub Actions runner registration
token — and chat transcripts are forbidden for secrets. Vault v2 already
stores secrets as owner-signed, scoped, revocable delegation grants. This
tool lets the agent consume such a grant without the value ever entering
model context, chat, tool-call logs, or error messages. **The grant IS the
record of the handoff** — there is no separate audit trail to keep in sync.

## Flow

1. **Owner** seals a value (e.g. a runner token) in their vault from `/jin`
   and issues a scoped grant to the agent's DID, with a `purpose` string
   (e.g. `gha-runner-registration`) and a TTL.
2. **`list_grants`** — the agent lists its own active grants, optionally
   filtered by `purpose`. Metadata only (`grantId`, `ownerDid`, `purpose`,
   `expiresAt`, `oneTime`, `consumedAt`, `createdAt`) — never a value.
3. **`fetch`** — given a `grantId` + a `name`, the agent resolves the sealed
   value into a **protected handle**. The value is stored in an in-process,
   single-use `SecretHandleStore` keyed by an opaque handle id, with a TTL
   of `min(grant expiresAt, 15 min)`. Only `{ handle, name, expiresAt,
   oneTime }` is ever returned — never the value.
4. **exec** — a follow-up exec bridge (not yet wired, see "Follow-ups"
   below) calls `withSecretEnv(handle, fn)` to resolve the handle to
   `{ [name]: value }` for exactly one command invocation. The entry is
   deleted on this first read, whether or not the command succeeds.
5. **`ack_consumed`** — once the value has been used, the agent marks the
   grant consumed. Idempotent kernel-side.
6. The grant now shows `consumedAt` (or is expired) — nothing sensitive
   ever appeared in a transcript.

## Security invariants

- `list_grants` and `ack_consumed` responses never carry a value field.
- `fetch` returns a handle, not a value — the value lives only in the
  module-level `SecretHandleStore` map (`src/vault/secret-handle-store.ts`).
- A handle is single-use (deleted on first `withSecretEnv` read) and
  expires after `min(grant expiresAt, 15 min)`.
- Kernel errors (403/404/410/5xx) are mapped to a small, fixed set of
  value-free error codes (`grant_not_for_this_agent`, `grant_not_found`,
  `grant_already_consumed`, `vault_request_failed`) in
  `src/vault/kernel-contract.ts` — the raw upstream response body is never
  included in a thrown error, a tool result, or a log line.
- `withSecretEnv` redacts any callback failure into a value-free error.

## Follow-ups

- The Gateway exec bridge that actually calls `withSecretEnv` to run the
  one command needing the secret is not wired in this PR — `fetch` stops
  at producing the handle. See the PR's "Follow-ups" section.
- `src/vault/kernel-contract.ts` isolates every kernel route/shape assumed
  here so it can be re-pointed once `ima-jin/imajin-ai#2231` lands for real.
