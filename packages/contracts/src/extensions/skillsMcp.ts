/**
 * Skills & MCP extension - one right-panel view of the MCP servers, skills,
 * and plugins that Claude Code and Codex load on this environment.
 *
 * Reads come from the agents themselves (Claude Agent SDK `mcpServerStatus()`,
 * Codex app-server `mcpServerStatus/list` and `skills/list`) plus the config
 * files they own. Writes go through each agent's own CLI or app-server so the
 * fork never hand-edits `~/.claude.json` or `~/.codex/config.toml`.
 *
 * Management follows CC Switch's model: the fork keeps one store of
 * user-scoped servers and skills with a per-app enabled flag, and projects it
 * into each app. Disabling a server for an app removes it from that app's live
 * config while the store keeps its definition, so it can be re-enabled.
 */
import * as Schema from "effect/Schema";

import { defineExtension } from "./host.ts";

export const SKILLS_MCP_EXTENSION_ID = "skills-mcp";

// ---------------------------------------------------------------------------
// Shared

/** The agent apps this extension manages. */
export const AgentApp = Schema.Literals(["claude", "codex"]);
export type AgentApp = typeof AgentApp.Type;
export const AGENT_APPS = ["claude", "codex"] as const satisfies readonly AgentApp[];

export const AgentAppFlags = Schema.Struct({ claude: Schema.Boolean, codex: Schema.Boolean });
export type AgentAppFlags = typeof AgentAppFlags.Type;

export const AgentAppInfo = Schema.Struct({
  app: AgentApp,
  /** The CLI was found and answered. False hides the app's columns with `error` as the reason. */
  available: Schema.Boolean,
  version: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type AgentAppInfo = typeof AgentAppInfo.Type;

/** Every mutation reports per-app failures instead of failing the whole call. */
export const MutationResult = Schema.Struct({
  failures: Schema.Array(Schema.Struct({ app: Schema.optional(AgentApp), message: Schema.String })),
  /** Optional one-line summary for a toast, e.g. "Imported 3 servers". */
  message: Schema.optional(Schema.String),
});
export type MutationResult = typeof MutationResult.Type;

const StringMap = Schema.Record(Schema.String, Schema.String);

// ---------------------------------------------------------------------------
// MCP

/** Transport-level definition. Codex has no SSE transport, so SSE servers are Claude-only. */
export const McpServerSpec = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("stdio"),
    command: Schema.String,
    args: Schema.optional(Schema.Array(Schema.String)),
    env: Schema.optional(StringMap),
    cwd: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("http"),
    url: Schema.String,
    headers: Schema.optional(StringMap),
    /** Codex reads the bearer token from this environment variable. */
    bearerTokenEnvVar: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("sse"),
    url: Schema.String,
    headers: Schema.optional(StringMap),
  }),
]);
export type McpServerSpec = typeof McpServerSpec.Type;

export const McpToolInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  readOnly: Schema.optional(Schema.Boolean),
  destructive: Schema.optional(Schema.Boolean),
  openWorld: Schema.optional(Schema.Boolean),
});
export type McpToolInfo = typeof McpToolInfo.Type;

export const McpLiveStatus = Schema.Literals([
  "connected",
  "failed",
  "needs-auth",
  "pending",
  "disabled",
  "not-started",
  "unknown",
]);
export type McpLiveStatus = typeof McpLiveStatus.Type;

/**
 * Where the definition lives. `user` is the only scope the store manages;
 * `project`/`local` are Claude's per-directory scopes, `plugin` comes from an
 * installed plugin, `managed` from admin policy, `builtin` is T3's own server.
 */
export const McpScope = Schema.Literals([
  "user",
  "project",
  "local",
  "plugin",
  "managed",
  "builtin",
  "unknown",
]);
export type McpScope = typeof McpScope.Type;

/** How one app sees one server. */
export const McpAppEntry = Schema.Struct({
  /** Present in the app's config or live status. */
  present: Schema.Boolean,
  /** Loaded by the app. For managed servers this is the store's desired flag. */
  enabled: Schema.Boolean,
  scope: McpScope,
  /** Plugin id or config path the definition came from. */
  source: Schema.optional(Schema.String),
  status: McpLiveStatus,
  error: Schema.optional(Schema.String),
  serverVersion: Schema.optional(Schema.String),
  /** Undefined when the live probe did not run or the server did not connect. */
  tools: Schema.optional(Schema.Array(McpToolInfo)),
  /** False for project/plugin/managed/builtin definitions the panel cannot rewrite. */
  editable: Schema.Boolean,
});
export type McpAppEntry = typeof McpAppEntry.Type;

