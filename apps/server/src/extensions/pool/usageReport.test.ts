// @effect-diagnostics globalDate:off - fixtures are fixed instants written as ISO strings.
import type { UsagePricing, UsageTokenTotals } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { createOverrideRateTable, parseRateTable } from "./t3.ts";
import { buildPoolUsage, usageWindow, type BuildPoolUsageInput } from "./usageReport.ts";
import type { AttributedSample, PoolUsageReadModel, UsageRollupRow } from "./usageTypes.ts";

const ms = (iso: string) => Date.parse(iso);
const iso = (value: number) => new Date(value).toISOString();

const tokens = (partial: Partial<UsageTokenTotals> = {}): UsageTokenTotals => ({
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  ...partial,
});

const row = (
  partial: Partial<UsageRollupRow> & Pick<UsageRollupRow, "start" | "account" | "model">,
): UsageRollupRow => ({
  provider: "claude",
  requests: 1,
  failed: 0,
  rateLimited: 0,
  tokens: tokens(),
  latencyMsSum: 0,
  latencyCount: 0,
  ttftMsSum: 0,
  ttftCount: 0,
  ...partial,
});

const sample = (
  partial: Partial<AttributedSample> & Pick<AttributedSample, "at" | "account">,
): AttributedSample => ({
  provider: "claude",
  model: "claude-test-1",
  failed: false,
  tokens: tokens(),
  ...partial,
});

const readModel = (
  rows: ReadonlyArray<UsageRollupRow>,
  events: ReadonlyArray<AttributedSample> = [],
  errors: ReadonlyArray<AttributedSample> = [],
  oldestStart?: number,
): PoolUsageReadModel => ({
  rows: (sinceMs, untilMs) => rows.filter((r) => r.start >= sinceMs && r.start < untilMs),
  recentEvents: () => events,
  recentErrors: () => errors,
  oldestStart: () => oldestStart,
});

// $3 / $15 per million, cache reads $0.30, cache writes $3.75.
const rates = parseRateTable({
  "claude-test-1": {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000003,
    cache_creation_input_token_cost: 0.00000375,
  },
});
// A custom rate for a model LiteLLM doesn't list: $2 in, $8 out, cache at the input rate.
const overrides = createOverrideRateTable({
  "gpt-test-1": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
});
const pricing: UsagePricing = {
  status: "fresh",
  source: "https://example.com/rates.json",
  fetchedAt: "2026-10-01T00:00:00.000Z",
  knownModels: 1,
};

const build = (overridesInput: Partial<BuildPoolUsageInput>) =>
  buildPoolUsage({
    range: "7d",
    timeZone: "UTC",
    now: ms("2026-10-01T12:00:00Z"),
    data: readModel([]),
    accounts: [],
    rates,
    overrides,
    pricing,
    recording: true,
    ...overridesInput,
  });

