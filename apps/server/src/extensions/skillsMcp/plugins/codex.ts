/**
 * Codex plugins, through a short-lived `codex app-server` (the client T3's
 * Codex provider uses). `codex plugin` on the command line has no JSON output
 * and no enable/disable/update, while the app-server exposes all of it:
 *
 * - `plugin/list` (marketplaces with install/enable state), `plugin/read`
 *   (skills, MCP servers, description);
 * - `plugin/install`, `plugin/uninstall`;
 * - enable/disable is `plugins."<id>".enabled` in `config.toml`, written with
 *   `config/batchWrite` exactly as Codex's own UI does;
 * - update = `marketplace/upgrade` + reinstalling the newer version. Codex's
 *   app-server already re-syncs plugins installed from *local* marketplaces to
 *   the marketplace copy by itself (seen with codex-cli 0.157.0), so update
 *   mostly matters for git/remote marketplaces.
 *
 * Codex plugins bundle skills, MCP servers, hooks and connector apps; they have
 * no slash commands or subagents, so those stay empty.
 *
 * `plugin/list` reports the marketplace's version, not the installed one, so
 * the installed version comes from Codex's plugin cache on disk.
 */
import * as NodeOS from "node:os";

import type { PluginRow, PluginsMutation } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  type AgentCli,
  type CodexAppServerClient,
  describeCause,
  withCodexClient,
} from "../shared/agents.ts";
import { ExtensionFailure } from "../shared/t3.ts";
import {
  byName,
  decodeEach,
  emptyContributes,
  listDirectory,
  nonEmpty,
  readJsonFile,
  uniqueNames,
} from "./common.ts";
import type { PluginContributes } from "./common.ts";

const READ_TIMEOUT = Duration.seconds(15);
const MUTATION_TIMEOUT = Duration.minutes(3);

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));
const OptionalUnknownArray = Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown)));

// ---------------------------------------------------------------------------
// `plugin/list`

const PluginInterface = Schema.Struct({
  displayName: OptionalString,
  shortDescription: OptionalString,
  longDescription: OptionalString,
});
const PluginSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: OptionalString,
  localVersion: OptionalString,
  installed: OptionalBoolean,
  enabled: OptionalBoolean,
  installPolicy: OptionalString,
  availability: OptionalString,
  interface: Schema.optional(Schema.Unknown),
});
const Marketplace = Schema.Struct({
  name: Schema.String,
  path: OptionalString,
  plugins: OptionalUnknownArray,
});
const ListResult = Schema.Struct({ marketplaces: Schema.Array(Schema.Unknown) });
const decodePluginInterface = Schema.decodeUnknownOption(PluginInterface);
const decodePluginSummary = Schema.decodeUnknownOption(PluginSummary);
const decodeMarketplace = Schema.decodeUnknownOption(Marketplace);
const decodeListResult = Schema.decodeUnknownOption(ListResult);

export interface CodexPlugin {
  /** `name@marketplace`, Codex's own plugin id. */
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  /** Local marketplaces have a manifest path; remote ones are addressed by name. */
  readonly marketplacePath: string | undefined;
  /** The marketplace's version: `version` for remote plugins, `localVersion` for local ones. */
  readonly latestVersion: string | undefined;
  readonly installed: boolean;
  readonly enabled: boolean;
  /** False when the marketplace or an admin does not let this plugin be installed. */
  readonly installable: boolean;
  readonly description: string | undefined;
}

export const codexPluginsFromList = (result: unknown): CodexPlugin[] | undefined => {
  const list = decodeListResult(result);
  if (Option.isNone(list)) return undefined;
  const plugins = new Map<string, CodexPlugin>();
  for (const marketplace of decodeEach(list.value.marketplaces, decodeMarketplace)) {
    for (const summary of decodeEach(marketplace.plugins, decodePluginSummary)) {
      if (plugins.has(summary.id)) continue;
      const face = Option.getOrUndefined(decodePluginInterface(summary.interface));
      const installed = summary.installed ?? false;
      plugins.set(summary.id, {
        id: summary.id,
        name: summary.name,
        marketplace: marketplace.name,
        marketplacePath: nonEmpty(marketplace.path),
        latestVersion: nonEmpty(summary.version) ?? nonEmpty(summary.localVersion),
        installed,
        enabled: installed && (summary.enabled ?? false),
        installable:
          summary.installPolicy !== "NOT_AVAILABLE" && summary.availability !== "DISABLED_BY_ADMIN",
        description: nonEmpty(face?.shortDescription) ?? nonEmpty(face?.longDescription),
      });
    }
  }
  return [...plugins.values()];
};

