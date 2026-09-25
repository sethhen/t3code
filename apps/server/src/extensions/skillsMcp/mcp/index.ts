/**
 * `mcp.list` / `mcp.mutate` / `mcp.presets`: one panel over Claude Code's and
 * Codex's MCP servers. The store (`store.ts`) holds the user-scope servers the
 * panel manages with a desired per-app flag; each app's own config stays the
 * source of truth for what loads, and every write goes through the app's own
 * CLI or app-server. One app failing never hides the other: list errors land in
 * `liveProbe`, mutation errors come back as `failures`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import type {
  AgentApp,
  AgentAppInfo,
  LiveProbeState,
  McpMutation,
  McpOverview,
  McpPreset,
  McpServerSpec,
  MutationResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import type { SkillsMcpServices } from "../index.ts";
import { type AgentCli, agentAppInfo, resolveAgentClis, runAgentCliOk } from "../shared/agents.ts";
import { ExtensionFailure, ServerSettingsService } from "../shared/t3.ts";
import { BUILTIN_SERVER_NAME, type BuiltinAccess, builtinRow } from "./builtin.ts";
import {
  claudeRemoveUser,
  claudeReplaceUser,
  claudeSetProjectEnabled,
  readClaudeConfig,
  readClaudeUserEntry,
} from "./claude.ts";
import { applyCodexWrites, type CodexWrite, readCodexConfigServers } from "./codex.ts";
import {
  type ConfigServer,
  claudeLiveServer,
  parseCodexConfig,
  parseCodexStatuses,
} from "./parse.ts";
import { makeMcpPresets } from "./presets.ts";
import {
  codexSnapshot,
  invalidateClaudeProbes,
  invalidateCodexProbes,
  probeClaudeStatuses,
} from "./probes.ts";
import { APP_LABELS, type AppSnapshot, buildRows } from "./rows.ts";
import {
  claudeEntryFor,
  claudeExtras,
  codexEntryFor,
  codexExtras,
  type JsonObject,
  specFromClaude,
} from "./spec.ts";
import { mcpStore, type McpStore, type StoredMcpServer } from "./store.ts";
import { HostProcessPlatform } from "./t3.ts";

type Failure = MutationResult["failures"][number];
type Failures = ReadonlyArray<Failure>;

/** Names both apps accept (Codex uses the name as a TOML key path segment). */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const SSE_UNSUPPORTED = "Codex has no SSE transport";

/** Module-level: the handler registry is rebuilt per ws connection. */
const mutationLock = Semaphore.makeUnsafe(1);

const homeCwd = (cwd: string | undefined) => cwd?.trim() || NodeOS.homedir();

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const unavailableMessage = (info: AgentAppInfo) =>
  `${APP_LABELS[info.app]} CLI unavailable${info.error ? `: ${info.error}` : ""}`;

/** Runs one app's write, turning its failure into a `failures` entry. */
const attempt = <R>(app: AgentApp, effect: Effect.Effect<unknown, ExtensionFailure, R>) =>
  effect.pipe(
    Effect.as<Failures>([]),
    Effect.catch((failure) => Effect.succeed<Failures>([{ app, message: failure.message }])),
  );

/** JSON with sorted keys, to compare entries regardless of key order. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => a.localeCompare(b)))
      : inner,
  );

// ---------------------------------------------------------------------------
// Import

const isUserScope = (server: ConfigServer) => server.scope === "user" || server.scope === "unknown";

const firstByName = (servers: ReadonlyArray<ConfigServer>) => {
  const byName = new Map<string, ConfigServer>();
  for (const server of servers) if (!byName.has(server.name)) byName.set(server.name, server);
  return byName;
};

/**
 * Adopts every user-scope server in either app's config that the store does
 * not already have. Claude's definition wins when both apps have the name; an
 * app's extras are kept only when its transport matches the adopted spec.
 * Claude has no global off switch (its per-project toggles are not one), so a
 * Claude definition always imports as enabled; Codex honours `enabled = false`.
 */
