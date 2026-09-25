/**
 * Claude Code plugins, through Claude's own CLI (`claude plugin ...`).
 *
 * - List: `plugin list --json [--available]`, then per installed plugin
 *   `plugin details <id>` (skills/agents/MCP inventory) plus the plugin's
 *   files on disk (commands, agents, skills) for what `details` folds away.
 * - Mutations run at user scope with `--json`, so success and the CLI's own
 *   failure reason come back as one machine-readable line.
 * - `updateAvailable` compares the installed version with the local clone of
 *   its marketplace, so it is only as fresh as the last marketplace refresh;
 *   `update` refreshes that marketplace first.
 */
import * as NodeOS from "node:os";

import type { PluginRow, PluginsMutation } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { type AgentCli, type CommandOutput, runAgentCli, runAgentCliOk } from "../shared/agents.ts";
import { ExtensionFailure, expandHomePath } from "../shared/t3.ts";
import {
  byName,
  decodeEach,
  emptyContributes,
  listDirectory,
  nonEmpty,
  parseJsonOutput,
  readJsonFile,
  splitPluginId,
  uniqueNames,
} from "./common.ts";

const LIST_TIMEOUT = Duration.seconds(60);
const DETAILS_TIMEOUT = Duration.seconds(20);
const MUTATION_TIMEOUT = Duration.minutes(3);

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalUnknownArray = Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown)));

// ---------------------------------------------------------------------------
// `claude plugin list --json [--available]`

const InstalledEntry = Schema.Struct({
  id: Schema.String,
  version: OptionalString,
  scope: OptionalString,
  enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  installPath: OptionalString,
  mcpServers: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
});
const AvailableEntry = Schema.Struct({
  pluginId: Schema.String,
  name: OptionalString,
  description: OptionalString,
  marketplaceName: OptionalString,
  version: OptionalString,
});
const ListEnvelope = Schema.Struct({
  installed: OptionalUnknownArray,
  available: OptionalUnknownArray,
});
const decodeInstalledEntry = Schema.decodeUnknownOption(InstalledEntry);
const decodeAvailableEntry = Schema.decodeUnknownOption(AvailableEntry);
const decodeListEnvelope = Schema.decodeUnknownOption(ListEnvelope);

export interface ClaudeInstalledPlugin {
  readonly id: string;
  readonly name: string;
  readonly marketplace: string | undefined;
  readonly version: string | undefined;
  readonly enabled: boolean;
  readonly scope: string | undefined;
  readonly installPath: string | undefined;
  readonly mcpServers: ReadonlyArray<string>;
}

export interface ClaudePluginList {
  readonly installed: ReadonlyArray<ClaudeInstalledPlugin>;
  readonly available: ReadonlyArray<PluginRow>;
}

/**
 * `plugin list --json` prints an array of installed entries; with
 * `--available` it prints `{installed, available}`. A plugin installed at
 * several scopes appears once, preferring its user-scope entry.
 */
export const parseClaudePluginList = (stdout: string): ClaudePluginList | undefined => {
  const json = parseJsonOutput(stdout);
  if (Option.isNone(json)) return undefined;
  let installedItems: ReadonlyArray<unknown>;
  let availableItems: ReadonlyArray<unknown>;
  if (Array.isArray(json.value)) {
    installedItems = json.value;
    availableItems = [];
  } else {
    const envelope = decodeListEnvelope(json.value);
    if (Option.isNone(envelope)) return undefined;
    installedItems = envelope.value.installed ?? [];
    availableItems = envelope.value.available ?? [];
  }

  const installed = new Map<string, ClaudeInstalledPlugin>();
  for (const entry of decodeEach(installedItems, decodeInstalledEntry)) {
    const current = installed.get(entry.id);
    if (current && (current.scope === "user" || entry.scope !== "user")) continue;
    const { name, marketplace } = splitPluginId(entry.id);
    installed.set(entry.id, {
      id: entry.id,
      name,
      marketplace,
      version: nonEmpty(entry.version),
      enabled: entry.enabled ?? false,
      scope: nonEmpty(entry.scope),
      installPath: nonEmpty(entry.installPath),
      mcpServers: Object.keys(entry.mcpServers ?? {}),
    });
  }

  const available = new Map<string, PluginRow>();
  for (const entry of decodeEach(availableItems, decodeAvailableEntry)) {
    if (installed.has(entry.pluginId) || available.has(entry.pluginId)) continue;
    const parts = splitPluginId(entry.pluginId);
    available.set(entry.pluginId, {
      app: "claude",
      id: entry.pluginId,
      name: nonEmpty(entry.name) ?? parts.name,
      marketplace: nonEmpty(entry.marketplaceName) ?? parts.marketplace,
      version: nonEmpty(entry.version),
      description: nonEmpty(entry.description),
      installed: false,
      enabled: false,
      contributes: emptyContributes(),
    });
  }

  return {
    installed: [...installed.values()],
    available: [...available.values()].toSorted(byName),
  };
};