/** The `pluginName` + marketplace pair every `plugin/*` request takes. */
export const codexPluginLocator = (plugin: CodexPlugin) =>
  plugin.marketplacePath
    ? { pluginName: plugin.name, marketplacePath: plugin.marketplacePath }
    : { pluginName: plugin.name, remoteMarketplaceName: plugin.marketplace };

// ---------------------------------------------------------------------------
// `plugin/read`

const ReadResult = Schema.Struct({
  plugin: Schema.Struct({
    description: OptionalString,
    skills: OptionalUnknownArray,
    mcpServers: OptionalUnknownArray,
  }),
});
const NamedItem = Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })]);
const decodeReadResult = Schema.decodeUnknownOption(ReadResult);
const decodeNamedItem = Schema.decodeUnknownOption(NamedItem);

/** Codex namespaces a plugin's skills as `plugin:skill`; the panel shows the skill name. */
const stripNamespace = (name: string) => {
  const colon = name.indexOf(":");
  return colon >= 0 ? name.slice(colon + 1) : name;
};

export interface CodexPluginDetail {
  readonly description: string | undefined;
  readonly contributes: PluginContributes;
}

export const codexDetailFromRead = (result: unknown): CodexPluginDetail | undefined => {
  const read = decodeReadResult(result);
  if (Option.isNone(read)) return undefined;
  const names = (items: ReadonlyArray<unknown> | null | undefined) =>
    decodeEach(items, decodeNamedItem).map((item) => (Predicate.isString(item) ? item : item.name));
  return {
    description: nonEmpty(read.value.plugin.description),
    contributes: {
      ...emptyContributes(),
      skills: uniqueNames(names(read.value.plugin.skills).map(stripNamespace)),
      mcpServers: uniqueNames(names(read.value.plugin.mcpServers)),
    },
  };
};

// ---------------------------------------------------------------------------
// Installed versions (Codex's plugin cache)

const byVersionDescending = (a: string, b: string) =>
  b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });

/** The installed copy: the marketplace's version when cached, else the newest cached one. */
export const pickInstalledVersion = (
  cachedVersions: ReadonlyArray<string>,
  latestVersion: string | undefined,
): string | undefined => {
  if (latestVersion && cachedVersions.includes(latestVersion)) return latestVersion;
  return cachedVersions.toSorted(byVersionDescending).at(0);
};

/** Undefined unless both the installed and the marketplace version are known. */
export const codexUpdateAvailable = (
  plugin: CodexPlugin,
  installedVersion: string | undefined,
): boolean | undefined =>
  plugin.installed && installedVersion && plugin.latestVersion
    ? installedVersion !== plugin.latestVersion
    : undefined;

const decodeVersionManifest = Schema.decodeUnknownOption(
  Schema.Struct({ version: OptionalString }),
);

/**
 * `<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>/`: the manifest's
 * version, else the directory name (remote plugins use `<version>-<sha>`).
 */
const readInstalledVersion = Effect.fn("skillsMcp.plugins.codex.readInstalledVersion")(function* (
  cli: AgentCli,
  plugin: CodexPlugin,
) {
  const path = yield* Path.Path;
  const root = path.join(cli.configDir, "plugins", "cache", plugin.marketplace, plugin.name);
  const entries = (yield* listDirectory(root)).filter((entry) => entry.type === "Directory");
  const versions = yield* Effect.forEach(entries, (entry) =>
    readJsonFile(path.join(root, entry.name, ".codex-plugin", "plugin.json")).pipe(
      Effect.map(
        (manifest) =>
          nonEmpty(
            Option.getOrUndefined(Option.flatMap(manifest, decodeVersionManifest))?.version,
          ) ?? entry.name,
      ),
    ),
  );
  return pickInstalledVersion(uniqueNames(versions), plugin.latestVersion);
});

