# Changelog

## Unreleased

### Fixed
- **Skill Workshop proposals never reached /jin (#33).** `skills.proposals.list`
  is scoped to a single agent's workshop and, with several agents configured
  and no single default, fails every call ("Pass agentId to select a configured
  agent") — so the source never saw a proposal. It now lists every agent from
  `agents.list`, remembers each proposal's owning agent for `apply`/`reject`,
  and a failed publish to the kernel is logged and retried on the next poll
  (`ApprovalSource.onPublishFailed`). Needs a gateway restart to load the new
  plugin code; no config change.
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
- **`wsNotifications.reportTo` (#47).** The isolated wake worker
  (`targetSession`, e.g. `agent:main:warp-events`) now discloses: after a wake
  turn ends, its final assistant output (or "no output" plus the Warp run
  state) is forwarded once per wake batch to each `reportTo` session, wrapped
  as an informational report from warp-events. Default empty = unchanged.
- Config: `modelDiscovery.refreshIntervalMs`, `modelDiscovery.modelsPath`.

### Operator notes
- The static `imajin-xai` / `imajin-openai` provider blocks can be retired once
  `imajin_status` shows `outcome: ok` with your brains listed. This release does
  not touch Gateway config; see README "Retiring the static provider blocks".