export const adoptUserServers = (
  existing: ReadonlyArray<StoredMcpServer>,
  configs: Readonly<Record<AgentApp, ReadonlyArray<ConfigServer>>>,
  newId: () => string,
): { readonly servers: ReadonlyArray<StoredMcpServer>; readonly added: number } => {
  const claude = firstByName(configs.claude.filter(isUserScope));
  const codex = firstByName(configs.codex.filter(isUserScope));
  const taken = new Set(existing.map((server) => server.name));
  const added: StoredMcpServer[] = [];
  for (const name of new Set([...claude.keys(), ...codex.keys()])) {
    if (taken.has(name) || name === BUILTIN_SERVER_NAME || !NAME_PATTERN.test(name)) continue;
    const fromClaude = claude.get(name);
    const fromCodex = codex.get(name);
    const spec = fromClaude?.spec ?? fromCodex?.spec;
    if (!spec) continue;
    const claudeFields =
      fromClaude?.spec?.type === spec.type ? claudeExtras(fromClaude.entry) : undefined;
    const codexFields =
      fromCodex?.spec?.type === spec.type ? codexExtras(fromCodex.entry) : undefined;
    added.push({
      id: newId(),
      name,
      spec,
      apps: {
        claude: fromClaude !== undefined,
        codex: fromCodex !== undefined && !fromCodex.disabled && spec.type !== "sse",
      },
      tags: [],
      ...(claudeFields || codexFields
        ? {
            extras: {
              ...(claudeFields ? { claude: claudeFields } : {}),
              ...(codexFields ? { codex: codexFields } : {}),
            },
          }
        : {}),
    });
  }
  return { servers: [...existing, ...added], added: added.length };
};

const importInto = (current: McpStore, configs: Record<AgentApp, ReadonlyArray<ConfigServer>>) =>
  Effect.map(nowIso, (importedAt) => {
    const { servers, added } = adoptUserServers(current.servers, configs, () =>
      NodeCrypto.randomUUID(),
    );
    return [added, { ...current, importedAt, servers }] as const;
  });

// ---------------------------------------------------------------------------
// List

interface AppListing {
  readonly snapshot: AppSnapshot;
  readonly probe: LiveProbeState;
  /** Whether the app's config was read, so an auto-import sees everything. */
  readonly configRead: boolean;
}

const unavailableListing = (info: AgentAppInfo): AppListing => ({
  snapshot: { config: [], live: undefined },
  probe: { ok: false, error: unavailableMessage(info) },
  configRead: false,
});

const listClaude = Effect.fn("skillsMcp.mcp.listClaude")(function* (
  cli: AgentCli,
  cwd: string,
  refresh: boolean,
) {
  const [config, probe] = yield* Effect.all(
    [readClaudeConfig(cli, cwd), probeClaudeStatuses(cli, cwd, { refresh })],
    { concurrency: 2 },
  );
  return {
    snapshot: { config, live: probe.error ? undefined : probe.statuses.map(claudeLiveServer) },
    probe: {
      ok: !probe.error,
      ...(probe.error ? { error: probe.error } : {}),
      checkedAt: probe.checkedAt,
    },
    configRead: true,
  } satisfies AppListing;
});

const listCodex = Effect.fn("skillsMcp.mcp.listCodex")(function* (
  cli: AgentCli,
  cwd: string,
  refresh: boolean,
) {
  const snapshot = yield* codexSnapshot(cli, cwd, { refresh });
  const config = parseCodexConfig(snapshot.config);
  const disabledNames = new Set(
    config.filter((server) => server.disabled).map((server) => server.name),
  );
  return {
    snapshot: {
      config,
      live: snapshot.statuses ? parseCodexStatuses(snapshot.statuses, disabledNames) : undefined,
    },
    probe: {
      ok: !snapshot.error,
      ...(snapshot.error ? { error: snapshot.error } : {}),
      checkedAt: snapshot.checkedAt,
    },
    configRead: snapshot.config !== undefined,
  } satisfies AppListing;
});

/** Which optional `t3-code` toolkits the global agent-access settings turn on. */
const builtinAccess = Effect.gen(function* () {
  const settings = yield* (yield* ServerSettingsService).getSettings;
  return {
    browser: settings.enableAgentBrowserAccess,
    device: settings.enableAgentDeviceAccess,
  } satisfies BuiltinAccess;
}).pipe(
  Effect.catch((error) =>
    Effect.logWarning(`Could not read agent access settings: ${error.message}`).pipe(
      Effect.as<BuiltinAccess>({ browser: true, device: false }),
    ),
  ),
);

