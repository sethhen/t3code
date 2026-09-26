/**
 * Pure helpers for the three lists: which rows are the user's and which came
 * with Claude Code, Codex, T3 or a plugin, what each app switch does, status
 * labels, and the one-click fixes on MCP rows.
 */
import type {
  AgentApp,
  AgentAppInfo,
  McpAppEntry,
  McpScope,
  McpServerRow,
  McpToolInfo,
  PluginRow,
  SkillRow,
  SkillScope,
} from "@t3tools/contracts";

export const APP_LABEL: Readonly<Record<AgentApp, string>> = { claude: "Claude", codex: "Codex" };

export const APPS = ["claude", "codex"] as const satisfies readonly AgentApp[];

const compareNames = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });

const byName = <Row extends { readonly name: string }>(rows: readonly Row[]): Row[] =>
  [...rows].sort((left, right) => compareNames(left.name, right.name));

function appEntries<Entry>(apps: {
  readonly claude?: Entry | undefined;
  readonly codex?: Entry | undefined;
}): NonNullable<Entry>[] {
  const entries: NonNullable<Entry>[] = [];
  if (apps.claude != null) entries.push(apps.claude);
  if (apps.codex != null) entries.push(apps.codex);
  return entries;
}

/** `vercel-plugin@vercel` -> `vercel-plugin`. */
const pluginName = (id: string): string => id.split("@")[0] || id;

// ---------------------------------------------------------------------------
// Sections

/**
 * A list split into what needs a look, what the user installed, what the
 * open project brings (its `.mcp.json`, `.claude/skills`), and what came with
 * the apps or a plugin.
 */
export interface ListSections<Row> {
  readonly attention: readonly Row[];
  readonly yours: readonly Row[];
  readonly project: readonly Row[];
  /** Folded away by default. */
  readonly builtIn: readonly Row[];
}

// ---------------------------------------------------------------------------
// App switches

/**
 * What one app's switch on a row does. `store`: the panel's own store (user
 * MCP servers, installed skills). `claude`: Claude's `deniedMcpServers`, for
 * every other Claude server. `native`: the app's own skill setting.
 */
export type AppControl =
  | { readonly kind: "store"; readonly id: string }
  | { readonly kind: "claude" }
  | { readonly kind: "native"; readonly path?: string }
  | { readonly kind: "locked"; readonly reason: string };

const locked = (reason: string): AppControl => ({ kind: "locked", reason });

const inPlugins = (plugin: string) =>
  `Comes with the ${plugin} plugin. Switch the plugin off in Plugins.`;

const CODEX_ORIGIN: Readonly<Record<McpScope, string>> = {
  user: "Defined in Codex's config.toml under a name T3 cannot manage.",
  project: "Defined in this project's Codex config.",
  local: "Defined in this project's Codex config.",
  plugin: "Comes with a plugin. Switch the plugin off in Plugins.",
  connector: "A claude.ai connector.",
  managed: "Set by admin policy.",
  builtin: "Built into T3 Code.",
  unknown: "Defined in another Codex config file.",
};

/** The switch for one app's cell, or null when the server is not in that app. */
export function mcpAppSwitch(row: McpServerRow, app: AgentApp): AppControl | null {
  const entry = row.apps[app];
  if (!entry) return null;
  if (row.builtin) return locked("T3 Code's own tools, attached to every thread.");
  if (row.managed) {
    if (app === "codex" && row.spec?.type === "sse") return locked("Codex has no SSE transport.");
    return row.id ? { kind: "store", id: row.id } : locked("This server has no store id.");
  }
  if (app === "claude") return { kind: "claude" };
  if (entry.scope === "plugin" && entry.source) return locked(inPlugins(pluginName(entry.source)));
  return locked(CODEX_ORIGIN[entry.scope]);
}

