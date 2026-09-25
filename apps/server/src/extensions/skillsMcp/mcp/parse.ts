/**
 * Pure parsers from each app's config files and live-status payloads into two
 * shapes the row builder merges by name: `ConfigServer` (a definition) and
 * `LiveServer` (what the running app reports).
 */
import type {
  AgentApp,
  McpLiveStatus,
  McpScope,
  McpServerSpec,
  McpToolInfo,
} from "@t3tools/contracts";

import { isRecord, type JsonObject, specFromClaude, specFromCodex } from "./spec.ts";

/** One server definition found in an app's config. */
export interface ConfigServer {
  readonly app: AgentApp;
  readonly name: string;
  readonly scope: McpScope;
  /** Config file (or plugin id) the definition came from. */
  readonly source?: string | undefined;
  /** The raw entry, so imports can keep fields the spec does not model. */
  readonly entry: JsonObject;
  /** Undefined for transports the contract does not model. */
  readonly spec: McpServerSpec | undefined;
  /** Switched off in the app's config (Codex `enabled = false`, Claude per-project toggles). */
  readonly disabled: boolean;
}

/** One server as the running app reports it. */
export interface LiveServer {
  readonly name: string;
  readonly scope?: McpScope | undefined;
  readonly source?: string | undefined;
  readonly status: McpLiveStatus;
  readonly error?: string | undefined;
  readonly serverVersion?: string | undefined;
  readonly tools?: ReadonlyArray<McpToolInfo> | undefined;
}

const stringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const booleanOrUndefined = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const toolInfo = (
  name: string,
  description: unknown,
  flags: {
    readonly readOnly: unknown;
    readonly destructive: unknown;
    readonly openWorld: unknown;
  },
): McpToolInfo => {
  const readOnly = booleanOrUndefined(flags.readOnly);
  const destructive = booleanOrUndefined(flags.destructive);
  const openWorld = booleanOrUndefined(flags.openWorld);
  const text = nonEmpty(description);
  return {
    name,
    ...(text ? { description: text } : {}),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(destructive === undefined ? {} : { destructive }),
    ...(openWorld === undefined ? {} : { openWorld }),
  };
};

// ---------------------------------------------------------------------------
// Claude

export interface ClaudeConfigInput {
  /** Parsed `.claude.json`, or undefined when missing/unreadable. */
  readonly claudeJson: unknown;
  readonly claudeJsonPath: string;
  /**
   * The `.mcp.json` files Claude loads for the cwd (it walks up to the
   * filesystem root), closest first; a closer file's server wins.
   */
  readonly projectMcpJsons: ReadonlyArray<{ readonly path: string; readonly json: unknown }>;
  /**
   * The `projects` keys for the cwd: the one Claude uses (see
   * `claudeProject`) and any older cwd-shaped keys.
   */
  readonly cwdKeys: ReadonlyArray<string>;
}

/**
 * Claude's user (`mcpServers`), local (`projects[key].mcpServers`) and
 * project (`.mcp.json`) servers. A server is disabled when the project
 * lists it in `disabledMcpServers` (Claude's per-project toggle) or, for
 * `.mcp.json` servers, in `disabledMcpjsonServers`.
 */
export const parseClaudeConfig = (input: ClaudeConfigInput): ReadonlyArray<ConfigServer> => {
  const root = isRecord(input.claudeJson) ? input.claudeJson : {};
  const projects = isRecord(root.projects) ? root.projects : {};
  const projectEntries = input.cwdKeys
    .map((key) => projects[key])
    .filter((entry): entry is JsonObject => isRecord(entry));
  const disabled = new Set(projectEntries.flatMap((entry) => stringList(entry.disabledMcpServers)));
  const disabledMcpJson = new Set(
    projectEntries.flatMap((entry) => stringList(entry.disabledMcpjsonServers)),
  );

  const servers: ConfigServer[] = [];
  const seen = new Set<string>();
  const add = (scope: McpScope, source: string | undefined, table: unknown) => {
    if (!isRecord(table)) return;
    for (const [name, entry] of Object.entries(table)) {
      if (!isRecord(entry) || seen.has(`${scope}:${name}`)) continue;
      seen.add(`${scope}:${name}`);
      servers.push({
        app: "claude",
        name,
        scope,
        ...(source ? { source } : {}),
        entry,
        spec: specFromClaude(entry),
        disabled: disabled.has(name) || (scope === "project" && disabledMcpJson.has(name)),
      });
    }
  };
  add("user", input.claudeJsonPath, root.mcpServers);
  for (const entry of projectEntries) add("local", input.claudeJsonPath, entry.mcpServers);
  for (const file of input.projectMcpJsons) {
    if (isRecord(file.json)) add("project", file.path, file.json.mcpServers);
  }
  return servers;
};

/** Minimal structural view of the SDK's `McpServerStatus`. */
export interface ClaudeServerStatus {
  readonly name: string;
  readonly status: string;
  readonly error?: string | undefined;
  readonly scope?: string | undefined;
  readonly serverInfo?: { readonly version?: string | undefined } | undefined;
  readonly tools?:
    | ReadonlyArray<{
        readonly name: string;
        readonly description?: string | undefined;
        readonly annotations?:
          | {
              readonly readOnly?: boolean | undefined;
              readonly destructive?: boolean | undefined;
              readonly openWorld?: boolean | undefined;
            }
          | undefined;
      }>
    | undefined;
}

const CLAUDE_STATUSES: Readonly<Record<string, McpLiveStatus>> = {
  connected: "connected",
  failed: "failed",
  "needs-auth": "needs-auth",
  pending: "pending",
  disabled: "disabled",
};

