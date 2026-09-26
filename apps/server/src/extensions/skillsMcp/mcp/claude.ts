/**
 * Claude Code's side of the MCP panel. Config is read straight from
 * `.claude.json` and the `.mcp.json` files above the cwd (never written here); live status comes
 * from a thread-less Agent SDK query (see `probes.ts`); user-scope writes go through
 * `claude mcp add-json/remove -s user` so Claude owns its own file format.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - the Agent SDK spawns through a Node ChildProcess.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { type AgentCli, describeCause, runAgentCli, runAgentCliOk } from "../shared/agents.ts";
import { buildClaudeCapabilitiesProbeQueryOptions, ExtensionFailure } from "../shared/t3.ts";
import { parseClaudeConfig } from "./parse.ts";
import type { JsonObject } from "./spec.ts";
import { resolveClaudeSdkExecutablePath } from "./t3.ts";

/** The cwd Claude resolves project config against when the panel has no thread. */
export const effectiveCwd = (cwd: string | undefined) => cwd ?? NodeOS.homedir();

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * Parsed JSON, or undefined when the file is missing, unreadable or invalid
 * (logged unless `quiet`, for polls that may catch a file mid-write).
 */
export const readJsonFile = Effect.fn("skillsMcp.mcp.readJsonFile")(function* (
  filePath: string,
  options?: { readonly quiet?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const warn = (message: string) =>
    options?.quiet
      ? Effect.succeed(undefined)
      : Effect.logWarning(message).pipe(Effect.as(undefined));
  const text = yield* fs
    .readFileString(filePath)
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(undefined)
          : warn(`Could not read ${filePath}: ${error.message}`),
      ),
    );
  if (text === undefined) return undefined;
  return yield* decodeJson(text).pipe(
    Effect.catch((error) => warn(`Invalid JSON in ${filePath}: ${error.message}`)),
  );
});

export const claudeJsonPathOf = (cli: AgentCli, path: Path.Path) =>
  cli.claudeJsonPath ?? path.join(cli.configDir, ".claude.json");

/** The user-scope entry for `name` in `.claude.json`, if any. */
export const readClaudeUserEntry = Effect.fn("skillsMcp.mcp.readClaudeUserEntry")(function* (
  cli: AgentCli,
  name: string,
) {
  const path = yield* Path.Path;
  const root = yield* readJsonFile(claudeJsonPathOf(cli, path));
  const servers =
    typeof root === "object" && root !== null && "mcpServers" in root ? root.mcpServers : undefined;
  const entry =
    typeof servers === "object" && servers !== null && name in servers
      ? (servers as JsonObject)[name]
      : undefined;
  return typeof entry === "object" && entry !== null && !Array.isArray(entry)
    ? (entry as JsonObject)
    : undefined;
});

/**
 * The main worktree of the linked worktree whose `.git` file is `dotGit`: the
 * parent of the common `.git` directory. Undefined when it cannot be followed
 * (a submodule, a bare repository, an unreadable file).
 */
const mainWorktreeRoot = Effect.fn("skillsMcp.mcp.mainWorktreeRoot")(function* (dotGit: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pointer = /^gitdir:\s*(.+)$/m.exec(yield* fs.readFileString(dotGit))?.[1]?.trim();
  if (!pointer) return undefined;
  const gitDir = path.resolve(path.dirname(dotGit), pointer);
  const commonDir = path.resolve(
    gitDir,
    (yield* fs.readFileString(path.join(gitDir, "commondir"))).trim(),
  );
  if (path.basename(commonDir) !== ".git") return undefined;
  return yield* fs.realPath(path.dirname(commonDir));
});

export interface ClaudeProject {
  /** The resolved cwd, which Claude runs in and walks up from for `.mcp.json`. */
  readonly realCwd: string;
  /**
   * The `projects` key in `.claude.json` Claude files this cwd under: the
   * main repository root when the cwd is inside a git checkout (a linked
   * worktree maps to its main repository), otherwise the resolved cwd.
   */
  readonly key: string;
}

