import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { gatedRead, type Slot, type SlotMode, slotFor, withAgentWrite } from "./probes.ts";

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

/** Lets forked fibers run as far as they can. */
const settleFibers = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
  discard: true,
});

describe("agent write gate", () => {
  it.effect("a read waits while a write to its app runs", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      const writing = yield* Deferred.make<void>();
      const finishWrite = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        withAgentWrite(
          ["claude"],
          Effect.gen(function* () {
            log.push("write");
            yield* Deferred.succeed(writing, undefined);
            yield* Deferred.await(finishWrite);
            log.push("write done");
          }),
        ),
      );
      yield* Deferred.await(writing);
      const reader = yield* Effect.forkChild(
        gatedRead(
          "claude",
          Effect.sync(() => log.push("read")),
        ),
      );
      yield* settleFibers;
      assert.deepStrictEqual(log, ["write"]);

      yield* Deferred.succeed(finishWrite, undefined);
      yield* Fiber.join(writer);
      yield* Fiber.join(reader);
      assert.deepStrictEqual(log, ["write", "write done", "read"]);
    }),
  );

  it.effect("a write stops a read in flight, waits for its process, and the read reruns", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      let runs = 0;
      const firstRunning = yield* Deferred.make<void>();
      const firstExit = yield* Deferred.make<void>();
      // A session with a process: spawned on acquire, gone once release returns.
      const session = Effect.acquireUseRelease(
        Effect.sync(() => {
          runs += 1;
          log.push(`spawn ${runs}`);
          return runs;
        }),
        (run) =>
          run === 1
            ? Effect.andThen(Deferred.succeed(firstRunning, undefined), Effect.never)
            : Effect.succeed(run),
        (run) =>
          Effect.gen(function* () {
            // The first process takes a while to exit.
            if (run === 1) yield* Deferred.await(firstExit);
            log.push(`exit ${run}`);
          }),
      );
      const reader = yield* Effect.forkChild(gatedRead("claude", session));
      yield* Deferred.await(firstRunning);

      const writer = yield* Effect.forkChild(
        withAgentWrite(
          ["claude"],
          Effect.sync(() => log.push("write")),
        ),
      );
      yield* settleFibers;
      // Interrupted, but its process has not exited yet: the write waits.
      assert.deepStrictEqual(log, ["spawn 1"]);

      yield* Deferred.succeed(firstExit, undefined);
      yield* Fiber.join(writer);
      assert.strictEqual(yield* Fiber.join(reader), 2);
      assert.deepStrictEqual(log, ["spawn 1", "exit 1", "write", "spawn 2", "exit 2"]);
    }),
  );

  it.effect("Claude and Codex gates are independent", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const finishWrite = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        withAgentWrite(
          ["claude"],
          Effect.andThen(Deferred.succeed(writing, undefined), Deferred.await(finishWrite)),
        ),
      );
      yield* Deferred.await(writing);
      // A Codex read and a Codex write both run while the Claude write holds.
      assert.strictEqual(yield* gatedRead("codex", Effect.succeed("codex read")), "codex read");
      assert.strictEqual(
        yield* withAgentWrite(["codex"], Effect.succeed("codex write")),
        "codex write",
      );
      yield* Deferred.succeed(finishWrite, undefined);
      yield* Fiber.join(writer);
    }),
  );
});