export const McpServerRow = Schema.Struct({
  /** Stable React key: the store id for managed rows, otherwise `<scope>:<name>`. */
  key: Schema.String,
  /** Store id; present only for managed rows. Mutations take this id. */
  id: Schema.optional(Schema.String),
  name: Schema.String,
  managed: Schema.Boolean,
  /** T3's own `t3-code` server, attached by T3 to each provider session. */
  builtin: Schema.Boolean,
  spec: Schema.optional(McpServerSpec),
  description: Schema.optional(Schema.String),
  homepage: Schema.optional(Schema.String),
  tags: Schema.Array(Schema.String),
  apps: Schema.Struct({
    claude: Schema.optional(McpAppEntry),
    codex: Schema.optional(McpAppEntry),
  }),
});
export type McpServerRow = typeof McpServerRow.Type;

export const LiveProbeState = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  checkedAt: Schema.optional(Schema.String),
});
export type LiveProbeState = typeof LiveProbeState.Type;

export const McpOverview = Schema.Struct({
  apps: Schema.Array(AgentAppInfo),
  servers: Schema.Array(McpServerRow),
  /** Live status/tools probes; config-derived rows still render when a probe fails. */
  liveProbe: Schema.Struct({ claude: LiveProbeState, codex: LiveProbeState }),
  checkedAt: Schema.String,
});
export type McpOverview = typeof McpOverview.Type;

export const McpListInput = Schema.Struct({
  /** Thread workspace root; enables project-scoped servers and the project-aware probe. */
  cwd: Schema.optional(Schema.String),
  /** Bypass the live-probe cache. */
  refresh: Schema.optional(Schema.Boolean),
});

export const McpMutation = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("upsert"),
    /** Omit to create. Renaming an existing server removes the old name from every app. */
    id: Schema.optional(Schema.String),
    name: Schema.String,
    spec: McpServerSpec,
    apps: AgentAppFlags,
    description: Schema.optional(Schema.String),
    homepage: Schema.optional(Schema.String),
    tags: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    action: Schema.Literal("setEnabled"),
    id: Schema.String,
    app: AgentApp,
    enabled: Schema.Boolean,
  }),
  /** Removes the server from every app and from the store. */
  Schema.Struct({ action: Schema.Literal("delete"), id: Schema.String }),
  /** Adopt every user-scope server found in either app into the store (never writes app config). */
  Schema.Struct({ action: Schema.Literal("import") }),
  /** Claude only: enable/disable a server for one project directory (Claude's own per-project toggle). */
  Schema.Struct({
    action: Schema.Literal("setProjectEnabled"),
    name: Schema.String,
    cwd: Schema.String,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("reconnect"),
    name: Schema.String,
    app: AgentApp,
    cwd: Schema.optional(Schema.String),
  }),
  /**
   * OAuth sign-in through the app's own CLI (`claude|codex mcp login`). It opens
   * the browser on the machine running the T3 server and waits for the callback.
   */
  Schema.Struct({ action: Schema.Literal("login"), name: Schema.String, app: AgentApp }),
]);
export type McpMutation = typeof McpMutation.Type;

export const McpPreset = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  homepage: Schema.optional(Schema.String),
  tags: Schema.Array(Schema.String),
  spec: McpServerSpec,
});
export type McpPreset = typeof McpPreset.Type;

// ---------------------------------------------------------------------------
// Skills

export const SkillSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("github"),
    owner: Schema.String,
    repo: Schema.String,
    branch: Schema.optional(Schema.String),
    /** Directory inside the repo that contains SKILL.md; empty/absent means the repo root. */
    path: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("zip"), fileName: Schema.String }),
  /** Adopted from an existing folder on disk. */
  Schema.Struct({ type: Schema.Literal("local"), path: Schema.String }),
]);
export type SkillSource = typeof SkillSource.Type;

export const SkillScope = Schema.Literals(["user", "project", "plugin", "system", "synced"]);
export type SkillScope = typeof SkillScope.Type;

export const SkillAppEntry = Schema.Struct({
  present: Schema.Boolean,
  enabled: Schema.Boolean,
  scope: SkillScope,
  path: Schema.optional(Schema.String),
  /** symlink/copy: deployed by the store. native: the app's own folder (unmanaged). */
  mode: Schema.optional(Schema.Literals(["symlink", "copy", "native"])),
  editable: Schema.Boolean,
  /** A plain folder directly in the app's user skills folder, so `adopt` accepts it. */
  adoptable: Schema.optional(Schema.Boolean),
});
export type SkillAppEntry = typeof SkillAppEntry.Type;

