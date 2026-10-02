import {
  EventId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  candidateSummary,
  continueCandidates,
  holdQueueForMove,
  releaseQueueAfterMove,
  type StopThread,
  usageLimitStop,
} from "./continueOn.logic";
import type { ProviderInstanceEntry, QueuedComposerMessage } from "./t3";

const TURN = TurnId.make("turn-2");
const PAUSE_TEXT = "Claude usage limit reached. This turn is paused until the 5-hour limit resets.";

const activity = (
  id: string,
  sequence: number,
  kind: string,
  payload: unknown = {},
): StopThread["activities"][number] => ({
  id: EventId.make(id),
  kind,
  payload,
  turnId: TURN,
  sequence,
  createdAt: `2026-10-02T10:00:${String(sequence).padStart(2, "0")}.000Z`,
});

const running = (patch: Partial<StopThread> = {}): StopThread => ({
  session: { status: "running", activeTurnId: TURN, lastError: null },
  latestTurn: { turnId: TURN },
  activities: [],
  messages: [],
  ...patch,
});

const stopped = (status: "error" | "stopped" | "running" | "starting", lastError: string) =>
  running({ session: { status, activeTurnId: null, lastError } });

describe("usageLimitStop", () => {
  it("a Claude turn parked on a rejected window is paused, keyed by its warning", () => {
    const thread = running({
      activities: [
        activity("tool", 1, "tool.completed"),
        activity("pause", 2, "runtime.warning", {
          message: PAUSE_TEXT,
          detail: { status: "rejected", rateLimitType: "five_hour" },
        }),
      ],
      messages: [{ role: "assistant", turnId: TURN, updatedAt: "2026-10-02T10:00:01.500Z" }],
    });
    assert.deepEqual(usageLimitStop(thread), { kind: "paused", key: "pause" });
  });

  it("recognizes the pause by the SDK's rejected status alone, and the fork's long rate-limit wait", () => {
    const rejected = activity("pause", 2, "runtime.warning", {
      message: "Something else",
      detail: { status: "rejected" },
    });
    assert.equal(usageLimitStop(running({ activities: [rejected] }))?.kind, "paused");
    const retryWait = activity("wait", 2, "runtime.warning", {
      message: "Claude is rate limited. This turn is paused and retries in 2h.",
      detail: { type: "system", subtype: "api_retry" },
    });
    assert.equal(usageLimitStop(running({ activities: [retryWait] }))?.kind, "paused");
  });

  it("orders a database snapshot by sequence, not position", () => {
    const pause = activity("pause", 3, "runtime.warning", { message: PAUSE_TEXT });
    const other = activity("other", 2, "runtime.warning", { message: "Context compacted." });
    assert.equal(usageLimitStop(running({ activities: [pause, other] }))?.key, "pause");
    // A tool row stored after the pause but listed first still means the turn moved on.
    const resumed = activity("tool", 4, "tool.completed");
    assert.isNull(usageLimitStop(running({ activities: [resumed, pause] })));
  });

  it("hides once the turn moves on: newer work, or assistant text written after the pause", () => {
    const pause = activity("pause", 2, "runtime.warning", { message: PAUSE_TEXT });
    assert.isNull(
      usageLimitStop(running({ activities: [pause, activity("tool", 3, "tool.started")] })),
    );
    assert.isNull(
      usageLimitStop(
        running({
          activities: [pause],
          messages: [{ role: "assistant", turnId: TURN, updatedAt: "2026-10-02T10:00:05.000Z" }],
        }),
      ),
    );
  });

  it("a reasoning message after the pause means the turn moved on; a user message does not", () => {
    const pause = activity("pause", 2, "runtime.warning", { message: PAUSE_TEXT });
    assert.isNull(
      usageLimitStop(
        running({
          activities: [pause],
          messages: [{ role: "reasoning", turnId: TURN, updatedAt: "2026-10-02T10:00:05.000Z" }],
        }),
      ),
    );
    assert.equal(
      usageLimitStop(
        running({
          activities: [pause],
          messages: [{ role: "user", turnId: TURN, updatedAt: "2026-10-02T10:00:05.000Z" }],
        }),
      )?.kind,
      "paused",
    );
  });

  it("only the active turn's newest warning counts", () => {
    const pause = activity("pause", 2, "runtime.warning", { message: PAUSE_TEXT });
    const later = activity("later", 3, "runtime.warning", { message: "Context compacted." });
    assert.isNull(usageLimitStop(running({ activities: [pause, later] })));
    const oldTurn = { ...pause, turnId: TurnId.make("turn-1") };
    assert.isNull(usageLimitStop(running({ activities: [oldTurn] })));
    assert.isNull(
      usageLimitStop(
        running({
          session: { status: "ready", activeTurnId: null, lastError: null },
          activities: [pause],
        }),
      ),
    );
  });

  it("a turn that failed on Claude's or Codex's limit is failed, keyed by that turn", () => {
    for (const error of [
      "Claude usage limit reached. Send the message again once the limit resets.",
      "Claude stopped: a usage limit blocked the request.",
      "Codex usage limit reached. The weekly limit resets in 2d 4h. Send the message again once the limit resets.",
    ]) {
      assert.deepEqual(usageLimitStop(stopped("error", error)), { kind: "failed", key: TURN });
    }
    // The session may be reaped while the thread waits; the stop stays.
    assert.equal(usageLimitStop(stopped("stopped", "Codex usage limit reached."))?.kind, "failed");
  });

  it("a failure from something else, or one the next turn is already past, is not a stop", () => {
    assert.isNull(usageLimitStop(stopped("error", "Claude gave up after repeated API errors.")));
    assert.isNull(usageLimitStop(stopped("starting", "Codex usage limit reached.")));
    assert.isNull(
      usageLimitStop(
        running({
          session: {
            status: "running",
            activeTurnId: TURN,
            lastError: "Codex usage limit reached.",
          },
        }),
      ),
    );
    assert.isNull(usageLimitStop(running({ session: null })));
  });
});