const listMcpEffect = Effect.fn("skillsMcp.mcp.list")(function* (input: {
  readonly cwd?: string | undefined;
  readonly refresh?: boolean | undefined;
}) {
  const cwd = homeCwd(input.cwd);
  const refresh = input.refresh ?? false;
  const { claude, codex } = yield* resolveAgentClis;
  const [claudeInfo, codexInfo] = yield* Effect.all([agentAppInfo(claude), agentAppInfo(codex)], {
    concurrency: 2,
  });
  const [claudeListing, codexListing] = yield* Effect.all(
    [
      claudeInfo.available
        ? listClaude(claude, cwd, refresh)
        : Effect.succeed(unavailableListing(claudeInfo)),
      codexInfo.available
        ? listCodex(codex, cwd, refresh)
        : Effect.succeed(unavailableListing(codexInfo)),
    ],
    { concurrency: 2 },
  );

  // The first list adopts the apps' user servers, once every available app's
  // config was read (a failed read retries on the next list).
  const available = [
    { info: claudeInfo, listing: claudeListing },
    { info: codexInfo, listing: codexListing },
  ].filter((app) => app.info.available);
  const canImport = available.length > 0 && available.every((app) => app.listing.configRead);
  const current = yield* mcpStore.read;
  const store =
    current.importedAt === undefined && canImport
      ? yield* mcpStore.update((latest) =>
          latest.importedAt !== undefined
            ? Effect.succeed([latest, latest] as const)
            : Effect.map(
                importInto(latest, {
                  claude: claudeListing.snapshot.config,
                  codex: codexListing.snapshot.config,
                }),
                ([, next]) => [next, next] as const,
              ),
        )
      : current;

  return {
    apps: [claudeInfo, codexInfo],
    servers: buildRows({
      store: store.servers,
      apps: { claude: claudeListing.snapshot, codex: codexListing.snapshot },
      builtin: builtinRow(yield* builtinAccess),
    }),
    liveProbe: { claude: claudeListing.probe, codex: codexListing.probe },
    checkedAt: yield* nowIso,
  } satisfies McpOverview;
});

// ---------------------------------------------------------------------------
// Mutations

interface Clis {
  readonly claude: AgentCli;
  readonly codex: AgentCli;
  readonly available: Readonly<Record<AgentApp, AgentAppInfo>>;
}

const resolveClis = Effect.gen(function* () {
  const { claude, codex } = yield* resolveAgentClis;
  const [claudeInfo, codexInfo] = yield* Effect.all([agentAppInfo(claude), agentAppInfo(codex)], {
    concurrency: 2,
  });
  return { claude, codex, available: { claude: claudeInfo, codex: codexInfo } } satisfies Clis;
});

/**
 * An app write, or a failure when the app's CLI is unavailable. Removals from
 * an unavailable app are skipped: its config is not loaded while it is missing.
 */
const forApp = <R>(
  clis: Clis,
  app: AgentApp,
  adds: boolean,
  write: (cli: AgentCli) => Effect.Effect<unknown, ExtensionFailure, R>,
) => {
  const info = clis.available[app];
  if (!info.available) {
    return Effect.succeed<Failures>(adds ? [{ app, message: unavailableMessage(info) }] : []);
  }
  return attempt(app, write(clis[app]));
};

const findStored = (store: McpStore, id: string) =>
  Effect.fromNullishOr(store.servers.find((server) => server.id === id)).pipe(
    Effect.mapError(() => new ExtensionFailure({ message: `Unknown MCP server ${id}` })),
  );

const saveServer = (server: StoredMcpServer) =>
  mcpStore.update((current) => {
    const exists = current.servers.some((stored) => stored.id === server.id);
    const servers = exists
      ? current.servers.map((stored) => (stored.id === server.id ? server : stored))
      : [...current.servers, server];
    return Effect.succeed([undefined, { ...current, servers }] as const);
  });

/**
 * Writes `server` to Claude's user scope, reusing the fields the spec does not
 * model from the live entry (or the store) while the transport is unchanged.
 * Skips the remove/add round trip when Claude already has the same entry.
 */
