/**
 * The panel loaders and the store behind them. The panel unmounts whenever it
 * is closed or another surface is picked, so each loader's last result is kept
 * here, outside the component: reopening shows the previous lists at once
 * while they refresh in the background. Keys carry the loader name and scope;
 * each key has its own listeners, so a write re-renders only the loader
 * showing it. Entries nobody shows are dropped oldest-first past a small cap.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { ExtensionCallOutcome } from "../client";

export interface OverviewEntry {
  readonly data: unknown;
  readonly error: string | null;
  readonly loadedAt: number | null;
  /** The request in flight, if any; a newer request supersedes it. */
  readonly request: number | null;
}

const EMPTY: OverviewEntry = { data: null, error: null, loadedAt: null, request: null };
const MAX_ENTRIES = 16;

const entries = new Map<string, OverviewEntry>();
const listeners = new Map<string, Set<() => void>>();
let lastRequest = 0;

export const readOverview = (key: string): OverviewEntry => entries.get(key) ?? EMPTY;

export function subscribeOverview(key: string, listener: () => void): () => void {
  let watching = listeners.get(key);
  if (!watching) {
    watching = new Set();
    listeners.set(key, watching);
  }
  watching.add(listener);
  return () => {
    watching.delete(listener);
    if (watching.size === 0 && listeners.get(key) === watching) listeners.delete(key);
  };
}

function write(key: string, entry: OverviewEntry) {
  // Re-inserting keeps the map in least-recently-written order.
  entries.delete(key);
  entries.set(key, entry);
  const watching = listeners.get(key);
  if (watching) for (const listener of watching) listener();
}

/**
 * Drops the oldest unwatched entries past the cap. Runs only when a load
 * settles: a load starts in a mount effect, possibly before the panel's other
 * loaders have subscribed to the entries they are about to show.
 */
function sweep() {
  for (const oldest of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) return;
    if (!listeners.has(oldest)) entries.delete(oldest);
  }
}

/**
 * Fetches into `key`. The previous data stays up meanwhile; the response is
 * dropped if a newer load for the key started (or the entry was dropped).
 */
export async function loadOverview(
  key: string,
  fetch: () => Promise<ExtensionCallOutcome<unknown>>,
): Promise<void> {
  const request = ++lastRequest;
  write(key, { ...readOverview(key), request });
  const outcome = await fetch();
  const current = entries.get(key);
  if (current?.request !== request) return;
  write(
    key,
    outcome.ok
      ? { data: outcome.value, error: null, loadedAt: Date.now(), request: null }
      : { data: current.data, error: outcome.message, loadedAt: Date.now(), request: null },
  );
  sweep();
}

/** Exported for tests. */
export function resetOverviews() {
  entries.clear();
  listeners.clear();
}

export interface OverviewState<Value> {
  readonly data: Value | null;
  readonly error: string | null;
  readonly loading: boolean;
  /** Reload now. Superseded responses are dropped; old data stays visible meanwhile. */
  readonly reload: (refresh?: boolean) => Promise<void>;
}

/**
 * Shows the last result stored for `name` and `key` from the moment the loader
 * is `active` (panel visible and tab selected), and loads while active: once
 * per mount and key, then again when the last load is older than `staleMs`.
 * Never fetches while inactive, except for explicit `reload` calls.
 */
export function useOverviewLoader<Value>(options: {
  /** The loader's own name; with `key` it names the stored result. */
  readonly name: string;
  readonly active: boolean;
  readonly key: string;
  readonly fetch: (refresh: boolean) => Promise<ExtensionCallOutcome<Value>>;
  readonly staleMs?: number;
}): OverviewState<Value> {
  const { active, staleMs = 15_000 } = options;
  const key = `${options.name}|${options.key}`;
  const latest = useRef({ fetch: options.fetch, key });
  // The key this mount last fetched; a new mount always fetches, so it never
  // settles for a result from before (MCP sign-in relies on that).
  const fetchedKey = useRef<string | null>(null);
  // A closed panel's late reloads (a mutation that finished after it closed)
  // must not overwrite what a reopened panel shows.
  const mounted = useRef(false);
  // An error stored before this mount is not shown; its own load decides.
  const [mountedAt] = useState(Date.now);

  useLayoutEffect(() => {
    latest.current = { fetch: options.fetch, key };
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const subscribe = useCallback((listener: () => void) => subscribeOverview(key, listener), [key]);
  const entry = useSyncExternalStore(subscribe, () => readOverview(key));

  const reload = useCallback((refresh = false) => {
    if (!mounted.current) return Promise.resolve();
    const { fetch, key: requestKey } = latest.current;
    return loadOverview(requestKey, () => fetch(refresh));
  }, []);

  // Stored results show only once this mount asked for them, so hidden tabs
  // stay light and nothing old (usage) shows before its refresh starts.
  const [shownKey, setShownKey] = useState<string | null>(null);
  if (active && shownKey !== key) setShownKey(key);
  const shown = active || shownKey === key;

  useEffect(() => {
    if (!active) return;
    const { request, loadedAt } = readOverview(key);
    const fresh =
      fetchedKey.current === key &&
      (request !== null || (loadedAt !== null && Date.now() - loadedAt <= staleMs));
    if (fresh) return;
    fetchedKey.current = key;
    void reload();
    // Re-evaluated when the panel becomes visible or the key changes.
  }, [active, key]);

  const settledHere = entry.loadedAt !== null && entry.loadedAt >= mountedAt;
  return {
    // The stored value under this loader's own name has its type.
    data: shown ? (entry.data as Value | null) : null,
    error: shown && settledHere ? entry.error : null,
    loading: shown && (entry.request !== null || entry.loadedAt === null),
    reload,
  };
}
