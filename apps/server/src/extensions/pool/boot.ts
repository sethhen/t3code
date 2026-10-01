// @effect-diagnostics globalTimers:off - the pool's boot cleanup is plain async Node by design; Effect wraps it at the layer boundary.
// @effect-diagnostics nodeBuiltinImport:off - the cleanup reads and deletes the retired pool's files and stops its process with plain Node.
/**
 * Retiring the pool at server start: stop a proxy an older build left
 * running, save the accounts it held to the move list, then delete
 * `<stateDir>/pool` (refresh tokens, a plaintext management key, the proxy
 * binary, logs). Safe to run on every start: once the directory is gone it
 * does nothing.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { runProcess } from "./process.ts";
import {
  isMissing,
  isRecord,
  jwtClaims,
  jwtPlanType,
  mergeMoveEntries,
  type MoveEntry,
  moveListPath,
  type PoolPaths,
  poolPaths,
  text,
  updateMoveList,
} from "./state.ts";
import { codexPlanLabel } from "./t3.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ProcessInfo {
  readonly executable: string;
  readonly commandLine: string;
}

const processInfo = async (pid: number, platform: string): Promise<ProcessInfo | undefined> => {
  try {
    if (platform === "win32") {
      const { stdout } = await runProcess(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.ExecutablePath; $p.CommandLine }`,
        ],
        { timeoutMs: 10_000 },
      );
      const [executable = "", ...rest] = stdout.split(/\r?\n/);
      return executable.trim()
        ? { executable: executable.trim(), commandLine: rest.join(" ") }
        : undefined;
    }
    // Empty output when the pid is gone.
    const { stdout } = await runProcess("ps", ["-p", String(pid), "-o", "command="], {
      timeoutMs: 5_000,
    });
    const commandLine = stdout.trim();
    // `ps` prints argv joined by spaces; argv[0] is the absolute path the pool spawned.
    return commandLine ? { executable: commandLine, commandLine } : undefined;
  } catch {
    return undefined;
  }
};

/**
 * True only for the pool's own proxy: its executable lives in the pool's
 * `bin` directory and it runs the pool's config. A bare name match would also
 * hit any other CLIProxyAPI on the machine (EasyCLIProxyAPI, CC Switch), or an
 * unrelated process that inherited a recycled pid.
 */
export const isOwnProxy = (
  info: ProcessInfo,
  paths: Pick<PoolPaths, "binDir" | "configPath">,
  platform: string,
) => {
  const normalize = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const separator = platform === "win32" ? "\\" : "/";
  const binDir = normalize(paths.binDir.replace(/[\\/]+$/, "") + separator);
  return (
    normalize(info.executable).startsWith(binDir) &&
    normalize(info.commandLine).includes(normalize(paths.configPath))
  );
};

/** Kills the proxy named by the pid file, only if it is the pool's own. */
const killStaleProxy = async (
  paths: Pick<PoolPaths, "pidPath" | "binDir" | "configPath">,
  platform: string,
) => {
  const raw = await NodeFSP.readFile(paths.pidPath, "utf8").catch(() => undefined);
  if (raw === undefined) return;
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  const info = await processInfo(pid, platform);
  if (!info || !isOwnProxy(info, paths, platform)) return;
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
  // Windows can't delete a running executable; give it a moment to exit.
  await sleep(500);
};

/** "codex-<email>-<plan>.json" → the plan's label, for files without an id_token. */
const planFromFileName = (name: string, email: string) => {
  const base = name.replace(/\.json$/i, "");
  const at = base.toLowerCase().lastIndexOf(email.toLowerCase());
  const rest = at < 0 ? "" : base.slice(at + email.length);
  return rest.startsWith("-") ? codexPlanLabel(rest.slice(1)) : undefined;
};

/**
 * The accounts in the pool's auth directory (top-level files), paused ones
 * included. Only a missing directory means "none": any other read failure
 * throws, so the caller never deletes accounts it could not list.
 */
const scanPoolAccounts = async (authDir: string): Promise<MoveEntry[]> => {
  let files: Array<{ readonly name: string; readonly isFile: () => boolean }>;
  try {
    files = await NodeFSP.readdir(authDir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const accounts: MoveEntry[] = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    const content = await NodeFSP.readFile(NodePath.join(authDir, file.name), "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      // Damaged: there is no email to keep.
      continue;
    }
    if (!isRecord(raw)) continue;
    const email = text(raw.email);
    if (!email || (raw.type !== "claude" && raw.type !== "codex")) continue;
    if (raw.type === "claude") {
      accounts.push({ provider: "claude", email });
      continue;
    }
    const plan =
      codexPlanLabel(jwtPlanType(jwtClaims(raw.id_token)) || undefined) ??
      planFromFileName(file.name, email);
    accounts.push({ provider: "codex", email, ...(plan ? { plan } : {}) });
  }
  return accounts;
};

/**
 * Steps a-d of the move: stop the proxy, save the accounts in its auth
 * directory, then delete the pool directory, only once the list is safely
 * written. `pool.json` is not read: a pool later pointed at an external server
 * can still hold this machine's earlier sign-ins (without any, the directory
 * is empty), and a damaged file must not leave the pool's tokens on disk.
 */
export const migratePool = async (stateDir: string, platform: string) => {
  const paths = poolPaths(stateDir);
  await killStaleProxy(paths, platform);
  const exists = await NodeFSP.stat(paths.root).then(
    () => true,
    (error: unknown) => {
      if (isMissing(error)) return false;
      throw error;
    },
  );
  if (!exists) return;
  const accounts = await scanPoolAccounts(paths.authDir);
  await updateMoveList(moveListPath(stateDir), (current) => mergeMoveEntries(current, accounts));
  await NodeFSP.rm(paths.root, { recursive: true, force: true });
};