/** The switch for one app's cell, or null when the app does not have the skill. */
export function skillAppSwitch(row: SkillRow, app: AgentApp): AppControl | null {
  const entry = row.apps[app];
  if (row.managed) {
    if (!entry) return null;
    return row.id ? { kind: "store", id: row.id } : locked("This skill has no store id.");
  }
  if (!entry?.present) return null;
  if (row.pluginId || entry.scope === "plugin") {
    return locked(inPlugins(row.pluginId ? pluginName(row.pluginId) : "a"));
  }
  if (app === "codex" && !entry.path) return locked("Codex did not report this skill's folder.");
  return { kind: "native", ...(entry.path ? { path: entry.path } : {}) };
}

// ---------------------------------------------------------------------------
// MCP

export type StatusTone = "success" | "destructive" | "warning" | "info" | "muted";

export interface StatusLabel {
  readonly label: string;
  readonly tone: StatusTone;
}

export function mcpStatusLabel(entry: McpAppEntry): StatusLabel {
  if (!entry.enabled || entry.status === "disabled") return { label: "Off", tone: "muted" };
  switch (entry.status) {
    case "connected":
      return { label: "Connected", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "destructive" };
    case "needs-auth":
      return { label: "Needs sign-in", tone: "warning" };
    case "pending":
      return { label: "Connecting", tone: "info" };
    case "not-started":
      return { label: "Not started", tone: "muted" };
    default:
      return { label: "Unknown", tone: "muted" };
  }
}

/** Scopes whose servers come with an app, a connector, a plugin or policy. */
const BUILT_IN_MCP_SCOPES: ReadonlySet<McpScope> = new Set([
  "plugin",
  "connector",
  "managed",
  "builtin",
]);

/**
 * A user server whose program ships inside the ChatGPT or Codex desktop app
 * (`node_repl`): the app registers it in both configs itself.
 */
const DESKTOP_APP_COMMAND = /[\\/](?:ChatGPT|Codex)\.app[\\/]/;

const fromDesktopApp = (row: McpServerRow) =>
  row.spec?.type === "stdio" && DESKTOP_APP_COMMAND.test(row.spec.command);

/** Came with Claude Code, Codex, T3, claude.ai or a plugin, rather than added by the user. */
function isBuiltInMcp(row: McpServerRow): boolean {
  if (row.builtin || fromDesktopApp(row)) return true;
  const present = appEntries(row.apps).filter((entry) => entry.present);
  return present.length > 0 && present.every((entry) => BUILT_IN_MCP_SCOPES.has(entry.scope));
}

/** Defined by the open project (`.mcp.json`, Claude's per-project servers). */
function isProjectMcp(row: McpServerRow): boolean {
  const present = appEntries(row.apps).filter((entry) => entry.present);
  return (
    present.length > 0 &&
    present.every((entry) => entry.scope === "project" || entry.scope === "local")
  );
}

/** A short "where from" label for rows that are not plain user servers. */
export function mcpOrigin(row: McpServerRow): string | null {
  if (row.builtin) return "T3";
  if (fromDesktopApp(row)) return "ChatGPT app";
  const entry = appEntries(row.apps).find((candidate) => candidate.present);
  switch (entry?.scope) {
    case "connector":
      return "claude.ai";
    case "plugin":
      return entry.source ? pluginName(entry.source) : "plugin";
    case "managed":
      return "policy";
    default:
      return null;
  }
}

export interface AttentionIssue {
  readonly app: AgentApp;
  readonly tone: "destructive" | "warning";
  readonly label: string;
  readonly message?: string;
}

/**
 * Enabled app entries that failed, need sign-in or carry an error (for
 * example a managed server missing from the app's config). Entries that are
 * off are never problems.
 */
export function mcpIssues(row: McpServerRow): AttentionIssue[] {
  const issues: AttentionIssue[] = [];
  for (const app of APPS) {
    const entry = row.apps[app];
    if (!entry?.enabled || entry.status === "disabled") continue;
    const message = entry.error ? { message: entry.error } : {};
    if (entry.status === "failed")
      issues.push({ app, tone: "destructive", label: "Failed", ...message });
    else if (entry.status === "needs-auth")
      issues.push({ app, tone: "warning", label: "Needs sign-in", ...message });
    else if (entry.error) issues.push({ app, tone: "destructive", label: "Error", ...message });
  }
  return issues;
}