export const claudeProject = Effect.fn("skillsMcp.mcp.claudeProject")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realCwd = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
  for (let dir = realCwd; ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    const info = yield* fs.stat(dotGit).pipe(Effect.option);
    if (Option.isSome(info)) {
      const main =
        info.value.type === "File"
          ? yield* mainWorktreeRoot(dotGit).pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
      return { realCwd, key: main ?? dir } satisfies ClaudeProject;
    }
    if (path.dirname(dir) === dir) return { realCwd, key: realCwd } satisfies ClaudeProject;
  }
});

/** Every `.mcp.json` from `dir` up to the filesystem root, closest first. */
const projectMcpJsons = Effect.fn("skillsMcp.mcp.projectMcpJsons")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates: string[] = [];
  for (let current = dir; ; current = path.dirname(current)) {
    candidates.push(path.join(current, ".mcp.json"));
    if (path.dirname(current) === current) break;
  }
  const files = yield* Effect.forEach(
    candidates,
    (filePath) =>
      fs.exists(filePath).pipe(
        Effect.orElseSucceed(() => false),
        Effect.flatMap((exists) =>
          exists
            ? readJsonFile(filePath).pipe(Effect.map((json) => ({ path: filePath, json })))
            : Effect.succeed(undefined),
        ),
      ),
    { concurrency: 4 },
  );
  return files.filter((file) => file !== undefined);
});

/** Claude's user, local and project server definitions for `cwd`. */
export const readClaudeConfig = Effect.fn("skillsMcp.mcp.readClaudeConfig")(function* (
  cli: AgentCli,
  cwd: string,
) {
  const path = yield* Path.Path;
  const claudeJsonPath = claudeJsonPathOf(cli, path);
  const project = yield* claudeProject(cwd);
  const [claudeJson, mcpJsons] = yield* Effect.all(
    [readJsonFile(claudeJsonPath), projectMcpJsons(project.realCwd)],
    { concurrency: 2 },
  );
  return parseClaudeConfig({
    claudeJson,
    claudeJsonPath,
    projectMcpJsons: mcpJsons,
    // The key Claude uses, then the older cwd-shaped keys it may have left.
    cwdKeys: [...new Set([project.key, project.realCwd, cwd])],
  });
});

// ---------------------------------------------------------------------------
// SDK session (the cached probes built on it live in `probes.ts`)

const INIT_TIMEOUT = Duration.seconds(30);

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

/**
 * T3's capabilities-probe options, but loading MCP servers the way a thread
 * does: no empty `mcpServers` override, no strict config, and claude.ai
 * servers left as the user's environment has them.
 */
const probeOptions = (
  cli: AgentCli,
  executablePath: string,
  abortController: AbortController,
  cwd: string,
): ClaudeQueryOptions => {
  const base = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath,
    abortController,
    environment: cli.env,
    cwd,
  });
  return {
    ...Struct.omit(base, ["mcpServers"]),
    strictMcpConfig: false,
    env: { ...base.env, ENABLE_CLAUDEAI_MCP_SERVERS: cli.env.ENABLE_CLAUDEAI_MCP_SERVERS },
  };
};

/** One SDK control request, failing with `Claude <label>: <reason>`. */
export const claudeCall = <A>(label: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ExtensionFailure({ message: `Claude ${label}: ${describeCause(cause)}`, cause }),
  });

/** Resolves true once `child` has exited, or false after `timeout`. */
const awaitExit = (child: NodeChildProcess.ChildProcess, timeout: Duration.Input) =>
  Effect.callback<boolean>((resume) => {
    // No pid: the spawn itself failed, so there is nothing to wait for.
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return resume(Effect.succeed(true));
    }
    const exited = () => resume(Effect.succeed(true));
    child.once("exit", exited);
    child.once("error", exited);
    return Effect.sync(() => {
      child.off("exit", exited);
      child.off("error", exited);
    });
  }).pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.succeed(false) }));

