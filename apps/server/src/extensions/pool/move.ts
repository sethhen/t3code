// @effect-diagnostics globalTimers:off globalDate:off - the move is plain async Node by design; Effect wraps it at the layer and handler boundary.
// @effect-diagnostics nodeBuiltinImport:off - the move runs the provider CLIs and lays out their config dirs with plain Node.
/**
 * Moves the retired pool's accounts to direct sign-ins, one at a time, with
 * each provider's own CLI login. One instance per server, created by
 * `layer.ts`; plain async code, the Effect boundary is the layer and the
 * handlers.
 *
 * A sign-in lands in the provider's default home (`~/.claude`, `~/.codex`)
 * while that home has no subscription sign-in, else in a new instance of its
 * own: `~/.claude-<slug>`, or a Codex shadow home on the shared Codex home (a
 * standalone `~/.codex-<slug>` where symlinks can't be made). In the default
 * home any account on the list counts; in a new instance only the one clicked.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type MoveProvider,
  type MoveSignInStart,
  type MoveSignInState,
  type MoveStatus,
  type MoveTarget,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
  UsageLimitSourceId,
} from "@t3tools/contracts";

import { migratePool } from "./boot.ts";
import { CLAUDE_URL_MARKER, CODEX_URL_MARKER, lastLine, signInEnv, signInUrl } from "./cli.ts";
import { runProcess } from "./process.ts";
import {
  accountHash,
  emailSlug,
  isMissing,
  isRecord,
  jwtClaims,
  jwtEmail,
  type MoveEntry,
  moveAccountId,
  moveListPath,
  readMoveList,
  sameAccount,
  text,
  updateMoveList,
} from "./state.ts";
import { deriveProviderInstanceConfigMap, mergeProviderInstanceEnvironment } from "./t3.ts";

/** The retired pool's entry in `settings.usageLimitSources`. */
export const POOL_USAGE_SOURCE_ID = UsageLimitSourceId.make("cliproxy-t3-pool");

/** Each provider's default instance id, which is also its driver kind. */
const DEFAULT_INSTANCE: Record<MoveProvider, string> = { claude: "claudeAgent", codex: "codex" };
const CLI: Record<MoveProvider, string> = { claude: "claude", codex: "codex" };
const PROVIDER_NAME: Record<MoveProvider, string> = { claude: "Claude Code", codex: "Codex" };

/**
 * What every Claude account shares from the main config dir. Never
 * `.claude.json` (it holds the account) or `projects/` (per-account history).
 */
const CLAUDE_SHARED_ENTRIES = [
  "settings.json",
  "CLAUDE.md",
  "skills",
  "agents",
  "commands",
  "plugins",
  "output-styles",
];

/**
 * `claude auth status` methods that Claude Code uses instead of any claude.ai
 * sign-in, in plain words. A new account's dir shares `settings.json`, so they
 * would override its sign-in too.
 */
const CLAUDE_OVERRIDES = new Map([
  ["api_key_helper", "an API key helper"],
  ["oauth_token", "an OAuth token (CLAUDE_CODE_OAUTH_TOKEN)"],
  ["third_party", "a cloud provider such as Bedrock or Vertex"],
]);

const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** How long `signIn.start` waits for the CLI to print its sign-in page. */
const URL_WAIT_MS = 5_000;
/** How long an exited CLI's output may stay open (a grandchild holding the pipes). */
const EXIT_GRACE_MS = 500;

export interface MoveDeps {
  readonly stateDir: string;
  /** The host's `HostProcessPlatform`. */
  readonly platform: string;
  /** The environment the CLIs start from, before an instance's own variables. */
  readonly env: NodeJS.ProcessEnv;
  /** `~` expansion as the provider drivers do it (`expandHomePath`). */
  readonly expandHome: (path: string) => string;
  readonly getSettings: () => Promise<ServerSettings>;
  readonly updateSettings: (patch: ServerSettingsPatch) => Promise<void>;
  /** The environment Claude Code runs with for `homePath` (upstream's `makeClaudeEnvironment`). */
  readonly claudeEnvironment: (
    homePath: string,
    base: NodeJS.ProcessEnv,
  ) => Promise<NodeJS.ProcessEnv>;
  /** Lays out a Codex shadow home the way the codex driver does; resolves to its path. */
  readonly materializeCodexHome: (homePath: string, shadowHomePath: string) => Promise<string>;
  /** `command args` as T3 spawns it (`resolveSpawnCommand`: `.cmd` shims on Windows). */
  readonly resolveSpawn: (
    command: string,
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv,
  ) => Promise<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly shell: boolean;
  }>;
  /** Re-probes an instance with its caches invalidated, like Settings' refresh. */
  readonly refreshInstance: (instanceId: string) => Promise<void>;
  /** Whether this host lets T3 create symlinks (`canCreateSymlinks`); asked once. */
  readonly canSymlink: () => Promise<boolean>;
  readonly log: (message: string, cause?: unknown) => void;
}

