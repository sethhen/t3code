/**
 * The work-log row for a long rate-limit wait inside a Claude turn.
 *
 * Pooled sessions run with `CLAUDE_CODE_RETRY_WATCHDOG` (see pool/overlay.ts),
 * so when every account is cooling down Claude Code sleeps until the proxy's
 * `Retry-After` instead of failing the turn. It reports the wait only as an
 * `api_retry` heartbeat every 30s, all with the same `attempt`, which the
 * adapter keeps quiet. Without a row the thread just shows as running, possibly
 * for hours. The host edit in ClaudeAdapter.ts posts this row once per `key`.
 */
import type { SDKAPIRetryMessage } from "@anthropic-ai/claude-agent-sdk";

/** Shorter retries are ordinary backoff and stay silent. */
const LONG_WAIT_MS = 60_000;

/** The row for a long 429 wait and its once-per-wait key, or `undefined` for anything else. */
export const describeClaudeRetryWait = (
  message: Pick<SDKAPIRetryMessage, "attempt" | "retry_delay_ms" | "error_status">,
): { readonly key: string; readonly text: string } | undefined => {
  if (message.error_status !== 429 || !(message.retry_delay_ms >= LONG_WAIT_MS)) return undefined;
  return {
    key: `retry-wait:${message.attempt}`,
    text: `Claude is rate limited. This turn is paused and retries in ${formatWait(message.retry_delay_ms)}.`,
  };
};

/** A wait, not a wall clock, like the usage-limit row: clients read it in other timezones. */
const formatWait = (waitMs: number): string => {
  const totalMinutes = Math.ceil(waitMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${totalMinutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
};
