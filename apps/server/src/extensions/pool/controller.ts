// @effect-diagnostics globalDate:off - the pool's process manager is plain async Node by design; Effect wraps it at the layer and handler boundary.
// @effect-diagnostics nodeBuiltinImport:off - the pool manages a child process and its state files with plain Node.
/**
 * The pool's state machine, shared by every ws connection (one instance per
 * server, created by `layer.ts`). Plain async code: the Effect boundary is the
 * layer and the extension handlers.
 *
 * Routing depends only on persisted facts (source, accounts on disk, route
 * overrides, port, key), never on whether the proxy is up right now. A proxy
 * crash therefore doesn't flip instances to direct and back, which would
 * rebuild them and end every running session; the sidecar restarts itself
 * instead.
 */
import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  PoolAccount,
  PoolCheck,
  PoolLoginStart,
  PoolLoginState,
  PoolProvider,
  PoolRouteMode,
  PoolRuntimeState,
  PoolSetSourceInput,
  PoolStatus,
  ProviderInstanceConfigMap,
  UsageLimitSourceAccount,
  UsageLimitSourceConfig,
} from "@t3tools/contracts";

import { registerInstanceOverlay } from "../instanceOverlays.ts";
import { CLIPROXY_VERSION, ensureBinary } from "./binary.ts";
import {
  type AuthFileEntry,
  accountStatusOf,
  deleteAuthFile,
  fetchCodexCatalog,
  listAuthFiles,
  loginStatus,
  poolProviderOf,
  probeClientKey,
  readRouting,
  setAuthFileDisabled,
  startLogin,
} from "./management.ts";
import { describeRoutes, poolOverlay, type PoolRoutingContext } from "./overlay.ts";
import {
  check,
  findEnvConflicts,
  probeToolSearch,
  readClaudeSettingsEnv,
  type ToolSearchProbe,
} from "./parity.ts";
import { Sidecar, killStaleProxy } from "./sidecar.ts";
import {
  defaultRouteMode,
  findFreePort,
  isPortFree,
  loadPoolState,
  type PoolPaths,
  type PoolState,
  savePoolState,
} from "./state.ts";

/** The pool's entry in `settings.usageLimitSources`, so its quotas show on the usage page. */
export const POOL_USAGE_SOURCE_ID = "cliproxy-t3-pool";

export interface PoolDeps {
  readonly paths: PoolPaths;
  /** The instance map as the registry sees it (overlays applied). */
  readonly instanceMap: () => Promise<ProviderInstanceConfigMap>;
  /** Re-runs the registry reconcile so overlay changes reach the instances. */
  readonly reconcile: () => Promise<void>;
  readonly usageSource: () => Promise<UsageLimitSourceConfig | undefined>;
  readonly setUsageSource: (entry: UsageLimitSourceConfig | null) => Promise<void>;
  readonly usageAccounts: () => Promise<ReadonlyArray<UsageLimitSourceAccount>>;
  readonly refreshUsage: () => Promise<void>;
  /** How a pooled session of `instanceId` launches, for the tool-search probe. */
  readonly claudeProbe: (
    instanceId: string,
  ) => Promise<ToolSearchProbe & { readonly configDir?: string }>;
  /** The version of the Codex CLI the pooled Codex instance runs (`client_version` for its catalog). */
  readonly codexVersion: () => Promise<string | undefined>;
  /** Tests replace the download; production uses `ensureBinary`. */
  readonly installBinary?: (signal: AbortSignal) => Promise<string>;
  readonly log: (message: string, cause?: unknown) => void;
}

const PROVIDER_NAMES: Record<PoolProvider, string> = { claude: "Claude", codex: "ChatGPT" };

/** Native Codex refreshes its catalog on a similar cadence. */
const CODEX_CATALOG_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Auth files straight from disk, for when the proxy isn't running (e.g. at boot). */
export const scanAuthDir = async (authDir: string): Promise<AuthFileEntry[]> => {
  let names: string[];
  try {
    names = await NodeFsPromises.readdir(authDir);
  } catch {
    return [];
  }
  const entries: AuthFileEntry[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    try {
      const raw = JSON.parse(await NodeFsPromises.readFile(NodePath.join(authDir, name), "utf8"));
      const provider = typeof raw?.type === "string" ? raw.type : "";
      if (!poolProviderOf(provider)) continue;
      entries.push({
        name,
        provider,
        ...(typeof raw.email === "string" ? { email: raw.email } : {}),
        disabled: raw.disabled === true,
        unavailable: false,
        status: "",
        statusMessage: "",
      });
    } catch {
      // A half-written file; the proxy's own listing will show it once it's complete.
    }
  }
  return entries;
};

