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
                │   summary, contentHash}│   summary, contentHash, detail}
                └───────────┬────────────┘
                            ▼
              GatewayApprovalsBridge (this file)
        sign → dedup by proposalId → POST /notify/api/send
                            │
                            ▼
                       Kernel (/jin)
                            │
         operator.approval.decided {proposalId, decision, decidedBy}
                            ▼
              GatewayApprovalsBridge routes by the
              proposalId's TRACKED sourceId, then:
                1. `source.getCurrent(id)` — not pending? no-op + evict.
                2. hash mismatch? `kernel.publishMismatch` +
                   `onDriftPolicy`: "leave" (system-agent, #24 parity) or
                   "restage" (skill-workshop, #33: evict + re-list so the
                   operator sees a fresh card at the current hash).
                3. match → `source.resolve(id, decision, contentHash)`.
```

Adding a third source is exactly "one file + one `approvals.sources`
entry, no bridge edits" (#33 acceptance criterion) — implement
`ApprovalSource` (`src/sources/types.ts`) and register it in
`startGatewayApprovalsBridge` (`src/gateway-approvals-bridge.ts`).

### Skill Workshop source (#33)

`sources/skill-workshop.ts` maps pending `skills.proposals.list` entries
(scope `operator.read`) to `ApprovalSourceRequest`s with `kind:
"skill-workshop:create"` or `"skill-workshop:update"`, `contentHash` =
the proposal's own `revisionHash`, and a bounded (≤16 KB) `detail`:
`{skillName, kind, scan, description, diffSummary}`. There is no
SDK-exposed "a new proposal appeared" push event — `skills.proposals.
events.list` (also real, scope `operator.read`) is scoped to one already-
known proposal's own revision history, not a discovery feed — so
`subscribe()` is an honest interval poll of `skills.proposals.list`
instead. `resolve()` calls `skills.proposals.apply`/`reject` (scope
`operator.admin`) with the tracked `expectedRevisionHash`; the Gateway
itself fails closed on a stale hash (`SkillProposalRevisionChangedError`),
which this source translates into an `ApprovalContentDriftError` so the
bridge's generic mismatch/`"restage"` handling applies uniformly.

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
       |                        |                          |--sign {proposalId, kind,      |
       |                        |                          |  summary, keysTouched: [],    |
       |                        |                          |  contentHash} with agent DID  |
       |                        |                          |  keypair (canonical JSON)     |
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

## Decision leg — operator decides → Gateway applies

```
Kernel (/jin)                gateway-approvals-bridge.ts        OpenClaw Gateway       OpenClaw system-agent
       |                              |                                |                       |
  operator taps                       |                                |                       |
  Approve/Deny                        |                                |                       |
       |                              |                                |                       |
       |--kernel signs & publishes--->|                                |                       |
       |  operator.approval.decided   |  (delivered over the plugin's  |                       |
       |  {proposalId, decision,      |   EXISTING, already-           |                       |
       |   decidedBy, decidedAt}      |   authenticated kernel WS —    |                       |
       |  via bus_event fan-out       |   #1884 grant-bound event      |                       |
       |  (#1884)                     |   subscription, capability     |                       |
       |                              |   operator:approvals)          |                       |
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
       |                              |--approval.get(proposalId)----->|                       |
       |                              |<--current snapshot-------------|                       |
       |                              |  {status, presentation.        |                       |
       |                              |   proposalHash}                |                       |
       |                              |                                |                       |
       |                              |--status != pending? no-op,     |                       |
       |                              |  log, evict, STOP (idempotent: |                       |
       |                              |  already applied/expired)      |                       |
       |                              |                                |                       |
       |                              |--currentHash != the hash this  |                       |
       |                              |  bridge signed at request      |                       |
       |                              |  time? -----------------------------------------+      |
       |                              |                                |                 |      |
       |<--POST /notify/api/send------|                                |                 |      |
       |  scope: operator.approval.   |                                |                 |      |
       |  mismatch (best effort;      |                                |                 |      |
       |  no dedicated kernel         |                                |                 |      |
       |  handling in v1)             |                                |                 |      |
       |                              |  STOP — never call             |<----------------+      |
       |                              |  approval.resolve              |                        |
       |                              |                                |                        |
       |                              |--hashes match: map decision--->|                        |
       |                              |  approve -> allow-once,        |                        |
       |                              |  deny -> deny; call            |                        |
       |                              |  approval.resolve              |                        |
       |                              |  {id, kind: "system-agent",    |                        |
       |                              |   decision}                    |                        |
       |                              |                                |--apply / discard------>|
       |                              |<--{applied, approval}----------|  proposal              |
       |                              |  (a resolve error/conflict is  |                        |
       |                              |   logged, never crashes the    |                        |
       |                              |   bridge)                      |                        |
```

## Trust chain summary

`plugin-signed request` → `operator decides on /jin` → `kernel witnesses` →
`plugin verifies signer + hash` → `Gateway approval store`.

The kernel does not cryptographically verify the plugin's request signature
in v1 (`ima-jin/imajin-ai#2059`'s target-shape ruling defers that to the
human-countersign follow-up); this bridge's own verification on the decision
leg — kernel-witnessed transport + exact operator DID match + content-hash
match against the Gateway's current proposal — is what stands in for it
today. The bridge never bypasses the Gateway's own approval store: it only
ever relays a verified decision to `approval.resolve`.
