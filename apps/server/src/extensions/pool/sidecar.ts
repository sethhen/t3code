// @effect-diagnostics globalTimers:off globalDate:off globalFetch:off - the pool's process manager is plain async Node by design; Effect wraps it at the layer and handler boundary.
// @effect-diagnostics nodeBuiltinImport:off - the pool manages a downloaded binary, its files and its child process with plain Node.
/**
 * The local CLIProxyAPI process: one per T3 server, started from the user's
 * state directory, restarted with backoff whenever it goes away, and stopped
 * when the server shuts down. A pid file lets the next start clean up a proxy
 * left behind by a hard kill (a stale proxy would hold the port and the OAuth
 * callback ports).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";

import { renderProxyConfig } from "./config.ts";
import { runProcess } from "./process.ts";
import type { PoolPaths } from "./state.ts";

export type SidecarPhase = "stopped" | "starting" | "running" | "error";

export interface SidecarSnapshot {
  readonly phase: SidecarPhase;
  readonly message?: string;
}

export interface SidecarOptions {
  readonly paths: PoolPaths;
  readonly binaryPath: string;
  readonly clientKey: string;
  readonly managementKey: string;
  /**
   * The port to listen on, asked before every (re)start: the controller moves the
   * pool to a free port (and re-applies routing) when something else took it.
   */
  readonly ensurePort: () => Promise<number>;
  readonly onChange: () => void;
}

const HEALTH_TIMEOUT_MS = 20_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Deletes the pid file only while it still names `pid` (a newer proxy may have replaced it). */
export const removePidFileIf = async (pidPath: string, pid: number | undefined) => {
  if (pid === undefined) return;
  const current = await NodeFsPromises.readFile(pidPath, "utf8").catch(() => "");
  if (Number.parseInt(current, 10) === pid) await NodeFsPromises.rm(pidPath, { force: true });
};

export interface ProcessInfo {
  readonly executable: string;
  readonly commandLine: string;
}

const processInfo = async (pid: number): Promise<ProcessInfo | undefined> => {
  try {
    if (process.platform === "win32") {
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
    const { stdout } = await runProcess("ps", ["-p", String(pid), "-o", "command="], {
      timeoutMs: 5_000,
    });
    const commandLine = stdout.trim();
    // `ps` prints argv joined by spaces; argv[0] is the absolute path the pool spawned.
    return commandLine ? { executable: commandLine, commandLine } : undefined;
  } catch {
    // `ps` exits non-zero when the pid is gone.
    return undefined;
  }
};

/**
 * True only for this pool's own proxy: its executable lives in this pool's
 * `bin` directory and it runs this pool's config. A bare name match would also
 * hit any other CLIProxyAPI on the machine (EasyCLIProxyAPI, CC Switch), or an
 * unrelated process that inherited a recycled pid.
 */
export const isOwnProxy = (
  info: ProcessInfo,
  paths: Pick<PoolPaths, "binDir" | "configPath">,
  platform: string = process.platform,
) => {
  const normalize = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const separator = platform === "win32" ? "\\" : "/";
  const binDir = normalize(paths.binDir.replace(/[\\/]+$/, "") + separator);
  return (
    normalize(info.executable).startsWith(binDir) &&
    normalize(info.commandLine).includes(normalize(paths.configPath))
  );
};

/** Kills a proxy a previous run left behind, only if the pid file still names this pool's proxy. */
export const killStaleProxy = async (
  paths: Pick<PoolPaths, "pidPath" | "binDir" | "configPath">,
) => {
  const raw = await NodeFsPromises.readFile(paths.pidPath, "utf8").catch(() => undefined);
  if (raw === undefined) return;
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    await NodeFsPromises.rm(paths.pidPath, { force: true });
    return;
  }
  const info = await processInfo(pid);
  if (info && isOwnProxy(info, paths)) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
    await sleep(500);
  }
  await removePidFileIf(paths.pidPath, pid);
};

export class Sidecar {
  private readonly options: SidecarOptions;
  private child: NodeChildProcess.ChildProcess | undefined;
  private snapshot: SidecarSnapshot = { phase: "stopped" };
  private stopping = false;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private startPromise: Promise<void> | undefined;
  private currentPort: number | undefined;