// ---------------------------------------------------------------------------
// Requests

const request = (client: CodexAppServerClient, method: string, payload: unknown, what: string) =>
  client.raw
    .request(method, payload)
    .pipe(
      Effect.mapError(
        (cause) =>
          new ExtensionFailure({ message: `Codex ${what}: ${describeCause(cause)}`, cause }),
      ),
    );

const listWith = Effect.fn("skillsMcp.plugins.codex.listWith")(function* (
  client: CodexAppServerClient,
  cwd: string,
) {
  const result = yield* request(client, "plugin/list", { cwds: [cwd] }, "could not list plugins");
  const plugins = codexPluginsFromList(result);
  if (!plugins) {
    return yield* new ExtensionFailure({ message: "Could not read Codex `plugin/list` result" });
  }
  return plugins;
});

/** Best effort: a plugin whose manifest will not load still gets a row. */
const readDetail = (client: CodexAppServerClient, plugin: CodexPlugin) =>
  client.raw.request("plugin/read", codexPluginLocator(plugin)).pipe(
    Effect.map(codexDetailFromRead),
    Effect.timeoutOption(READ_TIMEOUT),
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );

const pluginRow = Effect.fn("skillsMcp.plugins.codex.pluginRow")(function* (
  cli: AgentCli,
  client: CodexAppServerClient,
  plugin: CodexPlugin,
) {
  const detail = yield* readDetail(client, plugin);
  const installedVersion = plugin.installed ? yield* readInstalledVersion(cli, plugin) : undefined;
  return {
    app: "codex",
    id: plugin.id,
    name: plugin.name,
    marketplace: plugin.marketplace,
    version: installedVersion ?? plugin.latestVersion,
    description: detail?.description ?? plugin.description,
    installed: plugin.installed,
    enabled: plugin.enabled,
    updateAvailable: codexUpdateAvailable(plugin, installedVersion),
    contributes: detail?.contributes ?? emptyContributes(),
  } satisfies PluginRow;
});

const listRows = Effect.fn("skillsMcp.plugins.codex.listRows")(function* (
  cli: AgentCli,
  client: CodexAppServerClient,
  cwd: string,
  includeAvailable: boolean,
) {
  const plugins = yield* listWith(client, cwd);
  const wanted = plugins.filter(
    (plugin) => plugin.installed || (includeAvailable && plugin.installable),
  );
  const rows = yield* Effect.forEach(wanted, (plugin) => pluginRow(cli, client, plugin), {
    concurrency: 8,
  });
  return {
    installed: rows.filter((row) => row.installed).toSorted(byName),
    available: includeAvailable ? rows.filter((row) => !row.installed).toSorted(byName) : [],
  };
});

export const listCodexPlugins = (cli: AgentCli, cwd: string, includeAvailable: boolean) =>
  withCodexClient(cli, cwd, (client) => listRows(cli, client, cwd, includeAvailable));

// ---------------------------------------------------------------------------
// Mutations

const findPlugin = Effect.fn("skillsMcp.plugins.codex.findPlugin")(function* (
  client: CodexAppServerClient,
  id: string,
) {
  const plugin = (yield* listWith(client, NodeOS.homedir())).find(
    (candidate) => candidate.id === id,
  );
  if (!plugin) {
    return yield* new ExtensionFailure({
      message: `Codex has no plugin ${id} in its configured marketplaces`,
    });
  }
  return plugin;
});

const InstallResult = Schema.Struct({
  appsNeedingAuth: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ name: OptionalString, id: OptionalString }))),
  ),
});
const decodeInstallResult = Schema.decodeUnknownOption(InstallResult);

/** Connector apps the plugin needs signed in before its tools work. */
export const appsNeedingAuth = (result: unknown): string[] =>
  uniqueNames(
    (Option.getOrUndefined(decodeInstallResult(result))?.appsNeedingAuth ?? []).flatMap(
      (app) => nonEmpty(app.name) ?? nonEmpty(app.id) ?? [],
    ),
  );

const authNote = (apps: ReadonlyArray<string>) =>
  apps.length === 0 ? "" : ` Sign in to ${apps.join(", ")} in Codex to use its tools.`;

