# Changelog

## Unreleased

### Added
- **`imajin_vault` `ack` action (#42).** After `fetch`, the agent signs what it
  did with the grant: `ack { grantId, outcome: 'used'|'failed'|'discarded',
  evidence?: { kind, ref }, note? }` -> `POST
  /api/vault/delegation/grants/{grantId}/ack` (kernel `imajin-ai#2235`). Same
  value-free error mapping as `fetch` plus `grant_not_fetched` / `ack_conflict`
  (409); inputs validated against the kernel limits; a note/evidence holding a
  live handle's value is refused. `withSecretEnv` gained an optional `ack` hook
  so the exec bridge can ack `used`/`failed` automatically once wired.
- **Loop lifecycle events to the kernel loops rail (#46).** Signed
  `loop.started|progress|blocked|finished` events (`POST /api/loops`,
  `imajin-ai#2295`) for visible primary sessions (`openclaw.session`), subagents
  (`openclaw.subagent`), cron runs (`openclaw.automation`) and keepers
  (`openclaw.keeper`), with `parentLoopId` lineage and a `cron_reconciled`
  backstop for runs orphaned by a gateway restart. Lifecycle metadata only (no
  transcript content), observe hooks only, failures logged and dropped. On by
  default when `nodeUrl` + `did` + `keypairPath` are set; `loops.enabled: false`
  opts out; `loops.keeperJobs` classifies keepers. Typed in-session events and
  `refs.sessionId` need a kernel change: `imajin-ai#2552`. See README "Loop
  lifecycle events".

### Fixed
- **Skill Workshop proposals never reached /jin (#33).** `skills.proposals.list`
  is scoped to a single agent's workshop and, with several agents configured
  and no single default, fails every call ("Pass agentId to select a configured
  agent") — so the source never saw a proposal. It now lists every agent from
  `agents.list`, remembers each proposal's owning agent for `apply`/`reject`,
  and a failed publish to the kernel is logged and retried on the next poll
  (`ApprovalSource.onPublishFailed`). Needs a gateway restart to load the new
  plugin code; no config change.
- **Ask-gated `exec` card was rejected by the kernel, and the failure was
  silent (#52).** The `gateway-exec` card sent `detail.cwd` / `agentId` /
  `sessionKey` as `null` when the Gateway omitted them (OpenClaw sends
  `cwd: null` when no workdir is given), but the kernel's
  `validateExecCommandDetail` 400s unless `host`, `cwd`, `agentId` and
  `sessionKey` are non-empty strings — so no card ever appeared, the plugin
  only logged the 400, and the exec waited until its timeout and was SIGTERMed.
  Missing fields are now sent as the visible marker `unspecified`. A
  `gateway-exec` card that still cannot be published (after retrying
  network/5xx/408/429 failures) now denies the Gateway approval so the exec
  gets a clean refusal, logs an ERROR with the proposal id and reason, and
  notifies the operator via `directSend` (never including the command).
  The operator notice distinguishes denied / already resolved elsewhere (not
  denied by the bridge) / deny failed, left pending, and never awaits the notify
  CLI inside the publish reservation. With fail-closed, a kernel outage now
  denies every ask-gated exec within ~2.5s instead of leaving it pending.
  **Operator step:** reload/restart the plugin (gateway restart) to pick it up.
- **Ask-gated `exec` never surfaced as a /jin card (#52).** The `gateway-exec`
  source is opt-in and was skipped without a word when `approvals.sources`
  omitted it, and the plugin said nothing when the Gateway's own config could
  not raise an approval (sandbox exec host, or an `ask: off` baseline that
  makes OpenClaw ignore a per-call `ask`). The bridge now logs ONE loud
  warning at start naming the exact missing config, a malformed
  `exec.approval.requested` payload is logged once instead of dropped, and
  pending exec approvals are re-listed after every loopback Gateway reconnect
  (broadcasts raised while the socket was down are never replayed). README
  documents the required Gateway config under "gateway-exec source".
- **Model discovery never ran; `imajin/*` catalog was empty (#55).** The
  provider's catalog cache was purely lazy and pointed at the passthrough
  proxy's `/openai/v1/models` (404 — `imajin-ai#2453`) with no auth, so
  `imajin_status` reported `lastDiscovery.outcome: "never"`, `modelCount: 0`
  forever and models such as `grok-4` / `gpt-6-astra` only existed as
  hand-configured static `imajin-xai` / `imajin-openai` provider blocks.

### Changed
- Discovery now runs at plugin start and every `modelDiscovery.refreshIntervalMs`
  (default 5 min; `0` = start-up only), and immediately on the kernel's
  `connector.credential.sealed` / `.unsealed` / `connector.models.changed`
  notifications. It calls the kernel's `GET /infer/v1/models/usable`
  (`imajin-ai#2201`) through the plugin's existing agent-DID session — no static
  bearer — and registers each model as `imajin/<id>` with the existing
  passthrough `baseUrl`.
- Failures (kernel unreachable, route error, auth rejection, malformed body)
  are logged once, recorded in `lastDiscovery`, and keep the last good catalog;
  they never crash plugin start. (Previously an outage emptied the catalog.)
- `imajin_status` reports the catalog as `imajin/<id>` refs, `lastDiscovery`
  `{fetchedAt, outcome, modelCount, error?, httpStatus?, lastGoodAt}` with
  outcomes `ok | empty | unreachable | route-error | auth-error | malformed |
  unconfigured`, and the discovery URL/interval. The success outcome is now
  `ok` (was `live`).

### Added
- **Kernel MCP tools via the local passthrough `/mcp` (#50).** `imajin_status`
  gains an `mcp` block: reachability (`initialize` + `tools/list`, sent with no
  credential), tool count, whether an `mcp.servers` entry points at the
  passthrough (read-only check; flags `headers`), and send/write allowlist
  guidance (`allowlist.suggestedToolFilter`, `gatedToolsExposed`) for
  `google_*` tools. New optional config `mcpUrl` (default: proxy root + `/mcp`).
  README documents the one-line registration, the read-on / send-write-gated
  policy, and the two-agent-identity note. The plugin sends no credential to
  `/mcp` and never writes Gateway config.
- **`wsNotifications.reportTo` (#47).** The isolated wake worker
  (`targetSession`, e.g. `agent:main:warp-events`) now discloses: after a wake
  turn ends, its final assistant output (or "no output" plus the Warp run
  state) is forwarded once per wake batch to each `reportTo` session, wrapped
  as an informational report from warp-events. Default empty = unchanged.
- Config: `modelDiscovery.refreshIntervalMs`, `modelDiscovery.modelsPath`.

### Operator notes
- #50: register the kernel MCP server once (no headers) and restart/reload the
  Gateway if hot reload is off: `openclaw mcp add imajin --url
  http://127.0.0.1:8787/mcp --transport streamable-http`; then set a
  `toolFilter` from `imajin_status` → `mcp.allowlist.suggestedToolFilter`. The
  passthrough needs an `mcp` route configured (imajin-ai#2368). No plugin
  version bump is part of this change.
- The static `imajin-xai` / `imajin-openai` provider blocks can be retired once
  `imajin_status` shows `outcome: ok` with your brains listed. This release does
  not touch Gateway config; see README "Retiring the static provider blocks".