/** What a default home is signed in to. */
interface DefaultLogin {
  readonly signedIn: boolean;
  readonly email?: string;
  /** Claude: what Claude Code uses instead of any sign-in (`CLAUDE_OVERRIDES`). */
  readonly override?: string;
}

/** One account's sign-in: what to run, and how to check (or undo) the result. */
interface SignInPlan {
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly acceptsCode: boolean;
  /** The line the CLI prints before its sign-in page. */
  readonly marker: string;
  /** The account the CLI is signed in to now. */
  readonly signedInEmail: () => Promise<string | undefined>;
  /** Puts back what preparing the sign-in moved aside, when it doesn't finish. */
  readonly restore?: () => Promise<void>;
  /** Instance target only, so a default home is never signed out. */
  readonly instance?: {
    /** The instance an account signed in here becomes. */
    readonly config: (email: string) => ProviderInstanceConfig;
    /** Signs a wrong (or unreadable) account out of the new dir again. */
    readonly logout: () => Promise<void>;
  };
}

interface SignInRun {
  readonly signInId: string;
  readonly accountId: string;
  readonly entry: MoveEntry;
  readonly target: MoveTarget;
  readonly acceptsCode: boolean;
  /** Absent when the account was signed in there already. */
  readonly child?: NodeChildProcess.ChildProcess;
  /** Until the CLI exits; afterwards the result is being checked and can't be cancelled. */
  running: boolean;
  state: MoveSignInState["state"];
  url?: string;
  email?: string;
  message?: string;
  /** Resolves when the CLI printed its sign-in page. */
  urlFound: Promise<void>;
  /** Resolves once `state` is final. */
  finished: Promise<void>;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const configOf = (instance: ProviderInstanceConfig | undefined) =>
  isRecord(instance?.config) ? instance.config : {};

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await NodeFSP.readFile(path, "utf8"));
  } catch {
    return undefined;
  }
};

const pathExists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

/** The ChatGPT account a Codex home is signed in to (`auth.json`'s id_token). */
const codexEmail = async (home: string) => {
  const auth = await readJson(NodePath.join(home, "auth.json"));
  const tokens = isRecord(auth) && isRecord(auth.tokens) ? auth.tokens : {};
  return jwtEmail(jwtClaims(tokens.id_token)) || undefined;
};

/** The account a Claude config dir's `.claude.json` names, if any. */
const claudeConfigEmail = async (dir: string) => {
  const config = await readJson(NodePath.join(dir, ".claude.json"));
  const account = isRecord(config) && isRecord(config.oauthAccount) ? config.oauthAccount : {};
  return text(account.emailAddress) || undefined;
};

/** A sign-in that is waiting; without a CLI (`child`) it is already being checked. */
const newRun = (
  entry: MoveEntry,
  target: MoveTarget,
  acceptsCode: boolean,
  child?: NodeChildProcess.ChildProcess,
): SignInRun => ({
  signInId: NodeCrypto.randomUUID(),
  accountId: moveAccountId(entry),
  entry,
  target,
  acceptsCode,
  ...(child ? { child } : {}),
  running: child !== undefined,
  state: "waiting",
  urlFound: Promise.resolve(),
  finished: Promise.resolve(),
});