/**
 * Waits for the Claude process to really exit. `query.close()` only starts a
 * shutdown (stdin EOF, SIGTERM seconds later) and returns at once, but Claude
 * rewrites `.claude.json` at startup and exit, so a caller that goes on to
 * write that file (see `withAgentWrite` in `probes.ts`) must not overlap it.
 */
const reapClaude = (child: NodeChildProcess.ChildProcess | undefined) =>
  Effect.gen(function* () {
    if (!child) return;
    if (yield* awaitExit(child, Duration.seconds(3))) return;
    child.kill("SIGTERM");
    if (yield* awaitExit(child, Duration.seconds(5))) return;
    child.kill("SIGKILL");
    if (yield* awaitExit(child, Duration.seconds(2))) return;
    yield* Effect.logWarning(`Claude probe process ${child.pid} did not exit after SIGKILL`);
  });

/** `failure` plus the last line Claude printed to stderr, if any. */
const withStderr = (failure: ExtensionFailure, stderr: string) => {
  const last = stderr.trim().split("\n").at(-1)?.trim().slice(0, 300);
  return last && !failure.message.includes(last)
    ? new ExtensionFailure({ message: `${failure.message} (${last})`, cause: failure })
    : failure;
};

/**
 * Runs `use` against a Claude Agent SDK session at `cwd` that never sends a
 * prompt (so nothing reaches the API), then closes it and waits for the
 * process to exit, also when interrupted.
 */
export const withClaudeQuery = <A, R = never>(
  cli: AgentCli,
  cwd: string,
  use: (query: Query) => Effect.Effect<A, ExtensionFailure, R>,
) =>
  Effect.gen(function* () {
    const executablePath = yield* resolveClaudeSdkExecutablePath(cli.binaryPath, cli.env);
    return yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const abort = new AbortController();
          const spawned: { child?: NodeChildProcess.ChildProcess; stderr: string } = {
            stderr: "",
          };
          const query = claudeQuery({
            // oxlint-disable-next-line require-yield
            prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
              await waitForAbort(abort.signal);
            })(),
            options: {
              ...probeOptions(cli, executablePath, abort, cwd),
              // The SDK's own spawn, keeping the child so the release can wait for it.
              spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
                const child = NodeChildProcess.spawn(command, args, {
                  cwd,
                  env,
                  signal,
                  stdio: ["pipe", "pipe", "pipe"],
                  windowsHide: true,
                });
                // A custom spawn loses the SDK's stderr tail in its errors; keep our own.
                child.stderr?.on("data", (chunk) => {
                  spawned.stderr = (spawned.stderr + String(chunk)).slice(-2000);
                });
                spawned.child = child;
                return child;
              },
            },
          });
          return { abort, query, spawned };
        },
        catch: (cause) =>
          new ExtensionFailure({
            message: `Could not start Claude: ${describeCause(cause)}`,
            cause,
          }),
      }),
      ({ query, spawned }) =>
        claudeCall("session", () => query.initializationResult()).pipe(
          Effect.mapError((failure) => withStderr(failure, spawned.stderr)),
          Effect.timeoutOrElse({
            duration: INIT_TIMEOUT,
            orElse: () =>
              Effect.fail(new ExtensionFailure({ message: "Claude session start timed out" })),
          }),
          Effect.andThen(use(query)),
        ),
      ({ abort, query, spawned }) =>
        Effect.sync(() => {
          abort.abort();
          query.close();
        }).pipe(Effect.andThen(Effect.suspend(() => reapClaude(spawned.child)))),
    );
  });

// ---------------------------------------------------------------------------
// Writes

const NOT_FOUND = /No (?:MCP )?server|not found/i;

/**
 * `claude mcp remove <name> -s user`; succeeds when the server is already gone
 * (without spawning the CLI when `.claude.json` has no such user entry).
 */
