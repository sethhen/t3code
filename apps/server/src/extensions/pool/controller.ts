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
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  PoolAccount,
  PoolCheck,
  PoolLoginStart,
  PoolLoginState,
  PoolModelIssue,
  PoolProvider,
  PoolRoute,
  PoolRouteMode,
  PoolRuntimeState,
  PoolSetSourceInput,
  PoolStatus,
  ProviderInstanceConfig,
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
  fetchClaudePlan,
  fetchCodexCatalog,
  listAuthFiles,
  loginStatus,
  planRank,
  poolProviderOf,
  probeClientKey,
  readRouting,
  setAuthFileDisabled,
  startLogin,
} from "./management.ts";
import {
  customModelSlug,
  describeRoutes,
  isForeignModel,
  poolOverlay,
  type PoolRoutingContext,
} from "./overlay.ts";
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
  keyFilePath,
} from "./state.ts";

/** The pool's entry in `settings.usageLimitSources`, so its quotas show on the usage page. */
export const POOL_USAGE_SOURCE_ID = "cliproxy-t3-pool";

export interface PoolDeps {
  readonly paths: PoolPaths;
  /** The host's `HostProcessPlatform` and `HostProcessArchitecture`. */
  readonly platform: string;
  readonly arch: string;
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
  /** The Claude config directory `instanceId` uses (`CLAUDE_CONFIG_DIR`), for its `settings.json`. */
  readonly claudeConfigDir: (instanceId: string) => Promise<string | undefined>;
  /** The version of the Codex CLI the pooled Codex instance runs (`client_version` for its catalog). */
  readonly codexVersion: () => Promise<string | undefined>;
  /** Tests replace the download; production uses `ensureBinary`. */
  readonly installBinary?: (signal: AbortSignal) => Promise<string>;
  readonly log: (message: string, cause?: unknown) => void;
}

const PROVIDER_NAMES: Record<PoolProvider, string> = { claude: "Claude", codex: "ChatGPT" };

/** Claude Code env variables that name a model (aliases, the main model, subagents, background tasks). */
const CLAUDE_MODEL_ALIASES: ReadonlyArray<string> = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
];

