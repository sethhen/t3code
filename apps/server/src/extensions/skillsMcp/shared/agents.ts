/**
 * How the Skills & MCP extension reaches Claude Code and Codex.
 *
 * Mirrors T3's own provider drivers - same binary path and the same
 * CLAUDE_CONFIG_DIR / CODEX_HOME from `settings.providers` - so the panel sees
 * exactly what a thread's agent sees. This file and `t3.ts` are the
 * extension's only seam onto T3 server internals; when upstream moves these
 * helpers, fix the imports there.
 */
import * as NodeOS from "node:os";

import type { AgentApp, AgentAppInfo } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  ExtensionFailure,
  ServerSettingsService,
  expandHomePath,
  makeClaudeEnvironment,
  parseGenericCliVersion,
  resolveSpawnCommand,
  spawnAndCollect,
  withCodexAppServerClient,
  ChildProcess,
} from "./t3.ts";

export interface AgentCli {
  readonly app: AgentApp;
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  /** Claude: `$CLAUDE_CONFIG_DIR` or `~/.claude`. Codex: `$CODEX_HOME` or `~/.codex`. */
  readonly configDir: string;
  /** Claude only: the `.claude.json` that holds user/local MCP servers. */
  readonly claudeJsonPath?: string | undefined;
  /** Codex only: the raw `homePath` setting, forwarded to the app-server helper. */
  readonly codexHomeSetting?: string | undefined;
  readonly launchArgs?: string | undefined;
}

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** The Claude and Codex CLIs as the default provider instances configure them. */
export const resolveAgentClis = Effect.gen(function* () {
  const path = yield* Path.Path;
  const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
    Effect.mapError(
      (cause) => new ExtensionFailure({ message: "Could not read T3 settings", cause }),
    ),
  );
  const claudeSettings = settings.providers.claudeAgent;
  const codexSettings = settings.providers.codex;

  const claudeHomeSetting = claudeSettings.homePath.trim();
  const claudeEnv = yield* makeClaudeEnvironment(claudeSettings);
  const claudeConfigDir =
    claudeHomeSetting.length > 0
      ? path.resolve(expandHomePath(claudeHomeSetting))
      : path.join(NodeOS.homedir(), ".claude");
  const claude: AgentCli = {
    app: "claude",
    binaryPath: claudeSettings.binaryPath,
    env: claudeEnv,
    configDir: claudeConfigDir,
    claudeJsonPath:
      claudeHomeSetting.length > 0
        ? path.join(claudeConfigDir, ".claude.json")
        : path.join(NodeOS.homedir(), ".claude.json"),
    launchArgs: claudeSettings.launchArgs,
  };

  const codexHomeSetting = codexSettings.homePath.trim();
  const codexConfigDir =
    codexHomeSetting.length > 0
      ? path.resolve(expandHomePath(codexHomeSetting))
      : process.env.CODEX_HOME
        ? path.resolve(expandHomePath(process.env.CODEX_HOME))
        : path.join(NodeOS.homedir(), ".codex");
  const codex: AgentCli = {
    app: "codex",
    binaryPath: codexSettings.binaryPath,
    env: codexHomeSetting.length > 0 ? { ...process.env, CODEX_HOME: codexConfigDir } : process.env,
    configDir: codexConfigDir,
    codexHomeSetting: codexHomeSetting.length > 0 ? codexHomeSetting : undefined,
    launchArgs: codexSettings.launchArgs,
  };
  return { claude, codex } as const;
});

const DEFAULT_CLI_TIMEOUT = Duration.seconds(60);

/**
 * Runs the agent's CLI with its provider environment. Non-zero exits are
 * returned, not failed, so callers can surface the CLI's own stderr.
 */