export const SkillRow = Schema.Struct({
  key: Schema.String,
  /** Store id; present only for managed skills. */
  id: Schema.optional(Schema.String),
  name: Schema.String,
  description: Schema.optional(Schema.String),
  managed: Schema.Boolean,
  source: Schema.optional(SkillSource),
  installedAt: Schema.optional(Schema.String),
  updateAvailable: Schema.optional(Schema.Boolean),
  pluginId: Schema.optional(Schema.String),
  apps: Schema.Struct({
    claude: Schema.optional(SkillAppEntry),
    codex: Schema.optional(SkillAppEntry),
  }),
});
export type SkillRow = typeof SkillRow.Type;

export const SkillBackup = Schema.Struct({
  id: Schema.String,
  skillName: Schema.String,
  createdAt: Schema.String,
  path: Schema.String,
});
export type SkillBackup = typeof SkillBackup.Type;

export const SkillRepo = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  branch: Schema.optional(Schema.String),
});
export type SkillRepo = typeof SkillRepo.Type;

export const SkillsOverview = Schema.Struct({
  apps: Schema.Array(AgentAppInfo),
  /** Where managed skills live; each app folder links back here. */
  storageDir: Schema.String,
  appDirs: Schema.Struct({ claude: Schema.String, codex: Schema.String }),
  skills: Schema.Array(SkillRow),
  backups: Schema.Array(SkillBackup),
  repos: Schema.Array(SkillRepo),
  checkedAt: Schema.String,
});
export type SkillsOverview = typeof SkillsOverview.Type;

export const SkillSearchResult = Schema.Struct({
  id: Schema.String,
  skillId: Schema.String,
  name: Schema.String,
  installs: Schema.Number,
  /** `owner/repo` on GitHub. */
  source: Schema.String,
});
export type SkillSearchResult = typeof SkillSearchResult.Type;

export const DiscoverableSkill = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  branch: Schema.String,
  path: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  installed: Schema.Boolean,
});
export type DiscoverableSkill = typeof DiscoverableSkill.Type;

const GithubSkillSource = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  branch: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
});

export const SkillsMutation = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("install"),
    source: GithubSkillSource,
    /** Pick one skill by name when the repo holds several (skills.sh results). */
    skillName: Schema.optional(Schema.String),
    apps: AgentAppFlags,
  }),
  Schema.Struct({
    action: Schema.Literal("installZip"),
    fileName: Schema.String,
    dataBase64: Schema.String,
    apps: AgentAppFlags,
  }),
  Schema.Struct({
    action: Schema.Literal("setEnabled"),
    id: Schema.String,
    app: AgentApp,
    enabled: Schema.Boolean,
  }),
  /** Backs the skill up first; restore with `restoreBackup`. */
  Schema.Struct({ action: Schema.Literal("uninstall"), id: Schema.String }),
  Schema.Struct({ action: Schema.Literal("checkUpdates") }),
  /** Omit id to update every managed skill that has an update. */
  Schema.Struct({ action: Schema.Literal("update"), id: Schema.optional(Schema.String) }),
  Schema.Struct({ action: Schema.Literal("restoreBackup"), backupId: Schema.String }),
  Schema.Struct({ action: Schema.Literal("deleteBackup"), backupId: Schema.String }),
  /** Move an unmanaged skill folder into the store (after a backup) and link it back. */
  Schema.Struct({
    action: Schema.Literal("adopt"),
    path: Schema.String,
    apps: AgentAppFlags,
  }),
  Schema.Struct({
    action: Schema.Literal("addRepo"),
    owner: Schema.String,
    repo: Schema.String,
    branch: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("removeRepo"),
    owner: Schema.String,
    repo: Schema.String,
  }),
]);
export type SkillsMutation = typeof SkillsMutation.Type;

// ---------------------------------------------------------------------------
// Plugins

export const PluginRow = Schema.Struct({
  app: AgentApp,
  /** The id the app's CLI takes, e.g. `vercel-plugin@vercel`. */
  id: Schema.String,
  name: Schema.String,
  marketplace: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  updateAvailable: Schema.optional(Schema.Boolean),
  contributes: Schema.Struct({
    skills: Schema.Array(Schema.String),
    mcpServers: Schema.Array(Schema.String),
    commands: Schema.Array(Schema.String),
    agents: Schema.Array(Schema.String),
  }),
});
export type PluginRow = typeof PluginRow.Type;

export const PluginsOverview = Schema.Struct({
  apps: Schema.Array(AgentAppInfo),
  installed: Schema.Array(PluginRow),
  /** Marketplace plugins not yet installed; empty unless requested. */
  available: Schema.Array(PluginRow),
  checkedAt: Schema.String,
});
export type PluginsOverview = typeof PluginsOverview.Type;

export const PluginsMutation = Schema.Struct({
  action: Schema.Literals(["enable", "disable", "install", "uninstall", "update"]),
  app: AgentApp,
  id: Schema.String,
});
export type PluginsMutation = typeof PluginsMutation.Type;

// ---------------------------------------------------------------------------
// Context and usage - what each app pays per new thread, and what it actually uses

