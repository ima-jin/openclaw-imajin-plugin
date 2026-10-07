import { describe, it, expect, vi } from "vitest";
import {
  BILLED_LABEL,
  INCURRED_LABEL,
  buildUsageReport,
  listDays,
  parseDay,
  resolveUsageRange,
  type UsageSummary,
} from "./usage.js";

const NOW = new Date("2026-10-07T19:52:55Z");

describe("parseDay", () => {
  it("accepts real UTC dates only", () => {
    expect(parseDay("2026-10-07")).toBe(Date.parse("2026-10-07T00:00:00Z"));
    expect(parseDay("2026-02-30")).toBeNull();
    expect(parseDay("2026-13-01")).toBeNull();
    expect(parseDay("2026-10-7")).toBeNull();
    expect(parseDay("2026-10-07T00:00:00Z")).toBeNull();
  });
});

describe("resolveUsageRange", () => {
  it("defaults to the current UTC month", () => {
    expect(resolveUsageRange({}, NOW)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("resolves a month, including leap-year February", () => {
    expect(resolveUsageRange({ month: "2028-02" }, NOW)).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });

  it("resolves from/to and defaults `to` to today", () => {
    expect(resolveUsageRange({ from: "2026-10-01", to: "2026-10-07" }, NOW)).toEqual({
      from: "2026-10-01",
      to: "2026-10-07",
    });
    expect(resolveUsageRange({ from: "2026-10-01" }, NOW)).toEqual({
      from: "2026-10-01",
      to: "2026-10-07",
    });
  });

  it.each([
    [{ month: "2026-10", from: "2026-10-01" }, /either 'month' or 'from'/],
    [{ month: "2026-1" }, /Invalid month/],
    [{ to: "2026-10-07" }, /'to' requires 'from'/],
    [{ from: "yesterday" }, /Invalid 'from'/],
    [{ from: "2026-10-01", to: "nope" }, /Invalid 'to'/],
    [{ from: "2026-10-07", to: "2026-10-01" }, /after 'to'/],
    [{ from: "2024-01-01", to: "2026-01-01" }, /exceeds 366 days/],
  ])("rejects %j", (input, message) => {
    const result = resolveUsageRange(input, NOW);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(message);
  });
});

describe("listDays", () => {
  it("lists inclusive days and clamps to the last elapsed day", () => {
    expect(listDays({ from: "2026-10-05", to: "2026-10-09" }, "2026-10-07")).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
    ]);
  });

  it("is empty when the whole range is in the future", () => {
    expect(listDays({ from: "2026-10-08", to: "2026-10-09" }, "2026-10-07")).toEqual([]);
  });
});

describe("buildUsageReport", () => {
  const byWindow: Record<string, UsageSummary> = {
    "2026-10-05..2026-10-07": {
      incurred: { total: 30, byProvider: { anthropic: 20, warp: 10 } },
      billed: { total: 25, byVendor: { anthropic: 25 }, bySource: { api: 25 } },
      drift: 5,
      rollup: { attestationId: "att_1", signedAt: "2026-10-07T00:00:00Z" },
      currency: "USD",
    },
    "2026-10-05..2026-10-05": {
      incurred: { total: 10, byProvider: { anthropic: 10 } },
      billed: { total: 0, byVendor: {}, bySource: {} },
      drift: 0,
    },
    "2026-10-06..2026-10-06": {
      incurred: { total: 0, byProvider: {} },
      billed: { total: 0, byVendor: {}, bySource: {} },
      drift: 0,
    },
    "2026-10-07..2026-10-07": {
      incurred: { total: 20, byProvider: { anthropic: 10, warp: 10 } },
      billed: { total: 25, byVendor: { anthropic: 25 }, bySource: { api: 25 } },
      drift: 5,
    },
  };
  const fetchSummary = vi.fn(async (window: string) => byWindow[window]);

  it("returns labeled, separate incurred/billed totals and per-day entries", async () => {
    fetchSummary.mockClear();
    const report = await buildUsageReport(
      fetchSummary,
      { from: "2026-10-05", to: "2026-10-07" },
      { daily: true, today: "2026-10-07" },
    );

    expect(fetchSummary).toHaveBeenCalledTimes(4);
    expect(report.window).toEqual({ from: "2026-10-05", to: "2026-10-07", timezone: "UTC" });
    expect(report.currency).toBe("USD");
    expect(report.totals.incurred).toEqual({
      label: INCURRED_LABEL,
      total: 30,
      byProvider: { anthropic: 20, warp: 10 },
    });
    expect(report.totals.billed).toEqual({
      label: BILLED_LABEL,
      total: 25,
      byVendor: { anthropic: 25 },
      bySource: { api: 25 },
    });
    expect(report.totals.drift).toBe(5);
    expect(report.totals.rollup).toEqual({
      attestationId: "att_1",
      signedAt: "2026-10-07T00:00:00Z",
    });

    const withDays = report as typeof report & {
      days: Array<{ date: string; incurred: { total: number }; billed: { total: number } }>;
      daysWithNoUsage: number;
      daysNotYetElapsed: number;
    };
    expect(withDays.days.map((d) => d.date)).toEqual(["2026-10-05", "2026-10-07"]);
    expect(withDays.days[1].incurred.total).toBe(20);
    expect(withDays.days[1].billed.total).toBe(25);
    expect(withDays.daysWithNoUsage).toBe(1);
    expect(withDays.daysNotYetElapsed).toBe(0);
  });

  it("makes a single kernel call and no `days` when daily is false", async () => {
    fetchSummary.mockClear();
    const report = await buildUsageReport(
      fetchSummary,
      { from: "2026-10-05", to: "2026-10-07" },
      { daily: false, today: "2026-10-07" },
    );
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    expect(fetchSummary).toHaveBeenCalledWith("2026-10-05..2026-10-07");
    expect(report).not.toHaveProperty("days");
  });

  it("does not query days that have not happened yet", async () => {
    const fetch = vi.fn(async () => ({ incurred: { total: 0 }, billed: { total: 0 } }));
    const report = await buildUsageReport(
      fetch,
      { from: "2026-10-06", to: "2026-10-09" },
      { daily: true, today: "2026-10-07" },
    );
    // 1 totals call + 2 elapsed days (06, 07)
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((report as { daysNotYetElapsed: number }).daysNotYetElapsed).toBe(2);
  });

  it("defaults missing sections to zero rather than inventing values", async () => {
    const report = await buildUsageReport(
      async () => ({}),
      { from: "2026-10-07", to: "2026-10-07" },
      { daily: false, today: "2026-10-07" },
    );
    expect(report.currency).toBe("USD");
    expect(report.totals.incurred.total).toBe(0);
    expect(report.totals.billed.total).toBe(0);
    expect(report.totals.drift).toBe(0);
    expect(report.totals.rollup).toBeNull();
  });

  it("refuses a daily breakdown longer than 31 days", async () => {
    const fetch = vi.fn();
    await expect(
      buildUsageReport(fetch, { from: "2026-08-01", to: "2026-10-07" }, { daily: true, today: "2026-10-07" }),
    ).rejects.toThrow(/limited to 31 days/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates a kernel failure from any call", async () => {
    const fetch = vi.fn(async (window: string) => {
      if (window === "2026-10-06..2026-10-06") throw new Error("Imajin API 500: boom");
      return {};
    });
    await expect(
      buildUsageReport(fetch, { from: "2026-10-05", to: "2026-10-07" }, { daily: true, today: "2026-10-07" }),
    ).rejects.toThrow(/500/);
  });
});