export const claudeRemoveUser = Effect.fn("skillsMcp.mcp.claudeRemoveUser")(function* (
  cli: AgentCli,
  name: string,
) {
  if (!(yield* readClaudeUserEntry(cli, name))) return;
  const output = yield* runAgentCli(cli, ["mcp", "remove", name, "-s", "user"]);
  if (output.code === 0 || NOT_FOUND.test(`${output.stderr}\n${output.stdout}`)) return;
  return yield* new ExtensionFailure({
    message: `${output.stderr.trim() || output.stdout.trim() || `exit code ${output.code}`} (claude mcp remove)`,
  });
});

/** `claude mcp add-json <name> <json> -s user`; fails when the name exists. */
export const claudeAddUser = (cli: AgentCli, name: string, entry: JsonObject) =>
  runAgentCliOk(cli, ["mcp", "add-json", name, JSON.stringify(entry), "-s", "user"]).pipe(
    Effect.asVoid,
  );

/**
 * Replaces the user-scope `name` with `entry` (remove, then add). When the add
 * fails, `previous` is put back so a bad edit does not lose the server.
 */
export const claudeReplaceUser = Effect.fn("skillsMcp.mcp.claudeReplaceUser")(function* (
  cli: AgentCli,
  name: string,
  entry: JsonObject,
  previous: JsonObject | undefined,
) {
  yield* claudeRemoveUser(cli, name);
  yield* claudeAddUser(cli, name, entry).pipe(
    Effect.tapError(() =>
      previous ? claudeAddUser(cli, name, previous).pipe(Effect.ignore) : Effect.void,
    ),
  );
});

const TOGGLE_SAVE_TIMEOUT = Duration.seconds(10);
const TOGGLE_POLL = Duration.millis(25);

/** Whether `.claude.json` lists `name` in `projects[key].disabledMcpServers`. */
const isSavedDisabled = (claudeJson: unknown, key: string, name: string) => {
  const projects =
    typeof claudeJson === "object" && claudeJson !== null && "projects" in claudeJson
      ? claudeJson.projects
      : undefined;
  const project =
    typeof projects === "object" && projects !== null && key in projects
      ? (projects as JsonObject)[key]
      : undefined;
  const disabled =
    typeof project === "object" && project !== null && "disabledMcpServers" in project
      ? project.disabledMcpServers
      : undefined;
  return Array.isArray(disabled) && disabled.includes(name);
};

/**
 * Claude's per-project toggle, persisted in `.claude.json` under the project
 * key. `toggleMcpServer` resolves before Claude writes the file, and closing
 * the session first loses the write, so the session is held until it lands.
 */
export const claudeSetProjectEnabled = Effect.fn("skillsMcp.mcp.claudeSetProjectEnabled")(
  function* (cli: AgentCli, cwd: string, name: string, enabled: boolean) {
    const path = yield* Path.Path;
    const claudeJsonPath = claudeJsonPathOf(cli, path);
    const { key } = yield* claudeProject(cwd);
    const saved = readJsonFile(claudeJsonPath, { quiet: true }).pipe(
      Effect.map((claudeJson) => isSavedDisabled(claudeJson, key, name) === !enabled),
    );
    const waitForSave = Effect.gen(function* () {
      while (!(yield* saved)) yield* Effect.sleep(TOGGLE_POLL);
    }).pipe(
      Effect.timeoutOrElse({
        duration: TOGGLE_SAVE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ExtensionFailure({
              message: `Claude did not save the ${enabled ? "enable" : "disable"} of ${name} for ${key}`,
            }),
          ),
      }),
    );
    yield* withClaudeQuery(cli, cwd, (query) =>
      claudeCall(`toggle ${name}`, () => query.toggleMcpServer(name, enabled)).pipe(
        Effect.andThen(waitForSave),
      ),
    );
  },
);