/** Native Codex refreshes its catalog on a similar cadence. */
const CODEX_CATALOG_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** A plan rarely changes; a failed read (e.g. a token mid-refresh) retries sooner. */
const CLAUDE_PLAN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CLAUDE_PLAN_RETRY_MS = 5 * 60 * 1000;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Auth files straight from disk, for when the proxy isn't running (e.g. at boot). */
export const scanAuthDir = async (authDir: string): Promise<AuthFileEntry[]> => {
  let names: string[];
  try {
    names = await NodeFSP.readdir(authDir);
  } catch {
    return [];
  }
  const entries: AuthFileEntry[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    try {
      const raw = JSON.parse(await NodeFSP.readFile(NodePath.join(authDir, name), "utf8"));
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
  private checkAgain = false;
  private signature: string | undefined;
  private codexCatalogPath: string | undefined;
  private codexCatalogError: string | undefined;
  private fetchingCatalog: Promise<void> | undefined;
  /** Claude plan labels by auth file name, and when to read each again. */
  private claudePlans = new Map<string, { readonly plan?: string; readonly nextAt: number }>();
  private fetchingPlans: Promise<void> | undefined;
  /** The plan each account last showed, so a failed usage read doesn't blank it or move its row. */
  private shownPlans = new Map<string, string>();
  private unregisterOverlay: (() => void) | undefined;
  private closed = false;
  /** Bumped by every stop; a start that began under an older generation must not spawn. */
  private generation = 0;
  private startAbort: AbortController | undefined;
  /** Serialises state writes: one file, one writer at a time. */
  private stateQueue: Promise<void> = Promise.resolve();
  /** Serialises routing changes (key file + reconcile), so an older one never lands last. */
  private routingQueue: Promise<void> = Promise.resolve();
  /** The instance map as it reached the pool's overlay (custom models unfiltered). */
  private baseMap: ProviderInstanceConfigMap | undefined;

  private readonly deps: PoolDeps;

  constructor(deps: PoolDeps) {
    this.deps = deps;
  }

  async init() {
    this.state = await loadPoolState(this.deps.paths);
    this.accounts = await scanAuthDir(this.deps.paths.authDir);
    this.codexCatalogPath = await NodeFSP.access(this.deps.paths.codexCatalogPath).then(
      () => this.deps.paths.codexCatalogPath,
      () => undefined,
    );
    this.unregisterOverlay = registerInstanceOverlay("pool", (map) => {
      this.baseMap = map;
      return poolOverlay(this.routingContext())(map);
    });
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
    const keyHelperFor = (baseUrl: string) => ({
      path: keyFilePath(this.deps.paths, baseUrl),
      platform: this.deps.platform,
    });
    if (state.source === "external") {
      const endpoint =
        state.external.url && state.external.key
          ? { baseUrl: state.external.url.replace(/\/+$/, ""), key: state.external.key }
          : undefined;
      return {
        claude: endpoint,
        codex: endpoint,
        modeFor,
        keyHelper: keyHelperFor(endpoint?.baseUrl ?? ""),
      };
    }
    const endpoint = { baseUrl: this.localBaseUrl, key: state.clientKey };
    const keyHelper = keyHelperFor(endpoint.baseUrl);
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
  private applyRouting(): Promise<void> {
    const run = this.routingQueue.then(async () => {
      const context = this.routingContext();
      const signature = this.routingSignature(context);
      if (signature === this.signature) return;
      const endpoint = context.claude ?? context.codex;
      if (endpoint) await this.writeClientKey(context.keyHelper.path, endpoint.key);
      await this.deps.reconcile();
      // Committed only once both landed, so a failure is retried by the next change.
      this.signature = signature;
      // Other pools' keys go only now: until the reconcile lands, sessions still aimed at the
      // previous pool keep reading that pool's own key, never the new one.
      await this.pruneKeyFiles(endpoint ? context.keyHelper.path : undefined).catch((error) =>
        this.deps.log("Couldn't remove old pool keys", error),
      );
      void this.runChecks();
    });
    this.routingQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** A pool's key file for `apiKeyHelper` (0600; the key never goes on a command line). */
  private async writeClientKey(path: string, key: string) {
    await NodeFSP.mkdir(this.deps.paths.keysDir, { recursive: true, mode: 0o700 });
    // Temp + rename: a reader never sees a half-written key.
    const temp = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
    await NodeFSP.writeFile(temp, key, { mode: 0o600 });
    await NodeFSP.rename(temp, path);
  }

  /** Removes every pool key file except `keep` (and the pre-keysDir single file). */
  private async pruneKeyFiles(keep: string | undefined) {
    await NodeFSP.rm(this.deps.paths.legacyClientKeyPath, { force: true });
    const entries = await NodeFSP.readdir(this.deps.paths.keysDir).catch(() => []);
    for (const entry of entries) {
      const path = NodePath.join(this.deps.paths.keysDir, entry);
      if (path !== keep && !entry.endsWith(".tmp")) await NodeFSP.rm(path, { force: true });
    }
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
    const stopped = () => new Error("Account sharing was stopped.");
    this.starting = (async () => {
      this.startError = undefined;
      try {
        this.startPhase = "downloading";
        const install =
          this.deps.installBinary ??
          ((signal: AbortSignal) =>
            ensureBinary(this.deps.paths.binDir, {
              platform: this.deps.platform,
              arch: this.deps.arch,
              signal,
            }));
        const binaryPath = await install(abort.signal);
        if (!stillWanted()) throw stopped();
        this.startPhase = "starting";
        if (!this.sidecar) {
          await killStaleProxy(this.deps.paths, this.deps.platform);
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
          throw new Error(this.sidecar?.state.message ?? "Account sharing did not start.");
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
    void this.refreshClaudePlans();
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
    const age = await NodeFSP.stat(path).then(
      (stat) => Date.now() - stat.mtimeMs,
      () => Number.POSITIVE_INFINITY,
    );
    if (this.codexCatalogPath && age < CODEX_CATALOG_MAX_AGE_MS) return;
    const version = await this.deps.codexVersion();
    if (!version) throw new Error("couldn't read the Codex CLI version");
    const catalog = await fetchCodexCatalog(this.target, account, version);
    // In place, never renamed: running Codex sessions may be reading it.
    await NodeFSP.writeFile(path, `${JSON.stringify(catalog)}\n`);
    this.codexCatalogPath = path;
    this.codexCatalogError = undefined;
    await this.applyRouting();
  }

  private refreshClaudePlans(): Promise<void> {
    if (this.fetchingPlans) return this.fetchingPlans;
    this.fetchingPlans = this.fetchDueClaudePlans()
      .catch((error) => this.deps.log("Pool Claude plans", error))
      .finally(() => {
        this.fetchingPlans = undefined;
      });
    return this.fetchingPlans;
  }

  private async fetchDueClaudePlans() {
    if (this.state.source !== "local" || !this.running) return;
    const names = new Set(this.accounts.map((file) => file.name));
    for (const name of this.claudePlans.keys()) {
      if (!names.has(name)) this.claudePlans.delete(name);
    }
    const now = Date.now();
    const due = this.accounts.filter(
      (file) =>
        file.provider === "claude" &&
        file.authIndex &&
        (this.claudePlans.get(file.name)?.nextAt ?? 0) <= now,
    );
    await Promise.all(
      due.map(async (file) => {
        const plan = await fetchClaudePlan(this.target, file).catch(() => null);
        // A failed read keeps the last label: plans rarely change.
        const known = plan === null ? this.claudePlans.get(file.name)?.plan : plan;
        this.claudePlans.set(file.name, {
          ...(known ? { plan: known } : {}),
          nextAt: Date.now() + (plan === null ? CLAUDE_PLAN_RETRY_MS : CLAUDE_PLAN_MAX_AGE_MS),
        });
      }),
    );
  }

  private async syncUsageSource() {
    const current = await this.deps.usageSource();
    const wanted: UsageLimitSourceConfig | null =
      this.state.source === "local" && this.running && this.accounts.length > 0
        ? {
            kind: "cliproxy",
            label: "Shared accounts",
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
        : { ok: false, message: "Add the server URL and key." };
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
        message: sidecar?.message ?? this.startError ?? "Account sharing stopped.",
        logPath: this.deps.paths.logPath,
      };
    }
    if (sidecar?.phase === "starting") return { ...base, state: "starting" };
    return { ...base, state: "idle" };
  }

  async status(): Promise<PoolStatus> {
    if (this.state.source === "local" && this.running) {
      await this.refreshAccounts();
      void this.refreshCodexCatalog();
      void this.refreshClaudePlans();
    }
    const usage = new Map(
      (await this.deps.usageAccounts().catch(() => [])).map((account) => [account.id, account]),
    );
    const now = Date.now();
    const shownPlans = new Map<string, string>();
    const accounts = this.accounts.flatMap((file): PoolAccount[] => {
      const provider = poolProviderOf(file.provider);
      if (!provider) return [];
      const reading = usage.get(file.name);
      const plan =
        (provider === "claude" ? this.claudePlans.get(file.name)?.plan : undefined) ??
        reading?.plan ??
        this.shownPlans.get(file.name);
      if (plan) shownPlans.set(file.name, plan);
      return [
        {
          id: file.name,
          provider,
          ...(file.email ? { email: file.email } : {}),
          ...(plan ? { plan } : {}),
          ...accountStatusOf(file, now),
          windows: [...(reading?.usageLimits.windows ?? [])],
        },
      ];
    });
    this.shownPlans = shownPlans;
    // Stable: accounts on the same plan keep the proxy's order.
    accounts.sort((a, b) => planRank(b.plan) - planRank(a.plan));
    const context = this.routingContext();
    const routes = describeRoutes(await this.deps.instanceMap(), context, (provider) =>
      this.state.source === "external"
        ? "Add the server URL and key"
        : `Waiting for a ${PROVIDER_NAMES[provider]} account`,
    );
    // Live, not from the last check run: a removed model clears on the next poll.
    const modelIssues = await this.modelIssues(routes).catch(() => []);
    const checks = [
      ...this.checks.filter((entry) => entry.id !== "modelFamilies"),
      ...(modelIssues.length > 0
        ? [
            check(
              "modelFamilies",
              "Model families",
              "fail",
              modelIssues.map((issue) => issue.message).join(" "),
            ),
          ]
        : []),
    ];
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
      checks,
      ...(modelIssues.length > 0 ? { modelIssues } : {}),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
    };
  }

  /**
   * Models of the other family configured on pooled instances: T3's own custom
   * models, and for Claude the model aliases in the instance's environment and in
   * its `settings.json` (read only). T3 never offers one through the pool; a
   * hand-configured one is flagged, not blocked.
   */
  private async modelIssues(routes: ReadonlyArray<PoolRoute>): Promise<PoolModelIssue[]> {
    const base = this.baseMap as
      | Readonly<Record<string, ProviderInstanceConfig | undefined>>
      | undefined;
    if (!base) return [];
    const issues: PoolModelIssue[] = [];
    for (const route of routes) {
      const instance = route.active ? base[route.instanceId] : undefined;
      if (!instance) continue;
      const common = {
        instanceId: route.instanceId,
        displayName: route.displayName,
        provider: route.provider,
      };
      const foreign = route.provider === "claude" ? "GPT" : "Claude";
      const harness = route.provider === "claude" ? "Claude Code" : "Codex";
      const config = (instance.config ?? {}) as Record<string, unknown>;
      for (const model of Array.isArray(config.customModels) ? config.customModels : []) {
        const slug = customModelSlug(model);
        if (!slug || !isForeignModel(slug, route.provider)) continue;
        issues.push({
          ...common,
          slug,
          where: "customModels",
          message: `${route.displayName} has a ${foreign} model (${slug}) in its custom models; on these accounts it would run ${foreign} inside ${harness}.`,
        });
      }
      if (route.provider !== "claude") continue;
      const aliasIssue = (setting: string, slug: string, where: "instanceEnv" | "claudeSettings") =>
        issues.push({
          ...common,
          slug,
          where,
          setting,
          message: `${setting} in ${where === "claudeSettings" ? "~/.claude/settings.json" : `${route.displayName}'s environment`} points Claude at ${slug}; on these accounts it would run GPT inside Claude Code.`,
        });
      for (const entry of instance.environment ?? []) {
        if (CLAUDE_MODEL_ALIASES.includes(entry.name) && isForeignModel(entry.value, "claude")) {
          aliasIssue(entry.name, entry.value, "instanceEnv");
        }
      }
      const settingsEnv = await readClaudeSettingsEnv(
        await this.deps.claudeConfigDir(route.instanceId),
      );
      for (const name of CLAUDE_MODEL_ALIASES) {
        const value = settingsEnv[name];
        if (typeof value === "string" && isForeignModel(value, "claude")) {
          aliasIssue(name, value, "claudeSettings");
        }
      }
    }
    return issues;
  }

  // -------------------------------------------------------------------------
  // Mutations

  async setSource(input: PoolSetSourceInput) {
    if (input.source === "external") {
      // Omitted fields resolve inside the queue, against the latest state.
      await this.updateState((current) => {
        const url = (input.externalUrl ?? current.external.url).trim();
        const key = (input.externalKey ?? current.external.key).trim();
        if (!/^https?:\/\/\S+$/i.test(url)) {
          throw new Error("Enter the server's URL, e.g. https://accounts.example.com");
        }
        if (!key) throw new Error("Enter the key from the server's owner.");
        return { ...current, source: "external", external: { url, key } };
      });
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
      throw new Error("Disconnect from the team server to manage accounts here.");
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
    if (!this.running) return { state: "error", message: "Account sharing isn't running." };
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

  /** Runs the checks; a request made while they run queues exactly one more pass. */
  private runChecks(): Promise<void> {
    if (this.checking) {
      this.checkAgain = true;
      return this.checking;
    }
    this.checking = (async () => {
      do {
        this.checkAgain = false;
        try {
          this.checks = await this.computeChecks();
          this.checkedAt = new Date().toISOString();
        } catch (error) {
          this.deps.log("Pool checks failed", error);
        }
      } while (this.checkAgain && !this.closed);
    })().finally(() => {
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
        checks.push(
          check("proxy", "Account sharing", "ok", `Running on 127.0.0.1:${this.state.port}`),
        );
      else if (this.accounts.length === 0)
        checks.push(check("proxy", "Account sharing", "unknown", "Starts with the first account."));
      else
        checks.push(
          check("proxy", "Account sharing", "fail", this.runtimeState().message ?? "Not running."),
        );
    } else {
      checks.push(
        this.external.reachable === undefined
          ? check("proxy", "Account sharing", "unknown", "Checking the team server…")
          : this.external.reachable
            ? check("proxy", "Account sharing", "ok", `Connected to ${this.state.external.url}`)
            : check(
                "proxy",
                "Account sharing",
                "fail",
                this.external.message ?? "Can't reach the team server.",
              ),
      );
    }

    if (this.state.source === "external") {
      checks.push(check("sticky", "Sticky sessions", "unknown", "Set on the team server."));
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
              "Sessions aren't pinned to accounts; restart account sharing.",
            ),
      );
    } else {
      checks.push(
        check("sticky", "Sticky sessions", "unknown", "Checked once account sharing runs."),
      );
    }

    if (!claudeRoute) {
      const reason = "No Claude instance uses these accounts.";
      checks.push(check("toolSearch", "Tool search", "unknown", reason));
      checks.push(check("cache", "1h cache", "unknown", reason));
      checks.push(check("advisor", "Advisor", "unknown", reason));
    } else {
      // Preparing or running the probe can fail (e.g. no `claude` on this machine): that
      // marks tool search unknown, never the whole check run.
      const probe = await this.deps
        .claudeProbe(claudeRoute.instanceId)
        .catch((error: unknown) => ({ error: messageOf(error) }) as const);
      const toolSearch =
        "error" in probe
          ? probe
          : await probeToolSearch(probe).then(
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
      const conflicts = findEnvConflicts(
        await readClaudeSettingsEnv(
          "error" in probe
            ? await this.deps.claudeConfigDir(claudeRoute.instanceId)
            : probe.configDir,
        ),
        process.env,
      );
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
      checks.push(check("codex", "Codex", "unknown", "No Codex instance uses these accounts."));
    } else if (process.env.T3CODE_CODEX_LAUNCH_ARGS) {
      checks.push(
        check(
          "codex",
          "Codex",
          "warn",
          "T3CODE_CODEX_LAUNCH_ARGS replaces the Codex settings these accounts need.",
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
        check(
          "codex",
          "Codex",
          "ok",
          "Codex uses these accounts with OpenAI's current model catalog.",
        ),
      );
    }
    return checks;
  }
}
