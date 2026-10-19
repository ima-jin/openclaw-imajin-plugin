import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSkillWorkshopSource,
  type SkillWorkshopGatewayClient,
  type SkillWorkshopProposalSummary,
} from "./skill-workshop.js";
import { ApprovalContentDriftError } from "./types.js";

function makeProposal(overrides: Partial<SkillWorkshopProposalSummary> = {}): SkillWorkshopProposalSummary {
  return {
    id: "proposal-1",
    kind: "update",
    status: "pending",
    title: "Update trip-planning",
    description: "Also check seat maps before booking.",
    skillName: "trip-planning",
    skillKey: "trip-planning",
    scanState: "clean",
    revisionHash: "rev-1",
    ...overrides,
  };
}

class GatewayClientRequestError extends Error {
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GatewayClientRequestError";
  }
}

function makeClient(): { client: SkillWorkshopGatewayClient; fns: Record<string, ReturnType<typeof vi.fn>> } {
  const fns = {
    list: vi.fn().mockResolvedValue({ proposals: [] }),
    inspect: vi.fn().mockResolvedValue({ revisionHash: "inspected-rev-1" }),
    apply: vi.fn().mockResolvedValue({ applied: true }),
    reject: vi.fn().mockResolvedValue(undefined),
  };
  return { client: fns as unknown as SkillWorkshopGatewayClient, fns };
}

