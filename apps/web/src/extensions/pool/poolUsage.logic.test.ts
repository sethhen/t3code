import type {
  PoolAccount,
  PoolUsage,
  PoolUsageAccount,
  PoolUsageBucket,
  PoolUsageEvent,
  PoolUsageTotals,
} from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  bucketAxisLabel,
  buildUsageChart,
  buildUsageSeries,
  cacheHitRate,
  emptyUsageMessage,
  findUsageAccount,
  formatEventTime,
  formatLatency,
  isCostUnknown,
  NO_ACCOUNT_KEY,
  OTHER_ACCOUNTS_KEY,
  scopeUsage,
  stackSegments,
  successRate,
  usageAccountShortLabel,
} from "./poolUsage.logic";

function totals(overrides: Partial<PoolUsageTotals> = {}): PoolUsageTotals {
  return {
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
    ...overrides,
  };
}

function usageAccount(id: string, overrides: Partial<PoolUsageAccount> = {}): PoolUsageAccount {
  return { id, provider: "claude", current: true, totals: totals(), models: [], ...overrides };
}

function live(id: string, provider: PoolAccount["provider"] = "claude"): PoolAccount {
  return { id, provider, status: "ready", windows: [] };
}

function event(overrides: Partial<PoolUsageEvent> = {}): PoolUsageEvent {
  return {
    at: "2026-10-01T12:00:00.000Z",
    provider: "claude",
    model: "claude-sonnet-4-5",
    failed: false,
    tokens: 10,
    costUsd: 0.01,
    ...overrides,
  };
}

function usage(overrides: Partial<PoolUsage> = {}): PoolUsage {
  return {
    range: "7d",
    timeZone: "UTC",
    since: "2026-09-25T00:00:00.000Z",
    until: "2026-10-02T00:00:00.000Z",
    resolution: "day",
    totals: totals(),
    accounts: [],
    models: [],
    buckets: [],
    recentEvents: [],
    recentErrors: [],
    pricing: { status: "fresh", source: "LiteLLM", fetchedAt: null, knownModels: 10 },
    recording: true,
    ...overrides,
  };
}

describe("buildUsageSeries", () => {
  it("keeps an account's colour whatever its cost rank or which removed accounts the range shows", () => {
    const liveAccounts = [live("claude-b.json"), live("codex-a.json", "codex")];
    const week = buildUsageSeries(
      [
        usageAccount("codex-a.json", { provider: "codex" }),
        usageAccount("email:old@example.com", { current: false }),
        usageAccount("claude-b.json"),
      ],
      liveAccounts,
    );
    const today = buildUsageSeries(
      [usageAccount("claude-b.json"), usageAccount("codex-a.json", { provider: "codex" })],
      liveAccounts,
    );

    for (const id of ["claude-b.json", "codex-a.json"]) {
      assert.strictEqual(week.colorOf(id), today.colorOf(id));
    }
    // Claude before Codex, as Settings lists them; the removed account comes after.
    assert.deepStrictEqual(
      week.series.map((series) => series.key),
      ["claude-b.json", "codex-a.json", "email:old@example.com", NO_ACCOUNT_KEY],
    );
  });

  it("gives up to eight accounts distinct colours and folds the rest into one neutral series", () => {
    const accounts = Array.from({ length: 10 }, (_, at) => usageAccount(`acct-${at}`));
    const index = buildUsageSeries(accounts, []);
    const colors = accounts.slice(0, 8).map((account) => index.colorOf(account.id));

    assert.strictEqual(new Set(colors).size, 8);
    assert.strictEqual(index.keyOf("acct-8"), OTHER_ACCOUNTS_KEY);
    assert.strictEqual(index.colorOf("acct-9"), index.colorOf("acct-8"));
    assert.notInclude(colors, index.colorOf("acct-8"));
    // A folded account keeps its own name; only the colour is shared.
    assert.strictEqual(index.labelOf("acct-9"), "Claude account");
  });

  it("draws unknown and empty account ids as No account", () => {
    const index = buildUsageSeries([usageAccount("claude-a.json")], [live("claude-a.json")]);
    for (const id of ["", "gone.json", undefined]) {
      assert.strictEqual(index.keyOf(id), NO_ACCOUNT_KEY);
      assert.strictEqual(index.labelOf(id), "No account");
    }
    assert.notStrictEqual(index.colorOf(""), index.colorOf("claude-a.json"));
  });

  it("names accounts by provider and initials, never the address", () => {
    assert.strictEqual(
      usageAccountShortLabel({ provider: "codex", email: "ada@example.com" }),
      "Codex AE",
    );
    assert.strictEqual(usageAccountShortLabel({ provider: "claude" }), "Claude account");
  });
});

