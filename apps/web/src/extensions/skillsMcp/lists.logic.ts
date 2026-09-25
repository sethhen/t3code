/**
 * Pure helpers for the three lists: filtering, sorting, status labels, toggle
 * rules, relative time and small skills/plugins formatting.
 */
import type {
  AgentApp,
  AgentAppInfo,
  DiscoverableSkill,
  McpAppEntry,
  McpOverview,
  McpScope,
  McpServerRow,
  McpToolInfo,
  PluginRow,
  SkillRepo,
  SkillRow,
  SkillScope,
} from "@t3tools/contracts";

import type { Parsed } from "./mcpForm.logic";

export const APP_LABEL: Readonly<Record<AgentApp, string>> = { claude: "Claude", codex: "Codex" };

const defined = <Value>(value: Value | undefined): value is Value => value !== undefined;

function appEntries<Entry>(apps: {
  readonly claude?: Entry | undefined;
  readonly codex?: Entry | undefined;
}): NonNullable<Entry>[] {
  const entries: NonNullable<Entry>[] = [];
  if (apps.claude != null) entries.push(apps.claude);
  if (apps.codex != null) entries.push(apps.codex);
  return entries;
}

export const compareNames = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });

// ---------------------------------------------------------------------------
// Query matching

export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every term must appear somewhere in the fields (case-insensitive AND). */
export function matchesQuery(fields: readonly (string | undefined)[], query: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const haystack = fields.filter(defined).join("\n").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function filterBy<Row>(
  rows: readonly Row[],
  query: string,
  fields: (row: Row) => readonly (string | undefined)[],
): readonly Row[] {
  if (queryTerms(query).length === 0) return rows;
  return rows.filter((row) => matchesQuery(fields(row), query));
}

// ---------------------------------------------------------------------------
// MCP

/** The scope a row is listed under: builtin, else the first app entry's scope. */
export function primaryScope(row: McpServerRow): McpScope {
  if (row.builtin) return "builtin";
  return appEntries(row.apps)[0]?.scope ?? "unknown";
}

function mcpRank(row: McpServerRow): number {
  if (row.builtin) return 5;
  if (row.managed) return 0;
  switch (primaryScope(row)) {
    case "user":
      return 1;
    case "project":
    case "local":
      return 2;
    case "plugin":
      return 3;
    default:
      return 4;
  }
}

/** Managed first, then unmanaged user, project/local, plugin, managed/unknown, builtin. */
export function sortMcpServers(rows: readonly McpServerRow[]): McpServerRow[] {
  return [...rows].sort(
    (left, right) => mcpRank(left) - mcpRank(right) || compareNames(left.name, right.name),
  );
}

function mcpFields(row: McpServerRow): (string | undefined)[] {
  const fields: (string | undefined)[] = [row.name, row.description, row.homepage, ...row.tags];
  if (row.spec)
    fields.push(row.spec.type, row.spec.type === "stdio" ? row.spec.command : row.spec.url);
  if (row.builtin) fields.push("builtin");
  if (row.managed) fields.push("managed");
  for (const entry of appEntries(row.apps)) {
    fields.push(entry.scope, entry.source, ...(entry.tools ?? []).map((tool) => tool.name));
  }
  return fields;
}

export function filterMcpServers(rows: readonly McpServerRow[], query: string) {
  return filterBy(rows, query, mcpFields);
}

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
      return { label: "Needs auth", tone: "warning" };
    case "pending":
      return { label: "Connecting", tone: "info" };
    case "not-started":
      return { label: "Not started", tone: "muted" };
    default:
      return { label: "Unknown", tone: "muted" };
  }
}

const MCP_SCOPE_ORIGIN: Readonly<Record<McpScope, string>> = {
  user: "your user config",
  project: "the project's .mcp.json",
  local: "Claude's per-project config",
  plugin: "a plugin",
  managed: "admin policy",
  builtin: "T3",
  unknown: "another config file",
};

