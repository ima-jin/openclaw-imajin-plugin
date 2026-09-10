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
});