const window = (usedPercent: number, resetsAt?: string): ServerProviderUsageWindow => ({
  id: `w${usedPercent}`,
  kind: "session",
  label: "5h",
  usedPercent,
  ...(resetsAt ? { resetsAt } : {}),
});

const entry = (
  id: string,
  patch: {
    driver?: string;
    groupKey?: string | undefined;
    windows?: ServerProviderUsageWindow[];
    plan?: string;
  } = {},
): ProviderInstanceEntry => {
  const driverKind = ProviderDriverKind.make(patch.driver ?? "claudeAgent");
  const snapshot: ServerProvider = {
    instanceId: ProviderInstanceId.make(id),
    driver: driverKind,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", ...(patch.plan ? { label: patch.plan } : {}) },
    checkedAt: "2026-10-02T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(patch.windows
      ? { usageLimits: { checkedAt: "2026-10-02T10:00:00.000Z", windows: patch.windows } }
      : {}),
  };
  return {
    instanceId: ProviderInstanceId.make(id),
    driverKind,
    displayName: id,
    continuationGroupKey: "groupKey" in patch ? patch.groupKey : "claude:shared",
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: false,
    isAvailable: true,
    snapshot,
    models: [],
  };
};

describe("continueCandidates", () => {
  const current = entry("limited", { windows: [window(100)] });

  it("offers the other accounts that share this conversation store, most headroom first", () => {
    const candidates = continueCandidates(
      [
        current,
        entry("unknown"),
        entry("tight", { windows: [window(10), window(90)] }),
        entry("roomy", { windows: [window(20), window(40)] }),
        entry("other-store", { groupKey: "claude:home:/elsewhere", windows: [window(0)] }),
        entry("codex", { driver: "codex", windows: [window(0)] }),
      ],
      current,
    );
    assert.deepEqual(
      candidates.map((candidate) => [String(candidate.entry.instanceId), candidate.headroom]),
      [
        ["roomy", 60],
        ["tight", 10],
        ["unknown", null],
      ],
    );
  });

  it("offers nothing when the thread's account has no continuation key", () => {
    const keyless = entry("keyless", { groupKey: undefined });
    assert.deepEqual(
      continueCandidates([keyless, entry("other", { groupKey: undefined })], keyless),
      [],
    );
    assert.deepEqual(continueCandidates([entry("other")], keyless), []);
  });

  it("summarizes plan, quota left and the tightest window's reset", () => {
    const now = Date.parse("2026-10-02T10:00:00.000Z");
    const [roomy] = continueCandidates(
      [entry("roomy", { plan: "Claude Max", windows: [window(18, "2026-10-02T12:13:00.000Z")] })],
      current,
    );
    assert.equal(candidateSummary(roomy!, now), "Claude Max · 82% left · resets in 2h 13m");
    const [unknown] = continueCandidates([entry("unknown")], current);
    assert.equal(candidateSummary(unknown!, now), "usage unknown");
  });
});