const writeClaude = Effect.fn("skillsMcp.mcp.writeClaude")(function* (
  cli: AgentCli,
  server: StoredMcpServer,
  previousName: string,
) {
  const live = yield* readClaudeUserEntry(cli, previousName);
  const extras = live
    ? { spec: specFromClaude(live), fields: claudeExtras(live) }
    : { spec: server.spec, fields: server.extras?.claude };
  const entry = claudeEntryFor(server.spec, extras);
  const atName = previousName === server.name ? live : yield* readClaudeUserEntry(cli, server.name);
  if (atName && canonical(atName) === canonical(entry)) return;
  yield* claudeReplaceUser(cli, server.name, entry, atName);
});

/** The Codex write for `server`'s desired flag (SSE servers are removed from Codex). */
const codexWriteFor = (server: StoredMcpServer): CodexWrite => {
  const value = codexEntryFor(server.spec, server.apps.codex, {
    spec: server.spec,
    fields: server.extras?.codex,
  });
  return value
    ? { name: server.name, value, ifPresent: !server.apps.codex }
    : { name: server.name, value: null };
};

type Upsert = Extract<McpMutation, { readonly action: "upsert" }>;

const optionalText = (next: string | undefined, current: string | undefined) =>
  next === undefined ? current : next.trim() || undefined;

/** The stored record an upsert produces; extras survive only an unchanged transport. */
const upsertRecord = (
  input: Upsert,
  name: string,
  current: StoredMcpServer | undefined,
): StoredMcpServer => {
  const spec: McpServerSpec = input.spec;
  const sameTransport = current?.spec.type === spec.type;
  const description = optionalText(input.description, current?.description);
  const homepage = optionalText(input.homepage, current?.homepage);
  return {
    id: current?.id ?? NodeCrypto.randomUUID(),
    name,
    spec,
    apps: { claude: input.apps.claude, codex: input.apps.codex && spec.type !== "sse" },
    ...(description ? { description } : {}),
    ...(homepage ? { homepage } : {}),
    tags: [...(input.tags ?? current?.tags ?? [])],
    ...(sameTransport && current?.extras ? { extras: current.extras } : {}),
  };
};

const upsert = Effect.fn("skillsMcp.mcp.upsert")(function* (clis: Clis, input: Upsert) {
  const name = input.name.trim();
  if (!NAME_PATTERN.test(name)) {
    return yield* new ExtensionFailure({
      message: "Server names may only use letters, digits, '-' and '_'",
    });
  }
  if (name === BUILTIN_SERVER_NAME) {
    return yield* new ExtensionFailure({
      message: `${BUILTIN_SERVER_NAME} is T3 Code's own server`,
    });
  }
  const store = yield* mcpStore.read;
  const current = input.id === undefined ? undefined : yield* findStored(store, input.id);
  if (store.servers.some((server) => server.name === name && server.id !== current?.id)) {
    return yield* new ExtensionFailure({ message: `A server named ${name} already exists` });
  }
  const server = upsertRecord(input, name, current);
  const previousName = current?.name ?? name;
  const renamed = previousName !== name;

  const sseFailure: Failures =
    input.apps.codex && server.spec.type === "sse"
      ? [{ app: "codex", message: SSE_UNSUPPORTED }]
      : [];
  const [claudeFailures, codexFailures] = yield* Effect.all(
    [
      forApp(clis, "claude", server.apps.claude, (cli) =>
        Effect.gen(function* () {
          if (server.apps.claude) yield* writeClaude(cli, server, previousName);
          else yield* claudeRemoveUser(cli, name);
          if (renamed) yield* claudeRemoveUser(cli, previousName);
        }),
      ),
      forApp(clis, "codex", server.apps.codex, (cli) =>
        applyCodexWrites(cli, [
          ...(renamed ? [{ name: previousName, value: null }] : []),
          codexWriteFor(server),
        ]),
      ),
    ],
    { concurrency: 2 },
  );
  yield* saveServer(server);
  return {
    failures: [...sseFailure, ...claudeFailures, ...codexFailures],
    message: `Saved ${name}`,
  } satisfies MutationResult;
});

/**
 * Claude keeps nothing for a server it no longer has, so before disabling one
 * there the store takes over the fields the spec does not model.
 */
const withLiveClaudeExtras = (server: StoredMcpServer, live: JsonObject | undefined) => {
  if (!live || specFromClaude(live)?.type !== server.spec.type) return server;
  const { claude: _previous, ...rest } = server.extras ?? {};
  const fields = claudeExtras(live);
  const extras = { ...rest, ...(fields ? { claude: fields } : {}) };
  const { extras: _extras, ...base } = server;
  return Object.keys(extras).length > 0 ? { ...base, extras } : base;
};