// ---------------------------------------------------------------------------
// `claude plugin details <id>`

export interface ClaudePluginDetails {
  readonly description: string | undefined;
  /** Claude folds a plugin's `commands/` files into its skills here. */
  readonly skills: ReadonlyArray<string>;
  readonly agents: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<string>;
  readonly commands: ReadonlyArray<string>;
  readonly hooks: ReadonlyArray<string>;
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const DESCRIPTION_LINE = /^\s*Description:\s*(.*)$/;
const INVENTORY_LINE =
  /^\s*(Skills|Agents|Hooks|MCP servers|LSP servers|Commands)\s*\((\d+)\)\s*(.*)$/;
const TRAILING_NOTE = /\s{2,}\(.*\)\s*$/;
const ELISION = /^(?:\+?\d+\s+more|\.\.\.|…)/i;

/** The "Component inventory" block of `plugin details`; undefined when there is none. */
export const parseClaudePluginDetails = (stdout: string): ClaudePluginDetails | undefined => {
  let description: string | undefined;
  const inventory = new Map<string, string[]>();
  for (const rawLine of stdout.replace(ANSI_ESCAPE, "").split(/\r?\n/)) {
    const descriptionMatch = description === undefined ? DESCRIPTION_LINE.exec(rawLine) : null;
    if (descriptionMatch) {
      description = nonEmpty(descriptionMatch[1]);
      continue;
    }
    const match = INVENTORY_LINE.exec(rawLine);
    if (!match || inventory.has(match[1]!)) continue;
    const names = (match[3] ?? "")
      .replace(TRAILING_NOTE, "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0 && !ELISION.test(name));
    inventory.set(match[1]!, uniqueNames(names));
  }
  if (inventory.size === 0) return undefined;
  return {
    description,
    skills: inventory.get("Skills") ?? [],
    agents: inventory.get("Agents") ?? [],
    mcpServers: inventory.get("MCP servers") ?? [],
    commands: inventory.get("Commands") ?? [],
    hooks: inventory.get("Hooks") ?? [],
  };
};

// ---------------------------------------------------------------------------
// Plugin files and marketplace clones

const PluginManifest = Schema.Struct({
  version: OptionalString,
  description: OptionalString,
  commands: Schema.optional(Schema.Unknown),
  agents: Schema.optional(Schema.Unknown),
  skills: Schema.optional(Schema.Unknown),
});
const decodePluginManifest = Schema.decodeUnknownOption(PluginManifest);

const KnownMarketplace = Schema.Struct({ installLocation: OptionalString });
const decodeKnownMarketplaces = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Unknown),
);
const decodeKnownMarketplace = Schema.decodeUnknownOption(KnownMarketplace);

const MarketplaceManifest = Schema.Struct({ plugins: OptionalUnknownArray });
const MarketplacePlugin = Schema.Struct({
  name: Schema.String,
  version: OptionalString,
  source: Schema.optional(Schema.Unknown),
});
const GitSource = Schema.Struct({ sha: OptionalString });
const decodeMarketplaceManifest = Schema.decodeUnknownOption(MarketplaceManifest);
const decodeMarketplacePlugin = Schema.decodeUnknownOption(MarketplacePlugin);
const decodeGitSource = Schema.decodeUnknownOption(GitSource);

