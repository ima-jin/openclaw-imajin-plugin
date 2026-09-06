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

Coalescing (multiple completions within `wakeCoalesceMs`, default 5 min)
is keyed by scope and by an `Idempotency-Key` derived from the coalesce
window's start time, so repeated notifications in the same window collapse
to one hook call.

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

## Development
Run `npm run typecheck` (`tsc --noEmit -p .`) and `npm test` (vitest) before sending a PR. `openclaw` is declared as an optional `peerDependency` (the gateway supplies it at runtime); the `openclaw/plugin-sdk/*` imports in `index.ts` (static) and `src/notification-injector.ts` (dynamic, only on the SecretRef `hookToken` path, #20) are typed via a minimal hand-written ambient declaration (`src/types/openclaw-plugin-sdk.d.ts`) instead of installing the full `openclaw` package locally, since it's very large and recent releases gate `npm install` behind a strict Node engine check.

## About Imajin

Imajin (今人) is sovereign technology infrastructure — federated identity, .fair attribution, MJN/MJNx settlement, and discovery. No subscriptions, no cloud dependency, no vendor lock-in.

- **Network:** [jin.imajin.ai](https://jin.imajin.ai)
- **Protocol:** [protocol.dfos.com](https://protocol.dfos.com)
- **Code:** [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
