import { assert, describe, it } from "@effect/vitest";

import { describeClaudeRetryWait } from "./claudeRetryWait.ts";

const retry = (attempt: number, retry_delay_ms: number, error_status: number | null = 429) => ({
  attempt,
  retry_delay_ms,
  error_status,
});

describe("describeClaudeRetryWait", () => {
  it("names a long 429 wait as a remaining wait", () => {
    assert.deepEqual(describeClaudeRetryWait(retry(1, 90 * 60_000)), {
      key: "retry-wait:1",
      text: "Claude is rate limited. This turn is paused and retries in 1h 30m.",
    });
    assert.strictEqual(
      describeClaudeRetryWait(retry(1, 76_000))?.text,
      "Claude is rate limited. This turn is paused and retries in 2m.",
    );
  });

  it("keys every heartbeat of one wait alike and a later wait apart", () => {
    // Heartbeats count the same wait down; the next 429 starts a new attempt.
    assert.strictEqual(
      describeClaudeRetryWait(retry(1, 5_400_000))?.key,
      describeClaudeRetryWait(retry(1, 5_370_000))?.key,
    );
    assert.notStrictEqual(
      describeClaudeRetryWait(retry(1, 5_400_000))?.key,
      describeClaudeRetryWait(retry(2, 5_400_000))?.key,
    );
  });

  it("stays quiet for ordinary backoff and for other errors", () => {
    assert.isUndefined(describeClaudeRetryWait(retry(1, 16_000)));
    assert.isUndefined(describeClaudeRetryWait(retry(1, 5 * 60_000, 529)));
    assert.isUndefined(describeClaudeRetryWait(retry(1, 5 * 60_000, null)));
  });
});
