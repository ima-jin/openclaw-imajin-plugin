# Session command executor (#51)

Signed, DID-addressed session commands arrive over the plugin's existing
outbound kernel WebSocket, are verified, executed against the **local** OpenClaw
gateway, and attested back as signed `loop.session.*` events.

Rulings this follows: the kernel never addresses a gateway — it addresses the
agent DID bound to the principal via `serviceOf` (RFC-31 v2, ima-jin/imajin-ai#2407,
epic #1758, per-principal endpoint #2251); commands ride the existing outbound
WS; every command is countersigned per the wish-and-grant chain
(ima-jin/imajin-ai#2084); this generalizes the #2321 approval-echo path.

Off by default. Enable with `plugins.entries.imajin.config.sessionCommands`:

```json
{
  "enabled": true,
  "kernelPublicKeyHex": "<64-hex Ed25519 public key of the kernel's command signer>",
  "kernelDid": "did:imajin:<kernel>",
  "requirePrincipalCountersignature": true
}
```

`kernelPublicKeyHex` is required and pinned — it is the only key whose grant the
plugin accepts. `kernelDid` (optional) additionally pins `issuer`. When `actAs`
is set, a command's `principal` must equal it.

## Command frame

> The #2251 router does not yet publish a typed schema for these frames. This
> is the plugin-side contract the kernel half should emit; it is isolated in
> `src/session-commands.ts` so a schema change is a one-file edit.

```json
{
  "type": "session.send",
  "commandId": "<unique id>",
  "to": "<agent DID>",
  "principal": "<principal DID the agent serves>",
  "issuer": "<kernel DID>",
  "issuedAt": "2026-10-06T16:00:00.000Z",
  "expiresAt": "2026-10-06T16:05:00.000Z",
  "payload": { },
  "signature":        { "keyId": "<hex pubkey>", "alg": "ed25519", "sig": "<hex>" },
  "countersignature": { "keyId": "<hex pubkey>", "alg": "ed25519", "sig": "<hex>" }
}
```

Both signatures are Ed25519 over
`canonicalize({ type, commandId, to, principal, issuer, issuedAt, expiresAt|null, payload })`
(the same canonical JSON as the loops rail). `signature` is the kernel's grant;
`countersignature` is the principal's wish, checked against the principal's
currently registered key (`GET /registry/api/identity/:did`). `expiresAt`
defaults to `issuedAt + 5 min`.

| type | payload | gateway call (scope) |
| --- | --- | --- |
| `session.send` | `{ sessionKey, message, agentId? }` | `chat.send` (`operator.write`), `idempotencyKey = commandId` |
| `session.approve` | `{ approvalId, kind?: "exec" \| "plugin" }` | `exec`/`plugin.approval.resolve` `allow-once` (`operator.approvals`) |
| `session.deny` | `{ approvalId, kind? }` | same, `deny` |
| `session.abort` | `{ sessionKey, runId? }` | `chat.abort` (`operator.write`) |
| `session.spawn` | `{ task, parentSessionKey?, label?, agentId? }` | `sessions.create` (`operator.write`), `idempotencyKey = commandId` |

`allow-always` is unreachable, and `sessions.create` is never sent
`permissionMode` / `toolOverrides` / `execNode` / `incognito`, so a remote command
can never need `operator.admin`. The loopback gateway connection is opened lazily
on the first command with scopes `operator.write` + `operator.approvals`.

## Verification (nothing executes until all pass)

shape → signature present → `to` is this agent → `issuer` (+ pinned kernel key)
→ signature valid → time window (±60 s skew, TTL) → replay (`commandId`) →
`principal` ∈ this agent's `serviceOf` (re-read per command, fail closed) →
principal countersignature → payload shape → gateway.

Replay state is only consumed by frames that pass the kernel signature check, so
an unauthenticated frame cannot burn a `commandId`.

## Attestations

Every frame gets exactly one attestation — completed, failed, or rejected. It is
sent on the same WS as `{ type: "loop.session.<verb>.completed|failed", attestation }`
where `attestation` is the agent-signed envelope (`signMessage`, same shape as
`openclaw.approval.requested`) and `payload` is:

```json
{
  "eventType": "loop.session.send.failed",
  "commandId": "…", "command": "session.send", "outcome": "failed",
  "principal": "…", "issuer": "…",
  "payloadHash": "<sha256 hex of canonicalize(payload)>",
  "at": "…",
  "reason": "unsigned", "detail": "…",
  "sessionKey": "…", "runId": "…", "approvalId": "…", "approvalKind": "exec"
}
```

Only the hash of the command payload is attested — message text and task bodies
are never echoed. `detail` is redacted and capped.

Reasons: `malformed`, `unsigned`, `misaddressed`, `issuer_mismatch`,
`invalid_signature`, `expired`, `not_yet_valid`, `replayed`, `principal_mismatch`,
`not_service_of`, `service_binding_unverifiable`, `missing_countersignature`,
`invalid_countersignature`, `invalid_payload`, `gateway_error`,
`approval_not_found`, `nothing_to_abort`.

These typed events travel on the WS rather than `POST /api/loops`: the kernel's
loops ingest only accepts `loop.started|progress|blocked|finished`
(`LOOP_LIFECYCLE_TYPES`), and would 400 a `loop.session.*` type. The kernel half
must accept them from the socket (or extend the ingest vocabulary).
