# Loop-addressed session command executor (#51, #77)

Signed, DID-addressed session commands arrive over the plugin's existing
outbound kernel WebSocket, are verified, executed against the **local** OpenClaw
gateway, and attested back as signed `loop.session.*` events.

The kernel addresses **loops, not harness sessions** (DECISION a, Ryan,
2026-10-17). The plugin alone resolves a loop to a local gateway target.
The kernel never needs to read lifecycle `refs.sessionKey`, construct a
session key, or interpret one from an approval card.

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
| `session.send` | `{ loopId, message, agentId? }` | locally resolved `chat.send` (`operator.write`), `idempotencyKey = commandId` |
| `session.approve` | `{ approvalId, loopId?, kind?: "exec" \| "plugin" }` | `exec`/`plugin.approval.resolve` `allow-once` (`operator.approvals`) |
| `session.deny` | `{ approvalId, loopId?, kind? }` | same, `deny` |
| `session.abort` | `{ loopId, runId? }` | locally resolved `chat.abort` (`operator.write`) |
| `session.spawn` | `{ task, parentLoopId?, label?, agentId?, group?, model? }` | `sessions.create` (`operator.write`), `idempotencyKey = commandId` |

Send/abort accept a local `sessionKey` instead of `loopId` for compatibility.
Parented spawn likewise accepts local `parentSessionKey` instead of
`parentLoopId`; neither key is required from the kernel. If both forms are
supplied they must identify the same local target. A supplied loop ID always
takes precedence: unknown, foreign, ended or superseded loops fail closed as
`loop_not_found`, **never** falling back to a supplied session key. Conflicting
forms fail as `loop_target_mismatch`. Malformed IDs fail as `invalid_payload`.
Lookups use only the plugin's currently active registry, not a gateway lookup,
transcript scrape, or reverse derivation from an untrusted loop ID. After a
restart an unobserved loop is unavailable until lifecycle hooks establish it.
Loop-addressed commands require loop lifecycle tracking to be enabled.

An unparented spawn creates a root loop. A parented spawn resolves its parent
locally and registers the gateway-returned child under that parent, using the
same IDs as lifecycle hooks. `group` and `model` are forwarded unchanged when
present. A spawn missing a gateway-returned child target fails rather than
attesting an invented child; a parent ending during spawn can likewise prevent
lineage registration and produces a failure, not a claim that no child ran.

`allow-always` is unreachable, and `sessions.create` is never sent
`permissionMode` / `toolOverrides` / `execNode` / `incognito`, so a remote command
can never need `operator.admin`. The loopback gateway connection is opened lazily
on the first command with scopes `operator.write` + `operator.approvals`.

## Verification (nothing executes until all pass)

shape → signature present → `to` is this agent → `issuer` (+ pinned kernel key)
→ signature valid → time window (±60 s skew, TTL) → replay (`commandId`) →
`principal` ∈ this agent's `serviceOf` (re-read per command, fail closed) →
principal countersignature → payload shape → local loop/binding resolution →
shared approval execution claim (when applicable) → gateway.

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
  "principal": "…", "issuer": "…", "agentDid": "…",
  "payloadHash": "<sha256 hex of canonicalize(payload)>",
  "at": "…",
  "reason": "unsigned", "detail": "…",
  "loopId": "…", "parentLoopId": null,
  "runId": "…", "approvalId": "…", "approvalKind": "exec"
}
```

`loopId` identifies the resolved target; `parentLoopId` is its immediate parent
(null for a root). Successful spawn outcomes additionally carry `childLoopId`,
equal to `loopId`, with the resolved parent's ID in `parentLoopId`. The child
is immediately addressable by subsequent commands. `agentDid` is the executing
agent, also the signed envelope's `from`, not a client-supplied agent label.
The signed envelope covers all lineage fields; changing any invalidates it.
Gateway failures retain any already-resolved loop identity. Rejections before
resolution do not assert a trusted loop destination.

Only the hash of the command payload is attested — message text, task bodies
and session keys are never echoed. Gateway error details are generic to avoid
leaking local identifiers. Pre-execution rejection `detail` is redacted and capped.
Legacy native approval-ID-only commands remain supported; their outcomes gain
loop lineage when a native approval binding is available.

Reasons: `malformed`, `unsigned`, `misaddressed`, `issuer_mismatch`,
`invalid_signature`, `expired`, `not_yet_valid`, `replayed`, `principal_mismatch`,
`not_service_of`, `service_binding_unverifiable`, `missing_countersignature`,
`invalid_countersignature`, `invalid_payload`, `gateway_error`,
`approval_not_found`, `approval_already_executed`, `approval_binding_mismatch`,
`loop_not_found`, `loop_target_mismatch`, `nothing_to_abort`.

## Native approval → loop binding

For a native gateway-exec approval with a known active owner, the approvals
bridge publishes on the existing authenticated WS:

```json
{
  "type": "loop.approval.bound",
  "attestation": {
    "from": "<agent DID>", "type": "agent", "timestamp": 0,
    "payload": {
      "loopId": "<owning loop>",
      "principalDid": "<configured operator DID>",
      "agentDid": "<agent DID>",
      "approvalId": "<native gateway approval ID>"
    },
    "signature": "<Ed25519 hex>"
  }
}
```

This uses the same `signMessage` envelope as outcomes. Verify the signature
against the agent's registered key and require `from === payload.agentDid`;
join cards using the native `approvalId` plus the verified principal and agent.
The binding comes **only** from the native source's local owner lookup, not a
client-selected destination or approval detail's session key. Unknown/foreign/
ended owners produce no binding. It is replayed for active tracked approvals
on authenticated reconnect, so startup-before-WS delivery is not lost.
Binding delivery is best effort and is not an approval execution outcome.

When resolving a bound approval, the session executor uses this same local
binding for the outcome. Any supplied `loopId` must match it, and its principal
and agent must match the verified command. A loop-addressed approval without a
native binding fails closed as `approval_binding_mismatch`.

## Exactly one approval execution rail

The plugin injects **one** `ApprovalExecutionRegistry` into the legacy
`operator.approval.decided` executor, the session executor, and the older
`approval.decision` gateway callback. Each claims the native approval ID
synchronously immediately before invoking its execution RPC, after its own
signature/authorization/content checks. A converted proposal cannot execute on
both rails, including when live events, catch-up and commands race.
Invalid commands do not consume approval claims.

Claims are retained for the process lifetime, without eviction or release even
when an execution response is lost. The legacy rail skips a previously claimed
approval; the session rail attests `approval_already_executed` rather than
claiming another rail's action succeeded. Fail-closed publish-error denials
also use the same claim. This is process-local at-most-once dispatch, not a
claim of durable exactly-once execution across plugin crashes; the gateway's
native approval pending state remains the restart backstop.

The principal's legacy approval signature over
`{contentHash, decision, decidedAt[, mode]}` is **not** a command wish signature.
A converted session command still requires signatures over its complete
canonical command body. The kernel integration must select one executable
fan-out rail; transport delivery is never execution success.

These typed events travel on the WS rather than `POST /api/loops`: the kernel's
loops ingest only accepts `loop.started|progress|blocked|finished`
(`LOOP_LIFECYCLE_TYPES`), and would 400 a `loop.session.*` type. The kernel half
must accept them from the socket (or extend the ingest vocabulary).