export const ContextCategory = Schema.Struct({
  name: Schema.String,
  tokens: Schema.Number,
  /** used: in the window; free: remaining; buffer: compaction reserve; deferred: loaded on demand. */
  kind: Schema.Literals(["used", "free", "buffer", "deferred"]),
});
export type ContextCategory = typeof ContextCategory.Type;

export const McpContextCost = Schema.Struct({
  name: Schema.String,
  toolCount: Schema.Number,
  /** Tokens of tool definitions sent with every request. */
  loadedTokens: Schema.Number,
  /** Tokens of tool definitions kept out of the window until the agent searches for them. */
  deferredTokens: Schema.Number,
  tools: Schema.Array(
    Schema.Struct({ name: Schema.String, tokens: Schema.Number, loaded: Schema.Boolean }),
  ),
});
export type McpContextCost = typeof McpContextCost.Type;

export const AppContext = Schema.Struct({
  /** True only when measured with the provider's token counter; local estimates (both apps today) are false. */
  exact: Schema.Boolean,
  /** What an estimate covers, e.g. Codex: "MCP tools and skills only". */
  note: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  windowTokens: Schema.optional(Schema.Number),
  /** Tokens a new thread in this cwd starts with before the first message. */
  baselineTokens: Schema.Number,
  categories: Schema.Array(ContextCategory),
  mcpServers: Schema.Array(McpContextCost),
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      source: Schema.optional(Schema.String),
      tokens: Schema.Number,
    }),
  ),
  memoryFiles: Schema.Array(Schema.Struct({ path: Schema.String, tokens: Schema.Number })),
  error: Schema.optional(Schema.String),
});
export type AppContext = typeof AppContext.Type;

export const ContextOverview = Schema.Struct({
  apps: Schema.Struct({ claude: Schema.optional(AppContext), codex: Schema.optional(AppContext) }),
  checkedAt: Schema.String,
});
export type ContextOverview = typeof ContextOverview.Type;

export const UsageStat = Schema.Struct({
  name: Schema.String,
  calls: Schema.Number,
  lastUsedAt: Schema.optional(Schema.String),
});
export type UsageStat = typeof UsageStat.Type;

export const AppUsage = Schema.Struct({
  mcpServers: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      calls: Schema.Number,
      lastUsedAt: Schema.optional(Schema.String),
      tools: Schema.Array(UsageStat),
    }),
  ),
  skills: Schema.Array(UsageStat),
  sessions: Schema.Number,
  scannedFiles: Schema.Number,
  scannedBytes: Schema.Number,
  error: Schema.optional(Schema.String),
});
export type AppUsage = typeof AppUsage.Type;

/** Calls counted from the apps' own local transcripts (T3 threads and CLI sessions alike). */
export const UsageReport = Schema.Struct({
  days: Schema.Number,
  apps: Schema.Struct({ claude: AppUsage, codex: AppUsage }),
  scannedAt: Schema.String,
});
export type UsageReport = typeof UsageReport.Type;

// ---------------------------------------------------------------------------
// Methods

const CwdInput = Schema.Struct({ cwd: Schema.optional(Schema.String) });

export const SkillsMcpExtension = defineExtension(SKILLS_MCP_EXTENSION_ID, {
  "mcp.list": { input: McpListInput, output: McpOverview },
  "mcp.mutate": { input: McpMutation, output: MutationResult },
  "mcp.presets": { input: Schema.Struct({}), output: Schema.Array(McpPreset) },
  "skills.list": { input: CwdInput, output: SkillsOverview },
  "skills.search": {
    input: Schema.Struct({ query: Schema.String, limit: Schema.optional(Schema.Number) }),
    output: Schema.Array(SkillSearchResult),
  },
  "skills.discover": {
    input: Schema.Struct({ repo: Schema.optional(SkillRepo) }),
    output: Schema.Array(DiscoverableSkill),
  },
  "skills.mutate": { input: SkillsMutation, output: MutationResult },
  "plugins.list": {
    input: Schema.Struct({
      cwd: Schema.optional(Schema.String),
      includeAvailable: Schema.optional(Schema.Boolean),
    }),
    output: PluginsOverview,
  },
  "plugins.mutate": { input: PluginsMutation, output: MutationResult },
  "context.get": {
    input: Schema.Struct({
      cwd: Schema.optional(Schema.String),
      refresh: Schema.optional(Schema.Boolean),
    }),
    output: ContextOverview,
  },
  "usage.get": {
    input: Schema.Struct({
      /** Look-back window, 1-90 days. */
      days: Schema.Number,
      refresh: Schema.optional(Schema.Boolean),
    }),
    output: UsageReport,
  },
});
export type SkillsMcpMethods = typeof SkillsMcpExtension.methods;
