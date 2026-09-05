# The Warp wake chain: kernel event → human ping → agent turn

This is the full path a Warp cloud-agent run's outcome travels before it turns
into a real agent turn in the owner's DM, hop by hop, with exact source
locations, what each hop returns on success, every known failure mode
observed to date (and which fix closed it), and the log line to grep for at
each hop. It exists so the next incident in this chain is a five-minute grep
against this table instead of another week of whack-a-mole.

Kernel citations are `ima-jin/imajin-ai` at `main` (apps/kernel + packages/bus
+ packages/auth). Host/plugin-SDK citations are `openclaw/openclaw` at tag
`v2026.8.2`. Plugin citations are this repo.

## The chain at a glance

```
Warp platform run                                         (no webhooks exist)
  |
  v
[1] Kernel poll: in-request watch OR scheduled sweep observes terminal/timeout state
  |   apps/kernel/src/lib/warp/dispatch.ts (watchRun), run-watch-sweep.ts (sweepInFlightWarpRuns)
  v
[2] publish() fans the event out on the bus
  |   packages/bus/src/index.ts -> packages/bus/src/config.ts reactor chain (emit + notify)
  v
[3] notify reactor -> POST /notify/api/send -> notifications row + WS push
  |   packages/bus/src/reactors/notify.ts, apps/kernel/app/notify/api/send/route.ts,
  |   apps/kernel/src/lib/notify/ws-push.ts, apps/kernel/ws-server.js (sendToDid)
  v
[4] Plugin WS receive: parse + dispatch the `notification` frame
  |   src/ws-service.ts (parseFrame, isNotificationFrame, dispatchFrame)
  v
[5] Plugin frame handler logs + fires the injector
  |   index.ts (wsService.onFrame)
  v
[6] inject(): durable context + instant Telegram ping + coalesce into a wake batch
  |   src/notification-injector.ts (inject)
  v
[7] flushWakeTurn(): schedule a real agent turn via the host, with #13's
  |   missing-id-is-a-failure handling and a confirmation watchdog
  |   src/notification-injector.ts (flushWakeTurn), openclaw core
  |   src/plugins/host-hook-scheduled-turns.ts (schedulePluginSessionTurn)
  v
[8] Cron fires the job -> a real agent turn runs in the owner's session
      openclaw core Cron (`kind: "agentTurn"`, wakeMode: "now") -> agent_end hook
```

## Hop 1 — Kernel observes the run ending

Warp exposes no completion webhook (confirmed absent from its public Agent
API; see the module doc in `dispatch.ts`). Two kernel-side pollers exist,
sharing one publish path:

- **In-request watch** — `watchRun` / `pollUntilTerminal`,
  `apps/kernel/src/lib/warp/dispatch.ts:2235` and `:1930`. Started
  fire-and-forget right after the dispatch route responds. Polls on
  `WATCH_POLL_INTERVALS_MS` (`dispatch.ts:1426`) up to a `WATCH_TIMEOUT_MS` of
  30 minutes (`dispatch.ts:1429`).
- **Scheduled sweep** — `sweepInFlightWarpRuns` / `checkOneRun`,
  `apps/kernel/src/lib/warp/run-watch-sweep.ts:310` / `:270`. Runs on a cron
  tick (`GET /api/cron/warp-run-watch`) and re-checks every run whose latest
  `warp.agent.dispatched`/`warp.run.resumed` activity is newer than its
  latest terminal row (`run-watch-sweep.ts:160`, `listInFlightRuns`).

**Returns on success:** both call one of three shared publish functions in
`dispatch.ts`:
- `publishTerminalRunOutcome` (`:2124`) → `warp.run.completed` or
  `warp.run.failed`.
- `publishBlockedRunOutcome` (`:2141`) → `warp.run.blocked`.
- `publishRunStillRunning` (in-request watch only, `:2183`) or
  `publishTimeoutRunOutcome` (sweep only, `:2155`) → `warp.run.still_running`
  or the genuine `warp.run.timeout`.

