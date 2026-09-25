/**
 * `plugins.list` / `plugins.mutate`: Claude Code plugins through `claude
 * plugin ... --json` (user scope), Codex plugins through `codex app-server`.
 * One app failing never hides the other: list errors mark that app
 * unavailable, mutation errors come back as `failures`.
 */
import * as NodeOS from "node:os";

import type {
  AgentAppInfo,
  MutationResult,
  PluginRow,
  PluginsMutation,
  PluginsOverview,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { SkillsMcpServices } from "../index.ts";
import { type AgentCli, agentAppInfo, resolveAgentClis } from "../shared/agents.ts";
import type { ExtensionFailure } from "../shared/t3.ts";
import { listClaudePlugins, mutateClaudePlugin } from "./claude.ts";
import { listCodexPlugins, mutateCodexPlugin } from "./codex.ts";
import { byName } from "./common.ts";

interface PluginRows {
  readonly installed: ReadonlyArray<PluginRow>;
  readonly available: ReadonlyArray<PluginRow>;
}

interface AppPlugins extends PluginRows {
  readonly info: AgentAppInfo;
}

const listRows = (
  cli: AgentCli,
  cwd: string,
  includeAvailable: boolean,
): Effect.Effect<PluginRows, ExtensionFailure, SkillsMcpServices> =>
  cli.app === "claude"
    ? listClaudePlugins(cli, cwd, includeAvailable)
    : listCodexPlugins(cli, cwd, includeAvailable);

const mutateApp = (
  cli: AgentCli,
  mutation: PluginsMutation,
): Effect.Effect<string, ExtensionFailure, SkillsMcpServices> =>
  cli.app === "claude" ? mutateClaudePlugin(cli, mutation) : mutateCodexPlugin(cli, mutation);

const listApp = Effect.fn("skillsMcp.plugins.listApp")(function* (
  cli: AgentCli,
  cwd: string,
  includeAvailable: boolean,
) {
  const info = yield* agentAppInfo(cli);
  if (!info.available) return { info, installed: [], available: [] } satisfies AppPlugins;
  return yield* listRows(cli, cwd, includeAvailable).pipe(
    Effect.map((rows): AppPlugins => ({ info, ...rows })),
    Effect.catch((failure) =>
      Effect.succeed<AppPlugins>({
        info: { ...info, available: false, error: failure.message },
        installed: [],
        available: [],
      }),
    ),
  );
});

const listPluginsEffect = Effect.fn("skillsMcp.plugins.list")(function* (input: {
  readonly cwd?: string | undefined;
  readonly includeAvailable?: boolean | undefined;
}) {
  const cwd = input.cwd?.trim() || NodeOS.homedir();
  const includeAvailable = input.includeAvailable ?? false;
  const { claude, codex } = yield* resolveAgentClis;
  const apps = yield* Effect.forEach(
    [claude, codex],
    (cli) => listApp(cli, cwd, includeAvailable),
    { concurrency: 2 },
  );
  const rows = (pick: (app: AppPlugins) => ReadonlyArray<PluginRow>) =>
    apps.flatMap((app) => pick(app).toSorted(byName));
  return {
    apps: apps.map((app) => app.info),
    installed: rows((app) => app.installed),
    available: includeAvailable ? rows((app) => app.available) : [],
    checkedAt: DateTime.formatIso(yield* DateTime.now),
  } satisfies PluginsOverview;
});

/** Plugin ids go to the CLI as one argv entry; never let one read as a flag. */
const PLUGIN_ID = /^[^\s-]\S*$/;

const mutatePluginsEffect = Effect.fn("skillsMcp.plugins.mutate")(function* (
  mutation: PluginsMutation,
) {
  if (!PLUGIN_ID.test(mutation.id)) {
    return {
      failures: [{ app: mutation.app, message: `Invalid plugin id "${mutation.id}"` }],
    } satisfies MutationResult;
  }
  const { claude, codex } = yield* resolveAgentClis;
  return yield* mutateApp(mutation.app === "claude" ? claude : codex, mutation).pipe(
    Effect.map((message): MutationResult => ({ failures: [], message })),
    Effect.catch((failure) =>
      Effect.succeed<MutationResult>({
        failures: [{ app: mutation.app, message: failure.message }],
      }),
    ),
  );
});

export const listPlugins = (input: {
  readonly cwd?: string | undefined;
  readonly includeAvailable?: boolean | undefined;
}): Effect.Effect<PluginsOverview, ExtensionFailure, SkillsMcpServices> => listPluginsEffect(input);

export const mutatePlugins = (
  input: PluginsMutation,
): Effect.Effect<MutationResult, ExtensionFailure, SkillsMcpServices> => mutatePluginsEffect(input);