export class PoolController {
  private state!: PoolState;
  private sidecar: Sidecar | undefined;
  private starting: Promise<void> | undefined;
  private startPhase: PoolRuntimeState | undefined;
  private startError: string | undefined;
  private accounts: AuthFileEntry[] = [];
  private accountsError: string | undefined;
  private external: { reachable?: boolean; message?: string } = {};
  private checks: PoolCheck[] = [];
  private checkedAt: string | undefined;
  private checking: Promise<void> | undefined;
  private signature: string | undefined;
  private codexCatalogPath: string | undefined;
  private codexCatalogError: string | undefined;
  private fetchingCatalog: Promise<void> | undefined;
  private unregisterOverlay: (() => void) | undefined;
  private closed = false;
  /** Bumped by every stop; a start that began under an older generation must not spawn. */
  private generation = 0;
  private startAbort: AbortController | undefined;
  /** Serialises state writes: one file, one writer at a time. */
  private stateQueue: Promise<void> = Promise.resolve();

  private readonly deps: PoolDeps;

  constructor(deps: PoolDeps) {
    this.deps = deps;
  }

  async init() {
    this.state = await loadPoolState(this.deps.paths);
    this.accounts = await scanAuthDir(this.deps.paths.authDir);
    this.codexCatalogPath = await NodeFsPromises.access(this.deps.paths.codexCatalogPath).then(
      () => this.deps.paths.codexCatalogPath,
      () => undefined,
    );
    this.unregisterOverlay = registerInstanceOverlay("pool", (map) =>
      poolOverlay(this.routingContext())(map),
    );
    // Rewriting settings to re-reconcile is only needed when the overlay changes something.
    const context = this.routingContext();
    if (context.claude || context.codex) await this.applyRouting();
    else this.signature = this.routingSignature(context);
    if (this.state.source === "local" && this.accounts.length > 0) {
      void this.ensureStarted().catch((error) => this.deps.log("Pool failed to start", error));
    } else if (this.state.source === "external") {
      void this.probeExternal();
    } else {
      void this.runChecks();
    }
  }

  async shutdown() {
    this.closed = true;
    this.unregisterOverlay?.();
    await this.stopLocal();
  }

  // -------------------------------------------------------------------------
  // Routing

  private get localBaseUrl() {
    return `http://127.0.0.1:${this.state.port}`;
  }

  private routingContext(): PoolRoutingContext {
    const state = this.state;
    const modeFor = (instanceId: string): PoolRouteMode =>
      state.routes[instanceId] ?? defaultRouteMode(instanceId);
    const keyHelper = { path: this.deps.paths.clientKeyPath, platform: process.platform };
    if (state.source === "external") {
      const endpoint =
        state.external.url && state.external.key
          ? { baseUrl: state.external.url.replace(/\/+$/, ""), key: state.external.key }
          : undefined;
      return { claude: endpoint, codex: endpoint, modeFor, keyHelper };
    }
    const endpoint = { baseUrl: this.localBaseUrl, key: state.clientKey };
    const serves = (provider: PoolProvider) =>
      this.accounts.some((account) => account.provider === provider && !account.disabled);
    return {
      claude: serves("claude") ? endpoint : undefined,
      codex: serves("codex") ? endpoint : undefined,
      codexCatalogPath: serves("codex") ? this.codexCatalogPath : undefined,
      modeFor,
      keyHelper,
    };
  }

  private routingSignature(context: PoolRoutingContext) {
    return JSON.stringify({
      claude: context.claude ?? null,
      codex: context.codex ?? null,
      codexCatalogPath: context.codexCatalogPath ?? null,
      routes: this.state.routes,
    });
  }

  /** Reconciles the provider instances when anything the overlay reads has changed. */
  private async applyRouting() {
    const context = this.routingContext();
    const signature = this.routingSignature(context);
    if (signature === this.signature) return;
    this.signature = signature;
    await this.writeClientKey(context.claude?.key ?? context.codex?.key);
    await this.deps.reconcile();
    void this.runChecks();
  }

