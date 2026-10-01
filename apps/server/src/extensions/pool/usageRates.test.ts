// @effect-diagnostics nodeBuiltinImport:off - writes rate snapshots to a temp directory.
// @effect-diagnostics globalDate:off - fixtures are fixed instants written as ISO strings.
// @effect-diagnostics preferSchemaOverJson:off - writes the snapshot file as plain JSON, like upstream does.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { createUsageRates } from "./usageRates.ts";

const HOUR_MS = 60 * 60_000;
const NOW = Date.parse("2026-10-01T12:00:00Z");

const entry = { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 };

const tempCachePath = () =>
  NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pool-rates-")),
    "usage-model-rates.json",
  );

/** Writes a snapshot the way `UsageService` does, with an explicit mtime (seconds). */
const writeSnapshot = (
  path: string,
  fetchedAtMs: number,
  models: ReadonlyArray<string>,
  mtimeSeconds: number,
) => {
  const document = Object.fromEntries(models.map((model) => [model, entry]));
  NodeFS.writeFileSync(path, JSON.stringify({ fetchedAtMs, document }));
  NodeFS.utimesSync(path, mtimeSeconds, mtimeSeconds);
};

const clock = (start: number) => {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe("usage rates", () => {
  it("parses the snapshot once per file version", async () => {
    const cachePath = tempCachePath();
    writeSnapshot(cachePath, NOW - HOUR_MS, ["claude-test-1"], 1_000);
    const rates = createUsageRates({ cachePath, now: () => NOW });

    const first = await rates.read();
    assert.deepStrictEqual(first.pricing, {
      status: "fresh",
      source:
        "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
      fetchedAt: "2026-10-01T11:00:00.000Z",
      knownModels: 1,
    });
    const again = await rates.read();
    assert.strictEqual(again.rates, first.rates);

    writeSnapshot(cachePath, NOW - HOUR_MS, ["claude-test-1", "gpt-test-1"], 2_000);
    const rewritten = await rates.read();
    assert.notStrictEqual(rewritten.rates, first.rates);
    assert.strictEqual(rewritten.pricing.knownModels, 2);
  });

  it("labels a day-old table cached and keeps pricing with it", async () => {
    const cachePath = tempCachePath();
    writeSnapshot(cachePath, NOW - 25 * HOUR_MS, ["claude-test-1"], 1_000);
    const { rates, pricing } = await createUsageRates({ cachePath, now: () => NOW }).read();
    assert.strictEqual(pricing.status, "cached");
    assert.strictEqual(pricing.fetchedAt, "2026-09-30T11:00:00.000Z");
    assert.isTrue(rates.has("claude-test-1"));
  });

  it("is unavailable without a usable snapshot", async () => {
    const cachePath = tempCachePath();
    const missing = await createUsageRates({ cachePath, now: () => NOW }).read();
    assert.strictEqual(missing.pricing.status, "unavailable");
    assert.isNull(missing.pricing.fetchedAt);
    assert.strictEqual(missing.rates.size, 0);

    // Caught mid-write.
    NodeFS.writeFileSync(cachePath, '{"fetchedAtMs": 1, "docum');
    const damaged = await createUsageRates({ cachePath, now: () => NOW }).read();
    assert.strictEqual(damaged.pricing.status, "unavailable");
  });

  it("refreshes a missing snapshot, at most every ten minutes", async () => {
    const cachePath = tempCachePath();
    const time = clock(NOW);
    let calls = 0;
    const rates = createUsageRates({
      cachePath,
      now: time.now,
      refresh: async () => {
        calls++;
        // Offline the first time.
        if (calls === 1) throw new Error("offline");
        writeSnapshot(cachePath, time.now(), ["claude-test-1"], 1_000);
      },
    });

    assert.strictEqual((await rates.read()).pricing.status, "unavailable");
    assert.strictEqual(calls, 1);

    time.advance(5 * 60_000);
    assert.strictEqual((await rates.read()).pricing.status, "unavailable");
    assert.strictEqual(calls, 1);

    time.advance(6 * 60_000);
    const { pricing } = await rates.read();
    assert.strictEqual(calls, 2);
    assert.strictEqual(pricing.status, "fresh");
    assert.strictEqual(pricing.knownModels, 1);
  });

  it("refreshes a stale snapshot and keeps serving it when that fails", async () => {
    const cachePath = tempCachePath();
    writeSnapshot(cachePath, NOW - 25 * HOUR_MS, ["claude-test-1"], 1_000);
    let calls = 0;
    const rates = createUsageRates({
      cachePath,
      now: () => NOW,
      // Throws before returning a promise: must be swallowed all the same.
      refresh: () => {
        calls++;
        throw new Error("offline");
      },
    });

    const [first, second] = await Promise.all([rates.read(), rates.read()]);
    assert.strictEqual(calls, 1);
    assert.strictEqual(first.pricing.status, "cached");
    assert.strictEqual(second.pricing.knownModels, 1);
  });

  it("shares one refresh between concurrent reads", async () => {
    const cachePath = tempCachePath();
    let calls = 0;
    let started = () => {};
    const refreshStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish = () => {};
    const rates = createUsageRates({
      cachePath,
      now: () => NOW,
      refresh: () => {
        calls++;
        started();
        return new Promise<void>((resolve) => {
          finish = () => {
            writeSnapshot(cachePath, NOW, ["claude-test-1"], 1_000);
            resolve();
          };
        });
      },
    });

    const reads = Promise.all([rates.read(), rates.read(), rates.read()]);
    await refreshStarted;
    // One more file-system round trip: the other reads have found the snapshot
    // missing too by now, and must wait for this refresh rather than answer early.
    await NodeFS.promises.stat(cachePath).catch(() => undefined);
    finish();
    const results = await reads;
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(
      results.map((result) => result.pricing.status),
      ["fresh", "fresh", "fresh"],
    );
  });
});
