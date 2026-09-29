/**
 * Approvals bridge: entitlement preflight + `operator.approval.decided`
 * catch-up (#53).
 *
 * ## Why this exists
 *
 * The kernel's grant-bound event-subscription fan-out
 * (`packages/bus/src/subscriptions.ts` in ima-jin/imajin-ai) pushes
 * `operator.approval.decided` ONLY to DIDs whose ACTIVE delegation grant
 * carries the `operator:approvals` capability
 * (`packages/auth/src/grant-scopes.ts`). Without it the kernel pushes
 * nothing and raises no error — the /jin card just sits at
 * "approved — pending apply". And a decision must never depend on the socket
 * being open at the instant it was made.
 *
 * ## Kernel read path used (no new endpoint invented)
 *
 * `GET /auth/api/events/subscriptions/catchup?cursor=<seq>&limit=<n>`
 * (`apps/kernel/app/auth/api/events/subscriptions/catchup/route.ts`). It is
 * session-authenticated as the calling DID and returns
 * `{ events, nextCursor, entitledEventTypes }`, where:
 *
 *  - `events` are the durable `kernel.event_subscription_log` rows after
 *    `cursor` that the caller's CURRENTLY active grants entitle (the same
 *    per-row audience check the live push does), oldest first;
 *  - `entitledEventTypes` is the set of event types the caller's active
 *    grants entitle. `operator.approval.decided` is mapped ONLY by the
 *    `operator:approvals` scope, so its presence is exactly "the agent holds
 *    `operator:approvals`" — this is the capability read (the kernel has no
 *    "list my own received grants" route: `GET /auth/api/grants` lists the
 *    DELEGATOR's issued grants, not the grantee's).
 *
 * Known limitation: `entitledEventTypes` is not audience-aware, so a grant
 * that carries the capability but whose audience excludes the operator/agent
 * DID would pass this check yet still not deliver. See the follow-up noted in
 * the PR / README.
 *
 * This module has no plugin-SDK imports and no top-level I/O so it is unit
 * testable with plain fakes.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { KernelBusEventFrame } from "./gateway-approvals-bridge.js";

export const OPERATOR_APPROVALS_CAPABILITY = "operator:approvals";
export const APPROVAL_DECIDED_EVENT_TYPE = "operator.approval.decided";
export const SUBSCRIPTION_CATCHUP_PATH = "/auth/api/events/subscriptions/catchup";
export const APPROVALS_CURSOR_FILENAME = "approvals-decided-cursor.json";

/** Pages fetched per catch-up run at most; the persisted cursor resumes on the next (re)connect. */
export const DEFAULT_CATCHUP_MAX_PAGES = 50;

/**
 * Terminal-or-not result of trying to apply one decided event.
 * `deferred` is the ONLY non-terminal outcome (a transient failure BEFORE any
 * state change, e.g. the source's `getCurrent` threw) — catch-up will not
 * advance its persisted cursor past it, so the next reconnect retries.
 */
export type DecisionOutcome = "applied" | "noop" | "rejected" | "deferred";

interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

/** The subset of `ImajinClient.requestRaw` this module needs (status-only errors — bodies are never surfaced). */
export interface KernelHttp {
  requestRaw(
    path: string,
    opts?: { method?: "GET"; onBehalfOf?: string },
  ): Promise<{ status: number; contentType: string; text: string }>;
}

export interface CaughtUpEvent {
  id: string;
  cursor: string;
  eventType: string;
  issuer: string;
  subject: string;
  scope: string;
  payload: Record<string, unknown> | null;
  correlationId: string | null;
  occurredAt: string;
  grantId: string;
}

export interface CatchUpPage {
  events: CaughtUpEvent[];
  nextCursor: string;
  entitledEventTypes: string[];
}

export class CatchUpHttpError extends Error {
  constructor(readonly status: number) {
    super(`kernel event-subscription catch-up failed (HTTP ${status})`);
    this.name = "CatchUpHttpError";
  }
}

function isNonNegativeIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isCaughtUpEvent(value: unknown): value is CaughtUpEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    isNonNegativeIntegerString(e.cursor) &&
    typeof e.eventType === "string" &&
    typeof e.issuer === "string" &&
    typeof e.subject === "string"
  );
}

