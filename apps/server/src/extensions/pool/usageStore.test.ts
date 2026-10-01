// @effect-diagnostics nodeBuiltinImport:off - reads and damages the store's files in temp directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { PoolUsageStore, type PoolUsageStoreOptions } from "./usageStore.ts";
import { ROLLUP_BUCKET_MS, type AttributedSample, type UsageRollupRow } from "./usageTypes.ts";

const DAY_MS = 86_400_000;
const T0 = Date.parse("2026-10-01T12:00:00Z");

const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pool-usage-"));

let nextId = 0;
const sample = (overrides: Partial<AttributedSample> = {}): AttributedSample => ({
  at: T0,
  executionId: `exec-${++nextId}`,
  account: "claude-ada@example.com.json",
  email: "ada@example.com",
  provider: "claude",
  model: "claude-opus-5-5",
  failed: false,
  tokens: {
    uncachedInputTokens: 10,
    cachedInputTokens: 1000,
    cacheCreationTokens: 100,
    outputTokens: 50,
    reasoningTokens: 20,
  },
  latencyMs: 2000,
  ttftMs: 500,
  ...overrides,
});

/** A store on `dir` whose clock the test moves. */
const open = (dir: string, options: Partial<PoolUsageStoreOptions> = {}) => {
  const clock = { now: T0 };
  const store = new PoolUsageStore({ dir, now: () => clock.now, ...options });
  return { store, clock };
};

const reopen = async (dir: string, now = T0, options: Partial<PoolUsageStoreOptions> = {}) => {
  const { store } = open(dir, { now: () => now, ...options });
  await store.load();
  return store;
};

const all = (store: PoolUsageStore) => store.rows(0, Number.POSITIVE_INFINITY);
const requestsIn = (rows: ReadonlyArray<UsageRollupRow>) =>
  rows.reduce((sum, row) => sum + row.requests, 0);

