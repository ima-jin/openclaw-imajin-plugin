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
| `imajin_discover` | Discovery   | Search non-soft identities by handle/name/DID fragment; no events, market, or stub search |
| `imajin_vault`    | Vault       | Fetch owner-granted secrets (delegation grants) as protected handles — values never enter model context (#40); `ack` signs what the agent did with a fetched grant (#42) |
| `imajin_usage`    | Usage       | Read-only spend: `summary` (UTC range → totals + per-day, per provider/vendor/source; **incurred** = our meter and **billed** = counterparty statement kept separate and labeled, plus drift) and `rollup` (public signed `usage.rollup` attestation). Acts for `onBehalfOf` (default `actAs`); the kernel's 401/403 surface as errors (#72) |
| `imajin_warp`     | Warp        | Dispatch/inspect Warp cloud agents; `list_runs` takes `compact: true` to drop `statusMessage` + artifact `data` per run (plugin-side, kernel call unchanged) for wide spend/volume pulls (#72) |
| `imajin_cloudflare` | Cloudflare | DNS-only writes, classification, proxy/cache previews and human-approved proposals, settings/SSL, custom hostnames and signed history through kernel-only zone grants; never fetches a Cloudflare token (#98) |

### Warp usage units (#111)

`imajin_warp` `get_run` and `list_runs`, in both full and `compact: true` output,
label each run's `requestUsage` with `credits`, `usdEst`, and `unit: "warp_credits"`.
The original `inferenceCost`, `computeCost`, and `platformCost` fields are **Warp
credits, not dollars**, and remain unchanged. `credits` sums them with null/missing
values treated as zero (including missing usage on in-progress runs).
`usdEst` is a USD estimate rounded to two decimal places, not a billing statement.

`list_runs` also returns `totals: { credits, usdEst }` for the entire fetched page,
before the full view's 20-run display cap (compact displays up to 500 runs).
Totals do not include other pages; follow `nextCursor` for those. Total `usdEst`
is calculated from summed credits and then rounded, not from rounded per-run USD.
Empty pages return `runs: []` with zero totals and the normal pagination fields.

Set `plugins.entries.imajin.config.warp` to `{ "usdPerCredit": 0.0154 }` to
override the conversion rate. The default approximates $100 per 6,500 credits;
the rate must be finite and non-negative (zero is allowed).
For example, `260.4375 + 12.3017 + 109.8067` yields `382.5459` credits and
`usdEst: 5.89` at the default rate.

### Cloudflare zone access (#98)

Setup: **seal the zone token on /jin, then grant the agent DID the zone capabilities on the zone card**.
Use this plugin's own `did` and normal `keypairPath` session, not the MCP proxy's
app identity. There is no Cloudflare config field, environment variable, token
import/fetch/export action, or direct provider request in this tool.

Every action takes `zoneId` (32 lowercase hexadecimal characters) and `domain`
(the exact lowercase verified zone domain, not a record's subdomain):

- `dns_list`, `dns_create` (`record`: `type`, `name`, `content`, `ttl`),
  `dns_update` (`recordId` + partial `record`), `dns_delete` (`recordId`).
  Creation is **DNS-only**. Never include `proxied` in create/update:
  either boolean is rejected locally with `proxy_approval_required`, without
  a request. To edit the name/type/target of a proxied record, first disable
  its proxy through the approval rail and wait for the human countersignature.
- `proxy_set` (`recordId` + boolean `proxied`) sends a **single-change bulk
  preview/proposal**, never a DNS PATCH. Proxy changes go through kernel
  classification and a human countersignature on `/jin`.
- `classification` reads the kernel's per-host report: decisions, reasons,
  blocking routes, remedies, route evidence, proxy before/after states,
  proposed proxy batches/cache rules and warnings. Requires `cloudflare:read`;
  it never writes, stages approvals, overrides classification, or applies
  the report automatically. Unsafe/unclassified hosts stay DNS-only.
- `settings`, `ssl`, `cache_rules_list`.
- `cache_rules_replace` (`rules`, at most 20 ordered cache rules). Each rule has
  `expression`, `action: "set_cache_settings"`, `action_parameters` (`cache`
  and/or `edge_ttl`), `enabled`, and optional `ref`/`description`.
- `bulk_proxy` (`changes`: 1–20 `{recordId, proxied}` pairs).
- `hostnames_list`, `hostname_create` (`hostname`, `ssl: {method: "txt" | "http",
  type: "dv"}`), `hostname_status` / `hostname_delete` (`hostnameId`, a UUID).
- `history` returns the kernel's node-signed envelope unchanged, including
  `issuerDid`, `issuedAt`, `payload.actorDid`, `payload.onBehalfOf`, before/after
  state and `signature`. The kernel attributes every change to the authenticated
  **agent DID**, on behalf of the verified zone owner from the grant.

`onBehalfOf` follows the other tools: omitted uses `actAs`, an explicit DID
sets the delegation header, and `"self"` suppresses that header. None of these
replace the authenticated agent or the kernel's exact-zone grant checks.
Reads require `cloudflare:read`; DNS/proxy requires `cloudflare:dns`, SSL
requires `cloudflare:ssl`, cache replacement requires `cloudflare:cache`, and
hostname writes require `cloudflare:custom-hostnames`.

`proxy_set`, `bulk_proxy` and `cache_rules_replace` default **`dryRun: true`**, returning the
kernel's before/after preview without mutation. Explicit `dryRun: false` stages
a proposal and returns `{status: "pending_approval", proposalId, next}`:
**pending — approve on /jin (proposal &lt;id&gt;)**. A human must countersign on
`/jin` → Operator approvals; nothing changes until then. The plugin cannot
approve, poll-and-approve, or call an operator-approval decision route. Proxy-on
eligibility is checked by the kernel during preview/staging and again before
approved execution; proxy-off remediation remains available. Ordinary
DNS/hostname writes are immediate; they do not support `dryRun`.

403 returns “no Cloudflare authority for this zone — grant it on /jin” with
the kernel error code; 409 `credential_unavailable` returns “token not sealed
for this zone — seal it on /jin”. All mapped 409 messages retain their kernel
code in the text:
- `proxy_approval_required`: use `proxy_set`/`bulk_proxy` preview, then
  `dryRun: false` to request human approval on `/jin`; omit `proxied` in DNS writes.
- `disable_proxy_before_edit`: disable proxying through the approval rail
  and wait for countersigning before editing the record's name/type/target.
- `proxy_classification_blocks`: read `classification` for blocking routes
  and remedies; do not retry unchanged or bypass classification.
- `credential_unavailable`: seal the token on `/jin`.

Other conflicts retain their own code (for example stale before-state), never
claim a missing token. No retries
or fallback authority. Zone discovery is intentionally absent: the auth
contract currently lists delegator-owned grants, not the agent's received
zone grants ([kernel gap #3005](https://github.com/ima-jin/imajin-ai/issues/3005),
native sub-issue of [#2995](https://github.com/ima-jin/imajin-ai/issues/2995)).
Classification policy remains kernel-owned (`ima-jin/imajin-ai#3004`, implementing
#2996); the plugin only reads the report and submits explicit previews/proposals.

## Configuration

Identity lookup uses `GET /auth/api/lookup/{did}`. Handles/names first resolve via
`GET /auth/api/search?q=...&limit=20` (exact handle preferred, then exact name,
then the first fuzzy match). Discovery uses the same search route: minimum two
characters, up to 20 non-soft identities; `type` filters that page locally by
exact scope/subtype (for example `business` or `human`).
Connections uses `GET /connections/api/connections` for the queried DID as the
effective principal. It requires that DID's session or authorized
`connections:read` delegation; it is not a public arbitrary-DID graph endpoint.
An explicit `onBehalfOf` must agree with the query DID.

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
- **`warp.usdPerCredit`** (optional) — USD estimate per Warp credit; defaults to `0.0154` ($100 per 6,500 credits, approximately).
- **`attestation`** (optional) — configures the `agent_end` → `agent.turn.usage` hook (#1843):
  - **`attestation.enabled`** — explicit opt-out; defaults to `true` when `serviceUrl` + the key both resolve
  - **`attestation.serviceUrl`** — base URL for `POST /auth/api/attestations/internal`; defaults to `nodeUrl`
  - **`attestation.internalApiKey`** — Bearer token for that endpoint; falls back to the `ATTESTATION_INTERNAL_API_KEY` env var
- **`approvalBridge`** (optional, requires `did` + `keypairPath`) — routes OpenClaw gateway approvals to /jin (#1816):
  - **`approvalBridge.pinnedApproverPublicKeyHex`** — Ed25519 public key (hex) of the sole trusted human approver; see "Approval bridge" below
- **`wsNotifications`** (optional) — WS notification → agent session wiring (#1672); see "Wake on Warp completion" below:
  - **`wsNotifications.hookToken`** — Bearer token for the Gateway's `POST /hooks/agent`; a plain string, or (recommended, #20) a SecretRef object resolved via the plugin SDK; falls back to the `IMAJIN_WAKE_HOOK_TOKEN` env var
  - **`wsNotifications.directSend`** — deterministic in-process OpenClaw channel delivery for completion pings, wake disclosures/alerts, bridge warnings, and opt-in reach escalation. `channel` defaults to `telegram`; `target` is the configured recipient. Uses the host's `runtime.channel.outbound.loadAdapter(channel)` and `sendText({ cfg, to, text })` contract (verified from published `openclaw@2026.10.4`), with a 20-second deadline and abort signal. Hosts without that outbound runtime fail explicitly; no CLI fallback or subprocess is used. `cliPath` remains accepted but is deprecated and ignored. No configuration migration is needed.
  - **`wsNotifications.hooksPath`** — Gateway hooks base path; defaults to `/hooks`
  - **`wsNotifications.hookAgentId`** — agent id to route the wake hook to; defaults to `main`
  - **`wsNotifications.sessionPerWake`** — defaults to `true`; derives fresh batch sessions from `wakeSessionKey`/`targetSession` (default `agent:main:warp-events`); `false` opts into guarded fixed-key reuse without template tokens
  - **`wsNotifications.maxSessionTokens`** — reuse guard threshold; default and ceiling `50000`, with a `24000`-token pre-injection reserve
  - **`wsNotifications.maxWakeTokens`** — per-session context ceiling, default `80000`; applies independently to the wake and every decision child; never adds usage across turns or sessions
  - **`wsNotifications.model`** — optional coordinator model; omitted uses the host's configured wake-agent model
  - **`wsNotifications.wakeModel`** — optional string selecting the wake coordinator only (e.g. `"wakeModel": "imajin/kimi-k3"`); takes precedence over legacy `model`, never changes any gateway/agent default or `decisionModel`, and needs no provider keys. Unset, empty, or whitespace-only preserves the existing hook payload/routing (including legacy `model`, if configured). The host's read-only catalog and model policy resolve the override; unavailable/disallowed models or a failed/timed-out lookup warn and omit the override so the gateway uses its default. At the first root `llm_input`, each wake logs one `[imajin-ws] wake model="provider/model" source=wakeModel|default|model batch=…` line naming the actual model, not merely the requested one (`source=model` identifies the legacy option). Decision children and informational reports keep their existing routing.
  - **`wsNotifications.decisionModel`** — decision subagent model, default `anthropic/claude-opus-5-5`; review/merge/enqueue/dispatch tools run only in pinned subagents, not the coordinator
  - **`wsNotifications.wakeReadOnlyLookups`** — defaults to `false` (option c: coordinate only); explicit `true` enables allowlisted reads only when no PR is known or every run in the batch is FAILED. It never permits coordinator review, approve, merge, enqueue or dispatch.
  - **`wsNotifications.githubCliPath`** — trusted absolute GitHub CLI path for live PR reads; default `/usr/bin/gh`; set the installed absolute path (e.g. `/opt/homebrew/bin/gh` on macOS), never a PATH-resolved command
  - **`wsNotifications.wakeTimeoutMs`** — completion watchdog; default `900000` (15 minutes), clamped to `1..3600000`ms, independent of `reportTo`
  - **`wsNotifications.bridgeStatePath`** — bounded continuity file; default `<stateDir>/wake-bridge.json` (32 KiB, 50 records, 6 KiB prompt contribution)
  - **`wsNotifications.horizonEnabled`** — defaults to `false`; no-op without an injected harness adapter pending #2881
  - **`wsNotifications.wakeSettleMs`** — leading-edge settle window in ms (#25); default `10000` (10s); see "Coalescing" below
  - **`wsNotifications.wakeCoalesceMs`** — trailing coalesce window in ms (#25); default `30000` (30s, was `300000`/5min); see "Coalescing" below
  - **`wsNotifications.wakeOwedMaxAgeMs`** — age bound in ms (#30) for already-injected legacy/fixed pending markers; default `3600000` (1h); fresh `injected: false` markers do not silently age-expire
  - **`wsNotifications.reportTo`** — explicit disclosure session keys; when unset/empty, disclosure uses `directSend.channel` (default `telegram`) and `directSend.target`; without either destination, startup warns once and silent-ending monitoring is disabled
  - **`wsNotifications.stateDir`** — directory for this injector's persisted state (#26): the ack-dedup LRU and pending-wake markers; defaults to a directory colocated with `keypairPath` (see "Ack, dedup, and persisted wakes" below)
- **`approvals`** (optional, requires `did` + `keypairPath`) — publishes staged Gateway proposals from one or more sources to the kernel and applies signed operator decisions from /jin (#24, generalized by #33); see "Gateway approvals bridge" below:
  - **`approvals.enabled`** — explicit opt-in; `false`/omitted means nothing opens
  - **`approvals.operatorDid`** — the operator's Imajin DID
  - **`approvals.sources`** — which sources to drive: `"system-agent"` and/or `"skill-workshop"` (#33) default on when this array is omitted; `"imajin-catalog"` (opt-in per-model gating for newly discovered `imajin/*` models, #36) and `"gateway-exec"` (#38, OpenClaw host-exec approvals) are opt-in ONLY and must be listed explicitly — neither is ever included in that default; gateway-exec grants remote-execution-grade `operator.approvals` authority over live host-exec approvals. A source left out neither lists nor subscribes.
  - **`approvals.gatewayToken`** — optional bearer override for the plugin's own loopback Gateway operator connection(s); a plain string or a SecretRef object; Gateway auth otherwise resolves automatically from the host's own config
  - **`approvals.notifyWebhookSecret`** — bearer value for the kernel's `POST /notify/api/send` `x-webhook-secret` header; a plain string or a SecretRef object; falls back to the `IMAJIN_NOTIFY_WEBHOOK_SECRET` env var; required for the bridge to publish anything
  - **`approvals.skillWorkshop.operatorScopes`** — operator scopes (#35) for the `skill-workshop` source's OWN loopback Gateway connection; defaults to `["operator.read", "operator.admin"]` when omitted or `[]` (#53) — exactly what `skills.proposals.list`/`apply`/`reject` require, fixing `FORBIDDEN: missing scope: operator.read` on strict/token-mode gateways; set `["operator.approvals"]` to opt out of the broader authority; see "Gateway approvals bridge" below
  - **`approvals.loopBlockSweepIntervalMs`** — how often (ms) the bridge re-checks the approvals it holds a loop block for and clears blocks whose approval was settled outside /jin (#66); default `60000`, floor `5000`, `0` disables; see "Blocked on an operator approval" below
  - **`approvals.requireOperatorCountersignature`** — mirrors the kernel's `OPERATOR_COUNTERSIGN_REQUIRED` (#44, `ima-jin/imajin-ai#2082`); default `false` (a decision missing `operatorSignature` is still applied, unchanged v1 behavior); `true` rejects any decision (including a withdrawal) that lacks a valid `operatorSignature` before it ever reaches a source — see "Operator countersignature" below
- **`inferProxyBaseUrl`** (optional) — base URL of the local kernel inference proxy every discovered `imajin/<id>` model is registered with (completions go through it, #36); defaults to `http://127.0.0.1:8787/openai/v1`; see "Kernel brains as OpenClaw models" below
- **`modelDiscovery`** (optional, #55) — model discovery against the kernel; needs `nodeUrl` + `keypairPath`:
  - **`modelDiscovery.refreshIntervalMs`** — periodic re-discovery interval; default `300000` (5 min), floor `10000`, `0` = start-up discovery only
  - **`modelDiscovery.modelsPath`** — kernel route, default `/infer/v1/models/usable`
  - **`modelDiscovery.breakGlassModel`** — optional existing direct `provider/model` ref, never a key; the approved default migration can retain the old direct default here. Used only for confirmed kernel/passthrough transport outages, subject to live model policy.
- **`mcpUrl`** (optional, #50) — local passthrough `/mcp` endpoint `imajin_status` probes; defaults to the `inferProxyBaseUrl` root + `/mcp` (`http://127.0.0.1:8787/mcp`); see "Kernel MCP tools" below

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

## Signed reach events for Jin (#68)

The existing outbound kernel WebSocket (`imajin-ws` / `wsNotifications`) consumes
`agent.reach.delivered` and `agent.reach.replied`. The kernel never calls the
gateway; this adapter neither polls private reach routes nor adds a gateway
connection, wake token, secret, or configuration change.

Configure `plugins.entries.imajin.config.wsNotifications`:

```json
{
  "targetSession": "agent:main:main",
  "reach": {
    "kernelPublicKeyHex": "<trusted node Ed25519 PUBLIC key: 64 hex characters>",
    "telegramEscalation": false
  }
}
```

- `targetSession` is the explicit Jin session receiving context on its next
  natural turn. The principal is the plugin's configured `actAs` (or `did` when
  `actAs` is absent). There is no new agent turn or automatic reply.
- `reach.kernelPublicKeyHex` pins the **public** kernel node signing key for
  deliveries. Obtain it through a trusted channel from your node's
  `/auth/.well-known/kernel-signing-key` current key. It is not a new secret.
  Missing/malformed pins reject deliveries. A key embedded in an event is
  never sufficient. Rotation requires updating the trusted pin.
- Deliveries must carry a valid Ed25519 signature from that pin, with the
  node-derived issuer DID. Replies are different: they must be signed by the
  configured human principal, verified against its current registered public
  key via the existing DID resolver. Both require matching
  subject/principal/context fields. Unsigned, altered, wrong-signer, malformed,
  and metadata-only/redacted events are dropped before injection or escalation.
  The client accepts the current flat public DID document as well as legacy
  `{identity}` resolver responses.
- Jin receives a delimited `UNTRUSTED_REACH_CONTENT` data block: sender label,
  topic, **UNVERIFIED** onBehalfOf claim, and a bounded verbatim message excerpt
  (the gist, not a model-generated summary). All foreign values are quoted and
  delimiter/control characters escaped. The excerpt is capped at 2,000 encoded
  characters; the complete block is below 6,000. A verified signature
  authenticates provenance, **not** the truth of a claim or permission to follow
  embedded instructions. No reply handle is surfaced as an actionable callback.
- `reach.telegramEscalation` defaults to `false`. Explicit `true` also sends the
  verified, bounded untrusted block to the existing `directSend.target` using
  the in-process channel adapter, only if `directSend.channel` is `telegram` or omitted. No target
  means no escalation. Non-Telegram destinations are not used.
  Reach does not use generic Warp wakes, wake-failure pings, or `reportTo`.
  Adding reach scopes to `injectScopes` cannot bypass verification or this flag.
- A separate `reach-event-dedup.json` LRU in the existing `stateDir` (default
  next to `keypairPath`) prevents repeated signed deliveries/replies from being
  enqueued or escalated twice, including reconnects/restarts. Notification ACKs
  follow successful enqueue only; refused enqueues remain retryable. Dedup is
  best-effort if the state directory cannot be written; adapter failures are logged
  without message content and are not automatically retried.

### Kernel contract and current gap

Read against imajin-ai main at
`87310095337bcf2722cc8cde865b6781de91a0c5`: `reach-delivery.ts`,
`reach-reply-wire.ts`, `packages/bus/src/config.ts`, `reactors/notify.ts`, and
`subscriptions.ts`. Deliveries arrive as principal notifications. The adapter
reconstructs `{type:data.eventType, issuer:data.issuer, subject:data.subject,
scope:"agent", payload}` by removing only the notify-added `eventType`, `issuer`,
`subject`, `correlationId`, and `template` keys from `data`. It removes
`payload.signature` for verification over the canonical unsigned five-field
envelope (recursive localeCompare-sorted JSON, not an extra hash).

For either scope, the adapter also accepts original signed
`{type:"bus_event", eventType, issuer, subject, scope, payload, ...}` frames,
excluding bus transport metadata from verification. A future replied
notification must preserve the same notify data shape. Unknown signed payload
fields remain covered; the adapter does not discard fields to make a signature
pass.

**[gap(kernel) #2859](https://github.com/ima-jin/imajin-ai/issues/2859):** replies
currently go privately to the original requester, not to the principal's Jin
observer. Delivered has no bus subscription/cursor recovery; delegated
`register_also` notifications are live-only and cannot ACK/replay the
principal's backlog. Delegation revocation also needs a delivery-time check.
The plugin supports the signed reply shape behind this gap but does not claim
that principal reply fanout works on the current kernel, widen requester
entitlements, or fetch the private inbox as a workaround. Live verified delivery
already lets Jin describe a stranger's speaking request on its next turn;
principal-side reply observation/recovery awaits that kernel fix.
Ordinary requester-side receipts from a different principal are intentionally
not injected into this principal-observer session.

## Kernel brains as OpenClaw models (#36)

Sealing a connector card on `/jin` becomes the whole OpenClaw model
provisioning act. The plugin registers `imajin` as a real OpenClaw model
provider (`api.registerProvider`, not `models.providers` config): every
usable (connector, model) pair the kernel reports
(`GET /infer/v1/models/usable`, `ima-jin/imajin-ai#2201`) shows up as
`imajin/<id>`, named `<id> (via <connector>)`, with zero hand-edited
provider config.

**Two URLs, two jobs**:

- *Discovery* (the catalog) goes straight to the **kernel**:
  `GET <nodeUrl>/infer/v1/models/usable`, authenticated with the plugin's
  existing agent-DID challenge-response session (plus `X-Acting-For` from
  `actAs`, so the list is the principal's usable brains). No static bearer.
  Needs `nodeUrl` + `keypairPath`; without them discovery reports
  `unconfigured` and the plugin still starts. (The kernel's bare
  `/infer/v1/models` is the Anthropic model-catalog passthrough — a different
  shape — so it is deliberately not used; override with
  `modelDiscovery.modelsPath` if that ever moves.)
- *Completions* go through the local passthrough proxy —
  `plugins.entries.imajin.config.inferProxyBaseUrl` (default
  `http://127.0.0.1:8787/openai/v1`) is the `baseUrl` every discovered model is
  registered with, and `GET /healthz` at the proxy root is probed by
  `imajin_status`. There is no user credential to configure.

**Live discovery + refresh (#55)**: discovery runs (1) at plugin start
(the `imajin-model-discovery` service), (2) every
`modelDiscovery.refreshIntervalMs` (default **5 minutes**, floor 10 s, `0`
disables the periodic run), (3) immediately on a kernel notification whose
scope is `connector.credential.sealed`, `connector.credential.unsealed`, or
`connector.models.changed` (`IMAJIN_CATALOG_INVALIDATION_SCOPES`,
`src/imajin-provider.ts` — confirmed against `ima-jin/imajin-ai#2219`) arriving
over the plugin's existing WS connection, and (4) lazily when OpenClaw asks for
the catalog and the 60 s cache has expired. A model added kernel-side therefore
appears in the gateway without a config edit.

Previously the cache was purely lazy — nothing fetched until OpenClaw happened
to ask — so `imajin_status` showed `lastDiscovery.outcome: "never"` forever,
and the only URL it could have tried was the proxy's `/openai/v1/models`
(404, `imajin-ai#2453`) with no auth.

**Failure behaviour**: discovery never crashes plugin start and never wipes the
catalog. On any failure the **last good catalog keeps being served**,
`lastDiscovery` records the failure, and it is logged **once per distinct
failure** (plus one line on recovery). An empty but well-formed list is
authoritative (e.g. the last connector was unsealed) and empties the catalog.
Outcomes:

- `ok` / `empty` — kernel answered with a list (`modelCount` > 0 / 0)
- `unreachable` — kernel did not answer (connection refused, DNS, 5 s timeout,
  or 502/503/504 from a front proxy)
- `route-error` — kernel answered non-2xx (e.g. 404, 500); `httpStatus` is set
- `auth-error` — 401/403, or the DID login/keypair failed
- `malformed` — 2xx but not an OpenAI list
- `unconfigured` — no `nodeUrl`/`keypairPath`

**The allow-list step (one-time)**: OpenClaw's own
`agents.defaults.modelPolicy.allow` accepts trailing prefix wildcards
(confirmed directly against OpenClaw's docs/schema — not guessed), so the
supported one-time operator setting is simply:

```json5
{
  agents: {
    defaults: {
      modelPolicy: { allow: ["imajin/*" /* , ...your other allowed models */] },
    },
  },
}
```

This plugin never writes that config automatically — it is a one-time
manual step, exactly like adding any other provider to an existing
allowlist. If you omit `modelPolicy.allow` entirely (or leave it `[]`),
OpenClaw's own default is "allow any configured model", so `imajin/*`
models are already selectable with no allow-list edit at all.

**Operator-approved live allow-list (`imajin-catalog`, opt-in, #105)**:
add `"imajin-catalog"` to the existing `approvals.sources` bridge configuration.
For restrictive policies, each catalog refresh is reconciled within the source's
15-second poll. One card in **/jin → Operator approvals** lists exact `add` and
`remove` refs. Approving applies exactly that delta through Gateway
`config.get`/`config.patch`; no shell or manual per-model config edit is needed.
Discovery, polling, rejection and failed discovery never write policy.

Dropped `imajin/*` refs require the same approval before removal. Static
`imajin-openai/<id>` / `imajin-xai/<id>` refs are proposed for retirement only
after the discovered `imajin/<id>` equivalent is already allowed (a separate
card after enabling replacements). Wildcards, aliases, other providers,
provider blocks and explicit agent/session models are untouched. The same card
can now propose the inherited-default migration described below (#106). Repoint
explicit lanes before approving a legacy removal if they still use those refs.

Unchanged or reordered catalogs do not duplicate cards. Pending identities and
Ignore decisions survive restarts in the existing private bridge state;
changed deltas require fresh consent. Approval checks the current delta again
and uses Gateway `baseHash` to reject concurrent config edits. If removing the
last entry would produce `[]`, the card explicitly warns that OpenClaw treats
that as **allow any configured model**, not deny-all; reject to keep the
restriction. An omitted/empty policy or covering wildcard already allows the
live models and needs no addition card.

This opt-in source uses its own loopback **`operator.admin`** connection,
required by Gateway config RPCs; no other connection is widened. The host's
existing Gateway auth (or the existing override) must authorize that scope.
Catalog decisions always require the operator's registered-key countersignature,
even when the legacy `approvals.requireOperatorCountersignature` flag is false.
Missing permission/signature fails closed; there is no file-edit fallback.
### Follow the kernel connector pick (#106)

Enable the existing `imajin-catalog` approval source, then approve its single
card on **/jin → Operator approvals**. In addition to any allow-list delta,
`detail.defaultChange` shows the old default and the proposed
`agents.defaults.model = { primary: "imajin/default", fallbacks: [] }`.
The old direct default, if it is an exact non-kernel provider/model ref, is
retained as `modelDiscovery.breakGlassModel` (ref only; auth remains in the
host's existing protected credential store). An existing explicit emergency
ref takes precedence. No direct ref is invented for implicit host defaults.
Ordinary fallback ladders are cleared in this same approved, base-hash-guarded
patch: auth, billing and model errors must not automatically spend directly.
Ignore leaves config unchanged; changed before-state requires fresh approval.

After this one-time consent, **no gateway config edit** accompanies a picker
change. At the next discovery refresh, `imajin/default` resolves to the first
servable row with **boolean** `imajin.picked: true`, preserving the kernel's
connector-resolution order (first sealed/granted connector wins when multiple
cards are picked). It never guesses from an unmarked catalog row.
Select `imajin/<id>` in a session to pin that exact model, even if it equals
the current default; refreshes never rewrite that session. Explicit agent
model settings and deliberate wake/decision pins also stay unchanged.

For a floating-default turn, the pre-model hook probes the local passthrough's
`/healthz`. A transport failure (connection/DNS/timeout or HTTP 502/503/504),
or a discovery transport failure confirmed by a fresh retry, permits the
optional direct ref. Auth/grant/policy failures, HTTP 402/429, route errors,
malformed discovery, missing picks and stale `/healthz` history do **not**.
Both the picked model and emergency ref must satisfy live model policy.
The next turn rechecks reachability, so the emergency ref never becomes a
persisted session override. There is no inference replay after partial output;
an outage first observed during inference fails that attempt rather than
replaying potentially billed work. Discovery working does not prove
completions are healthy.

`imajin_status.defaultRouting` reports `selector`, `pickedModel`,
`fallbackCount`, `lastReason` (`passthrough_unreachable` or
`kernel_unreachable`) and `lastFallbackAt`. These count routing decisions in
the current service lifetime; recovery retains the count and last reason.
The existing `healthz.body` separately exposes the passthrough's own counters.
No credential or raw upstream error is included in the routing reason.

**Doctor/status** (`imajin_status` tool): reports the discovered catalog as
`imajin/<id>` refs, `lastDiscovery` `{ fetchedAt, outcome, modelCount, error?,
httpStatus?, lastGoodAt }`, the kernel `discovery` URL + refresh interval, and a
fresh probe of the proxy's `GET /healthz` body. `allowList.configured` reports
the configured refs (including legacy entries); `allowList.allowListed` and
`allowList.discoveredButNotAllowed` partition the discovered catalog using
OpenClaw's exact/wildcard/empty-policy semantics. All three are `null` if
live config cannot be read, rather than implying permission. Healthy looks like:

```json
{ "lastDiscovery": { "outcome": "ok", "modelCount": 3, "fetchedAt": "..." },
  "catalog": [{ "ref": "imajin/grok-4", "connector": "xai" }, ...] }
```

**Retiring static providers**: the approval source only retires their exact
allow-list refs, never the `models.providers.imajin-xai` / `imajin-openai`
blocks or lane configuration. After replacement `imajin/*` refs are allowed,
repoint any lanes/fallbacks still using legacy refs before approving the
retirement card. Provider-block cleanup is a separate operator choice.

Note completions still depend on the kernel passthrough proxy being healthy
(`imajin-ai#2453`); discovery working does not by itself prove completions do.

## Kernel MCP tools (#50)

The kernel's MCP tools (`google_gmail_*`, `google_calendar_*`, `google_drive_*`,
`google_meet_*`, …) reach the agent as ordinary OpenClaw tools through the
local passthrough's `/mcp` (`ima-jin/imajin-ai#2368`, loopback `:8787`). The
passthrough mints the user-delegated app token per call; **no credential ever
lives in `openclaw.json` and none passes through this plugin.** The kernel never
calls into the gateway — OpenClaw's own MCP client calls the passthrough, the
passthrough calls the kernel.

**Operator step — register the server (one line, no headers, send/write tools
excluded from the start):**

```bash
openclaw mcp add imajin --url http://127.0.0.1:8787/mcp --transport streamable-http --exclude 'google_*_send*,google_*_create*,google_*_update*,google_*_delete*,google_*_trash*,google_*_untrash*,google_*_modify*,google_*_move*,google_*_copy*,google_*_share*,google_*_insert*,google_*_patch*,google_*_draft*,google_*_reply*,google_*_forward*,google_*_archive*,google_*_label*,google_*_upload*,google_*_import*,google_*_append*,google_*_set*,google_*_add*,google_*_remove*,google_*_cancel*,google_*_accept*,google_*_decline*,google_*_watch*,google_*_stop*,google_*_write*'
openclaw mcp doctor imajin --probe
```

The `--exclude` globs (`GATED_TOOL_EXCLUDE_GLOBS` in `src/kernel-mcp.ts`, derived
from the write verbs the plugin gates) make send/write tools opt-in at
registration time: `google_gmail_send`, `google_calendar_create_event` and
`google_gmail_watch` never reach the agent until you enable them. **To enable a
send tool, remove its glob or exact name from `exclude`** (e.g. drop
`google_*_send*`). Equivalent config: `mcp.servers.imajin = { url:
"http://127.0.0.1:8787/mcp", transport: "streamable-http", toolFilter: { exclude:
[ … the globs above … ] } }`. The plugin does not write MCP Gateway config; that check is read-only, so `imajin_status` can
tell you when the entry is missing. The passthrough also needs an `mcp` route
in its `INFER_PROXY_ROUTES_CONFIG` (see its README); without one `/mcp` answers
`422 no_route_configured`, which status reports as `outcome: not-configured`.

**`imajin_status` → `mcp` block** (next to the model catalog): `reachable`,
`outcome` (`ok | unreachable | not-configured | auth-error | route-error |
malformed`), `toolCount`, `googleToolCount`, `registration` (is an
`mcp.servers` entry pointing at the URL, enabled, `streamable-http`, and — as a
warning — whether it sets `headers`; values are never read), `allowlist`, and
`warnings`. The probe is `initialize` + `tools/list` only, sent without any
credential; it never calls a tool.

**Tool allowlist guidance.** Read tools (`google_gmail_list_threads`,
`google_gmail_get_message`, `google_calendar_list_events`,
`google_calendar_free_busy`, `google_drive_*` reads, `google_meet_list_*`) are
meant to be on by default when the attestation carries the matching read scope
(e.g. `google:gmail:read`; the kernel enforces scope per tool call). Send/write
tools — today `google_gmail_send`, `google_calendar_create_event`, and
`google_gmail_watch` (arms a push subscription) — must be an explicit operator
enable. OpenClaw's `mcp.servers.<name>.toolFilter` is the control, and
`imajin_status` computes `allowlist.suggestedToolFilter` for you (a default-deny
`include` list of every discovered tool except the gated ones; unrecognised
`google_*` verbs count as gated). Paste it into the entry:

```json5
mcp: { servers: { imajin: {
  url: "http://127.0.0.1:8787/mcp",
  transport: "streamable-http",
  toolFilter: { include: ["google_gmail_list_threads", "google_gmail_get_message", /* … */] },
} } }
```

Keep this as the stricter, exact-name follow-up to the `--exclude` registration:
the exclude globs only match recognised write verbs and cannot deny an
unrecognised new one, whereas the `include` list denies everything it does not
name. Without any `toolFilter` (e.g. an entry registered without `--exclude`)
every tool the kernel lists is exposed, and status warns
(`allowlist.gatedToolsExposed`). To enable a send tool deliberately, remove its
glob or name from `exclude` (or add its name to `include`). Re-run `imajin_status` after the kernel ships new tools: an
exact-name allowlist never auto-enables them.

**Two agent identities today** (flagged for unification, out of scope here):
MCP calls ride the proxy's app-token lane (`azp=<app>`, `sub=<principal>`, the
`4Mgu…` DID), while chat/media/warp/vault use this plugin's own agent DID
(`ADEK…`). Attestations granted to one do not apply to the other.

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
- [x] Imajin OpenClaw model provider — live catalog from the kernel passthrough, WS-driven refresh, allow-list via operator approval (#36)
- [x] gateway-exec source — forward OpenClaw host-exec approvals to /jin, resolve allow-once/deny (#38)
- [x] `imajin_vault` — owner→agent credential handoff via delegation grant, values kept out of model context (#40, kernel half ima-jin/imajin-ai#2231); see `docs/vault-handoff.md`
- [x] `approvals.skillWorkshop.operatorScopes` — scope-parameterized loopback Gateway client for the skill-workshop source, fixing #35's `FORBIDDEN: missing scope` on strict/token-mode gateways
- [x] Operator countersignature verification — `operator.approval.decided` is verified directly against the operator DID's own key, not just the kernel's witness signature (#44, kernel half `ima-jin/imajin-ai#2082`/`#2158`)
- [x] `operator:approvals` preflight, loud degraded mode, and `operator.approval.decided` catch-up on every WS (re)connect (#53)
- [x] Kernel MCP tools (google_*, calendar, drive) via the local passthrough `/mcp` — registration one-liner, `imajin_status` MCP reachability + tool count, send/write allowlist guidance (#50, proxy half `ima-jin/imajin-ai#2368`)

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

**Sources** (`approvals.sources`; `system-agent` + `skill-workshop` default on, `gateway-exec` is opt-in ONLY — see "gateway-exec source" below):

| Source | File | Backing store | Decision labels |
| --- | --- | --- | --- |
| `system-agent` | `src/sources/system-agent.ts` | OpenClaw Gateway `openclaw.approval.*` / `approval.resolve` | Approve / Deny (default) |
| `skill-workshop` | `src/sources/skill-workshop.ts` | Gateway `skills.proposals.*` | Apply / Reject |
| `gateway-exec` | `src/sources/gateway-exec.ts` | OpenClaw Gateway `exec.approval.*` | Allow once / Deny (never Always) |

**What it does, per source**

1. Each `ApprovalSource` (`src/sources/types.ts`) observes its own pending
   items via `list()` (startup reconcile, so an item staged while the
   plugin was down is not missed) and `subscribe()` (live discovery).
   `system-agent` opens the plugin's OWN loopback OpenClaw Gateway operator
   connection, scoped `operator.approvals` only, via
   `openclaw/plugin-sdk/gateway-runtime`'s `createOperatorApprovalsGatewayClient`
   (the same helper the OpenClaw CLI's own `openclaw approvals` tooling
   uses) and listens for `openclaw.approval.requested`. `skill-workshop`
   uses that same connection-bootstrap helper BY DEFAULT, or the #35
   scoped one when `approvals.skillWorkshop.operatorScopes` is set (see
   below), and polls `skills.proposals.list` on an interval — there is no
   SDK-exposed "a new proposal appeared" push event; `skills.proposals.
   events.list` is real but scoped to one already-known proposal's own
   revision history, not a discovery feed.
2. The bridge signs and publishes one `operator.approval.requested` kernel
   notification per pending item, tagged with that source's id and a
   namespaced `kind` (`"system-agent:restart"`, `"skill-workshop:update"`,
   `"gateway-exec:command"`, etc. — #2152's open kind/source vocabulary).
   `detail` is ALWAYS present
   (#2084): each source's own native anti-tamper pin rides inside it as
   `detail.sourceRevision`, alongside whatever per-kind fields the source
   adds — Skill Workshop's `{skillName, kind, scan, description,
   diffSummary}` — so the operator-facing card is fully covered by
   `contentHash` (see "The trust chain" below for the exact digest).
3. Subscribes on the plugin's EXISTING kernel WebSocket
   (`src/ws-service.ts`) for the resulting `operator.approval.decided` bus
   event (delivered via the kernel's #1884 grant-bound event-subscription
   fan-out — the agent's own DID needs an active delegation grant for the
   `operator:approvals` capability on the kernel side; the bridge checks
   this at startup, every five minutes, before stale publishes, and on every reconnect and fails loudly when it is
   missing, and replays anything the socket missed — see "Approvals grant
   preflight, degraded mode, and catch-up (#53)" below; also "Live check
   before enabling"). Before ever touching a source, it verifies the
   event's `issuer` and `decidedBy` equal the configured
   `approvals.operatorDid` exactly and its `subject` (the addressee of one
   per-recipient copy) is the operator DID or this agent's own DID, then
   (#2084) checks the decided event's
   own `contentHash` matches what was staged, then (#44) verifies the
   operator's own `operatorSignature` — see "Operator countersignature"
   below — then refetches that source's CURRENT state
   (`ApprovalSource.getCurrent`), and recomputes the digest from the
   current `sourceRevision` + `detail` to confirm it STILL matches.
   Only when every check passes does it call
   `source.resolve(id, decision, sourceRevision)` — for `system-agent`
   that maps `approve → allow-once`, `reject`/`deny → deny`; for
   `skill-workshop` that calls `skills.proposals.apply`/`reject` with the
   matching `expectedRevisionHash` (the Gateway itself then fails closed on
   a stale hash). A mismatch publishes a best-effort kernel notice and
   either leaves the stale entry tracked (`system-agent`, exact #24
   behaviour) or evicts + immediately re-lists that one source so the
   operator sees a fresh card (`skill-workshop`, #33's "revision drift →
   no apply + re-stage").

### Approvals grant preflight, degraded mode, and catch-up (#53)

The kernel pushes `operator.approval.decided` over the agent's WebSocket
ONLY to DIDs whose ACTIVE delegation grant carries the `operator:approvals`
capability (`packages/bus/src/subscriptions.ts` / `packages/auth/src/grant-scopes.ts`
in `ima-jin/imajin-ai`). Without it the kernel pushes nothing and raises no
error: the /jin card sat at "approved — pending apply" forever. The plugin
cannot self-grant this (the grant is the owner's to author, not the
kernel's to auto-grant), so it now:

1. **Preflights** the capability — once at bridge startup (before the first
   reconcile publishes any card) and again after the kernel's auth-ok on
   EVERY WS (re)connect, every five minutes while connected, and before a
   publish if the previous check is at least five minutes old. It reads the agent's own effective entitlement
   from `GET /auth/api/events/subscriptions/catchup` (as the agent itself,
   never through `actAs`): `entitledEventTypes` contains
   `operator.approval.decided` exactly when an active grant carries
   `operator:approvals`. No new kernel endpoint is used.
2. **Fails loud**, once, when it is missing: a single ERROR log naming the
   agent DID, the missing capability, and the exact grant the owner must
   author —
   `POST /auth/api/grants {"agentDid":"<agent>","capabilities":["operator:approvals"],"audience":{"type":"dids","values":["<operatorDid>","<agent>"]}}`
   (or `PUT /auth/api/grants/{grantId}/capabilities/operator:approvals` on an
   existing active grant). The audience must allow both the operator DID and
   the agent DID: the kernel publishes each decision once per recipient.
   The bridge is marked **degraded** and, for every proposal it publishes
   while degraded, logs and sends (via `wsNotifications.directSend`, Telegram
   by default) `⚠ bridge cannot apply: agent lacks operator:approvals …`.
   Warnings use the in-process channel outbound adapter (never the CLI),
   deduped across publish attempts and boots. The signed request also carries
   `detail.bridge = {degraded:true, reason, fix:"/auth/agents"}`. This marker
   remains pinned to the original card during decision-time hash checks;
   recovery never silently rewrites what the operator signed.
   An inconclusive check (kernel unreachable) is NOT treated as degraded and
   is retried within five minutes.
3. **Catches up** on every (re)connect and periodic check once entitled,
   including immediately after renewal is detected: re-reconciles pending
   source items, then reads `operator.approval.decided` events from the
   kernel's durable `kernel.event_subscription_log` (the same catch-up route)
   since the persisted cursor and applies each through the SAME handler as
   the live WS path — so operator identity, `contentHash` echo, operator
   countersignature, and source-drift checks are identical. Applying an
   already-applied decision is a no-op (the proposal is no longer tracked /
   pending), and a live push racing a replay for the same proposal shares one
   in-flight run. The cursor lives in
   `<stateDir>/approvals-decided-cursor.json` (`wsNotifications.stateDir`,
   default: `imajin-ws-state/` next to `keypairPath`), is scoped to node URL +
   agent DID, only ever advances (never from a live frame — live pushes can
   skip a seq, the durable read cannot), and stops at the first event whose
   handling failed transiently so the next check/reconnect retries it. A missing or
   corrupt cursor file just replays the retention window (safe, idempotent).

The decided event addressed to the agent has `subject` = the agent DID (the
kernel publishes one copy per recipient, `ima-jin/imajin-ai#2337`); the
bridge accepts `subject` ∈ {operator DID, agent DID}, while `issuer`,
`decidedBy`, and the countersignature must still be the operator.

**Known limits**: the entitlement read is not audience-aware, so a grant
that carries `operator:approvals` but whose audience excludes the operator/
agent DID passes the preflight yet still receives nothing (catch-up applies
nothing either). Cards published while degraded keep their original content
after recovery; the grant simply makes them applicable.

**Native expiry and orphan safety (#103).** Both `system-agent` and
`gateway-exec` publish `detail.expiresAt` from the Gateway record's own
`expiresAtMs` (never an invented TTL), so the panel's existing expiry check
disables stale pending cards. An untracked, source-gone, or expired proposal
can never resolve an approval. Boot/reconnect and periodic reconcile compare
persisted proposals against successful source lists; a failed list is not
evidence of deletion. Proposal metadata, terminal local outcomes and successful
warning dedupe are scoped to node + agent + operator in
`<stateDir>/approvals-bridge-state.json`, with ordered atomic writes.

**Kernel gaps verified against live `/spec` (2026-10-20).** No grantee-readable
grant expiry is exposed ([imajin-ai#3018](https://github.com/ima-jin/imajin-ai/issues/3018)),
so T-24h/T-1h warnings cannot be scheduled honestly; startup logs that limitation.
Renew at **/auth/agents → the grant → Renew**; effective entitlement recovers
within five minutes without a Gateway restart. There is no documented signer
expiry/withdrawal route ([imajin-ai#3019](https://github.com/ima-jin/imajin-ai/issues/3019)),
so orphan outcomes are recorded locally as `expired/superseded`, logged and
warned once through Telegram rather than forging an operator decision. The
kernel card cannot yet be terminalized remotely. The current panel also ignores
the generic signed `detail.bridge` marker
([imajin-ai#3020](https://github.com/ima-jin/imajin-ai/issues/3020)); Telegram/log
remain the visible degraded warning until that renderer lands.

### Operator countersignature (#44, `ima-jin/imajin-ai#2082`/`#2158`)

Before #44, this bridge trusted the kernel's own witness signature on the
`operator.approval.decided` WS envelope (`issuer`/`subject`/`decidedBy` ==
`approvals.operatorDid`) as the ONLY authority for a decision. That proves
the kernel *recorded* a decision, never that the operator *actually made*
it — a compromised kernel alone could forge an approval. The kernel now
ships a second, independent signature (`operatorSignature`), produced
client-side on /jin with the operator's OWN key, over
`canonicalize({contentHash, decision, decidedAt, mode?, replyMessage?})`, with
the **bare lowercase hex** hash (the bus event retains `sha256:<hex>`).
This bridge verifies
that signature **directly against the operator DID's registered Ed25519
public key** (resolved via this plugin's EXISTING DID resolver,
`ImajinClient.getIdentity` — `GET /registry/api/identity/:did` — never a
second resolver, and never the kernel's witness signature) before ever
treating a decision as authoritative. This applies uniformly to every
decision, including a withdrawal.

**Who signs what:**

| Field | Who signs it | Who verifies it (this plugin) |
| --- | --- | --- |
| `contentHash` (on the request) | This plugin's agent DID keypair, at publish time | The kernel, at ingest (400 on mismatch) |
| Kernel witness `signature` (on the decided WS envelope) | The kernel's own node key | Channel/identity check only (`issuer`/`subject`/`decidedBy` == `approvals.operatorDid`) — proves the kernel recorded a decision, NOT that the operator made it |
| `operatorSignature.sig` | The operator's own key, client-side on /jin | **This plugin**, directly against the operator DID's current registered public key — never the kernel's witness signature |
| `operatorSignature.keyId` | — (identifies the signer) | Must equal the resolved operator public key exactly; a mismatch is treated identically to an unknown or revoked key |

The fields verified (`contentHash`, `decision`, `decidedAt`) are
reconstructed from THIS bridge's own `tracked.contentHash` — the value it
itself published in the matching `operator.approval.requested` — never a
value read off the wire event, since that is exactly what the operator's
/jin client actually signed over.

**Config knob** (`approvals.requireOperatorCountersignature`, mirrors the
kernel's `OPERATOR_COUNTERSIGN_REQUIRED`): while `false` (default), a
decision with no `operatorSignature` is still applied — unchanged v1
behavior — but any `operatorSignature` that IS supplied is ALWAYS verified,
and a malformed or invalid one is ALWAYS rejected regardless of this flag.
Once `true`, a decision (including a withdrawal) lacking a valid
`operatorSignature` is rejected before it ever reaches a source.

**Rollout order** (do this before flipping anything):

1. The kernel ships `operatorSignature` on every decision already, with its
   own `OPERATOR_COUNTERSIGN_REQUIRED` off — nothing changes for an
   unmigrated plugin (`ima-jin/imajin-ai#2158`).
2. This plugin (#44) verifies `operatorSignature` against the operator
   DID's public key on every decision it receives — live, regardless of
   either flag.
3. Once #44 is confirmed live and verifying correctly, set
   `approvals.requireOperatorCountersignature: true` in this plugin's own
   config, AND have the operator set `OPERATOR_COUNTERSIGN_REQUIRED=true`
   on their kernel node (defense in depth — this plugin's own verification
   never depends on that kernel flag being on).

**Known gap**: there is no kernel route today that surfaces the kernel
node's own `OPERATOR_COUNTERSIGN_REQUIRED` value, so
`approvals.requireOperatorCountersignature` cannot "discover" and mirror it
automatically — each side is set independently.

**Fixed in #35 (interim, config-gated)**: the plugin SDK's only exported
loopback-operator-connection factory (`createOperatorApprovalsGatewayClient`)
declares `scopes: ["operator.approvals"]`; `skills.proposals.list` needs
`operator.read` and `skills.proposals.apply`/`reject` need `operator.admin`.
On a Gateway that enforces per-connection scope checks strictly (token-mode
auth), the `skill-workshop` source's connection through that factory can
never satisfy those RPCs — every poll failed closed with `FORBIDDEN:
missing scope: operator.read`, logged and swallowed on every single poll.

Set `approvals.skillWorkshop.operatorScopes` to grant this source's own
loopback connection the scopes it actually needs instead:

```json5
{
  plugins: {
    entries: {
      imajin: {
        config: {
          approvals: {
            enabled: true,
            operatorDid: "did:imajin:operator",
            skillWorkshop: {
              operatorScopes: ["operator.read", "operator.admin"],
            },
          },
        },
      },
    },
  },
}
```

`operatorScopes` defaults to `["operator.read", "operator.admin"]` when
omitted or `[]` (#53; it used to default to `[]`, which left the source
failing every poll on token-mode gateways) — startup logs the defaulted
scopes once. To opt out of the broader authority, set
`["operator.approvals"]` (the SDK factory's own scope). Only `operator.read`, `operator.admin`,
`operator.approvals`, and `operator.write` are accepted; an unrecognized
entry fails plugin startup with a clear error rather than silently opening
a connection the Gateway will reject anyway (`src/gateway-operator-
client.ts`'s `assertKnownOperatorGatewayScopes`). When set, the source opens
its Gateway connection via `createOperatorGatewayClient` (`src/gateway-
operator-client.ts`) instead of the SDK factory — see that file's module
doc for exactly how it builds the connection and how it differs from the
SDK's own factory (loopback-only, no operator-approval-runtime-token
shortcut). A missing-scope RPC error is now logged exactly ONCE (not once
per poll) with a pointer back at this config key, and the poll backs off
rather than repeating the same doomed request every interval.

**Authority**: `operator.admin` on this connection lets the plugin itself
apply/reject Skill Workshop proposals — this is the intended authority,
not scope creep: this bridge IS the component that applies a proposal once
the operator approves it on /jin (see "What it does, per source" above and
`docs/approvals-bridge.md`'s trust chain). The scope is confined to this
one loopback connection, granted by default only to the `skill-workshop`
source (#53) or as configured, and never includes the unrelated `operator.questions`/`operator.pairing`/
`operator.talk`/`operator.talk.secrets` scopes the real Gateway also
supports.

**Removal plan**: this is an interim fix pending an upstream, scope-
parameterized loopback-connection factory in the OpenClaw plugin SDK
(tracked as `openclaw/openclaw#TBD`, filed alongside #35). Once that ships,
`src/gateway-operator-client.ts` should be deleted and every caller should
switch back to the SDK's own factory with the scopes it then accepts.

### gateway-exec source (#38)

Forwards pending OpenClaw **host-exec** approvals (`tools.exec.mode: "ask"`/
`"auto"`, or a per-agent `ask: "on-miss"`/`"always"`) to /jin as kernel
operator-approvals of kind `gateway-exec:command`, and resolves the
operator's decision back through OpenClaw's own `exec.approval.resolve`. It
is a separate `ApprovalSource` (`src/sources/gateway-exec.ts`) driven by the
same generic bridge described above — see that file's module doc for the
full design rationale (why it subscribes to the Gateway's own `exec.
approval.requested` event rather than registering as an `approvals.exec.
targets` forwarded-channel destination, the identity-only `sourceRevision`,
and outcome reporting).

**Opt-in, off by default.** Unlike `system-agent`/`skill-workshop`,
`gateway-exec` is never enabled just because `approvals.enabled: true` and
`approvals.sources` is omitted — it must be listed explicitly:

```json5
{
  plugins: {
    entries: {
      imajin: {
        config: {
          approvals: {
            enabled: true,
            operatorDid: "did:imajin:operator",
            sources: ["system-agent", "skill-workshop", "gateway-exec"],
            notifyWebhookSecret: { source: "store", provider: "default", id: "IMAJIN_NOTIFY_WEBHOOK_SECRET" },
          },
        },
      },
    },
  },
}
```

#### Required Gateway config for the exec rail (#52)

The plugin can only forward an approval the Gateway actually raises. Beyond
listing `gateway-exec` above, the **Gateway's own** `openclaw.json` needs
host exec that asks:

```json5
// In the OpenClaw GATEWAY's own openclaw.json, not this plugin's config:
{
  tools: {
    exec: {
      host: "gateway", // or "node" — never "sandbox", never "auto" with a sandbox active
      mode: "ask",     // ask-capable baseline; "full"/"allowlist"/unset never ask
    },
  },
}
// Prompt on EVERY command instead (no `mode` equivalent): replace `mode` with
//   security: "full", ask: "always"   (and do not set `mode` alongside them)
```

Why each line matters (per OpenClaw's "Exec tool" / "Exec approvals" docs —
Gateway behaviour this plugin cannot verify from its own process):

- Host approvals are only evaluated for `gateway`/`node` execution. With
  `host: "auto"` and a sandbox runtime active (`agents.defaults.sandbox.mode`
  / `agents.entries.*.sandbox.mode` of `non-main` or `all`), exec stays in the
  sandbox and **no approval is ever raised**, so there is nothing to forward.
- A per-call `ask: "always"` can only *harden* the baseline, and is ignored for
  channel-origin calls (e.g. a Telegram DM) when the effective host ask is
  `off`. With no `tools.exec` block the baseline is `full`/`off`.
- `askFallback: deny` (the ORDERING NOTE below) stays the safe default when no
  approval client is reachable.

**Fail loud, not silent.** At bridge start the plugin logs ONE
`[imajin-approvals-bridge] exec approval rail will not surface ask-gated exec on /jin`
warning if `gateway-exec` is missing from `approvals.sources`, or if the
loaded Gateway config shows a sandbox exec host or an `ask`-less baseline,
with the config above. A malformed `exec.approval.requested` payload is logged
once (key names only, never the command), and a failed source start says
"ask-gated exec will NOT reach /jin". After every loopback Gateway reconnect
the plugin re-lists pending exec approvals (a broadcast raised while the socket
was down is never replayed); the bridge's per-`proposalId` dedup keeps that to
one card.

**Card contract and publish failures (#52).** The kernel rejects a
`gateway-exec:command` card with `400` unless `detail.host`, `cwd`, `agentId`
and `sessionKey` are all non-empty strings (`validateExecCommandDetail`,
`ima-jin/imajin-ai`). OpenClaw sends `cwd: null` for an exec with no explicit
workdir and may omit the agent/session binding, which used to be forwarded as
`null` → `400` → the failure was only logged and the exec waited until its own
timeout (SIGTERM, no card). The source now renders any missing field as the
visible marker `unspecified` (never a guessed value; the command is never
altered). Separately, when a `gateway-exec` card still cannot be published
(transient kernel errors — network, 5xx, 408, 429 — are retried at 0.5 s and
2 s; any other 4xx is permanent and not retried), the bridge now **denies the
Gateway approval** (`exec.approval.resolve` → `deny`, so the exec returns a
clean refusal instead of a timeout), logs an ERROR naming the proposal id and
reason, and sends the same notice through `wsNotifications.directSend`. The
command text is never included in that log or notice. Other sources keep the
old log-and-retry-on-next-event behavior.

**Manual repro** (run with the config above, from the main session):

1. Ask the agent to run `exec` with `command: "echo hi"`, `ask: "always"`,
   `timeoutSeconds: 900`.
2. Within seconds `/jin` shows a pending `gateway-exec:command` card with
   `command: echo hi`; the exec stays blocked.
3. `Allow once` runs it (output `hi`); `Deny` returns a clean refusal, not a
   SIGTERM. Gateway log: `published operator.approval.requested for <id>
   (source=gateway-exec, kind=gateway-exec:command)`.
4. No card? Check, in order: the startup warning above, the
   `operator:approvals` preflight error (#53), then `openclaw approvals get`
   for the effective ask policy.

This source relies on OpenClaw's own **approval forwarding to chat/plugin
channels** being reachable in principle (it observes the same underlying
`exec.approval.*` Gateway surface that feature is built on), documented
under "Approval forwarding to chat channels" in OpenClaw's `tools/exec-
approvals-advanced` docs — the `approvals.exec.targets` snippet there is
OpenClaw's OWN config (not this plugin's), shown here for context:

```json5
// In the OpenClaw GATEWAY's own openclaw.json, not this plugin's config:
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      targets: [{ channel: "telegram", to: "123456789" }],
    },
  },
}
```

**Scope**: like every other source, this one opens the plugin's own loopback
Gateway connection via `createOperatorApprovalsGatewayClient`, which
declares `scopes: ["operator.approvals"]` — the same dedicated,
remote-execution-grade scope OpenClaw's own docs call out as required for
`exec.approval.resolve`/`approval.resolve` ("Minimal scopes for third-party
clients"). No broader scope (e.g. `operator.admin`) is ever requested for
this source.

**ORDERING NOTE**: land this plugin change together with its kernel half
(`ima-jin/imajin-ai#2221`) **before** flipping the Gateway's `ssh` exec
policy from `deny` to `ask` (with `askFallback: deny`). Flipping the policy
first routes approval prompts to the legacy Telegram `/approve` flow this
source is meant to replace, with no /jin card to catch them in the interim.

**Never `allow-always`**: `resolve()` only ever sends `allow-once` or `deny`
to `exec.approval.resolve` — an exhaustive switch over the bridge's generic
`approve`/`reject` decision vocabulary makes any other value (including a
hypothetical `allow-always`) throw rather than reach the Gateway. The
generic bridge itself already drops any kernel-decided value outside
`approve`/`reject`/`withdrawn` before any source is ever touched.

**Outcome reporting**: after the Gateway reports an approved exec finished,
the source posts `{proposalId, exitCode, durationMs, outputHash}` to the
kernel's dedicated outcome endpoint (`ima-jin/imajin-ai` PR #2223, via
`createHttpKernelExecOutcomeClient`):
`POST /notify/api/internal/operator-approvals/outcome`, header
`x-webhook-secret: <NOTIFY_WEBHOOK_SECRET>` (the same secret this bridge
already resolves for every other kernel write). `200 {ok:true}` on success;
`400`/`401`/`404` on a validation error, a bad secret, or an unknown
proposal, respectively. Re-posting for the same `proposalId` OVERWRITES the
previously posted outcome (idempotent by kernel design). The Gateway-side
"exec finished" trigger event this listens for is still an unconfirmed,
narrowly-guarded best-effort placeholder — see the `TODO` in
`gateway-exec.ts`'s module doc.

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
- A verified `withdrawn` decision uses the source's terminal non-apply
  action: `deny` for system-agent/gateway-exec, `reject` for Skill Workshop.
  The bridge forgets the proposal and unblocks its loop. Sources without a
  cancel analog retain a logged no-op.
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

When a Warp run completes (or fails), the plugin runs a real agent turn in a
fresh per-batch worker session by default, calling the local
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
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: ["agent:main:warp-events:"], // permit derived keys
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
        "hooks": { "allowConversationAccess": true },
        "config": {
          "wsNotifications": {
            "injectScopes": ["warp.run.completed", "warp.run.failed", "warp.run.timeout"],
            "wakeSessionKey": "agent:main:warp-events",
            "sessionPerWake": true,
            "maxWakeTokens": 80000,
            "decisionModel": "anthropic/claude-opus-5-5",
            "wakeReadOnlyLookups": false,
            "reportTo": ["agent:main:telegram:direct:8321865723"],
            "directSend": { "channel": "telegram", "target": "8321865723" },
            "hookToken": { "source": "store", "provider": "default", "id": "OPENCLAW_HOOKS_TOKEN" }
          }
        }
      }
    }
  }
}
```

**Set `plugins.entries.imajin.hooks.allowConversationAccess: true`.** This is
outside the plugin's `config` block. OpenClaw refuses external-plugin
`agent_end` registration without this explicit permission, disabling final-size
and turn-outcome monitoring. `reportTo` is not required for monitoring.
Permit every derived wake prefix and any report destination in
`hooks.allowedSessionKeyPrefixes`; direct persistent hooks require this
allowlist as well as `allowRequestSessionKey: true`. A template or dedicated
agent changes the required prefix and `allowedAgentIds`.

`hookToken` is resolved once (at plugin startup / config reload, never per
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
  --data '{"message":"Wake-path test: reply with exactly WAKE_OK","name":"wake-test","agentId":"main","sessionMode":"persistent","sessionKey":"agent:main:warp-events:smoke-test","deliver":true}'
```

A `200` response means admission, not completion. Use a test session beneath
an allowed prefix in the smoke test. A client timeout or a 503 with a `runId`
is ambiguous/queued admission, not permission to issue another wake.
For plugin-dispatched wakes (not this manual smoke test), the independent
completion watchdog alerts through `directSend` if no turn ends; other
admission failures alert on the first failed attempt while retries continue.


#### Live state, bounded work and mandatory disclosure (#82)

Before dispatch, the plugin reads each subject PR with the authenticated `gh`
CLI (`gh pr view`, bounded timeout/output). Install `gh` on the gateway host and
grant its existing identity read access to subject repositories. Set
`githubCliPath` if it is installed outside `/usr/bin/gh`. The preamble
contains state, draft flag, head SHA, mergeability, review decision and CI rollup,
alongside the existing horizon/bridge evidence. **MERGED/CLOSED wins over
mergeable UNKNOWN/null**: terminal subjects receive a one-line directSend
disclosure and are not re-reviewed. Mixed batches retain open or unavailable
subjects; lookup failures are explicitly unavailable, never assumed merged.

The coordinator's tools are restricted to `sessions_spawn`, `sessions_send`, `message` and
`session_status`. Review/approve/merge/enqueue/dispatch work is delegated through
`sessions_spawn` with `runtime: "subagent"` and the configured `decisionModel`;
the plugin overrides attempted model substitutions. The host must allow that
model and the spawn tool. Missing permission/model availability is a blocker,
not permission to fall back to a cheap decision model. Accepted children are
included in wake completion and guard accounting. One-use plugin tickets
correlate children before their first model call, because the host can emit
`subagent_spawned` after a child has already started. A resolved decision model
that differs from the configured model is stopped and alerted, not accepted
as a cheaper fallback.

**Plugin-owned decision yardstick (#101).** Each delegated task gets a
plugin-resolved grading block for every subject PR, even with script-built
packets. Authenticated, bounded GraphQL reads supply `closingIssuesReferences`,
each issue's native `parent` chain through the epic (including cross-repository
parents), verbatim OUTCOME and DECISION ruled lines from bodies/comments, and
review history (reviewer, state, commit SHA). Comments follow the body so later
rulings remain visible. Missing ancestry, an absent epic/OUTCOME, incomplete
pagination or lookup failure is explicitly **UNRESOLVED**: report blocked,
never substitute the coordinator's interpretation.

Decision-child approve/merge/enqueue calls require that exact PR's resolved
block on the child's one-use ticket. Immediately before acting, the plugin
re-reads head/reviews: **any imajin-jin CHANGES_REQUESTED on the current head
stands until a new head lands**, even after a subsequent approval. A changed
head needs a new delegation/grading ticket; old-head change requests do not
veto a freshly graded head. CLI approval bodies and GitHub MCP review bodies
are prefixed with `Graded against: OUTCOME <repo>#<epic> · DECISION <refs> @ <headSha>`
(`none` when there are no DECISION refs).

Use a literal `gh pr review <PR-URL> --approve --body 'evidence'`, or an
explicit PR number plus `--repo owner/repo`; merge has the same exact-target
requirement. GitHub MCP approval/review, merge and enqueue tools use explicit
owner/repo/PR fields. Opaque body files, environment overrides, shell programs
and ambiguous targets fail closed. Raw GraphQL enqueue/merge accepts only one
literal mutation with `input: {pullRequestId: "PR_..."}` (optionally
`expectedHeadOid`) and a `clientMutationId` or `pullRequest { id }` selection,
passed as `gh api graphql -f 'query=mutation { ... }'` or MCP `query`.
Variables, aliases, compound mutations and opaque inputs are refused rather
than guessed; use the direct CLI/MCP operation instead. Raw API approvals are
refused in favor of the body-prefixed approval paths. These are wake tool-call
guards, not a general-purpose shell sandbox.

**Coordinator authority — option c (Ryan, 2026-10-18 11:08).** The wake
model never approves or merges. `before_tool_call` denies direct review,
approve, merge, enqueue and dispatch tools/actions, including shell commands
and typed plugin actions; this is not only prompt guidance. An open-PR wake
must use a `sessions_spawn` subagent pinned to `decisionModel` for that work.

`wsNotifications.wakeReadOnlyLookups` defaults to **false**, so the default is
delegation/reporting only for every wake. Explicit **true** allows a small
read-only tool/action allowlist only for **no-known-PR** wakes or batches in
which **every run is FAILED**. A mixed batch containing a successful open PR
does not gain lookup permission because another run failed. A known PR whose
live lookup failed is not treated as “no PR.” The switch never enables
decision writes, even for FAILED runs.

Eligible opted-in reads are local `read`, `imajin_status`, Warp
`get_run`/`get_transcript`/`list_runs`, process `poll`/`log`, and narrowly
validated `gh pr/run/issue` read commands. GitHub commands are rewritten to
the trusted `githubCliPath` and accept only allowlisted verbs/flags and simple
arguments: arbitrary executables, shell syntax, API mutations, jq/templates,
and environment overrides are refused. Tool visibility and the runtime
tool-call gate use the same eligibility; unknown tools fail closed.

Three identical tool calls (same tool and recursively key-sorted args) with
unchanged output stop the wake, including interleaved polls. Result comparison
uses only content text, error/isError, and details.exitCode/status; duration,
timestamps, cwd and tokenjuice telemetry are not progress. `process` poll/log
calls whose details.status is `running` are exempt and reset the repeat streak;
normal counting resumes once the command exits. Decision children are instructed
to use one bounded `gh pr checks <n> --watch` call instead of polling CI or
mergeability repeatedly, or report blocked with CI pending for the next wake.

`maxWakeTokens` is a **per-session context ceiling**, not a billed-token budget.
Each session's latest assistant call replaces its context measurement:
input + cacheRead + cacheWrite + output. Ten turns at 20k stay at 20k, not
200k; parent 60k plus child 30k do not exceed an 80k ceiling. A single child
at 85k does exceed it and stops the whole wake, aborting parent and children.
Attempt aggregate usage is never treated as context; attempt-end fallback
uses only the last assistant call's own usage. On crossing,
the plugin blocks further tools, requests `chat.abort` for the wake and its
children through the existing loopback gateway adapter, and alerts via
`directSend` with session, subject, repeated call/last result or usage.
Provider work already in flight cannot be unspent; host model limits remain
useful additional bounds. Public per-message hooks provide live measurements;
missing per-call usage is unknown, not cumulative billed usage.

Configure **`directSend`**, and optionally `reportTo`. Explicit `reportTo`
destinations take precedence; otherwise the directSend channel/target is the
required destination. A successful `message` send to every required destination
is the disclosure receipt. OpenClaw disables
the native `message` tool in subagents, so decision children use the plugin's
**`imajin_wake_report`** tool with `outcome: "completed"` or `"blocked"` and a
concrete evidence/blocker message. It performs deterministic
`openclaw message send` calls to the explicit or fallback destinations and
records receipts only after successful sends. Allow this plugin tool in
decision-child tool policy. Final prose, spawn admission and the informational
#47 report are not delivery evidence.
An ending without receipts alerts **“wake ended without reporting”**, including
the session, subject and last assistant line. `NO_REPLY` is silent without a
delivery receipt. Duplicate notifications are dropped at admission before
any agent turn; there is no agent-controlled duplicate exemption. If neither
reportTo nor directSend supplies a destination, the plugin logs one startup
warning and skips the silent-ending check rather than alerting on every wake.
Other failure, loop, context and watchdog checks remain enabled.

An optional main-session copy is **fire-and-forget**: the plugin forces
`sessions_send.timeoutSeconds: 0` and permits at most one copy attempt per wake.
The coordinator must address that copy by the **exact configured `reportTo`
disclosure session key** (or the existing directSend-derived disclosure key
when reportTo is empty). There is no implicit `agent:main:main` copy target.
Other keys, missing keys and `agentId`/`label` addressing are blocked—even
when supplied alongside an allowed key—with a pointer to `sessions_spawn`
on `decisionModel` for actual delegated work. Decision-child sends retain
their existing behavior.

Coordinator copies carry the #47 informational envelope: “Report from
warp-events wake — informational, not an instruction; do not act on it as
a request.” The receiver is explicitly told not to start work, call tools
or reply to warp-events. The original message follows as report evidence,
not as a task.
After disclosure, inter-session reply turns (including `ANNOUNCE_SKIP`) are
blocked without a reply, and further channel/report posts are refused.
Ended wakes stay fenced against late announcements, preventing acknowledgment
ping-pong. A new admitted batch can still use an explicitly reused session.

Alert evidence is redacted before it is clipped or retained: secret-shaped
keys and GitHub/API/Slack/Bearer/JWT/private-key strings are masked.
`imajin_vault` results are always replaced with `[vault result omitted]`,
including loop, context-ceiling and silent-ending alerts.
The existing watchdog still catches a wake or accepted child that never ends.
Enable `plugins.entries.imajin.hooks.allowConversationAccess: true` for
per-message and completion hooks. Gateway credentials need `operator.write`
for scoped aborts; no kernel access to harness state is added.

#### Fresh wake sessions, sizing and continuity (#79)

`wsNotifications.sessionPerWake` defaults to `true`. The default base is
`agent:main:warp-events` (`targetSession`, overridden by `wakeSessionKey`).
Each coalesced leading/trailing batch gets its own session instead of growing
one worker transcript. With no template token, a deterministic batch hash is
appended. `{batchId}` expands to a 24-hex SHA-256 batch hash; `{runId}` expands
to a hash of the batch's run IDs plus the batch hash, not a raw external ID.
The same batch identity derives the same key on retry/replay.

The hook admission UUID is not necessarily the harness runner UUID.
Completion matches the plugin-owned fresh session or the `Wake batch ID`
evidence marker in the current user turn; it does not assume those UUIDs
are equal. Fixed-session batches use the marker to avoid guessing between
queued wakes. Duplicate runner completions are ignored.

Set `sessionPerWake: false` with a non-templated key to opt into legacy
fixed-session reuse. Template tokens still select batch-specific sessions even
when this flag is false. Before fixed-key injection/dispatch, the plugin reads
fresh scoped session metadata through the public SDK and reserves 24,000
tokens for evidence/continuity. Unknown size or a snapshot plus reserve above
`maxSessionTokens` rotates to a fresh key and alerts. `maxSessionTokens`
defaults to and cannot exceed 50,000. This is a reuse guard; the separate
`maxWakeTokens` ceiling controls in-flight and final context observations.

**Configure model limits in the host.** `/hooks/agent` does not forward
`contextTokens` or `maxTokens` body parameters. To keep a single tool-heavy
turn around the 50k budget, operators must configure the selected model's
`models.providers.<provider>.models[].contextTokens` and `maxTokens` (or
supported output `params.maxTokens`), accounting for output/headroom, and
select/pin that model for the wake agent. These limits belong to the model
route, not an agent-level `contextTokens` setting; `agents.entries.<id>`
is the current agent configuration map. Native runtime/compaction behavior
varies, so the plugin does not claim a universal provider-side hard ceiling.
Final-size logging prefers the last assistant's available
`usage.contextUsage` snapshot; fallback measurements are observations, not
cumulative tool-loop billing. Missing data is explicitly `unavailable`, never
presented as a measured zero. Outer accounting can finish after `agent_end`.

**Completion supervision is independent of reports.** `wakeTimeoutMs` defaults
to 900,000ms (15 minutes) and clamps to 1..3,600,000ms (60 minutes) from wake
dispatch. This is a **missing-completion backstop**, not a one-minute limit
on healthy work: run lookups, PR discovery and reviews can take minutes.
Configure it for the expected duration of the wake's work.

The **within-one-minute failure-alert budget starts when `agent_end` reports
a failure**, an empty reply or `stopReason=length`. That path invokes the
configured `directSend` immediately, without waiting for the completion
watchdog; the delivery call has a 20,000ms timeout. Real hook-call failures
also alert on the first failed attempt. If no completion arrives, the
watchdog alerts only after `wakeTimeoutMs`, not within one minute of dispatch.
Admission-timeout/pending responses do not disable this backstop; a late
successful turn can still update continuity.

**Bounded continuity, not transcript history.** `bridgeStatePath` defaults to
`<stateDir>/wake-bridge.json`; without a resolved path it is in-memory only.
The file holds at most 32 KiB / 50 allowlisted records
(`runId`, `issue`, `expectedPr`, `lastVerdict`, `status`), and contributes at
most 6 KiB of untrusted evidence to a wake prompt. Closed records are evicted
first, then oldest records when a bound is reached. No gateway transcript is
copied into this file.

A successful wake may optionally return a **whole-response JSON object**
of at most 4 KiB: `{"updates":[{"runId":"<batch-run>","status":"closed"}]}`.
Each update requires `runId` and `status` (`open` or `closed`), and may include
`issue`, `expectedPr`, and `lastVerdict`. Only runs in the current batch can
be updated; failed, truncated or empty turns cannot apply structured updates.
Prose may record a bounded verdict but never implies closure. Fenced JSON
or JSON embedded in prose is not the whole-response protocol.

`horizonEnabled` defaults to `false`. Even when enabled it is a no-op without
an injected harness-side `HorizonWakeAdapter` exposing
`readOpenItems({runIds})` and `writeStepEvents(outcome)`. Live registry horizon
integration remains pending #2881; the adapter owns signed writeback.
The kernel never reads or calls a gateway session, and this change does not
implement or modify horizon-sync.

**Retention gap.** Fresh gateway sessions are not deleted at `agent_end`:
doing so races the host's remaining accounting. Host
`session.maintenance: {mode: "enforce", pruneAfter: "30d", maxEntries: 5000}`
provides age/count cleanup (`warn` only reports). Disposable automation rows
can be removed, while ordinary persistent entries may archive in place.
This is not an exact per-wake TTL or guaranteed physical storage ceiling.
Future plugin-owned expiry must run after accounting, verify a dedicated
generated prefix and ownership, skip active/admitted work, and use
`expectedSessionId` plus `expectedUpdatedAt` compare-and-swap deletion.
Never auto-delete shared worker, operator or reply sessions.

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
before its own attempt starts. In fresh mode this serialization is per batch;
distinct fresh sessions do not share a fixed worker's POST queue.

Startup replay also **merges** every owed marker for the same scope into a
single wake instead of firing one per marker: a scope can accumulate several
owed markers across many failed flushes before a restart (each failed flush
retains its marker but still returns the in-memory scope to idle, so the
next notification opens a brand-new window) — replaying each one
individually is exactly the fan-out that can storm the Gateway with dozens
of simultaneous wake attempts. The merged replay uses the union of every
marker's frames, the earliest `sinceTs`, and always fires as the `leading`
phase.

Fresh sessions persist evidence in pending state with `injected: false`,
rather than enqueueing into a fixed gateway inbox. These owed wakes are
**not silently age-expired**: they still need delivery. Fixed-mode
`injected: true` records (and legacy records without the flag) retain the
`wakeOwedMaxAgeMs` behavior (default `3600000`, 1h): old markers may be cleared
because the system-event queue already holds their context. This logs
`owed wake expired … — injected only`; the context remains for the next turn.

#### Wake-pending: timeout and admission-timeout 503 aren't failures (#31)

Two `POST /hooks/agent` outcomes may mean the wake is already running or
queued, so immediately retrying risks duplicate queued turns:

- A **client-side timeout** (`HOOK_REQUEST_TIMEOUT_MS`, 10s): the response
  did not arrive in time, so admission is ambiguous rather than proven refused.
- A **503 whose JSON body carries a `runId`**: the Gateway queued the run but
  couldn't start it before its admission window. A runId-less 503 (or any
  other non-pending failure) alerts on the first failed attempt and still walks
  the `HOOK_RETRY_DELAYS_MS` ladder.

Either outcome logs one `wake pending` info line, skips the retry ladder and
keeps the owed marker. It does not immediately retry ambiguous admission,
but it also does not suppress alerts forever: the completion watchdog
remains active and alerts through `directSend`. A later successful admission
or correlated terminal hook settles the pending state. Only already-injected
legacy/fixed markers are eligible for the age expiry described above.

#### Wake reports: the worker discloses (`wsNotifications.reportTo`, #47)

A wake that runs in an isolated worker session (e.g. `targetSession:
"agent:main:warp-events"`) has no channel binding, so its outcome — PR
verdicts, `ev:` lines, DECISION cards — never reaches a human: the Gateway
logs `status:"ok"`, `delivered:false`. `reportTo` keeps the worker isolated
(own transcript, no DM noise mid-review) and makes it *disclose* instead of
repointing it at a DM:

```json
"wsNotifications": {
  "injectScopes": ["warp.run.completed", "warp.run.failed", "warp.run.timeout"],
  "targetSession": "agent:main:warp-events",
  "reportTo": ["agent:main:telegram:direct:8321865723"]
}
```

How it works:

- The plugin hooks `agent_end`. When a correlated turn ends in a derived wake
  session (or the fixed session in legacy mode), it takes that turn's **final
  assistant message** and posts it to each `reportTo` session via
  `POST /hooks/agent` (`deliver: true`, run name `imajin-wake-report`, using
  the same `hookToken`/`hooksPath` as wakes; the agent id is parsed from the
  session key, so `hooks.allowedAgentIds` must permit it).
- **One report per wake batch.** The batch id is the wake's idempotency key
  (`imajin-wake:<scope>:<windowStart>:<leading|trailing>`); a batch is
  reported at most once however many times it is replayed or `agent_end`
  fires, and the per-target `Idempotency-Key` is
  `imajin-wake-report:<batchId>:<sessionKey>`.
- **Never silence.** A wake turn with no assistant output (or only
  `NO_REPLY`) reports `no output` plus the Warp run state(s) and whether the
  turn errored.
- **Not a wake.** The report is wrapped as `[Report from warp-events — wake
  batch …]` with an explicit "informational, do not start work" header, never
  enters the wake queue/coalescer, and is never delivered to the wake
  session (a `reportTo` entry equal to it is rejected, since that would loop).
  `agent_end` for sessions outside tracked wake batches is ignored, so a
  report's own turn is never reported on.
- **Validation, never a crash.** Entries must look like `agent:<agentId>:…`;
  anything else (and non-array values, duplicates, the wake session) is
  logged once at startup and dropped. A gateway rejection of a key (e.g. an
  unknown session) is logged once per key and never throws. Empty/omitted
  `reportTo` disables reports only; the `agent_end` completion/size monitor
  remains registered and requires the explicit conversation-access permission.

Limits (by design): pending batches are tracked in memory only — a gateway
restart between a wake being admitted and its turn ending loses that
batch's report (the wake itself is unaffected); the output is clipped to
3000 chars to fit a channel message; and a `reportTo` session's agent will
run a normal delivery turn to relay the report, as `/hooks/agent` always
does.

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

- **Ack frame.** After `inject()` has durably persisted fresh-session pending
  evidence (or enqueued a fixed-mode system event), the plugin sends
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
  `wakeCoalesceMs` wait. Successful admission or a correlated terminal hook
  clears the marker; the watchdog does not silently clear any still-pending
  fresh evidence on timeout.
- **Hook retry with backoff.** A refused/non-pending failure from
  `POST /hooks/agent` alerts on the first failed attempt and is retried 3 times
  (5s / 15s / 45s backoff); the owed marker is kept through the
  retries and even through the channel alert, and is cleared on eventual
  admission or a correlated terminal hook.
- **State directory (`wsNotifications.stateDir`).** Defaults to a directory
  named `imajin-ws-state` colocated with `keypairPath` (e.g.
  `/path/to/imajin-ws-state/` next to `/path/to/.jin-identity.json`).
  Persistence is best-effort: a missing/corrupt state file degrades to empty
  state rather than throwing, and this plugin still works exactly as before
  (in-memory-only dedup/coalesce, no cross-restart durability) if `keypairPath`
  and `stateDir` are both unset.

### Loop lifecycle events (#46)

The plugin publishes signed `loop.started | loop.progress | loop.blocked |
loop.finished` events to the kernel's loops rail (`POST /api/loops`,
`ima-jin/imajin-ai#2295`), so the operator console's Runs lane can answer "what is
running" without the kernel ever calling into the Gateway. The kernel's knowledge
of a loop is these signed events only. Top-level inventory (#109) adds label,
agent ID, last activity and blocked-on-you, plus bounded, redacted typed history
(`text` / `tool_call` / `tool_result`) through the #2406 output contract.

On by default once `nodeUrl`, `did` and `keypairPath` are configured; opt out
with `loops.enabled: false`. Observe hooks only: a failed publish is logged
(rate-limited, never with the payload) and dropped, never retried, and can
never block or fail the session / subagent / cron run it describes.

| Kind | started | progress | finished |
| --- | --- | --- | --- |
| `openclaw.session` (visible primary sessions) | `session_start` | `agent_end` (per turn) | `session_end` (`reason` → state) |
| `openclaw.subagent` | `subagent_spawned` | `subagent_progress` | `subagent_ended` (`outcome` → state) |
| `openclaw.automation` (cron) | `cron_changed` `started` | — | `cron_changed` `finished` / `removed` |
| `openclaw.keeper` (cron, classified) | same as automation | — | same as automation |

`loop.blocked` (and the return to running) is supported on every kind by
`tracker.block({ sessionKey | jobId }, reason)` / `unblock(...)` in
`src/loop-tracker.ts`. The approvals bridge is the producer (#64, see "Blocked on an operator approval" below).

- **Ids.** `loopId = <kind>:<sha256(agent DID, kind, session id | session key |
  job id + run start)[0..32]>`: deterministic, but the OpenClaw key never *is* the
  id. `refs.sessionKey` / `refs.runId` carry the OpenClaw ids (the kernel rejects
  any other ref key, so `sessionId` is only used to derive the id).
- **Lineage.** A subagent's `parentLoopId` is the loop of the session that spawned
  it (`ctx.requesterSessionKey`): the operator's session, another subagent, or a
  cron run. A requester session the plugin never saw start is started lazily so
  the parent always exists.
- **Keepers.** A keeper is a cron job listed in `loops.keeperJobs` (job id, name
  or declarationKey) or named `keeper`, `keeper:*`, `keeper-*`, `keeper_*`,
  `keeper/*`. Everything else scheduled is an automation.
- **Restart backstop.** `cron_reconciled` (startup/reload) closes cron loops
  that never saw a `finished`: runs the persisted snapshot still marks running
  are finished as `interrupted`; in-flight loops whose job vanished are
  `cancelled`. Session loops are closed by `session_end` (`shutdown` / `restart`
  → `interrupted`). A crashed *subagent* has no backstop hook.
- **Signing.** Ed25519 by the agent DID over `canonicalize({ type, payload })`,
  exactly as `imajin-ai#2295` verifies; `keyId` is derived from the private key.

```json
{
  "plugins": {
    "entries": {
      "imajin": {
        "config": {
          "actAs": "did:imajin:<operator>",
          "loops": { "keeperJobs": ["inbox-keeper"] }
        }
      }
    }
  }
}
```

**Operator step.** Loops belong to `actAs` when set (the operator, so the Runs
lane shows them), else to the agent DID. The kernel only accepts a publisher DID
that *is* the principal or holds an active `loops:publish` delegation grant from
it (`imajin-ai#2358`): when `actAs` is set, grant the agent DID `loops:publish`
from that principal, otherwise every publish is rejected with 403 (logged once a
minute as `publish dropped ... HTTP 403`).

**Top-level inventory (#109).** Boot/reconnect `sessions.list` (all pages) and
`sessions.changed` keep dashboard/Telegram/warp-events threads on the rail,
without polling or a kernel Gateway client. Archive finishes the loop but keeps
the record. History backfills the last 20 message entries, at most 80 redacted
blocks of 12 KiB each. See [wire contract and bounds](docs/session-commands.md).
Backfill and archived-state watermarks persist per native session ID in
`<stateDir>/session-inventory-<publisher-hash>.json` (the existing
`wsNotifications.stateDir`, or `imajin-ws-state` next to the keypair). Reboots and
reconnects publish only history past the saved point; unchanged archived rows
do not re-emit `loop.finished`. New turns remain event-driven. The private
atomic checkpoint stores hashes/flags, not transcript text or harness keys.

#### Blocked on an operator approval (#64)

While an approval card is pending, the session (or cron run) that owns it is
waiting on an operator. When the approvals bridge has published a card whose
source knows the owning session key (`gateway-exec` and `system-agent` read it
from the Gateway request; `skill-workshop` and `imajin-catalog` have none), it
calls `tracker.block({ sessionKey }, "awaiting operator approval (<kind>)")` →
`loop.blocked`. It calls `unblock` (→ `loop.progress`, state `running`) when the
approval is settled: the decision is applied, the item is no longer pending at
its source, applying it fails, or its `expiresAtMs` passes with no decision.

- Blocks only after the card is published, so a card that never reached /jin
  never shows the loop as blocked.
- Several pending approvals for one session block it once and unblock it only
  when the last is settled. A rejected/unverifiable decision, drift, or a
  `withdrawn` decision leaves the approval pending, so the loop stays blocked.
- The reason carries the card `kind` only, never the command text. The owner
  rides only on the in-process `ApprovalSourceRequest`. Native expiry also
  rides in signed card `detail.expiresAt` for system-agent and gateway-exec.
- Observe-only (`src/approval-loop-blocker.ts`): a throwing `block` / `unblock`
  is logged and dropped and never affects publishing or applying a decision.
  With the loops feature off (`loops.enabled: false` or unconfigured) nothing is
  wired and the bridge behaves exactly as before.
- **Settled outside /jin (#66).** Sources have no "resolved elsewhere" push
  signal, so an approval answered in the gateway UI / CLI that has no
  `expiresAtMs` would leave its loop blocked until the session ends. The bridge
  therefore runs a periodic sweep: every `approvals.loopBlockSweepIntervalMs`
  (default `60000`; values below `5000` are raised to `5000`; `0` disables it) it
  calls `getCurrent` for each approval it holds a block for and unblocks the ones
  no longer pending (or unknown to the source), so the block clears within one
  interval. The sweep only ever unblocks; a failing `getCurrent` is logged and
  dropped (the block stays, the next sweep retries) and never affects publishing
  or applying a decision. The interval exists only while a block is held and is
  cleared on shutdown / unregister.
- **No flicker on restage (#66).** When a source's drift policy re-stages a
  proposal (`onDriftPolicy: "restage"`), the bridge keeps the block held across
  the re-publish of the same `proposalId`, so the Runs lane sees one continuous
  block rather than `loop.progress` (running) immediately followed by
  `loop.blocked`. If the item does not come back (resolved meanwhile) or its
  re-publish fails, the block is released as before.

### Harness horizon sync (imajin-ai#2881)

The opt-in `horizon` service reads
`~/.openclaw/workspace/horizon/horizon.json` (configurable), diffs it against
a private persisted cursor, and pushes signed `step.*` observations through
the same `/api/loops` signer/transport as loop lifecycle events. It runs on
startup, file replacement/change and a periodic tick; the kernel never calls
a gateway, session or transcript.

Set `horizon.enabled: true`, `horizon.loopId` to an **existing** owning loop,
and `horizon.repository` to the repository used for bare `#N` refs. The
publisher uses the plugin's `did` / `keypairPath` and optional `actAs`; a second
harness uses its own DID and keypair with the same loop/principal.
`horizon.filePath`, `horizon.stateDir` and `horizon.syncIntervalMs` customize
the source, durable state location and tick interval (default 30 seconds).
Unlike lifecycle hooks' dropped-on-error observations, horizon requests are
saved before delivery and retried byte-identically after uncertain responses.

Zones remain kernel-derived. `past`/`closed` publishes finished and closure
facts, not fabricated release/deployment success. The base bridge lacks an
issue OUTCOME, which the merged kernel contract currently requires before
closure can project as `past`; this and stale exact-retry reconciliation are
tracked in [imajin-ai#2931](https://github.com/ima-jin/imajin-ai/issues/2931).
See [configuration, field mapping and recovery](docs/horizon-sync.md) for
optional explicit evidence, limitations and verification. Inbound claims and
wake outcome inference are not part of this one-way publisher.

### Session commands (#51)

Signed, DID-addressed `session.send` / `session.approve` / `session.deny` /
`session.abort` / `session.spawn` / `session.archive` / `session.reset` /
`session.label` / `session.history` commands arrive over the existing outbound
kernel WS, are verified, executed against the local gateway (`chat.send`,
`exec`/`plugin.approval.resolve`, `chat.abort`, `sessions.create`), and attested
back as signed `loop.session.<verb>.completed|failed` frames. Rejection (unsigned,
misaddressed, bad signature, expired, replayed, principal not in `serviceOf`,
missing countersignature, bad payload) is also an attestation, never silent.

Off by default; enable with `sessionCommands.enabled: true` and pin the kernel's
command-signing key in `sessionCommands.kernelPublicKeyHex`. Wire contract,
verification order, attestation shape and the kernel-side assumptions are in
[`docs/session-commands.md`](docs/session-commands.md).
Archive/label use `sessions.patch` with an existing-session guard; archive is
never hard delete. Reset requires `operator.admin` in the verified published
Gateway versions and is explicitly rejected/attested as `missing_scope` on the
plugin's unchanged write+approvals connection. The command stays registered,
but successful reset waits on operator-approved authority in
[plugin#115](https://github.com/ima-jin/openclaw-imajin-plugin/issues/115)
(native child of #109); no standing admin scope is added here.
Kernel controls/enum and signed
history-on-open dispatch are tracked in
[imajin-ai#3036](https://github.com/ima-jin/imajin-ai/issues/3036).

## Development
Run `npm run typecheck` (`tsc --noEmit -p .`) and `npm test` (vitest) before sending a PR. `openclaw` is declared as an optional `peerDependency` (the gateway supplies it at runtime); the `openclaw/plugin-sdk/*` imports in `index.ts` (static) and `src/notification-injector.ts` / `src/gateway-approvals-bridge.ts` (dynamic — only on the SecretRef paths, #20, and the live Gateway/kernel wiring in `gateway-approvals-bridge.ts`'s `createLiveGatewayApprovalsClient`, #24) are typed via a minimal hand-written ambient declaration (`src/types/openclaw-plugin-sdk.d.ts`) instead of installing the full `openclaw` package locally, since it's very large and recent releases gate `npm install` behind a strict Node engine check.

## About Imajin

Imajin (今人) is sovereign technology infrastructure — federated identity, .fair attribution, MJN/MJNx settlement, and discovery. No subscriptions, no cloud dependency, no vendor lock-in.

- **Network:** [jin.imajin.ai](https://jin.imajin.ai)
- **Protocol:** [protocol.dfos.com](https://protocol.dfos.com)
- **Code:** [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)

## Per-agent Imajin identities (#136)

On a multi-agent Gateway, set `plugins.entries.imajin.config.agents`, keyed by
the **OpenClaw agent id** (`main`, `artifact-jin`, etc.). Each entry has its own
`did`, sealed `keypair` SecretRef, optional `actAs` principal, exact `tools`
allowlist, and `wsNotifications` settings. Each resolved entry owns one HTTP
challenge-response session, reused by its own notification socket. No agent
uses another agent's keypair, session cookie, or default acting principal.

```json
{
  "nodeUrl": "https://jin.imajin.ai",
  "agents": {
    "main": {
      "did": "did:imajin:MAIN_AGENT_PUBLIC_DID",
      "keypair": { "source": "store", "provider": "default", "id": "imajin-main-identity" },
      "actAs": "did:imajin:MAIN_PRINCIPAL"
    },
    "artifact-jin": {
      "did": "did:imajin:ARTIFACT_AGENT_PUBLIC_DID",
      "keypair": { "source": "exec", "provider": "imajin-vault", "id": "artifact-jin-identity" },
      "actAs": "did:imajin:ARTIFACT_ORG",
      "tools": ["imajin_identity", "imajin_discover", "imajin_chat"],
      "wsNotifications": {
        "injectScopes": ["warp.run.completed", "warp.run.failed", "warp.run.timeout"],
        "hookToken": { "source": "store", "provider": "default", "id": "gateway-hook-token" },
        "wakeSessionKey": "agent:artifact-jin:warp-events",
        "reportTo": ["agent:artifact-jin:telegram:direct:OPERATOR_CHAT_ID"]
      }
    }
  }
}
```

The DIDs above are placeholders, not registered identities. Provision each
keypair through your existing sealed store/vault tooling, outside chat,
shell arguments and plugin config. The referenced value is a JSON object
with `did`, `publicKey` and `privateKey` fields (Ed25519 hex); the plugin
checks the public key against both the private key and the kernel's
`did:imajin:<base58(publicKey)>` DID. Only the runtime signer sees private
material. Configure an actual encrypted OpenClaw `store` provider or a trusted
vault-backed `exec` provider in the host's `secrets.providers` first.
The plugin ships the **`imajin-vault` exec provider** described below.
Missing SDK secret-resolution support or an unavailable provider disables that agent;
do not substitute an inline value or a plaintext key file.

Per-agent `keypair` rejects strings, inline key objects, `keypairPath`, and
`env`/`file` refs. Duplicate DIDs or identical SecretRefs disable both entries.
Resolution happens at full service startup, not during metadata discovery;
before resolution, after stop, or on failure, the factory returns no tools.
Restart/reload the plugin after provisioning or rotating an identity.

### Register the agent and bind it to an org

These are **operator steps**, not actions performed by this plugin. Do not
mint, register, or seal a real key as part of testing this configuration.

1. Read the deployed kernel's `/spec` catalogue first. Its auth contract is
   available at `https://jin.imajin.ai/auth/api/spec`; its vault contract is
   `https://jin.imajin.ai/vault/api/spec`. Auth spec paths are relative to
   `/auth`, so the two existing operations below are served as
   `/auth/api/register` and `/auth/api/groups/{groupDid}/controllers`.
2. Use your protected signing/provisioning tool to submit **POST
   `/api/register`**, with `type: "agent"`, the **public** `publicKey`, optional
   `handle`/`name`, and a registration `signature`. No private key is sent to
   register. The published spec requires `[publicKey, type, signature]`;
   expect 201 for a new identity, or 200 for an already registered key.
   Omit `Authorization` for signed self-registration. An app-service
   Authorization header selects a separate, permission-gated path and never
   falls back to self-registration.
   **Version caveat:** the current kernel source still accepts
   `scope: "actor", subtype: "agent"` rather than consuming `type`.
   For that version, include those fields alongside `type: "agent"` and sign
   the exact supported registration payload
   `JSON.stringify({publicKey, handle, name, scope: "actor", subtype: "agent"})`
   with the protected agent signer. Check your deployed version before
   signing; do not register an unintended human identity by guessing fields.
3. From the org owner's/admin's authenticated session, submit **POST
   `/api/groups/{groupDid}/controllers`**, with public body
   `{ "did": "<returned agent DID>", "role": "agent" }`. An owner can optionally
   supply a finite `allowedServices` list to narrow authority; admins must
   choose a finite subset of their own live services. The existing route
   records `group.member.added` with the membership. No kernel change is
   required. Use this org DID as that entry's `actAs`; omit `actAs` to act as
   the agent itself. The kernel still adjudicates grants for every tool call.
4. Store/seal the identity through the operator's protected provider flow,
   then configure only its SecretRef in the map. The published vault spec
   documents vault-side minting and grants. Use the import/delegation flow
   below for existing agent keys; never export them through chat or SSH.

### Kernel vault exec provider (#143)

`bin/imajin-vault.mjs` implements OpenClaw's
[exec provider protocol v1](https://docs.openclaw.ai/gateway/secrets/secretref-contract).
Run `npm ci --omit=peer --ignore-scripts` then `npm run build` in the plugin
checkout before configuring it. Rebuild after updates. Use the **real,
absolute, non-symlink Node binary** as `command`; `args` names the plugin-owned
entrypoint and its non-secret config file. Do not run this resolver manually,
from a model tool, or with stdout redirected to a terminal/log/file: successful
stdout necessarily contains the secret protocol payload for the gateway's
private pipe, **not tool output**.

#### Seal and delegate

In `/jin` → **Import credential**, a signed-in human approver selects the
authorized **owner DID** (the org when acting as that org), pastes the keypair
JSON once with no reveal, and explicitly selects the gateway's **main agent
DID as consumer**. The panel uses `POST /api/vault/import`, requires human
approval, and returns 409 on vault tier 1. `/admin/vault` and `/api/vault/set`
are node-admin-only, not the org import path. Complete approval and obtain
the resulting delegation `grantId` from the operator's metadata view.
Use a reusable (`oneTime: false`), active grant: one-time grants are consumed
by fetch and cannot support gateway refresh. The provider rejects them.

Map the SecretRef id to that exact grant explicitly. No lookup by name,
owner guessing, personal-session defaults, or inferred org ownership occurs.
The kernel checks the grant's actual owner/consumer authority, revocation
and expiry on every POST to
`/auth/api/vault/delegation/grants/{grantId}/fetch`.
The authenticated identity is always the consumer DID, with **no acting-as
header**, even when main's usual `actAs` is a business/org DID.

#### Bootstrap and config example

The bootstrap identity must already work independently of this provider:
`plugins.entries.imajin.config.did` is main's DID, with its existing absolute
`keypairPath` and HTTPS `nodeUrl`. It must match `consumerDid` exactly. The
provider validates that keypair's private/public/DID relationship and uses
the plugin's Ed25519 challenge-response auth. It never authenticates as the
target agent before fetching its key, nor borrows a human session.
Moving **main's existing key off disk is out of scope**; no additional key
file is created and fetched agent keys/cookies are never persisted or passed
on argv/env. Keep main's existing file outside agent-readable sandboxes.

Both files below are strict JSON, not JSON5, and must be operator-owned,
protected against modification by agents. Includes and environment/template
expansion are not supported by the standalone resolver. All DIDs/grant IDs
shown here are public placeholders, not credentials.

Non-secret `/etc/openclaw/imajin-vault.json`:

```json
{
  "gatewayConfigPath": "/etc/openclaw/openclaw.json",
  "consumerDid": "did:imajin:MAIN_AGENT_PUBLIC_DID",
  "grants": {
    "artifact-jin-identity": "GRANT_ID_FROM_APPROVED_IMPORT"
  }
}
```

Relevant portions of `/etc/openclaw/openclaw.json`:

```json
{
  "secrets": {
    "providers": {
      "imajin-vault": {
        "source": "exec",
        "command": "/usr/bin/node",
        "args": ["/opt/openclaw-imajin-plugin/bin/imajin-vault.mjs", "--config", "/etc/openclaw/imajin-vault.json"],
        "jsonOnly": true,
        "timeoutMs": 20000,
        "maxOutputBytes": 262144
      }
    }
  },
  "plugins": {
    "entries": {
      "imajin": {
        "enabled": true,
        "config": {
          "nodeUrl": "https://jin.imajin.ai",
          "did": "did:imajin:MAIN_AGENT_PUBLIC_DID",
          "keypairPath": "/protected/existing-main-identity.json",
          "agents": {
            "artifact-jin": {
              "did": "did:imajin:ARTIFACT_AGENT_PUBLIC_DID",
              "keypair": { "source": "exec", "provider": "imajin-vault", "id": "artifact-jin-identity" },
              "actAs": "did:imajin:ARTIFACT_ORG",
              "tools": ["imajin_identity", "imajin_discover", "imajin_chat"]
            }
          }
        }
      }
    }
  }
}
```

OpenClaw applies executable ownership/permission checks; adjust the real Node
path to the gateway installation, without disabling those checks. The script,
compiled `dist/`, config and main bootstrap file are trusted gateway assets.
Do not give model tools host-exec/read access to them or to the resolver.
SecretRefs are not an OS/process-isolation boundary.

The command accepts only `--config <absolute non-secret path>` and a single
stdin request `{protocolVersion: 1, provider: "imajin-vault", ids: [...]}`.
It returns only protocol JSON, with requested values or fixed per-id
`UNAVAILABLE` errors. It never logs upstream errors, response bodies or
parser excerpts. Inputs/responses/output are bounded to 256 KiB and 64 ids;
each HTTP request has a 5-second deadline, HTTPS only, redirects forbidden.
There is no value cache between invocations, no fallback provider, no
`keypairPath` fallback for a target agent, and no main-identity fallback.

Cold boot resolves each `agents.<id>.keypair` through the existing SDK.
An unavailable/missing/revoked/expired grant, auth error or malformed response
leaves that agent without tools; healthy entries remain independent.
**Refresh means a full plugin service restart/reload**, which clears existing
identities before resolving again. Do not rely on a host secrets-only reload
that retains a last-known-good snapshot: restart the plugin service after
revocation. This provider does not poll or promise instant revocation of an
already-running signer. On the next service refresh a revoked grant disables
the entry, rather than keeping its old signer.

### Tool policy, notifications and compatibility

- `tools` omitted permits all existing primitive tools; `[]` permits none.
  Entries are exact tool names, never wildcards. A tenant list can exclude
  `imajin_warp`, `imajin_vault`, `imajin_cloudflare`, `imajin_status`, and
  `imajin_wake_report`. Invalid or duplicate names fail closed. This plugin
  list is an additional restriction; it does not grant kernel authority or
  bypass OpenClaw tool policy.
- Notifications use `agents.<id>.wsNotifications`: default wake/target is
  `agent:<id>:warp-events`, and the hook agent is always `<id>`.
  Agent-prefixed custom wake keys are scoped to that agent. `reportTo` and
  `directSend` are explicit per-entry destinations, never inherited from main.
  Permit that agent and its derived session-key prefix in the Gateway hook
  allowlists. Each entry gets a separate persisted state directory (the
  configured state root plus `<id>`, or `~/.openclaw/imajin-agents/<id>`) and
  agent-namespaced wake idempotency keys.
- Gateway-wide approvals (`approvals` and `approvalBridge`), signed session
  commands, loop/horizon publishers, turn-usage attestations and authenticated
  model discovery are **not inherited or started in agent-map mode**. They
  currently require the legacy Gateway file signer; reusing it for tenant
  events would violate identity isolation. In particular, no tenant receives
  the Gateway approval rail through its tool list. The global model-provider
  registration remains available for health diagnostics but its catalog is
  unconfigured, never authenticated as main.
- **Legacy zero-edit compatibility:** omit `agents` entirely to retain the
  existing top-level `did`, `keypairPath`, `actAs`, `warp` and
  `wsNotifications.wakeSessionKey` behavior, tools, provider and services.
  (`wakeSessionKey` lives in `wsNotifications`, not `warp`, on current main.)
  Adding even an empty `agents: {}` switches off legacy identity fallback:
  an absent/unresolvable agent receives **zero `imajin_*` tools**, including
  status. Move every participating identity into the map; merely retaining
  top-level credentials does not configure `main` in this mode.

