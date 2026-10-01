/**
 * What each pool account served over a range, polled while something shows it.
 * The server aggregates; this only asks for a range in the browser's zone and
 * keeps the last answer up while a newer one loads or fails.
 */
import type { PoolUsage, PoolUsageRange } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import { usePolling, type PoolClient } from "./usePoolStatus";

/** Usage moves slowly next to status; a minute keeps a dashboard honest without churn. */
export const POOL_USAGE_POLL_MS = 60_000;

export interface PoolUsageState {
  readonly usage: PoolUsage | null;
  /** The last read failed; `usage`, when present, is from before it. */
  readonly error: string | null;
  /** True until the first answer for the current range lands. */
  readonly loading: boolean;
}

export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** `range: null` turns the hook off (no calls), e.g. while a dialog is closed. */
export function usePoolUsage(
  client: PoolClient,
  range: PoolUsageRange | null,
  pollMs: number = POOL_USAGE_POLL_MS,
) {
  // Answers carry the range they were asked for: a new range starts empty, so
  // totals never mix ranges, without resetting state from an effect.
  const [answer, setAnswer] = useState<
    (Omit<PoolUsageState, "loading"> & { readonly range: PoolUsageRange }) | null
  >(null);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    if (range === null) return;
    const id = ++sequence.current;
    const outcome = await client.call("usage", { range, timeZone: browserTimeZone() });
    if (id !== sequence.current) return;
    setAnswer((previous) =>
      outcome.ok
        ? { range, usage: outcome.value, error: null }
        : {
            range,
            usage: previous?.range === range ? previous.usage : null,
            error: outcome.message,
          },
    );
  }, [client, range]);

  usePolling(refresh, range === null ? null : pollMs);

  const current = answer !== null && answer.range === range ? answer : null;
  const state: PoolUsageState = {
    usage: current?.usage ?? null,
    error: current?.error ?? null,
    loading: range !== null && current === null,
  };
  return { ...state, refresh };
}
