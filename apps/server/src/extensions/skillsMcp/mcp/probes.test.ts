import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { type Slot, type SlotMode, slotFor } from "./probes.ts";

interface TestSlot extends Slot {
  readonly id: number;
  readonly done: Deferred.Deferred<void>;
}

/** Probes that settle only when their gate opens. */
const harness = Effect.gen(function* () {
  const slots = new Map<string, TestSlot>();
  let gate = yield* Deferred.make<void>();
  let started = 0;
  const get = (mode: SlotMode) =>
    slotFor(
      slots,
      "k",
      mode,
      (): TestSlot => ({
        id: ++started,
        settledAt: undefined,
        failed: false,
        done: Deferred.makeUnsafe(),
      }),
      (slot) =>
        Effect.gen(function* () {
          yield* Deferred.await(gate);
          slot.settledAt = yield* Clock.currentTimeMillis;
          yield* Deferred.succeed(slot.done, undefined);
        }),
    );
  const settleAll = Effect.gen(function* () {
    yield* Deferred.succeed(gate, undefined);
    for (const slot of slots.values()) yield* Deferred.await(slot.done);
    gate = yield* Deferred.make<void>();
  });
  return { get, settleAll };
});

describe("slotFor", () => {
  it.effect("refresh joins a probe in flight but never a settled one", () =>
    Effect.gen(function* () {
      const { get, settleAll } = yield* harness;
      const first = yield* get("cached");
      assert.strictEqual((yield* get("refresh")).id, first.id);
      yield* settleAll;

      assert.strictEqual((yield* get("cached")).id, first.id);
      const refreshed = yield* get("refresh");
      assert.notStrictEqual(refreshed.id, first.id);
      assert.strictEqual((yield* get("refresh")).id, refreshed.id);
    }),
  );

  it.effect("force never joins, and cached expires after a minute", () =>
    Effect.gen(function* () {
      const { get, settleAll } = yield* harness;
      const first = yield* get("cached");
      const forced = yield* get("force");
      assert.notStrictEqual(forced.id, first.id);
      yield* settleAll;

      yield* TestClock.adjust("59 seconds");
      assert.strictEqual((yield* get("cached")).id, forced.id);
      yield* TestClock.adjust("2 seconds");
      assert.notStrictEqual((yield* get("cached")).id, forced.id);
    }),
  );
});