**Known failure modes:**
- *Resumed runs never re-fired.* Pre-#2032, `listInFlightRuns`'s "in-flight"
  query was existence-based ("has any terminal event ever been logged for
  this `runId`"), so once a run's first segment had a `warp.run.completed`
  row, a later `send_followup resume: true` segment on the same `runId` was
  invisible forever. **Fixed by `ima-jin/imajin-ai` PR #2033**: the query is
  now a timestamp comparison — latest dispatch-or-resume activity vs. latest
  terminal row (`run-watch-sweep.ts:160-214`). PR #2033 also found a deeper
  root cause: `warp.run.resumed` was missing from
  `packages/auth/src/grant-scopes.ts`'s entitled event types, so
  `deliverToSubscribers` (`packages/bus/src/subscriptions.ts:108-112`) took
  its zero-capabilities fast path and never durably logged the resume at
  all — fixed in the same PR.
- *30-minute watch budget published a terminal `warp.run.timeout` for a run
  that could still succeed.* Pre-#2032, `watchRun`'s budget-elapsed branch
  called `publishTimeoutRunOutcome` directly. **Fixed by PR #2033**:
  `watchRun` now publishes non-terminal `warp.run.still_running`
  (`dispatch.ts:2259-2277`); `warp.run.timeout` is reserved for the sweep's
  own `SWEEP_LOOKBACK_MS` (6 hours, `run-watch-sweep.ts:97`) elapsing with
  still no terminal state, confirmed by one extra read
  (`run-watch-sweep.ts:270-298`).

**Grep (kernel service logs, not the gateway journal):**
```
"Warp cloud agent run reached a terminal state"
"Warp run watch budget elapsed while the run is still going"
```

## Hop 2 — `publish()` fans the event out

`packages/bus`'s `publish()` runs the event's configured reactor chain. The
static defaults for every `warp.run.*` scope live in
`packages/bus/src/config.ts:320-381`:

| Event | Reactors |
|---|---|
| `warp.run.completed` | `emit` + `notify` (title "Warp run completed") |
| `warp.run.failed` | `emit` + `notify` (title "Warp run failed") |
| `warp.run.blocked` | `emit` + `notify` (title "Warp run blocked") |
| `warp.run.timeout` | `emit` + `notify` (title "Warp run timed out") |
| `warp.run.still_running` | `emit` + `notify` |
| `warp.run.resumed` | `emit` + `notify` (added by #2032 — previously *no chain at all*) |
| `warp.run.progress` | `emit` only (no `notify` — telemetry-class, #1805) |

A separate, unrelated fan-out also runs on every `publish()` call:
`deliverToSubscribers` (`packages/bus/src/subscriptions.ts:108`) — grant-scope
entitled external-agent push (`type: "bus_event"` WS frames, #1884). **This
plugin does not consume that frame type** (`ws-service.ts`'s `dispatchFrame`
only special-cases `notification` and `chat_message`); it only matters
because it is what feeds the sweep's `kernel.event_subscription_log`
bookkeeping in Hop 1.

**Returns on success:** the `notify` reactor's `send()` call reaching
`/notify/api/send` (Hop 3) — `publish()` itself doesn't await outcomes beyond
that.

**Grep:** none directly useful at this hop; it is in-process. If a reactor
chain is ever suspected of being misconfigured, check
`kernel.bus_chain_configs` in the DB — a row there **replaces** the
`config.ts` defaults above (see the comments at `config.ts:318` and `:352`).

## Hop 3 — `notify` reactor → notification row + WS push

`notifyReactor` (`packages/bus/src/reactors/notify.ts:44`) interpolates the
configured `title`/`body` against the event payload and calls
`@imajin/notify`'s `send()`, which POSTs to
`apps/kernel/app/notify/api/send/route.ts:128`. That handler:
1. Inserts a row into the `notifications` table (`route.ts:178`).
2. If the in-app preference is on, calls `pushNotificationToDid`
   (`apps/kernel/src/lib/notify/ws-push.ts:71`, `route.ts:200`).

`pushNotificationToDid` POSTs to `/chat/api/internal/did-push`
(`ws-push.ts:81`), handled by `ws-server.js`'s `setupBroadcastRoute`
(`ws-server.js:399-430`), which calls `sendToDid` (`ws-server.js:347`) —
`JSON.stringify` the frame and `ws.send` it to every open socket registered
for that DID (`didSockets`, plus any `register_also` delegate,
`ws-server.js:230-233`).

**Returns on success:** `pushNotificationToDid` resolves `true` (at least one
socket got it) or `false` (nobody was connected — degrades to catch-up-on-
reconnect, never a failed send: see the module doc at `ws-push.ts:1-13`). The
frame sent is exactly `NotificationWsFrame` (`ws-push.ts:29-39`):
`{ type: "notification", id: "ntf_…", scope, title, body, data, createdAt }`.

**Known failure modes:** none specific to this hop have been observed in
this incident series; it is the most reliable link (Warp's own webhook-less
design is why Hop 1 exists at all, not this hop).

**Grep (kernel service logs):** `"Notification WS push failed"` /
`"Notification WS push error"` (`ws-push.ts:91,98`).

## Hop 4 — Plugin WS receive

`ImajinWsService` (`src/ws-service.ts`) maintains the authenticated
WebSocket connection (challenge-response, `connect()` at `:311`; native
fallback via a one-time WS token at `:294`). Inbound frames go through:
- `parseFrame` (`:92`) — JSON-parses, returns `null` for anything without a
  string `type` (never throws on a malformed frame).
- `isNotificationFrame` (`:111`) — narrows to the required
  `{id, scope, title}` shape.
- `dispatchFrame` (`:427`) — drops a malformed `notification`-typed frame
  with a warn, otherwise calls every registered `onFrame` handler in a
  try/catch per handler.

**Returns on success:** the parsed `NotificationFrame` reaches every handler
registered via `onFrame()`.

**Known failure modes (historic, both from before this incident series and
already fixed, kept here for completeness):**
- WS auth via a raw session cookie sent post-connect on the native-WebSocket
  fallback was never recognized by the kernel's deferred-auth branch (it only
  accepts `{type:"auth", token}`) — fixed to use the short-lived WS token
  exchange (`ws-service.ts:15-19`, `fetchWsToken` at `:294`).

**Grep:** `"connected"`, `"auth ok"`, `"disconnected (code="`,
`"failed to parse WS frame"`, `"dropped malformed notification frame"`.

## Hop 5 — Plugin frame handler

`index.ts:181-199` — `wsService.onFrame((frame) => {...})`. For a
`notification` frame it logs `[imajin-ws] notification: {scope} — {title}`
and calls `injector(nf)` fire-and-forget (`.catch()` only, since this runs on
the socket's event loop turn, not inside an agent turn — see the doc comment
at `notification-injector.ts:116-121`).

**Grep:** `"\[imajin-ws\] notification: "`

## Hop 6 — `inject()`: durable context + instant ping + coalesce

`src/notification-injector.ts:411` (`inject`). In order:
1. `enqueueSystemEvent` (host API, `api.runtime.system.enqueueSystemEvent`) —
   durable context injection so the event survives a restart. Logs
   `"queued via system-event"` on success or `"system-event queue rejected"`
   on failure (in which case `inject()` returns early — no ping, no wake;
   see `:412-436`).
2. Instant direct channel ping via `sendChannelMessage` (`:191-201`,
   `openclaw message send` CLI, no model in the loop) — logs
   `"direct-sent {scope} → {channel}:{target}"`.
3. Coalesce into `coalesceByScope` (`:207`), keyed by scope, for
   `wakeCoalesceMs` (default 5 minutes, `DEFAULT_WAKE_COALESCE_MS`,
   `:43`). Logs `"warp wake: batched {id} (n=N, fires in Xms)"` on every
   push, whether it starts a new batch or joins an existing one — so no
   notification is ever silently dropped from the batch (regression-tested,
   see `src/notification-injector.test.ts` "keeps the newest notification…").

**Known failure modes:**
- *Early `return` after a successful ping skipped the wake entirely.*
  `inject()` used to `return` right after the `direct-sent` log line, so with
  `directSend` configured and healthy (the normal case) `flushWakeTurn` was
  never even scheduled — the human got the Telegram ping, the agent never
  acted. **Fixed by PR #12** (`feff0a9`, "schedule wake turn even when
  direct-send succeeds") — the early `return` was removed; see the comment
  at `:448-451`.

**Grep:** `"\[imajin-ws\] direct-sent "`, `"\[imajin-ws\] warp wake: batched "`,
`"system-event queue rejected"`.

## Hop 7 — `flushWakeTurn()`: schedule the real agent turn

`src/notification-injector.ts:281` (`flushWakeTurn`), fired once per scope
when the coalesce timer elapses. Unschedules any still-pending turn under the
same tag (`unscheduleSessionTurnsByTag`), builds the combined message, then
calls the host's `api.session.workflow.scheduleSessionTurn` — which reaches
openclaw core's `schedulePluginSessionTurn`
(`src/plugins/host-hook-scheduled-turns.ts:235`). That function creates a
Cron `at` job (`wakeMode: "now"`, `deleteAfterRun: true`,
`host-hook-scheduled-turns.ts:317-330`) targeting `session:{sessionKey}`.

**Returns on success:** `{ id, pluginId, sessionKey, kind: "session-turn" }`
— a real Cron job id (`host-hook-scheduled-turns.ts:365-387`,
`registerPluginSessionSchedulerJob`).

**Returns on failure — and this is the crux of #13:** `undefined`, from *six
different branches* in `schedulePluginSessionTurn`, only three of which log
anything:
- Warned: unsupported `deliveryMode` (`:259-268`), `deleteAfterRun` on a
  `cron`-kind schedule (`:269-278`), a reserved-character tag (`:279-289`),
  no `cron` service available (`:294-303`), `cron.add()` throwing
  (`:316-340`), or a rollback that itself fails to remove the job
  (`:345-364`).
- **Silent** (`:244-246`, `:249-251`, `:252-255`, `:341-344`, and the
  `shouldCommit()` gate at `:291-293` and again at `:345`): plugin origin is
  not `"bundled"`; missing `sessionKey`/`message`; an unparseable schedule;
  `cron.add()` itself resolving without an `id` on the returned job; or —
  the most plausible mechanism for the incident below — the plugin's
  liveness gate (`isLoadedRecordInLiveRegistry`, wired in as `shouldCommit`
  at `src/plugins/registry-api.ts:343-357`) reading `false` either **before**
  `cron.add()` (job never created) or **after** it (job created, then
  immediately rolled back — `removeScheduledSessionTurn`,
  `host-hook-scheduled-turns.ts:107-123`). Openclaw core's own contract test,
  `"removes a stale cron job when the plugin unloads after cron.add"`
  (`src/plugins/contracts/scheduled-turns.contract.test.ts:572-592`),
  exercises exactly this create-then-rollback sequence and asserts no
  observable effect beyond the `undefined` return — confirming the host
  gives a caller **zero** signal to distinguish "never tried" from "tried,
  succeeded, then got silently undone".

  This liveness gate flips to `false` whenever the plugin looks unloaded or
  the registry has been retired by a newer one (`registry-lifecycle.ts:107`,
  `isPluginRegistryRetired`) — which happens on a plugin/config hot-reload or
  a full gateway restart. Diagnosing a future recurrence: check for a plugin
  reload/registry-swap log line at the exact `scheduleSessionTurn` call
  timestamp.

- **Fixed by this PR (#13):** a missing/empty `id` is now always treated as a
  **failure**, never logged as if it were a successful schedule (see the
  `handle?.id ?? "(no id)"` anti-pattern this replaces). On failure:
  1. `console.warn` with the raw response (`safePreview(handle)`) so the
     refusal shape is visible next time.
  2. Retry once (`attemptSchedule` called a second time).
  3. If the retry also has no id, send a plain channel message — same
     `sendChannelMessage` mechanism as the instant ping — "Warp run `{title}`
     finished — automatic wake failed (`{reason}`); ask me to review" to the
     same `directSend` target the completion ping went to.
- **Determinism (#13):** even a real `id` is not proof the turn ran — the
  host creates the Cron job record synchronously but runs it asynchronously.
  `watchWakeTurn` (`:232`) arms a `WAKE_CONFIRM_TIMEOUT_MS` (60s) watchdog;
  an `agent_end` hook registered once per injector (`:246-259`) confirms the
  oldest pending wake by matching `event.sessionKey === wakeSessionKey`
  (openclaw core fires `agent_end` with the same `sessionKey` the turn ran
  in — `src/plugins/hook-message.types.ts:60-82`). If nothing confirms it
  within the window, the same channel-message escalation fires with a
  `"never ran"` reason.

**Grep:**
```
"scheduled wake turn "                    — success (real id logged)
"wake schedule returned no job id"        — #13 tier 1 failure (warn)
"wake fallback ALSO returned no job id"   — #13 tier 2 failure (warn)
"wake turn FAILED for"                    — #13 escalation triggered
"wake turn confirmed "                    — #13 determinism check passed
"never ran (no agent_end within"          — #13 determinism check failed
"wake-failure fallback message sent"      — escalation channel message delivered
```

## Hop 8 — Cron fires the job → real agent turn

Openclaw core's Cron service runs the `at`-scheduled `agentTurn` payload in
`session:{wakeSessionKey}` at (or a few seconds after) the scheduled time,
delivering with `mode: "announce", channel: "last"`. This is what actually
produces the "the agent reacted to my Warp run" experience — as opposed to
`runHeartbeatOnce`, which wakes an isolated, `lightContext` heartbeat lane
that cannot see the owner's session at all (see the evidence note at
`notification-injector.ts:109-114` — this was the mechanism before PR #11).

**Known failure modes:**
- *Heartbeat lane woke instead of the conversation.* Pre-PR-#11, the wake
  used `runHeartbeatOnce`. **Fixed by PR #11**
  (`ima-jin/openclaw-imajin-plugin`, `d3cd2d3`) — switched to
  `scheduleSessionTurn` targeting the exact owner session key.

**Grep:** application-level — there is no dedicated log line for "a
cron-triggered turn started" distinct from any other turn; this is exactly
why Hop 7's confirmation watchdog exists (it is currently the only
plugin-observable signal that a scheduled turn actually ran, since no
job-status query is exposed to plugins — confirmed against
`openclaw/plugin-sdk` types: `session.workflow` only exposes
`scheduleSessionTurn`/`unscheduleSessionTurnsByTag`/
`registerSessionSchedulerJob`, `src/plugins/api-facades.ts:36-42`).

## Root cause of the 2026-09-05 18:53 "no id" incident

Evidence:
```
18:48:34  direct-sent warp.run.completed → telegram:8321865723 (context queued via system-event)
18:48:34  warp wake: batched ntf_yxCD5EUs-xB1oKuC (n=1, fires in 300000ms)
18:53:34  scheduled wake turn (no id) for warp.run.completed → agent:main:telegram:direct:8321865723 (1 notification(s) coalesced)
```
No warn, no error, nothing else — just the misleading "(no id)" success-shaped
log line this PR removes.

Per Hop 7 above, `schedulePluginSessionTurn` returns `undefined` completely
silently in several branches, and the shape of a "created, then immediately
rolled back because the plugin looked unloaded" sequence
(`shouldCommit`/`isLoadedRecordInLiveRegistry`) is the best-evidenced
candidate: it is the *only* documented path in openclaw core that can create
a real Cron job and then erase it with zero log trace
(`scheduled-turns.contract.test.ts:572-592` pins exactly this behaviour with
no log assertions). The 5-minute gap between the batch opening (18:48:34,
proving the plugin *was* alive and connected then) and the flush
(18:53:34) is exactly the coalesce window — so nothing about the timing rules
out a registry hot-reload landing in that window (PR #12's own fix had just
shipped ~10-15 minutes earlier and explicitly "Requires gateway restart to
take effect on the running plugin"). This cannot be fully confirmed without
an operator/deploy-side reload log at 18:53:3x specifically — that is the one
piece this doc cannot supply after the fact, which is exactly why this PR
adds the raw-response warn log: the next occurrence will show the field
value instead of a guess.

Ruled out from the source:
- **Not** a session-busy/already-queued refusal (hypothesis a) — no such
  check exists in `cron.add()`'s add path (openclaw core's
  `src/cron/service/ops-mutations.ts` has no per-session concurrency limit;
  the only "already exists" check is a `normalizedId` collision, which
  throws rather than silently swallowing).
- **Not** a config gate named `hooks.allowRequestSessionKey` (hypothesis c)
  — no such config key exists anywhere in openclaw core's schema or plugin
  hook policy types.
- Coalescing itself (hypothesis d) does not drop the newest notification —
  every push into `coalesceByScope` appends to the same array
  (`notification-injector.ts:466`), pinned by a regression test.

## Is the 19:09:01 `warp.run.timeout` a genuine kernel event?

**No — it is a plugin-side log-format artifact, not a live event.** The lines
```
19:09:01  injecting [warp.run.completed, warp.run.timeout] → session agent:main:telegram:direct:8321865723
19:09:01  wake turns → session agent:main:telegram:direct:8321865723 (coalesce 300000ms)
```
are `createNotificationInjector`'s **one-time startup banner**
(`notification-injector.ts:273-275` and `:277-278`), printed whenever the
injector is constructed — i.e. whenever the plugin (re)registers, on a
gateway restart or a plugin hot-reload. It lists the *static configuration*
(`wsNotifications.injectScopes`), not a pair of live notifications that just
arrived. `warp.run.timeout` appears in it because that scope is (correctly)
configured to wake the agent — not because a timeout notification was
received at 19:09:01.

The timing lines up with the human's 19:07 ping: the plugin/gateway most
likely restarted around then in response, which is what re-printed the
banner two minutes later.

Separately, even taking the log at face value as a real timeout: it would
still be impossible for it to be genuine. Per `run-watch-sweep.ts:97`,
`warp.run.timeout` is only ever published by the sweep, and only for a
candidate whose latest activity is older than `SWEEP_LOOKBACK_MS` (6 hours).
The runs in question were dispatched at 18:24 — about 45 minutes before
19:09, nowhere near 6 hours old. So a genuine kernel-published
`warp.run.timeout` for any of those runs would itself be a violation of
#2032's terminal-timeout guard. Recommendation if this pattern recurs with a
*confirmed* live notification (not just the startup banner): capture the
notification's `id`/`runId` from the `[imajin-ws] notification: warp.run.timeout — …`
line (Hop 5's grep) and check that `runId`'s `warp.agent.dispatched`/
`warp.run.resumed` timestamps in `kernel.event_subscription_log` directly —
if its latest activity is under 6h old, file it against
`ima-jin/imajin-ai` as a #2032 regression with that evidence attached.

## Operator quick-reference: grep by symptom

- **"The agent never reacted to a completed run"** — grep the gateway
  journal for the run's `[imajin-ws] notification: warp.run.completed`
  line, then follow forward for `warp wake: batched` → `scheduled wake turn`
  (or one of the #13 failure/escalation lines above). If a plain channel
  message saying "automatic wake failed" arrived, the fix in this PR already
  did its job — the referenced `(reason)` says why.
- **"scheduled wake turn (no id)" appears** — should no longer happen after
  this PR (it is now a `wake schedule returned no job id` warn +
  retry/escalation). If you still see the literal string `(no id)`, the
  deployed build predates this fix.
- **A wake turn was scheduled but the agent still never spoke** — grep for
  `wake turn confirmed` for that id; its absence plus a
  `never ran (no agent_end within` line means the Cron job itself never
  fired — escalate to openclaw core, since that is entirely host-side from
  this point on.