describe("scopeUsage", () => {
  const ada = usageAccount("claude-ada.json", {
    totals: totals({ requests: 3, costUsd: 1 }),
    models: [{ model: "claude-opus-4-1", provider: "claude", totals: totals({ requests: 3 }) }],
  });
  const all = usage({
    totals: totals({ requests: 5, costUsd: 2 }),
    accounts: [ada, usageAccount("claude-alan.json")],
    models: [{ model: "claude-sonnet-4-5", provider: "claude", totals: totals({ requests: 5 }) }],
    recentEvents: [
      event({ accountId: "claude-ada.json" }),
      event({ accountId: "claude-alan.json" }),
      event({}),
    ],
    recentErrors: [event({ accountId: "claude-alan.json", failed: true, statusCode: 429 })],
  });

  it("uses the server's pool-wide numbers for every account (unattributed requests included)", () => {
    const scoped = scopeUsage(all, null);
    assert.strictEqual(scoped.totals.requests, 5);
    assert.strictEqual(scoped.recentEvents.length, 3);
  });

  it("narrows totals, models, requests and errors to the selected account", () => {
    const scoped = scopeUsage(all, findUsageAccount(all, "claude-ada.json"));
    assert.strictEqual(scoped.totals.costUsd, 1);
    assert.deepStrictEqual(
      scoped.models.map((model) => model.model),
      ["claude-opus-4-1"],
    );
    assert.deepStrictEqual(
      scoped.recentEvents.map((entry) => entry.accountId),
      ["claude-ada.json"],
    );
    assert.strictEqual(scoped.recentErrors.length, 0);
  });

  it("finds no account when the selection is not in this range", () => {
    assert.isNull(findUsageAccount(all, "email:old@example.com"));
  });
});

describe("rates", () => {
  it("are null rather than 0% with nothing to divide by", () => {
    assert.isNull(successRate(totals()));
    assert.isNull(cacheHitRate(totals().tokens));
  });

  it("count failures against requests and cache reads against all input", () => {
    assert.strictEqual(successRate(totals({ requests: 4, failed: 1 })), 0.75);
    const tokens = {
      uncachedInputTokens: 100,
      cachedInputTokens: 300,
      cacheCreationTokens: 100,
      outputTokens: 1_000,
      reasoningTokens: 500,
    };
    assert.strictEqual(cacheHitRate(tokens), 0.6);
  });

  it("calls cost unknown only when prices are missing and tokens were used", () => {
    const tokens = totals({
      tokens: { ...totals().tokens, outputTokens: 10 },
    });
    const unavailable = {
      status: "unavailable",
      source: "LiteLLM",
      fetchedAt: null,
      knownModels: 0,
    } as const;
    assert.isTrue(isCostUnknown({ pricing: unavailable }, tokens));
    assert.isFalse(isCostUnknown({ pricing: unavailable }, totals()));
    assert.isFalse(isCostUnknown(usage(), tokens));
  });
});

describe("emptyUsageMessage", () => {
  it("is null once anything was served, even only requests no account could take", () => {
    assert.isNull(emptyUsageMessage(usage({ totals: totals({ requests: 1 }) })));
    assert.isNull(emptyUsageMessage(usage({ unattributed: totals({ requests: 2 }) })));
  });

  it("explains why nothing is recorded before saying nothing happened", () => {
    assert.strictEqual(
      emptyUsageMessage(usage({ recording: false, recordingNote: "The server records usage." })),
      "The server records usage.",
    );
    assert.strictEqual(
      emptyUsageMessage(usage({ recordedSince: "2026-09-01T00:00:00.000Z" })),
      "No requests in this period.",
    );
    assert.strictEqual(
      emptyUsageMessage(usage()),
      "Usage shows up here as your accounts serve requests.",
    );
  });
});