const selection = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const queued = (
  id: string,
  model: string,
  patch: Partial<QueuedComposerMessage> = {},
): QueuedComposerMessage => ({
  id,
  prompt: id,
  images: [],
  files: [],
  terminalContexts: [],
  previewAnnotations: [],
  reviewComments: [],
  sendSettings: {
    modelSelection: selection("limited", model),
    runtimeMode: "full-access",
    interactionMode: "default",
    promptEffort: null,
  },
  queuedAfterToolActivityId: null,
  createdAt: "2026-10-02T10:00:00.000Z",
  ...patch,
});

describe("holdQueueForMove and releaseQueueAfterMove", () => {
  const retarget = (current: ModelSelection) => selection("roomy", current.model);
  const view = (queue: ReadonlyArray<QueuedComposerMessage> | undefined) =>
    queue?.map((message) => [
      message.id,
      String(message.sendSettings.modelSelection.instanceId),
      message.sendSettings.modelSelection.model,
      message.holdUntilUserAction ?? false,
    ]);

  it("holds the thread's waiting messages on the picked account, then lets go of just those", () => {
    const other = [queued("elsewhere", "opus")];
    const sending = queued("sending", "opus", { sending: "dispatching" });
    const queues = {
      thread: [queued("a", "opus"), queued("b", "sonnet", { holdUntilUserAction: true }), sending],
      other,
    };
    const hold = holdQueueForMove(queues, "thread", retarget);
    assert.deepEqual(view(hold.queuesByThreadKey.thread), [
      ["a", "roomy", "opus", true],
      ["b", "roomy", "sonnet", true],
      ["sending", "limited", "opus", false],
    ]);
    assert.strictEqual(hold.queuesByThreadKey.thread![2], sending);
    assert.strictEqual(hold.queuesByThreadKey.other, other);
    assert.deepEqual([...hold.held], ["a"]);

    const released = releaseQueueAfterMove(hold.queuesByThreadKey, "thread", hold.held);
    // "b" was held for the user before the move and stays that way.
    assert.deepEqual(view(released.thread), [
      ["a", "roomy", "opus", false],
      ["b", "roomy", "sonnet", true],
      ["sending", "limited", "opus", false],
    ]);
    assert.strictEqual(released.other, other);
  });

  it("releases nothing the user sent or removed during the move", () => {
    const hold = holdQueueForMove(
      { thread: [queued("a", "opus"), queued("b", "opus")] },
      "thread",
      retarget,
    );
    const [a] = hold.queuesByThreadKey.thread!;
    // Send now took "a"; "b" was removed.
    const during = { thread: [{ ...a!, sending: "preparing" as const }] };
    assert.strictEqual(releaseQueueAfterMove(during, "thread", hold.held), during);
    const emptied = {};
    assert.strictEqual(releaseQueueAfterMove(emptied, "thread", hold.held), emptied);
  });

  it("leaves the queues alone when the thread has none", () => {
    const queues = { other: [queued("elsewhere", "opus")] };
    const hold = holdQueueForMove(queues, "thread", retarget);
    assert.strictEqual(hold.queuesByThreadKey, queues);
    assert.equal(hold.held.size, 0);
  });
});