  constructor(options: SidecarOptions) {
    this.options = options;
  }

  get state(): SidecarSnapshot {
    return this.snapshot;
  }

  /** The port the running (or last started) proxy listens on. */
  get port() {
    return this.currentPort;
  }

  private set(next: SidecarSnapshot) {
    this.snapshot = next;
    this.options.onChange();
  }

  /**
   * Starts the proxy and waits (bounded) for it to answer. Serialised: a retry
   * and a controller start share one attempt. Never rejects; a failure is
   * recorded and retried with backoff (it may run from a timer, where a
   * rejection would be unhandled and take the server down).
   */
  start(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.startPromise ??= this.attempt()
      .catch((error: unknown) => {
        if (!this.stopping) this.fail(`The pool could not start: ${messageOf(error)}.`);
      })
      .finally(() => {
        this.startPromise = undefined;
      });
    return this.startPromise;
  }

  private async attempt(): Promise<void> {
    if (this.child || this.stopping) return;
    this.clearRetry();
    this.set({ phase: "starting" });
    const { paths } = this.options;
    const port = await this.options.ensurePort();
    if (this.stopping) return;
    await NodeFsPromises.mkdir(paths.authDir, { recursive: true, mode: 0o700 });
    // In place: the proxy watches this file, and a rename reads as a delete.
    await NodeFsPromises.writeFile(
      paths.configPath,
      renderProxyConfig({ ...this.options, port, authDir: paths.authDir }),
      { mode: 0o600 },
    );
    if (this.stopping || this.child) return;
    this.currentPort = port;

    const log = NodeFs.openSync(paths.logPath, "w");
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(this.options.binaryPath, ["-config", paths.configPath], {
        cwd: paths.root,
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
    } finally {
      NodeFs.closeSync(log);
    }
    this.child = child;

    // One path for every way the process can go (a failed spawn emits 'error' and may
    // never emit 'exit'), attached before any await so no event is missed.
    let gone = false;
    // Backstop for exits that skip the layer finalizer (e.g. process.exit): never leave the
    // proxy holding its port after T3 is gone. The pid file covers a hard kill on next start.
    const killOnExit = () => {
      if (child.exitCode === null) child.kill();
    };
    const onGone = (reason: string) => {
      if (gone) return;
      gone = true;
      process.off("exit", killOnExit);
      if (this.child === child) this.child = undefined;
      void removePidFileIf(paths.pidPath, child.pid).catch(() => undefined);
      if (!this.stopping) this.fail(`${reason}. Log: ${paths.logPath}.`);
    };
    process.once("exit", killOnExit);
    child.once("error", (error) => onGone(`The pool could not start: ${error.message}`));
    child.once("exit", (code, signal) => onGone(`The pool stopped (${signal ?? `exit ${code}`})`));

    // Only for crash cleanup: a failed write must not take down a healthy proxy.
    if (child.pid) {
      await NodeFsPromises.writeFile(paths.pidPath, String(child.pid)).catch(() => undefined);
    }

    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline && this.child === child) {
      if (await this.healthy(port)) {
        if (this.child !== child) return;
        this.failures = 0;
        this.set({ phase: "running" });
        return;
      }
      await sleep(300);
    }
    if (this.child === child && !this.stopping) {
      // Not answering (e.g. the port was taken): kill it; the exit path schedules the retry.
      child.kill("SIGKILL");
    }
  }

  /** Records the failure and schedules the next attempt. */
  private fail(message: string) {
    const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!;
    this.failures++;
    this.set({ phase: "error", message: `${message} Retrying in ${delay / 1000}s.` });
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.start();
    }, delay);
    this.retryTimer.unref();
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async healthy(port: number) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${this.options.clientKey}` },
        signal: AbortSignal.timeout(1_500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Stops the proxy; waits out a start in progress so nothing lands after it returns. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRetry();
    await this.kill(this.child);
    await this.startPromise;
    // A start that spawned just before it saw `stopping`.
    await this.kill(this.child);
    this.snapshot = { phase: "stopped" };
  }

  private async kill(child: NodeChildProcess.ChildProcess | undefined) {
    if (!child) return;
    if (this.child === child) this.child = undefined;
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(3_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await removePidFileIf(this.options.paths.pidPath, child.pid).catch(() => undefined);
  }
}