const install = (client: CodexAppServerClient, plugin: CodexPlugin, what: string) =>
  request(client, "plugin/install", codexPluginLocator(plugin), what).pipe(
    Effect.map(appsNeedingAuth),
  );

const setEnabled = Effect.fn("skillsMcp.plugins.codex.setEnabled")(function* (
  client: CodexAppServerClient,
  plugin: CodexPlugin,
  enabled: boolean,
) {
  yield* request(
    client,
    "config/batchWrite",
    {
      edits: [{ keyPath: "plugins", value: { [plugin.id]: { enabled } }, mergeStrategy: "upsert" }],
      reloadUserConfig: true,
    },
    `could not ${enabled ? "enable" : "disable"} ${plugin.id}`,
  );
});

const mutateWith = Effect.fn("skillsMcp.plugins.codex.mutateWith")(function* (
  cli: AgentCli,
  client: CodexAppServerClient,
  mutation: PluginsMutation,
) {
  const plugin = yield* findPlugin(client, mutation.id);
  const notInstalled = new ExtensionFailure({
    message: `Codex plugin ${plugin.id} is not installed`,
  });

  switch (mutation.action) {
    case "install": {
      if (plugin.installed) return `Codex plugin ${plugin.id} is already installed`;
      if (!plugin.installable) {
        return yield* new ExtensionFailure({
          message: `Codex marketplace ${plugin.marketplace} does not allow installing ${plugin.name}`,
        });
      }
      const apps = yield* install(client, plugin, `could not install ${plugin.id}`);
      return `Installed Codex plugin ${plugin.id}.${authNote(apps)}`;
    }
    case "uninstall": {
      // Codex answers `{}` for a plugin that is not installed, so check first.
      if (!plugin.installed) return yield* notInstalled;
      yield* request(
        client,
        "plugin/uninstall",
        { pluginId: plugin.id },
        `could not uninstall ${plugin.id}`,
      );
      return `Uninstalled Codex plugin ${plugin.id}`;
    }
    case "enable":
    case "disable": {
      if (!plugin.installed) return yield* notInstalled;
      const enabled = mutation.action === "enable";
      if (plugin.enabled === enabled)
        return `Codex plugin ${plugin.id} is already ${mutation.action}d`;
      yield* setEnabled(client, plugin, enabled);
      const after = yield* findPlugin(client, plugin.id);
      if (after.enabled !== enabled) {
        return yield* new ExtensionFailure({
          message: `Codex still reports ${plugin.id} as ${after.enabled ? "enabled" : "disabled"}`,
        });
      }
      return `${enabled ? "Enabled" : "Disabled"} Codex plugin ${plugin.id}`;
    }
    case "update": {
      if (!plugin.installed) return yield* notInstalled;
      // Refreshes git/remote marketplaces; local directories have nothing to pull.
      yield* request(
        client,
        "marketplace/upgrade",
        { marketplaceName: plugin.marketplace },
        "could not refresh the marketplace",
      ).pipe(Effect.ignore);
      const latest = yield* findPlugin(client, plugin.id);
      const before = yield* readInstalledVersion(cli, latest);
      if (before && latest.latestVersion && before === latest.latestVersion) {
        return `Codex plugin ${plugin.id} is already at the latest version (${before})`;
      }
      const apps = yield* install(client, latest, `could not update ${plugin.id}`);
      // Reinstalling re-enables the plugin; keep it disabled if it was.
      if (!plugin.enabled) yield* setEnabled(client, latest, false);
      const after = yield* readInstalledVersion(cli, latest);
      const change = before && after && before !== after ? ` from ${before} to ${after}` : "";
      return `Updated Codex plugin ${plugin.id}${change}. Start a new thread to use it.${authNote(apps)}`;
    }
  }
});

/** Runs one mutation; resolves to a toast message, fails with Codex's reason. */
export const mutateCodexPlugin = (cli: AgentCli, mutation: PluginsMutation) =>
  withCodexClient(cli, NodeOS.homedir(), (client) => mutateWith(cli, client, mutation)).pipe(
    Effect.timeoutOrElse({
      duration: MUTATION_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new ExtensionFailure({ message: `Codex timed out: ${mutation.action} ${mutation.id}` }),
        ),
    }),
  );
