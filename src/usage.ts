/**
 * Read-only usage reporting for `imajin_usage` (#72).
 *
 * Wire contract: the kernel usage service's OpenAPI spec
 * (`GET {node}/usage/api/spec`, apps/kernel/app/usage/api in ima-jin/imajin-ai):
 *   - `GET /usage/api/summary?window=` → one UsageSummary per window. There is
 *     no per-day breakdown in a single response, so per-day figures are built
 *     here from one single-day window (`YYYY-MM-DD..YYYY-MM-DD`, inclusive,
 *     UTC) call per day. `incurred` (our meter) and `billed` (the
 *     counterparty's statement) are never merged — only labeled.
 *   - `GET /usage/api/rollup/{did}/latest[?window=YYYY-MM-DD]` → the public
 *     signed `usage.rollup` attestation.
 * Every field passed through below is a field in that spec.
 */

/** Spec `UsageSummary`. Every field is optional on the wire as far as this reader cares. */
export interface UsageSummary {
  did?: string;
  window?: string;
  incurred?: { total?: number; byProvider?: Record<string, number> };
  billed?: {
    total?: number;
    byVendor?: Record<string, number>;
    bySource?: Record<string, number>;
  };
  drift?: number;
  rollup?: { attestationId?: string; signedAt?: string } | null;
  currency?: string;
}

/** Spec `UsageRollupAttestation`, passed through unmodified. */
export type UsageRollupAttestation = Record<string, unknown>;

export interface UsageRange {
  from: string;
  to: string;
}

export interface UsageRangeInput {
  from?: string;
  to?: string;
  month?: string;
}

export const MAX_DAILY_DAYS = 31;
export const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

export const INCURRED_LABEL =
  "INCURRED — our own meter (usage.incurred); an estimate recorded at call time, not an invoice";
export const BILLED_LABEL =
  "BILLED — the counterparty's statement (usage.billed: api/manual/document); never merged with incurred";

/** Parse a strict `YYYY-MM-DD` to a UTC epoch ms, or null when malformed / not a real date. */
export function parseDay(value: string): number | null {
  if (!DAY_PATTERN.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return formatDay(ms) === value ? ms : null;
}

export function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function monthRange(month: string): UsageRange | { error: string } {
  if (!MONTH_PATTERN.test(month) || parseDay(`${month}-01`) === null) {
    return { error: `Invalid month '${month}' — expected YYYY-MM` };
  }
  const start = parseDay(`${month}-01`) as number;
  const next = new Date(start);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { from: `${month}-01`, to: formatDay(next.getTime() - DAY_MS) };
}

function validateExplicitRange(from: string, to: string | undefined, today: string): UsageRange | { error: string } {
  const fromMs = parseDay(from);
  if (fromMs === null) return { error: `Invalid 'from' '${from}' — expected YYYY-MM-DD` };
  const resolvedTo = to ?? today;
  const toMs = parseDay(resolvedTo);
  if (toMs === null) return { error: `Invalid 'to' '${resolvedTo}' — expected YYYY-MM-DD` };
  if (fromMs > toMs) return { error: `'from' (${from}) is after 'to' (${resolvedTo})` };
  if ((toMs - fromMs) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    return { error: `Range exceeds ${MAX_RANGE_DAYS} days — narrow from/to` };
  }
  return { from, to: resolvedTo };
}

/**
 * Resolve the report window (UTC dates, inclusive). `month` and `from`/`to` are
 * mutually exclusive; with neither, the current UTC month (the kernel's own default).
 */
export function resolveUsageRange(
  input: UsageRangeInput,
  now: Date = new Date(),
): UsageRange | { error: string } {
  const today = formatDay(now.getTime());
  if (input.month !== undefined && (input.from !== undefined || input.to !== undefined)) {
    return { error: "Pass either 'month' or 'from'/'to', not both" };
  }
  if (input.month !== undefined) return monthRange(input.month);
  if (input.from !== undefined) return validateExplicitRange(input.from, input.to, today);
  if (input.to !== undefined) return { error: "'to' requires 'from'" };
  return monthRange(today.slice(0, 7));
}

/** Inclusive list of UTC days in the range, clamped to `lastDay` (so future days cost no calls). */
export function listDays(range: UsageRange, lastDay: string): string[] {
  const days: string[] = [];
  const end = Math.min(parseDay(range.to) as number, parseDay(lastDay) as number);
  for (let ms = parseDay(range.from) as number; ms <= end; ms += DAY_MS) {
    days.push(formatDay(ms));
  }
  return days;
}

function dayCount(range: UsageRange): number {
  const span = (parseDay(range.to) as number) - (parseDay(range.from) as number);
  return span / DAY_MS + 1;
}

export function windowParam(from: string, to: string): string {
  return `${from}..${to}`;
}

function amount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isEmptyDay(summary: UsageSummary): boolean {
  return (
    amount(summary.incurred?.total) === 0 &&
    amount(summary.billed?.total) === 0 &&
    amount(summary.drift) === 0
  );
}

/** Labeled, separate incurred/billed blocks — kernel field names kept verbatim. */
function labeled(summary: UsageSummary) {
  return {
    incurred: { label: INCURRED_LABEL, ...(summary.incurred ?? { total: 0, byProvider: {} }) },
    billed: { label: BILLED_LABEL, ...(summary.billed ?? { total: 0, byVendor: {}, bySource: {} }) },
    drift: summary.drift ?? 0,
  };
}

export type FetchUsageSummary = (window: string) => Promise<UsageSummary>;

/**
 * Totals for the whole range (one kernel call) plus, when `daily`, one call per
 * UTC day (days with no incurred/billed/drift are counted, not listed).
 */
export async function buildUsageReport(
  fetchSummary: FetchUsageSummary,
  range: UsageRange,
  opts: { daily: boolean; today: string },
) {
  const days = opts.daily ? listDays(range, opts.today) : [];
  if (days.length > MAX_DAILY_DAYS) {
    throw new Error(
      `daily breakdown is limited to ${MAX_DAILY_DAYS} days (got ${days.length}) — narrow from/to or pass daily: false`,
    );
  }

  const totals = await fetchSummary(windowParam(range.from, range.to));

  // At most MAX_DAILY_DAYS (31) concurrent reads — the cap above bounds the fan-out.
  const perDay = await Promise.all(
    days.map(async (date) => ({ date, summary: await fetchSummary(windowParam(date, date)) })),
  );

  const report = {
    window: { from: range.from, to: range.to, timezone: "UTC" },
    currency: totals.currency ?? "USD",
    totals: { ...labeled(totals), rollup: totals.rollup ?? null },
  };
  if (!opts.daily) return report;

  const listed = perDay.filter((entry) => !isEmptyDay(entry.summary));
  return {
    ...report,
    days: listed.map((entry) => ({ date: entry.date, ...labeled(entry.summary) })),
    daysWithNoUsage: perDay.length - listed.length,
    daysNotYetElapsed: dayCount(range) - days.length,
  };
}