describe("createSkillWorkshopSource", () => {
  it("has id \"skill-workshop\", onDriftPolicy \"restage\", and Apply/Reject decision labels", () => {
    const { client } = makeClient();
    const source = createSkillWorkshopSource(client);
    expect(source.id).toBe("skill-workshop");
    expect(source.onDriftPolicy).toBe("restage");
    expect(source.decisionLabels).toEqual({ approve: "Apply", reject: "Reject" });
  });

  it("list() maps only pending proposals with bounded detail", async () => {
    const { client, fns } = makeClient();
    fns.list.mockResolvedValue({
      proposals: [makeProposal(), makeProposal({ id: "applied-1", status: "applied" })],
    });
    const source = createSkillWorkshopSource(client);

    const requests = await source.list();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      proposalId: "proposal-1",
      kind: "skill-workshop:update",
      sourceRevision: "rev-1",
    });
    expect(requests[0].detail).toMatchObject({
      skillName: "trip-planning",
      kind: "update",
      scan: "clean",
      description: "Also check seat maps before booking.",
    });
    expect(Buffer.byteLength(JSON.stringify(requests[0].detail), "utf8")).toBeLessThanOrEqual(16 * 1024);
  });

  it("bounds an oversized detail payload by shrinking only diffSummary", async () => {
    const { client, fns } = makeClient();
    const hugeDescription = "x".repeat(20 * 1024);
    fns.list.mockResolvedValue({ proposals: [makeProposal({ description: hugeDescription })] });
    const source = createSkillWorkshopSource(client);

    const [request] = await source.list();

    expect(Buffer.byteLength(JSON.stringify(request.detail), "utf8")).toBeLessThanOrEqual(16 * 1024);
    // skillName is never truncated, even when the description/diffSummary is.
    expect(request.detail?.skillName).toBe("trip-planning");
  });

  describe("revision hydration", () => {
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("uses inspect's top-level revision consistently for list, current and apply", async () => {
      const { client, fns } = makeClient();
      fns.list.mockResolvedValue({
        proposals: [makeProposal({ revisionHash: undefined, updatedAt: "2026-10-19T00:00:00Z" })],
      });
      fns.inspect.mockResolvedValue({ revisionHash: "actual-revision", proposal: { revisionHash: "wrong" } });
      const source = createSkillWorkshopSource(client);
      const [request] = await source.list();
      expect(request.sourceRevision).toBe("actual-revision");
      expect(fns.inspect).toHaveBeenCalledWith("proposal-1");
      await expect(source.getCurrent(request.proposalId)).resolves.toEqual({
        pending: true, sourceRevision: request.sourceRevision, detail: request.detail,
      });
      await source.resolve(request.proposalId, "approve", request.sourceRevision);
      expect(fns.apply).toHaveBeenCalledWith("proposal-1", "actual-revision");
      expect(fns.inspect).toHaveBeenCalledTimes(1);
    });

    it("retains valid list revisions without requiring inspect", async () => {
      const { client, fns } = makeClient();
      const inspect = fns.inspect;
      delete client.inspect;
      fns.list.mockResolvedValue({ proposals: [makeProposal()] });
      const source = createSkillWorkshopSource(client);
      expect((await source.list())[0].sourceRevision).toBe("rev-1");
      expect(inspect).not.toHaveBeenCalled();
    });

    it("invalidates cached revisions when updatedAt changes, including getCurrent", async () => {
      const { client, fns } = makeClient();
      const proposal = makeProposal({ revisionHash: undefined, updatedAt: "first" });
      fns.list.mockImplementation(async () => ({ proposals: [proposal] }));
      const source = createSkillWorkshopSource(client);
      expect((await source.list())[0].sourceRevision).toBe("inspected-rev-1");
      await source.list();
      expect(fns.inspect).toHaveBeenCalledTimes(1);
      proposal.updatedAt = "second";
      fns.inspect.mockResolvedValue({ revisionHash: "inspected-rev-2" });
      await expect(source.getCurrent(proposal.id)).resolves.toMatchObject({ sourceRevision: "inspected-rev-2" });
      expect(fns.inspect).toHaveBeenCalledTimes(2);
    });

    it("does not cache proposals lacking updatedAt or reuse their old timestamp cache", async () => {
      const { client, fns } = makeClient();
      const proposal = makeProposal({ revisionHash: undefined, updatedAt: "first" });
      fns.list.mockImplementation(async () => ({ proposals: [proposal] }));
      const source = createSkillWorkshopSource(client);
      await source.list();
      proposal.updatedAt = undefined;
      fns.inspect.mockResolvedValue({ revisionHash: "fresh-revision" });
      expect((await source.list())[0].sourceRevision).toBe("fresh-revision");
      await source.getCurrent(proposal.id);
      expect(fns.inspect).toHaveBeenCalledTimes(3);
      proposal.updatedAt = "first";
      await source.list();
      expect(fns.inspect).toHaveBeenCalledTimes(4);
    });

    it("keys the cache by proposal id and agent and binds scoped apply/reject", async () => {
      const { client, fns } = makeClient();
      client.listAgentIds = vi.fn().mockResolvedValue(["main", "ops"]);
      fns.list.mockImplementation(async (agentId) => ({
        proposals: [
          makeProposal({ id: "shared", revisionHash: undefined, updatedAt: "same" }),
          makeProposal({ id: `${agentId}-only`, revisionHash: undefined, updatedAt: "same" }),
        ],
      }));
      fns.inspect.mockImplementation(async (id, agentId) => ({ revisionHash: `${agentId}-${id}-rev` }));
      const source = createSkillWorkshopSource(client);
      const requests = await source.list();
      expect(requests.map((request) => request.sourceRevision)).toEqual([
        "main-shared-rev", "main-main-only-rev", "ops-ops-only-rev",
      ]);
      expect(fns.inspect).toHaveBeenCalledWith("shared", "main");
      expect(fns.inspect).toHaveBeenCalledWith("shared", "ops");
      await source.list();
      expect(fns.inspect).toHaveBeenCalledTimes(4);
      fns.list.mockClear();
      await expect(source.getCurrent("ops-only")).resolves.toMatchObject({ sourceRevision: "ops-ops-only-rev" });
      expect(fns.list).toHaveBeenCalledTimes(1);
      expect(fns.list).toHaveBeenCalledWith("ops");
      await source.resolve("ops-only", "approve", "ops-ops-only-rev");
      await source.resolve("ops-only", "reject", "ops-ops-only-rev");
      expect(fns.apply).toHaveBeenCalledWith("ops-only", "ops-ops-only-rev", "ops");
      expect(fns.reject).toHaveBeenCalledWith("ops-only", "ops-ops-only-rev", "ops");
    });

    it.each([undefined, null, "", "  ", 42, {}, ["rev"]])(
      "withholds invalid inspect revision %j, logs once, and keeps valid proposals visible",
      async (revisionHash) => {
        const { client, fns } = makeClient();
        fns.list.mockResolvedValue({
          proposals: [makeProposal({ revisionHash: undefined }), makeProposal({ id: "valid" })],
        });
        fns.inspect.mockResolvedValue({ revisionHash });
        const source = createSkillWorkshopSource(client);
        expect((await source.list()).map((request) => request.proposalId)).toEqual(["valid"]);
        expect((await source.list()).map((request) => request.proposalId)).toEqual(["valid"]);
        await expect(source.getCurrent("proposal-1")).resolves.toMatchObject({ pending: false, sourceRevision: null });
        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no verified revisionHash"));
      },
    );

    it("fails closed without inspect support rather than inventing a revision", async () => {
      const { client, fns } = makeClient();
      delete client.inspect;
      fns.list.mockResolvedValue({ proposals: [makeProposal({ revisionHash: undefined })] });
      const source = createSkillWorkshopSource(client);
      await expect(source.list()).resolves.toEqual([]);
      await source.list();
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it("does not cache inspect errors and recovers without hiding another valid proposal", async () => {
      const { client, fns } = makeClient();
      fns.list.mockResolvedValue({
        proposals: [
          makeProposal({ revisionHash: undefined, updatedAt: "same" }),
          makeProposal({ id: "valid" }),
        ],
      });
      fns.inspect.mockRejectedValueOnce(new Error("inspect unavailable"));
      const source = createSkillWorkshopSource(client);
      expect((await source.list()).map((request) => request.proposalId)).toEqual(["valid"]);
      expect((await source.list()).map((request) => request.sourceRevision)).toEqual(["inspected-rev-1", "rev-1"]);
      expect(fns.inspect).toHaveBeenCalledTimes(2);
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it.each(["", " ", undefined, null])("rejects expected revision %j before either decision RPC", async (revision) => {
      const { client, fns } = makeClient();
      const source = createSkillWorkshopSource(client);
      for (const decision of ["approve", "reject"] as const) {
        await expect(source.resolve("proposal-1", decision, revision as string)).rejects.toThrow(
          "requires a non-empty expectedSourceRevision",
        );
      }
      expect(fns.apply).not.toHaveBeenCalled();
      expect(fns.reject).not.toHaveBeenCalled();
    });
  });

  describe("subscribe()", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("polls list() on an interval and reports only newly-seen proposals", async () => {
      const { client, fns } = makeClient();
      fns.list.mockResolvedValue({ proposals: [] });
      const source = createSkillWorkshopSource(client, { pollIntervalMs: 1000 });
      const onRequested = vi.fn();
      const unsubscribe = source.subscribe(onRequested);

      fns.list.mockResolvedValue({ proposals: [makeProposal()] });
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).toHaveBeenCalledTimes(1);
      expect(onRequested).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "proposal-1" }));

      // Same proposal still pending on the next poll — must not re-fire.
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).toHaveBeenCalledTimes(1);

      unsubscribe();
    });
  });

  describe("content-aware publish retries", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it("hydrates polls and recovers from inspect failure without emitting an unrevisioned request", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { client, fns } = makeClient();
      fns.list.mockResolvedValue({
        proposals: [makeProposal({ revisionHash: undefined, updatedAt: "first" })],
      });
      fns.inspect.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ revisionHash: "hydrated" });
      const source = createSkillWorkshopSource(client, { pollIntervalMs: 1000 });
      const onRequested = vi.fn();
      const unsubscribe = source.subscribe(onRequested);
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).toHaveBeenCalledTimes(1);
      expect(onRequested).toHaveBeenCalledWith(expect.objectContaining({ sourceRevision: "hydrated" }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).toHaveBeenCalledTimes(1);
      expect(fns.inspect).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it("emits changed revisions and content for known proposals, but not unchanged requests", async () => {
      const { client, fns } = makeClient();
      const proposal = makeProposal();
      fns.list.mockImplementation(async () => ({ proposals: [proposal] }));
      const source = createSkillWorkshopSource(client, { pollIntervalMs: 1000 });
      await source.list();
      const onRequested = vi.fn();
      const unsubscribe = source.subscribe(onRequested);
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).not.toHaveBeenCalled();
      proposal.revisionHash = "rev-2";
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).toHaveBeenCalledTimes(1);
      proposal.description = "changed content with the same revision";
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).toHaveBeenCalledTimes(2);
      unsubscribe();
    });

    it("retries transient publish failures on the next poll", async () => {
      const { client, fns } = makeClient();
      fns.list.mockResolvedValue({ proposals: [makeProposal()] });
      const source = createSkillWorkshopSource(client, { pollIntervalMs: 1000 });
      await source.list();
      source.onPublishFailed!("proposal-1");
      const onRequested = vi.fn();
      const unsubscribe = source.subscribe(onRequested);
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it("suppresses unchanged failures through retryAtMs, preserving backoff across list()", async () => {
      const { client, fns } = makeClient();
      fns.list.mockResolvedValue({ proposals: [makeProposal()] });
      const source = createSkillWorkshopSource(client, { pollIntervalMs: 1000 });
      await source.list();
      const failed = source.onPublishFailed as (id: string, failure: { retryAtMs: number }) => void;
      failed("proposal-1", { retryAtMs: Date.now() + 2000 });
      const onRequested = vi.fn();
      const unsubscribe = source.subscribe(onRequested);
      await vi.advanceTimersByTimeAsync(1000);
      await source.list();
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(onRequested).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it.each(["revisionHash", "description"] as const)(
      "allows changed %s immediately despite a deterministic failure's retry deadline",
      async (field) => {
        const { client, fns } = makeClient();
        const proposal = makeProposal();
        fns.list.mockImplementation(async () => ({ proposals: [proposal] }));
        const source = createSkillWorkshopSource(client, { pollIntervalMs: 1000 });
        await source.list();
        const failed = source.onPublishFailed as (id: string, failure: { retryAtMs: number }) => void;
        failed("proposal-1", { retryAtMs: Date.now() + 30_000 });
        const onRequested = vi.fn();
        const unsubscribe = source.subscribe(onRequested);
        await vi.advanceTimersByTimeAsync(1000);
        expect(onRequested).not.toHaveBeenCalled();
        proposal[field] = "changed";
        await vi.advanceTimersByTimeAsync(1000);
        expect(onRequested).toHaveBeenCalledTimes(1);
        unsubscribe();
      },
    );
  });

  it("getCurrent() reports pending: false for an unknown/resolved proposal", async () => {
    const { client, fns } = makeClient();
    fns.list.mockResolvedValue({ proposals: [] });
    const source = createSkillWorkshopSource(client);

    await expect(source.getCurrent("proposal-1")).resolves.toEqual({ pending: false, sourceRevision: null });
  });

  it("stage -> decide approve -> apply is called with the matching expectedRevisionHash", async () => {
    const { client, fns } = makeClient();
    const source = createSkillWorkshopSource(client);

    const result = await source.resolve("proposal-1", "approve", "rev-1");

    expect(fns.apply).toHaveBeenCalledWith("proposal-1", "rev-1");
    expect(result.applied).toBe(true);
  });

  it("reject calls client.reject with the matching expectedRevisionHash", async () => {
    const { client, fns } = makeClient();
    const source = createSkillWorkshopSource(client);

    await source.resolve("proposal-1", "reject", "rev-1");

    expect(fns.reject).toHaveBeenCalledWith("proposal-1", "rev-1");
  });

  it("revision drift: apply is attempted with the stale hash but the source throws ApprovalContentDriftError, never masking it as success", async () => {
    const { client, fns } = makeClient();
    fns.apply.mockRejectedValue(
      new GatewayClientRequestError("Skill proposal proposal-1 changed while evaluation was running.", {
        expectedRevisionHash: "rev-1",
        currentRevisionHash: "rev-2",
      }),
    );
    const source = createSkillWorkshopSource(client);

    await expect(source.resolve("proposal-1", "approve", "rev-1")).rejects.toBeInstanceOf(ApprovalContentDriftError);
    expect(fns.apply).toHaveBeenCalledWith("proposal-1", "rev-1");
  });

  it("a non-revision RPC error is rethrown as-is (not converted to a drift error)", async () => {
    const { client, fns } = makeClient();
    fns.apply.mockRejectedValue(new Error("network error"));
    const source = createSkillWorkshopSource(client);

    await expect(source.resolve("proposal-1", "approve", "rev-1")).rejects.toThrow("network error");
  });

  // --- #35: missing operator scope — single warning + backoff, never a crash ---

  function makeMissingScopeError(): GatewayClientRequestError {
    const err = new GatewayClientRequestError("missing scope: operator.read");
    (err as unknown as { gatewayCode: string }).gatewayCode = "FORBIDDEN";
    return err;
  }

  describe("#35 missing operator scope", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("list() propagates the error but logs exactly one actionable warning", async () => {
      const { client, fns } = makeClient();
      fns.list.mockRejectedValue(makeMissingScopeError());
      const source = createSkillWorkshopSource(client);

      await expect(source.list()).rejects.toThrow("missing scope: operator.read");
      await expect(source.list()).rejects.toThrow("missing scope: operator.read");

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("approvals.skillWorkshop.operatorScopes");
      // The generic per-poll console.error path must never fire for this
      // specific, disclosed failure mode.
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("subscribe()'s poll logs the warning once and backs off instead of erroring every interval", async () => {
      vi.useFakeTimers();
      try {
        const { client, fns } = makeClient();
        fns.list.mockRejectedValue(makeMissingScopeError());
        const source = createSkillWorkshopSource(client, { pollIntervalMs: 1000 });
        const onRequested = vi.fn();
        const unsubscribe = source.subscribe(onRequested);

        // First poll fires after pollIntervalMs and hits the missing-scope error.
        await vi.advanceTimersByTimeAsync(1000);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(fns.list).toHaveBeenCalledTimes(1);

        // Backed off: the NEXT poll should not fire at another 1000ms (only
        // at 1000ms * MISSING_SCOPE_BACKOFF_MULTIPLIER from the first).
        await vi.advanceTimersByTimeAsync(1000);
        expect(fns.list).toHaveBeenCalledTimes(1);

        // ...but does fire once the full backoff window has elapsed, and the
        // warning is still only ever logged once.
        await vi.advanceTimersByTimeAsync(9000);
        expect(fns.list).toHaveBeenCalledTimes(2);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(onRequested).not.toHaveBeenCalled();

        unsubscribe();
      } finally {
        vi.useRealTimers();
      }
    });

    it("subscribe() never crashes and keeps polling across a missing-scope error", async () => {
      vi.useFakeTimers();
      try {
        const { client, fns } = makeClient();
        fns.list.mockRejectedValueOnce(makeMissingScopeError());
        fns.list.mockResolvedValue({ proposals: [makeProposal()] });
        const source = createSkillWorkshopSource(client, { pollIntervalMs: 1000 });
        const onRequested = vi.fn();
        const unsubscribe = source.subscribe(onRequested);

        await vi.advanceTimersByTimeAsync(1000);
        expect(warnSpy).toHaveBeenCalledTimes(1);

        // Recovers on the next (backed-off) poll once the scope issue clears.
        await vi.advanceTimersByTimeAsync(1000 * 10);
        expect(onRequested).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "proposal-1" }));

        unsubscribe();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
