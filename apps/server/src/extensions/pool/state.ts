// @effect-diagnostics nodeBuiltinImport:off - the pool manages a downloaded binary, its files and its child process with plain Node.
/**
 * The pool's persisted state: `<stateDir>/pool/pool.json` (mode 0600), next to
 * the proxy's config, auth files and binaries. It lives in T3's state
 * directory, never in the app bundle, so app updates keep sign-ins.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import type { PoolRouteMode, PoolSource } from "@t3tools/contracts";

export interface PoolState {
  readonly version: 1;
  readonly source: PoolSource;
  readonly port: number;
  /** Client key T3's Claude and Codex sessions present to the local proxy. */
  readonly clientKey: string;
  /** Plaintext management secret (the proxy stores only its hash). */
  readonly managementKey: string;
  readonly external: { readonly url: string; readonly key: string };
  /** Per-instance route overrides; absent instances use `defaultRouteMode`. */
  readonly routes: Readonly<Record<string, PoolRouteMode>>;
}

export interface PoolPaths {
  readonly root: string;
  readonly statePath: string;
  readonly configPath: string;
  readonly authDir: string;
  readonly binDir: string;
  readonly logPath: string;
  readonly pidPath: string;
  /**
   * Keys T3's Claude sessions read through `apiKeyHelper` (never argv): one 0600 file per
   * pool address, so a session aimed at pool A can only ever read A's key (see `keyFilePath`).
   */
  readonly keysDir: string;
  /** Pre-keysDir single key file, removed on the next routing change. */
  readonly legacyClientKeyPath: string;
  /** OpenAI's Codex model catalog, as fetched through a pool account. */
  readonly codexCatalogPath: string;
}

export const poolPaths = (stateDir: string): PoolPaths => {
  const root = NodePath.join(stateDir, "pool");
  return {
    root,
    statePath: NodePath.join(root, "pool.json"),
    configPath: NodePath.join(root, "config.yaml"),
    authDir: NodePath.join(root, "auth"),
    binDir: NodePath.join(root, "bin"),
    logPath: NodePath.join(root, "proxy.log"),
    pidPath: NodePath.join(root, "proxy.pid"),
    keysDir: NodePath.join(root, "keys"),
    legacyClientKeyPath: NodePath.join(root, "client-key"),
    codexCatalogPath: NodePath.join(root, "codex-models.json"),
  };
};

/** The key file for the pool at `baseUrl`: switching pools never rewrites another pool's key. */
export const keyFilePath = (paths: Pick<PoolPaths, "keysDir">, baseUrl: string) =>
  NodePath.join(
    paths.keysDir,
    NodeCrypto.createHash("sha256").update(baseUrl).digest("hex").slice(0, 16),
  );

/** Default instances (`claudeAgent`, `codex`) use the pool; extra instances stay direct. */
export const defaultRouteMode = (instanceId: string): PoolRouteMode =>
  instanceId === "claudeAgent" || instanceId === "codex" ? "pool" : "direct";

const randomKey = () => NodeCrypto.randomBytes(24).toString("hex");

/** First port in the range that nothing listens on. Stays fixed once chosen. */
export const findFreePort = async (from = 18_417, to = 18_499): Promise<number> => {
  for (let port = from; port <= to; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port for the pool between ${from} and ${to}.`);
};

export const isPortFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Tolerant decode: unknown or damaged fields fall back to defaults, secrets are regenerated. */
export const decodePoolState = (raw: unknown, fallbackPort: number): PoolState => {
  const value = isRecord(raw) ? raw : {};
  const external = isRecord(value.external) ? value.external : {};
  const routes: Record<string, PoolRouteMode> = {};
  if (isRecord(value.routes)) {
    for (const [id, mode] of Object.entries(value.routes)) {
      if (mode === "pool" || mode === "direct") routes[id] = mode;
    }
  }
  const text = (field: unknown) => (typeof field === "string" ? field : "");
  return {
    version: 1,
    source: value.source === "external" ? "external" : "local",
    port:
      typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0
        ? value.port
        : fallbackPort,
    clientKey: text(value.clientKey) || randomKey(),
    managementKey: text(value.managementKey) || randomKey(),
    external: { url: text(external.url), key: text(external.key) },
    routes,
  };
};

export const loadPoolState = async (paths: PoolPaths): Promise<PoolState> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await NodeFSP.readFile(paths.statePath, "utf8"));
  } catch {
    raw = undefined;
  }
  const state = decodePoolState(
    raw,
    isRecord(raw) && typeof raw.port === "number" ? raw.port : await findFreePort(),
  );
  if (raw === undefined || JSON.stringify(raw) !== JSON.stringify(state)) {
    await savePoolState(paths, state);
  }
  return state;
};

export const savePoolState = async (paths: PoolPaths, state: PoolState) => {
  await NodeFSP.mkdir(paths.root, { recursive: true, mode: 0o700 });
  // Unique per write: concurrent saves must never share (and delete) one temp file.
  const temp = `${paths.statePath}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await NodeFSP.rename(temp, paths.statePath);
};