/** Whether a symlink can be made here (Windows refuses without Developer Mode or elevation). */
export const canCreateSymlinks = async () => {
  let dir: string | undefined;
  try {
    dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-symlink-probe-"));
    await NodeFSP.symlink(NodePath.join(dir, "target"), NodePath.join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    if (dir) await NodeFSP.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** Resolves when any of `events` does, or after `ms`. */
const waitFor = (events: ReadonlyArray<Promise<unknown>>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise((resolve) => (timer = setTimeout(resolve, ms)));
  return Promise.race([...events, cap]).finally(() => clearTimeout(timer));
};

/**
 * Ends a sign-in CLI and whatever it started: on Windows its whole tree (a
 * `.cmd` shim runs it under cmd.exe), elsewhere its process group (`launch`
 * starts it detached, as the group's leader).
 */
const killTree = (child: NodeChildProcess.ChildProcess, platform: string) => {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === "win32") {
    NodeChildProcess.spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => child.kill());
    return;
  }
  const signalGroup = (signal: NodeJS.Signals | 0) => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (!signalGroup("SIGTERM")) child.kill("SIGTERM");
  setTimeout(() => {
    if (signalGroup(0)) signalGroup("SIGKILL");
    else if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3_000).unref();
};

export class MoveController {
  private readonly deps: MoveDeps;
  private readonly listPath: string;
  private booted: Promise<void> | undefined;
  /** Each default home's sign-in; absent while unknown (then it is never the target). */
  private defaults: Partial<Record<MoveProvider, DefaultLogin | undefined>> = {};
  /** The current (or last) sign-in. One at a time: Codex's callback port is fixed. */
  private run: SignInRun | undefined;
  /** Sign-ins a newer one replaced, for pollers still asking about them. */
  private readonly replaced = new Set<string>();
  private starting: Promise<unknown> = Promise.resolve();
  private symlinks: Promise<boolean> | undefined;
  /** Set by `close`: a start still in flight launches nothing (or ends what it launched). */
  private closed = false;

  constructor(deps: MoveDeps) {
    this.deps = deps;
    this.listPath = moveListPath(deps.stateDir);
  }

  /**
   * Server start: retire the pool, drop its usage source, read the default
   * logins and drop the accounts already signed in. Runs once; never rejects.
   */
  boot(): Promise<void> {
    this.booted ??= (async () => {
      const log = (step: string) => (error: unknown) => this.deps.log(step, error);
      await migratePool(this.deps.stateDir, this.deps.platform).catch(
        log("Moving off the account pool failed; retrying at the next start"),
      );
      await this.dropUsageSource().catch(log("Removing the pool's usage source failed"));
      // Nothing left to move (every start once it is done): no need to run the CLIs.
      const pending = await readMoveList(this.listPath).catch(() => []);
      if (pending.length === 0) return;
      await Promise.all(
        (["claude", "codex"] as const).map((provider) =>
          this.refreshDefault(provider).catch(
            log(`Reading the default ${provider} sign-in failed`),
          ),
        ),
      );
      await this.prune().catch(log("Updating the account move list failed"));
    })();
    return this.booted;
  }

  async status(): Promise<MoveStatus> {
    await this.boot();
    const entries = await readMoveList(this.listPath);
    const run = this.run;
    return {
      accounts: entries.map((entry) => ({
        id: moveAccountId(entry),
        provider: entry.provider,
        email: entry.email,
        ...(entry.plan ? { plan: entry.plan } : {}),
        target: this.targetOf(entry.provider),
      })),
      ...(run?.state === "waiting"
        ? { signIn: { signInId: run.signInId, accountId: run.accountId } }
        : {}),
    };
  }

  /** Starts `accountId`'s sign-in, cancelling the one running. Starts never overlap. */
  startSignIn(accountId: string): Promise<MoveSignInStart> {
    const next = this.starting.then(() => this.start(accountId));
    this.starting = next.catch(() => undefined);
    return next;
  }

  signInState(signInId: string): MoveSignInState {
    const run = this.run;
    if (run?.signInId !== signInId) {
      return {
        state: "error",
        acceptsCode: false,
        message: this.replaced.has(signInId)
          ? "Another sign-in started."
          : "This sign-in is no longer running.",
      };
    }
    return {
      state: run.state,
      acceptsCode: run.acceptsCode,
      ...(run.url ? { url: run.url } : {}),
      ...(run.email ? { email: run.email } : {}),
      ...(run.message ? { message: run.message } : {}),
    };
  }

  /** The sign-in's final state, for callers that wait instead of polling. */
  async settled(signInId: string): Promise<MoveSignInState> {
    if (this.run?.signInId === signInId) await this.run.finished;
    return this.signInState(signInId);
  }

  /**
   * Claude's manual flow: hands the CLI the code its sign-in page shows. A
   * sign-in that ended meanwhile reports how it ended instead.
   */
  submitCode(signInId: string, code: string): MoveSignInState {
    const run = this.run;
    if (run?.signInId !== signInId) throw new Error(this.signInState(signInId).message);
    if (!run.acceptsCode) throw new Error("This sign-in doesn't take a code.");
    const value = code.trim();
    if (!value) throw new Error("Paste the code from the sign-in page.");
    if (!run.running || run.state !== "waiting") return this.signInState(signInId);
    // As the CLI checks it: `code#state`, both halves present.
    const [authorization, state] = value.split("#");
    if (!authorization || !state) {
      throw new Error("Paste the whole code, including the part after #.");
    }
    run.child?.stdin?.write(`${value}\n`);
    return this.signInState(signInId);
  }

  async cancelSignIn(signInId: string): Promise<MoveStatus> {
    if (this.run?.signInId === signInId) await this.stop(this.run, "Sign-in cancelled.");
    return this.status();
  }

  /** Drops an account from the list without signing it in. */
  async skip(accountId: string): Promise<MoveStatus> {
    await this.boot();
    if (this.run?.accountId === accountId) await this.stop(this.run, "Skipped.");
    await updateMoveList(this.listPath, (entries) =>
      entries.filter((entry) => moveAccountId(entry) !== accountId),
    );
    return this.status();
  }

  /** Server shutdown: ends a running sign-in CLI, and any a start still in flight launches. */
  close() {
    this.closed = true;
    const run = this.run;
    if (run?.running) this.end(run, "The server stopped.");
  }

  private async start(accountId: string): Promise<MoveSignInStart> {
    await this.boot();
    if (this.run) await this.stop(this.run, "Another sign-in started.");
    const entry = (await readMoveList(this.listPath)).find(
      (candidate) => moveAccountId(candidate) === accountId,
    );
    if (!entry) throw new Error("That account isn't on the list anymore.");
    // Read again: signing in over a default login that appeared since would replace it.
    await this.refreshDefault(entry.provider);
    const override = entry.provider === "claude" ? this.defaults.claude?.override : undefined;
    if (override) {
      throw new Error(
        `Claude Code is set to use ${override} (in its settings.json), which overrides any sign-in. Remove it, then sign in.`,
      );
    }
    const target = this.targetOf(entry.provider);
    const settings = await this.deps.getSettings();
    if (this.closed) throw new Error("The server stopped.");
    const plan =
      entry.provider === "claude"
        ? await this.claudePlan(entry, target, settings)
        : await this.codexPlan(entry, target, settings);
    if (plan.instance) {
      const email = await plan.signedInEmail();
      if (email?.toLowerCase() === entry.email.toLowerCase()) {
        // Signed in there already (an earlier sign-in that wasn't saved): keep it, no CLI.
        const run = this.track(newRun(entry, target, plan.acceptsCode));
        run.finished = this.settle(run, plan, email).catch((error: unknown) =>
          this.fail(run, messageOf(error)),
        );
        await run.finished;
        if (run.state === "error") throw new Error(run.message);
        return { signInId: run.signInId, acceptsCode: run.acceptsCode };
      }
    }
    let run: SignInRun;
    try {
      run = this.track(await this.launch(entry, target, plan));
    } catch (error) {
      await this.restore(plan);
      throw error;
    }
    if (this.closed) this.end(run, "The server stopped.");
    await waitFor([run.urlFound, run.finished], URL_WAIT_MS);
    if (run.state === "error") {
      // Report it once the CLI is gone and what it moved aside is back.
      await run.finished;
      throw new Error(run.message);
    }
    return {
      signInId: run.signInId,
      ...(run.url ? { url: run.url } : {}),
      acceptsCode: run.acceptsCode,
    };
  }

  /** Makes `run` the current sign-in, remembering the one it replaces. */
  private track(run: SignInRun) {
    if (this.run) this.replaced.add(this.run.signInId);
    this.run = run;
    return run;
  }

  /** A default home is the target only while it is known to have no subscription sign-in. */
  private targetOf(provider: MoveProvider): MoveTarget {
    return this.defaults[provider]?.signedIn === false ? "default" : "instance";
  }

  private defaultInstance(settings: ServerSettings, provider: MoveProvider) {
    const instance =
      deriveProviderInstanceConfigMap(settings)[
        ProviderInstanceId.make(DEFAULT_INSTANCE[provider])
      ];
    const config = configOf(instance);
    const binaryPath = text(config.binaryPath);
    return {
      config,
      environment: instance?.environment,
      homePath: text(config.homePath),
      binary: this.deps.expandHome(binaryPath || CLI[provider]),
      /** Copied to new instances only when it isn't the bare command. */
      binaryConfig: binaryPath && binaryPath !== CLI[provider] ? { binaryPath } : {},
    };
  }

  private resolveHome(path: string) {
    return NodePath.resolve(this.deps.expandHome(path));
  }

  /**
   * The default Codex instance and the home every Codex instance shares, as
   * upstream's usage scan resolves it (UsageService.ts): its `homePath`, else
   * the `CODEX_HOME` it runs with, else `~/.codex`.
   */
  private codexDefault(settings: ServerSettings) {
    const instance = this.defaultInstance(settings, "codex");
    const environment = mergeProviderInstanceEnvironment(instance.environment, this.deps.env);
    // Signed in somewhere of its own: the shared home's auth.json isn't its sign-in.
    const separate =
      instance.config.setupMode === "managed" || text(instance.config.shadowHomePath) !== "";
    const homePath = instance.homePath || (separate ? "" : text(environment.CODEX_HOME));
    return {
      ...instance,
      environment,
      separate,
      /** What a new instance saves as its shared home; empty for `~/.codex`. */
      homePath,
      home: this.resolveHome(homePath || NodePath.join("~", ".codex")),
    };
  }

  /** The default Claude instance's environment, auth overrides stripped. */
  private claudeDefaultEnv(settings: ServerSettings) {
    const instance = this.defaultInstance(settings, "claude");
    return this.deps.claudeEnvironment(
      instance.homePath,
      signInEnv(mergeProviderInstanceEnvironment(instance.environment, this.deps.env)),
    );
  }

  /** The claude.ai account `env`'s Claude Code is signed in to; undefined when it can't tell. */
  private async claudeLogin(
    binary: string,
    env: NodeJS.ProcessEnv,
  ): Promise<DefaultLogin | undefined> {
    const result = await this.exec(binary, ["auth", "status", "--json"], env).catch(
      () => undefined,
    );
    const stdout = result?.stdout ?? "";
    let status: unknown;
    try {
      status = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
    } catch {
      return undefined;
    }
    if (!isRecord(status)) return undefined;
    const method = text(status.authMethod);
    // Settings (or the environment) outrank a stored login, whether or not there is one.
    const override = CLAUDE_OVERRIDES.get(method);
    if (override) return { signedIn: true, override };
    if (status.loggedIn !== true || method === "none") return { signedIn: false };
    // A Console login ("api_key") or anything newer: unknown, so never replaced.
    if (method !== "claude.ai") return undefined;
    const email = text(status.email);
    return { signedIn: true, ...(email ? { email } : {}) };
  }

  /**
   * What the Codex home `home` is signed in to; undefined when it can't tell.
   * Signed out only for an API key, or a home or auth.json that doesn't exist.
   */
  private async codexLogin(
    binary: string,
    home: string,
    base: NodeJS.ProcessEnv,
  ): Promise<DefaultLogin | undefined> {
    let raw: string;
    try {
      raw = await NodeFSP.readFile(NodePath.join(home, "auth.json"), "utf8");
    } catch (error) {
      if (!isMissing(error)) return undefined;
      const homeExists = await NodeFSP.stat(home).then(
        () => true,
        (statError: unknown) => (isMissing(statError) ? false : undefined),
      );
      if (homeExists !== true) return homeExists === false ? { signedIn: false } : undefined;
      // No auth.json: the login may be in the OS keyring, which only the CLI can read.
      const status = await this.exec(binary, ["login", "status"], {
        ...signInEnv(base),
        CODEX_HOME: home,
      }).catch(() => undefined);
      if (!status) return undefined;
      return { signedIn: status.code === 0 };
    }
    let auth: unknown;
    try {
      auth = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isRecord(auth)) return undefined;
    // An API key login has no ChatGPT tokens.
    if (!isRecord(auth.tokens)) return { signedIn: false };
    const email = jwtEmail(jwtClaims(auth.tokens.id_token));
    return { signedIn: true, ...(email ? { email } : {}) };
  }

  private async refreshDefault(provider: MoveProvider) {
    const settings = await this.deps.getSettings();
    if (provider === "claude") {
      const env = await this.claudeDefaultEnv(settings);
      this.defaults.claude = await this.claudeLogin(
        this.defaultInstance(settings, "claude").binary,
        env,
      );
      return;
    }
    const codex = this.codexDefault(settings);
    this.defaults.codex = codex.separate
      ? { signedIn: true }
      : await this.codexLogin(codex.binary, codex.home, codex.environment);
  }

  private async dropUsageSource() {
    const settings = await this.deps.getSettings();
    if (!(POOL_USAGE_SOURCE_ID in settings.usageLimitSources)) return;
    // Removing the entry also deletes its stored management key (serverSettings.ts).
    await this.deps.updateSettings({ usageLimitSources: { [POOL_USAGE_SOURCE_ID]: null } });
  }

  /** Drops accounts already signed in directly: in a default home, or as an instance made here. */
  private async prune() {
    const settings = await this.deps.getSettings();
    const signedIn = (entry: MoveEntry) =>
      this.defaults[entry.provider]?.email?.toLowerCase() === entry.email.toLowerCase() ||
      moveAccountId(entry) in settings.providerInstances;
    await updateMoveList(this.listPath, (entries) => entries.filter((entry) => !signedIn(entry)));
  }

  /** `~/.claude-<slug>` / `~/.codex-<slug>`, plus the account's hash when another account has it. */
  private async homePathFor(entry: MoveEntry, settings: ServerSettings) {
    const hash = accountHash(entry.provider, entry.email);
    const plain = `~/.${CLI[entry.provider]}-${emailSlug(entry.email) || hash}`;
    const dir = this.resolveHome(plain);
    const usedByOther = Object.entries(settings.providerInstances).some(([id, instance]) => {
      if (id === moveAccountId(entry)) return false;
      const config = configOf(instance);
      return [text(config.homePath), text(config.shadowHomePath)].some(
        (path) => path && this.resolveHome(path) === dir,
      );
    });
    const signedInAs =
      entry.provider === "claude" ? await claudeConfigEmail(dir) : await codexEmail(dir);
    const taken =
      usedByOther ||
      (signedInAs !== undefined && signedInAs.toLowerCase() !== entry.email.toLowerCase());
    return taken ? `${plain}-${hash}` : plain;
  }

  private async claudePlan(
    entry: MoveEntry,
    target: MoveTarget,
    settings: ServerSettings,
  ): Promise<SignInPlan> {
    const defaults = this.defaultInstance(settings, "claude");
    const defaultEnv = await this.claudeDefaultEnv(settings);
    const plan = {
      binary: defaults.binary,
      args: ["auth", "login", "--email", entry.email],
      acceptsCode: true,
      marker: CLAUDE_URL_MARKER,
    };
    const signedInEmail = (env: NodeJS.ProcessEnv) => async () => {
      const login = await this.claudeLogin(defaults.binary, env);
      return login?.signedIn ? login.email : undefined;
    };
    if (target === "default") {
      return { ...plan, env: defaultEnv, signedInEmail: signedInEmail(defaultEnv) };
    }
    const homePath = await this.homePathFor(entry, settings);
    // From the exact homePath the instance saves: the Keychain item's name hashes the
    // CLAUDE_CONFIG_DIR string, so the instance must see the same one the login wrote.
    const env = await this.deps.claudeEnvironment(homePath, signInEnv(this.deps.env));
    // Without it the login would replace the main (default) Keychain sign-in.
    if (!env.CLAUDE_CONFIG_DIR) {
      throw new Error("Can't sign in a separate Claude account: CLAUDE_CONFIG_DIR isn't set.");
    }
    await this.seedClaudeHome(env.CLAUDE_CONFIG_DIR, defaultEnv);
    return {
      ...plan,
      env,
      signedInEmail: signedInEmail(env),
      instance: {
        config: (email) => ({
          driver: ProviderDriverKind.make("claudeAgent"),
          displayName: email,
          enabled: true,
          config: { homePath, ...defaults.binaryConfig },
        }),
        logout: async () => {
          await this.exec(defaults.binary, ["auth", "logout"], env);
        },
      },
    };
  }

  /**
   * Shares the main config dir's settings, memory, skills, agents, commands,
   * plugins and output styles with a new account's `dir`, and copies its MCP
   * servers once. Only fills in what `dir` doesn't have yet.
   */
  private async seedClaudeHome(dir: string, defaultEnv: NodeJS.ProcessEnv) {
    const home = this.deps.expandHome("~");
    // Where the default instance's Claude Code reads its config (ClaudeHome.ts resolveClaudeHomePath).
    const inherited = text(defaultEnv.CLAUDE_CONFIG_DIR);
    const mainDir = inherited ? NodePath.resolve(inherited) : NodePath.join(home, ".claude");
    const mainConfig = inherited
      ? NodePath.join(mainDir, ".claude.json")
      : NodePath.join(home, ".claude.json");
    if (NodePath.resolve(dir) === mainDir) return;
    await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const name of CLAUDE_SHARED_ENTRIES) {
      const source = NodePath.join(mainDir, name);
      const target = NodePath.join(dir, name);
      const stat = await NodeFSP.stat(source).catch(() => undefined);
      if (!stat || (await pathExists(target))) continue;
      // A junction needs no privilege on Windows; a file symlink does.
      const type = stat.isDirectory()
        ? this.deps.platform === "win32"
          ? "junction"
          : "dir"
        : "file";
      try {
        await NodeFSP.symlink(source, target, type);
      } catch (error) {
        // A file that can't be linked is copied; a directory is left out.
        if (stat.isDirectory()) {
          this.deps.log(`Couldn't link ${name} into ${dir}; left it out`, error);
          continue;
        }
        await NodeFSP.copyFile(source, target);
        this.deps.log(`Couldn't link ${name} into ${dir}; copied it instead`, error);
      }
    }
    const config = NodePath.join(dir, ".claude.json");
    if (await pathExists(config)) return;
    const main = await readJson(mainConfig);
    const mcpServers = isRecord(main) && isRecord(main.mcpServers) ? main.mcpServers : {};
    if (Object.keys(mcpServers).length === 0) return;
    await NodeFSP.writeFile(config, `${JSON.stringify({ mcpServers }, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  }

  private async codexPlan(
    entry: MoveEntry,
    target: MoveTarget,
    settings: ServerSettings,
  ): Promise<SignInPlan> {
    const codex = this.codexDefault(settings);
    const plan = {
      binary: codex.binary,
      args: ["login"],
      acceptsCode: false,
      marker: CODEX_URL_MARKER,
    };
    if (target === "default") {
      // `codex login` refuses a CODEX_HOME that doesn't exist.
      await NodeFSP.mkdir(codex.home, { recursive: true });
      // Signing in replaces auth.json: keep a non-ChatGPT one (e.g. an API key) next to it.
      const auth = NodePath.join(codex.home, "auth.json");
      let backup: string | undefined;
      if (await pathExists(auth)) {
        backup = `${auth}.before-t3-move`;
        if (await pathExists(backup)) backup = `${backup}-${Date.now()}`;
        await NodeFSP.rename(auth, backup);
      }
      const saved = backup;
      return {
        ...plan,
        env: { ...signInEnv(codex.environment), CODEX_HOME: codex.home },
        signedInEmail: () => codexEmail(codex.home),
        ...(saved
          ? {
              restore: async () => {
                if (!(await pathExists(auth))) await NodeFSP.rename(saved, auth);
              },
            }
          : {}),
      };
    }
    const homePath = await this.homePathFor(entry, settings);
    let home: string;
    let config: Record<string, string>;
    if (await (this.symlinks ??= this.deps.canSymlink())) {
      // A shadow home: its own auth.json, everything else linked to the shared home.
      home = await this.deps.materializeCodexHome(codex.homePath, homePath);
      config = {
        setupMode: "existing",
        shadowHomePath: homePath,
        ...(codex.homePath ? { homePath: codex.homePath } : {}),
      };
    } else {
      // No symlinks (Windows without Developer Mode): a home of its own, with the shared config.
      home = this.resolveHome(homePath);
      await NodeFSP.mkdir(home, { recursive: true });
      await NodeFSP.copyFile(
        NodePath.join(codex.home, "config.toml"),
        NodePath.join(home, "config.toml"),
        NodeFSP.constants.COPYFILE_EXCL,
      ).catch((error: unknown) => {
        // None to copy, or copied before.
        if (isMissing(error) || (isRecord(error) && error.code === "EEXIST")) return;
        this.deps.log(`Couldn't copy Codex's config.toml into ${home}`, error);
      });
      config = { setupMode: "existing", homePath };
    }
    const env = { ...signInEnv(this.deps.env), CODEX_HOME: home };
    return {
      ...plan,
      env,
      signedInEmail: () => codexEmail(home),
      instance: {
        config: (email) => ({
          driver: ProviderDriverKind.make("codex"),
          displayName: email,
          enabled: true,
          config: { ...config, ...codex.binaryConfig },
        }),
        logout: async () => {
          await this.exec(codex.binary, ["logout"], env);
        },
      },
    };
  }

  /** Runs a short CLI command (status, logout) the way T3 spawns it. */
  private async exec(binary: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) {
    const spawn = await this.deps.resolveSpawn(binary, args, env);
    return runProcess(spawn.command, spawn.args, { env, shell: spawn.shell, timeoutMs: 15_000 });
  }

  private async launch(entry: MoveEntry, target: MoveTarget, plan: SignInPlan) {
    const spawn = await this.deps.resolveSpawn(plan.binary, plan.args, plan.env);
    const child = NodeChildProcess.spawn(spawn.command, spawn.args, {
      env: plan.env,
      shell: spawn.shell,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so `killTree` ends what it started too.
      detached: this.deps.platform !== "win32",
      windowsHide: true,
    });
    // Listeners first, before any await, so an early exit or spawn error is never missed.
    const exited = new Promise<{ readonly code: number | null; readonly error?: Error }>(
      (resolve) => {
        let grace: ReturnType<typeof setTimeout> | undefined;
        child.once("error", (error) => resolve({ code: null, error }));
        child.once("close", (code) => {
          clearTimeout(grace);
          resolve({ code });
        });
        // 'close' waits for the pipes, which a grandchild can hold open for good.
        child.once("exit", (code) => {
          grace = setTimeout(() => {
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
            resolve({ code });
          }, EXIT_GRACE_MS);
        });
      },
    );
    // A code pasted as the CLI exits must not take the server down (EPIPE).
    child.stdin.on("error", () => undefined);
    let foundUrl = () => {};
    const run: SignInRun = {
      ...newRun(entry, target, plan.acceptsCode, child),
      urlFound: new Promise((resolve) => (foundUrl = resolve)),
    };
    // Whole buffers, re-parsed per chunk: an escape sequence or URL can span two chunks.
    let output = "";
    let errors = "";
    const findUrl = (text: string) => {
      const url = run.url ? undefined : signInUrl(text, plan.marker);
      if (!url) return;
      run.url = url;
      foundUrl();
    };
    child.stdout.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-65_536);
      findUrl(output);
    });
    child.stderr.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-65_536);
      errors = (errors + String(chunk)).slice(-8_192);
      findUrl(output);
    });
    const timer = setTimeout(
      () => this.end(run, "The sign-in timed out after 10 minutes."),
      SIGN_IN_TIMEOUT_MS,
    );
    timer.unref();

    const name = `${PROVIDER_NAME[entry.provider]} (${plan.binary})`;
    run.finished = exited
      .then(async ({ code, error }) => {
        clearTimeout(timer);
        run.running = false;
        // The last line may have ended with the output.
        findUrl(`${output}\n`);
        if (run.state !== "waiting") return;
        if (error) {
          this.fail(run, isMissing(error) ? `${name} wasn't found.` : error.message);
        } else if (code !== 0) {
          this.fail(run, lastLine(errors) ?? `${name} exited with code ${code}.`);
        } else {
          await this.settle(run, plan);
        }
      })
      .catch((error: unknown) => this.fail(run, messageOf(error)))
      .then(() => (run.state === "done" ? undefined : this.restore(plan)));
    return run;
  }

  /** `plan.restore`, if the sign-in didn't finish; logs instead of failing. */
  private async restore(plan: SignInPlan) {
    await plan
      .restore?.()
      .catch((error: unknown) => this.deps.log("Putting the replaced sign-in back failed", error));
  }

  /**
   * The CLI finished (or `email` was signed in already): keep the sign-in if
   * it is an account that counts.
   */
  private async settle(run: SignInRun, plan: SignInPlan, known?: string) {
    const provider = run.entry.provider;
    const email = known ?? (await plan.signedInEmail());
    if (!email && plan.instance) {
      // Nothing readable signed in (e.g. a login kept elsewhere): don't leave it in the new dir.
      await plan.instance
        .logout()
        .catch((error: unknown) =>
          this.deps.log(`Signing ${run.entry.email}'s new directory out failed`, error),
        );
    }
    const problem = email
      ? await this.accept(run, plan, email)
      : `${PROVIDER_NAME[provider]} finished without a signed-in account.`;
    // The default home's sign-in may have changed: read it again before reporting.
    await this.refreshDefault(provider).catch((error) =>
      this.deps.log(`Reading the default ${provider} sign-in failed`, error),
    );
    if (run.target === "default") {
      void this.deps
        .refreshInstance(DEFAULT_INSTANCE[provider])
        .catch((error) => this.deps.log(`Refreshing ${DEFAULT_INSTANCE[provider]} failed`, error));
    }
    if (email) run.email = email;
    if (problem) this.fail(run, problem);
    else run.state = "done";
  }

  /** Records `email`'s sign-in; returns why it doesn't count, if it doesn't. */
  private async accept(run: SignInRun, plan: SignInPlan, email: string) {
    const isEmail = (entry: MoveEntry) =>
      entry.provider === run.entry.provider && entry.email.toLowerCase() === email.toLowerCase();
    if (plan.instance) {
      // A new instance is for the account that was clicked, and only that one.
      if (!isEmail(run.entry)) {
        await plan.instance
          .logout()
          .catch((error: unknown) => this.deps.log(`Signing ${email} out again failed`, error));
        return `Signed in as ${email}. Sign your browser in to ${run.entry.email} and try again.`;
      }
      await this.addInstance(moveAccountId(run.entry), plan.instance.config(run.entry.email));
      await updateMoveList(this.listPath, (entries) =>
        entries.filter((entry) => !sameAccount(entry, run.entry)),
      );
      return undefined;
    }
    // The default home keeps whatever signed in (it may be the user's own main account);
    // it counts for any account on the list.
    const settings = await this.deps.getSettings();
    const match = (await readMoveList(this.listPath)).find(
      (entry) => isEmail(entry) && !(moveAccountId(entry) in settings.providerInstances),
    );
    if (!match) return `Signed in as ${email}, which isn't in this list.`;
    await updateMoveList(this.listPath, (entries) =>
      entries.filter((entry) => !sameAccount(entry, match)),
    );
    return undefined;
  }

  /** Sign-ins never overlap, so this is the move's only writer of the map. */
  private async addInstance(id: string, instance: ProviderInstanceConfig) {
    // The patch replaces the whole map: start from what is saved right now (never the
    // derived map, which would persist the default instances).
    const current = (await this.deps.getSettings()).providerInstances;
    await this.deps.updateSettings({
      providerInstances: { ...current, [ProviderInstanceId.make(id)]: instance },
    });
  }

  private fail(run: SignInRun, message: string) {
    if (run.state !== "waiting") return;
    run.state = "error";
    run.message = message;
  }

  /** Fails `run` and ends its CLI. */
  private end(run: SignInRun, message: string) {
    this.fail(run, message);
    if (run.child) killTree(run.child, this.deps.platform);
  }

  /** Ends `run` and waits for its final state. A CLI that already exited is left to finish. */
  private async stop(run: SignInRun, message: string) {
    if (run.running) this.end(run, message);
    await run.finished;
  }
}
