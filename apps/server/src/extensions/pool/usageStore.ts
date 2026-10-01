// @effect-diagnostics globalDate:off - the pool's process manager is plain async Node by design; Effect wraps it at the layer and handler boundary.
// @effect-diagnostics nodeBuiltinImport:off - the pool keeps its usage history in plain files with Node.
/**
 * The pool's usage history, kept next to its other state (mode 0600 files in
 * 0700 directories):
 *
 * - `days/YYYY-MM-DD.json`: `{ version: 1, rows }`, the 15-minute rollups whose
 *   bucket starts on that UTC day. A flush rewrites only the days that changed,
 *   so a long history never costs more than today's file per write.
 * - `recent.json`: `{ version: 1, events, errors }`, the latest requests and
 *   the latest failures, newest first.
 *
 * Everything is held in memory (90 days of rollups is a few MB at most);
 * `ingest` is synchronous and `flush` persists. Damaged files or rows are
 * skipped, never fatal: losing history must not stop the pool.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { UsageTokenTotals } from "@t3tools/contracts";

import { poolProviderOf } from "./management.ts";
import {
  ROLLUP_BUCKET_MS,
  USAGE_RETENTION_DAYS,
  type AttributedSample,
  type PoolUsageReadModel,
  type UsageRollupRow,
} from "./usageTypes.ts";

const DAY_MS = 86_400_000;
const PRUNE_INTERVAL_MS = 3_600_000;
/** Execution ids remembered for de-duplication; far more than one drain ever repeats. */
const DEDUPE_WINDOW = 5_000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Row = Mutable<Omit<UsageRollupRow, "tokens">> & { tokens: Mutable<UsageTokenTotals> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const optionalCount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

const optionalText = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const dayStartOf = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
const dayName = (dayStart: number) => new Date(dayStart).toISOString().slice(0, 10);
// NUL never appears in an account, provider or model, so keys can't collide.
const rowKey = (row: Pick<UsageRollupRow, "start" | "account" | "provider" | "model">) =>
  `${row.start}\u0000${row.account}\u0000${row.provider}\u0000${row.model}`;

const decodeTokens = (raw: unknown): Mutable<UsageTokenTotals> => {
  const value = isRecord(raw) ? raw : {};
  return {
    uncachedInputTokens: count(value.uncachedInputTokens),
    cachedInputTokens: count(value.cachedInputTokens),
    cacheCreationTokens: count(value.cacheCreationTokens),
    outputTokens: count(value.outputTokens),
    reasoningTokens: count(value.reasoningTokens),
  };
};

const addTokens = (target: Mutable<UsageTokenTotals>, tokens: UsageTokenTotals) => {
  target.uncachedInputTokens += tokens.uncachedInputTokens;
  target.cachedInputTokens += tokens.cachedInputTokens;
  target.cacheCreationTokens += tokens.cacheCreationTokens;
  target.outputTokens += tokens.outputTokens;
  target.reasoningTokens += tokens.reasoningTokens;
};

const decodeRow = (raw: unknown): Row | undefined => {
  if (!isRecord(raw) || typeof raw.start !== "number" || !Number.isFinite(raw.start)) {
    return undefined;
  }
  const provider = typeof raw.provider === "string" ? poolProviderOf(raw.provider) : undefined;
  const model = optionalText(raw.model);
  const email = optionalText(raw.email);
  if (!provider || !model || typeof raw.account !== "string") return undefined;
  return {
    start: Math.floor(raw.start / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS,
    account: raw.account,
    ...(email ? { email } : {}),
    provider,
    model,
    requests: count(raw.requests),
    failed: count(raw.failed),
    rateLimited: count(raw.rateLimited),
    tokens: decodeTokens(raw.tokens),
    latencyMsSum: count(raw.latencyMsSum),
    latencyCount: count(raw.latencyCount),
    ttftMsSum: count(raw.ttftMsSum),
    ttftCount: count(raw.ttftCount),
  };
};

/** Adds `source`'s sums into `target`; `target` keeps its address if it has one. */
const addRow = (target: Row, source: Row) => {
  target.requests += source.requests;
  target.failed += source.failed;
  target.rateLimited += source.rateLimited;
  addTokens(target.tokens, source.tokens);
  target.latencyMsSum += source.latencyMsSum;
  target.latencyCount += source.latencyCount;
  target.ttftMsSum += source.ttftMsSum;
  target.ttftCount += source.ttftCount;
  if (!target.email && source.email) target.email = source.email;
};

const decodeSample = (raw: unknown): AttributedSample | undefined => {
  if (!isRecord(raw) || typeof raw.at !== "number" || !Number.isFinite(raw.at)) return undefined;
  const provider = typeof raw.provider === "string" ? poolProviderOf(raw.provider) : undefined;
  const model = optionalText(raw.model);
  if (!provider || !model || typeof raw.account !== "string" || typeof raw.failed !== "boolean") {
    return undefined;
  }
  const executionId = optionalText(raw.executionId);
  const authIndex = optionalText(raw.authIndex);
  const email = optionalText(raw.email);
  const message = optionalText(raw.message);
  const statusCode = optionalCount(raw.statusCode);
  const latencyMs = optionalCount(raw.latencyMs);
  const ttftMs = optionalCount(raw.ttftMs);
  return {
    at: raw.at,
    ...(executionId ? { executionId } : {}),
    ...(authIndex ? { authIndex } : {}),
    ...(email ? { email } : {}),
    provider,
    model,
    failed: raw.failed,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(message ? { message } : {}),
    tokens: decodeTokens(raw.tokens),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(ttftMs !== undefined ? { ttftMs } : {}),
    account: raw.account,
  };
};

/** `added` merged into `existing`, newest first, at most `max`; at equal times the later arrival leads. */
const newestFirst = (
  added: ReadonlyArray<AttributedSample>,
  existing: ReadonlyArray<AttributedSample>,
  max: number,
) => [...added.toReversed(), ...existing].sort((a, b) => b.at - a.at).slice(0, max);

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await NodeFSP.readFile(path, "utf8"));
  } catch {
    return undefined;
  }
};

