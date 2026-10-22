# Harness horizon sync

The opt-in horizon publisher pushes local queue facts to an existing owning
loop through the signed `/api/loops` rail. The kernel never reads the harness,
gateway, sessions or transcripts. Inbound `/jin` claims are a separate feature.

The wire contract is `docs/loops-rail-contract.md` from merged kernel PRs #2909 and #3000 (receipt lookup, imajin-ai#2931).
Zones are kernel projections, never published fields.
Local `head` is not a lease; local `near` is not proof of settled design.

The bridge's current `refs` and `pr` do not contain issue OUTCOMEs, release
containment or production deployment evidence. The publisher must not invent
these facts. A local `past` can report finished work and issue closure, but
cannot prove release or deployment. Full exit requires explicit evidence.

## Configuration

Set `plugins.entries.imajin.config.horizon` alongside the existing `nodeUrl`,
`did`, `keypairPath` and optional `actAs`:

```json
{
  "enabled": true,
  "loopId": "existing-owning-loop-id",
  "repository": "ima-jin/imajin-ai",
  "filePath": "~/.openclaw/workspace/horizon/horizon.json",
  "stateDir": "~/.openclaw/horizon-sync",
  "syncIntervalMs": 30000
}
```

`enabled` defaults to false. `loopId` and `repository` are required when enabled.
The loop must already exist under `actAs` (or `did` if `actAs` is omitted).
This service never publishes `loop.started` to create an owning loop. When
`actAs !== did`, the publisher needs an active `loops:publish` grant from
that principal. Register the configured DID's public key in the kernel through
the existing identity setup; the signer derives its public key from the existing
keypair file, and never persists a private key in the cursor.

The file path defaults to the bridge path above; `~/` is expanded for file,
state and keypair paths. `stateDir` defaults to `horizon-sync` beside the keypair.
The interval defaults to 30 seconds (minimum 1 second). Sync also runs at service
startup and on parent-directory file events, including atomic replacement of
`horizon.json`. Periodic ticks recover missed events or a missing directory.
Shutdown closes the watch/timer and preserves any unfinished outbox.

## File mapping

The supported base shape is:

```json
{
  "depthTarget": 12,
  "items": [{
    "id": "issue-2866",
    "zone": "tail",
    "title": "Push the harness queue to the loop registry",
    "refs": ["#2866"],
    "addedAt": "2026-10-18T00:00:00Z"
  }]
}
```

- `id` is stable for the item's lifetime. The wire `stepId` hashes
  `[loopId, publisherDid, item.id]`; two DIDs can safely reuse an item id in
  the same loop. Neither raw item ids nor gateway/session identifiers become
  registry step identities.
- File array position becomes finite `rank` (zero first). Rank/title changes
  publish sparse `step.updated` facts. No 12-item truncation: `depthTarget` is
  validated locally, but kernel target depth is 12 and is not authored here.
- Items default to `stepKind: "code"`, including fuzzy intentions with no refs
  yet. `repository` resolves bare `#N` refs and PR numbers. The first recognized
  issue ref binds the item; qualified `owner/repo#N` and GitHub issue URLs are
  normalized to `owner/repo#N`. PR numbers, `#N`, and GitHub pull URLs are accepted.
  A qualified issue chooses that issue's repository for its declaration.
- New code items declare exactly `issue_closed`, `release_contains`, and
  `deployed` conditions. The condition ids are those same literal names,
  scoped by step id. A PR URL or `prDraft: false` never satisfies an exit.
- Local `past` / `done` or explicit `closed: true` emits `step.finished` and, when an
  issue ref exists, an `issue_closed` observation. This is the bridge writer's
  signed assertion, not a fetched GitHub status. `doneAt`, `waitingOn` and `prDraft`
  do not become completion evidence. Other local zones never grant a claim.
- Removing an item does not cancel or delete registry history. Reintroducing
  its id resumes the existing step without re-queuing it. Facts are additive:
  removing a field cannot retract a published fact. Use a new stable id for a
  genuinely new step or a change to immutable kind/repository/exit conditions.
- Optional `stepKind: "human" | "ops"` declares one attestation condition.
  `attestorDid` defaults to the publisher DID; an explicit `attestation`
  statement is emitted only when that attestor is the actual signer. A local
  `past` alone does not impersonate a human attestor.

### Optional explicit sharpening and exit evidence

The current bridge does **not** supply these optional fields. They are a
forward-compatible bridge extension, not values inferred from prose or a PR:

```json
{
  "outcome": "OUTCOME · Ryan can see the queued work on the loop horizon",
  "briefRef": "brief:2866",
  "provisionRef": "provision:2866",
  "designRef": "design:2866",
  "release": {
    "issue": "#2866",
    "mergeCommit": "<full 40-character hexadecimal merge SHA>",
    "tag": "v1.2.3"
  },
  "deployment": { "tag": "v1.2.3", "environment": "prod" }
}
```

`outcome` must start with `OUTCOME` and is paired with the recognized issue ref
in `step.updated.issue`. A release assertion requires the exact same issue,
its repository, a full merge SHA and the tag containing that commit.
Production deployment must reference the same release tag to satisfy exit.
Corrections are new observations. Completion with missing or mismatched
evidence remains visible with open conditions; the publisher never sends
`state: "exited"` or `zone`.