  /** The key file `apiKeyHelper` prints (0600; the key never goes on a command line). */
  private async writeClientKey(key: string | undefined) {
    if (!key) return;
    const path = this.deps.paths.clientKeyPath;
    await NodeFsPromises.mkdir(this.deps.paths.root, { recursive: true, mode: 0o700 });
    await NodeFsPromises.writeFile(path, key, { mode: 0o600 });
    await NodeFsPromises.chmod(path, 0o600);
  }

  /** Serialised: the change sees the latest state, and memory follows only a successful write. */
  private updateState(change: (current: PoolState) => PoolState): Promise<PoolState> {
    const run = this.stateQueue.then(async () => {
      const next = change(this.state);
      await savePoolState(this.deps.paths, next);
      this.state = next;
      return next;
    });
    this.stateQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // -------------------------------------------------------------------------
  // Local proxy

  private get running() {
    return this.sidecar?.state.phase === "running";
  }

  private get target() {
    return { baseUrl: this.localBaseUrl, managementKey: this.state.managementKey };
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error("T3 is shutting down.");
    if (this.running) return;
    if (this.starting) return this.starting;
    // A stop (shutdown, switch to External, restart) between here and the spawn cancels it.
    const generation = this.generation;
    const abort = new AbortController();
    this.startAbort = abort;
    const stillWanted = () =>
      generation === this.generation && !this.closed && this.state.source === "local";
    const stopped = () => new Error("The pool was stopped.");
    this.starting = (async () => {
      this.startError = undefined;
      try {
        this.startPhase = "downloading";
        const install =
          this.deps.installBinary ??
          ((signal: AbortSignal) => ensureBinary(this.deps.paths.binDir, { signal }));
        const binaryPath = await install(abort.signal);
        if (!stillWanted()) throw stopped();
        this.startPhase = "starting";
        if (!this.sidecar) {
          await killStaleProxy(this.deps.paths);
          if (!stillWanted()) throw stopped();
          this.sidecar = new Sidecar({
            paths: this.deps.paths,
            binaryPath,
            clientKey: this.state.clientKey,
            managementKey: this.state.managementKey,
            ensurePort: () => this.ensurePort(),
            onChange: () => {
              if (this.running) void this.afterProxyUp();
            },
          });
        }
        await this.sidecar.start();
        if (!this.running) {
          throw new Error(this.sidecar?.state.message ?? "The pool did not start.");
        }
      } catch (error) {
        if (stillWanted()) this.startError = messageOf(error);
        throw error;
      } finally {
        this.startPhase = undefined;
        this.starting = undefined;
        if (this.startAbort === abort) this.startAbort = undefined;
      }
    })();
    return this.starting;
  }

  /** The pool's port, moved to a free one (and routing re-applied) if something else took it. */
  private async ensurePort(): Promise<number> {
    if (await isPortFree(this.state.port)) return this.state.port;
    const port = await findFreePort();
    await this.updateState((current) => ({ ...current, port }));
    await this.applyRouting();
    return port;
  }

  private async afterProxyUp() {
    await this.refreshAccounts().catch(() => undefined);
    void this.refreshCodexCatalog();
    await this.syncUsageSource().catch((error) => this.deps.log("Pool usage source", error));
    void this.runChecks();
  }

  /** Stops the proxy, cancelling (and waiting out) a start in progress. */
  private async stopLocal() {
    this.generation++;
    this.startAbort?.abort();
    const sidecar = this.sidecar;
    this.sidecar = undefined;
    await sidecar?.stop();
    await this.starting?.catch(() => undefined);
    const late = this.sidecar as Sidecar | undefined;
    this.sidecar = undefined;
    await late?.stop();
  }

  private async refreshAccounts() {
    if (this.state.source !== "local") return;
    try {
      this.accounts = this.running
        ? (await listAuthFiles(this.target)).filter((file) => poolProviderOf(file.provider))
        : await scanAuthDir(this.deps.paths.authDir);
      this.accountsError = undefined;
    } catch (error) {
      this.accountsError = messageOf(error);
    }
    await this.applyRouting();
  }

  private refreshCodexCatalog(): Promise<void> {
    if (this.fetchingCatalog) return this.fetchingCatalog;
    this.fetchingCatalog = this.fetchCodexCatalogIfStale()
      .catch((error) => {
        this.codexCatalogError = messageOf(error);
      })
      .finally(() => {
        this.fetchingCatalog = undefined;
      });
    return this.fetchingCatalog;
  }

  private async fetchCodexCatalogIfStale() {
    if (this.state.source !== "local" || !this.running) return;
    const account = this.accounts.find(
      (file) => file.provider === "codex" && !file.disabled && file.authIndex,
    );
    if (!account) return;
    const path = this.deps.paths.codexCatalogPath;
    const age = await NodeFsPromises.stat(path).then(
      (stat) => Date.now() - stat.mtimeMs,
      () => Number.POSITIVE_INFINITY,
    );
    if (this.codexCatalogPath && age < CODEX_CATALOG_MAX_AGE_MS) return;
    const version = await this.deps.codexVersion();
    if (!version) throw new Error("couldn't read the Codex CLI version");
    const catalog = await fetchCodexCatalog(this.target, account, version);
    // In place, never renamed: running Codex sessions may be reading it.
    await NodeFsPromises.writeFile(path, `${JSON.stringify(catalog)}\n`);
    this.codexCatalogPath = path;
    this.codexCatalogError = undefined;
    await this.applyRouting();
  }

  private async syncUsageSource() {
    const current = await this.deps.usageSource();
    const wanted: UsageLimitSourceConfig | null =
      this.state.source === "local" && this.running && this.accounts.length > 0
        ? {
            kind: "cliproxy",
            label: "Pool",
            url: this.localBaseUrl,
            managementKey: this.state.managementKey,
            enabled: true,
          }
        : null;
    if (JSON.stringify(current ?? null) === JSON.stringify(wanted)) return;
    // Keep the entry while the proxy restarts; drop it only when the pool no longer applies.
    if (wanted === null && this.state.source === "local" && this.accounts.length > 0) return;
    await this.deps.setUsageSource(wanted);
    if (wanted) await this.deps.refreshUsage();
  }

  private async probeExternal() {
    const { url, key } = this.state.external;
    const result =
      url && key
        ? await probeClientKey(url, key)
        : { ok: false, message: "Add the pool URL and key." };
    this.external = {
      reachable: result.ok,
      ...(result.message ? { message: result.message } : {}),
    };
    void this.runChecks();
  }

  // -------------------------------------------------------------------------
  // Status

  private runtimeState(): PoolStatus["runtime"] {
    const base = { version: CLIPROXY_VERSION };
    if (this.state.source === "external") return { ...base, state: "idle" };
    if (this.startPhase) return { ...base, state: this.startPhase };
    const sidecar = this.sidecar?.state;
    if (sidecar?.phase === "running") {
      return { ...base, state: "running", endpoint: `127.0.0.1:${this.state.port}` };
    }
    if (sidecar?.phase === "error" || this.startError) {
      return {
        ...base,
        state: "error",
        message: sidecar?.message ?? this.startError ?? "The pool stopped.",
      };
    }
    if (sidecar?.phase === "starting") return { ...base, state: "starting" };
    return { ...base, state: "idle" };
  }

  async status(): Promise<PoolStatus> {
    if (this.state.source === "local" && this.running) {
      await this.refreshAccounts();
      void this.refreshCodexCatalog();
    }
    const usage = new Map(
      (await this.deps.usageAccounts().catch(() => [])).map((account) => [account.id, account]),
    );
    const now = Date.now();
    const accounts = this.accounts.flatMap((file): PoolAccount[] => {
      const provider = poolProviderOf(file.provider);
      if (!provider) return [];
      const reading = usage.get(file.name);
      return [
        {
          id: file.name,
          provider,
          ...(file.email ? { email: file.email } : {}),
          ...(reading?.plan ? { plan: reading.plan } : {}),
          ...accountStatusOf(file, now),
          windows: [...(reading?.usageLimits.windows ?? [])],
        },
      ];
    });
    const context = this.routingContext();
    const routes = describeRoutes(await this.deps.instanceMap(), context, (provider) =>
      this.state.source === "external"
        ? "Add the pool URL and key"
        : `Waiting for a ${PROVIDER_NAMES[provider]} account`,
    );
    return {
      source: this.state.source,
      runtime: this.runtimeState(),
      external: {
        url: this.state.external.url,
        hasKey: this.state.external.key.length > 0,
        ...(this.external.reachable === undefined ? {} : { reachable: this.external.reachable }),
        ...(this.external.message ? { message: this.external.message } : {}),
      },
      accounts: this.state.source === "local" ? accounts : [],
      ...(this.accountsError ? { accountsError: this.accountsError } : {}),
      routes,
      checks: this.checks,
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Mutations

  async setSource(input: PoolSetSourceInput) {
    if (input.source === "external") {
      const url = (input.externalUrl ?? this.state.external.url).trim();
      const key = (input.externalKey ?? this.state.external.key).trim();
      if (!/^https?:\/\/\S+$/i.test(url))
        throw new Error("Enter the pool's URL, e.g. https://pool.example.com");
      if (!key) throw new Error("Enter the key the pool gave you.");
      await this.updateState((current) => ({
        ...current,
        source: "external",
        external: { url, key },
      }));
      await this.stopLocal();
      await this.syncUsageSource().catch(() => undefined);
      await this.applyRouting();
      await this.probeExternal();
    } else {
      await this.updateState((current) => ({ ...current, source: "local" }));
      this.external = {};
      this.accounts = await scanAuthDir(this.deps.paths.authDir);
      await this.applyRouting();
      if (this.accounts.length > 0) await this.ensureStarted();
    }
    return this.status();
  }

  async setRoute(instanceId: string, mode: PoolRouteMode) {
    await this.updateState((current) => {
      const routes = { ...current.routes };
      if (mode === defaultRouteMode(instanceId)) delete routes[instanceId];
      else routes[instanceId] = mode;
      return { ...current, routes };
    });
    await this.applyRouting();
    return this.status();
  }

  private requireLocal() {
    if (this.state.source !== "local") {
      throw new Error("Switch the pool to This Mac to manage accounts here.");
    }
  }

  async startLogin(provider: PoolProvider): Promise<PoolLoginStart> {
    this.requireLocal();
    await this.ensureStarted();
    const login = await startLogin(this.target, provider);
    return { loginId: login.state, url: login.url };
  }

  async loginStatus(loginId: string): Promise<PoolLoginState> {
    this.requireLocal();
    if (!this.running) return { state: "error", message: "The pool isn't running." };
    const result = await loginStatus(this.target, loginId);
    if (result.state === "done") {
      await this.refreshAccounts();
      await this.syncUsageSource().catch(() => undefined);
      await this.deps.refreshUsage().catch(() => undefined);
    }
    return result;
  }

  /** Only ids the pool listed: never pass a client-supplied name straight to the proxy. */
  private requireAccount(id: string) {
    if (!this.accounts.some((account) => account.name === id)) throw new Error("Unknown account");
  }

  async setAccountEnabled(id: string, enabled: boolean) {
    this.requireLocal();
    this.requireAccount(id);
    await this.ensureStarted();
    await setAuthFileDisabled(this.target, id, !enabled);
    await this.refreshAccounts();
    return this.status();
  }

  async removeAccount(id: string) {
    this.requireLocal();
    this.requireAccount(id);
    await this.ensureStarted();
    await deleteAuthFile(this.target, id);
    await this.refreshAccounts();
    await this.syncUsageSource().catch(() => undefined);
    return this.status();
  }

  async restart() {
    if (this.state.source !== "local") return this.probeExternal().then(() => this.status());
    await this.stopLocal();
    this.startError = undefined;
    if (this.accounts.length > 0) await this.ensureStarted();
    return this.status();
  }

  async check() {
    if (this.state.source === "external") await this.probeExternal();
    await this.runChecks();
    return this.status();
  }

  // -------------------------------------------------------------------------
  // Native-parity checks

  private runChecks(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = this.computeChecks()
      .then((checks) => {
        this.checks = checks;
        this.checkedAt = new Date().toISOString();
      })
      .catch((error) => this.deps.log("Pool checks failed", error))
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }

  private async computeChecks(): Promise<PoolCheck[]> {
    const context = this.routingContext();
    const routes = describeRoutes(await this.deps.instanceMap(), context, () => "");
    const claudeRoute = routes.find((route) => route.provider === "claude" && route.active);
    const codexRoute = routes.find((route) => route.provider === "codex" && route.active);
    const checks: PoolCheck[] = [];

    if (this.state.source === "local") {
      if (this.running)
        checks.push(check("proxy", "Pool", "ok", `Running on 127.0.0.1:${this.state.port}`));
      else if (this.accounts.length === 0)
        checks.push(check("proxy", "Pool", "unknown", "Add an account to start the pool."));
      else
        checks.push(
          check("proxy", "Pool", "fail", this.runtimeState().message ?? "The pool isn't running."),
        );
    } else {
      checks.push(
        this.external.reachable
          ? check("proxy", "Pool", "ok", `Connected to ${this.state.external.url}`)
          : check("proxy", "Pool", "fail", this.external.message ?? "Can't reach the pool."),
      );
    }

    if (this.state.source === "external") {
      checks.push(check("sticky", "Sticky sessions", "unknown", "Set on the pool server."));
    } else if (this.running) {
      const routing = await readRouting(this.target).catch(() => undefined);
      checks.push(
        routing?.sessionAffinity && routing.subagentsSpread
          ? check(
              "sticky",
              "Sticky sessions",
              "ok",
              "Each thread and subagent keeps one account, so its prompt cache is reused.",
            )
          : check(
              "sticky",
              "Sticky sessions",
              "fail",
              "The pool isn't pinning sessions to accounts; restart it.",
            ),
      );
    } else {
      checks.push(check("sticky", "Sticky sessions", "unknown", "Checked once the pool runs."));
    }

    if (!claudeRoute) {
      const reason = "No Claude instance goes through the pool.";
      checks.push(check("toolSearch", "Tool search", "unknown", reason));
      checks.push(check("cache", "1h cache", "unknown", reason));
      checks.push(check("advisor", "Advisor", "unknown", reason));
    } else {
      const probe = await this.deps.claudeProbe(claudeRoute.instanceId);
      const toolSearch = await probeToolSearch(probe).then(
        (on) => (on ? ("ok" as const) : ("fail" as const)),
        (error) => ({ error: messageOf(error) }),
      );
      checks.push(
        toolSearch === "ok"
          ? check(
              "toolSearch",
              "Tool search",
              "ok",
              "Tool schemas load on demand, as in direct Claude Code.",
            )
          : toolSearch === "fail"
            ? check(
                "toolSearch",
                "Tool search",
                "fail",
                "Claude is loading every tool schema into every thread. This Claude Code version may have changed how it treats proxies; update T3 or tell the fork maintainer.",
              )
            : check(
                "toolSearch",
                "Tool search",
                "unknown",
                `The Claude probe failed: ${toolSearch.error}`,
              ),
      );
      const conflicts = findEnvConflicts(await readClaudeSettingsEnv(probe.configDir), process.env);
      const cacheConflict = conflicts.find((conflict) => /CACHING/.test(conflict));
      checks.push(
        cacheConflict
          ? check("cache", "1h cache", "warn", cacheConflict)
          : check(
              "cache",
              "1h cache",
              "ok",
              "Prompts are cached for an hour, as with a Claude subscription.",
            ),
      );
      checks.push(
        check("advisor", "Advisor", "ok", "The advisor uses Opus when your account has it."),
      );
      const others = conflicts.filter((conflict) => conflict !== cacheConflict);
      if (others.length > 0)
        checks.push(
          check(
            "overrides",
            "Claude settings",
            "warn",
            `Your Claude settings: ${others.join("; ")}.`,
          ),
        );
    }

    if (!codexRoute) {
      checks.push(check("codex", "Codex", "unknown", "No Codex instance goes through the pool."));
    } else if (process.env.T3CODE_CODEX_LAUNCH_ARGS) {
      checks.push(
        check(
          "codex",
          "Codex",
          "warn",
          "T3CODE_CODEX_LAUNCH_ARGS replaces the pool's Codex settings.",
        ),
      );
    } else if (this.state.source === "local" && !context.codexCatalogPath) {
      checks.push(
        check(
          "codex",
          "Codex",
          "warn",
          `Codex is using the model catalog built into the CLI${this.codexCatalogError ? ` (${this.codexCatalogError})` : ""}, so model defaults can differ from native.`,
        ),
      );
    } else {
      checks.push(
        check("codex", "Codex", "ok", "Codex uses the pool with OpenAI's current model catalog."),
      );
    }
    return checks;
  }
}