const isMissing = (error: unknown) => isRecord(error) && error.code === "ENOENT";

const writeAtomic = async (path: string, content: string) => {
  // Unique per write: concurrent writers must never share (and delete) one temp file.
  const temp = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temp, content, { mode: 0o600 });
    await NodeFSP.rename(temp, path);
  } catch (error) {
    await NodeFSP.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
};

export interface PoolUsageStoreOptions {
  /** Where the history lives, e.g. `<stateDir>/pool/usage`. */
  readonly dir: string;
  /** Whole UTC days past this many are dropped. Default `USAGE_RETENTION_DAYS`. */
  readonly retentionDays?: number;
  readonly maxRecentEvents?: number;
  readonly maxRecentErrors?: number;
  readonly now?: () => number;
}

/**
 * The pool's usage rollups and recent requests. Call `load` once at start
 * (`flush` waits for it, so a write never replaces history it hasn't read),
 * `ingest` each drained batch, then `flush`.
 */
export class PoolUsageStore implements PoolUsageReadModel {
  private readonly daysDir: string;
  private readonly recentPath: string;
  private readonly retentionMs: number;
  private readonly maxRecentEvents: number;
  private readonly maxRecentErrors: number;
  private readonly now: () => number;
  /** Rows by UTC day start, then by `rowKey`. */
  private readonly days = new Map<number, Map<string, Row>>();
  private readonly dirtyDays = new Set<number>();
  private recentDirty = false;
  private events: AttributedSample[] = [];
  private errors: AttributedSample[] = [];
  /** Execution ids already counted, oldest first (a Set iterates in insertion order). */
  private readonly seen = new Set<string>();
  private lastPruneAt = Number.NEGATIVE_INFINITY;
  private loading: Promise<void> | undefined;
  /** Settles after the last queued flush; each flush starts after the one before. */
  private flushTail: Promise<void> = Promise.resolve();
  /** A flush queued behind a running one; later calls join it instead of queueing more. */
  private queuedFlush: Promise<void> | undefined;

  constructor(options: PoolUsageStoreOptions) {
    this.daysDir = NodePath.join(options.dir, "days");
    this.recentPath = NodePath.join(options.dir, "recent.json");
    this.retentionMs = (options.retentionDays ?? USAGE_RETENTION_DAYS) * DAY_MS;
    this.maxRecentEvents = options.maxRecentEvents ?? 300;
    this.maxRecentErrors = options.maxRecentErrors ?? 200;
    this.now = options.now ?? Date.now;
  }

  /** Reads the history from disk and drops expired day files. Safe to call more than once. */
  load(): Promise<void> {
    this.loading ??= this.readFromDisk().catch((error: unknown) => {
      // Nothing was merged yet (reads finish before the merge), so a retry is safe.
      this.loading = undefined;
      throw error;
    });
    return this.loading;
  }

