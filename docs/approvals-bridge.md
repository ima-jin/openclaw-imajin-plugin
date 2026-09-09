# Gateway approvals bridge — sequence (#24)

Plugin half of `ima-jin/imajin-ai#2059` (kernel half merged in
`ima-jin/imajin-ai` PR #2078). See `README.md` → "Gateway approvals bridge"
for config keys and what was deliberately left out of v1.

## Request leg — proposal staged → kernel notification

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