describe("pool usage store", () => {
  it("survives a restart with the same rows and recent requests", async () => {
    const dir = tempDir();
    const { store } = open(dir);
    await store.load();
    store.ingest([
      sample(),
      sample({ at: T0 + 60_000, model: "claude-sonnet-5" }),
      sample({
        at: T0 + 120_000,
        failed: true,
        statusCode: 429,
        message: "Rate limited",
        tokens: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
      }),
      // The proxy answered without an account: no address, no latency.
      (({ email: _email, latencyMs: _latencyMs, ...unattributed }) => unattributed)(
        sample({ at: T0 - DAY_MS, account: "" }),
      ),
    ]);
    await store.flush();

    const restored = await reopen(dir);
    assert.deepStrictEqual(all(restored), all(store));
    assert.deepStrictEqual(restored.recentEvents(), store.recentEvents());
    assert.deepStrictEqual(restored.recentErrors(), store.recentErrors());
    assert.strictEqual(restored.oldestStart(), T0 - DAY_MS);
    assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(dir, "days")).toSorted(), [
      "2026-09-30.json",
      "2026-10-01.json",
    ]);
    assert.strictEqual(NodeFS.statSync(NodePath.join(dir, "recent.json")).mode & 0o777, 0o600);
    assert.strictEqual(NodeFS.statSync(NodePath.join(dir, "days")).mode & 0o777, 0o700);
  });

  it("sums one account and model per 15-minute bucket", () => {
    const { store } = open(tempDir());
    store.ingest([
      sample({ at: T0 }),
      // Ended before its first token: no time to first token.
      (({ ttftMs: _ttftMs, ...noTtft }) => noTtft)(
        sample({ at: T0 + ROLLUP_BUCKET_MS - 1, latencyMs: 4000 }),
      ),
      sample({ at: T0 + ROLLUP_BUCKET_MS }),
      sample({ at: T0, model: "claude-sonnet-5" }),
      sample({ at: T0, failed: true, statusCode: 429 }),
      sample({ at: T0, failed: true, statusCode: 500 }),
    ]);
    const rows = all(store);
    assert.strictEqual(rows.length, 3);
    const first = rows.find((row) => row.start === T0 && row.model === "claude-opus-5-5");
    assert.deepInclude(first, {
      account: "claude-ada@example.com.json",
      email: "ada@example.com",
      requests: 4,
      failed: 2,
      rateLimited: 1,
      latencyMsSum: 10_000,
      latencyCount: 4,
      ttftMsSum: 1500,
      ttftCount: 3,
    });
    assert.deepStrictEqual(first?.tokens, {
      uncachedInputTokens: 40,
      cachedInputTokens: 4000,
      cacheCreationTokens: 400,
      outputTokens: 200,
      reasoningTokens: 80,
    });
  });

  it("counts an execution once, across batches and restarts", async () => {
    const dir = tempDir();
    const { store } = open(dir);
    const repeated = sample({ executionId: "exec-repeat" });
    store.ingest([repeated, repeated]);
    store.ingest([repeated]);
    assert.strictEqual(requestsIn(all(store)), 1);
    assert.strictEqual(store.recentEvents().length, 1);
    await store.flush();

    const restored = await reopen(dir);
    restored.ingest([repeated, sample()]);
    assert.strictEqual(requestsIn(all(restored)), 2);
  });

  it("keeps the newest requests and failures, each list bounded", () => {
    const { store } = open(tempDir(), { maxRecentEvents: 3, maxRecentErrors: 2 });
    store.ingest([
      sample({ at: T0 + 1, failed: true, statusCode: 429 }),
      sample({ at: T0 + 2 }),
      sample({ at: T0 + 3, failed: true, statusCode: 500 }),
    ]);
    // Out of order: a long request finishes after a later one.
    store.ingest([sample({ at: T0 + 5 }), sample({ at: T0 + 4, failed: true, statusCode: 529 })]);
    assert.deepStrictEqual(
      store.recentEvents().map((event) => event.at),
      [T0 + 5, T0 + 4, T0 + 3],
    );
    assert.deepStrictEqual(
      store.recentErrors().map((event) => event.statusCode),
      [529, 500],
    );
    // The rollups still count everything.
    assert.strictEqual(requestsIn(all(store)), 5);
  });

  it("drops days past retention on load and on a later flush", async () => {
    const dir = tempDir();
    const { store, clock } = open(dir, { retentionDays: 2 });
    store.ingest([sample({ at: T0 - 3 * DAY_MS }), sample({ at: T0 - DAY_MS }), sample()]);
    // Already past retention when it arrives.
    assert.strictEqual(requestsIn(all(store)), 2);
    await store.flush();

    clock.now = T0 + 2 * DAY_MS;
    store.ingest([sample({ at: clock.now })]);
    await store.flush();
    assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(dir, "days")).toSorted(), [
      "2026-10-01.json",
      "2026-10-03.json",
    ]);
    assert.strictEqual(store.oldestStart(), T0);

    const later = await reopen(dir, T0 + 5 * DAY_MS, { retentionDays: 2 });
    assert.deepStrictEqual(all(later), []);
    assert.isUndefined(later.oldestStart());
    assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(dir, "days")), []);
  });

  it("returns only the buckets inside the window, across a UTC day boundary", () => {
    const { store } = open(tempDir());
    const midnight = Date.parse("2026-10-02T00:00:00Z");
    store.ingest(
      [-2, -1, 0, 1, 2].map((offset) => sample({ at: midnight + offset * ROLLUP_BUCKET_MS })),
    );
    const window = store.rows(midnight - ROLLUP_BUCKET_MS, midnight + ROLLUP_BUCKET_MS);
    assert.deepStrictEqual(
      window.map((row) => row.start),
      [midnight - ROLLUP_BUCKET_MS, midnight],
    );
    assert.deepStrictEqual(store.rows(midnight, midnight), []);
  });

  it("skips a damaged day file and bad rows without losing the rest", async () => {
    const dir = tempDir();
    const { store } = open(dir);
    store.ingest([sample({ at: T0 - DAY_MS }), sample()]);
    await store.flush();
    const days = NodePath.join(dir, "days");
    NodeFS.writeFileSync(NodePath.join(days, "2026-09-30.json"), "{ not json");
    const today = JSON.parse(NodeFS.readFileSync(NodePath.join(days, "2026-10-01.json"), "utf8"));
    today.rows.push({ start: "yesterday" }, { ...today.rows[0], start: T0 - DAY_MS });
    NodeFS.writeFileSync(NodePath.join(days, "2026-10-01.json"), JSON.stringify(today));
    NodeFS.writeFileSync(NodePath.join(dir, "recent.json"), "[]");

    const restored = await reopen(dir);
    assert.deepStrictEqual(
      all(restored).map((row) => [row.start, row.requests]),
      [[T0, 1]],
    );
    assert.deepStrictEqual(restored.recentEvents(), []);
  });

  it("never writes over history it hasn't read yet", async () => {
    const dir = tempDir();
    const { store } = open(dir);
    store.ingest([sample()]);
    await store.flush();

    const { store: next } = open(dir);
    const loading = next.load();
    next.ingest([sample({ at: T0 + 60_000 })]);
    await Promise.all([next.flush(), loading]);
    assert.strictEqual(requestsIn(all(await reopen(dir))), 2);
  });

  it("writes what arrives during a running flush with the next one", async () => {
    const dir = tempDir();
    const { store } = open(dir);
    await store.load();
    store.ingest([sample()]);
    const first = store.flush();
    // One turn of the event loop: the first flush has taken its snapshot and is writing.
    await new Promise((resolve) => setImmediate(resolve));
    store.ingest([sample({ at: T0 + DAY_MS })]);
    const second = store.flush();
    store.ingest([sample({ at: T0 + 2 * DAY_MS })]);
    await Promise.all([first, second, store.flush()]);
    const restored = await reopen(dir, T0 + 2 * DAY_MS);
    assert.strictEqual(requestsIn(all(restored)), 3);
    assert.strictEqual(restored.recentEvents().length, 3);
  });
});
