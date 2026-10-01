/**
 * Shapes shared by the pool's usage recording (`usageStore.ts`), its report
 * (`usageReport.ts`) and the controller that feeds both from the proxy.
 *
 * The proxy (CLIProxyAPI 7.3.17) publishes one record per upstream attempt to
 * an in-memory queue that `GET /v0/management/usage-queue?count=N` pops, and
 * forgets records after `redis-usage-queue-retention-seconds`. The pool drains
 * it, keeps 15-minute rollups per account and model (small enough for 90 days
 * of heavy subagent traffic, and aligned with every UTC offset, so day buckets
 * in any time zone stay exact) plus a bounded list of recent requests.
 */
import type { PoolProvider, UsageTokenTotals } from "@t3tools/contracts";

/** Rollup granularity. Every UTC offset in use is a multiple of 15 minutes. */
export const ROLLUP_BUCKET_MS = 15 * 60_000;

/** How long rollups are kept. */
export const USAGE_RETENTION_DAYS = 90;

/**
 * One usage-queue record, reduced to what the pool keeps: no client key, token
 * hash, IPs, headers or user agent ever leave the parser.
 */
export interface UsageSample {
  /** Epoch ms of the request. */
  readonly at: number;
  /** The proxy's id for this attempt, for de-duplication. */
  readonly executionId?: string;
  /** The proxy's handle for the account (`auth_index`, also in `auth-files`). */
  readonly authIndex?: string;
  /** The account's address (the record's `source`). */
  readonly email?: string;
  readonly provider: PoolProvider;
  /** The model that answered when the proxy knows it, else the one requested. */
  readonly model: string;
  readonly failed: boolean;
  /** Upstream HTTP status; only for failed attempts. */
  readonly statusCode?: number;
  /** The upstream error body, trimmed to a short single line; only for failed attempts. */
  readonly message?: string;
  readonly tokens: UsageTokenTotals;
  readonly latencyMs?: number;
  readonly ttftMs?: number;
}

/**
 * A sample with the pool account it belongs to, resolved by the controller
 * when it drains the queue (the auth file list is current then).
 *
 * `account` is the auth file name (`PoolAccount.id`) when resolved, else
 * `email:<address>` when only the address is known, else `""` (the proxy
 * answered without trying an account, e.g. every account cooling down).
 */
export interface AttributedSample extends UsageSample {
  readonly account: string;
}

/** Sums for one (15-minute bucket, account, provider, model). */
export interface UsageRollupRow {
  /** Bucket start, epoch ms, a multiple of `ROLLUP_BUCKET_MS`. */
  readonly start: number;
  readonly account: string;
  /** The account's address at the time, so history stays readable after it is removed. */
  readonly email?: string;
  readonly provider: PoolProvider;
  readonly model: string;
  readonly requests: number;
  readonly failed: number;
  readonly rateLimited: number;
  readonly tokens: UsageTokenTotals;
  readonly latencyMsSum: number;
  readonly latencyCount: number;
  readonly ttftMsSum: number;
  readonly ttftCount: number;
}

/** What the report reads; `PoolUsageStore` implements it. */
export interface PoolUsageReadModel {
  /** Rows whose bucket starts in `[sinceMs, untilMs)`. */
  readonly rows: (sinceMs: number, untilMs: number) => ReadonlyArray<UsageRollupRow>;
  /** Newest first. */
  readonly recentEvents: () => ReadonlyArray<AttributedSample>;
  /** Newest first, failures only. */
  readonly recentErrors: () => ReadonlyArray<AttributedSample>;
  /** The oldest bucket still kept, epoch ms. */
  readonly oldestStart: () => number | undefined;
}
