/**
 * Pure helpers for the account usage dialog: ranges, the stable colour each
 * account wears, scoping to one account, tile rates, chart columns and the
 * labels tables and tooltips use. The server aggregates; nothing here sums
 * accounts back into totals (that would drop requests no account served).
 */
import type {
  PoolAccount,
  PoolUsage,
  PoolUsageAccount,
  PoolUsageBucket,
  PoolUsageEvent,
  PoolUsageModel,
  PoolUsageRange,
  PoolUsageTotals,
  UsageTokenTotals,
} from "@t3tools/contracts";
import { formatDayShort, formatHourShort } from "@t3tools/shared/usageFormat";

import { orderAccounts, POOL_PROVIDER_LABEL } from "./pool.logic";

export const POOL_USAGE_RANGES: ReadonlyArray<{
  readonly value: PoolUsageRange;
  readonly label: string;
}> = [
  { value: "24h", label: "24 hours" },
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

export const DEFAULT_POOL_USAGE_RANGE: PoolUsageRange = "7d";

export type UsageChartMetric = "cost" | "tokens";

// ---------------------------------------------------------------------------
// Colours

/**
 * The dataviz reference categorical palette, light and dark steps of the same
 * eight hues (validated adjacent-pair CVD and contrast in both modes). The
 * order is the colour-blind safety: slots are handed out in sequence and
 * stacked in slot order, so touching segments are always validated neighbours.
 */
const SERIES_COLORS: ReadonlyArray<readonly [light: string, dark: string]> = [
  ["#2a78d6", "#3987e5"],
  ["#eb6834", "#d95926"],
  ["#1baf7a", "#199e70"],
  ["#eda100", "#c98500"],
  ["#e87ba4", "#d55181"],
  ["#008300", "#008300"],
  ["#4a3aa7", "#9085e9"],
  ["#e34948", "#e66767"],
];

const lightDark = ([light, dark]: readonly [string, string]) => `light-dark(${light}, ${dark})`;

/** Series keys that are not an account (auth file names never start with ":"). */
export const OTHER_ACCOUNTS_KEY = ":other";
export const NO_ACCOUNT_KEY = ":none";

const OTHER_ACCOUNTS_COLOR = lightDark(["#898781", "#898781"]);
const NO_ACCOUNT_COLOR = lightDark(["#c3c2b7", "#52514e"]);

export interface UsageSeries {
  /** An account id, `OTHER_ACCOUNTS_KEY` (past the eighth account) or `NO_ACCOUNT_KEY`. */
  readonly key: string;
  readonly color: string;
  /** Tells accounts apart without printing an address (tooltips and legends are not masked). */
  readonly label: string;
}

export interface UsageSeriesIndex {
  /** Stack order, bottom first: the eight coloured accounts, then the rest, then no account. */
  readonly series: readonly UsageSeries[];
  /** The series an account's usage is drawn in; unknown or empty ids are "No account". */
  readonly keyOf: (accountId: string | undefined) => string;
  readonly colorOf: (accountId: string | undefined) => string;
  readonly labelOf: (accountId: string | undefined) => string;
}

/** `someone@example.com` → `SE`, like the Usage page's account chips: enough to tell accounts apart, too little to identify one. */
export function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

/** "Claude AE": an account's short, unmasked-safe name for tooltips, legends and tables. */
export function usageAccountShortLabel(account: Pick<PoolUsageAccount, "provider" | "email">) {
  const provider = POOL_PROVIDER_LABEL[account.provider];
  const email = account.email?.trim();
  return email ? `${provider} ${accountInitials(email)}` : `${provider} account`;
}

/**
 * Colours follow the account, never its cost rank or the range: signed-in
 * accounts take slots in the order Settings lists them, then any the status
 * has not caught up with, then removed ones (both by id). Past eight, accounts
 * share one neutral "Other accounts" series instead of a generated hue.
 */
export function buildUsageSeries(
  usageAccounts: readonly PoolUsageAccount[],
  liveAccounts: readonly PoolAccount[],
): UsageSeriesIndex {
  const byId = new Map(usageAccounts.map((account) => [account.id, account]));
  const byIdOrder = (a: PoolUsageAccount, b: PoolUsageAccount) => a.id.localeCompare(b.id);
  const live = orderAccounts(liveAccounts).flatMap((account) => byId.get(account.id) ?? []);
  const liveIds = new Set(live.map((account) => account.id));
  const rest = usageAccounts.filter((account) => !liveIds.has(account.id));
  const ordered = [
    ...live,
    ...rest.filter((account) => account.current).toSorted(byIdOrder),
    ...rest.filter((account) => !account.current).toSorted(byIdOrder),
  ];

  const slotted = new Map<string, UsageSeries>();
  ordered.slice(0, SERIES_COLORS.length).forEach((account, index) => {
    slotted.set(account.id, {
      key: account.id,
      color: lightDark(SERIES_COLORS[index]!),
      label: usageAccountShortLabel(account),
    });
  });
  const other: UsageSeries = {
    key: OTHER_ACCOUNTS_KEY,
    color: OTHER_ACCOUNTS_COLOR,
    label: "Other accounts",
  };
  const none: UsageSeries = { key: NO_ACCOUNT_KEY, color: NO_ACCOUNT_COLOR, label: "No account" };

  const keyOf = (accountId: string | undefined) => {
    if (accountId === undefined || !byId.has(accountId)) return NO_ACCOUNT_KEY;
    return slotted.has(accountId) ? accountId : OTHER_ACCOUNTS_KEY;
  };
  const seriesOf = (accountId: string | undefined) => {
    const key = keyOf(accountId);
    return key === NO_ACCOUNT_KEY ? none : key === OTHER_ACCOUNTS_KEY ? other : slotted.get(key)!;
  };
  return {
    series: [...slotted.values(), ...(ordered.length > slotted.size ? [other] : []), none],
    keyOf,
    colorOf: (accountId) => seriesOf(accountId).color,
    // A folded account still has its own name; only its colour is shared.
    labelOf: (accountId) => {
      const account = accountId === undefined ? undefined : byId.get(accountId);
      return account ? usageAccountShortLabel(account) : none.label;
    },
  };
}

// ---------------------------------------------------------------------------
// Scoping and tiles

export interface ScopedUsage {
  readonly totals: PoolUsageTotals;
  readonly models: readonly PoolUsageModel[];
  readonly recentEvents: readonly PoolUsageEvent[];
  readonly recentErrors: readonly PoolUsageEvent[];
}

/** The selected account, or null when none is selected or it is not in this range's answer. */
export function findUsageAccount(
  usage: PoolUsage,
  accountId: string | null,
): PoolUsageAccount | null {
  if (accountId === null) return null;
  return usage.accounts.find((account) => account.id === accountId) ?? null;
}

/** Everything below the filter row, for every account or just the selected one. */
export function scopeUsage(usage: PoolUsage, account: PoolUsageAccount | null): ScopedUsage {
  if (account === null) {
    return {
      totals: usage.totals,
      models: usage.models,
      recentEvents: usage.recentEvents,
      recentErrors: usage.recentErrors,
    };
  }
  return {
    totals: account.totals,
    models: account.models,
    recentEvents: usage.recentEvents.filter((event) => event.accountId === account.id),
    recentErrors: usage.recentErrors.filter((event) => event.accountId === account.id),
  };
}

/** Everything sent to the model: uncached, read from cache and written to cache. */
export function inputTokens(tokens: UsageTokenTotals): number {
  return tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.cacheCreationTokens;
}

/** Input plus output; reasoning is part of output, never added on top. */
export function totalTokens(tokens: UsageTokenTotals): number {
  return inputTokens(tokens) + tokens.outputTokens;
}

/** Share of requests that succeeded; null with no requests (never a misleading 0%). */
export function successRate(totals: Pick<PoolUsageTotals, "requests" | "failed">): number | null {
  return totals.requests === 0 ? null : (totals.requests - totals.failed) / totals.requests;
}

/** Cache read ÷ all input; null with no input. */
export function cacheHitRate(tokens: UsageTokenTotals): number | null {
  const input = inputTokens(tokens);
  return input === 0 ? null : tokens.cachedInputTokens / input;
}

/** The cost tile can't claim $0.00 when prices could not be loaded at all. */
export function isCostUnknown(usage: Pick<PoolUsage, "pricing">, totals: PoolUsageTotals): boolean {
  return usage.pricing.status === "unavailable" && totalTokens(totals.tokens) > 0;
}

/** A model row whose cost is only unpriced requests: "Unpriced", not $0.00. */
export function isModelUnpriced(model: PoolUsageModel): boolean {
  return model.totals.unpricedRequests > 0 && model.totals.costUsd === 0;
}

/**
 * The message shown instead of the dashboard when there is nothing to show;
 * null when there is. Recording that is off explains itself (e.g. a team
 * server records its own usage) before any "nothing yet".
 */
export function emptyUsageMessage(usage: PoolUsage): string | null {
  const unattributed = usage.unattributed?.requests ?? 0;
  if (usage.totals.requests > 0 || unattributed > 0 || usage.recentEvents.length > 0) return null;
  const note = usage.recordingNote?.trim();
  if (!usage.recording && note) return note;
  if (usage.recordedSince !== undefined) return "No requests in this period.";
  return "Usage shows up here as your accounts serve requests.";
}

// ---------------------------------------------------------------------------
// Chart

export interface UsageChartColumn {
  /** The bucket key (`YYYY-MM-DD` or an hour's ISO start). */
  readonly key: string;
  /** Aligned with `UsageChart.series`, bottom first. */
  readonly values: readonly number[];
  readonly total: number;
}

export interface UsageChart {
  /** Series with something to draw in this range, stack order. */
  readonly series: readonly UsageSeries[];
  readonly columns: readonly UsageChartColumn[];
  /** The tallest column (stacked, so the sum, not the largest segment). */
  readonly peak: number;
}

/**
 * One stacked column per bucket, every series in stack order. With an account
 * selected the chart is that account alone, in its own colour.
 */
export function buildUsageChart(
  buckets: readonly PoolUsageBucket[],
  index: UsageSeriesIndex,
  metric: UsageChartMetric,
  selectedAccountId: string | null,
): UsageChart {
  const measure = (entry: PoolUsageBucket["accounts"][number]) =>
    metric === "cost" ? entry.costUsd : entry.tokens;

  if (selectedAccountId !== null) {
    const series: UsageSeries = {
      key: selectedAccountId,
      color: index.colorOf(selectedAccountId),
      label: index.labelOf(selectedAccountId),
    };
    const columns = buckets.map((bucket) => {
      const total = bucket.accounts
        .filter((entry) => entry.id === selectedAccountId)
        .reduce((sum, entry) => sum + measure(entry), 0);
      return { key: bucket.key, values: [total], total };
    });
    return { series: [series], columns, peak: peakOf(columns) };
  }

  const position = new Map(index.series.map((series, at) => [series.key, at]));
  const raw = buckets.map((bucket) => {
    const values = index.series.map(() => 0);
    for (const entry of bucket.accounts) {
      const at = position.get(index.keyOf(entry.id))!;
      values[at] = values[at]! + measure(entry);
    }
    return { key: bucket.key, values };
  });
  // Drop series with nothing in the range, so the tooltip lists only who served.
  const kept = index.series.flatMap((series, at) =>
    raw.some((column) => column.values[at]! > 0) ? [{ series, at }] : [],
  );
  const columns = raw.map((column) => {
    const values = kept.map(({ at }) => column.values[at]!);
    return { key: column.key, values, total: values.reduce((sum, value) => sum + value, 0) };
  });
  return { series: kept.map(({ series }) => series), columns, peak: peakOf(columns) };
}

export interface StackSegment {
  /** Index into the chart's series. */
  readonly at: number;
  /** Percent of the plot height, from the baseline. */
  readonly bottom: number;
  readonly height: number;
  /** The lowest drawn segment sits on the baseline; each one above gives up 2px for the gap below it. */
  readonly first: boolean;
  /** The highest drawn segment carries the rounded data end. */
  readonly last: boolean;
}

/** Where each non-empty segment of one column sits, bottom-up, on a scale topping out at `max`. */
export function stackSegments(values: readonly number[], max: number): StackSegment[] {
  if (max <= 0) return [];
  const drawn = values.flatMap((value, at) => (value > 0 ? [{ at, value }] : []));
  let base = 0;
  return drawn.map(({ at, value }, index) => {
    const segment = {
      at,
      bottom: (base / max) * 100,
      height: (value / max) * 100,
      first: index === 0,
      last: index === drawn.length - 1,
    };
    base += value;
    return segment;
  });
}

function peakOf(columns: readonly UsageChartColumn[]): number {
  return columns.reduce((max, column) => Math.max(max, column.total), 0);
}

/** Axis label for a bucket: "Oct 1" by day, "3 PM" by hour in the viewer's zone. */
export function bucketAxisLabel(key: string, resolution: "hour" | "day", timeZone: string) {
  return resolution === "hour" ? formatHourShort(key, timeZone) : formatDayShort(key);
}

// ---------------------------------------------------------------------------
// Times and durations

const eventTimeFormatters = new Map<string, Intl.DateTimeFormat>();

/** "Oct 1, 3:04 PM": request lists need minutes (`formatDateTimeShort` stops at the hour). */
export function formatEventTime(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  let formatter = eventTimeFormatters.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      // An unknown zone from an old client falls back to the browser's own.
      formatter = new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    }
    eventTimeFormatters.set(timeZone, formatter);
  }
  return formatter.format(date);
}

/** "850 ms", "2.1 s", "1.5 min"; "—" when nothing reported one. */
export function formatLatency(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1).replace(/\.0$/, "")} s`;
  return `${(ms / 60_000).toFixed(1).replace(/\.0$/, "")} min`;
}

/** A failed request's status cell: the HTTP code when known. */
export function eventStatusLabel(event: Pick<PoolUsageEvent, "failed" | "statusCode">): string {
  if (!event.failed) return "OK";
  return event.statusCode === undefined ? "Failed" : String(event.statusCode);
}
