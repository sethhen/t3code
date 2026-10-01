/**
 * Pool status for one environment: the latest `status`, polled in the
 * background, plus mutations that answer with a fresh status and show it at
 * once. Responses are sequence-gated so a poll that started before a mutation
 * can never overwrite the status the mutation returned.
 */
import type { PoolExtension, PoolStatus } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";

import type { ExtensionCallOutcome, ExtensionClient } from "../client";
import { isPoolUnsupported } from "./pool.logic";

export type PoolClient = ExtensionClient<(typeof PoolExtension)["methods"]>;
type StatusOutcome = ExtensionCallOutcome<PoolStatus>;

export interface PoolStatusState {
  readonly status: PoolStatus | null;
  /** The last read failed; `status`, when present, is from before it. */
  readonly error: string | null;
  /** This environment has no pool, or this session may not read it: the section steps aside. */
  readonly unsupported: boolean;
}

const INITIAL: PoolStatusState = { status: null, error: null, unsupported: false };

export function usePoolStatus(client: PoolClient, readOnly: boolean) {
  const [state, setState] = useState<PoolStatusState>(INITIAL);
  const sequence = useRef(0);
  const applied = useRef(0);

  const accept = useCallback((id: number, status: PoolStatus) => {
    if (id < applied.current) return;
    applied.current = id;
    setState({ status, error: null, unsupported: false });
  }, []);

  const refresh = useCallback(async () => {
    const id = ++sequence.current;
    const outcome = await client.call("status", {});
    if (outcome.ok) {
      accept(id, outcome.value);
      return;
    }
    if (id < applied.current) return;
    // Before the first answer a failure may mean "no pool here" (or, read-only,
    // no permission to ask); after it, keep the last status up with the error.
    setState((previous) =>
      previous.status !== null
        ? { ...previous, error: outcome.message }
        : {
            ...previous,
            error: outcome.message,
            unsupported: readOnly || isPoolUnsupported(outcome.message),
          },
    );
  }, [accept, client, readOnly]);

  /** Runs a mutation that answers with the new status; shows it unless something newer landed. */
  const apply = useCallback(
    async (call: () => Promise<StatusOutcome>): Promise<StatusOutcome> => {
      const id = ++sequence.current;
      const outcome = await call();
      if (outcome.ok) accept(id, outcome.value);
      return outcome;
    },
    [accept],
  );

  return { ...state, refresh, apply };
}

/**
 * Calls `refresh` now and then every `delay` ms until unmounted, skipping
 * ticks while the page is hidden. `null` stops polling. A new delay restarts
 * the loop, so switching to the fast cadence takes effect at once.
 */
export function usePolling(refresh: () => Promise<void>, delay: number | null) {
  useEffect(() => {
    if (delay === null) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (!document.hidden) await refresh();
      if (!cancelled) timer = window.setTimeout(tick, delay);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refresh, delay]);
}

export interface PoolActions {
  /** True while the key's call runs. */
  readonly isBusy: (key: string) => boolean;
  /** The value the key's running call is heading to, for optimistic controls. */
  readonly intent: (key: string) => unknown;
  /**
   * Runs a status-returning call unless the key is already running. Failures
   * toast under `failure`; pass null to handle the returned outcome inline.
   */
  readonly run: (
    key: string,
    call: () => Promise<StatusOutcome>,
    failure: string | null,
    intent?: unknown,
  ) => Promise<StatusOutcome | null>;
}

export function usePoolActions(
  apply: (call: () => Promise<StatusOutcome>) => Promise<StatusOutcome>,
) {
  const [running, setRunning] = useState<ReadonlyMap<string, unknown>>(() => new Map());
  const inFlight = useRef(new Set<string>());

  const run = useCallback<PoolActions["run"]>(
    async (key, call, failure, intent) => {
      if (inFlight.current.has(key)) return null;
      inFlight.current.add(key);
      setRunning((previous) => new Map(previous).set(key, intent));
      const outcome = await apply(call);
      inFlight.current.delete(key);
      setRunning((previous) => {
        const next = new Map(previous);
        next.delete(key);
        return next;
      });
      if (!outcome.ok && failure !== null) {
        toastManager.add({ type: "error", title: failure, description: outcome.message });
      }
      return outcome;
    },
    [apply],
  );

  return {
    isBusy: (key: string) => running.has(key),
    intent: (key: string) => running.get(key),
    run,
  } satisfies PoolActions;
}