**Known contract gap: [imajin-ai#2931](https://github.com/ima-jin/imajin-ai/issues/2931).**
Kernel #2909 requires an OUTCOME in order to bind an issue ref, and requires
that binding to satisfy closure. A basic bridge item moved to `past` therefore
publishes finished/closure facts, but cannot derive kernel `past` until a real
OUTCOME is supplied or the kernel supports issue-ref-only binding. No fabricated
OUTCOME, release tag, deployment or signature is used to hide this gap.

## Durability, isolation and failures

The cursor is keyed by kernel URL, owning loop, publisher DID and principal.
Use one live plugin process per cursor; instances in a process serialize writes.
Different harness DIDs have independent cursors even when sharing a state
directory and loop. Preserve the directory across restarts and file moves.
Do not delete/reset it to recover a network or ingest error.

Each tick validates/maps the **entire** file before any POST, including replay.
Invalid JSON, duplicate ids, invalid evidence, changed immutable declarations,
or credential-shaped text fail safely: a rate-limited fixed warning, no raw
file/error/server body in logs, and no publish. A corrupt cursor also fails
closed rather than silently starting over. Limits: 1 MiB file, 1000 items,
100 refs/waiting entries per item and 2000 characters per text fact.

The write-ahead outbox stores exact signed envelopes in a mode-0600 file,
fsyncs and atomically replaces it, then sends in declaration-before-fact order.
Every successful response is acknowledged durably before the next send.
An uncertain response or restart retries the identical payload, timestamp and
signature; the kernel deduplicates exact signed requests. Explicit "already
applied" receipts also acknowledge the saved request: a JSON `code` equal to
`already_applied`, a JSON `error` equal to `already applied`, or the exact
plain-text body `already applied`. Generic duplicate/conflict messages are not
treated as acknowledgements. Receipt reads are bounded to 4096 bytes; response
bodies are never logged or persisted. Changed source
facts wait behind the saved batch, then diff against its completed target.

Other permanent HTTP 4xx rejections (excluding 408 and 429) are stored in
`<cursorPath>.dead-letter.json` before advancing to the next request. This
mode-0600 file retains the exact signed request, HTTP status and rejection time,
keyed by the request hash so a crash cannot duplicate its entry. A warning names
the rejected `stepId`, never the server body. A failed dead-letter write keeps
the request pending rather than losing it. HTTP 408/429, 5xx and network errors
still retain the exact head request for retry.
Dead-lettered requests, including 401/403 from a revoked or misconfigured grant, are not replayed automatically: they live in `<cursorPath>.dead-letter.json`, and an operator replays them after fixing auth.

### Stale exact outbox recovery (kernel #2931)

An original envelope older than the kernel's five-minute signed-message window
is **not** posted again or restamped. The publisher signs a separate fresh
`loop.receipt` request to kernel-root `POST /api/loops/receipts` (never a
`/jin` route), using its own DID key and the original loop and principal.
`envelopeHash` is SHA-256 of the canonical parsed original ingest request,
including its original payload and normalized lowercase signature hex. Null,
absent and extension payload fields are preserved; this is not the cursor's
JSON digest. The lookup uses the same live `loops:publish` authorization as ingest.

Only HTTP 200 `{status: "accepted", eventId: "signed-loop:<envelopeHash>"}`
acknowledges that exact saved request. The cursor is advanced durably before
the next lookup; no step is published, so receipt recovery adds no history.
The acceptance log identifies the step without logging the envelope or body.

HTTP 404 `{status: "not_found"}` retains the entire remaining exact outbox:
it is not permission to re-issue the observation, and may also mean publishing
scope was denied or revoked. An unavailable kernel, rejected lookup signature,
malformed/oversized body or mismatched event id likewise retains the outbox.
A rate-limited warning identifies the step and `not_found` or `unavailable`;
subsequent syncs retry lookup with a fresh lookup timestamp only. Changed source
facts wait behind this unresolved batch. Operators should investigate identity,
scope and kernel availability rather than delete/reset the cursor or restamp.
A 400 ingest rejection that crosses the age boundary during delivery also
uses this receipt path. Other permanent ingest failures still use the dead letter.
Old dead letters remain available for operator reconciliation; they are not
automatically replayed or treated as acceptance.

## Verification and wake seam

Run `pnpm run typecheck` and
`pnpm exec vitest run --maxWorkers=2 --minWorkers=1`.
The horizon suite covers file mapping, rank changes, exit facts, exact
restart replay, per-event acknowledgement, two DID signatures, malformed files
and cursor failures, watcher replacement and service disposal.
`src/horizon/receipts.test.ts` covers stale accepted/not-found/unreachable
restarts, exact canonical hashing, separate Ed25519 lookup signatures, scope
mismatches, invalid responses, partial batch recovery and cursor-write failure.

Read `loops_get` / `GET /api/loops/{loopId}` under the owning principal. Inspect
`horizon.steps` and `events[].payload.publisherProof` for the actual publisher,
signature, ranks and unsatisfied exit conditions. `include_exited: true`
includes fully exited steps for audit.

`createHorizonSync(...).sync()` is an explicit one-way resync seam for a future
wake adapter. #79 / PR #80 is still independent; no wake or wsNotifications file
is modified here. A wake verdict is not closure/release/deployment evidence.
Inbound claim application and lease policy remain #2879/#2880, not this service.
