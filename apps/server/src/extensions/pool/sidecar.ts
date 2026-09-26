// @effect-diagnostics globalTimers:off globalDate:off globalFetch:off - the pool's process manager is plain async Node by design; Effect wraps it at the layer and handler boundary.
// @effect-diagnostics nodeBuiltinImport:off - the pool manages a downloaded binary, its files and its child process with plain Node.
/**
 * The local CLIProxyAPI process: one per T3 server, started from the user's
 * state directory, restarted with backoff if it dies, and stopped when the
 * server shuts down. A pid file lets the next start clean up a proxy left
 * behind by a crash (a stale proxy would hold the port and the OAuth
 * callback ports).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeFsPromises from "node:fs/promises";

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
  readonly port: number;
  readonly clientKey: string;
  readonly managementKey: string;
  readonly onChange: () => void;
}

const HEALTH_TIMEOUT_MS = 20_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Kills a proxy a previous run left behind, only if the pid still runs our binary. */
export const killStaleProxy = async (pidPath: string, binaryName: string) => {
  let pid: number;
  try {
    pid = Number.parseInt(await NodeFsPromises.readFile(pidPath, "utf8"), 10);
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  let command = "";
  try {
    command =
      process.platform === "win32"
        ? (
            await runProcess("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
              timeoutMs: 5_000,
            })
          ).stdout
        : (await runProcess("ps", ["-p", String(pid), "-o", "command="], { timeoutMs: 5_000 }))
            .stdout;
  } catch {
    // `ps` exits non-zero when the pid is gone.
  }
  if (command.includes(binaryName)) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
    await sleep(500);
  }
  await NodeFsPromises.rm(pidPath, { force: true });
};

export class Sidecar {
  private child: NodeChildProcess.ChildProcess | undefined;
  private snapshot: SidecarSnapshot = { phase: "stopped" };
  private stopping = false;
  private failures = 0;

  private readonly options: SidecarOptions;

  constructor(options: SidecarOptions) {
    this.options = options;
  }

  get state(): SidecarSnapshot {
    return this.snapshot;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.options.port}`;
  }

  private set(next: SidecarSnapshot) {
    this.snapshot = next;
    this.options.onChange();
  }

  async start(): Promise<void> {
    if (this.child || this.stopping) return;
    this.set({ phase: "starting" });
    const { paths } = this.options;
    await NodeFsPromises.mkdir(paths.authDir, { recursive: true, mode: 0o700 });
    await killStaleProxy(paths.pidPath, "cli-proxy-api");
    // In place: the proxy watches this file, and a rename reads as a delete.
    await NodeFsPromises.writeFile(
      paths.configPath,
      renderProxyConfig({ ...this.options, authDir: paths.authDir }),
      {
        mode: 0o600,
      },
    );
    const log = NodeFs.openSync(paths.logPath, "w");
    const child = NodeChildProcess.spawn(
      this.options.binaryPath,
      ["-config", paths.configPath, "-no-browser"],
      { cwd: paths.root, stdio: ["ignore", log, log], windowsHide: true },
    );
    NodeFs.closeSync(log);
    this.child = child;
    if (child.pid) await NodeFsPromises.writeFile(paths.pidPath, String(child.pid));
    // Backstop for exits that skip the layer finalizer (e.g. process.exit): never leave the
    // proxy holding its port after T3 is gone. The pid file covers a hard kill on next start.
    const killOnExit = () => {
      if (child.exitCode === null) child.kill();
    };
    process.once("exit", killOnExit);

    child.once("exit", (code, signal) => {
      process.off("exit", killOnExit);
      if (this.child === child) this.child = undefined;
      void NodeFsPromises.rm(paths.pidPath, { force: true });
      if (this.stopping) return;
      const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!;
      this.failures++;
      this.set({
        phase: "error",
        message: `The pool stopped (${signal ?? `exit ${code}`}); restarting in ${delay / 1000}s. Log: ${paths.logPath}`,
      });
      setTimeout(() => void this.start().catch(() => undefined), delay).unref();
    });
    child.once("error", (error) => {
      this.set({ phase: "error", message: `The pool could not start: ${error.message}` });
    });

    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline && this.child === child) {
      if (await this.healthy()) {
        this.failures = 0;
        this.set({ phase: "running" });
        return;
      }
      await sleep(300);
    }
    if (this.child === child) {
      this.set({
        phase: "error",
        message: `The pool did not answer within ${HEALTH_TIMEOUT_MS / 1000}s. Log: ${paths.logPath}`,
      });
    }
  }

  private async healthy() {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${this.options.clientKey}` },
        signal: AbortSignal.timeout(1_500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(3_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await NodeFsPromises.rm(this.options.paths.pidPath, { force: true });
    this.snapshot = { phase: "stopped" };
  }
}