/** `known_marketplaces.json` → marketplace name → local clone directory. */
export const parseKnownMarketplaces = (json: unknown): ReadonlyMap<string, string> => {
  const locations = new Map<string, string>();
  const entries = decodeKnownMarketplaces(json);
  if (Option.isNone(entries)) return locations;
  for (const [name, value] of Object.entries(entries.value)) {
    const location = Option.getOrUndefined(decodeKnownMarketplace(value))?.installLocation;
    const trimmed = nonEmpty(location);
    if (trimmed) locations.set(name, expandHomePath(trimmed));
  }
  return locations;
};

export interface MarketplaceLatest {
  readonly version?: string | undefined;
  /** Git sources pin a commit; plugins without a version are installed under its short sha. */
  readonly sha?: string | undefined;
  /** A `./relative` source whose own plugin.json carries the version. */
  readonly localSource?: string | undefined;
}

/** What a marketplace manifest says about one plugin; undefined when it is not listed. */
export const marketplaceLatest = (
  manifest: unknown,
  pluginName: string,
): MarketplaceLatest | undefined => {
  const plugins = Option.getOrUndefined(decodeMarketplaceManifest(manifest))?.plugins;
  const entry = decodeEach(plugins, decodeMarketplacePlugin).find(
    (plugin) => plugin.name === pluginName,
  );
  if (!entry) return undefined;
  const source = entry.source;
  return {
    version: nonEmpty(entry.version),
    sha: Predicate.isString(source)
      ? undefined
      : nonEmpty(Option.getOrUndefined(decodeGitSource(source))?.sha),
    localSource: Predicate.isString(source) && source.startsWith(".") ? source : undefined,
  };
};

const HEX_VERSION = /^[0-9a-f]{7,40}$/i;

/** Undefined when neither side says enough to tell. */
export const claudeUpdateAvailable = (
  installedVersion: string | undefined,
  latest: MarketplaceLatest | undefined,
): boolean | undefined => {
  if (!installedVersion || !latest) return undefined;
  if (latest.version) return latest.version !== installedVersion;
  if (latest.sha && HEX_VERSION.test(installedVersion)) {
    return !latest.sha.toLowerCase().startsWith(installedVersion.toLowerCase());
  }
  return undefined;
};

const declaredPaths = (value: unknown): string[] =>
  Predicate.isString(value)
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => Predicate.isString(item))
      : [];

const markdownNames = (dir: string) =>
  listDirectory(dir).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.type === "File" && entry.name.endsWith(".md"))
        .map((entry) => entry.name.slice(0, -3)),
    ),
  );

const directoryNames = (dir: string) =>
  listDirectory(dir).pipe(
    Effect.map((entries) =>
      entries.filter((entry) => entry.type === "Directory").map((entry) => entry.name),
    ),
  );

interface PluginFiles {
  readonly description: string | undefined;
  readonly commands: ReadonlyArray<string>;
  readonly agents: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
}

/**
 * Components from the plugin's install directory. Manifest paths supplement
 * the default `commands/`, `agents/` and `skills/` directories, as in Claude.
 */
const readPluginFiles = Effect.fn("skillsMcp.plugins.claude.readPluginFiles")(function* (
  root: string,
) {
  const path = yield* Path.Path;
  const manifest = Option.getOrUndefined(
    Option.flatMap(
      yield* readJsonFile(path.join(root, ".claude-plugin", "plugin.json")),
      decodePluginManifest,
    ),
  );
  const markdownComponents = (defaultDir: string, declared: unknown) =>
    Effect.forEach([defaultDir, ...declaredPaths(declared)], (relative) => {
      const target = path.resolve(root, relative);
      return target.endsWith(".md")
        ? Effect.succeed([path.basename(target, ".md")])
        : markdownNames(target);
    }).pipe(Effect.map((groups) => uniqueNames(groups.flat())));
  const commands = yield* markdownComponents("commands", manifest?.commands);
  const agents = yield* markdownComponents("agents", manifest?.agents);
  const skillGroups = yield* Effect.forEach(
    ["skills", ...declaredPaths(manifest?.skills)],
    (relative) => directoryNames(path.resolve(root, relative)),
  );
  return {
    description: nonEmpty(manifest?.description),
    commands,
    agents,
    skills: uniqueNames(skillGroups.flat()),
  } satisfies PluginFiles;
});