/** The row's single dot: the worst problem, else the best live state of an app it is on in. */
export function mcpRowTone(row: McpServerRow): StatusTone {
  const issues = mcpIssues(row);
  if (issues.some((issue) => issue.tone === "destructive")) return "destructive";
  if (issues.length > 0) return "warning";
  const tones = new Set(
    appEntries(row.apps)
      .filter((entry) => entry.present)
      .map((entry) => mcpStatusLabel(entry).tone),
  );
  if (tones.has("success")) return "success";
  if (tones.has("info")) return "info";
  return "muted";
}

/** The one-click fix shown on the row itself. */
export interface McpPrimaryAction {
  readonly kind: "restore" | "login" | "reconnect";
  readonly label: string;
  readonly apps: readonly AgentApp[];
}

/** Apps a managed server is switched on for whose config has lost the entry. */
function mcpDriftApps(row: McpServerRow): AgentApp[] {
  if (!row.managed || row.builtin || !row.id) return [];
  return APPS.filter((app) => {
    const entry = row.apps[app];
    return entry?.enabled === true && !entry.present && mcpAppSwitch(row, app)?.kind === "store";
  });
}

/**
 * Restore beats everything (nothing else works while the entry is missing),
 * then sign-in beats reconnect: a server waiting on OAuth will not connect
 * until the user logs in.
 */
export function mcpPrimaryAction(row: McpServerRow): McpPrimaryAction | null {
  if (row.builtin) return null;
  const drift = mcpDriftApps(row);
  if (drift.length > 0) return { kind: "restore", label: "Restore", apps: drift };
  const issues = mcpIssues(row).filter(
    (issue) => issue.label !== "Error" && row.apps[issue.app]?.present,
  );
  const needsAuth = issues
    .filter((issue) => row.apps[issue.app]?.status === "needs-auth")
    .map((issue) => issue.app);
  if (needsAuth.length > 0) return { kind: "login", label: "Sign in", apps: needsAuth };
  const apps = issues.map((issue) => issue.app);
  return apps.length > 0 ? { kind: "reconnect", label: "Reconnect", apps } : null;
}

function severity(row: McpServerRow): number {
  const issues = mcpIssues(row);
  if (issues.some((issue) => issue.tone === "destructive")) return 0;
  return issues.length > 0 ? 1 : 2;
}

/**
 * The user's and the project's servers with a problem first (failures before
 * sign-in). Built-in servers keep their problems to themselves: a claude.ai
 * connector nobody signed in to is not the user's to fix.
 */
export function sectionMcpServers(rows: readonly McpServerRow[]): ListSections<McpServerRow> {
  const own = byName(rows.filter((row) => !isBuiltInMcp(row)));
  const fine = own.filter((row) => severity(row) === 2);
  return {
    attention: own
      .filter((row) => severity(row) < 2)
      .sort((left, right) => severity(left) - severity(right)),
    yours: fine.filter((row) => !isProjectMcp(row)),
    project: fine.filter(isProjectMcp),
    builtIn: byName(rows.filter(isBuiltInMcp)).sort(
      (left, right) => Number(right.builtin) - Number(left.builtin),
    ),
  };
}

export interface ToolGroup {
  readonly apps: readonly AgentApp[];
  readonly tools: readonly McpToolInfo[];
}

/** One group when both apps list the same tool names, otherwise one group per app. */
export function groupTools(row: McpServerRow): ToolGroup[] {
  const claude = row.apps.claude?.tools;
  const codex = row.apps.codex?.tools;
  if (claude && codex && sameNames(claude, codex))
    return [{ apps: ["claude", "codex"], tools: claude }];
  const groups: ToolGroup[] = [];
  if (claude) groups.push({ apps: ["claude"], tools: claude });
  if (codex) groups.push({ apps: ["codex"], tools: codex });
  return groups;
}

/** At most `cap` tools across the groups, in order; each group keeps its full count. */
export function capToolGroups(
  groups: readonly ToolGroup[],
  cap: number,
): (ToolGroup & { readonly total: number })[] {
  const shown: (ToolGroup & { readonly total: number })[] = [];
  let remaining = cap;
  for (const group of groups) {
    const tools = group.tools.slice(0, Math.max(0, remaining));
    remaining -= tools.length;
    if (tools.length > 0) shown.push({ apps: group.apps, tools, total: group.tools.length });
  }
  return shown;
}

