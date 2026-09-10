/**
 * Generic approval-source adapter interface (#33, generalizing #24's
 * hardcoded OpenClaw-system-agent-only bridge).
 *
 * A `GatewayApprovalsBridge` (`../gateway-approvals-bridge.ts`) is driven by
 * zero or more `ApprovalSource`s — one per `approvals.sources` config entry
 * — and owns everything that is genuinely source-agnostic: signing the
 * kernel wish, dedup by `proposalId`, startup reconcile, POSTing to the
 * kernel, and routing `operator.approval.decided` bus events back to the
 * source that published the matching proposal. Each `ApprovalSource` owns
 * only what is genuinely specific to it: how to list/observe pending items
 * from its own backing store, and how to carry an operator decision back to
 * that backing store.
 *
 * This is a deliberate, disclosed compression of the inline interface sketch
 * in #33 (`ApprovalSource { id; list(); subscribe(onRequested, onResolved);
 * resolve(id, decision); decisionLabels?; buildDetail?(req) }`) — see the PR
 * body for the full rationale:
 *
 *   - `buildDetail?(req)` is folded into `detail` on `ApprovalSourceRequest`
 *     itself, since both `list()`/`subscribe()` and `buildDetail` would run
 *     at the same call site in every real source; a separate late-bound hook
 *     added no flexibility this repo's two sources needed.
 *   - `subscribe`'s `onResolved` parameter is dropped: neither source has a
 *     "this proposal was resolved by someone else" push signal to honestly
 *     wire up (the OpenClaw Gateway has no such event for system-agent
 *     proposals, and Skill Workshop's only observation surface is polling
 *     `skills.proposals.list`, see `skill-workshop.ts`). Inventing one would
 *     violate the issue's own "do not invent" instruction.
 *   - `getCurrent` was added. It is not in the issue's inline sketch, but the
 *     bridge's existing (#24) anti-tamper check — "does the proposal this
 *     operator decided on still match what was signed and published?" —
 *     needs a uniform way to refetch a source's current state before ever
 *     calling `resolve`. Without it, preserving #24's exact system-agent
 *     behaviour (required: "zero behaviour change") would not be possible
 *     from the bridge alone.
 *   - `resolve` takes a third `expectedContentHash` argument (the sketch
 *     shows only `resolve(id, decision)`). The bridge already tracks the
 *     exact hash it signed and published for this proposal id (`published`,
 *     in `gateway-approvals-bridge.ts`) — passing it through lets a source
 *     bind its own native anti-tamper primitive to EXACTLY what the operator
 *     reviewed (Skill Workshop's `expectedRevisionHash` param on `apply`/
 *     `reject`) without re-deriving or re-caching that value itself, which
 *     would otherwise risk silently rebinding to a newer, unreviewed
 *     revision on every list()/poll refresh.
 *   - `onDriftPolicy` was added so each source can express what should
 *     happen after a detected mismatch: system-agent's existing behaviour
 *     (#24) leaves the stale entry tracked until a full reconcile/reconnect
 *     fixes it up; Skill Workshop instead wants the drifted proposal
 *     immediately re-staged with its current revision hash (#33 acceptance:
 *     "revision drift → no apply + re-stage").
 */

/** The kernel's generic decision vocabulary (#2152) — never source-specific. */
export type ApprovalDecision = "approve" | "reject";

/**
 * One pending item as reported by an `ApprovalSource`, already normalized to
 * exactly what the bridge needs to sign, publish, and later route a decision
 * back to the right source.
 */
export interface ApprovalSourceRequest {
  /** Stable id for this pending item, unique within its own source. */
  proposalId: string;
  /** Namespaced `"<source>:<subkind>"` kernel kind (#2152), e.g. `"system-agent:restart"` or `"skill-workshop:update"`. */
  kind: string;
  /** Human summary shown on the /jin default card. Bounded by the source. */
  summary: string;
  /**
   * The source's own native anti-tamper hash (the Gateway's `proposalHash`
   * for system-agent, Skill Workshop's `revisionHash`). This is deliberately
   * NOT a hash this plugin computes over the outgoing payload itself — see
   * `gateway-approvals-bridge.ts`'s module doc for why that would overstate
   * the actual guarantee this bridge can honestly provide in v1.
   */
  contentHash: string;
  /**
   * Optional bounded structured payload for a per-kind /jin card renderer
   * (#2152). Omitted entirely for sources with nothing structured to add
   * (system-agent). Must fit the kernel's 16 KB cap — enforced by the
   * source that populates it.
   */
  detail?: Record<string, unknown>;
}

/** A source's current, live view of one proposal — used only for the anti-tamper check before resolving a decision. */
export interface ApprovalSourceCurrentState {
  pending: boolean;
  /** `null` when the source cannot recover any hash for a no-longer-pending/unknown proposal. */
  contentHash: string | null;
}

export type Unsubscribe = () => void;

/** One pending-approval provider the generic bridge can drive (#33). */
export interface ApprovalSource {
  readonly id: string;

  /** Startup/reconcile backfill: every currently-pending item from this source. */
  list(): Promise<ApprovalSourceRequest[]>;

  /** Registers a live "new pending item" observer. Returns an unsubscribe function. */
  subscribe(onRequested: (request: ApprovalSourceRequest) => void): Unsubscribe;

  /** Refetches one proposal's current live state, for the anti-tamper check before ever resolving a decision. `null` when unknown to this source. */
  getCurrent(proposalId: string): Promise<ApprovalSourceCurrentState | null>;

  /**
   * Carries a verified operator decision back to this source's own backing
   * store. `expectedContentHash` is exactly the `contentHash` this proposal
   * was published with (see module doc) — a source with its own native
   * revision-binding primitive (e.g. Skill Workshop's `expectedRevisionHash`)
   * should pass it straight through so the decision can only ever apply to
   * the content the operator actually reviewed.
   */
  resolve(
    proposalId: string,
    decision: ApprovalDecision,
    expectedContentHash: string,
  ): Promise<{ applied: boolean }>;

  /** Button labels for the /jin card. Omit for the default (Approve/Deny). */
  readonly decisionLabels?: { approve: string; reject: string };

  /**
   * What the bridge should do after `getCurrent` reveals the tracked
   * content hash no longer matches: `"leave"` (default when omitted) keeps
   * the stale entry tracked, exactly like #24's original system-agent
   * behaviour, until a full reconcile/reconnect naturally repopulates it.
   * `"restage"` evicts the stale entry and immediately re-lists this one
   * source so the operator sees a fresh card bound to the current hash
   * (#33's Skill Workshop requirement).
   */
  readonly onDriftPolicy?: "leave" | "restage";
}

/**
 * Thrown by `ApprovalSource.resolve` when the source's own backing store
 * refused the decision because the proposal changed after the operator
 * decided on it (e.g. Skill Workshop's `expectedRevisionHash` mismatch).
 * The bridge catches this uniformly, regardless of source, to drive the
 * kernel mismatch notification and the source's `onDriftPolicy`.
 */
export class ApprovalContentDriftError extends Error {
  constructor(
    public readonly proposalId: string,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalContentDriftError";
  }
}