export const runAgentCli = Effect.fn("skillsMcp.runAgentCli")(function* (
  cli: AgentCli,
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string; readonly timeout?: Duration.Input },
) {
  const spawnCommand = yield* resolveSpawnCommand(cli.binaryPath, args, { env: cli.env });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: cli.env,
    shell: spawnCommand.shell,
    ...(options?.cwd ? { cwd: options.cwd } : {}),
  });
  const result = yield* spawnAndCollect(cli.binaryPath, command).pipe(
    Effect.timeoutOrElse({
      duration: options?.timeout ?? DEFAULT_CLI_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new ExtensionFailure({ message: `\`${cli.binaryPath} ${args.join(" ")}\` timed out` }),
        ),
    }),
    Effect.mapError((cause) =>
      cause instanceof ExtensionFailure
        ? cause
        : new ExtensionFailure({
            message: `Could not run \`${cli.binaryPath}\`: ${String(cause)}`,
            cause,
          }),
    ),
  );
  return result satisfies CommandOutput;
});

/** Fails with the CLI's stderr (or stdout) when it exits non-zero. */
export const runAgentCliOk = (
  cli: AgentCli,
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string; readonly timeout?: Duration.Input },
) =>
  runAgentCli(cli, args, options).pipe(
    Effect.flatMap((output) =>
      output.code === 0
        ? Effect.succeed(output)
        : Effect.fail(
            new ExtensionFailure({
              message:
                (output.stderr.trim() || output.stdout.trim() || `exit code ${output.code}`) +
                ` (${cli.app} ${args.slice(0, 3).join(" ")})`,
            }),
          ),
    ),
  );

const appInfoCache = new Map<string, { readonly at: number; readonly info: AgentAppInfo }>();
const APP_INFO_TTL_MS = 5 * 60_000;

/** `--version` of each CLI, cached for five minutes per binary. */
export const agentAppInfo = Effect.fn("skillsMcp.agentAppInfo")(function* (cli: AgentCli) {
  const cacheKey = `${cli.app}:${cli.binaryPath}:${cli.configDir}`;
  const now = yield* Clock.currentTimeMillis;
  const cached = appInfoCache.get(cacheKey);
  if (cached && now - cached.at < APP_INFO_TTL_MS) return cached.info;
  return yield* runAgentCli(cli, ["--version"], { timeout: Duration.seconds(15) }).pipe(
    Effect.map((output): AgentAppInfo =>
      output.code === 0
        ? {
            app: cli.app,
            available: true,
            version: parseGenericCliVersion(output.stdout) ?? output.stdout.trim(),
          }
        : { app: cli.app, available: false, error: output.stderr.trim() || "CLI failed" },
    ),
    Effect.catch((failure) =>
      Effect.succeed<AgentAppInfo>({ app: cli.app, available: false, error: failure.message }),
    ),
    Effect.tap((info) => Effect.sync(() => appInfoCache.set(cacheKey, { at: now, info }))),
  );
});

/**
 * Runs `use` against a short-lived `codex app-server` (killed when `use`
 * finishes). Use for `mcpServerStatus/list`, `config/*`, `skills/*`.
 */
export type CodexAppServerClient = Effect.Success<
  ReturnType<typeof withCodexAppServerClient>
>["client"];

export const withCodexClient = <A, E, R>(
  cli: AgentCli,
  cwd: string,
  use: (client: CodexAppServerClient) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    withCodexAppServerClient({
      binaryPath: cli.binaryPath,
      homePath: cli.codexHomeSetting,
      launchArgs: cli.launchArgs,
      cwd,
    }).pipe(Effect.flatMap(({ client }) => use(client))),
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof ExtensionFailure
        ? cause
        : new ExtensionFailure({ message: `Codex app-server: ${describeCause(cause)}`, cause }),
    ),
  );

export function describeCause(cause: unknown): string {
  if (cause && typeof cause === "object") {
    if ("message" in cause && typeof cause.message === "string" && cause.message.length > 0) {
      return cause.message;
    }
    if ("_tag" in cause && typeof cause._tag === "string") return cause._tag;
  }
  return String(cause);
}

export type AgentCliServices = Effect.Services<ReturnType<typeof runAgentCli>>;