/** One page of the kernel's catch-up read. Throws `CatchUpHttpError` on non-200 and `Error` on a malformed body. */
export async function fetchCatchUpPage(http: KernelHttp, cursor: string, limit?: number): Promise<CatchUpPage> {
  const query = `cursor=${encodeURIComponent(cursor)}${limit ? `&limit=${limit}` : ""}`;
  // "self": the catch-up route resolves `actingAs ?? id` — an `actAs` delegation
  // header would query the PRINCIPAL's entitlements instead of this agent's.
  const res = await http.requestRaw(`${SUBSCRIPTION_CATCHUP_PATH}?${query}`, { onBehalfOf: "self" });
  if (res.status !== 200) throw new CatchUpHttpError(res.status);
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    throw new Error("kernel event-subscription catch-up returned a non-JSON body");
  }
  const b = body as Partial<CatchUpPage> | null;
  if (
    !b ||
    !Array.isArray(b.events) ||
    !isNonNegativeIntegerString(b.nextCursor) ||
    !Array.isArray(b.entitledEventTypes)
  ) {
    throw new Error("kernel event-subscription catch-up returned an unexpected shape");
  }
  return {
    events: b.events.filter(isCaughtUpEvent),
    nextCursor: b.nextCursor,
    entitledEventTypes: b.entitledEventTypes.filter((t): t is string => typeof t === "string"),
  };
}

// --- Entitlement preflight ---

export type EntitlementState =
  | { state: "entitled" }
  | { state: "missing" }
  /** The check itself failed (kernel unreachable, auth hiccup, unexpected body). NOT treated as degraded — retried on the next (re)connect. */
  | { state: "unknown"; reason: string };

/**
 * Reads the agent's own effective entitlement from the kernel: does an active
 * grant carry `operator:approvals` (⇔ `operator.approval.decided` is in
 * `entitledEventTypes`)? Cursor `0`/limit `1` keeps this a cheap read; nothing
 * is persisted or applied.
 */
