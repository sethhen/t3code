// @effect-diagnostics nodeBuiltinImport:off - the pool manages a downloaded binary, its files and its child process with plain Node.
/**
 * The pinned CLIProxyAPI release the local pool runs.
 *
 * Downloaded on first use (not bundled): the server may run on macOS, Windows
 * or a Linux WSL runtime, and a binary in the user's state directory is never
 * locked by an installer replacing the app. Every archive is checked against
 * the SHA-256 GitHub published for it before anything is extracted.
 *
 * Bumping the version: take the digests from
 * `gh api repos/router-for-me/CLIProxyAPI/releases/tags/v<version> --jq '.assets[] | [.name, .digest]'`,
 * then re-run the pool's parity checks against a real account (FORK.md).
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import { runProcess } from "./process.ts";

export const CLIPROXY_VERSION = "7.3.17";

const RELEASE_URL = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLIPROXY_VERSION}`;

interface ReleaseAsset {
  readonly file: string;
  readonly sha256: string;
}

/** Keyed by `<platform>-<arch>` (Node's names). */
export const RELEASE_ASSETS: Readonly<Record<string, ReleaseAsset>> = {
  "darwin-arm64": {
    file: `CLIProxyAPI_${CLIPROXY_VERSION}_darwin_aarch64.tar.gz`,
    sha256: "59bca8a23938216eab42380362424a109986df20c70d5f552948d3dfeb3c7820",
  },
  "darwin-x64": {
    file: `CLIProxyAPI_${CLIPROXY_VERSION}_darwin_amd64.tar.gz`,
    sha256: "37f6b9767d2820d96095f5a792041b6c11dcd7420023aa2c3fe1769aaeff6612",
  },
  "linux-arm64": {
    file: `CLIProxyAPI_${CLIPROXY_VERSION}_linux_aarch64.tar.gz`,
    sha256: "65a250f749222eee88d949e94efd88c9a9640728e01ae83e1353bac591487e3f",
  },
  "linux-x64": {
    file: `CLIProxyAPI_${CLIPROXY_VERSION}_linux_amd64.tar.gz`,
    sha256: "1c9aef78dcd372775ccd5252bd0f383366c93c1fa552204df8ea9191fa130927",
  },
  "win32-arm64": {
    file: `CLIProxyAPI_${CLIPROXY_VERSION}_windows_aarch64.zip`,
    sha256: "99fb4d3bdfc8d2e2002f2fb4d2c0b5d724cefe60d0c1c110f7e00cd8a49ef0ad",
  },
  "win32-x64": {
    file: `CLIProxyAPI_${CLIPROXY_VERSION}_windows_amd64.zip`,
    sha256: "3a036376a7c04a8fe70d7335915aa79cc520f8fad72030ef8da43a64e50bc38b",
  },
};

export const releaseAssetFor = (platform: string, arch: string): ReleaseAsset | undefined =>
  RELEASE_ASSETS[`${platform}-${arch}`];

export const binaryName = (platform: string) =>
  platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";

const exists = (path: string) =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );

const sha256Of = async (path: string) => {
  const hash = NodeCrypto.createHash("sha256");
  await NodeStreamPromises.pipeline(NodeFS.createReadStream(path), hash);
  return hash.digest("hex");
};

/**
 * The binary for this platform under `binDir/<version>/`, downloading and
 * verifying it first if needed. Older versions are removed once the new one
 * is in place.
 */
export const ensureBinary = async (
  binDir: string,
  options: {
    /** The host's `HostProcessPlatform` / `HostProcessArchitecture`. */
    readonly platform: string;
    readonly arch: string;
    readonly fetch?: typeof fetch;
    /** Cancels the download (the pool stopped, T3 is quitting). */
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
): Promise<string> => {
  const { platform, arch } = options;
  const asset = releaseAssetFor(platform, arch);
  if (!asset) {
    throw new Error(`Account sharing doesn't support ${platform} on ${arch} yet.`);
  }
  const versionDir = NodePath.join(binDir, CLIPROXY_VERSION);
  const binaryPath = NodePath.join(versionDir, binaryName(platform));
  if (await exists(binaryPath)) return binaryPath;

  await NodeFSP.mkdir(binDir, { recursive: true });
  const staging = await NodeFSP.mkdtemp(NodePath.join(binDir, ".download-"));
  try {
    const archive = NodePath.join(staging, asset.file);
    const signal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(options.timeoutMs ?? 180_000),
    ]);
    const response = await (options.fetch ?? fetch)(`${RELEASE_URL}/${asset.file}`, {
      redirect: "follow",
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Downloading CLIProxyAPI failed (HTTP ${response.status}).`);
    }
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(
        response.body as Parameters<typeof NodeStream.Readable.fromWeb>[0],
      ),
      NodeFS.createWriteStream(archive),
      { signal },
    );
    const digest = await sha256Of(archive);
    if (digest !== asset.sha256) {
      throw new Error(
        `The CLIProxyAPI download failed its checksum (got ${digest.slice(0, 12)}…); nothing was installed.`,
      );
    }
    // bsdtar (macOS, Windows 10+) reads .zip too; GNU tar on Linux gets .tar.gz only.
    const extracted = NodePath.join(staging, "out");
    await NodeFSP.mkdir(extracted);
    await runProcess("tar", ["-xf", archive, "-C", extracted], { timeoutMs: 120_000 });
    const extractedBinary = NodePath.join(extracted, binaryName(platform));
    if (!(await exists(extractedBinary))) {
      throw new Error("The CLIProxyAPI archive did not contain the proxy binary.");
    }
    if (platform !== "win32") await NodeFSP.chmod(extractedBinary, 0o755);
    await NodeFSP.rm(versionDir, { recursive: true, force: true });
    await NodeFSP.mkdir(versionDir, { recursive: true });
    await NodeFSP.rename(extractedBinary, binaryPath);
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }

  // Best effort: Windows can't delete an exe a leftover proxy still runs; the next start retries.
  for (const entry of await NodeFSP.readdir(binDir)) {
    if (entry !== CLIPROXY_VERSION && !entry.startsWith(".")) {
      await NodeFSP.rm(NodePath.join(binDir, entry), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
  return binaryPath;
};
