import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ImajinClient, WarpAgentRun } from "./client.js";
import { createWarpTool } from "./tools.js";

const rawUsage = { inferenceCost: 260.4375, computeCost: 12.3017, platformCost: 109.8067 };
const run: WarpAgentRun = {
  runId: "issue-102-run",
  state: "SUCCEEDED",
  sessionLink: null,
  title: null,
  configName: null,
  requestUsage: rawUsage,
  statusMessage: { message: "large status", errorCode: null, retryable: null },
  artifacts: [{ artifactType: "PULL_REQUEST", createdAt: null, data: { url: "fixture" } }],
};

function fixture(runs: WarpAgentRun[] = [run], usdPerCredit?: number) {
  const client = {
    getWarpRun: vi.fn().mockResolvedValue(runs[0]),
    listWarpRuns: vi.fn().mockResolvedValue({ runs, hasNextPage: true, nextCursor: "next-page" }),
  } as unknown as ImajinClient;
  return { client, tool: createWarpTool(client, { usdPerCredit }) };
}

describe("Warp credit output (#111)", () => {
  it.each([
    ["get_run", false], ["get_run", true], ["list_runs", false], ["list_runs", true],
  ] as const)("labels the #102 run in %s (compact=%s) without changing raw fields", async (action, compact) => {
    const { client, tool } = fixture();
    const result = await tool.execute("1", {
      action, compact, runId: run.runId, onBehalfOf: "did:imajin:principal",
    });
    const body = JSON.parse(result.content[0].text);
    const output = action === "get_run" ? body : body.runs[0];
    expect(output.requestUsage).toEqual({
      ...rawUsage, credits: expect.closeTo(382.5459, 4), usdEst: 5.89, unit: "warp_credits",
    });
    expect(output.requestUsage.credits).toBeCloseTo(382.5, 1);
    expect(output.artifacts[0].data).toEqual(compact ? null : run.artifacts![0].data);
    expect(output.statusMessage).toEqual(compact ? undefined : run.statusMessage);
    if (action === "list_runs") {
      expect(body.totals).toEqual({ credits: expect.closeTo(382.5459, 4), usdEst: 5.89 });
      expect(body).toMatchObject({ hasNextPage: true, nextCursor: "next-page" });
      expect(client.listWarpRuns).toHaveBeenCalledWith({}, "did:imajin:principal");
    } else {
      expect(client.getWarpRun).toHaveBeenCalledWith(run.runId, "did:imajin:principal");
    }
    expect(run.requestUsage).toEqual(rawUsage);
    expect(run.requestUsage).not.toHaveProperty("credits");
    expect(run.statusMessage).toBeDefined();
    expect(run.artifacts![0].data).not.toBeNull();
    expect(tool.description).toContain("are Warp credits");
    expect(tool.description).toContain("NOT dollars");
    expect(tool.description).toContain("usdEst");
  });

  const missingUsageCases = [
    { usage: undefined, credits: 0 },
    { usage: null, credits: 0 },
    { usage: {}, credits: 0 },
    { usage: { inferenceCost: null, computeCost: null, platformCost: null }, credits: 0 },
    { usage: { inferenceCost: null, computeCost: 2, platformCost: null }, credits: 2 },
    { usage: { inferenceCost: 3, computeCost: null }, credits: 3 },
    { usage: { inferenceCost: 0, computeCost: 0, platformCost: 0 }, credits: 0 },
  ];

  it.each(missingUsageCases)("returns finite numbers for incomplete usage $usage", async ({ usage, credits }) => {
    const { tool } = fixture([{ ...run, state: "INPROGRESS", requestUsage: usage }]);
    for (const action of ["get_run", "list_runs"]) {
      const body = JSON.parse((await tool.execute("1", { action, runId: run.runId })).content[0].text);
      const output = action === "get_run" ? body : body.runs[0];
      expect(output.requestUsage).toMatchObject({ credits, unit: "warp_credits" });
      expect(output.requestUsage).toMatchObject(usage ?? {});
      expect(Number.isFinite(output.requestUsage.credits)).toBe(true);
      expect(Number.isFinite(output.requestUsage.usdEst)).toBe(true);
      if (action === "list_runs") expect(body.totals.credits).toBe(credits);
    }
  });

  it.each([0, 0.02])("uses configured usdPerCredit=%s for runs and totals", async (usdPerCredit) => {
    const { tool } = fixture([run, run], usdPerCredit);
    const expectedUsd = usdPerCredit === 0 ? 0 : 7.65;
    for (const action of ["get_run", "list_runs"]) {
      const body = JSON.parse((await tool.execute("1", { action, runId: run.runId })).content[0].text);
      expect((action === "get_run" ? body : body.runs[0]).requestUsage.usdEst).toBe(expectedUsd);
      if (action === "list_runs") expect(body.totals.usdEst).toBe(usdPerCredit === 0 ? 0 : 15.3);
    }
  });

  it.each([-1, NaN, Infinity, -Infinity, "0.02"])("rejects invalid rate %s without client calls", (rate) => {
    const { client } = fixture();
    expect(() => createWarpTool(client, { usdPerCredit: rate as number })).toThrow(
      "warp.usdPerCredit must be a finite, non-negative number",
    );
    expect(client.getWarpRun).not.toHaveBeenCalled();
    expect(client.listWarpRuns).not.toHaveBeenCalled();
  });

  it.each([false, true])("sums the page before display truncation and rounds only once (compact=%s)", async (compact) => {
    const runs = Array.from({ length: 30 }, (_, i) => ({
      ...run, runId: `run-${i}`, requestUsage: { inferenceCost: 0.1 },
    }));
    const { tool } = fixture(runs);
    const body = JSON.parse((await tool.execute("1", { action: "list_runs", compact })).content[0].text);
    expect(body.runs).toHaveLength(compact ? 30 : 21);
    expect(body.runs[0].requestUsage.usdEst).toBe(0);
    expect(body.totals.credits).toBeCloseTo(3);
    expect(body.totals.usdEst).toBe(0.05);
    expect(body.nextCursor).toBe("next-page");
    if (!compact) expect(body.runs[20]).toEqual({ _truncated: true, total: 30, showing: 20 });
  });

  it.each([false, true])("returns numeric zero totals for empty pages (compact=%s)", async (compact) => {
    const { tool } = fixture([]);
    expect(JSON.parse((await tool.execute("1", { action: "list_runs", compact })).content[0].text)).toEqual({
      runs: [], totals: { credits: 0, usdEst: 0 }, hasNextPage: true, nextCursor: "next-page",
    });
  });

  it("declares the default rate and non-negative constraint in the config schema", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(manifest.configSchema.properties.warp).toMatchObject({
      type: "object", additionalProperties: false,
      properties: { usdPerCredit: { type: "number", minimum: 0, default: 0.0154 } },
    });
    expect(manifest.uiHints["warp.usdPerCredit"].help).toContain("credits, not dollars");
  });
});
