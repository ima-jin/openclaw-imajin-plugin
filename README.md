# @openclaw/imajin-plugin

OpenClaw plugin for the [Imajin](https://jin.imajin.ai) sovereign identity and settlement network.

## What it does

Gives your OpenClaw agent access to the Imajin network through five tools mapping to Imajin's five primitives:

| Tool              | Primitive   | What it does                                                 |
| ----------------- | ----------- | ------------------------------------------------------------ |
| `imajin_identity` | Identity    | Look up DIDs, resolve handles, check trust graph connections |
| `imajin_attest`   | Attestation | List and create signed attestations                          |
| `imajin_transact` | Settlement  | Check MJNx/MJN balances, view transaction history            |
| `imajin_fair`     | Attribution | Inspect .fair manifests — who made what and who gets paid    |
| `imajin_discover` | Discovery   | Search the network for people, businesses, events, stubs     |

## Configuration

In `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "imajin": {
        "enabled": true,
        "config": {
          "nodeUrl": "https://jin.imajin.ai",
          "did": "did:imajin:...",
          "keypairPath": "/path/to/.jin-identity.json"
        }
      }
    }
  }
}
```

- **`nodeUrl`** (required) — URL of the Imajin node
- **`did`** (optional) — Agent's DID for authenticated requests
- **`keypairPath`** (optional) — Path to Ed25519 keypair for signing attestations
- **`attestation`** (optional) — configures the `agent_end` → `agent.turn.usage` hook (#1843):
  - **`attestation.enabled`** — explicit opt-out; defaults to `true` when `serviceUrl` + the key both resolve
  - **`attestation.serviceUrl`** — base URL for `POST /auth/api/attestations/internal`; defaults to `nodeUrl`
  - **`attestation.internalApiKey`** — Bearer token for that endpoint; falls back to the `ATTESTATION_INTERNAL_API_KEY` env var
- **`approvalBridge`** (optional, requires `did` + `keypairPath`) — routes OpenClaw gateway approvals to /jin (#1816):
  - **`approvalBridge.pinnedApproverPublicKeyHex`** — Ed25519 public key (hex) of the sole trusted human approver; see "Approval bridge" below
- **`wsNotifications`** (optional) — WS notification → agent session wiring (#1672); see "Wake on Warp completion" below:
  - **`wsNotifications.hookToken`** — Bearer token for the Gateway's `POST /hooks/agent`; a plain string, or (recommended, #20) a SecretRef object resolved via the plugin SDK; falls back to the `IMAJIN_WAKE_HOOK_TOKEN` env var
  - **`wsNotifications.hooksPath`** — Gateway hooks base path; defaults to `/hooks`
  - **`wsNotifications.hookAgentId`** — agent id to route the wake hook to; defaults to `main`
  - **`wsNotifications.wakeSettleMs`** — leading-edge settle window in ms (#25); default `10000` (10s); see "Coalescing" below
  - **`wsNotifications.wakeCoalesceMs`** — trailing coalesce window in ms (#25); default `30000` (30s, was `300000`/5min); see "Coalescing" below
  - **`wsNotifications.wakeOwedMaxAgeMs`** — age bound in ms (#30) for a persisted "wake owed" marker replayed at startup; older markers are dropped (their frames already reached the agent via the durable system-event queue) instead of firing a stale wake; default `3600000` (1h); see "Ack, dedup, and persisted wakes" below
  - **`wsNotifications.stateDir`** — directory for this injector's persisted state (#26): the ack-dedup LRU and pending-wake markers; defaults to a directory colocated with `keypairPath` (see "Ack, dedup, and persisted wakes" below)
- **`approvals`** (optional, requires `did` + `keypairPath`) — publishes staged Gateway proposals from one or more sources to the kernel and applies signed operator decisions from /jin (#24, generalized by #33); see "Gateway approvals bridge" below:
  - **`approvals.enabled`** — explicit opt-in; `false`/omitted means nothing opens
  - **`approvals.operatorDid`** — the operator's Imajin DID
  - **`approvals.sources`** — which sources to drive (#33): `"system-agent"` and/or `"skill-workshop"`; defaults to both when omitted. A source left out neither lists nor subscribes.
  - **`approvals.gatewayToken`** — optional bearer override for the plugin's own loopback Gateway operator connection(s); a plain string or a SecretRef object; Gateway auth otherwise resolves automatically from the host's own config
  - **`approvals.notifyWebhookSecret`** — bearer value for the kernel's `POST /notify/api/send` `x-webhook-secret` header; a plain string or a SecretRef object; falls back to the `IMAJIN_NOTIFY_WEBHOOK_SECRET` env var; required for the bridge to publish anything

### Turn-usage attestation

After every agent turn, the plugin emits a self-signed, unilateral `agent.turn.usage`
attestation (issuer == subject == the agent's own DID) to the Imajin kernel, recording
per-turn token usage, cost, and context usage — including $0 turns from local models.
This is fire-and-forget: it never blocks, retries, or fails the turn, and any error is
logged and dropped.

The claim also carries a `transcript` pointer + hash (#1865): `sessionId` / `path` /
`messageIds` / `lineRange` point at the turn's lines in the OpenClaw session JSONL
(`agents/<agent>/sessions/<sessionId>.jsonl`), and `contentSha256` is a SHA-256 hash of
the turn's message batch. The transcript content itself is never uploaded or embedded —
only a pointer plus a tamper-evident hash, so a later disclosure can be verified against
the signed claim without the content ever leaving the agent's own machine.

## Roadmap

- [ ] Memory corpus supplement — agent's attestation chain as searchable memory
- [ ] Entity context hook — auto-decorate prompts with Imajin identity context
- [x] Background service — persistent node connection, auth refresh (#1904)
- [ ] Webhook receiver — push Imajin events (messages, transactions) into agent sessions
- [ ] Chat bridge — send/receive messages as a DID via Imajin chat
- [x] Approval bridge — route OpenClaw gateway approvals to /jin, resolve from signed decisions (#1816)
- [x] Ack-confirmed delivery, dedup, and persisted pending wakes (#26)
- [x] Gateway approvals bridge — publish staged Gateway proposals to the kernel and apply signed decisions from /jin (#24)
- [x] Generic source-adapter bridge + Skill Workshop source (#33)

### Approval bridge (#1816)

When `approvalBridge.pinnedApproverPublicKeyHex` is configured (alongside `did` +
`keypairPath`), the plugin can act as a signed bridge between OpenClaw gateway
approvals (exec elevation, Skill Workshop proposals) and a human approver on /jin:

- **Request leg** (`ApprovalBridge.publishRequest`, `src/approval-bridge.ts`): signs
  `{ requestId, kind, summary, requesterDid, expiresAt }` as this agent's DID and
  publishes it as an `openclaw.approval.requested` bus event over the plugin's
  existing authenticated WS (`ImajinWsService.send`).
- **Decision leg**: an inbound `approval.decision` WS frame is verified — in this
  order — against (a) the pinned approver's Ed25519 public key, (b) the *signed*
  request id (not just the frame's outer routing field), and (c) the original
  request's expiry. Only then is `resolveApprovalOverGateway`
  (`openclaw/plugin-sdk/approval-gateway-runtime`) called to resolve the gateway's
  pending approval (`approve` → `allow-once`, `reject` → `deny`). Expired,
  mismatched, or unsigned decisions are rejected and logged, never resolved.
- **Trust model**: the authenticated WS session (channel-trust) is never sufficient
  on its own to resolve an approval — every decision must carry the approver's
  signature. Standing/auto-approval (`allow-always`) is intentionally unreachable
  from this bridge; that is a separate delegation-grant feature.
- **Known gap**: nothing yet calls `publishRequest` automatically. OpenClaw has no
  generic, non-channel plugin hook for "a new exec/plugin approval was raised" —
  the supported path is registering as a full `ChannelPlugin` with an
  `approvalCapability.nativeRuntime` (see the `TODO(#1816 request leg)` comment in
  `index.ts`), which is a larger lift tracked as follow-up alongside the existing
  "Imajin chat as a full messaging channel" TODO.

### Gateway approvals bridge (#24, generalized by #33)

Plugin half of `ima-jin/imajin-ai#2059` (kernel half merged in imajin-ai PR
#2078), generalized into a source-adapter model by #33 (companion kernel
issue `ima-jin/imajin-ai#2152`). When a source (OpenClaw system-agent, or
Skill Workshop) stages a proposal awaiting the operator's decision, this
bridge carries that decision to and from /jin without ever bypassing that
source's own backing store. See `docs/approvals-bridge.md` for sequence
diagrams, including the generic leg.

**Sources** (`approvals.sources`, default both):

| Source | File | Backing store | Decision labels |
| --- | --- | --- | --- |
| `system-agent` | `src/sources/system-agent.ts` | OpenClaw Gateway `openclaw.approval.*` / `approval.resolve` | Approve / Deny (default) |
| `skill-workshop` | `src/sources/skill-workshop.ts` | Gateway `skills.proposals.*` | Apply / Reject |

**What it does, per source**

1. Each `ApprovalSource` (`src/sources/types.ts`) observes its own pending
   items via `list()` (startup reconcile, so an item staged while the
   plugin was down is not missed) and `subscribe()` (live discovery).
   `system-agent` opens the plugin's OWN loopback OpenClaw Gateway operator
   connection, scoped `operator.approvals` only, via
   `openclaw/plugin-sdk/gateway-runtime`'s `createOperatorApprovalsGatewayClient`
   (the same helper the OpenClaw CLI's own `openclaw approvals` tooling
   uses) and listens for `openclaw.approval.requested`. `skill-workshop`
   reuses the same connection-bootstrap helper (see "Known limitation"
   below) and polls `skills.proposals.list` on an interval — there is no
   SDK-exposed "a new proposal appeared" push event; `skills.proposals.
   events.list` is real but scoped to one already-known proposal's own
   revision history, not a discovery feed.
2. The bridge signs and publishes one `operator.approval.requested` kernel
   notification per pending item, tagged with that source's id and a
   namespaced `kind` (`"system-agent:restart"`, `"skill-workshop:update"`,
   etc. — #2152's open kind/source vocabulary). `detail` is ALWAYS present
   (#2084): each source's own native anti-tamper pin rides inside it as
   `detail.sourceRevision`, alongside whatever per-kind fields the source
   adds — Skill Workshop's `{skillName, kind, scan, description,
   diffSummary}` — so the operator-facing card is fully covered by
   `contentHash` (see "The trust chain" below for the exact digest).
3. Subscribes on the plugin's EXISTING kernel WebSocket
   (`src/ws-service.ts`) for the resulting `operator.approval.decided` bus
   event (delivered via the kernel's #1884 grant-bound event-subscription
   fan-out — the agent's own DID needs an active delegation grant for the
   `operator:approvals` capability on the kernel side; see "Live check
   before enabling" below). Before ever touching a source, it verifies the
   event's `issuer`/`subject`/`decidedBy` all equal the configured
   `approvals.operatorDid` exactly, then (#2084) checks the decided event's
   own `contentHash` matches what was staged, refetches that source's
   CURRENT state (`ApprovalSource.getCurrent`), and recomputes the digest
   from the current `sourceRevision` + `detail` to confirm it STILL matches.
   Only when both checks pass does it call
   `source.resolve(id, decision, sourceRevision)` — for `system-agent`
   that maps `approve → allow-once`, `reject`/`deny → deny`; for
   `skill-workshop` that calls `skills.proposals.apply`/`reject` with the
   matching `expectedRevisionHash` (the Gateway itself then fails closed on
   a stale hash). A mismatch publishes a best-effort kernel notice and
   either leaves the stale entry tracked (`system-agent`, exact #24
   behaviour) or evicts + immediately re-lists that one source so the
   operator sees a fresh card (`skill-workshop`, #33's "revision drift →
   no apply + re-stage").

**Known limitation**: the plugin SDK's only exported loopback-operator-
connection factory (`createOperatorApprovalsGatewayClient`) declares
`scopes: ["operator.approvals"]`; `skills.proposals.list` needs
`operator.read` and `skills.proposals.apply`/`reject` need
`operator.admin`. The `skill-workshop` source reuses that same factory
since no scope-parameterized alternative is exposed at this SDK version —
if a deployment's Gateway enforces per-connection scope checks strictly,
those RPCs will surface as a logged, swallowed error (never crashing the
bridge) rather than succeed. Flagged as follow-up work for the OpenClaw
plugin SDK.

**The trust chain**

`plugin-signed request` → `kernel recomputes + verifies contentHash` →
`operator decides on /jin` → `kernel witnesses` → `plugin verifies signer +
hash (twice)` → `Gateway approval store`. Concretely:

- **`contentHash` digest (#2084)**: `"sha256:" + sha256hex(canonicalize({
  proposalId, source, kind, summary, keysTouched, detail}))` — exactly
  those six keys, matching the kernel's OWN recomputation
  (`ima-jin/imajin-ai#2154`), which returns 400 on mismatch. There is no
  top-level `sourceRevision`: each source's native anti-tamper pin rides
  INSIDE `detail` as `detail.sourceRevision`, so `detail` is always present
  and the pin is covered by the hash. The plugin signs the SAME canonical
  object with the agent's existing DID keypair (the same one used for
  challenge-response).
- The kernel does not verify the Ed25519 *signature* in v1 (see
  `ima-jin/imajin-ai#2059`'s "target shape" comment — the human countersign
  step is a follow-up); it DOES verify `contentHash` by recomputing it
  itself and rejecting the request on mismatch, then stores the
  notification and renders the /jin confirm card from the validated
  payload.
- The operator decides on /jin; the kernel signs and publishes
  `operator.approval.decided` (echoing back `contentHash`) with its own
  node key, over the #1884 event-subscription channel this plugin already
  holds an authenticated session on.
- The plugin verifies the decision is kernel-witnessed (delivered over that
  grant-scoped, already-authenticated session) and attributed to exactly
  the configured operator DID, then verifies (a) the decided event's own
  `contentHash` matches what was staged, and (b) a digest recomputed from
  the source's CURRENT state still matches — before ever calling
  `approval.resolve` / `skills.proposals.apply`/`reject`.

**Config keys**: `approvals.enabled`, `approvals.operatorDid`,
`approvals.sources` (optional, defaults to both), `approvals.gatewayToken`
(optional), `approvals.notifyWebhookSecret` (required to publish) — see
"Configuration" above.

**What the Gateway payload did / didn't expose for `keysTouched`**

The Gateway's `SystemAgentApprovalRequestPayload` (`openclaw/src/infra/
system-agent-approvals.ts`) exposes only a human `description` string, a
free-text `title`/`command`, and a `proposalHash` — there is no structured
list of touched config keys. `keysTouched` is therefore always published as
an empty array; the /jin card's `summary` (the Gateway's already-redacted
`description`) is the only human-readable detail carried. `kind` is a
disclosed heuristic over that same free text (`deriveProposalKind`) for the
same reason — the Gateway payload has no structured kind field either.

**What was deliberately left**

- **`operator.approval.mismatch`** is published as a generic kernel
  notification (same `POST /notify/api/send`, scope
  `operator.approval.mismatch`) since no dedicated kernel-side handling for
  this scope exists (it was not part of the merged #2059/PR #2078
  contract). It reaches the operator via the standard notify channels
  (in-app/email) but will not render as a dedicated /jin card — that is
  kernel-side follow-up work, out of scope here.
- A `withdrawn` decision is a documented no-op: `approval.resolve` has no
  "withdraw" for a system-agent proposal already forwarded to it.
- The plugin's own Ed25519 request-*signature* is not yet verified by the
  kernel (see the trust-chain section above — the kernel does verify
  `contentHash` itself, per #2084) — signature verification lands with the
  human-countersign follow-up (`ima-jin/imajin-ai#2059` step 2).

**Live check before enabling**: per the #24 investigation, system-agent
approval records "appear broadly visible" to any `operator.approvals`-scoped
connection, but per-record visibility is filtered by requester/reviewer
binding and this needs a live check against your own Gateway deployment
before relying on it — confirm that the operator-scoped connection this
bridge opens can actually see the specific system-agent records you expect
it to see (and none it shouldn't) before flipping `approvals.enabled: true`
in a shared environment.

### Wake on Warp completion (#18)

When a Warp run completes (or fails) and the owner is idle, the plugin runs a
real agent turn in the owner's configured session by calling the local
OpenClaw Gateway's `POST /hooks/agent` — a first-class, documented,
upgrade-safe surface (see `docs/automation/webhook.md` in the OpenClaw core
repo). This replaces an earlier bundled-only `scheduleSessionTurn` approach
(#11–#17) that silently never worked for a third-party plugin like this one.

**1. Enable the Gateway's webhook ingress.** In the *Gateway's own*
`openclaw.json` (the operator's config, not this plugin's `config` block):

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}", // shared secret; see "Auth" below
    path: "/hooks", // optional, this is the default
    allowedAgentIds: ["main"], // must include wsNotifications.hookAgentId (default "main")
  },
}
```

**2. Configure this plugin** with the matching token and the session to wake.

The recommended form (#20) points `hookToken` at the *same* secrets-store
entry the Gateway's own `hooks.token` references, via a SecretRef object —
so the token is stored exactly once, not duplicated between the Gateway's
config and this plugin's config:

```json
{
  "plugins": {
    "entries": {
      "imajin": {
        "config": {
          "wsNotifications": {
            "injectScopes": ["warp.run.completed"],
            "wakeSessionKey": "agent:main:telegram:direct:8321865723",
            "hookToken": { "source": "store", "provider": "default", "id": "OPENCLAW_HOOKS_TOKEN" }
          }
        }
      }
    }
  }
}
```

This is resolved once (at plugin startup / config reload, never per
request) via the OpenClaw plugin SDK's `openclaw/plugin-sdk/secret-ref-runtime`
(`resolveSecretRefValues`) — the same secret-resolution mechanism the
Gateway itself uses for `hooks.token`. A plain string also still works
unchanged:

```json
"hookToken": "${OPENCLAW_HOOKS_TOKEN}"
```

Resolution order is config SecretRef → config plain string → the
`IMAJIN_WAKE_HOOK_TOKEN` env var (same pattern as
`attestation.internalApiKey`) → none, in which case a single startup
warning is logged and the wake hook is disabled (the `directSend` fallback
still works). The token is never logged or echoed at any point, including
when a SecretRef fails to resolve.

**3. Validate and restart the Gateway** so both config changes take effect:

```bash
openclaw config validate
openclaw gateway restart
```

**4. Smoke-test the hook directly** before relying on a real Warp completion:

```bash
curl -i http://127.0.0.1:<port>/hooks/agent \
  -H "Authorization: Bearer $HOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: wake-test-001' \
  --data '{"message":"Wake-path test: reply with exactly WAKE_OK","name":"wake-test","agentId":"main","sessionMode":"persistent","sessionKey":"<owner session key>","deliver":true}'
```

A `200` response means the run was admitted; the reply should land in the
target session's transcript shortly after. Anything else (non-200,
connection refused, or a ~10s timeout) falls back to the deterministic
Telegram ping from `directSend` (#14) — the same backstop that fires when
the hook is disabled entirely.

#### Coalescing (#25)

Warp wake turns coalesce in two phases, so a single completion doesn't wait
out the same window a burst needs:

- **Leading edge.** The first qualifying notification in an idle window
  fires its own wake after `wsNotifications.wakeSettleMs` (default `10000`,
  10s). Any further notification arriving before that settle elapses joins
  the same leading wake.
- **Trailing batch.** Once the leading wake fires, any notification arriving
  within the next `wsNotifications.wakeCoalesceMs` (default `30000`, 30s —
  was `300000`/5min) batches into ONE follow-up wake fired at that window's
  end. A burst therefore produces at most two wake turns: one leading, one
  trailing.

Both wakes of one window share the window's start time but are kept
distinct via a `:leading`/`:trailing`-suffixed `Idempotency-Key`
(`imajin-wake:<scope>:<windowStart>:<leading|trailing>`), so a notification
the kernel replays (#26) can never double-wake either one.

If wakes feel slow, `wakeSettleMs`/`wakeCoalesceMs` are the knob to check —
not the kernel sweep. A stale trailing-only 5-minute default was previously
found to be the *entire* user-visible wake lag (~5m10s for a single
completion) even though the kernel path itself was fast (#25).

#### Drain, not fan-out: in-flight cap and owed-wake replay (#30)

A `POST /hooks/agent` call is a full agent turn, serialized by the Gateway
per session — so offering it more than one wake at a time for the same
session just queues turns behind each other without helping anything land
sooner. This plugin now caps itself to **one in-flight wake POST per
session**: every wake — a live coalesce firing or a startup replay — funnels
through one queue per `wakeSessionKey`, and a queued wake waits for the
current one to *settle* (admitted, wake-pending, or retries-exhausted)
before its own attempt starts.

Startup replay also **merges** every owed marker for the same scope into a
single wake instead of firing one per marker: a scope can accumulate several
owed markers across many failed flushes before a restart (each failed flush
retains its marker but still returns the in-memory scope to idle, so the
next notification opens a brand-new window) — replaying each one
individually is exactly the fan-out that can storm the Gateway with dozens
of simultaneous wake attempts. The merged replay uses the union of every
marker's frames, the earliest `sinceTs`, and always fires as the `leading`
phase.

An owed marker older than `wakeOwedMaxAgeMs` (default `3600000`, 1h) is
dropped instead of replayed: its frames already reached the agent's context
via the durable `enqueueSystemEvent` queue when they were first received, so
waking a possibly hours-stale turn just for those notifications adds no
value. This logs `owed wake expired for <scope> (N frame(s), age …ms) —
injected only` and clears the marker; the agent still sees the context on
its next natural turn.

#### Wake-pending: timeout and admission-timeout 503 aren't failures (#31)

Two `POST /hooks/agent` outcomes mean the wake is already running or queued
— not refused — so retrying only adds more queued turns behind it:

- A **client-side timeout** (`HOOK_REQUEST_TIMEOUT_MS`, 10s): the Gateway
  accepted the POST but the agent turn didn't return in time — a normal turn
  routinely takes longer than that.
- A **503 whose JSON body carries a `runId`**: the Gateway queued the run but
  couldn't start it before its admission window. A runId-less 503 (or any
  other non-2xx/network failure) is unaffected and still walks the
  `HOOK_RETRY_DELAYS_MS` ladder to the Telegram fallback exactly as before.

Either outcome logs one `wake pending for <scope>: N notification(s), M
frame(s) durable` info line — never the per-attempt retry-warning spam — and
keeps the owed marker instead of escalating to the Telegram fallback. A
later 2xx for the same scope (during this run, or on a future replay subject
to `wakeOwedMaxAgeMs` above) clears it exactly like any other successful
wake.

### Real-time notifications (#1904)

When `keypairPath` is configured, the plugin opens a persistent, authenticated
WebSocket to the kernel's `/chat/ws` endpoint (`src/ws-service.ts`), registered
via `api.registerService` so it starts and stops with the plugin lifecycle:

- **Auth:** the same Ed25519 challenge-response flow as `client.ts`. Prefers
  the `ws` package (`Cookie` header on the upgrade request); falls back to
  native WebSocket + the kernel's short-lived WS token exchange
  (`GET /chat/api/ws-token`) when `ws` isn't resolvable in the host sandbox.
- **Reconnect:** exponential backoff (2s → 60s cap) on any drop.
- **Auth refresh:** re-authenticates ahead of the kernel's 24h session expiry,
  and immediately on an `auth_required`/auth `error` frame from the kernel.
- **Notifications:** `{ type: "notification" }` frames (see #1645) are
  validated and handed to registered frame handlers; `wsNotifications` in
  `openclaw.json` controls which scopes (e.g. `warp.run.completed`) wake the
  agent session (#1672). Unrecognized scopes and malformed frames are logged
  and dropped — they never crash the socket.

### Ack, dedup, and persisted wakes (#26)

The kernel side of this contract (`ima-jin/imajin-ai#2099`) re-offers a
notification on reconnect — up to 3 times — until the plugin acknowledges it,
so a gateway crash between the kernel's `ws.send()` and this plugin actually
receiving the frame can no longer strand the notification forever. This
plugin implements its half of that contract:

- **Ack frame.** After `inject()` has durably enqueued the system event for a
  notification (the `enqueueSystemEvent` call succeeding), the plugin sends
  `{ "type": "notification_ack", "id": "<notification id>" }` back over the
  same authenticated WS connection (`ImajinWsService.send`). The ack is never
  sent before that durable step, and never sent at all when the socket isn't
  open — the kernel just replays on the next reconnect in that case.
- **Dedup by id.** A small persisted LRU of the last 500 durably-injected
  notification ids lives at `<stateDir>/notification-ack-dedup.json`. A
  replayed id that's already in the LRU is acked again but never re-injected,
  re-pinged, or re-batched into a wake.
- **Persisted pending wakes.** Every mutation of the in-memory coalesce
  buffer (a new wake batch opening, or another notification joining one
  already open) is mirrored to `<stateDir>/pending-wakes.json`, keyed by
  `scope:windowStart` (the same window id used in the wake hook's
  `Idempotency-Key`). A gateway restart inside the coalesce window used to
  silently drop the buffered wake (#2098 Candidate B); now, on the next
  start, any owed wake found in that file is flushed immediately — no fresh
  `wakeCoalesceMs` wait. The marker is cleared only once the wake hook
  reports a 2xx.
- **Hook retry with backoff.** A non-2xx/network failure from
  `POST /hooks/agent` is retried 3 times (5s / 15s / 45s backoff) before
  falling back to the #14 Telegram ping; the owed marker is kept through the
  retries and even through the Telegram fallback, and is cleared only on an
  eventual 2xx (whether that happens during this run or after a later
  restart).
- **State directory (`wsNotifications.stateDir`).** Defaults to a directory
  named `imajin-ws-state` colocated with `keypairPath` (e.g.
  `/path/to/imajin-ws-state/` next to `/path/to/.jin-identity.json`).
  Persistence is best-effort: a missing/corrupt state file degrades to empty
  state rather than throwing, and this plugin still works exactly as before
  (in-memory-only dedup/coalesce, no cross-restart durability) if `keypairPath`
  and `stateDir` are both unset.

## Development
Run `npm run typecheck` (`tsc --noEmit -p .`) and `npm test` (vitest) before sending a PR. `openclaw` is declared as an optional `peerDependency` (the gateway supplies it at runtime); the `openclaw/plugin-sdk/*` imports in `index.ts` (static) and `src/notification-injector.ts` / `src/gateway-approvals-bridge.ts` (dynamic — only on the SecretRef paths, #20, and the live Gateway/kernel wiring in `gateway-approvals-bridge.ts`'s `createLiveGatewayApprovalsClient`, #24) are typed via a minimal hand-written ambient declaration (`src/types/openclaw-plugin-sdk.d.ts`) instead of installing the full `openclaw` package locally, since it's very large and recent releases gate `npm install` behind a strict Node engine check.

## About Imajin

Imajin (今人) is sovereign technology infrastructure — federated identity, .fair attribution, MJN/MJNx settlement, and discovery. No subscriptions, no cloud dependency, no vendor lock-in.

- **Network:** [jin.imajin.ai](https://jin.imajin.ai)
- **Protocol:** [protocol.dfos.com](https://protocol.dfos.com)
- **Code:** [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
