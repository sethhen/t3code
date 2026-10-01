// @effect-diagnostics globalDate:off - windows are local days and hours in the viewer's zone, computed with Intl from the caller's clock.
/**
 * The pool's usage report: recorded rollups and recent requests turned into
 * the `usage` answer for one range in the viewer's time zone. Pure: the caller
 * passes the clock, the recorded data, the signed-in accounts and the rates.
 *
 * Costs are priced like the Usage page (upstream's `priceUsage` with the
 * user's price overrides). Pricing is linear in tokens, so pricing each rollup
 * row and summing is exact.
 */
import type {
  PoolProvider,
  PoolUsage,
  PoolUsageAccount,
  PoolUsageBucket,
  PoolUsageEvent,
  PoolUsageModel,
  PoolUsageRange,
  PoolUsageTotals,
  UsagePricing,
  UsageTokenTotals,
} from "@t3tools/contracts";
import { enumerateDays } from "@t3tools/shared/usageFormat";

import { cacheSavingsUsd, priceUsage, type RateTable } from "./t3.ts";
import {
  ROLLUP_BUCKET_MS,
  type AttributedSample,
  type PoolUsageReadModel,
  type UsageRollupRow,
} from "./usageTypes.ts";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const RECENT_EVENTS_LIMIT = 100;
const RECENT_ERRORS_LIMIT = 50;
const EMAIL_KEY_PREFIX = "email:";

// ---------------------------------------------------------------------------
// Local time. Every UTC offset in use is a multiple of 15 minutes and every
// transition happens on a local quarter hour, so local hour and day starts all
// sit on the 15-minute UTC grid the rollups use: a row never straddles two
// buckets, and walking that grid finds every boundary without a tz library.

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      // `h23`: midnight is 00, never 24.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    if (formatters.size >= 32) formatters.clear();
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

/** `timeZone` when Intl knows it, else `UTC` (a bad zone must not fail the report). */
export const resolveTimeZone = (timeZone: string): string => {
  try {
    formatterFor(timeZone);
    return timeZone;
  } catch {
    return "UTC";
  }
};

interface LocalTime {
  /** `YYYY-MM-DD`. */
  readonly day: string;
  /** The local wall clock read as if it were UTC, minute precision. */
  readonly wallMs: number;
  readonly offsetMs: number;
}

const localTime = (timeZone: string, ms: number): LocalTime => {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wallMs = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
  );
  return {
    day: new Date(wallMs).toISOString().slice(0, 10),
    wallMs,
    offsetMs: wallMs - Math.floor(ms / 60_000) * 60_000,
  };
};

/**
 * Two instants share a local hour when the wall hour and the offset match. The
 * offset tells apart the two 01:00 hours of a fall-back night.
 */
const sameLocalHour = (a: LocalTime, b: LocalTime) =>
  a.offsetMs === b.offsetMs && Math.floor(a.wallMs / HOUR_MS) === Math.floor(b.wallMs / HOUR_MS);