function sameNames(left: readonly McpToolInfo[], right: readonly McpToolInfo[]): boolean {
  if (left.length !== right.length) return false;
  const names = new Set(left.map((tool) => tool.name));
  return right.every((tool) => names.has(tool.name));
}

// ---------------------------------------------------------------------------
// Apps

/** Null when the app answered (or was not reported at all). */
export function appUnavailableReason(apps: readonly AgentAppInfo[], app: AgentApp): string | null {
  const info = apps.find((candidate) => candidate.app === app);
  if (!info || info.available) return null;
  return `${APP_LABEL[app]} is unavailable${info.error ? `: ${info.error}` : "."}`;
}

// ---------------------------------------------------------------------------
// Skills

/** Scopes whose skills ship with an app, sync from claude.ai, or come with a plugin. */
const BUILT_IN_SKILL_SCOPES: ReadonlySet<SkillScope> = new Set(["system", "synced", "plugin"]);

function isBuiltInSkill(row: SkillRow): boolean {
  if (row.managed) return false;
  const present = appEntries(row.apps).filter((entry) => entry.present);
  return present.length > 0 && present.every((entry) => BUILT_IN_SKILL_SCOPES.has(entry.scope));
}

/** A short "where from" label for skills that are not plain user skills. */
export function skillOrigin(row: SkillRow): string | null {
  if (row.pluginId) return pluginName(row.pluginId);
  switch (appEntries(row.apps).find((entry) => entry.present)?.scope) {
    case "system":
      return "built in";
    case "synced":
      return "claude.ai";
    case "plugin":
      return "plugin";
    default:
      return null;
  }
}

const isProjectSkill = (row: SkillRow) =>
  !row.managed &&
  appEntries(row.apps).some((entry) => entry.present) &&
  appEntries(row.apps).every((entry) => !entry.present || entry.scope === "project");

export function sectionSkills(rows: readonly SkillRow[]): ListSections<SkillRow> {
  const own = byName(rows.filter((row) => !isBuiltInSkill(row)));
  return {
    attention: [],
    yours: own.filter((row) => !isProjectSkill(row)),
    project: own.filter(isProjectSkill),
    builtIn: byName(rows.filter(isBuiltInSkill)),
  };
}

// ---------------------------------------------------------------------------
// Plugins

/** Codex's own marketplaces: their plugins come with the Codex app. */
const BUILT_IN_MARKETPLACES: ReadonlySet<string> = new Set([
  "openai-bundled",
  "openai-primary-runtime",
]);

function isBuiltInPlugin(row: PluginRow): boolean {
  return row.app === "codex" && BUILT_IN_MARKETPLACES.has(row.marketplace ?? "");
}

/** Installed plugins, Claude's then Codex's, each by name. */
export function sectionPlugins(rows: readonly PluginRow[]): ListSections<PluginRow> {
  const ordered = APPS.flatMap((app) => byName(rows.filter((row) => row.app === app)));
  return {
    attention: [],
    yours: ordered.filter((row) => !isBuiltInPlugin(row)),
    project: [],
    builtIn: ordered.filter(isBuiltInPlugin),
  };
}

const CONTRIBUTION_NOUNS = {
  skills: ["skill", "skills"],
  mcpServers: ["MCP server", "MCP servers"],
  commands: ["command", "commands"],
  agents: ["agent", "agents"],
} as const;

/** "26 skills · 1 MCP server" for what a plugin brings; empty when it reports nothing. */
export function contributionSummary(row: PluginRow): string {
  return (Object.keys(CONTRIBUTION_NOUNS) as (keyof typeof CONTRIBUTION_NOUNS)[])
    .flatMap((kind) => {
      const count = row.contributes[kind].length;
      const [one, many] = CONTRIBUTION_NOUNS[kind];
      return count > 0 ? [`${count} ${count === 1 ? one : many}`] : [];
    })
    .join(" · ");
}