export async function checkApprovalsEntitlement(http: KernelHttp): Promise<EntitlementState> {
  try {
    const page = await fetchCatchUpPage(http, "0", 1);
    return page.entitledEventTypes.includes(APPROVAL_DECIDED_EVENT_TYPE)
      ? { state: "entitled" }
      : { state: "missing" };
  } catch (err) {
    return { state: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The ONE startup error for a missing grant: names the agent DID, the missing
 * capability, and the exact grant the owner must author. Contains only DIDs
 * and a capability string — never any secret.
 */
export function describeMissingApprovalsGrant(params: { agentDid: string; operatorDid: string }): string {
  const { agentDid, operatorDid } = params;
  return [
    `agent ${agentDid} lacks the "${OPERATOR_APPROVALS_CAPABILITY}" capability on this kernel node, so the kernel will NOT push ` +
      `"${APPROVAL_DECIDED_EVENT_TYPE}" to it — operator approvals on /jin cannot be applied live (bridge DEGRADED).`,
    `The owner (delegator, ${operatorDid}) must author this delegation grant: ` +
      `POST /auth/api/grants ` +
      JSON.stringify({
        agentDid,
        capabilities: [OPERATOR_APPROVALS_CAPABILITY],
        audience: { type: "dids", values: [operatorDid, agentDid] },
      }) +
      `, or add the capability to an existing active grant for this agent: ` +
      `PUT /auth/api/grants/{grantId}/capabilities/${OPERATOR_APPROVALS_CAPABILITY}.`,
    `The audience must allow both the operator DID and the agent DID (the kernel publishes a decided event addressed to each). ` +
      `Once granted, the next WS reconnect re-checks and catches up missed decisions automatically.`,
  ].join(" ");
}

/** Human-facing (Telegram) text sent when a card is published while the bridge is degraded. */
export function buildDegradedPublishWarning(params: {
  agentDid: string;
  proposalId: string;
  kind: string;
}): string {
  return (
    `⚠ bridge cannot apply: agent lacks ${OPERATOR_APPROVALS_CAPABILITY}. ` +
    `The /jin card for ${params.kind} (${params.proposalId}) is live, but approving it there will NOT be applied ` +
    `until the owner grants ${OPERATOR_APPROVALS_CAPABILITY} to ${params.agentDid}.`
  );
}

// --- Durable cursor ---

interface CursorFileShape {
  version: 1;
  nodeUrl: string;
  agentDid: string;
  cursor: string;
}

/**
 * Persisted "last fully processed `event_subscription_log.seq`" for this
 * agent + node. Best-effort like every other state file in this plugin: a
 * missing/corrupt/foreign file degrades to cursor `0` (replay the retention
 * window — safe, because applying an already-applied decision is a no-op),
 * and a write failure is logged, never thrown. Monotonic: never moves back.
 */
export class ApprovalsCursorStore {
  private cursor = "0";

  constructor(
    private readonly filePath: string | undefined,
    private readonly scope: { nodeUrl: string; agentDid: string },
    private readonly logger: Logger = console,
  ) {}

  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf-8")) as Partial<CursorFileShape>;
      if (
        parsed.nodeUrl === this.scope.nodeUrl &&
        parsed.agentDid === this.scope.agentDid &&
        isNonNegativeIntegerString(parsed.cursor)
      ) {
        this.cursor = parsed.cursor;
      }
    } catch {
      // First run or unreadable file: start from 0.
    }
  }

  get(): string {
    return this.cursor;
  }

  /** Advances (never rewinds) and persists. A no-op when `next` is not ahead of the current cursor. */
  async advance(next: string): Promise<void> {
    if (!isNonNegativeIntegerString(next) || BigInt(next) <= BigInt(this.cursor)) return;
    this.cursor = next;
    if (!this.filePath) return;
    const shape: CursorFileShape = { version: 1, ...this.scope, cursor: next };
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, JSON.stringify(shape, null, 2), "utf-8");
      await rename(tmp, this.filePath);
    } catch (err: unknown) {
      this.logger.error(
        `[imajin-approvals-bridge] failed to persist approvals cursor: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// --- Catch-up ---

export interface CatchUpSummary {
  pages: number;
  scanned: number;
  decided: number;
  applied: number;
  deferred: number;
  cursor: string;
}

/** Re-shapes a durable log row as the live `bus_event` frame the bridge's handler already consumes. */
export function toBusEventFrame(event: CaughtUpEvent): KernelBusEventFrame {
  return {
    type: "bus_event",
    id: event.id,
    cursor: event.cursor,
    eventType: event.eventType,
    issuer: event.issuer,
    subject: event.subject,
    scope: event.scope,
    payload: event.payload ?? undefined,
    correlationId: event.correlationId,
    occurredAt: event.occurredAt,
    grantId: event.grantId,
  };
}

/**
 * Reads every entitled event after the persisted cursor and applies each
 * `operator.approval.decided` through `applyDecision` — the SAME handler the
 * live WS path uses, so verification (operator identity, contentHash echo,
 * operator countersignature, source drift check) and idempotency are
 * identical. The cursor advances only across a contiguous run of TERMINAL
 * outcomes: it stops at the first `deferred` event so a transient failure is
 * retried on the next reconnect, while later events are still attempted
 * (re-applying one is a no-op).
 *
 * Only this function advances the cursor — never a live frame — because live
 * pushes are best-effort and can skip a seq; the durable log read cannot.
 */
export async function runApprovalsCatchUp(deps: {
  http: KernelHttp;
  store: ApprovalsCursorStore;
  applyDecision: (frame: KernelBusEventFrame) => Promise<DecisionOutcome>;
  logger: Logger;
  pageSize?: number;
  maxPages?: number;
}): Promise<CatchUpSummary> {
  const { http, store, applyDecision, logger } = deps;
  const maxPages = deps.maxPages ?? DEFAULT_CATCHUP_MAX_PAGES;
  const summary: CatchUpSummary = { pages: 0, scanned: 0, decided: 0, applied: 0, deferred: 0, cursor: store.get() };

  let fetchCursor = store.get();
  let safeCursor = fetchCursor;
  let blocked = false;

  try {
    while (summary.pages < maxPages) {
      const page = await fetchCatchUpPage(http, fetchCursor, deps.pageSize);
      summary.pages += 1;
      for (const event of page.events) {
        summary.scanned += 1;
        if (event.eventType === APPROVAL_DECIDED_EVENT_TYPE) {
          summary.decided += 1;
          const outcome = await applyDecision(toBusEventFrame(event));
          if (outcome === "applied") summary.applied += 1;
          if (outcome === "deferred") {
            summary.deferred += 1;
            blocked = true;
          }
        }
        if (!blocked) safeCursor = event.cursor;
      }
      // `nextCursor` also advances over rows the kernel filtered out by audience.
      if (!blocked && BigInt(page.nextCursor) > BigInt(safeCursor)) safeCursor = page.nextCursor;
      if (page.nextCursor === fetchCursor) break;
      fetchCursor = page.nextCursor;
    }
  } finally {
    await store.advance(safeCursor);
    summary.cursor = store.get();
  }

  if (summary.decided > 0 || summary.deferred > 0) {
    logger.info(
      `catch-up: scanned ${summary.scanned} event(s), ${summary.decided} decided, ${summary.applied} applied, ` +
        `${summary.deferred} deferred (cursor ${summary.cursor})`,
    );
  }
  return summary;
}
