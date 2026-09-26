/**
 * The last result of each panel loader, kept across panel mounts: the panel
 * unmounts whenever it is closed or another surface is picked, and reopening
 * should show the previous lists at once while it refreshes in the background.
 * Keys carry the loader name and scope; each key has its own listeners, so a
 * write re-renders only the loader showing it. Entries nobody shows are
 * dropped oldest-first past a small cap.
 */
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
  for (const oldest of entries.keys()) {
    if (entries.size <= MAX_ENTRIES) break;
    if (!listeners.has(oldest)) entries.delete(oldest);
  }
  const watching = listeners.get(key);
  if (watching) for (const listener of watching) listener();
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
}

/** Exported for tests. */
export function resetOverviews() {
  entries.clear();
  listeners.clear();
}
