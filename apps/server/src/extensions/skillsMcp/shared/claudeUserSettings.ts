/**
 * Claude Code's user `settings.json` (`<configDir>/settings.json`), where the
 * panel keeps the two switches Claude has no CLI for: `deniedMcpServers` turns
 * an MCP server off in every project (claude.ai connectors, plugin and project
 * servers included) and `skillOverrides` turns a skill off. Writes change only
 * those keys, keep everything else as it was, and refuse to replace a file
 * that is not valid JSON.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import type { AgentCli } from "./agents.ts";
import { ExtensionFailure } from "./t3.ts";

type Settings = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const settingsPath = (cli: AgentCli, path: Path.Path) => path.join(cli.configDir, "settings.json");

/** The file's text, or undefined when there is none. */
const readText = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(file).pipe(
      Effect.map((text): string | undefined => text),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(new ExtensionFailure({ message: `Could not read ${file}`, cause: error })),
      ),
    ),
  );

const parse = (text: string | undefined): Settings | undefined => {
  if (text === undefined || text.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/** The user settings, or `{}` when the file is missing or unreadable. */
export const readClaudeUserSettings = Effect.fn("skillsMcp.readClaudeUserSettings")(function* (
  cli: AgentCli,
) {
  const file = settingsPath(cli, yield* Path.Path);
  return parse(yield* readText(file).pipe(Effect.orElseSucceed(() => undefined))) ?? {};
});

/** Claude's own layout: two-space indent, trailing newline. */
const formatSettings = (settings: Settings) => `${JSON.stringify(settings, null, 2)}\n`;

/** Module-level: every settings write in the server goes through one lock. */
const writeLock = Semaphore.makeUnsafe(1);

/** Read, transform and atomically replace the user settings. */
export const updateClaudeUserSettings = (
  cli: AgentCli,
  transform: (current: Settings) => Settings,
) =>
  writeLock.withPermit(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = settingsPath(cli, yield* Path.Path);
      const current = parse(yield* readText(file));
      if (current === undefined) {
        return yield* new ExtensionFailure({
          message: `${file} is not valid JSON; fix it before switching this here`,
        });
      }
      const next = transform(current);
      if (next === current) return;
      const temp = `${file}.t3-tmp`;
      yield* fs.makeDirectory(cli.configDir, { recursive: true }).pipe(
        Effect.andThen(fs.writeFileString(temp, formatSettings(next))),
        Effect.andThen(fs.rename(temp, file)),
        Effect.mapError(
          (cause) => new ExtensionFailure({ message: `Could not write ${file}`, cause }),
        ),
      );
    }),
  );

// ---------------------------------------------------------------------------
// deniedMcpServers

/** Server names in `deniedMcpServers` (entries that match by command or URL are left alone). */
export const deniedServerNames = (settings: Settings): ReadonlySet<string> => {
  const entries = Array.isArray(settings.deniedMcpServers) ? settings.deniedMcpServers : [];
  return new Set(
    entries.flatMap((entry) =>
      isRecord(entry) && typeof entry.serverName === "string" ? [entry.serverName] : [],
    ),
  );
};

/** `settings` with `name` added to or removed from `deniedMcpServers`; the same object when unchanged. */
export const withDeniedServer = (settings: Settings, name: string, denied: boolean): Settings => {
  if (deniedServerNames(settings).has(name) === denied) return settings;
  const entries = Array.isArray(settings.deniedMcpServers) ? settings.deniedMcpServers : [];
  const next = denied
    ? [...entries, { serverName: name }]
    : entries.filter((entry) => !(isRecord(entry) && entry.serverName === name));
  if (next.length > 0) return { ...settings, deniedMcpServers: next };
  const { deniedMcpServers: _removed, ...rest } = settings;
  return rest;
};

// ---------------------------------------------------------------------------
// skillOverrides

/** Skill names `skillOverrides` switches off. */
export const skillsOff = (settings: Settings): ReadonlySet<string> => {
  const overrides = isRecord(settings.skillOverrides) ? settings.skillOverrides : {};
  return new Set(Object.keys(overrides).filter((name) => overrides[name] === "off"));
};

/**
 * `settings` with skill `name` switched off, or back on (its override removed,
 * which is Claude's default); the same object when unchanged.
 */
export const withSkillOff = (settings: Settings, name: string, off: boolean): Settings => {
  const overrides = isRecord(settings.skillOverrides) ? settings.skillOverrides : {};
  if (off ? overrides[name] === "off" : !(name in overrides)) return settings;
  const { [name]: _previous, ...others } = overrides;
  const next = off ? { ...others, [name]: "off" } : others;
  if (Object.keys(next).length > 0) return { ...settings, skillOverrides: next };
  const { skillOverrides: _removed, ...rest } = settings;
  return rest;
};
