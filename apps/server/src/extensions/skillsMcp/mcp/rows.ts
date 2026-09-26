/**
 * Merges the store, both apps' config definitions and their live status into
 * the panel's rows: one row per server name, with a per-app entry.
 */
import {
  AGENT_APPS,
  type AgentApp,
  type McpAppEntry,
  type McpScope,
  type McpServerRow,
} from "@t3tools/contracts";

import type { ConfigServer, LiveServer } from "./parse.ts";
import type { StoredMcpServer } from "./store.ts";

export interface AppSnapshot {
  readonly config: ReadonlyArray<ConfigServer>;
  /** Undefined when the live probe did not run or failed. */
  readonly live: ReadonlyArray<LiveServer> | undefined;
}

export const APP_LABELS: Readonly<Record<AgentApp, string>> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** Claude loads the most specific definition of a name: local, then project, then user. */
const SCOPE_PRECEDENCE: ReadonlyArray<McpScope> = ["local", "project", "user"];
const precedence = (scope: McpScope) => {
  const index = SCOPE_PRECEDENCE.indexOf(scope);
  return index === -1 ? SCOPE_PRECEDENCE.length : index;
};

/** The definition an app actually loads for each name. */
export const effectiveConfig = (
  config: ReadonlyArray<ConfigServer>,
): ReadonlyMap<string, ConfigServer> => {
  const byName = new Map<string, ConfigServer>();
  for (const server of config) {
    const current = byName.get(server.name);
    if (!current || precedence(server.scope) < precedence(current.scope)) {
      byName.set(server.name, server);
    }
  }
  return byName;
};

interface AppView {
  readonly config: ReadonlyMap<string, ConfigServer>;
  readonly live: ReadonlyMap<string, LiveServer> | undefined;
}

const viewOf = (snapshot: AppSnapshot): AppView => ({
  config: effectiveConfig(snapshot.config),
  live: snapshot.live && new Map(snapshot.live.map((server) => [server.name, server])),
});

/** How one app sees a name, from its config and live status; undefined when it has neither. */
const observedEntry = (view: AppView, name: string): McpAppEntry | undefined => {
  const config = view.config.get(name);
  const live = view.live?.get(name);
  if (!config && !live) return undefined;
  const scope = config?.scope ?? live?.scope ?? "unknown";
  const source = config?.source ?? live?.source;
  const status = config?.disabled ? "disabled" : (live?.status ?? "unknown");
  return {
    present: true,
    enabled: status !== "disabled",
    scope,
    ...(source ? { source } : {}),
    status,
    ...(live?.error ? { error: live.error } : {}),
    ...(live?.serverVersion ? { serverVersion: live.serverVersion } : {}),
    ...(live?.tools ? { tools: live.tools } : {}),
    editable: scope === "user",
  };
};

/** A managed server's entry: the app's view plus the store's desired flag. */
const managedEntry = (
  app: AgentApp,
  view: AppView,
  server: StoredMcpServer,
): McpAppEntry | undefined => {
  if (app === "codex" && server.spec.type === "sse" && !server.raw?.codex) {
    return {
      present: false,
      enabled: false,
      scope: "user",
      status: "disabled",
      error: "Codex has no SSE transport",
      editable: false,
    };
  }
  const desired = server.apps[app];
  const observed = observedEntry(view, server.name);
  if (observed) return { ...observed, enabled: desired, editable: true };
  if (!desired) {
    return { present: false, enabled: false, scope: "user", status: "disabled", editable: true };
  }
  return {
    present: false,
    enabled: true,
    scope: "user",
    status: "unknown",
    error: `Missing from ${APP_LABELS[app]} config`,
    editable: true,
  };
};

const byNameThenKey = (a: McpServerRow, b: McpServerRow) =>
  Number(b.builtin) - Number(a.builtin) ||
  a.name.localeCompare(b.name) ||
  a.key.localeCompare(b.key);

export interface BuildRowsInput {
  readonly store: ReadonlyArray<StoredMcpServer>;
  readonly apps: Readonly<Record<AgentApp, AppSnapshot>>;
  readonly builtin?: McpServerRow | undefined;
}

/**
 * Managed rows come from the store (key = store id); every other name found in
 * either app's config or live status becomes an unmanaged row keyed
 * `<scope>:<name>`.
 */
export const buildRows = (input: BuildRowsInput): ReadonlyArray<McpServerRow> => {
  const views = { claude: viewOf(input.apps.claude), codex: viewOf(input.apps.codex) };
  const rows: McpServerRow[] = input.builtin ? [input.builtin] : [];

  const managedNames = new Set<string>();
  for (const server of input.store) {
    managedNames.add(server.name);
    const claude = managedEntry("claude", views.claude, server);
    const codex = managedEntry("codex", views.codex, server);
    rows.push({
      key: server.id,
      id: server.id,
      name: server.name,
      managed: true,
      builtin: false,
      spec: server.spec,
      ...(server.description ? { description: server.description } : {}),
      ...(server.homepage ? { homepage: server.homepage } : {}),
      tags: server.tags,
      apps: { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) },
    });
  }

  const names = new Set<string>();
  for (const app of AGENT_APPS) {
    for (const name of views[app].config.keys()) names.add(name);
    for (const name of views[app].live?.keys() ?? []) names.add(name);
  }
  for (const name of names) {
    if (managedNames.has(name)) continue;
    const claude = observedEntry(views.claude, name);
    const codex = observedEntry(views.codex, name);
    const spec = views.claude.config.get(name)?.spec ?? views.codex.config.get(name)?.spec;
    rows.push({
      key: `${claude?.scope ?? codex?.scope ?? "unknown"}:${name}`,
      name,
      managed: false,
      builtin: false,
      ...(spec ? { spec } : {}),
      tags: [],
      apps: { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) },
    });
  }
  return rows.toSorted(byNameThenKey);
};