const floorToGrid = (ms: number) => Math.floor(ms / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS;

const startOfLocalHour = (timeZone: string, ms: number): number => {
  let start = floorToGrid(ms);
  const hour = localTime(timeZone, start);
  while (sameLocalHour(localTime(timeZone, start - ROLLUP_BUCKET_MS), hour)) {
    start -= ROLLUP_BUCKET_MS;
  }
  return start;
};

const nextLocalHourStart = (timeZone: string, hourStart: number): number => {
  const hour = localTime(timeZone, hourStart);
  let next = hourStart + ROLLUP_BUCKET_MS;
  while (sameLocalHour(localTime(timeZone, next), hour)) next += ROLLUP_BUCKET_MS;
  return next;
};

/**
 * The first instant whose local date is `day` or later. Usually local
 * midnight; where a zone springs forward at midnight, the day starts at 01:00.
 */
const startOfLocalDay = (timeZone: string, day: string): number => {
  const wallMidnight = Date.parse(`${day}T00:00:00Z`);
  let start = floorToGrid(wallMidnight - localTime(timeZone, wallMidnight).offsetMs);
  while (localTime(timeZone, start).day < day) start += ROLLUP_BUCKET_MS;
  while (localTime(timeZone, start - ROLLUP_BUCKET_MS).day >= day) start -= ROLLUP_BUCKET_MS;
  return start;
};

/** Calendar arithmetic on a `YYYY-MM-DD`, in UTC where every day is 24 hours. */
const shiftDay = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;

export interface UsageWindow {
  readonly sinceMs: number;
  /** Exclusive. */
  readonly untilMs: number;
  readonly resolution: "hour" | "day";
  /** Oldest first: UTC ISO hour starts, or `YYYY-MM-DD` days in the zone. */
  readonly bucketKeys: string[];
}

/**
 * The window a range covers in `timeZone` at `now`.
 *
 * - `24h`: the 24 local hours ending with the one that contains `now`.
 * - `today`: local midnight to the end of the current local hour (23 or 25
 *   hourly buckets on a daylight-saving day).
 * - `7d` / `30d` / `90d`: that many local calendar days ending today, from
 *   local midnight of the first to local midnight after today.
 *
 * Hour buckets follow local hour starts, so in a +5:30 zone they start at :30
 * UTC. An unknown zone is read as UTC.
 */
export const usageWindow = (range: PoolUsageRange, timeZone: string, now: number): UsageWindow => {
  const zone = resolveTimeZone(timeZone);
  if (range === "24h" || range === "today") {
    const currentHour = startOfLocalHour(zone, now);
    let sinceMs = currentHour;
    if (range === "today") {
      sinceMs = startOfLocalDay(zone, localTime(zone, now).day);
    } else {
      for (let hour = 1; hour < 24; hour++) {
        sinceMs = startOfLocalHour(zone, sinceMs - ROLLUP_BUCKET_MS);
      }
    }
    const untilMs = nextLocalHourStart(zone, currentHour);
    const bucketKeys: string[] = [];
    for (let start = sinceMs; start < untilMs; start = nextLocalHourStart(zone, start)) {
      bucketKeys.push(new Date(start).toISOString());
    }
    return { sinceMs, untilMs, resolution: "hour", bucketKeys };
  }

  const today = localTime(zone, now).day;
  const firstDay = shiftDay(today, -(RANGE_DAYS[range] - 1));
  return {
    sinceMs: startOfLocalDay(zone, firstDay),
    untilMs: startOfLocalDay(zone, shiftDay(today, 1)),
    resolution: "day",
    bucketKeys: [...enumerateDays(firstDay, today)],
  };
};

// ---------------------------------------------------------------------------
// The report.

export interface BuildPoolUsageInput {
  readonly range: PoolUsageRange;
  readonly timeZone: string;
  readonly now: number;
  readonly data: PoolUsageReadModel;
  /** The accounts signed in now; each one is listed even without usage. */
  readonly accounts: ReadonlyArray<{
    readonly id: string;
    readonly provider: PoolProvider;
    readonly email?: string | undefined;
  }>;
  readonly rates: RateTable;
  /** The user's price overrides (`createOverrideRateTable`), applied as on the Usage page. */
  readonly overrides: RateTable;
  readonly pricing: UsagePricing;
  readonly recording: boolean;
  readonly recordingNote?: string | undefined;
}

/** Uncached + cached + cache creation + output; reasoning is already inside output. */
const tokenTotal = (tokens: UsageTokenTotals) =>
  tokens.uncachedInputTokens +
  tokens.cachedInputTokens +
  tokens.cacheCreationTokens +
  tokens.outputTokens;

interface Sums {
  requests: number;
  failed: number;
  rateLimited: number;
  tokens: {
    uncachedInputTokens: number;
    cachedInputTokens: number;
    cacheCreationTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
  costUsd: number;
  cacheSavingsUsd: number;
  unpricedRequests: number;
  latencyMsSum: number;
  latencyCount: number;
  ttftMsSum: number;
  ttftCount: number;
}

const emptySums = (): Sums => ({
  requests: 0,
  failed: 0,
  rateLimited: 0,
  tokens: {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  costUsd: 0,
  cacheSavingsUsd: 0,
  unpricedRequests: 0,
  latencyMsSum: 0,
  latencyCount: 0,
  ttftMsSum: 0,
  ttftCount: 0,
});

interface PricedRow {
  readonly row: UsageRollupRow;
  readonly costUsd: number;
  readonly cacheSavingsUsd: number;
  readonly unpricedRequests: number;
}

const addRow = (sums: Sums, { row, costUsd, cacheSavingsUsd, unpricedRequests }: PricedRow) => {
  sums.requests += row.requests;
  sums.failed += row.failed;
  sums.rateLimited += row.rateLimited;
  sums.tokens.uncachedInputTokens += row.tokens.uncachedInputTokens;
  sums.tokens.cachedInputTokens += row.tokens.cachedInputTokens;
  sums.tokens.cacheCreationTokens += row.tokens.cacheCreationTokens;
  sums.tokens.outputTokens += row.tokens.outputTokens;
  sums.tokens.reasoningTokens += row.tokens.reasoningTokens;
  sums.costUsd += costUsd;
  sums.cacheSavingsUsd += cacheSavingsUsd;
  sums.unpricedRequests += unpricedRequests;
  sums.latencyMsSum += row.latencyMsSum;
  sums.latencyCount += row.latencyCount;
  sums.ttftMsSum += row.ttftMsSum;
  sums.ttftCount += row.ttftCount;
};

const toTotals = (sums: Sums): PoolUsageTotals => ({
  requests: sums.requests,
  failed: sums.failed,
  rateLimited: sums.rateLimited,
  tokens: { ...sums.tokens },
  costUsd: sums.costUsd,
  cacheSavingsUsd: sums.cacheSavingsUsd,
  unpricedRequests: sums.unpricedRequests,
  ...(sums.latencyCount > 0
    ? { avgLatencyMs: Math.round(sums.latencyMsSum / sums.latencyCount) }
    : {}),
  ...(sums.ttftCount > 0 ? { avgTtftMs: Math.round(sums.ttftMsSum / sums.ttftCount) } : {}),
});

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Highest cost first, then most requests, then by name. */
const byUsage = (
  a: { readonly sums: Sums; readonly name: string },
  b: { readonly sums: Sums; readonly name: string },
) =>
  b.sums.costUsd - a.sums.costUsd ||
  b.sums.requests - a.sums.requests ||
  compareText(a.name, b.name);

interface ModelEntry {
  readonly model: string;
  readonly provider: PoolProvider;
  readonly name: string;
  readonly sums: Sums;
}

const addToModels = (models: Map<string, ModelEntry>, priced: PricedRow) => {
  const { model, provider } = priced.row;
  const key = `${provider}\n${model}`;
  let entry = models.get(key);
  if (entry === undefined) {
    entry = { model, provider, name: model, sums: emptySums() };
    models.set(key, entry);
  }
  addRow(entry.sums, priced);
};

const toModels = (models: Map<string, ModelEntry>): PoolUsageModel[] =>
  [...models.values()]
    .toSorted(byUsage)
    .map(({ model, provider, sums }) => ({ model, provider, totals: toTotals(sums) }));

interface AccountEntry {
  readonly id: string;
  provider: PoolProvider;
  email: string | undefined;
  readonly current: boolean;
  /** The email came from the status list, so rows never replace it. */
  statusEmail: boolean;
  readonly sums: Sums;
  readonly models: Map<string, ModelEntry>;
  /** Start of the newest row seen; its email and provider describe a removed account. */
  latestStart: number;
  name: string;
}

/** The report for one range: see `PoolUsage`. */
export const buildPoolUsage = (input: BuildPoolUsageInput): PoolUsage => {
  const timeZone = resolveTimeZone(input.timeZone);
  const window = usageWindow(input.range, timeZone, input.now);
  const { sinceMs, untilMs } = window;
  const inWindow = (ms: number) => ms >= sinceMs && ms < untilMs;

  // A row keyed `email:<address>` was recorded before the proxy listed the
  // account's auth file (or after it was re-added under a new one). It belongs
  // to the unique signed-in account with that address and provider: one
  // address can sign in to both providers or to multiple ChatGPT workspaces.
  const emailOwners = new Map<string, string | null>();
  const emailKey = (provider: PoolProvider, email: string) =>
    `${provider}\n${email.trim().toLowerCase()}`;
  for (const account of input.accounts) {
    if (account.email === undefined || account.email === "") continue;
    const key = emailKey(account.provider, account.email);
    emailOwners.set(key, emailOwners.has(key) ? null : account.id);
  }
  const resolveAccount = (account: string, provider: PoolProvider) => {
    if (!account.startsWith(EMAIL_KEY_PREFIX)) return account;
    const email = account.slice(EMAIL_KEY_PREFIX.length).trim().toLowerCase();
    return emailOwners.get(emailKey(provider, email)) ?? `${EMAIL_KEY_PREFIX}${provider}:${email}`;
  };

  const accounts = new Map<string, AccountEntry>();
  const accountEntry = (id: string, provider: PoolProvider, current: boolean) => {
    let entry = accounts.get(id);
    if (entry === undefined) {
      entry = {
        id,
        provider,
        email: undefined,
        current,
        statusEmail: false,
        sums: emptySums(),
        models: new Map(),
        latestStart: Number.NEGATIVE_INFINITY,
        name: id,
      };
      accounts.set(id, entry);
    }
    return entry;
  };
  for (const account of input.accounts) {
    const entry = accountEntry(account.id, account.provider, true);
    if (account.email !== undefined && account.email !== "") {
      entry.email = account.email;
      entry.statusEmail = true;
    }
  }

  const price = (model: string, tokens: UsageTokenTotals) => {
    const record = { model, totals: tokens, fast: false, reportedCostUsd: null };
    const priced = priceUsage(input.rates, record, input.overrides);
    return {
      costUsd: priced.costUsd,
      cacheSavingsUsd: cacheSavingsUsd(input.rates, record, input.overrides),
      unpriced: priced.costSource === "unpriced" && tokenTotal(tokens) > 0,
    };
  };

  // Bucket lookup: day keys by the row's local date (cached per start, since
  // 90 days hold ~8.6k distinct starts), hour keys by the latest start <= row.
  const bucketIndex = new Map(window.bucketKeys.map((key, index) => [key, index]));
  const hourStarts = window.resolution === "hour" ? window.bucketKeys.map(Date.parse) : [];
  const indexByStart = new Map<number, number>();
  const bucketOf = (start: number): number => {
    const cached = indexByStart.get(start);
    if (cached !== undefined) return cached;
    let index: number;
    if (window.resolution === "day") {
      index = bucketIndex.get(localTime(timeZone, start).day) ?? -1;
    } else {
      let low = 0;
      let high = hourStarts.length - 1;
      index = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if ((hourStarts[middle] ?? Number.POSITIVE_INFINITY) <= start) {
          index = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
    }
    indexByStart.set(start, index);
    return index;
  };

  const totals = emptySums();
  const unattributed = emptySums();
  const models = new Map<string, ModelEntry>();
  const bucketAccounts = window.bucketKeys.map(
    () => new Map<string, { costUsd: number; tokens: number; requests: number }>(),
  );

  for (const row of input.data.rows(sinceMs, untilMs)) {
    if (!inWindow(row.start)) continue;
    const { costUsd, cacheSavingsUsd: savings, unpriced } = price(row.model, row.tokens);
    const priced: PricedRow = {
      row,
      costUsd,
      cacheSavingsUsd: savings,
      unpricedRequests: unpriced ? Math.max(0, row.requests - row.failed) : 0,
    };
    addRow(totals, priced);
    addToModels(models, priced);

    const id = resolveAccount(row.account, row.provider);
    if (id === "") {
      addRow(unattributed, priced);
      continue;
    }
    const account = accountEntry(id, row.provider, false);
    addRow(account.sums, priced);
    addToModels(account.models, priced);
    if (row.start > account.latestStart) {
      account.latestStart = row.start;
      // The status list describes a signed-in account; rows fill in what it lacks.
      if (!account.current) account.provider = row.provider;
      const email =
        row.email ||
        (row.account.startsWith(EMAIL_KEY_PREFIX)
          ? row.account.slice(EMAIL_KEY_PREFIX.length)
          : undefined);
      if (email !== undefined && !account.statusEmail) {
        account.email = email;
      }
    }

    const bucket = bucketAccounts[bucketOf(row.start)];
    if (bucket !== undefined) {
      const share = bucket.get(id) ?? { costUsd: 0, tokens: 0, requests: 0 };
      share.costUsd += costUsd;
      share.tokens += tokenTotal(row.tokens);
      share.requests += row.requests;
      bucket.set(id, share);
    }
  }

  for (const account of accounts.values()) {
    account.name = account.email ?? account.id;
  }

  const toEvent = (sample: AttributedSample): PoolUsageEvent => {
    const accountId = resolveAccount(sample.account, sample.provider);
    return {
      at: new Date(sample.at).toISOString(),
      ...(accountId === "" ? {} : { accountId }),
      provider: sample.provider,
      model: sample.model,
      failed: sample.failed,
      ...(sample.failed && sample.statusCode !== undefined
        ? { statusCode: sample.statusCode }
        : {}),
      ...(sample.failed && sample.message !== undefined && sample.message !== ""
        ? { message: sample.message }
        : {}),
      tokens: tokenTotal(sample.tokens),
      costUsd: price(sample.model, sample.tokens).costUsd,
      ...(sample.latencyMs !== undefined
        ? { latencyMs: Math.max(0, Math.round(sample.latencyMs)) }
        : {}),
    };
  };
  // Filter to the window first, then cap: older entries must not crowd out
  // the window's own.
  const recentSamples = input.data.recentEvents().filter((sample) => inWindow(sample.at));
  const errorSamples = input.data.recentErrors().filter((sample) => inWindow(sample.at));

  const lastEventAt = new Map<string, number>();
  for (const sample of [...recentSamples, ...errorSamples]) {
    const id = resolveAccount(sample.account, sample.provider);
    if (sample.at > (lastEventAt.get(id) ?? Number.NEGATIVE_INFINITY)) {
      lastEventAt.set(id, sample.at);
    }
  }

  const accountOrder = [...accounts.values()].toSorted(
    (a, b) => byUsage(a, b) || compareText(a.id, b.id),
  );
  const usageAccounts: PoolUsageAccount[] = accountOrder.map((account) => {
    const lastUsed =
      lastEventAt.get(account.id) ??
      (Number.isFinite(account.latestStart) ? account.latestStart : undefined);
    return {
      id: account.id,
      provider: account.provider,
      ...(account.email === undefined ? {} : { email: account.email }),
      current: account.current,
      totals: toTotals(account.sums),
      models: toModels(account.models),
      ...(lastUsed === undefined ? {} : { lastUsedAt: new Date(lastUsed).toISOString() }),
    };
  });

  // Each column lists accounts in the table's order, so stacks line up across columns.
  const buckets: PoolUsageBucket[] = window.bucketKeys.map((key, index) => {
    const shares = bucketAccounts[index] ?? new Map();
    return {
      key,
      accounts: accountOrder.flatMap((account) => {
        const share = shares.get(account.id);
        return share === undefined ? [] : [{ id: account.id, ...share }];
      }),
    };
  });

  const oldest = input.data.oldestStart();
  return {
    range: input.range,
    timeZone,
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    resolution: window.resolution,
    totals: toTotals(totals),
    accounts: usageAccounts,
    ...(unattributed.requests > 0 ? { unattributed: toTotals(unattributed) } : {}),
    models: toModels(models),
    buckets,
    recentEvents: recentSamples.slice(0, RECENT_EVENTS_LIMIT).map(toEvent),
    recentErrors: errorSamples.slice(0, RECENT_ERRORS_LIMIT).map(toEvent),
    pricing: input.pricing,
    recording: input.recording,
    ...(input.recordingNote === undefined ? {} : { recordingNote: input.recordingNote }),
    ...(oldest === undefined ? {} : { recordedSince: new Date(oldest).toISOString() }),
  };
};