/** Flips one app's flag; the store only changes when the app write succeeded. */
const setEnabled = Effect.fn("skillsMcp.mcp.setEnabled")(function* (
  clis: Clis,
  input: Extract<McpMutation, { readonly action: "setEnabled" }>,
) {
  const stored = yield* findStored(yield* mcpStore.read, input.id);
  if (input.app === "codex" && input.enabled && stored.spec.type === "sse") {
    return { failures: [{ app: "codex", message: SSE_UNSUPPORTED }] } satisfies MutationResult;
  }
  const liveClaude =
    input.app === "claude" && !input.enabled && clis.available.claude.available
      ? yield* readClaudeUserEntry(clis.claude, stored.name)
      : undefined;
  const server = withLiveClaudeExtras(
    { ...stored, apps: { ...stored.apps, [input.app]: input.enabled } },
    liveClaude,
  );
  const failures = yield* forApp(clis, input.app, input.enabled, (cli) =>
    input.app === "codex"
      ? applyCodexWrites(cli, [codexWriteFor(server)])
      : input.enabled
        ? writeClaude(cli, server, server.name)
        : claudeRemoveUser(cli, server.name),
  );
  if (failures.length > 0) return { failures } satisfies MutationResult;
  yield* saveServer(server);
  return {
    failures,
    message: `${input.enabled ? "Enabled" : "Disabled"} ${server.name} in ${APP_LABELS[input.app]}`,
  } satisfies MutationResult;
});

const deleteServer = Effect.fn("skillsMcp.mcp.delete")(function* (clis: Clis, id: string) {
  const server = yield* findStored(yield* mcpStore.read, id);
  const [claudeFailures, codexFailures] = yield* Effect.all(
    [
      forApp(clis, "claude", false, (cli) => claudeRemoveUser(cli, server.name)),
      forApp(clis, "codex", false, (cli) =>
        applyCodexWrites(cli, [{ name: server.name, value: null }]),
      ),
    ],
    { concurrency: 2 },
  );
  const failures = [...claudeFailures, ...codexFailures];
  if (failures.length > 0) return { failures } satisfies MutationResult;
  yield* mcpStore.update((current) =>
    Effect.succeed([
      undefined,
      { ...current, servers: current.servers.filter((stored) => stored.id !== id) },
    ] as const),
  );
  return { failures, message: `Deleted ${server.name}` } satisfies MutationResult;
});

/** Reads both apps' user config fresh (at the home directory) and adopts it. */
const importServers = Effect.fn("skillsMcp.mcp.import")(function* (clis: Clis) {
  const home = NodeOS.homedir();
  const [claude, codex] = yield* Effect.all(
    [
      clis.available.claude.available
        ? Effect.result(readClaudeConfig(clis.claude, home))
        : Effect.succeed(Result.succeed<ReadonlyArray<ConfigServer>>([])),
      clis.available.codex.available
        ? Effect.result(readCodexConfigServers(clis.codex, home))
        : Effect.succeed(Result.succeed<ReadonlyArray<ConfigServer>>([])),
    ],
    { concurrency: 2 },
  );
  const failures: Failure[] = [];
  const configsOf = (app: AgentApp, result: typeof codex) => {
    if (Result.isSuccess(result)) return result.success;
    failures.push({ app, message: result.failure.message });
    return [];
  };
  const added = yield* mcpStore.update((current) =>
    importInto(current, { claude: configsOf("claude", claude), codex: configsOf("codex", codex) }),
  );
  return {
    failures,
    message: `Imported ${added} server${added === 1 ? "" : "s"}`,
  } satisfies MutationResult;
});