  /** Counts a drained batch. Repeated execution ids and samples older than retention are ignored. */
  ingest(samples: ReadonlyArray<AttributedSample>): void {
    const cutoff = this.now() - this.retentionMs;
    const fresh: AttributedSample[] = [];
    for (const sample of samples) {
      if (!Number.isFinite(sample.at) || sample.at < cutoff) continue;
      if (sample.executionId !== undefined) {
        if (this.seen.has(sample.executionId)) continue;
        this.remember(sample.executionId);
      }
      this.addSample(sample);
      fresh.push(sample);
    }
    if (fresh.length === 0) return;
    this.events = newestFirst(fresh, this.events, this.maxRecentEvents);
    const failures = fresh.filter((sample) => sample.failed);
    if (failures.length > 0) {
      this.errors = newestFirst(failures, this.errors, this.maxRecentErrors);
    }
    this.recentDirty = true;
  }

  /**
   * Writes the days changed since the last flush and the recent lists. Flushes
   * run one at a time; one requested during a write runs after it with the
   * latest state. A failed write keeps its days pending for the next flush.
   */
  flush(): Promise<void> {
    if (this.queuedFlush) return this.queuedFlush;
    const run = this.flushTail.then(async () => {
      this.queuedFlush = undefined;
      await this.load();
      await this.write();
    });
    this.queuedFlush = run;
    this.flushTail = run.catch(() => undefined);
    return run;
  }

  /** Rows whose bucket starts in `[sinceMs, untilMs)`. Live objects: read them right away. */
  rows(sinceMs: number, untilMs: number): ReadonlyArray<UsageRollupRow> {
    const result: UsageRollupRow[] = [];
    for (const day of [...this.days.keys()].toSorted((a, b) => a - b)) {
      if (day >= untilMs || day + DAY_MS <= sinceMs) continue;
      for (const row of this.days.get(day)?.values() ?? []) {
        if (row.start >= sinceMs && row.start < untilMs) result.push(row);
      }
    }
    return result;
  }

  recentEvents(): ReadonlyArray<AttributedSample> {
    return this.events;
  }

  recentErrors(): ReadonlyArray<AttributedSample> {
    return this.errors;
  }