/** Why an app's enable switch is locked for this row, or null when it can be toggled. */
export function mcpToggleBlock(row: McpServerRow, app: AgentApp): string | null {
  if (row.builtin) return "T3 attaches this server to every session itself.";
  const entry = row.apps[app];
  if (!row.managed) {
    const scope = entry?.scope ?? primaryScope(row);
    if (scope === "user") return "Not managed yet. Use Import to manage it here.";
    const source = entry?.source ? ` (${entry.source})` : "";
    return `Defined by ${MCP_SCOPE_ORIGIN[scope]}${source}; edit it there.`;
  }
  if (app === "codex" && row.spec?.type === "sse") return "Codex has no SSE transport.";
  if (!row.id) return "This server has no store id.";
  return null;
}

/** Unmanaged servers in the user scope of either app: what `import` would adopt. */
export function countImportable(rows: readonly McpServerRow[]): number {
  return rows.filter(
    (row) =>
      !row.managed && !row.builtin && appEntries(row.apps).some((entry) => entry.scope === "user"),
  ).length;
}

export interface ToolGroup {
  readonly apps: readonly AgentApp[];
  readonly tools: readonly McpToolInfo[];
}

/** One group when both apps list the same tool names, otherwise one group per app. */
export function groupTools(row: McpServerRow): ToolGroup[] {
  const groups: ToolGroup[] = [];
  const claude = row.apps.claude?.tools;
  const codex = row.apps.codex?.tools;
  if (claude && codex && sameNames(claude, codex))
    return [{ apps: ["claude", "codex"], tools: claude }];
  if (claude) groups.push({ apps: ["claude"], tools: claude });
  if (codex) groups.push({ apps: ["codex"], tools: codex });
  return groups;
}

function sameNames(left: readonly McpToolInfo[], right: readonly McpToolInfo[]): boolean {
  if (left.length !== right.length) return false;
  const names = new Set(left.map((tool) => tool.name));
  return right.every((tool) => names.has(tool.name));
}

const APPS = ["claude", "codex"] as const satisfies readonly AgentApp[];

export interface AttentionIssue {
  readonly app: AgentApp;
  readonly tone: "destructive" | "warning";
  readonly label: string;
  readonly message?: string;
}

/**
 * Enabled app entries that failed, need auth or carry an error (for example a
 * managed server missing from the app's config). Entries that are off (Codex
 * for SSE, project-disabled) are not problems.
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
      issues.push({ app, tone: "warning", label: "Needs auth", ...message });
    else if (entry.error) issues.push({ app, tone: "destructive", label: "Error", ...message });
  }
  return issues;
}

export function countAttention(rows: readonly McpServerRow[]): number {
  return rows.filter((row) => mcpIssues(row).length > 0).length;
}

/** The row's single dot: the worst problem, else the best live state of a present app. */
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

/** Distinct tool names across both apps. */
export function mcpToolCount(row: McpServerRow): number {
  const names = new Set<string>();
  for (const entry of appEntries(row.apps))
    for (const tool of entry.tools ?? []) names.add(tool.name);
  return names.size;
}

/**
 * The one-click fix shown on the row itself. Today that is reconnecting the
 * apps whose server failed or needs auth; a "Log in" action can take the
 * needs-auth case once the contract has one.
 */
export interface McpPrimaryAction {
  readonly kind: "login" | "reconnect";
  readonly label: string;
  readonly apps: readonly AgentApp[];
}

/** Sign-in beats reconnect: a server waiting on OAuth will not connect until the user logs in. */
export function mcpPrimaryAction(row: McpServerRow): McpPrimaryAction | null {
  if (row.builtin) return null;
  const issues = mcpIssues(row).filter(
    (issue) => issue.label !== "Error" && row.apps[issue.app]?.present,
  );
  const needsAuth = issues
    .filter((issue) => row.apps[issue.app]?.status === "needs-auth")
    .map((issue) => issue.app);
  if (needsAuth.length > 0) return { kind: "login", label: "Log in", apps: needsAuth };
  const apps = issues.map((issue) => issue.app);
  return apps.length > 0 ? { kind: "reconnect", label: "Reconnect", apps } : null;
}

