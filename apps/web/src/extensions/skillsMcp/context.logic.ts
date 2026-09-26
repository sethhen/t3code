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

import { APP_LABEL, APPS, compareNames, type RowSection } from "./lists.logic";

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
  /** Only part of the thread was counted (Codex: MCP tools and skills), so there is no bar or window. */
  readonly partial: boolean;
  /** What an estimate covers, from the server. */
  readonly note?: string;
  readonly model?: string;
  readonly baselineTokens: number;
  readonly windowTokens?: number;
  /** "new thread 38k / 200k", "new thread ~38k / 200k" (estimate), "~58k MCP + skills" (partial). */
  readonly label: string;
  /** Used categories then the compaction buffer; the rest of the bar is free. Empty when partial. */
  readonly segments: readonly ContextSegment[];
  /** Everything reported, including free space (not for a partial count) and deferred tools. */
  readonly categories: readonly ContextCategory[];
  readonly deferredTokens: number;
  readonly memoryFiles: AppContext["memoryFiles"];
  readonly error?: string;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

export function contextSummary(app: AgentApp, context: AppContext): ContextSummary {
  const partial = app === "codex" && !context.exact;
  const inWindow = context.categories.filter((category) => category.kind !== "deferred");
  const total =
    context.windowTokens && context.windowTokens > 0
      ? context.windowTokens
      : Math.max(sum(inWindow.map((category) => category.tokens)), context.baselineTokens, 1);
  let left = 1;
  const segments: ContextSegment[] = [];
  for (const kind of partial ? [] : (["used", "buffer"] as const)) {
    for (const category of context.categories) {
      if (category.kind !== kind || !(category.tokens > 0)) continue;
      const share = Math.min(left, category.tokens / total);
      left -= share;
      segments.push({ name: category.name, tokens: category.tokens, kind, share });
    }
  }
  const approx = context.exact ? "" : "~";
  const window = context.windowTokens && !partial ? ` / ${formatTokens(context.windowTokens)}` : "";
  return {
    app,
    partial,
    ...(context.note ? { note: context.note } : {}),
    ...(context.model ? { model: context.model } : {}),
    baselineTokens: context.baselineTokens,
    ...(context.windowTokens && !partial ? { windowTokens: context.windowTokens } : {}),
    label: partial
      ? `~${formatTokens(context.baselineTokens)} MCP + skills`
      : `new thread ${approx}${formatTokens(context.baselineTokens)}${window}`,
    segments,
    categories: partial
      ? context.categories.filter((category) => category.kind !== "free")
      : context.categories,
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

export interface AppCost {
  readonly loaded: number;
  readonly deferred: number;
  /** False for a local estimate. */
  readonly exact: boolean;
}

type PerApp<Value> = Partial<Record<AgentApp, Value>>;

/** Context cost and usage joined onto one row, per app. Unknown parts stay undefined. */
export interface RowStats {
  /** Largest per-request cost across apps; for sorting only (a thread runs in one app). */
  readonly tokens?: number;
  /** Largest deferred cost across apps; for sorting only. */
  readonly deferredTokens?: number;
  readonly perAppTokens?: PerApp<AppCost>;
  /** Calls in the usage window, summed over apps whose scan worked. */
  readonly calls?: number;
  readonly perAppCalls?: PerApp<number>;
  readonly lastUsedAt?: string;
  /** Every app the row is on in was scanned and saw zero calls. */
  readonly unused?: true;
  /** Per bare tool name, per app (MCP only). */
  readonly tools?: ReadonlyMap<string, PerApp<ToolStat>>;
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

function mergeTool(
  tools: Map<string, PerApp<ToolStat>>,
  name: string,
  app: AgentApp,
  patch: ToolStat,
) {
  const previous = tools.get(name) ?? {};
  const current = previous[app] ?? {};
  const calls = patch.calls === undefined ? {} : { calls: (current.calls ?? 0) + patch.calls };
  tools.set(name, { ...previous, [app]: { ...current, ...patch, ...calls } });
}

/** Totals, plus the unused flag, from per-app costs and calls and the apps the row is on in. */
function finishStats(
  perAppTokens: PerApp<AppCost>,
  perAppCalls: PerApp<number>,
  onApps: readonly AgentApp[],
  extra: { lastUsedAt?: string | undefined; tools?: RowStats["tools"] },
): RowStats {
  const costs = Object.values(perAppTokens);
  const scanned = Object.values(perAppCalls);
  const unused = onApps.length > 0 && onApps.every((app) => perAppCalls[app] === 0);
  return {
    ...(costs.length > 0
      ? {
          tokens: Math.max(...costs.map((cost) => cost.loaded)),
          deferredTokens: Math.max(...costs.map((cost) => cost.deferred)),
          perAppTokens,
        }
      : {}),
    ...(scanned.length > 0 ? { calls: sum(scanned), perAppCalls } : {}),
    ...(unused ? { unused } : {}),
    ...(extra.lastUsedAt ? { lastUsedAt: extra.lastUsedAt } : {}),
    ...(extra.tools && extra.tools.size > 0 ? { tools: extra.tools } : {}),
  };
}

/** Apps where the server is configured, switched on and not project-disabled. */
function mcpOnApps(row: McpServerRow): AgentApp[] {
  return APPS.filter((app) => {
    const entry = row.apps[app];
    return entry?.present === true && entry.enabled && entry.status !== "disabled";
  });
}

function mcpRowStats(
  row: McpServerRow,
  context: ContextOverview | null,
  usage: UsageReport | null,
): RowStats {
  const names = mcpNames(row);
  const tools = new Map<string, PerApp<ToolStat>>();
  const perAppTokens: PerApp<AppCost> = {};
  const perAppCalls: PerApp<number> = {};
  let lastUsedAt: string | undefined;

  for (const app of APPS) {
    const appContext = usableContext(context, app);
    const cost: McpContextCost | undefined =
      appContext && row.apps[app] ? findNamed(appContext.mcpServers, names) : undefined;
    if (appContext && cost) {
      perAppTokens[app] = {
        loaded: cost.loadedTokens,
        deferred: cost.deferredTokens,
        exact: appContext.exact,
      };
      for (const tool of cost.tools) {
        mergeTool(tools, bareToolName(tool.name, cost.name), app, {
          tokens: tool.tokens,
          loaded: tool.loaded,
        });
      }
    }
    const appUsage = usableUsage(usage, app);
    const used = appUsage ? findNamed(appUsage.mcpServers, names) : undefined;
    if (appUsage && (row.apps[app] || used)) {
      perAppCalls[app] = used?.calls ?? 0;
      lastUsedAt = later(lastUsedAt, used?.lastUsedAt);
      for (const tool of used?.tools ?? []) {
        mergeTool(tools, bareToolName(tool.name, used?.name ?? row.name), app, {
          calls: tool.calls,
        });
      }
    }
  }
  return finishStats(perAppTokens, perAppCalls, mcpOnApps(row), { lastUsedAt, tools });
}

function skillRowStats(
  row: SkillRow,
  context: ContextOverview | null,
  usage: UsageReport | null,
): RowStats {
  const names = skillNames(row);
  const perAppTokens: PerApp<AppCost> = {};
  const perAppCalls: PerApp<number> = {};
  let lastUsedAt: string | undefined;
  for (const app of APPS) {
    const appContext = usableContext(context, app);
    const cost = appContext && row.apps[app] ? findNamed(appContext.skills, names) : undefined;
    if (appContext && cost) {
      perAppTokens[app] = { loaded: cost.tokens, deferred: 0, exact: appContext.exact };
    }
    const appUsage = usableUsage(usage, app);
    const used = appUsage ? findNamed(appUsage.skills, names) : undefined;
    if (appUsage && (row.apps[app] || used)) {
      perAppCalls[app] = used?.calls ?? 0;
      lastUsedAt = later(lastUsedAt, used?.lastUsedAt);
    }
  }
  const onApps = APPS.filter((app) => row.apps[app]?.present && row.apps[app]?.enabled);
  return finishStats(perAppTokens, perAppCalls, onApps, { lastUsedAt });
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
// Chips - one number per app, never mixed

export const APP_INITIAL: Readonly<Record<AgentApp, string>> = { claude: "C", codex: "X" };

/** "C 12k · X 45k" across the shown apps (no initials when only one app shows); null when empty. */
function perAppText(
  apps: readonly AgentApp[],
  text: (app: AgentApp) => string | null | undefined,
): string | null {
  const parts = apps.flatMap((app) => {
    const value = text(app);
    if (!value) return [];
    return [apps.length > 1 ? `${APP_INITIAL[app]} ${value}` : value];
  });
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "C 12k · X 45k tok": tokens each request carries, per app. */
export function tokenChip(stats: RowStats, apps: readonly AgentApp[]): string | null {
  const text = perAppText(apps, (app) => {
    const cost = stats.perAppTokens?.[app];
    return cost ? formatTokens(cost.loaded) : null;
  });
  return text ? `${text} tok` : null;
}

/** "C +1.1k deferred" when tool search keeps definitions out of the window. */
export function deferredChip(stats: RowStats, apps: readonly AgentApp[]): string | null {
  const text = perAppText(apps, (app) => {
    const deferred = stats.perAppTokens?.[app]?.deferred ?? 0;
    return deferred > 0 ? `+${formatTokens(deferred)}` : null;
  });
  return text ? `${text} deferred` : null;
}

/** "14 calls · 7d"; null until usage is loaded. */
export function usageChip(stats: RowStats, days: number): string | null {
  if (stats.calls === undefined) return null;
  return `${formatCalls(stats.calls)} · ${days}d`;
}

/** One tool's cost and calls in the given apps: "C 1.2k tok · X 900 deferred", "C 3 calls". */
export function toolChips(
  stat: PerApp<ToolStat> | undefined,
  apps: readonly AgentApp[],
): { cost: string | null; deferredOnly: boolean; calls: string | null } {
  const costApps = apps.filter((app) => stat?.[app]?.tokens !== undefined);
  return {
    cost: perAppText(apps, (app) => {
      const tool = stat?.[app];
      if (tool?.tokens === undefined) return null;
      return `${formatTokens(tool.tokens)} ${tool.loaded === false ? "deferred" : "tok"}`;
    }),
    deferredOnly: costApps.length > 0 && costApps.every((app) => stat?.[app]?.loaded === false),
    calls: perAppText(apps, (app) => {
      const calls = stat?.[app]?.calls;
      return calls === undefined ? null : formatCalls(calls);
    }),
  };
}

const exactNumber = (value: number) => Math.round(value).toLocaleString("en-US");

/** Tooltip and detail lines with exact numbers: "Claude: ~3,214 tok per request, 1,100 deferred, 2 calls in 7d". */
export function statsDetail(stats: RowStats, days: number): string[] {
  const lines: string[] = [];
  for (const app of APPS) {
    const cost = stats.perAppTokens?.[app];
    const calls = stats.perAppCalls?.[app];
    const parts: string[] = [];
    if (cost) {
      parts.push(`${cost.exact ? "" : "~"}${exactNumber(cost.loaded)} tok per request`);
      if (cost.deferred > 0) parts.push(`${exactNumber(cost.deferred)} deferred`);
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
 * sections). Context cost uses each row's most expensive app. Unknown values
 * sink to the bottom.
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

/** The status sort keeps the tab's own sections; any other sort is one flat list. */
export function arrangeRows<Row extends { readonly key: string; readonly name: string }>(
  rows: readonly Row[],
  mode: SortMode,
  stats: ReadonlyMap<string, RowStats>,
  byStatus: (rows: readonly Row[]) => RowSection<Row>[],
): RowSection<Row>[] {
  if (mode === "status") return byStatus(rows);
  return [{ id: "sorted", label: "", rows: sortRowsBy(rows, mode, stats) }];
}

/** Rows the Unused filter keeps (empty until usage is loaded). */
export function unusedRows<Row extends { readonly key: string }>(
  rows: readonly Row[],
  stats: ReadonlyMap<string, RowStats>,
): Row[] {
  return rows.filter((row) => statsFor(stats, row.key).unused === true);
}

/** What the unused rows cost a new thread, per app: "C 12k · X 8k tok". */
export function unusedCost(
  rows: readonly { readonly key: string }[],
  stats: ReadonlyMap<string, RowStats>,
  apps: readonly AgentApp[],
): string | null {
  const total = (app: AgentApp) =>
    sum(rows.map((row) => statsFor(stats, row.key).perAppTokens?.[app]?.loaded ?? 0));
  const text = perAppText(apps, (app) => {
    const tokens = total(app);
    return tokens > 0 ? formatTokens(tokens) : null;
  });
  return text ? `${text} tok` : null;
}

/** "Scanned 412 sessions" style footnote for the usage window. */
export function usageFootnote(report: UsageReport): string {
  const sessions = sum(APPS.map((app) => report.apps[app].sessions));
  const failed = APPS.filter((app) => report.apps[app].error).map((app) => APP_LABEL[app]);
  const base = `${sessions} ${sessions === 1 ? "session" : "sessions"} in ${report.days}d`;
  return failed.length > 0 ? `${base}; ${failed.join(" and ")} could not be scanned` : base;
}