  oldestStart(): number | undefined {
    let oldestDay: Map<string, Row> | undefined;
    let oldestDayStart = Number.POSITIVE_INFINITY;
    for (const [day, rows] of this.days) {
      if (rows.size > 0 && day < oldestDayStart) {
        oldestDay = rows;
        oldestDayStart = day;
      }
    }
    if (!oldestDay) return undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const row of oldestDay.values()) oldest = Math.min(oldest, row.start);
    return oldest;
  }

  private isExpired(dayStart: number, now: number) {
    return dayStart + DAY_MS <= now - this.retentionMs;
  }

  private remember(executionId: string) {
    this.seen.add(executionId);
    if (this.seen.size > DEDUPE_WINDOW) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  private addSample(sample: AttributedSample) {
    const start = Math.floor(sample.at / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS;
    const day = dayStartOf(start);
    let rows = this.days.get(day);
    if (!rows) {
      rows = new Map();
      this.days.set(day, rows);
    }
    const key = rowKey({ ...sample, start });
    let row = rows.get(key);
    if (!row) {
      row = {
        start,
        account: sample.account,
        provider: sample.provider,
        model: sample.model,
        requests: 0,
        failed: 0,
        rateLimited: 0,
        tokens: decodeTokens(undefined),
        latencyMsSum: 0,
        latencyCount: 0,
        ttftMsSum: 0,
        ttftCount: 0,
      };
      rows.set(key, row);
    }
    row.requests += 1;
    if (sample.failed) row.failed += 1;
    if (sample.statusCode === 429) row.rateLimited += 1;
    addTokens(row.tokens, sample.tokens);
    if (sample.latencyMs !== undefined) {
      row.latencyMsSum += sample.latencyMs;
      row.latencyCount += 1;
    }
    if (sample.ttftMs !== undefined) {
      row.ttftMsSum += sample.ttftMs;
      row.ttftCount += 1;
    }
    if (sample.email) row.email = sample.email;
    this.dirtyDays.add(day);
  }

  private async readFromDisk(): Promise<void> {
    const now = this.now();
    let names: string[] = [];
    try {
      names = await NodeFSP.readdir(this.daysDir);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const loaded = new Map<number, Map<string, Row>>();
    const expired: string[] = [];
    for (const name of names) {
      const match = DAY_FILE.exec(name);
      const day = match?.[1] ? Date.parse(`${match[1]}T00:00:00Z`) : Number.NaN;
      // The round trip rejects names like 2026-02-31.
      if (!Number.isFinite(day) || dayName(day) !== match?.[1]) continue;
      if (this.isExpired(day, now)) {
        expired.push(name);
        continue;
      }
      const json = await readJson(NodePath.join(this.daysDir, name));
      const list =
        isRecord(json) && json.version === 1 && Array.isArray(json.rows) ? json.rows : [];
      const rows = new Map<string, Row>();
      for (const raw of list) {
        const row = decodeRow(raw);
        // A row filed under the wrong day is damaged: keeping it could count it twice.
        if (!row || dayStartOf(row.start) !== day) continue;
        const existing = rows.get(rowKey(row));
        if (existing) addRow(existing, row);
        else rows.set(rowKey(row), row);
      }
      if (rows.size > 0) loaded.set(day, rows);
    }
    const recent = await readJson(this.recentPath);
    const decodeList = (field: string) => {
      const list = isRecord(recent) && recent.version === 1 ? recent[field] : undefined;
      return (Array.isArray(list) ? list : [])
        .flatMap((raw) => decodeSample(raw) ?? [])
        .filter((sample) => sample.at >= now - this.retentionMs);
    };
    const events = decodeList("events");
    const errors = decodeList("errors");

    // Merge in one synchronous step, after every read: samples ingested while
    // loading stay (their days are already dirty, so the next flush keeps both).
    for (const [day, rows] of loaded) {
      const live = this.days.get(day);
      if (!live) {
        this.days.set(day, rows);
        continue;
      }
      for (const [key, row] of rows) {
        const current = live.get(key);
        if (current) addRow(current, row);
        else live.set(key, row);
      }
    }
    this.events = newestFirst([], [...this.events, ...events], this.maxRecentEvents);
    this.errors = newestFirst([], [...this.errors, ...errors], this.maxRecentErrors);
    for (const sample of [...events, ...errors]) {
      if (sample.executionId !== undefined) this.remember(sample.executionId);
    }

    this.lastPruneAt = now;
    await Promise.all(
      expired.map((name) =>
        NodeFSP.rm(NodePath.join(this.daysDir, name), { force: true }).catch(() => undefined),
      ),
    );
  }

  private async write(): Promise<void> {
    const now = this.now();
    const prune = now - this.lastPruneAt >= PRUNE_INTERVAL_MS;
    if (prune) {
      this.lastPruneAt = now;
      for (const day of this.days.keys()) {
        if (!this.isExpired(day, now)) continue;
        this.days.delete(day);
        this.dirtyDays.delete(day);
      }
    }
    // Snapshot before the first await: samples ingested during the write mark
    // their days dirty again and go out with the next flush.
    const days = [...this.dirtyDays];
    this.dirtyDays.clear();
    const recentDirty = this.recentDirty;
    this.recentDirty = false;
    const files = days.flatMap((day) => {
      const rows = this.days.get(day);
      return rows
        ? [
            {
              path: NodePath.join(this.daysDir, `${dayName(day)}.json`),
              content: JSON.stringify({ version: 1, rows: [...rows.values()] }),
            },
          ]
        : [];
    });
    const recent = recentDirty
      ? JSON.stringify({ version: 1, events: this.events, errors: this.errors })
      : undefined;
    if (files.length === 0 && recent === undefined && !prune) return;

    try {
      if (files.length > 0 || recent !== undefined) {
        await NodeFSP.mkdir(this.daysDir, { recursive: true, mode: 0o700 });
      }
      for (const file of files) await writeAtomic(file.path, file.content);
      if (recent !== undefined) await writeAtomic(this.recentPath, recent);
      if (prune) await this.pruneFiles(now);
    } catch (error) {
      for (const day of days) this.dirtyDays.add(day);
      if (recentDirty) this.recentDirty = true;
      throw error;
    }
  }

  private async pruneFiles(now: number) {
    let names: string[] = [];
    try {
      names = await NodeFSP.readdir(this.daysDir);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    for (const name of names) {
      const match = DAY_FILE.exec(name);
      const day = match?.[1] ? Date.parse(`${match[1]}T00:00:00Z`) : Number.NaN;
      if (Number.isFinite(day) && this.isExpired(day, now)) {
        await NodeFSP.rm(NodePath.join(this.daysDir, name), { force: true });
      }
    }
  }
}