export interface RowSection<Row> {
  readonly id: string;
  readonly label: string;
  readonly rows: readonly Row[];
}

const nonEmpty = <Row>(sections: RowSection<Row>[]) =>
  sections.filter((section) => section.rows.length > 0);

function severity(row: McpServerRow): number {
  const issues = mcpIssues(row);
  if (issues.some((issue) => issue.tone === "destructive")) return 0;
  return issues.length > 0 ? 1 : 2;
}

/** Problems first (failures before auth), then managed, then everything else. */
export function sectionMcpServers(rows: readonly McpServerRow[]): RowSection<McpServerRow>[] {
  const sorted = sortMcpServers(rows);
  const attention = sorted
    .filter((row) => severity(row) < 2)
    .sort((left, right) => severity(left) - severity(right));
  const rest = sorted.filter((row) => severity(row) === 2);
  return nonEmpty([
    { id: "attention", label: "Needs attention", rows: attention },
    { id: "managed", label: "Managed", rows: rest.filter((row) => row.managed) },
    { id: "other", label: "Not managed", rows: rest.filter((row) => !row.managed) },
  ]);
}

/** One filter choice; `group` titles its block in the filter menu. */
export interface Facet {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  readonly group: string;
}

export const ALL_FACET = "all";

function countFacets<Row>(
  rows: readonly Row[],
  group: string,
  keys: (row: Row) => readonly { readonly id: string; readonly label: string }[],
): Facet[] {
  const facets = new Map<string, { label: string; count: number }>();
  for (const row of rows) {
    for (const { id, label } of keys(row)) {
      const facet = facets.get(id);
      if (facet) facet.count += 1;
      else facets.set(id, { label, count: 1 });
    }
  }
  return [...facets.entries()]
    .map(([id, facet]) => ({ id, group, ...facet }))
    .sort((left, right) => compareNames(left.label, right.label));
}

const MCP_SCOPE_FACET: Readonly<Record<McpScope, string>> = {
  user: "User config",
  project: "Project .mcp.json",
  local: "Claude per-project",
  plugin: "Plugins",
  managed: "Policy",
  builtin: "Built in",
  unknown: "Other files",
};

/** Status, tag (managed servers carry tags) and origin filters, with counts over all rows. */
export function mcpFacets(rows: readonly McpServerRow[]): Facet[] {
  const status = countFacets(rows, "Show", (row) => [
    ...(mcpIssues(row).length > 0 ? [{ id: "attention", label: "Needs attention" }] : []),
    row.managed ? { id: "managed", label: "Managed" } : { id: "unmanaged", label: "Not managed" },
  ]);
  const order = ["attention", "managed", "unmanaged"];
  status.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
  const tags = countFacets(rows, "Tags", (row) =>
    row.tags.map((tag) => ({ id: `tag:${tag}`, label: tag })),
  );
  const origins = countFacets(
    rows.filter((row) => !row.managed),
    "Origin",
    (row) => {
      const scope = primaryScope(row);
      return [{ id: `scope:${scope}`, label: MCP_SCOPE_FACET[scope] }];
    },
  );
  return [...status, ...tags, ...(origins.length > 1 ? origins : [])];
}

export function mcpFacetMatches(row: McpServerRow, facet: string): boolean {
  if (facet === ALL_FACET) return true;
  if (facet === "attention") return mcpIssues(row).length > 0;
  if (facet === "managed") return row.managed;
  if (facet === "unmanaged") return !row.managed;
  if (facet.startsWith("tag:")) return row.tags.includes(facet.slice(4));
  if (facet.startsWith("scope:")) return !row.managed && primaryScope(row) === facet.slice(6);
  return true;
}

/** The selected facet, or "all" once it no longer exists (e.g. the last problem got fixed). */
export function resolveFacet(facets: readonly Facet[], selected: string): string {
  return selected === ALL_FACET || facets.some((facet) => facet.id === selected)
    ? selected
    : ALL_FACET;
}

