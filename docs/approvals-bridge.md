# Gateway approvals bridge — sequence (#24, generalized by #33)

Plugin half of `ima-jin/imajin-ai#2059` (kernel half merged in
`ima-jin/imajin-ai` PR #2078), generalized into a source-adapter model by
#33 (companion kernel issue `ima-jin/imajin-ai#2152`). See `README.md` →
"Gateway approvals bridge" for config keys and what was deliberately left
out of v1.

## Generic leg — one bridge, N `ApprovalSource`s (#33)

The sequence diagrams below ("Request leg" / "Decision leg") describe the
system-agent source concretely — they are still exactly accurate for it.
`GatewayApprovalsBridge` itself no longer talks to the OpenClaw Gateway
directly; it is driven by a `Map<string, ApprovalSource>` built from
`approvals.sources` (default: both `system-agent` and `skill-workshop`).

```
 approvals.sources: ["system-agent", "skill-workshop"]
                │                        │
                ▼                        ▼
   sources/system-agent.ts    sources/skill-workshop.ts
   (openclaw.approval.*,      (skills.proposals.list /
    approval.resolve)          .apply / .reject)
                │                        │
                │  ApprovalSourceRequest │  ApprovalSourceRequest
                │  {proposalId, kind:    │  {proposalId, kind:
                │   "system-agent:*",    │   "skill-workshop:*",
                │   summary,             │   summary, sourceRevision,
                │   sourceRevision}      │   detail}
                └───────────┬───────────┘
                            ▼
              GatewayApprovalsBridge (this file)
     fold sourceRevision into detail.sourceRevision → sign+hash the
     canonical 6-key payload → dedup by proposalId → POST /notify/api/send
                            │
                            ▼
                       Kernel (/jin)
           RECOMPUTES contentHash over the received 6-key payload;
           400 on mismatch (`ima-jin/imajin-ai#2154`)
                            │
     operator.approval.decided {proposalId, decision, decidedBy, contentHash}
                            ▼
              GatewayApprovalsBridge routes by the
              proposalId's TRACKED sourceId, then:
                1. decided event's `contentHash` != the one staged?
                   drift (no RPC needed).
                2. `source.getCurrent(id)` — not pending? no-op + evict.
                3. recomputed digest (current sourceRevision + detail)
                   != staged `contentHash`? drift.
                4. drift (either check) → `kernel.publishMismatch` +
                   `onDriftPolicy`: "leave" (system-agent, #24 parity) or
                   "restage" (skill-workshop, #33: evict + re-list so the
                   operator sees a fresh card at the current hash).
                5. no drift → `source.resolve(id, decision, sourceRevision)`.
```

Adding a third source is exactly "one file + one `approvals.sources`
entry, no bridge edits" (#33 acceptance criterion) — implement
`ApprovalSource` (`src/sources/types.ts`) and register it in
`startGatewayApprovalsBridge` (`src/gateway-approvals-bridge.ts`).

### `contentHash` digest definition (#2084)

```
contentHash = "sha256:" + sha256hex(canonicalize({
  proposalId, source, kind, summary, keysTouched, detail
}))
```

Exactly those six keys — matching the kernel's OWN recomputation
(`ima-jin/imajin-ai#2154`, `apps/kernel/src/lib/notify/operator-
approvals.ts`), which returns 400 on mismatch. There is no top-level
`sourceRevision`: each source's own NATIVE anti-tamper pin (the Gateway's
`proposalHash` for system-agent, Skill Workshop's `revisionHash`) rides
INSIDE `detail` as `detail.sourceRevision`, so `detail` is always present
(never omitted, even for system-agent) and the pin is covered by the hash.
The bridge signs the same canonical object with the agent DID keypair. The
kernel accepts an optional `"sha256:"` prefix on ingest; this bridge always
emits it.

### Skill Workshop source (#33)

`sources/skill-workshop.ts` maps pending `skills.proposals.list` entries
(scope `operator.read`) to `ApprovalSourceRequest`s with `kind:
"skill-workshop:create"` or `"skill-workshop:update"`, `sourceRevision` =
the proposal's own `revisionHash`, and a bounded (≤16 KB) `detail`:
`{skillName, kind, scan, description, diffSummary}` (the bridge folds
`sourceRevision` into this `detail` before hashing/publishing — see the
digest definition above). There is no SDK-exposed "a new proposal
appeared" push event — `skills.proposals.events.list` (also real, scope
`operator.read`) is scoped to one already-known proposal's own revision
history, not a discovery feed — so `subscribe()` is an honest interval
poll of `skills.proposals.list` instead. `resolve()` calls `skills.
proposals.apply`/`reject` (scope `operator.admin`) with the tracked
`expectedRevisionHash`; the Gateway itself fails closed on a stale hash
(`SkillProposalRevisionChangedError`), which this source translates into
an `ApprovalContentDriftError` so the bridge's generic mismatch/
`"restage"` handling applies uniformly.

## Request leg — proposal staged → kernel notification (system-agent, concrete example)

```
OpenClaw system-agent    OpenClaw Gateway         gateway-approvals-bridge.ts        Kernel (/jin)
       |                        |                          |                              |
       |--stage proposal------->|                          |                              |
       |  (restart / config     |--openclaw.approval.------>|                              |
       |   mutation)            |  requested (event, over   |                              |
       |                        |  the plugin's OWN loop-   |                              |
       |                        |  back operator.approvals  |                              |
       |                        |  connection)               |                              |
       |                        |                          |--build {proposalId, source,   |
       |                        |                          |  kind, summary, keysTouched:  |
       |                        |                          |  [], detail: {sourceRevision: |
       |                        |                          |  proposalHash}}; sign +       |
       |                        |                          |  sha256-hash the canonical    |
       |                        |                          |  JSON with agent DID keypair  |
       |                        |                          |  (#2084 digest, see above)    |
       |                        |                          |                              |
       |                        |                          |--POST /notify/api/send------->|
       |                        |                          |  scope: operator.approval.    |
       |                        |                          |  requested, to: operatorDid,  |
       |                        |                          |  x-webhook-secret             |
       |                        |                          |                              |
       |                        |                          |          (dedup by proposalId;|
       |                        |                          |           startup: reconcile  |
       |                        |                          |           via openclaw.approval|
       |                        |                          |           .list catches any   |
       |                        |                          |           proposal missed     |
       |                        |                          |           while the plugin was|
       |                        |                          |           down)               |
       |                        |                          |                              |--persist +
       |                        |                          |                              |  render /jin
       |                        |                          |                              |  confirm card
```

## Decision leg — operator decides → Gateway applies (system-agent, concrete example)

```
Kernel (/jin)                gateway-approvals-bridge.ts        OpenClaw Gateway       OpenClaw system-agent
       |                              |                                |                       |
  operator taps                       |                                |                       |
  Approve/Deny                        |                                |                       |
       |                              |                                |                       |
       |--kernel signs & publishes--->|                                |                       |
       |  operator.approval.decided   |  (delivered over the plugin's  |                       |
       |  {proposalId, decision,      |   EXISTING, already-           |                       |
       |   decidedBy, decidedAt,      |   authenticated kernel WS —    |                       |
       |   contentHash}               |   #1884 grant-bound event      |                       |
       |  via bus_event fan-out       |   subscription, capability     |                       |
       |  (#1884)                     |   operator:approvals)          |                       |
       |                              |                                |                       |
       |                              |--verify issuer == subject ==   |                       |
       |                              |  decidedBy == configured       |                       |
       |                              |  operatorDid                   |                       |
       |                              |  (else: reject, log, STOP —    |                       |
       |                              |   Gateway is never contacted)  |                       |
       |                              |                                |                       |
       |                              |--if decision == withdrawn:     |                       |
       |                              |  no-op (no Gateway analog)     |                       |
       |                              |                                |                       |
       |                              |--proposalId tracked by this    |                       |
       |                              |  bridge? no -> no-op, log,     |                       |
       |                              |  STOP (idempotent: unknown/    |                       |
       |                              |  already-resolved)             |                       |
       |                              |                                |                       |
       |                              |--check 1 (#2084): decided      |                       |
       |                              |  event's contentHash == the    |                       |
       |                              |  one this bridge staged?       |                       |
       |                              |  no -> drift (see below),      |                       |
       |                              |  STOP -----------------+       |                       |
       |                              |                         |     |                       |
       |                              |--approval.get(proposalId)----->|                       |
       |                              |<--current snapshot-------------|                       |
       |                              |  {status, presentation.        |                       |
       |                              |   proposalHash}                |                       |
       |                              |                                |                       |
       |                              |--status != pending? no-op,     |                       |
       |                              |  log, evict, STOP (idempotent: |                       |
       |                              |  already applied/expired)      |                       |
       |                              |                                |                       |
       |                              |--check 2 (#2084): recompute    |                       |
       |                              |  "sha256:" + sha256hex(canon-  |                       |
       |                              |  icalize({proposalId, source,  |                       |
       |                              |  kind, summary, keysTouched,   |                       |
       |                              |  detail: {sourceRevision:      |                       |
       |                              |  currentHash}})) != the        |                       |
       |                              |  contentHash this bridge       |                       |
       |                              |  signed at request time? ------+------------------+    |
       |                              |                                |                  |    |
       |<--POST /notify/api/send------|                                |                  |    |
       |  scope: operator.approval.   |                                |                  |    |
       |  mismatch (best effort;      |                                |                  |    |
       |  no dedicated kernel         |                                |                  |    |
       |  handling in v1)             |                                |                  |    |
       |                              |  STOP — never call             |<-----------------+    |
       |                              |  approval.resolve (either      |                       |
       |                              |  check-1 or check-2 drift)     |                       |
       |                              |                                |                       |
       |                              |--both checks pass: map         |                       |
       |                              |  decision--> approve ->        |                       |
       |                              |  allow-once, deny -> deny;     |                       |
       |                              |  call approval.resolve         |                       |
       |                              |  {id, kind: "system-agent",    |                        |
       |                              |   decision}                    |                        |
       |                              |                                |--apply / discard------>|
       |                              |<--{applied, approval}----------|  proposal              |
       |                              |  (a resolve error/conflict is  |                        |
       |                              |   logged, never crashes the    |                        |
       |                              |   bridge)                      |                        |
```

For `skill-workshop`, check 2's recomputed `detail` also carries whatever
structured fields that source adds (`skillName`/`scan`/`description`/
`diffSummary`) alongside `sourceRevision` — so a proposal whose `detail`
changed after the operator decided is caught even when the underlying
`revisionHash` happened not to change.

## Trust chain summary

`plugin-signed request` → `kernel recomputes + verifies contentHash` →
`operator decides on /jin` → `kernel witnesses` → `plugin verifies signer +
hash (twice)` → `Gateway approval store`.

The kernel (`ima-jin/imajin-ai#2154`) recomputes `contentHash` over the
exact six-key canonical payload it received and rejects the request
(400) on mismatch — so the /jin card the operator sees is provably bound
to what this bridge published. It does NOT verify the plugin's Ed25519
*signature* in v1 (`ima-jin/imajin-ai#2059`'s target-shape ruling defers
that to the human-countersign follow-up); this bridge's own verification
on the decision leg — kernel-witnessed transport, exact operator DID
match, the decided event's own `contentHash` echoed back matching what was
staged, AND a fresh digest recomputed from the source's current state
still matching — is what stands in for it today. The bridge never bypasses
a source's own backing store: it only ever relays a verified decision to
it (`approval.resolve` for system-agent, `skills.proposals.apply`/`reject`
for Skill Workshop).