/** Refreshes one app's live probe; the server's connect error becomes a failure. */
const reconnect = Effect.fn("skillsMcp.mcp.reconnect")(function* (
  clis: Clis,
  input: Extract<McpMutation, { readonly action: "reconnect" }>,
) {
  const info = clis.available[input.app];
  if (!info.available) {
    return {
      failures: [{ app: input.app, message: unavailableMessage(info) }],
    } satisfies MutationResult;
  }
  const cwd = homeCwd(input.cwd);
  const problem =
    input.app === "claude"
      ? yield* Effect.map(
          probeClaudeStatuses(clis.claude, cwd, { refresh: true }),
          (probe): string | undefined => {
            if (probe.error) return probe.error;
            const status = probe.statuses.find((server) => server.name === input.name);
            if (!status) return `${input.name} is not loaded by Claude Code here`;
            switch (status.status) {
              case "failed":
                return status.error || "Failed to connect";
              case "needs-auth":
                return "Needs authentication (run /mcp in Claude Code)";
              case "disabled":
                return `${input.name} is disabled for this project`;
              case "pending":
                return "Still connecting";
              default:
                return undefined;
            }
          },
        )
      : yield* Effect.map(
          codexSnapshot(clis.codex, cwd, { reload: true }),
          (snapshot): string | undefined => {
            if (snapshot.error) return snapshot.error;
            const status = snapshot.statuses?.find((server) => server.name === input.name);
            if (status) return status.toolsError || undefined;
            const configured = parseCodexConfig(snapshot.config).find(
              (server) => server.name === input.name,
            );
            return configured?.disabled
              ? `${input.name} is disabled in Codex`
              : `${input.name} is not configured in Codex here`;
          },
        );
  return problem
    ? ({ failures: [{ app: input.app, message: problem }] } satisfies MutationResult)
    : ({ failures: [], message: `Reconnected ${input.name}` } satisfies MutationResult);
});

/** Browser sign-in can take a while; the CLI exits once the OAuth callback lands. */
const LOGIN_TIMEOUT = Duration.minutes(5);

const login = Effect.fn("skillsMcp.mcp.login")(function* (
  clis: Clis,
  input: Extract<McpMutation, { readonly action: "login" }>,
) {
  const failures = yield* forApp(clis, input.app, true, (cli) =>
    runAgentCliOk(cli, ["mcp", "login", input.name], { timeout: LOGIN_TIMEOUT }),
  );
  yield* input.app === "claude" ? invalidateClaudeProbes : invalidateCodexProbes;
  return failures.length > 0
    ? ({ failures } satisfies MutationResult)
    : ({ failures, message: `Signed in to ${input.name}` } satisfies MutationResult);
});

/** Writes run one at a time and drop the cached probes, so the next list sees them. */
const exclusiveWrite = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  mutationLock
    .withPermit(effect)
    .pipe(Effect.ensuring(Effect.andThen(invalidateClaudeProbes, invalidateCodexProbes)));

const mutateMcpEffect = Effect.fn("skillsMcp.mcp.mutate")(function* (input: McpMutation) {
  const clis = yield* resolveClis;
  switch (input.action) {
    case "upsert":
      return yield* exclusiveWrite(upsert(clis, input));
    case "setEnabled":
      return yield* exclusiveWrite(setEnabled(clis, input));
    case "delete":
      return yield* exclusiveWrite(deleteServer(clis, input.id));
    case "import":
      return yield* exclusiveWrite(importServers(clis));
    case "setProjectEnabled":
      return yield* exclusiveWrite(
        forApp(clis, "claude", true, (cli) =>
          claudeSetProjectEnabled(cli, input.cwd, input.name, input.enabled),
        ).pipe(
          Effect.map((failures): MutationResult => ({
            failures,
            message: `${input.enabled ? "Enabled" : "Disabled"} ${input.name} for this project`,
          })),
        ),
      );
    case "reconnect":
      return yield* reconnect(clis, input);
    case "login":
      return yield* login(clis, input);
  }
});

// ---------------------------------------------------------------------------
// Exports (typed for the extension's `run`)

export const listMcp = (input: {
  readonly cwd?: string | undefined;
  readonly refresh?: boolean | undefined;
}): Effect.Effect<McpOverview, ExtensionFailure, SkillsMcpServices> => listMcpEffect(input);

export const mutateMcp = (
  input: McpMutation,
): Effect.Effect<MutationResult, ExtensionFailure, SkillsMcpServices> => mutateMcpEffect(input);

/** CC Switch's MCP presets (MIT), with commands adjusted for the host platform. */
export const mcpPresets = (): Effect.Effect<ReadonlyArray<McpPreset>, never, SkillsMcpServices> =>
  Effect.gen(function* () {
    return makeMcpPresets(yield* HostProcessPlatform);
  });