/** The oldest live-probe time, since that is what the statuses reflect. */
export function mcpCheckedAt(overview: McpOverview): string {
  const probes = [overview.liveProbe.claude.checkedAt, overview.liveProbe.codex.checkedAt]
    .filter(defined)
    .filter((value) => Number.isFinite(Date.parse(value)));
  if (probes.length === 0) return overview.checkedAt;
  return probes.reduce((oldest, value) =>
    Date.parse(value) < Date.parse(oldest) ? value : oldest,
  );
}

// ---------------------------------------------------------------------------
// Apps

export function appInfo(apps: readonly AgentAppInfo[], app: AgentApp): AgentAppInfo | undefined {
  return apps.find((info) => info.app === app);
}

/** Null when the app answered (or was not reported at all). */
export function appUnavailableReason(apps: readonly AgentAppInfo[], app: AgentApp): string | null {
  const info = appInfo(apps, app);
  if (!info || info.available) return null;
  return `${APP_LABEL[app]} is unavailable${info.error ? `: ${info.error}` : "."}`;
}

// ---------------------------------------------------------------------------
// Relative time

export function formatRelativeTime(iso: string, now: number): string | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

// ---------------------------------------------------------------------------
// Skills

/** Managed first, then by name. */
export function sortSkills(rows: readonly SkillRow[]): SkillRow[] {
  return [...rows].sort(
    (left, right) =>
      Number(right.managed) - Number(left.managed) || compareNames(left.name, right.name),
  );
}

export interface SkillSourceLabel {
  readonly kind: "github" | "zip" | "local" | "plugin";
  readonly label: string;
  readonly href?: string;
}

export function skillSourceLabel(row: SkillRow): SkillSourceLabel | null {
  const source = row.source;
  if (source?.type === "github") {
    const repoUrl = `https://github.com/${source.owner}/${source.repo}`;
    const path = source.path?.replace(/^\/+|\/+$/g, "") ?? "";
    const href =
      path || source.branch ? `${repoUrl}/tree/${source.branch ?? "HEAD"}/${path}` : repoUrl;
    return {
      kind: "github",
      label: `${source.owner}/${source.repo}`,
      href: href.replace(/\/$/, ""),
    };
  }
  if (source?.type === "zip") return { kind: "zip", label: source.fileName };
  if (source?.type === "local") return { kind: "local", label: source.path };
  if (row.pluginId) return { kind: "plugin", label: row.pluginId };
  return null;
}

function skillFields(row: SkillRow): (string | undefined)[] {
  const source = skillSourceLabel(row);
  return [
    row.name,
    row.description,
    row.pluginId,
    source?.label,
    row.managed ? "managed" : undefined,
    row.updateAvailable ? "update" : undefined,
    ...appEntries(row.apps).map((entry) => entry.scope),
  ];
}

export function filterSkills(rows: readonly SkillRow[], query: string) {
  return filterBy(rows, query, skillFields);
}

const SKILL_SCOPE_SOURCE: Readonly<Record<SkillScope, string>> = {
  user: "Skills folder",
  project: "This project",
  plugin: "Plugins",
  system: "Built in",
  synced: "Synced",
};

/** Where a skill comes from, as a filter key: a repo, uploads, a plugin, or its folder. */
export function skillOrigin(row: SkillRow): { readonly id: string; readonly label: string } {
  const source = row.source;
  if (source?.type === "github") {
    const label = `${source.owner}/${source.repo}`;
    return { id: `source:github:${label.toLowerCase()}`, label };
  }
  if (source?.type === "zip") return { id: "source:zip", label: "Uploaded .zip" };
  if (source?.type === "local") return { id: "source:local", label: "Local folders" };
  if (row.pluginId) return { id: `source:plugin:${row.pluginId}`, label: row.pluginId };
  const scope = appEntries(row.apps)[0]?.scope ?? "user";
  return { id: `source:${scope}`, label: SKILL_SCOPE_SOURCE[scope] };
}

