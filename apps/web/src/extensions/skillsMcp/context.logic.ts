/**
 * Pure helpers for context cost: token formatting, the per-app "new thread"
 * summary behind the footer bars, and each MCP server's cost joined onto its
 * row by name.
 */
import type {
  AgentApp,
  AppContext,
  ContextCategory,
  ContextOverview,
  McpServerRow,
} from "@t3tools/contracts";

import { APP_LABEL, APPS } from "./lists.logic";

/** 850, 3.2k, 38k, 1.2M. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 1000)
    return String(Math.max(0, Math.round(tokens || 0)));
  const short = (value: number, digits: number) => value.toFixed(digits).replace(/\.0$/, "");
  if (tokens < 9_950) return `${short(tokens / 1000, 1)}k`;
  if (tokens < 999_500) return `${Math.round(tokens / 1000)}k`;
  return `${short(tokens / 1_000_000, 1)}M`;
}

const exactNumber = (value: number) => Math.round(value).toLocaleString("en-US");

// ---------------------------------------------------------------------------
// Per-app summary

export interface ContextSummary {
  readonly app: AgentApp;
  readonly model?: string;
  /** What an estimate leaves out, from the server. */
  readonly note?: string;
  /** "~32k / 1M". */
  readonly label: string;
  /** Share of the window a new thread starts with, 0 to 1. */
  readonly share: number;
  /** What the baseline is made of, largest first; tools loaded on demand included. */
  readonly categories: readonly ContextCategory[];
  readonly memoryFiles: AppContext["memoryFiles"];
  readonly error?: string;
}

export function contextSummary(app: AgentApp, context: AppContext): ContextSummary {
  const window = context.windowTokens && context.windowTokens > 0 ? context.windowTokens : null;
  const baseline = context.baselineTokens;
  return {
    app,
    ...(context.model ? { model: context.model } : {}),
    ...(context.note ? { note: context.note } : {}),
    label: `${context.exact ? "" : "~"}${formatTokens(baseline)}${window ? ` / ${formatTokens(window)}` : ""}`,
    share: window ? Math.min(1, Math.max(0, baseline / window)) : 0,
    categories: context.categories
      .filter(
        (category) =>
          (category.kind === "used" || category.kind === "deferred") && category.tokens > 0,
      )
      .toSorted((left, right) => right.tokens - left.tokens),
    memoryFiles: context.memoryFiles,
    ...(context.error ? { error: context.error } : {}),
  };
}

export function contextSummaries(overview: ContextOverview | null): ContextSummary[] {
  if (!overview) return [];
  return APPS.flatMap((app) => {
    const context = overview.apps[app];
    return context ? [contextSummary(app, context)] : [];
  });
}

// ---------------------------------------------------------------------------
// MCP server cost

/** Claude builds tool names as `mcp__<server>__<tool>` with anything outside [A-Za-z0-9_-] as `_`. */
export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
}

/** Names a server may be reported under: its own, and Claude's `plugin:<plugin>:<server>` form. */
function mcpNames(row: McpServerRow): string[] {
  const names = [row.name];
  const plugin = row.apps.claude?.scope === "plugin" ? row.apps.claude.source : undefined;
  if (plugin && !row.name.startsWith("plugin:"))
    names.push(`plugin:${plugin.split("@")[0]}:${row.name}`);
  return names;
}

/** Exact name first, then the normalized form. */
function findNamed<Item extends { readonly name: string }>(
  items: readonly Item[],
  names: readonly string[],
): Item | undefined {
  for (const name of names) {
    const exact = items.find((item) => item.name === name);
    if (exact) return exact;
  }
  const wanted = new Set(names.map(normalizeName));
  return items.find((item) => wanted.has(normalizeName(item.name)));
}

export interface AppCost {
  /** Tokens of tool definitions every request carries. */
  readonly loaded: number;
  /** Tokens kept out of the window until the agent searches for the tools. */
  readonly deferred: number;
  /** False for a local estimate. */
  readonly exact: boolean;
}

export type McpCost = Partial<Record<AgentApp, AppCost>>;

/** Row key -> what the server costs each app it is on in. */
export function joinMcpCosts(
  rows: readonly McpServerRow[],
  overview: ContextOverview | null,
): ReadonlyMap<string, McpCost> {
  const costs = new Map<string, McpCost>();
  for (const row of rows) {
    const cost: McpCost = {};
    for (const app of APPS) {
      const context = overview?.apps[app];
      const entry = row.apps[app];
      if (!context || context.error || !entry?.present || !entry.enabled) continue;
      const found = findNamed(context.mcpServers, mcpNames(row));
      if (found) {
        cost[app] = {
          loaded: found.loadedTokens,
          deferred: found.deferredTokens,
          exact: context.exact,
        };
      }
    }
    if (Object.keys(cost).length > 0) costs.set(row.key, cost);
  }
  return costs;
}

/**
 * "44k tok": the most any app pays up front for the server in every thread,
 * with each app's numbers in the hint. Null when it costs nothing up front
 * (Claude's tool search keeps most servers out of the window).
 */
export function mcpCostChip(
  cost: McpCost | undefined,
): { readonly text: string; readonly hint: string } | null {
  if (!cost) return null;
  const apps = APPS.filter((app) => cost[app] !== undefined);
  const most = Math.max(0, ...apps.map((app) => cost[app]?.loaded ?? 0));
  if (most === 0) return null;
  const hint = apps.map((app) => {
    const { loaded, deferred, exact } = cost[app]!;
    const upFront =
      loaded > 0
        ? `${exact ? "" : "~"}${exactNumber(loaded)} tokens in every thread`
        : "none up front";
    const onDemand = deferred > 0 ? `, ~${formatTokens(deferred)} loaded on demand` : "";
    return `${APP_LABEL[app]}: ${upFront}${onDemand}`;
  });
  return { text: `${formatTokens(most)} tok`, hint: hint.join("\n") };
}
