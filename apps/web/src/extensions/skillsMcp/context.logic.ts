/**
 * Pure helpers for context cost and usage: token formatting, the per-app
 * "new thread" summary, joining `context.get` / `usage.get` results onto MCP
 * and skill rows by name, and the cost/usage sorts and "Unused" filter.
 */
import type {
  AgentApp,
  AppContext,
  AppUsage,
  ContextCategory,
  ContextOverview,
  McpContextCost,
  McpServerRow,
  SkillRow,
  UsageReport,
} from "@t3tools/contracts";

import { APP_LABEL, compareNames } from "./lists.logic";

const APPS = ["claude", "codex"] as const satisfies readonly AgentApp[];

// ---------------------------------------------------------------------------
// Formatting

/** 850, 3.2k, 38k, 1.2M. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 1000)
    return String(Math.max(0, Math.round(tokens || 0)));
  const short = (value: number, digits: number) => value.toFixed(digits).replace(/\.0$/, "");
  if (tokens < 9_950) return `${short(tokens / 1000, 1)}k`;
  if (tokens < 999_500) return `${Math.round(tokens / 1000)}k`;
  return `${short(tokens / 1_000_000, 1)}M`;
}

/** "14 calls", "1 call". */
export function formatCalls(calls: number): string {
  return `${calls} ${calls === 1 ? "call" : "calls"}`;
}

// ---------------------------------------------------------------------------
// Per-app summary

export interface ContextSegment {
  readonly name: string;
  readonly tokens: number;
  readonly kind: "used" | "buffer";
  /** Fraction of the bar (the context window), clamped to what is left. */
  readonly share: number;
}