export function skillFacets(rows: readonly SkillRow[]): Facet[] {
  const status = countFacets(rows, "Show", (row) => [
    ...(row.updateAvailable ? [{ id: "updates", label: "Update available" }] : []),
    row.managed ? { id: "managed", label: "Managed" } : { id: "unmanaged", label: "Not managed" },
  ]);
  const order = ["updates", "managed", "unmanaged"];
  status.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
  const sources = countFacets(rows, "Source", (row) => [skillOrigin(row)]);
  return [...status, ...(sources.length > 1 ? sources : [])];
}

export function skillFacetMatches(row: SkillRow, facet: string): boolean {
  if (facet === ALL_FACET) return true;
  if (facet === "updates") return row.updateAvailable === true;
  if (facet === "managed") return row.managed;
  if (facet === "unmanaged") return !row.managed;
  if (facet.startsWith("source:")) return skillOrigin(row).id === facet;
  return true;
}

/** Updates first, then managed, then the rest (plugins, built-ins, unmanaged folders). */
export function sectionSkills(rows: readonly SkillRow[]): RowSection<SkillRow>[] {
  const sorted = sortSkills(rows);
  const updates = sorted.filter((row) => row.updateAvailable);
  const rest = sorted.filter((row) => !row.updateAvailable);
  return nonEmpty([
    { id: "updates", label: "Update available", rows: updates },
    { id: "managed", label: "Managed", rows: rest.filter((row) => row.managed) },
    { id: "other", label: "Not managed", rows: rest.filter((row) => !row.managed) },
  ]);
}

/** Why a skill's per-app switch is locked, or null when it can be toggled. */
export function skillToggleBlock(row: SkillRow, app: AgentApp): string | null {
  const entry = row.apps[app];
  if (row.pluginId || entry?.scope === "plugin") {
    return `Comes from ${row.pluginId ? `plugin ${row.pluginId}` : "a plugin"}; manage it in Plugins.`;
  }
  if (!row.managed) {
    switch (entry?.scope) {
      case "system":
        return `Built into ${APP_LABEL[app]}.`;
      case "project":
        return "Lives in this project's folder; edit it there.";
      case "synced":
        return `Synced by ${APP_LABEL[app]}; manage it there.`;
      default:
        return "Not managed yet. Adopt it to manage it here.";
    }
  }
  if (!row.id) return "This skill has no store id.";
  return null;
}

/** The folder `adopt` moves into the store. */
export function skillAdoptPath(row: SkillRow): string | undefined {
  if (row.managed || row.pluginId) return undefined;
  const candidates = [row.apps.claude, row.apps.codex].filter(defined);
  const adoptable = candidates.find((entry) => entry.scope === "user" && entry.path);
  return adoptable?.path;
}

const REPO_PART = /^[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9_./-]+$/;

