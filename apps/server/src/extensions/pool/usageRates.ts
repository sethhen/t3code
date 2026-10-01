// @effect-diagnostics globalDate:off - the pool's process manager is plain async Node by design; Effect wraps it at the layer and handler boundary.
// @effect-diagnostics nodeBuiltinImport:off - reads upstream's rate snapshot with plain Node.
/**
 * Model rates for the pool's usage report: the same LiteLLM table the Usage
 * page prices against, read from the snapshot upstream's `UsageService` keeps
 * at `<stateDir>/usage-model-rates.json`. The pool never fetches rates itself;
 * when the snapshot is missing or a day old it asks the caller's `refresh`
 * (the Usage page's own refetch), which rewrites the file.
 */
import * as NodeFSP from "node:fs/promises";

import type { UsagePricing } from "@t3tools/contracts";

import { parseRateTable, type RateTable } from "./t3.ts";

/** Upstream's source, shown with the figures (`LITELLM_RATES_URL` in `UsageService.ts`). */
const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Upstream's TTL: a day-old table is still used, but labelled `cached`. */
const RATES_TTL_MS = 24 * 60 * 60_000;

/** Offline, a refresh fails every time; don't hold up every report waiting for it. */
const REFRESH_INTERVAL_MS = 10 * 60_000;

export interface UsageRatesOptions {
  /** Upstream's rate snapshot: `{ fetchedAtMs, document }` with the LiteLLM JSON. */
  readonly cachePath: string;
  /** Refetches the table and rewrites `cachePath`. Errors are ignored. */
  readonly refresh?: () => Promise<void>;
  readonly now?: () => number;
}

export interface UsageRates {
  /** The current table (empty when there is none) and how good it is. */
  readonly read: () => Promise<{ rates: RateTable; pricing: UsagePricing }>;
}

interface Snapshot {
  readonly mtimeMs: number;
  readonly size: number;
  /** Null when the file didn't parse or priced nothing. */
  readonly table: { readonly rates: RateTable; readonly fetchedAtMs: number } | null;
}

const EMPTY_RATES: RateTable = new Map();

export const createUsageRates = (options: UsageRatesOptions): UsageRates => {
  const now = options.now ?? Date.now;
  let snapshot: Snapshot | null = null;
  let lastRefreshAt = Number.NEGATIVE_INFINITY;
  let refreshing: Promise<void> | null = null;

  /** The file's table, parsed again only when the file changed (it is ~2 MB). */
  const load = async (): Promise<Snapshot["table"]> => {
    let stat: { mtimeMs: number; size: number };
    try {
      stat = await NodeFSP.stat(options.cachePath);
    } catch {
      snapshot = null;
      return null;
    }
    if (snapshot !== null && snapshot.mtimeMs === stat.mtimeMs && snapshot.size === stat.size) {
      return snapshot.table;
    }
    let table: Snapshot["table"] = null;
    try {
      const file: unknown = JSON.parse(await NodeFSP.readFile(options.cachePath, "utf8"));
      if (typeof file === "object" && file !== null) {
        const { fetchedAtMs, document } = file as { fetchedAtMs?: unknown; document?: unknown };
        const rates = parseRateTable(document);
        if (typeof fetchedAtMs === "number" && Number.isFinite(fetchedAtMs) && rates.size > 0) {
          table = { rates, fetchedAtMs };
        }
      }
    } catch {
      // Missing between stat and read, or caught mid-write (upstream doesn't
      // write atomically): no table this time, the next read tries again.
    }
    snapshot = { mtimeMs: stat.mtimeMs, size: stat.size, table };
    return table;
  };

  /** One refresh at a time; concurrent reads wait for the same one. */
  const refresh = (run: () => Promise<void>): Promise<void> => {
    if (refreshing === null) {
      lastRefreshAt = now();
      const attempt = async () => {
        try {
          await run();
        } catch {
          // The stale table (or none) stands until the next attempt.
        }
      };
      // `finally` runs on a later tick, so even a synchronous throw clears the slot.
      refreshing = attempt().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  };

  const read = async () => {
    let table = await load();
    const stale = table === null || now() - table.fetchedAtMs >= RATES_TTL_MS;
    if (stale && options.refresh !== undefined) {
      if (refreshing !== null || now() - lastRefreshAt >= REFRESH_INTERVAL_MS) {
        await refresh(options.refresh);
        table = await load();
      }
    }
    const pricing: UsagePricing = {
      status:
        table === null
          ? "unavailable"
          : now() - table.fetchedAtMs < RATES_TTL_MS
            ? "fresh"
            : "cached",
      source: LITELLM_RATES_URL,
      fetchedAt: table === null ? null : new Date(table.fetchedAtMs).toISOString(),
      knownModels: table?.rates.size ?? 0,
    };
    return { rates: table?.rates ?? EMPTY_RATES, pricing };
  };

  return { read };
};
