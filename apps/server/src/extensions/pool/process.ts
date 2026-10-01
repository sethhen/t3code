// @effect-diagnostics globalTimers:off - the pool's process helpers are plain async Node by design; Effect wraps them at the layer and handler boundary.
// @effect-diagnostics nodeBuiltinImport:off - the pool runs short-lived CLIs with plain Node.
/** Small child-process helper for the pool (plain Node, no shell unless T3 resolved one). */
import * as NodeChildProcess from "node:child_process";

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `command args` to completion. Resolves whatever the exit code (`claude
 * auth status` exits non-zero while still printing its JSON); rejects only when
 * the process can't start or outlives the timeout.
 */
export const runProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly timeoutMs?: number;
    readonly env?: NodeJS.ProcessEnv;
    /** Only for Windows `.cmd` shims, as resolved by T3's `resolveSpawnCommand`. */
    readonly shell?: boolean;
  } = {},
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
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
      resolve({ code, stdout, stderr });
    });
  });