describe("buildUsageChart", () => {
  const accounts = [usageAccount("a.json"), usageAccount("b.json")];
  const index = buildUsageSeries(accounts, [live("a.json"), live("b.json")]);
  const buckets: PoolUsageBucket[] = [
    {
      key: "2026-09-30",
      accounts: [
        { id: "b.json", costUsd: 2, tokens: 200, requests: 2 },
        { id: "a.json", costUsd: 1, tokens: 500, requests: 1 },
      ],
    },
    { key: "2026-10-01", accounts: [{ id: "", costUsd: 0, tokens: 30, requests: 3 }] },
    { key: "2026-10-02", accounts: [] },
  ];

  it("stacks every account in slot order and tops the scale at the tallest column", () => {
    const cost = buildUsageChart(buckets, index, "cost", null);
    assert.deepStrictEqual(
      cost.series.map((series) => series.key),
      ["a.json", "b.json"],
    );
    assert.deepStrictEqual(
      cost.columns.map((column) => column.values),
      [
        [1, 2],
        [0, 0],
        [0, 0],
      ],
    );
    assert.strictEqual(cost.peak, 3);

    const tokens = buildUsageChart(buckets, index, "tokens", null);
    assert.deepStrictEqual(
      tokens.series.map((series) => series.key),
      ["a.json", "b.json", NO_ACCOUNT_KEY],
    );
    assert.deepStrictEqual(
      tokens.columns.map((column) => column.total),
      [700, 30, 0],
    );
    assert.strictEqual(tokens.peak, 700);
  });

  it("draws only the selected account, in its own colour", () => {
    const chart = buildUsageChart(buckets, index, "tokens", "b.json");
    assert.strictEqual(chart.series.length, 1);
    assert.strictEqual(chart.series[0]!.color, index.colorOf("b.json"));
    assert.deepStrictEqual(
      chart.columns.map((column) => column.total),
      [200, 0, 0],
    );
  });
});

describe("stackSegments", () => {
  it("stacks drawn segments from the baseline, skipping empty series", () => {
    assert.deepStrictEqual(stackSegments([1, 0, 3], 8), [
      { at: 0, bottom: 0, height: 12.5, first: true, last: false },
      { at: 2, bottom: 12.5, height: 37.5, first: false, last: true },
    ]);
  });

  it("draws nothing on an empty scale", () => {
    assert.deepStrictEqual(stackSegments([0, 0], 4), []);
    assert.deepStrictEqual(stackSegments([1], 0), []);
  });
});

describe("labels", () => {
  it("labels day buckets by date and hour buckets in the viewer's zone", () => {
    assert.strictEqual(bucketAxisLabel("2026-10-01", "day", "UTC"), "Oct 1");
    assert.strictEqual(bucketAxisLabel("2026-10-01T15:00:00.000Z", "hour", "UTC"), "3 PM");
    assert.strictEqual(
      bucketAxisLabel("2026-10-01T15:00:00.000Z", "hour", "America/New_York"),
      "11 AM",
    );
  });

  it("gives request times to the minute in the requested zone", () => {
    assert.strictEqual(formatEventTime("2026-10-01T15:04:00.000Z", "UTC"), "Oct 1, 3:04 PM");
    assert.strictEqual(formatEventTime("2026-10-01T15:09:00.000Z", "UTC"), "Oct 1, 3:09 PM");
  });

  it("formats latencies at a readable precision", () => {
    assert.strictEqual(formatLatency(undefined), "—");
    assert.strictEqual(formatLatency(850), "850 ms");
    assert.strictEqual(formatLatency(2_140), "2.1 s");
    assert.strictEqual(formatLatency(90_000), "1.5 min");
  });
});
