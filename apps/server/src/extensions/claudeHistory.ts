// @effect-diagnostics nodeBuiltinImport:off globalDate:off - links account config dirs to the main one with plain Node.
/**
 * One conversation store for every Claude account, so a thread can move
 * between the user's accounts.
 *
 * Claude Code resumes a conversation from `<config dir>/projects/<cwd
 * slug>/<id>.jsonl` (+ `<id>/`) and keeps plans in `<config dir>/plans`. An
 * account dir the fork made links both to the main dir's (the one its marker
 * names, else `~/.claude`), while its sign-in (`.claude.json`, the Keychain
 * item) stays its own. ClaudeDriver.ts keys each instance through
 * `claudeSharedHistoryKey` (a `t3-ext` seam), so instances that share a store
 * share a continuation key, and ProviderService resumes a thread's
 * conversation on any of them.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * A file the fork writes into each Claude account dir it creates. It holds
 * the main config dir's path; dirs from builds before that have it empty.
 */
export const CLAUDE_ACCOUNT_MARKER = ".t3-account";

/** What an account dir shares with the main one. */
const SHARED = ["projects", "plans"] as const;

/** The ids of the instances the previous release made `~/.claude-*` dirs for. */
const PREVIOUS_RELEASE_ID = /^claude_[0-9a-f]{8}$/;

export interface ShareClaudeHistoryOptions {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /** The instance on the config dir; qualifies an unmarked dir the previous release made. */
  readonly instanceId?: string;
  readonly log: (message: string) => void;
}

/**
 * Links an account dir's `projects` and `plans` to the main dir's, moving
 * what the account has there into the main dir first. Acts only on an account
 * dir: one with `CLAUDE_ACCOUNT_MARKER` (the main dir is the path it holds,
 * else `<home>/.claude`), or the `<home>/.claude-*` dir of a `claude_<hash>`
 * instance, as the previous release made them unmarked. Leaves a dir separate
 * while a Claude process uses it. Idempotent, a few lstats once linked.
 */
export const shareClaudeHistory = async (configDir: string, options: ShareClaudeHistoryOptions) => {
  const home = NodePath.resolve(options.home);
  const dir = NodePath.resolve(configDir);
  const marker = await NodeFSP.readFile(NodePath.join(dir, CLAUDE_ACCOUNT_MARKER), "utf8").catch(
    () => undefined,
  );
  if (marker === undefined && !isPreviousReleaseDir(dir, home, options.instanceId)) return;
  const recorded = marker?.trim() ?? "";
  const main = NodePath.isAbsolute(recorded)
    ? NodePath.resolve(recorded)
    : NodePath.join(home, ".claude");
  if (dir === main || (await realPath(dir)) === (await realPath(main))) return;
  for (const name of SHARED) await shareEntry(dir, main, name, options);
};

const isPreviousReleaseDir = (dir: string, home: string, instanceId: string | undefined) =>
  instanceId !== undefined &&
  PREVIOUS_RELEASE_ID.test(instanceId) &&
  NodePath.dirname(dir) === home &&
  NodePath.basename(dir).startsWith(".claude-");

const shareEntry = async (
  dir: string,
  main: string,
  name: string,
  { platform, log }: ShareClaudeHistoryOptions,
) => {
  const shared = NodePath.join(main, name);
  const own = NodePath.join(dir, name);
  // A junction needs no privilege on Windows; a symlink does.
  const link = (at: string) =>
    NodeFSP.symlink(shared, at, platform === "win32" ? "junction" : "dir");
  await NodeFSP.mkdir(shared, { recursive: true });
  const stat = await NodeFSP.lstat(own).catch(() => undefined);
  if (stat === undefined) {
    await link(own).catch((error) => log(`Couldn't link ${own} to ${shared}: ${message(error)}`));
    return;
  }
  if (stat.isSymbolicLink()) {
    if ((await realPath(own)) !== (await realPath(shared))) {
      log(`${own} links elsewhere; left it separate from ${shared}`);
    }
    return;
  }
  // E.g. the main dir's `projects` links into the account's: merging would delete it all.
  if (await overlaps(own, shared)) {
    log(`${own} and ${shared} are one directory already; left both as they are`);
    return;
  }
  if (!stat.isDirectory()) {
    log(`${own} is not a directory; left it separate from ${shared}`);
    return;
  }
  if (await claudeIsRunning(dir)) {
    log(`Claude is running on ${dir}; ${name} stays separate until it stops`);
    return;
  }
  // Linked under a temporary name first: nothing moves where no link can be made.
  const staged = `${own}.t3-link`;
  await NodeFSP.unlink(staged).catch(() => undefined);
  try {
    await link(staged);
  } catch (error) {
    log(`Couldn't link ${own} to ${shared}: ${message(error)}`);
    return;
  }
  const suffix = `.from-${NodePath.basename(dir)}`;
  const merged = await mergeInto(own, shared, suffix, log).catch((error) => {
    log(`Couldn't merge ${own} into ${shared}: ${message(error)}`);
    return false;
  });
  if (merged && (await succeeds(NodeFSP.rmdir(own)))) {
    await NodeFSP.rename(staged, own).catch((error) =>
      log(`Couldn't link ${own} to ${shared}: ${message(error)}`),
    );
    return;
  }
  // What couldn't move goes aside (same volume), so the account shares anyway.
  const aside = `${own}.unmerged-${Date.now()}`;
  if (await succeeds(NodeFSP.rename(own, aside))) {
    if (await succeeds(NodeFSP.rename(staged, own))) {
      log(`Some of ${own} couldn't be merged into ${shared}; linked it, the rest is in ${aside}`);
      return;
    }
    await NodeFSP.rename(aside, own).catch((error) =>
      log(`Couldn't move ${aside} back to ${own}: ${message(error)}`),
    );
  }
  await NodeFSP.unlink(staged).catch(() => undefined);
  log(`Some of ${own} couldn't be merged into ${shared}; left it separate`);
};