/** Accepts `owner/repo`, `owner/repo@branch` and github.com URLs (with `/tree/<branch>`). */
export function parseRepoInput(text: string): Parsed<SkillRepo> {
  let value = text.trim();
  if (value === "") return { ok: false, error: "Enter a repository." };
  let branch: string | undefined;
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(value);
  if (url?.[1] !== undefined) {
    const [owner = "", rawRepo = "", tree, ...rest] = url[1].replace(/[?#].*$/, "").split("/");
    const repo = rawRepo.replace(/\.git$/i, "");
    if (tree === "tree" && rest.length > 0) branch = rest.join("/").replace(/\/+$/, "");
    value = `${owner}/${repo}`;
  } else {
    const at = value.lastIndexOf("@");
    if (at > 0) {
      branch = value.slice(at + 1);
      value = value.slice(0, at);
    }
  }
  const parts = value.replace(/\/+$/, "").split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo || !REPO_PART.test(owner) || !REPO_PART.test(repo)) {
    return { ok: false, error: "Use owner/repo or a GitHub URL." };
  }
  if (branch !== undefined && (branch === "" || !BRANCH.test(branch))) {
    return { ok: false, error: "That branch name is not valid." };
  }
  return { ok: true, value: { owner, repo, ...(branch ? { branch } : {}) } };
}

export const repoKey = (repo: { readonly owner: string; readonly repo: string }): string =>
  `${repo.owner}/${repo.repo}`;

export interface RepoGroup {
  readonly key: string;
  readonly repo: SkillRepo;
  /** Saved in the repo list (so it can be removed), as opposed to only discovered. */
  readonly saved: boolean;
  readonly skills: readonly DiscoverableSkill[];
}

/** Groups discovered skills by repo; saved repos without skills still get a group. */
export function groupDiscoverable(
  skills: readonly DiscoverableSkill[],
  repos: readonly SkillRepo[],
): RepoGroup[] {
  const groups = new Map<
    string,
    { repo: SkillRepo; saved: boolean; skills: DiscoverableSkill[] }
  >();
  for (const repo of repos)
    groups.set(repoKey(repo).toLowerCase(), { repo, saved: true, skills: [] });
  for (const skill of skills) {
    const key = repoKey(skill).toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = {
        repo: { owner: skill.owner, repo: skill.repo, branch: skill.branch },
        saved: false,
        skills: [],
      };
      groups.set(key, group);
    }
    group.skills.push(skill);
  }
  return [...groups.values()]
    .map((group) => ({
      key: repoKey(group.repo),
      repo: group.repo,
      saved: group.saved,
      skills: group.skills.sort((left, right) => compareNames(left.name, right.name)),
    }))
    .sort((left, right) => compareNames(left.key, right.key));
}

export function filterDiscoverable(groups: readonly RepoGroup[], query: string): RepoGroup[] {
  if (queryTerms(query).length === 0) return [...groups];
  return groups
    .map((group) => ({
      ...group,
      skills: group.skills.filter((skill) =>
        matchesQuery([group.key, skill.name, skill.description, skill.path], query),
      ),
    }))
    .filter((group) => group.skills.length > 0 || matchesQuery([group.key], query));
}

/** 999, 1.2k, 3.4M. */
export function formatInstalls(count: number): string {
  if (!Number.isFinite(count) || count < 1000) return String(Math.max(0, Math.round(count || 0)));
  const short = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  const thousands = count / 1000;
  if (Number(thousands.toFixed(1)) < 1000) return `${short(thousands)}k`;
  return `${short(count / 1_000_000)}M`;
}

/** Base64 without blowing the argument limit on big files. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Plugins

export function sortPlugins(rows: readonly PluginRow[]): PluginRow[] {
  return [...rows].sort((left, right) => compareNames(left.name, right.name));
}

export function filterPlugins(rows: readonly PluginRow[], query: string) {
  return filterBy(rows, query, (row) => [
    row.name,
    row.id,
    row.marketplace,
    row.description,
    row.app,
    ...row.contributes.skills,
    ...row.contributes.mcpServers,
    ...row.contributes.commands,
    ...row.contributes.agents,
  ]);
}

export interface ContributionChip {
  readonly kind: "skills" | "mcpServers" | "commands" | "agents";
  readonly label: string;
  readonly names: readonly string[];
}

const CONTRIBUTION_NOUNS = {
  skills: ["skill", "skills"],
  mcpServers: ["MCP server", "MCP servers"],
  commands: ["command", "commands"],
  agents: ["agent", "agents"],
} as const;

/** "3 skills", "1 MCP server": one chip per non-empty contribution kind. */
export function contributionChips(row: PluginRow): ContributionChip[] {
  return (Object.keys(CONTRIBUTION_NOUNS) as (keyof typeof CONTRIBUTION_NOUNS)[])
    .map((kind) => {
      const names = row.contributes[kind];
      const [one, many] = CONTRIBUTION_NOUNS[kind];
      return { kind, names, label: `${names.length} ${names.length === 1 ? one : many}` };
    })
    .filter((chip) => chip.names.length > 0);
}
