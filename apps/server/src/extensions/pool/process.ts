// @effect-diagnostics globalTimers:off - the pool's process manager is plain async Node by design; Effect wraps it at the layer and handler boundary.
// @effect-diagnostics nodeBuiltinImport:off - the pool manages a downloaded binary, its files and its child process with plain Node.
/** Small child-process helpers for the pool (plain Node, no shell). */
import * as NodeChildProcess from "node:child_process";

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `command args`, rejecting on a non-zero exit, a spawn error or the timeout. */
export const runProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly timeoutMs?: number;
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    /** Only for Windows `.cmd` shims, as resolved by T3's `resolveSpawnCommand`. */
    readonly shell?: boolean;
  } = {},
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr = (stderr + String(chunk)).slice(-4000)));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, options.timeoutMs ?? 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim().slice(-400)}`));
    });
  });