/**
 * Moves `from`'s entries into `to` without overwriting: an entry `to` lacks
 * moves, a directory both have merges, an identical file is dropped, a
 * different one moves as `<name><suffix>` (logged). True when `from` is left
 * empty. Touches nothing where `from` and `to` are one directory.
 */
const mergeInto = async (
  from: string,
  to: string,
  suffix: string,
  log: (message: string) => void,
): Promise<boolean> => {
  if (await overlaps(from, to)) {
    log(`${from} and ${to} are one directory already; left both as they are`);
    return false;
  }
  let complete = true;
  for (const entry of await NodeFSP.readdir(from, { withFileTypes: true })) {
    const source = NodePath.join(from, entry.name);
    const target = NodePath.join(to, entry.name);
    const existing = await NodeFSP.lstat(target).catch(() => undefined);
    if (existing === undefined) {
      if (!entry.isFile()) await NodeFSP.rename(source, target);
      else if (!(await moveFile(source, target))) complete = false;
    } else if (entry.isDirectory() && existing.isDirectory()) {
      if (await mergeInto(source, target, suffix, log)) await NodeFSP.rmdir(source);
      else complete = false;
    } else if (entry.isFile() && existing.isFile() && (await sameFile(source, target))) {
      await NodeFSP.unlink(source);
    } else if (entry.isFile() && (await moveFile(source, target + suffix))) {
      log(`Kept both copies of ${target}: the account's is ${target}${suffix}`);
    } else {
      complete = false;
    }
  }
  return complete;
};

/**
 * Moves a file to `target` unless something is there, even something that
 * appeared just now: a hard link can't replace a file the way a rename does.
 */
const moveFile = async (source: string, target: string) => {
  try {
    await NodeFSP.link(source, target);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  await NodeFSP.unlink(source);
  return true;
};

/**
 * Whether `a` and `b` are one directory: the same inode (through links, or a
 * bind mount) or real paths that are equal or nested.
 */
const overlaps = async (a: string, b: string) => {
  const [left, right] = await Promise.all(
    [a, b].map((path) => NodeFSP.stat(path).catch(() => undefined)),
  );
  if (left && right && left.dev === right.dev && left.ino === right.ino) return true;
  const [realA, realB] = await Promise.all([realPath(a), realPath(b)]);
  return (
    realA !== undefined && realB !== undefined && (within(realA, realB) || within(realB, realA))
  );
};

const within = (path: string, dir: string) => path === dir || path.startsWith(dir + NodePath.sep);

const sameFile = async (a: string, b: string) => {
  const [left, right] = await Promise.all([NodeFSP.lstat(a), NodeFSP.lstat(b)]);
  if (left.size !== right.size) return false;
  const [leftBytes, rightBytes] = await Promise.all([NodeFSP.readFile(a), NodeFSP.readFile(b)]);
  return leftBytes.equals(rightBytes);
};

/** Claude Code keeps `<config dir>/sessions/<pid>.json` while it runs. */
const claudeIsRunning = async (dir: string) => {
  const sessions = NodePath.join(dir, "sessions");
  const names = await NodeFSP.readdir(sessions).catch(() => []);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const pid = await readPid(NodePath.join(sessions, name));
    if (pid !== undefined && isAlive(pid)) return true;
  }
  return false;
};

const readPid = async (file: string) => {
  try {
    const value: unknown = JSON.parse(await NodeFSP.readFile(file, "utf8"));
    if (typeof value !== "object" || value === null || !("pid" in value)) return undefined;
    const { pid } = value;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // The process exists but belongs to another user.
    return errorCode(error) === "EPERM";
  }
};

const succeeds = (promise: Promise<unknown>) =>
  promise.then(
    () => true,
    () => false,
  );

const realPath = (path: string) => NodeFSP.realpath(path).catch(() => undefined);

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The continuation key of the Claude instance `instanceId` on `configDir`.
 * Shares an account dir's conversations first (`shareClaudeHistory`), then keys the
 * instance by the dir its `projects` resolves to, so `~/.claude` and every
 * account linked to it get `claude:home:<~/.claude>`. `upstreamKey`
 * (ClaudeHome.ts) when `projects` is missing or resolves to another name.
 */
export const claudeSharedHistoryKey = Effect.fn("claudeSharedHistoryKey")(function* (
  configDir: string,
  upstreamKey: string,
  instanceId: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const notes: Array<string> = [];
  yield* Effect.tryPromise({
    try: () =>
      shareClaudeHistory(configDir, {
        home: NodeOS.homedir(),
        platform,
        instanceId,
        log: (note) => notes.push(note),
      }),
    catch: message,
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => notes.push(`Couldn't share ${configDir}'s Claude history: ${error}`)),
    ),
  );
  yield* Effect.forEach(notes, (note) => Effect.logWarning(note), { discard: true });
  const projects = yield* fileSystem.realPath(path.join(configDir, "projects")).pipe(Effect.option);
  return Option.isSome(projects) && path.basename(projects.value) === "projects"
    ? `claude:home:${path.dirname(projects.value)}`
    : upstreamKey;
});