const claudeScope = (scope: string | undefined): { scope: McpScope; source?: string } => {
  switch (scope) {
    case "user":
    case "project":
    case "local":
    case "plugin":
    case "managed":
      return { scope };
    case "claudeai":
      return { scope: "managed", source: "claude.ai" };
    case "enterprise":
      return { scope: "managed", source: "enterprise" };
    default:
      return { scope: "unknown" };
  }
};

/** One entry of `query.mcpServerStatus()`. */
export const claudeLiveServer = (status: ClaudeServerStatus): LiveServer => {
  const { scope, source } = claudeScope(status.scope);
  const version = nonEmpty(status.serverInfo?.version);
  const error = nonEmpty(status.error);
  return {
    name: status.name,
    scope,
    ...(source ? { source } : {}),
    status: CLAUDE_STATUSES[status.status] ?? "unknown",
    ...(error ? { error } : {}),
    ...(version ? { serverVersion: version } : {}),
    ...(status.tools
      ? {
          tools: status.tools.map((tool) =>
            toolInfo(tool.name, tool.description, {
              readOnly: tool.annotations?.readOnly,
              destructive: tool.annotations?.destructive,
              openWorld: tool.annotations?.openWorld,
            }),
          ),
        }
      : {}),
  };
};

// ---------------------------------------------------------------------------
// Codex

const codexLayerScope = (layer: unknown): { scope: McpScope; source?: string } => {
  if (!isRecord(layer)) return { scope: "unknown" };
  const source = nonEmpty(layer.file) ?? nonEmpty(layer.dotCodexFolder);
  const withSource = (scope: McpScope) => (source ? { scope, source } : { scope });
  switch (layer.type) {
    case "user":
      return withSource("user");
    case "project":
      return withSource("project");
    case "system":
    case "mdm":
    case "enterpriseManaged":
    case "legacyManagedConfigTomlFromFile":
    case "legacyManagedConfigTomlFromMdm":
      return withSource("managed");
    default:
      return withSource("unknown");
  }
};

/**
 * `config/read` → Codex's `mcp_servers` tables. `origins` maps every leaf key
 * (`mcp_servers.<name>.args.0`, ...) to its config layer; the layer that set
 * `command`/`url` decides the scope.
 */
export const parseCodexConfig = (response: unknown): ReadonlyArray<ConfigServer> => {
  if (!isRecord(response) || !isRecord(response.config)) return [];
  const table = response.config.mcp_servers;
  if (!isRecord(table)) return [];
  const origins = isRecord(response.origins) ? response.origins : {};
  const layerOf = (name: string): unknown => {
    const prefix = `mcp_servers.${name}.`;
    const origin =
      origins[`${prefix}command`] ??
      origins[`${prefix}url`] ??
      Object.entries(origins).find(([key]) => key.startsWith(prefix))?.[1];
    return isRecord(origin) ? origin.name : undefined;
  };
  return Object.entries(table).flatMap(([name, entry]): ConfigServer[] => {
    if (!isRecord(entry)) return [];
    const { scope, source } = codexLayerScope(layerOf(name));
    return [
      {
        app: "codex",
        name,
        scope,
        ...(source ? { source } : {}),
        entry,
        spec: specFromCodex(entry),
        disabled: entry.enabled === false,
      },
    ];
  });
};

const CODEX_RUNTIME_STATUSES: Readonly<Record<string, McpLiveStatus>> = {
  notStarted: "not-started",
  starting: "pending",
  connected: "connected",
  ready: "connected",
  authenticationRequired: "needs-auth",
  failed: "failed",
  cancelled: "failed",
  disabled: "disabled",
};

/**
 * `mcpServerStatus/list {detail: "full"}` pages → live servers. Without a
 * thread `runtimeStatus` is null, so the status is inferred from whether the
 * listing reached the server (server info or tools) or hit an error.
 */
export const parseCodexStatuses = (
  data: ReadonlyArray<unknown>,
  disabledNames: ReadonlySet<string>,
): ReadonlyArray<LiveServer> =>
  data.flatMap((item): LiveServer[] => {
    if (!isRecord(item) || typeof item.name !== "string") return [];
    const tools = isRecord(item.tools)
      ? Object.entries(item.tools).map(([key, tool]) => {
          const value = isRecord(tool) ? tool : {};
          const annotations = isRecord(value.annotations) ? value.annotations : {};
          return toolInfo(nonEmpty(value.name) ?? key, value.description, {
            readOnly: annotations.readOnlyHint,
            destructive: annotations.destructiveHint,
            openWorld: annotations.openWorldHint,
          });
        })
      : [];
    const serverInfo = isRecord(item.serverInfo) ? item.serverInfo : undefined;
    const version = nonEmpty(serverInfo?.version);
    const toolsError = nonEmpty(item.toolsError);
    const runtime =
      typeof item.runtimeStatus === "string"
        ? CODEX_RUNTIME_STATUSES[item.runtimeStatus]
        : undefined;
    const status: McpLiveStatus = disabledNames.has(item.name)
      ? "disabled"
      : (runtime ??
        (toolsError
          ? item.authStatus === "notLoggedIn"
            ? "needs-auth"
            : "failed"
          : serverInfo || tools.length > 0
            ? "connected"
            : "unknown"));
    const pluginId = nonEmpty(item.pluginId);
    return [
      {
        name: item.name,
        ...(pluginId ? { scope: "plugin" as const, source: pluginId } : {}),
        status,
        ...(toolsError ? { error: toolsError } : {}),
        ...(version ? { serverVersion: version } : {}),
        ...(status === "connected" || tools.length > 0 ? { tools } : {}),
      },
    ];
  });