/** Newest version each installed plugin's marketplace clone offers, keyed by plugin id. */
const readMarketplaceLatest = Effect.fn("skillsMcp.plugins.claude.readMarketplaceLatest")(
  function* (cli: AgentCli, plugins: ReadonlyArray<ClaudeInstalledPlugin>) {
    const path = yield* Path.Path;
    const known = parseKnownMarketplaces(
      Option.getOrUndefined(
        yield* readJsonFile(path.join(cli.configDir, "plugins", "known_marketplaces.json")),
      ),
    );
    const manifests = new Map<string, unknown>();
    for (const marketplace of new Set(plugins.flatMap((plugin) => plugin.marketplace ?? []))) {
      const location = known.get(marketplace);
      if (!location) continue;
      const manifest = yield* readJsonFile(
        path.join(location, ".claude-plugin", "marketplace.json"),
      );
      if (Option.isSome(manifest)) manifests.set(marketplace, manifest.value);
    }

    const latest = new Map<string, MarketplaceLatest>();
    for (const plugin of plugins) {
      if (!plugin.marketplace || !manifests.has(plugin.marketplace)) continue;
      const entry = marketplaceLatest(manifests.get(plugin.marketplace), plugin.name);
      if (!entry) continue;
      const location = known.get(plugin.marketplace);
      if (!entry.version && entry.localSource && location) {
        const sourceManifest = yield* readJsonFile(
          path.join(path.resolve(location, entry.localSource), ".claude-plugin", "plugin.json"),
        );
        const version = nonEmpty(
          Option.getOrUndefined(Option.flatMap(sourceManifest, decodePluginManifest))?.version,
        );
        latest.set(plugin.id, { ...entry, version });
        continue;
      }
      latest.set(plugin.id, entry);
    }
    return latest;
  },
);

const detailsCache = new Map<string, ClaudePluginDetails>();

/** `plugin details`, uncoloured; cached per install since contributes only change with it. */
const readPluginDetails = Effect.fn("skillsMcp.plugins.claude.readPluginDetails")(function* (
  cli: AgentCli,
  plugin: ClaudeInstalledPlugin,
  cwd: string,
) {
  const cacheKey = [cli.configDir, plugin.id, plugin.version, plugin.installPath].join("\u0000");
  const cached = detailsCache.get(cacheKey);
  if (cached) return cached;
  const env = Object.fromEntries(
    Object.entries(cli.env).filter(([key]) => key !== "FORCE_COLOR"),
  ) as NodeJS.ProcessEnv;
  const output = yield* runAgentCli(
    { ...cli, env: { ...env, NO_COLOR: "1" } },
    ["plugin", "details", plugin.id],
    { cwd, timeout: DETAILS_TIMEOUT },
  ).pipe(Effect.option);
  const details =
    Option.isSome(output) && output.value.code === 0
      ? parseClaudePluginDetails(output.value.stdout)
      : undefined;
  if (details) detailsCache.set(cacheKey, details);
  return details;
});

const installedRow = Effect.fn("skillsMcp.plugins.claude.installedRow")(function* (
  cli: AgentCli,
  plugin: ClaudeInstalledPlugin,
  latest: MarketplaceLatest | undefined,
  cwd: string,
) {
  const details = yield* readPluginDetails(cli, plugin, cwd);
  const files: PluginFiles = plugin.installPath
    ? yield* readPluginFiles(plugin.installPath)
    : { description: undefined, commands: [], agents: [], skills: [] };
  const commands = uniqueNames([...files.commands, ...(details?.commands ?? [])]);
  const commandNames = new Set(commands);
  return {
    app: "claude",
    id: plugin.id,
    name: plugin.name,
    marketplace: plugin.marketplace,
    version: plugin.version,
    description: details?.description ?? files.description,
    installed: true,
    enabled: plugin.enabled,
    updateAvailable: claudeUpdateAvailable(plugin.version, latest),
    contributes: {
      skills: uniqueNames([...(details?.skills ?? []), ...files.skills]).filter(
        (name) => !commandNames.has(name),
      ),
      mcpServers: uniqueNames([...(details?.mcpServers ?? []), ...plugin.mcpServers]),
      commands,
      agents: uniqueNames([...(details?.agents ?? []), ...files.agents]),
    },
  } satisfies PluginRow;
});

