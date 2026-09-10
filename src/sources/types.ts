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
 *   - `resolve` takes a third `expectedSourceRevision` argument (the sketch
 *     shows only `resolve(id, decision)`). This is the source's own NATIVE
 *     anti-tamper pin (the Gateway's `proposalHash` for system-agent, Skill
 *     Workshop's `revisionHash`) — never the kernel-facing `contentHash`
 *     digest (see `gateway-approvals-bridge.ts`'s module doc for that
 *     distinction, tightened per #2084 review). The bridge tracks it
 *     exactly (`published`, in `gateway-approvals-bridge.ts`) and passes it
 *     straight through so a source's own revision-binding primitive (Skill
 *     Workshop's `expectedRevisionHash` param on `apply`/`reject`) is bound
 *     to EXACTLY what the operator reviewed.
 *   - `onDriftPolicy` was added so each source can express what should
 *     happen after a detected mismatch: system-agent's existing behaviour
 *     (#24) leaves the stale entry tracked until a full reconcile/reconnect
 *     fixes it up; Skill Workshop instead wants the drifted proposal
 *     immediately re-staged with its current revision hash (#33 acceptance:
 *     "revision drift → no apply + re-stage").
 *
 * #2084 review update: the kernel-facing `contentHash` (computed by the
 * bridge, not by sources, matching the kernel's OWN recomputation —
 * `ima-jin/imajin-ai#2154`) covers the WHOLE canonical `{proposalId,
 * source, kind, summary, keysTouched, detail}` payload the operator is
 * shown. There is no top-level `sourceRevision` on the wire: the bridge
 * folds each source's `sourceRevision` (below) into `detail.sourceRevision`
 * before hashing, so it is covered by the hash without adding a key the
 * kernel's recomputation doesn't expect. See `gateway-approvals-bridge.ts`'s
 * module doc for the exact digest definition. `ApprovalSourceRequest`/
 * `ApprovalSourceCurrentState` below only ever carry each source's NATIVE
 * `sourceRevision` as its own field — they never merge it into `detail`
 * themselves, and never compute or see the composite `contentHash` itself;
 * that stays entirely bridge-owned so every source shares one digest rule.
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
   * The source's own NATIVE anti-tamper pin (the Gateway's `proposalHash`
   * for system-agent, Skill Workshop's `revisionHash`). This is one
   * ingredient of the bridge's composite `contentHash` digest (#2084) —
   * never the digest itself. See `gateway-approvals-bridge.ts`'s module doc.
   */
  sourceRevision: string;
  /**
   * Optional bounded structured payload for a per-kind /jin card renderer
   * (#2152). Omitted entirely for sources with nothing structured to add
   * (system-agent). Must fit the kernel's 16 KB cap — enforced by the
   * source that populates it. Covered by the bridge's `contentHash` digest
   * (#2084) — mutating `detail` without changing `sourceRevision` still
   * changes the digest.
   */
  detail?: Record<string, unknown>;
}

/** A source's current, live view of one proposal — used only for the anti-tamper check before resolving a decision. */
export interface ApprovalSourceCurrentState {
  pending: boolean;
  /** `null` when the source cannot recover a revision pin for a no-longer-pending/unknown proposal. */
  sourceRevision: string | null;
  /**
   * The CURRENT `detail` for this proposal, refetched live (#2084) — lets
   * the bridge recompute the full `contentHash` digest and catch a
   * proposal whose `detail` changed after the operator decided, even when
   * `sourceRevision` alone did not.
   */
  detail?: Record<string, unknown>;
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
   * store. `expectedSourceRevision` is exactly this proposal's `sourceRevision`
   * at publish time (see module doc) — a source with its own native
   * revision-binding primitive (e.g. Skill Workshop's `expectedRevisionHash`)
   * should pass it straight through so the decision can only ever apply to
   * the content the operator actually reviewed. The bridge has ALREADY
   * verified the composite `contentHash` (covering `detail` too, #2084)
   * before ever calling this — this parameter is the source-native
   * fail-closed pin, not a re-statement of that check.
   */
  resolve(
    proposalId: string,
    decision: ApprovalDecision,
    expectedSourceRevision: string,
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