describe("usage window", () => {
  it("aligns 24h buckets to local hours in a +5:30 zone", () => {
    // 15:40 in Kolkata.
    const window = usageWindow("24h", "Asia/Kolkata", ms("2026-10-01T10:10:00Z"));
    assert.strictEqual(window.resolution, "hour");
    assert.strictEqual(iso(window.sinceMs), "2026-09-30T10:30:00.000Z");
    assert.strictEqual(iso(window.untilMs), "2026-10-01T10:30:00.000Z");
    assert.strictEqual(window.bucketKeys.length, 24);
    assert.strictEqual(window.bucketKeys[0], "2026-09-30T10:30:00.000Z");
    assert.strictEqual(window.bucketKeys[23], "2026-10-01T09:30:00.000Z");
  });

  it("runs today from local midnight to the end of the current hour", () => {
    // 13:20 in Sydney (AEST, +10).
    const window = usageWindow("today", "Australia/Sydney", ms("2026-10-01T03:20:00Z"));
    assert.strictEqual(iso(window.sinceMs), "2026-09-30T14:00:00.000Z");
    assert.strictEqual(iso(window.untilMs), "2026-10-01T04:00:00.000Z");
    assert.strictEqual(window.bucketKeys.length, 14);
  });

  it("has 23 hours on a spring-forward day", () => {
    // Sydney, 2026-10-04: 02:00 AEST jumps to 03:00 AEDT. 23:30 local.
    const sydney = usageWindow("today", "Australia/Sydney", ms("2026-10-04T12:30:00Z"));
    assert.strictEqual(iso(sydney.sinceMs), "2026-10-03T14:00:00.000Z");
    assert.strictEqual(iso(sydney.untilMs), "2026-10-04T13:00:00.000Z");
    assert.strictEqual(sydney.bucketKeys.length, 23);
    // 01:00 AEST is followed directly by 03:00 AEDT, one real hour later.
    assert.strictEqual(sydney.bucketKeys[1], "2026-10-03T15:00:00.000Z");
    assert.strictEqual(sydney.bucketKeys[2], "2026-10-03T16:00:00.000Z");

    // New York, 2026-03-08: 02:00 EST jumps to 03:00 EDT. 23:30 local.
    const newYork = usageWindow("today", "America/New_York", ms("2026-03-09T03:30:00Z"));
    assert.strictEqual(iso(newYork.sinceMs), "2026-03-08T05:00:00.000Z");
    assert.strictEqual(iso(newYork.untilMs), "2026-03-09T04:00:00.000Z");
    assert.strictEqual(newYork.bucketKeys.length, 23);
  });

  it("has 25 hours on a fall-back day, with both 01:00 hours", () => {
    // New York, 2026-11-01: 02:00 EDT falls back to 01:00 EST. 23:30 local.
    const window = usageWindow("today", "America/New_York", ms("2026-11-02T04:30:00Z"));
    assert.strictEqual(iso(window.sinceMs), "2026-11-01T04:00:00.000Z");
    assert.strictEqual(iso(window.untilMs), "2026-11-02T05:00:00.000Z");
    assert.strictEqual(window.bucketKeys.length, 25);
    assert.deepStrictEqual(window.bucketKeys.slice(1, 4), [
      "2026-11-01T05:00:00.000Z", // 01:00 EDT
      "2026-11-01T06:00:00.000Z", // 01:00 EST
      "2026-11-01T07:00:00.000Z", // 02:00 EST
    ]);
  });

  it("keeps 24 one-hour buckets in a 24h window across a change", () => {
    // 07:10 EST, the morning after New York fell back.
    const window = usageWindow("24h", "America/New_York", ms("2026-11-01T12:10:00Z"));
    assert.strictEqual(iso(window.sinceMs), "2026-10-31T13:00:00.000Z");
    assert.strictEqual(iso(window.untilMs), "2026-11-01T13:00:00.000Z");
    assert.strictEqual(window.bucketKeys.length, 24);
    window.bucketKeys.forEach((key, index) =>
      assert.strictEqual(ms(key), window.sinceMs + index * 3_600_000),
    );
  });

  it("covers whole local days, today included", () => {
    // 10:00 EST on 2026-11-03; the week starts in EDT.
    const window = usageWindow("7d", "America/New_York", ms("2026-11-03T15:00:00Z"));
    assert.strictEqual(window.resolution, "day");
    assert.strictEqual(iso(window.sinceMs), "2026-10-28T04:00:00.000Z");
    assert.strictEqual(iso(window.untilMs), "2026-11-04T05:00:00.000Z");
    assert.deepStrictEqual(window.bucketKeys, [
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);

    const quarter = usageWindow("90d", "Australia/Sydney", ms("2026-10-01T03:20:00Z"));
    assert.strictEqual(quarter.bucketKeys.length, 90);
    assert.strictEqual(quarter.bucketKeys[0], "2026-07-04");
    assert.strictEqual(quarter.bucketKeys[89], "2026-10-01");
    assert.strictEqual(iso(quarter.sinceMs), "2026-07-03T14:00:00.000Z");
  });

  it("reads an unknown zone as UTC", () => {
    const usage = build({ range: "today", timeZone: "Not/AZone" });
    assert.strictEqual(usage.timeZone, "UTC");
    assert.strictEqual(usage.since, "2026-10-01T00:00:00.000Z");
    assert.strictEqual(usage.buckets.length, 13);
  });
});

describe("usage report", () => {
  it("puts rows in local buckets and keeps empty ones", () => {
    // Sydney: 13:45Z is 23:45 on Sep 30, 14:00Z is midnight Oct 1.
    const data = readModel([
      row({ start: ms("2026-09-30T13:45:00Z"), account: "claude-ada.json", model: "m" }),
      row({ start: ms("2026-09-30T14:00:00Z"), account: "claude-ada.json", model: "m" }),
      row({ start: ms("2026-09-30T14:15:00Z"), account: "claude-ada.json", model: "m" }),
    ]);
    const days = build({ timeZone: "Australia/Sydney", now: ms("2026-10-01T03:20:00Z"), data });
    assert.strictEqual(days.buckets.length, 7);
    assert.deepStrictEqual(
      days.buckets.map((bucket) => [bucket.key, bucket.accounts[0]?.requests ?? 0]),
      [
        ["2026-09-25", 0],
        ["2026-09-26", 0],
        ["2026-09-27", 0],
        ["2026-09-28", 0],
        ["2026-09-29", 0],
        ["2026-09-30", 1],
        ["2026-10-01", 2],
      ],
    );

    // Kolkata hours start at :30 UTC.
    const hours = build({
      range: "24h",
      timeZone: "Asia/Kolkata",
      now: ms("2026-10-01T10:10:00Z"),
      data: readModel([
        row({ start: ms("2026-10-01T09:15:00Z"), account: "claude-ada.json", model: "m" }),
        row({ start: ms("2026-10-01T09:45:00Z"), account: "claude-ada.json", model: "m" }),
      ]),
    });
    const used = hours.buckets.filter((bucket) => bucket.accounts.length > 0);
    assert.deepStrictEqual(
      used.map((bucket) => bucket.key),
      ["2026-10-01T08:30:00.000Z", "2026-10-01T09:30:00.000Z"],
    );
  });

  it("prices like the Usage page, overrides and unpriced models included", () => {
    const start = ms("2026-10-01T09:00:00Z");
    const usage = build({
      accounts: [
        { id: "claude-ada.json", provider: "claude", email: "ada@example.com" },
        { id: "codex-bob.json", provider: "codex", email: "bob@example.com" },
      ],
      data: readModel([
        row({
          start,
          account: "claude-ada.json",
          model: "claude-test-1",
          requests: 2,
          tokens: tokens({
            uncachedInputTokens: 1_000,
            cachedInputTokens: 10_000,
            cacheCreationTokens: 2_000,
            outputTokens: 500,
          }),
          latencyMsSum: 3_000,
          latencyCount: 2,
        }),
        row({
          start,
          account: "codex-bob.json",
          provider: "codex",
          model: "gpt-test-1",
          tokens: tokens({
            uncachedInputTokens: 1_000_000,
            cachedInputTokens: 500_000,
            outputTokens: 100_000,
          }),
          latencyMsSum: 1_001,
          latencyCount: 1,
        }),
        // Three attempts, one failed; the two that answered carry tokens nobody prices.
        row({
          start,
          account: "codex-bob.json",
          provider: "codex",
          model: "mystery-model-x",
          requests: 3,
          failed: 1,
          tokens: tokens({ uncachedInputTokens: 100 }),
        }),
        // A failure with no tokens is not "unpriced", it simply cost nothing.
        row({
          start,
          account: "codex-bob.json",
          provider: "codex",
          model: "mystery-model-y",
          failed: 1,
          rateLimited: 1,
        }),
      ]),
    });

    // 1k*3 + 10k*0.3 + 2k*3.75 + 500*15 per million = $0.021; reads saved 10k*(3-0.3).
    const ada = usage.accounts.find((account) => account.id === "claude-ada.json");
    assert.closeTo(ada?.totals.costUsd ?? 0, 0.021, 1e-12);
    assert.closeTo(ada?.totals.cacheSavingsUsd ?? 0, 0.027, 1e-12);
    // 1M*2 + 500k*2 (cache at the input rate) + 100k*8 per million = $3.80.
    const bob = usage.accounts.find((account) => account.id === "codex-bob.json");
    assert.closeTo(bob?.totals.costUsd ?? 0, 3.8, 1e-9);
    assert.strictEqual(bob?.totals.unpricedRequests, 2);
    assert.strictEqual(bob?.totals.rateLimited, 1);

    assert.closeTo(usage.totals.costUsd, 3.821, 1e-9);
    assert.strictEqual(usage.totals.requests, 7);
    assert.strictEqual(usage.totals.failed, 2);
    assert.strictEqual(usage.totals.unpricedRequests, 2);
    assert.strictEqual(usage.totals.avgLatencyMs, 1_334);
    assert.isUndefined(usage.totals.avgTtftMs);

    // Highest cost first; equal cost falls back to requests, then name.
    assert.deepStrictEqual(
      usage.accounts.map((account) => account.id),
      ["codex-bob.json", "claude-ada.json"],
    );
    assert.deepStrictEqual(
      usage.models.map((model) => model.model),
      ["gpt-test-1", "claude-test-1", "mystery-model-x", "mystery-model-y"],
    );
    assert.deepStrictEqual(
      bob?.models.map((model) => model.model),
      ["gpt-test-1", "mystery-model-x", "mystery-model-y"],
    );
    assert.deepStrictEqual(usage.pricing, pricing);
  });

  it("keeps unattributed requests and removed accounts apart from signed-in ones", () => {
    const start = ms("2026-09-29T09:00:00Z");
    const usage = build({
      accounts: [
        { id: "claude-ada.json", provider: "claude", email: "ada@example.com" },
        { id: "claude-cyd.json", provider: "claude", email: "cyd@example.com" },
        // An auth file without an address: its rows supply one.
        { id: "codex-eve.json", provider: "codex" },
      ],
      data: readModel([
        row({ start, account: "claude-ada.json", model: "claude-test-1" }),
        row({
          start,
          account: "codex-eve.json",
          email: "eve@example.com",
          provider: "codex",
          model: "gpt-test-1",
        }),
        row({
          start,
          account: "claude-old.json",
          email: "old@example.com",
          model: "claude-test-1",
          tokens: tokens({ outputTokens: 1_000 }),
        }),
        row({ start, account: "", model: "claude-test-1", requests: 3, failed: 3, rateLimited: 3 }),
      ]),
    });

    assert.deepStrictEqual(
      usage.accounts.map((account) => [account.id, account.email, account.current]),
      [
        ["claude-old.json", "old@example.com", false],
        ["claude-ada.json", "ada@example.com", true],
        ["codex-eve.json", "eve@example.com", true],
        // Signed in, never used in the window: listed with zero usage.
        ["claude-cyd.json", "cyd@example.com", true],
      ],
    );
    const cyd = usage.accounts[3];
    assert.strictEqual(cyd?.totals.requests, 0);
    assert.isUndefined(cyd?.lastUsedAt);

    assert.strictEqual(usage.unattributed?.requests, 3);
    assert.strictEqual(usage.unattributed?.rateLimited, 3);
    assert.strictEqual(usage.totals.requests, 6);
    // Columns only carry accounts.
    const column = usage.buckets.find((bucket) => bucket.key === "2026-09-29");
    assert.deepStrictEqual(
      column?.accounts.map((account) => account.id),
      ["claude-old.json", "claude-ada.json", "codex-eve.json"],
    );

    const quiet = build({ data: readModel([row({ start, account: "a.json", model: "m" })]) });
    assert.isUndefined(quiet.unattributed);
  });

  it("merges address-only rows into the signed-in account with that address and provider", () => {
    const start = ms("2026-09-30T09:00:00Z");
    const usage = build({
      // The same address signed in to both agents.
      accounts: [
        { id: "claude-ada.json", provider: "claude", email: "ada@example.com" },
        { id: "codex-ada.json", provider: "codex", email: "ada@example.com" },
      ],
      data: readModel(
        [
          row({ start, account: "claude-ada.json", model: "claude-test-1" }),
          row({ start, account: "email:ADA@example.com", model: "claude-test-1", requests: 2 }),
          row({
            start,
            account: "email:ada@example.com",
            provider: "codex",
            model: "gpt-test-1",
            requests: 4,
          }),
          row({
            start,
            account: "email:gone@example.com",
            provider: "codex",
            model: "gpt-test-1",
          }),
        ],
        [
          sample({
            at: ms("2026-09-30T09:05:00Z"),
            account: "email:ada@example.com",
            provider: "codex",
            model: "gpt-test-1",
          }),
        ],
      ),
    });

    const requests = Object.fromEntries(
      usage.accounts.map((account) => [account.id, [account.totals.requests, account.current]]),
    );
    assert.deepStrictEqual(requests, {
      "claude-ada.json": [3, true],
      "codex-ada.json": [4, true],
      "email:codex:gone@example.com": [1, false],
    });
    const gone = usage.accounts.find((account) => account.id === "email:codex:gone@example.com");
    assert.strictEqual(gone?.email, "gone@example.com");
    assert.strictEqual(gone?.provider, "codex");
    assert.strictEqual(usage.recentEvents[0]?.accountId, "codex-ada.json");
    assert.strictEqual(
      usage.accounts.find((account) => account.id === "codex-ada.json")?.lastUsedAt,
      "2026-09-30T09:05:00.000Z",
    );
    // Without an event in the window, the newest row's bucket start stands in.
    assert.strictEqual(
      usage.accounts.find((account) => account.id === "claude-ada.json")?.lastUsedAt,
      "2026-09-30T09:00:00.000Z",
    );
  });

  it("keeps ambiguous email usage separate from workspaces and other providers", () => {
    const start = ms("2026-09-30T09:00:00Z");
    const usage = build({
      accounts: [
        { id: "codex-personal.json", provider: "codex", email: "ada@example.com" },
        { id: "codex-work.json", provider: "codex", email: "ADA@example.com" },
      ],
      data: readModel(
        [
          row({ start, account: "email:ada@example.com", model: "claude-test-1" }),
          row({ start, account: "email:ADA@example.com", model: "claude-test-1" }),
          row({
            start,
            account: "email:ada@example.com",
            provider: "codex",
            model: "gpt-test-1",
            requests: 3,
          }),
        ],
        [
          sample({ at: start, account: "email:ada@example.com" }),
          sample({ at: start, account: "email:ADA@example.com", provider: "codex" }),
        ],
      ),
    });

    assert.deepStrictEqual(
      usage.accounts.map((account) => [
        account.id,
        account.provider,
        account.totals.requests,
        account.current,
      ]),
      [
        ["email:codex:ada@example.com", "codex", 3, false],
        ["email:claude:ada@example.com", "claude", 2, false],
        ["codex-work.json", "codex", 0, true],
        ["codex-personal.json", "codex", 0, true],
      ],
    );
    assert.strictEqual(usage.accounts[0]?.email, "ada@example.com");
    assert.strictEqual(usage.accounts[1]?.email, "ada@example.com");
    assert.deepStrictEqual(
      usage.recentEvents.map((event) => event.accountId),
      ["email:claude:ada@example.com", "email:codex:ada@example.com"],
    );
    assert.deepStrictEqual(
      usage.buckets
        .find((bucket) => bucket.key === "2026-09-30")
        ?.accounts.map((account) => [account.id, account.requests]),
      [
        ["email:codex:ada@example.com", 3],
        ["email:claude:ada@example.com", 2],
      ],
    );
  });

  it("lists recent requests and errors in the window, newest first and capped", () => {
    const now = ms("2026-10-01T12:00:00Z");
    const minutes = (count: number) => count * 60_000;
    // 150 successes in the window, then one from before it.
    const events = [
      ...Array.from({ length: 150 }, (_, index) =>
        sample({
          at: now - minutes(index + 1),
          account: index % 2 === 0 ? "claude-ada.json" : "",
          tokens: tokens({ uncachedInputTokens: 1_000, outputTokens: 100 }),
          latencyMs: 812,
        }),
      ),
      sample({ at: ms("2026-09-20T00:00:00Z"), account: "claude-ada.json" }),
    ];
    const errors = Array.from({ length: 60 }, (_, index) =>
      sample({
        at: now - minutes(index + 1),
        account: "claude-ada.json",
        failed: true,
        statusCode: 429,
        message: "rate limited",
      }),
    );
    // A clock-skewed error from after the window must not take one of its slots.
    const usage = build({
      now,
      data: readModel([], events, [
        sample({ at: ms("2026-10-03T00:00:00Z"), account: "x", failed: true, statusCode: 500 }),
        ...errors,
      ]),
    });

    assert.strictEqual(usage.recentEvents.length, 100);
    const { costUsd, ...newest } = usage.recentEvents[0] ?? { costUsd: 0 };
    assert.deepStrictEqual(newest, {
      at: "2026-10-01T11:59:00.000Z",
      accountId: "claude-ada.json",
      provider: "claude",
      model: "claude-test-1",
      failed: false,
      tokens: 1_100,
      latencyMs: 812,
    });
    // 1k in at $3 + 100 out at $15 per million.
    assert.closeTo(costUsd, 0.0045, 1e-12);
    // Answered without an account: no id at all.
    assert.notProperty(usage.recentEvents[1], "accountId");

    assert.strictEqual(usage.recentErrors.length, 50);
    assert.isTrue(usage.recentErrors.every((event) => event.statusCode === 429));
    assert.strictEqual(usage.recentErrors[0]?.message, "rate limited");
  });

  it("reports how far back history goes and why it isn't recording", () => {
    const usage = build({
      data: readModel([], [], [], ms("2026-07-03T00:15:00Z")),
      recording: false,
      recordingNote: "A team server records usage itself.",
    });
    assert.strictEqual(usage.recordedSince, "2026-07-03T00:15:00.000Z");
    assert.isFalse(usage.recording);
    assert.strictEqual(usage.recordingNote, "A team server records usage itself.");
    assert.strictEqual(usage.since, "2026-09-25T00:00:00.000Z");
    assert.strictEqual(usage.until, "2026-10-02T00:00:00.000Z");
  });
});