export const listClaudePlugins = Effect.fn("skillsMcp.plugins.claude.list")(function* (
  cli: AgentCli,
  cwd: string,
  includeAvailable: boolean,
) {
  const args = ["plugin", "list", "--json", ...(includeAvailable ? ["--available"] : [])];
  const output = yield* runAgentCliOk(cli, args, { cwd, timeout: LIST_TIMEOUT });
  const parsed = parseClaudePluginList(output.stdout);
  if (!parsed) {
    return yield* new ExtensionFailure({
      message: `Could not read \`claude ${args.join(" ")}\` output`,
    });
  }
  const latest = yield* readMarketplaceLatest(cli, parsed.installed);
  const installed = yield* Effect.forEach(
    parsed.installed,
    (plugin) => installedRow(cli, plugin, latest.get(plugin.id), cwd),
    { concurrency: 4 },
  );
  return {
    installed: installed.toSorted(byName),
    available: includeAvailable ? parsed.available : [],
  };
});

// ---------------------------------------------------------------------------
// Mutations

const MutationLine = Schema.Struct({
  outcome: Schema.String,
  failureCode: OptionalString,
  message: OptionalString,
  shownCommand: Schema.optional(Schema.Unknown),
});
const decodeMutationLine = Schema.decodeUnknownOption(MutationLine);

export const claudeMutationArgs = (
  action: PluginsMutation["action"],
  id: string,
): ReadonlyArray<string> => ["plugin", action, id, "--scope", "user", "--json"];

export interface ClaudeMutationOutcome {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Reads the `--json` result line. Asking for the state a plugin is already
 * in (`already_in_goal_state`) counts as success.
 */
export const parseClaudeMutationOutput = (
  output: CommandOutput,
  mutation: PluginsMutation,
): ClaudeMutationOutcome => {
  const line = output.stdout
    .split(/\r?\n/)
    .flatMap((text) => Option.toArray(Option.flatMap(parseJsonOutput(text), decodeMutationLine)))
    .at(0);
  const alreadyDone = line?.failureCode === "already_in_goal_state";
  const ok = alreadyDone || (output.code === 0 && line?.outcome !== "failed");
  if (ok) {
    return {
      ok,
      message: nonEmpty(line?.message) ?? `Claude: ${mutation.action} ${mutation.id} done`,
    };
  }
  const reason =
    nonEmpty(line?.message) ??
    nonEmpty(output.stderr) ??
    nonEmpty(output.stdout) ??
    `exit code ${output.code}`;
  // Plugins installed by running a marketplace-declared command need a person
  // to read that command first, so T3 never passes `-y` for them.
  const confirm =
    line?.shownCommand === undefined
      ? ""
      : ` This plugin runs a command declared by its marketplace; review and confirm it in a terminal with \`claude plugin ${mutation.action} ${mutation.id}\`.`;
  return { ok, message: `${reason}${confirm}` };
};

/** Runs one mutation; resolves to a toast message, fails with the CLI's reason. */
export const mutateClaudePlugin = Effect.fn("skillsMcp.plugins.claude.mutate")(function* (
  cli: AgentCli,
  mutation: PluginsMutation,
) {
  const cwd = NodeOS.homedir();
  const { marketplace } = splitPluginId(mutation.id);
  if (mutation.action === "update" && marketplace) {
    // Best effort: `update` only sees versions the local marketplace clone knows.
    yield* runAgentCli(cli, ["plugin", "marketplace", "update", marketplace], {
      cwd,
      timeout: MUTATION_TIMEOUT,
    }).pipe(Effect.ignore);
  }
  const output = yield* runAgentCli(cli, claudeMutationArgs(mutation.action, mutation.id), {
    cwd,
    timeout: MUTATION_TIMEOUT,
  });
  const outcome = parseClaudeMutationOutput(output, mutation);
  if (!outcome.ok) return yield* new ExtensionFailure({ message: outcome.message });
  return outcome.message;
});