export interface ContextSummary {
  readonly app: AgentApp;
  readonly exact: boolean;
  readonly model?: string;
  readonly baselineTokens: number;
  readonly windowTokens?: number;
  /** "new thread 38k / 200k" (a leading ~ for estimates). */
  readonly label: string;
  /** Used categories then the compaction buffer; the rest of the bar is free. */
  readonly segments: readonly ContextSegment[];
  /** Everything reported, including free space and deferred tools, for the breakdown list. */
  readonly categories: readonly ContextCategory[];
  readonly deferredTokens: number;
  readonly memoryFiles: AppContext["memoryFiles"];
  readonly error?: string;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

export function contextSummary(app: AgentApp, context: AppContext): ContextSummary {
  const inWindow = context.categories.filter((category) => category.kind !== "deferred");
  const total =
    context.windowTokens && context.windowTokens > 0
      ? context.windowTokens
      : Math.max(sum(inWindow.map((category) => category.tokens)), context.baselineTokens, 1);
  let left = 1;
  const segments: ContextSegment[] = [];
  for (const kind of ["used", "buffer"] as const) {
    for (const category of context.categories) {
      if (category.kind !== kind || !(category.tokens > 0)) continue;
      const share = Math.min(left, category.tokens / total);
      left -= share;
      segments.push({ name: category.name, tokens: category.tokens, kind, share });
    }
  }
  const approx = context.exact ? "" : "~";
  const window = context.windowTokens ? ` / ${formatTokens(context.windowTokens)}` : "";
  return {
    app,
    exact: context.exact,
    ...(context.model ? { model: context.model } : {}),
    baselineTokens: context.baselineTokens,
    ...(context.windowTokens ? { windowTokens: context.windowTokens } : {}),
    label: `new thread ${approx}${formatTokens(context.baselineTokens)}${window}`,
    segments,
    categories: context.categories,
    deferredTokens: sum(
      context.categories.filter((category) => category.kind === "deferred").map((c) => c.tokens),
    ),
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
// Name joins

/** Claude builds tool names as `mcp__<server>__<tool>` with anything outside [A-Za-z0-9_-] as `_`. */
export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
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

/** `mcp__github__create_issue` -> `create_issue` (for `github`); bare names pass through. */
export function bareToolName(toolName: string, serverName: string): string {
  const prefix = `mcp__${normalizeName(serverName)}__`;
  if (toolName.toLowerCase().startsWith(prefix)) return toolName.slice(prefix.length);
  if (toolName.startsWith("mcp__")) {
    const split = toolName.indexOf("__", 5);
    if (split > 5) return toolName.slice(split + 2);
  }
  return toolName;
}

/** Names a server may be reported under: its own, and Claude's `plugin:<plugin>:<server>` form. */
function mcpNames(row: McpServerRow): string[] {
  const names = [row.name];
  const plugin = row.apps.claude?.scope === "plugin" ? row.apps.claude.source : undefined;
  if (plugin && !row.name.startsWith("plugin:"))
    names.push(`plugin:${plugin.split("@")[0]}:${row.name}`);
  return names;
}

/** Names a skill may be reported under: its own, and `<plugin>:<skill>` for plugin skills. */
function skillNames(row: SkillRow): string[] {
  const names = [row.name];
  if (row.pluginId && !row.name.includes(":"))
    names.push(`${row.pluginId.split("@")[0]}:${row.name}`);
  return names;
}

// ---------------------------------------------------------------------------
// Row stats

export interface ToolStat {
  readonly tokens?: number;
  readonly loaded?: boolean;
  readonly calls?: number;
}

/** Context cost and usage joined onto one row. Unknown parts stay undefined. */
export interface RowStats {
  /** Tokens sent with every request: the largest across apps (a thread runs in one app). */
  readonly tokens?: number;
  /** Tokens kept out of the window until searched for (MCP tool search). */
  readonly deferredTokens?: number;
  /** False when any contributing app only estimated. */
  readonly exact?: boolean;
  readonly perAppTokens?: Partial<
    Record<AgentApp, { readonly loaded: number; readonly deferred: number }>
  >;
  /** Calls in the usage window, summed over apps whose scan worked. */
  readonly calls?: number;
  readonly perAppCalls?: Partial<Record<AgentApp, number>>;
  readonly lastUsedAt?: string;
  /** Per bare tool name (MCP only). */
  readonly tools?: ReadonlyMap<string, ToolStat>;
}

const EMPTY_STATS: RowStats = {};

function usableContext(overview: ContextOverview | null, app: AgentApp): AppContext | undefined {
  const context = overview?.apps[app];
  return context && !context.error ? context : undefined;
}

function usableUsage(report: UsageReport | null, app: AgentApp): AppUsage | undefined {
  const usage = report?.apps[app];
  return usage && !usage.error ? usage : undefined;
}

function later(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function mergeTool(tools: Map<string, ToolStat>, name: string, patch: ToolStat) {
  const previous = tools.get(name) ?? {};
  tools.set(name, {
    ...previous,
    ...(patch.tokens !== undefined
      ? {
          tokens: Math.max(previous.tokens ?? 0, patch.tokens),
          loaded: patch.loaded ?? previous.loaded,
        }
      : {}),
    ...(patch.calls !== undefined ? { calls: (previous.calls ?? 0) + patch.calls } : {}),
  });
}

function mcpRowStats(
  row: McpServerRow,
  context: ContextOverview | null,
  usage: UsageReport | null,
): RowStats {
  const names = mcpNames(row);
  const tools = new Map<string, ToolStat>();
  const perAppTokens: Partial<Record<AgentApp, { loaded: number; deferred: number }>> = {};
  const perAppCalls: Partial<Record<AgentApp, number>> = {};
  let exact = true;
  let lastUsedAt: string | undefined;
  let costs = 0;
  let scans = 0;

  for (const app of APPS) {
    const appContext = usableContext(context, app);
    if (appContext && row.apps[app]) {
      const cost: McpContextCost | undefined = findNamed(appContext.mcpServers, names);
      if (cost) {
        costs += 1;
        exact &&= appContext.exact;
        perAppTokens[app] = { loaded: cost.loadedTokens, deferred: cost.deferredTokens };
        for (const tool of cost.tools) {
          mergeTool(tools, bareToolName(tool.name, cost.name), {
            tokens: tool.tokens,
            loaded: tool.loaded,
          });
        }
      }
    }
    const appUsage = usableUsage(usage, app);
    if (appUsage) {
      scans += 1;
      const used = findNamed(appUsage.mcpServers, names);
      perAppCalls[app] = used?.calls ?? 0;
      if (used) {
        lastUsedAt = later(lastUsedAt, used.lastUsedAt);
        for (const tool of used.tools) {
          mergeTool(tools, bareToolName(tool.name, used.name), { calls: tool.calls });
        }
      }
    }
  }

  const loaded = Object.values(perAppTokens);
  return {
    ...(costs > 0
      ? {
          tokens: Math.max(...loaded.map((cost) => cost.loaded)),
          deferredTokens: Math.max(...loaded.map((cost) => cost.deferred)),
          exact,
          perAppTokens,
        }
      : {}),
    ...(scans > 0 ? { calls: sum(Object.values(perAppCalls)), perAppCalls } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {}),
    ...(tools.size > 0 ? { tools } : {}),
  };
}

function skillRowStats(
  row: SkillRow,
  context: ContextOverview | null,
  usage: UsageReport | null,
): RowStats {
  const names = skillNames(row);
  const perAppTokens: Partial<Record<AgentApp, { loaded: number; deferred: number }>> = {};
  const perAppCalls: Partial<Record<AgentApp, number>> = {};
  let exact = true;
  let lastUsedAt: string | undefined;
  for (const app of APPS) {
    const appContext = usableContext(context, app);
    const cost = appContext && row.apps[app] ? findNamed(appContext.skills, names) : undefined;
    if (appContext && cost) {
      exact &&= appContext.exact;
      perAppTokens[app] = { loaded: cost.tokens, deferred: 0 };
    }
    const appUsage = usableUsage(usage, app);
    if (appUsage) {
      const used = findNamed(appUsage.skills, names);
      perAppCalls[app] = used?.calls ?? 0;
      lastUsedAt = later(lastUsedAt, used?.lastUsedAt);
    }
  }
  const loaded = Object.values(perAppTokens);
  const scanned = Object.values(perAppCalls);
  return {
    ...(loaded.length > 0
      ? { tokens: Math.max(...loaded.map((cost) => cost.loaded)), exact, perAppTokens }
      : {}),
    ...(scanned.length > 0 ? { calls: sum(scanned), perAppCalls } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {}),
  };
}

function joinRows<Row extends { readonly key: string }>(
  rows: readonly Row[],
  stats: (row: Row) => RowStats,
): ReadonlyMap<string, RowStats> {
  const joined = new Map<string, RowStats>();
  for (const row of rows) {
    const value = stats(row);
    joined.set(row.key, Object.keys(value).length > 0 ? value : EMPTY_STATS);
  }
  return joined;
}

/** Row key -> joined stats. Compute over all rows (not the filtered ones) so rows keep stable props. */
export function joinMcpStats(
  rows: readonly McpServerRow[],
  context: ContextOverview | null,
  usage: UsageReport | null,
): ReadonlyMap<string, RowStats> {
  return joinRows(rows, (row) => mcpRowStats(row, context, usage));
}

export function joinSkillStats(
  rows: readonly SkillRow[],
  context: ContextOverview | null,
  usage: UsageReport | null,
): ReadonlyMap<string, RowStats> {
  return joinRows(rows, (row) => skillRowStats(row, context, usage));
}

export function statsFor(stats: ReadonlyMap<string, RowStats>, key: string): RowStats {
  return stats.get(key) ?? EMPTY_STATS;
}

// ---------------------------------------------------------------------------
// Chips

/** "3.2k tok" (or "~3.2k tok" for estimates); null when unknown. */
export function tokenChip(stats: RowStats): string | null {
  if (stats.tokens === undefined) return null;
  return `${stats.exact === false ? "~" : ""}${formatTokens(stats.tokens)} tok`;
}

/** "+1.1k deferred" when tool search keeps some definitions out of the window. */
export function deferredChip(stats: RowStats): string | null {
  if (!stats.deferredTokens) return null;
  return `+${formatTokens(stats.deferredTokens)} deferred`;
}

/** "14 calls · 7d"; null until usage is loaded. */
export function usageChip(stats: RowStats, days: number): string | null {
  if (stats.calls === undefined) return null;
  return `${formatCalls(stats.calls)} · ${days}d`;
}

/** Tooltip text: per-app tokens and calls. */
export function statsDetail(stats: RowStats, days: number): string[] {
  const lines: string[] = [];
  for (const app of APPS) {
    const cost = stats.perAppTokens?.[app];
    const calls = stats.perAppCalls?.[app];
    const parts: string[] = [];
    if (cost) {
      parts.push(`${formatTokens(cost.loaded)} tok per request`);
      if (cost.deferred > 0) parts.push(`${formatTokens(cost.deferred)} deferred`);
    }
    if (calls !== undefined) parts.push(`${formatCalls(calls)} in ${days}d`);
    if (parts.length > 0) lines.push(`${APP_LABEL[app]}: ${parts.join(", ")}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Sorts and the Unused filter

export type SortMode = "status" | "name" | "context" | "usage";

export const SORT_LABEL: Readonly<Record<SortMode, string>> = {
  status: "Status",
  name: "Name",
  context: "Context cost",
  usage: "Usage",
};

/** Whether this sort or filter needs `usage.get`. */
export function needsUsage(sort: SortMode, unusedOnly: boolean): boolean {
  return sort === "usage" || unusedOnly;
}

const descending = (left: number | undefined, right: number | undefined): number =>
  (right ?? -1) - (left ?? -1);

/**
 * Flat order for the name / context / usage sorts (the status sort keeps its
 * sections). Unknown values sink to the bottom.
 */
export function sortRowsBy<Row extends { readonly key: string; readonly name: string }>(
  rows: readonly Row[],
  mode: Exclude<SortMode, "status">,
  stats: ReadonlyMap<string, RowStats>,
): Row[] {
  const of = (row: Row) => statsFor(stats, row.key);
  return [...rows].sort((left, right) => {
    const a = of(left);
    const b = of(right);
    const byName = compareNames(left.name, right.name);
    if (mode === "context") {
      return (
        descending(a.tokens, b.tokens) || descending(a.deferredTokens, b.deferredTokens) || byName
      );
    }
    if (mode === "usage")
      return descending(a.calls, b.calls) || descending(a.tokens, b.tokens) || byName;
    return byName;
  });
}

/** Switched on for at least one app. */
export function mcpIsOn(row: McpServerRow): boolean {
  return APPS.some((app) => {
    const entry = row.apps[app];
    return entry !== undefined && entry.enabled && entry.status !== "disabled";
  });
}

export function skillIsOn(row: SkillRow): boolean {
  return APPS.some((app) => row.apps[app]?.enabled === true);
}

/** On somewhere, and usage says zero calls. False while usage is unknown. */
export function isUnused(on: boolean, stats: RowStats): boolean {
  return on && stats.calls === 0;
}

/** Tokens the unused rows cost a new thread (largest app per row), for the filter summary. */
export function unusedTokens(
  rows: readonly { readonly key: string }[],
  stats: ReadonlyMap<string, RowStats>,
): number {
  return sum(rows.map((row) => statsFor(stats, row.key).tokens ?? 0));
}

/** "Scanned 412 sessions" style footnote for the usage window. */
export function usageFootnote(report: UsageReport): string {
  const sessions = sum(APPS.map((app) => report.apps[app].sessions));
  const failed = APPS.filter((app) => report.apps[app].error).map((app) => APP_LABEL[app]);
  const base = `${sessions} ${sessions === 1 ? "session" : "sessions"} in ${report.days}d`;
  return failed.length > 0 ? `${base}; ${failed.join(" and ")} could not be scanned` : base;
}
