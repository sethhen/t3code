/**
 * Claude `--settings` from an instance's launch arguments, merged into the
 * settings object T3 builds for each Claude process.
 *
 * Upstream passes launch arguments as SDK `extraArgs`, but the SDK overwrites
 * `extraArgs.settings` whenever T3's own settings object is non-empty, so a
 * `--settings` launch argument was silently dropped. The host edits in
 * ClaudeAdapter.ts and ClaudeTextGeneration.ts spread this helper's result
 * first, so T3's own keys still win.
 *
 * Flag settings outrank the user's `settings.json`, including its `env` block,
 * which in turn outranks the process environment. That is why the pool routes
 * Claude through here and not through environment variables alone.
 */
import { parseCliArgs } from "@t3tools/shared/cliArgs";

export type ClaudeFlagSettings = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The inline JSON object of `--settings`, or `{}` (absent, a file path, or invalid JSON). */
export const launchArgSettings = (launchArgs: string | undefined): ClaudeFlagSettings => {
  if (!launchArgs) return {};
  const value = parseCliArgs(launchArgs).flags.settings;
  if (typeof value !== "string" || !value.trimStart().startsWith("{")) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * Shallow merge where `env` merges one level deeper, so two sources of
 * environment settings combine instead of one replacing the other.
 */
export const mergeClaudeSettings = (
  base: ClaudeFlagSettings,
  extra: ClaudeFlagSettings,
): ClaudeFlagSettings => {
  const env = {
    ...(isRecord(base.env) ? base.env : {}),
    ...(isRecord(extra.env) ? extra.env : {}),
  };
  return {
    ...base,
    ...extra,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
};

/**
 * Adds `settings` to the launch arguments' `--settings`. The merged object is
 * appended as a new `--settings` flag: `parseCliArgs` keeps the last value of
 * a repeated flag, so the rest of the user's arguments stay byte-for-byte.
 */
export const withLaunchArgSettings = (
  launchArgs: string | undefined,
  settings: ClaudeFlagSettings,
): string => {
  const merged = mergeClaudeSettings(launchArgSettings(launchArgs), settings);
  const flag = `--settings ${singleQuote(JSON.stringify(merged))}`;
  return launchArgs?.trim() ? `${launchArgs.trim()} ${flag}` : flag;
};

/** `tokenizeCliArgs` keeps everything inside single quotes verbatim. */
const singleQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
