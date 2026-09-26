/**
 * Claude's context cost, estimated by Claude itself: the `/context` breakdown
 * the MCP module's probe session reports (`getContextUsage`, summary detail),
 * mapped onto the contract. Pure, so it is tested without a Claude session.
 */
import type { AppContext, ContextCategory, McpContextCost } from "@t3tools/contracts";

import type { ClaudeContextUsage, ClaudeProbe } from "../mcp/probes.ts";

type Kind = ContextCategory["kind"];
type Category = ClaudeContextUsage["categories"][number];

const KINDS: ReadonlySet<string> = new Set<Kind>(["used", "free", "buffer", "deferred"]);

/**
 * Claude tags each category with a `kind` its type definitions do not declare
 * (the binary's own schema says to classify on it, never on the English
 * name); older CLIs only mark deferred categories, so fall back to the names.
 */
export const categoryKind = (category: Category): Kind => {
  const kind = (category as { readonly kind?: unknown }).kind;
  if (typeof kind === "string" && KINDS.has(kind)) return kind as Kind;
  if (category.isDeferred) return "deferred";
  const name = category.name.toLowerCase();
  if (name === "free space") return "free";
  if (name.includes("buffer")) return "buffer";
  return "used";
};

/** Conversation tokens: none before the first message, so not part of the baseline. */
const MESSAGES_CATEGORY = "messages";

/**
 * How Claude turns an MCP server name into the `mcp__<server>__<tool>` tool
 * prefix, so config names can be matched to the servers `/context` reports.
 */
export const normalizeClaudeServerName = (name: string) => {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return name.startsWith("claude.ai ")
    ? normalized.replace(/_+/g, "_").replace(/^_|_$/g, "")
    : normalized;
};

const byTokens = <T extends { readonly tokens: number; readonly name: string }>(a: T, b: T) =>
  b.tokens - a.tokens || a.name.localeCompare(b.name);

const toolName = (qualified: string, serverName: string) => {
  const prefix = `mcp__${normalizeClaudeServerName(serverName)}__`;
  if (qualified.startsWith(prefix)) return qualified.slice(prefix.length);
  if (!qualified.startsWith("mcp__")) return qualified;
  const split = qualified.indexOf("__", 5);
  return split === -1 ? qualified : qualified.slice(split + 2);
};

/**
 * `deferring`: whether `/context` reports any out-of-window tool schemas. When
 * tool search is off, every MCP tool is in the window whatever `isLoaded`
 * says (Claude reports `isLoaded: false` for tools it never had to search for).
 */
const mcpServersOf = (
  tools: ClaudeContextUsage["mcpTools"],
  statuses: ClaudeProbe["statuses"],
  deferring: boolean,
): McpContextCost[] => {
  // `/context` may report the normalized name; the panel knows servers by config name.
  const configNames = new Map<string, string>();
  for (const status of statuses) {
    configNames.set(status.name, status.name);
    if (!configNames.has(normalizeClaudeServerName(status.name))) {
      configNames.set(normalizeClaudeServerName(status.name), status.name);
    }
  }
  const servers = new Map<string, Array<McpContextCost["tools"][number]>>();
  for (const tool of tools) {
    const server = configNames.get(tool.serverName) ?? tool.serverName;
    const list = servers.get(server) ?? [];
    list.push({
      name: toolName(tool.name, tool.serverName),
      tokens: tool.tokens,
      // Absent on CLIs that load every tool up front.
      loaded: !deferring || tool.isLoaded !== false,
    });
    servers.set(server, list);
  }
  return [...servers.entries()]
    .map(([name, list]) => {
      const sorted = list.toSorted(byTokens);
      const sum = (loaded: boolean) =>
        sorted.reduce((total, tool) => (tool.loaded === loaded ? total + tool.tokens : total), 0);
      return {
        name,
        toolCount: sorted.length,
        loadedTokens: sum(true),
        deferredTokens: sum(false),
        tools: sorted,
      };
    })
    .toSorted(
      (a, b) =>
        b.loadedTokens + b.deferredTokens - (a.loadedTokens + a.deferredTokens) ||
        a.name.localeCompare(b.name),
    );
};

/** The summary detail is Claude's own estimate; the exact one calls the API. */
const CLAUDE_NOTE = "Claude's local estimate";

const emptyContext = (error: string): AppContext => ({
  exact: false,
  baselineTokens: 0,
  categories: [],
  mcpServers: [],
  skills: [],
  memoryFiles: [],
  error,
});

/** `AppContext` from a Claude probe; a probe without context usage becomes an error. */
export const claudeAppContext = (probe: ClaudeProbe): AppContext => {
  const usage = probe.contextUsage;
  if (!usage) {
    return emptyContext(
      probe.error ?? probe.contextError ?? "Claude did not report its context usage",
    );
  }
  const categories = usage.categories.map((category): ContextCategory => ({
    name: category.name,
    tokens: category.tokens,
    kind: categoryKind(category),
  }));
  const baselineTokens = categories.reduce(
    (total, category) =>
      category.kind === "used" && category.name.toLowerCase() !== MESSAGES_CATEGORY
        ? total + category.tokens
        : total,
    0,
  );
  const windowTokens = usage.rawMaxTokens || usage.maxTokens;
  return {
    exact: false,
    note: CLAUDE_NOTE,
    ...(usage.model ? { model: usage.model } : {}),
    ...(windowTokens > 0 ? { windowTokens } : {}),
    baselineTokens,
    categories,
    mcpServers: mcpServersOf(
      usage.mcpTools,
      probe.statuses,
      categories.some((category) => category.kind === "deferred" && category.tokens > 0),
    ),
    skills: (usage.skills?.skillFrontmatter ?? [])
      .map((skill) => ({
        name: skill.name,
        ...(skill.source ? { source: skill.source } : {}),
        tokens: skill.tokens,
      }))
      .toSorted(byTokens),
    memoryFiles: usage.memoryFiles.map((file) => ({ path: file.path, tokens: file.tokens })),
    ...(probe.error ? { error: probe.error } : {}),
  };
};
