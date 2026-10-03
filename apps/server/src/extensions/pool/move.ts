// @effect-diagnostics globalTimers:off globalDate:off - the move is plain async Node by design; Effect wraps it at the layer and handler boundary.
// @effect-diagnostics nodeBuiltinImport:off - the move runs the provider CLIs and lays out their config dirs with plain Node.
/**
 * Signs Claude and Codex accounts in, one at a time, with each provider's own
 * CLI login: the retired pool's accounts (the move list) and new ones the user
 * adds, or an account instance signed in again in its own dir. Removing an
 * account instance signs it out with the same CLI. One instance per server,
 * created by `layer.ts`; plain async code, the Effect boundary is the layer
 * and the handlers.
 *
 * A sign-in lands in the provider's default home (`~/.claude`, `~/.codex`)
 * while that home has no subscription sign-in, else in a new instance of its
 * own: `~/.claude-<slug>`, or a Codex shadow home on the shared Codex home (a
 * standalone `~/.codex-<slug>` where symlinks can't be made). An added
 * account's email is only known after its login, so its dir is
 * `~/.claude-account-<hex>` / `~/.codex-account-<hex>`, made for it and deleted
 * again if the sign-in doesn't finish. In the default home any account on the
 * list counts; in a new instance only the one clicked, or for an added account
 * any one T3 doesn't have yet.
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

import { CLAUDE_ACCOUNT_MARKER } from "../claudeHistory.ts";
import { migratePool } from "./boot.ts";
import { CLAUDE_URL_MARKER, CODEX_URL_MARKER, lastLine, signInEnv, signInUrl } from "./cli.ts";
import { ClaudePrivacy, type PrivacyDeps } from "./privacy.ts";
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

const PROVIDERS = ["claude", "codex"] as const;
/** Each provider's default instance id, which is also its driver kind. */
const DEFAULT_INSTANCE: Record<MoveProvider, string> = { claude: "claudeAgent", codex: "codex" };
const CLI: Record<MoveProvider, string> = { claude: "claude", codex: "codex" };
const PROVIDER_NAME: Record<MoveProvider, string> = { claude: "Claude Code", codex: "Codex" };
/** Where each provider keeps the default instance's sign-in. */
const MAIN_HOME: Record<MoveProvider, string> = {
  claude: "Claude config dir",
  codex: "Codex home",
};
const EMAIL = /^[^\s@]+@[^\s@]+$/;

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
/** How long `status` reuses a read of the default logins. */
const DEFAULTS_TTL_MS = 30_000;
/** How long `signIn.start` waits for the CLI to print its sign-in page. */
const URL_WAIT_MS = 5_000;
/** How long an exited CLI's output may stay open (a grandchild holding the pipes). */
const EXIT_GRACE_MS = 500;

/** `PrivacyDeps` (settings, homes, the Claude terminal, refresh), plus what sign-ins need. */
export interface MoveDeps extends PrivacyDeps {
  readonly updateSettings: (patch: ServerSettingsPatch) => Promise<void>;
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
  /** Whether this host lets T3 create symlinks (`canCreateSymlinks`); asked once. */
  readonly canSymlink: () => Promise<boolean>;
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
  /**
   * Undoes the sign-in when it doesn't finish: puts back a login it moved
   * aside (default home), or signs the new dir out again and deletes it if
   * this sign-in made it (new instance; never a default home or an existing
   * instance's dir).
   */
  readonly restore?: () => Promise<void>;
  /**
   * Signs out the account that just signed in, when `accept` refuses it
   * there: one T3 has in a default home (putting back a login it replaced),
   * another account in an instance signed in again.
   */
  readonly signOut?: () => Promise<void>;
  /** Instance target only: the instance an account signed in here becomes. */
  readonly instance?: (email: string) => ProviderInstanceConfig;
}

/** What a sign-in is for: a listed account, a new account of `provider`, or an existing instance. */
interface SignInRequest {
  readonly provider: MoveProvider;
  readonly entry?: MoveEntry;
  /** `account.signIn`: the instance signed in again, and its account when its name is an email. */
  readonly existing?: {
    readonly id: string;
    readonly instance: ProviderInstanceConfig;
    readonly email?: string;
  };
}

type SignInPick =
  | { readonly accountId: string }
  | { readonly provider: MoveProvider }
  | { readonly instanceId: string };

interface SignInRun extends SignInRequest {
  readonly signInId: string;
  readonly target: MoveTarget;
  readonly acceptsCode: boolean;
  /** Absent when the account was signed in there already. */
  readonly child?: NodeChildProcess.ChildProcess;
  /** Until the CLI exits; afterwards the result is being checked and can't be cancelled. */
  running: boolean;
  state: MoveSignInState["state"];
  url?: string;
  email?: string;
  /** `done`: the instance the account now is. */
  instanceId?: string;
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

const isCode = (error: unknown, code: string) => isRecord(error) && error.code === code;

/**
 * Marks `dir` as an account dir T3 made (`CLAUDE_ACCOUNT_MARKER`, which the
 * Claude history sharing looks for), naming the main config dir it shares
 * with; keeps a marker already there.
 */
const markClaudeAccountDir = (dir: string, mainDir: string) =>
  NodeFSP.writeFile(NodePath.join(dir, CLAUDE_ACCOUNT_MARKER), mainDir, {
    mode: 0o600,
    flag: "wx",
  }).catch((error: unknown) => {
    if (!isCode(error, "EEXIST")) throw error;
  });

/**
 * Deletes an account dir a sign-in made. Its links (into the main Claude
 * config dir or the shared Codex home) are unlinked first, so nothing behind
 * one is ever touched; the rest is the account's own (its `.claude.json`,
 * caches, the marker, a shadow home's own files).
 */
const removeAccountDir = async (dir: string) => {
  for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) await NodeFSP.unlink(NodePath.join(dir, entry.name));
  }
  await NodeFSP.rm(dir, { recursive: true, force: true });
};

/** A sign-in that is waiting; without a CLI (`child`) it is already being checked. */
const newRun = (
  request: SignInRequest,
  target: MoveTarget,
  acceptsCode: boolean,
  child?: NodeChildProcess.ChildProcess,
): SignInRun => ({
  signInId: NodeCrypto.randomUUID(),
  ...request,
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
  private defaultsRead: { readonly at: number; readonly done: Promise<void> } | undefined;
  /** Each default home's sign-in; absent while unknown (then it is never the target). */
  private defaults: Partial<Record<MoveProvider, DefaultLogin | undefined>> = {};
  /** The current (or last) sign-in. One at a time: Codex's callback port is fixed. */
  private run: SignInRun | undefined;
  /** Sign-ins a newer one replaced, for pollers still asking about them. */
  private readonly replaced = new Set<string>();
  private starting: Promise<unknown> = Promise.resolve();
  private instanceWrites: Promise<unknown> = Promise.resolve();
  private symlinks: Promise<boolean> | undefined;
  /** Set by `close`: a start still in flight launches nothing (or ends what it launched). */
  private closed = false;
  /** Training settings and session resets (`privacy.*`, `reset.useClaude`). */
  readonly privacy: ClaudePrivacy;

  constructor(deps: MoveDeps) {
    this.deps = deps;
    this.listPath = moveListPath(deps.stateDir);
    this.privacy = new ClaudePrivacy(deps);
  }

  /**
   * Server start: retire the pool, drop its usage source, then read the
   * default logins and drop the accounts T3 has already. Runs once; never
   * rejects.
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
      await this.readDefaults();
      await this.prune().catch(log("Updating the account move list failed"));
    })();
    return this.booted;
  }

  async status(): Promise<MoveStatus> {
    await this.boot();
    await this.readDefaults();
    const [entries, settings] = await Promise.all([
      readMoveList(this.listPath),
      this.deps.getSettings(),
      this.privacy.load(),
    ]);
    const run = this.run;
    return {
      // One T3 got since (another way) isn't offered; the list drops it at the next start.
      accounts: entries
        .filter((entry) => !this.isKnown(entry, settings))
        .map((entry) => ({
          id: moveAccountId(entry),
          provider: entry.provider,
          email: entry.email,
          ...(entry.plan ? { plan: entry.plan } : {}),
        })),
      addTarget: { claude: this.targetOf("claude"), codex: this.targetOf("codex") },
      privacy: this.privacy.status(settings),
      ...(run?.state === "waiting"
        ? {
            signIn: {
              signInId: run.signInId,
              provider: run.provider,
              ...(run.entry ? { accountId: moveAccountId(run.entry) } : {}),
              ...(run.existing ? { instanceId: run.existing.id } : {}),
            },
          }
        : {}),
    };
  }

  /** Starts `accountId`'s sign-in, cancelling the one running. */
  startSignIn(accountId: string): Promise<MoveSignInStart> {
    return this.queueStart({ accountId });
  }

  /** Starts a sign-in for a new `provider` account, cancelling the one running. */
  addAccount(provider: MoveProvider): Promise<MoveSignInStart> {
    return this.queueStart({ provider });
  }

  /** Signs an account instance in again in its own dir, cancelling the sign-in running. */
  signInAgain(instanceId: string): Promise<MoveSignInStart> {
    return this.queueStart({ instanceId });
  }

  /**
   * Signs an account instance out with its CLI's own logout (a failed logout
   * is only logged, and none runs while another instance uses the same
   * sign-in) and removes it from T3. Its dir stays: its threads' transcripts
   * point into it, and Claude's history in it is shared.
   */
  async removeAccount(instanceId: string): Promise<MoveStatus> {
    await this.boot();
    if (Object.values(DEFAULT_INSTANCE).includes(instanceId)) {
      throw new Error("The main account can't be removed.");
    }
    const { settings, instance, provider } = await this.savedAccount(instanceId, "removed");
    const logout = await this.logoutOf(provider, instance, settings);
    // Its sign-in again would otherwise finish after the logout, signing the account back in.
    const run = this.run;
    if (run?.existing?.id === instanceId) await this.stop(run, "The account was removed.");
    // Nor may a Claude Code terminal keep running on it.
    await this.privacy.stop(instanceId);
    if (logout) {
      const name = instance.displayName ?? instanceId;
      // The default instances count too (a default Codex can have a shadow home of its own).
      let sharer: string | undefined;
      for (const [id, other] of Object.entries(deriveProviderInstanceConfigMap(settings))) {
        if (id === instanceId || other.driver !== instance.driver) continue;
        if ((await this.signInHome(provider, other, settings))?.dir === logout.dir) sharer = id;
      }
      if (sharer) {
        this.deps.log(`Didn't sign ${name} out: ${sharer} uses the same sign-in (${logout.dir})`);
      } else {
        await this.logOut(name, logout.binary, logout.logout, logout.env);
      }
    }
    await this.changeInstances((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => id !== instanceId)),
    );
    await this.privacy.forget(instanceId);
    return this.status();
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
      ...(run.instanceId ? { instanceId: run.instanceId } : {}),
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
    const run = this.run;
    if (run?.entry && moveAccountId(run.entry) === accountId) await this.stop(run, "Skipped.");
    await updateMoveList(this.listPath, (entries) =>
      entries.filter((entry) => moveAccountId(entry) !== accountId),
    );
    return this.status();
  }

  /**
   * Server shutdown: ends a running sign-in CLI (and any a start still in
   * flight launches) and the running Claude Code terminal task.
   */
  close() {
    this.closed = true;
    this.privacy.close();
    const run = this.run;
    if (run?.running) this.end(run, "The server stopped.");
  }

  /** Starts never overlap: Codex's callback port is fixed. */
  private queueStart(pick: SignInPick): Promise<MoveSignInStart> {
    const next = this.starting.then(() => this.start(pick));
    this.starting = next.catch(() => undefined);
    return next;
  }

  private async start(pick: SignInPick): Promise<MoveSignInStart> {
    await this.boot();
    if (this.run) await this.stop(this.run, "Another sign-in started.");
    let request: SignInRequest;
    if ("accountId" in pick) {
      const entry = (await readMoveList(this.listPath)).find(
        (candidate) => moveAccountId(candidate) === pick.accountId,
      );
      if (!entry) throw new Error("That account isn't on the list anymore.");
      request = { provider: entry.provider, entry };
    } else if ("instanceId" in pick) {
      if (Object.values(DEFAULT_INSTANCE).includes(pick.instanceId)) {
        throw new Error("Sign the main account in with Add account.");
      }
      const { instance, provider } = await this.savedAccount(pick.instanceId, "signed in");
      const name = instance.displayName?.trim() ?? "";
      request = {
        provider,
        existing: { id: pick.instanceId, instance, ...(EMAIL.test(name) ? { email: name } : {}) },
      };
    } else {
      request = { provider: pick.provider };
    }
    const { provider, entry } = request;
    // Read again: signing in over a default login that appeared since would replace it.
    await this.refreshDefault(provider);
    const override = provider === "claude" ? this.defaults.claude?.override : undefined;
    if (override) {
      throw new Error(
        `Claude Code is set to use ${override} (in its settings.json), which overrides any sign-in. Remove it, then sign in.`,
      );
    }
    // An instance signed in again is never the default home, whatever that holds.
    const target = request.existing ? "instance" : this.targetOf(provider);
    const settings = await this.deps.getSettings();
    if (this.closed) throw new Error("The server stopped.");
    const plan = request.existing
      ? await this.existingPlan(request.existing, provider, settings)
      : provider === "claude"
        ? await this.claudePlan(entry, target, settings)
        : await this.codexPlan(entry, target, settings);
    if (entry && plan.instance) {
      const email = await plan.signedInEmail();
      if (email?.toLowerCase() === entry.email.toLowerCase()) {
        // Signed in there already (an earlier sign-in that wasn't saved): keep it, no CLI.
        const run = this.track(newRun(request, target, plan.acceptsCode));
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
      run = this.track(await this.launch(request, target, plan));
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

  /**
   * Reads both default logins (boot with a list, status), reusing a read from
   * the last `DEFAULTS_TTL_MS`; sign-ins re-read theirs.
   */
  private readDefaults() {
    const now = Date.now();
    if (!this.defaultsRead || now - this.defaultsRead.at >= DEFAULTS_TTL_MS) {
      const done = Promise.all(
        PROVIDERS.map((provider) =>
          this.refreshDefault(provider).catch((error: unknown) =>
            this.deps.log(`Reading the default ${provider} sign-in failed`, error),
          ),
        ),
      ).then(() => undefined);
      this.defaultsRead = { at: now, done };
    }
    return this.defaultsRead.done;
  }

  /** Whether T3 has `account` already: as a default home's sign-in, or as an instance. */
  private isKnown(account: MoveEntry, settings: ServerSettings) {
    const email = account.email.toLowerCase();
    return (
      this.defaults[account.provider]?.email?.toLowerCase() === email ||
      moveAccountId(account) in settings.providerInstances ||
      Object.values(settings.providerInstances).some(
        (instance) =>
          instance.driver === DEFAULT_INSTANCE[account.provider] &&
          instance.displayName?.toLowerCase() === email,
      )
    );
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

  /** Drops the accounts T3 has already (`isKnown`). */
  private async prune() {
    const settings = await this.deps.getSettings();
    await updateMoveList(this.listPath, (entries) =>
      entries.filter((entry) => !this.isKnown(entry, settings)),
    );
  }

  /** Whether an instance (other than `exceptId`) keeps its home or shadow home in `dir`. */
  private homeInUse(dir: string, settings: ServerSettings, exceptId?: string) {
    return Object.entries(settings.providerInstances).some(([id, instance]) => {
      if (id === exceptId) return false;
      const config = configOf(instance);
      return [text(config.homePath), text(config.shadowHomePath)].some(
        (path) => path && this.resolveHome(path) === dir,
      );
    });
  }

  /** `~/.claude-<slug>` / `~/.codex-<slug>`, plus the account's hash when another account has it. */
  private async homePathFor(entry: MoveEntry, settings: ServerSettings) {
    const hash = accountHash(entry.provider, entry.email);
    const plain = `~/.${CLI[entry.provider]}-${emailSlug(entry.email) || hash}`;
    const dir = this.resolveHome(plain);
    const signedInAs =
      entry.provider === "claude" ? await claudeConfigEmail(dir) : await codexEmail(dir);
    const taken =
      this.homeInUse(dir, settings, moveAccountId(entry)) ||
      (signedInAs !== undefined && signedInAs.toLowerCase() !== entry.email.toLowerCase());
    return taken ? `${plain}-${hash}` : plain;
  }

  /**
   * A new account's dir, `~/.claude-account-<hex>` / `~/.codex-account-<hex>`,
   * made here, so it is this sign-in's to delete again. It is fixed before the
   * login: Claude's Keychain item is named after the dir.
   */
  private async claimAccountHome(provider: MoveProvider, settings: ServerSettings) {
    for (;;) {
      const homePath = `~/.${CLI[provider]}-account-${NodeCrypto.randomBytes(3).toString("hex")}`;
      const dir = this.resolveHome(homePath);
      if (this.homeInUse(dir, settings)) continue;
      try {
        // Not recursive: fails if the dir exists, so it is only ever one this sign-in made.
        await NodeFSP.mkdir(dir, { mode: 0o700 });
        return homePath;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
      }
    }
  }

  /** Signs a new dir out again (logged, not thrown), then deletes it if this sign-in made it. */
  private async undoInstance(logout: () => Promise<unknown>, made: string | undefined) {
    await logout().catch((error: unknown) => this.deps.log("Signing a new dir out failed", error));
    if (made) await removeAccountDir(made);
  }

  /** Deletes a dir a sign-in made when preparing that sign-in failed, then rethrows. */
  private async abandon(made: string | undefined, error: unknown): Promise<never> {
    if (made) {
      await removeAccountDir(made).catch((cause: unknown) =>
        this.deps.log(`Deleting ${made} failed`, cause),
      );
    }
    throw error;
  }

  /** Where the default instance's Claude Code keeps its config (ClaudeHome.ts resolveClaudeHomePath). */
  private claudeMainDir(defaultEnv: NodeJS.ProcessEnv) {
    const inherited = text(defaultEnv.CLAUDE_CONFIG_DIR);
    return inherited
      ? NodePath.resolve(inherited)
      : NodePath.join(this.deps.expandHome("~"), ".claude");
  }

  /** A saved Claude or Codex instance (`action`: what other drivers can't be). */
  private async savedAccount(instanceId: string, action: string) {
    const settings = await this.deps.getSettings();
    const instance = Object.entries(settings.providerInstances).find(
      ([id]) => id === instanceId,
    )?.[1];
    if (!instance) throw new Error("That account isn't in T3 anymore.");
    const provider = PROVIDERS.find((candidate) => DEFAULT_INSTANCE[candidate] === instance.driver);
    if (!provider) throw new Error(`Only Claude and Codex accounts can be ${action} here.`);
    return { settings, instance, provider };
  }

  /**
   * Where `instance` keeps its sign-in (Claude's config dir, Codex's shadow or
   * own home), the default instance's next to it, and how its CLI runs there:
   * its binary and environment as the driver builds them (Claude's Keychain
   * item is named after the literal CLAUDE_CONFIG_DIR). None for a managed
   * Codex instance, whose sign-in T3 keeps.
   */
  private async signInHome(
    provider: MoveProvider,
    instance: ProviderInstanceConfig,
    settings: ServerSettings,
  ) {
    const config = configOf(instance);
    const binary = this.deps.expandHome(text(config.binaryPath) || CLI[provider]);
    const base = signInEnv(mergeProviderInstanceEnvironment(instance.environment, this.deps.env));
    if (provider === "claude") {
      const env = await this.deps.claudeEnvironment(text(config.homePath), base);
      const main = this.claudeMainDir(await this.claudeDefaultEnv(settings));
      const dir = text(env.CLAUDE_CONFIG_DIR);
      const logout = ["auth", "logout"];
      return { binary, env, dir: dir ? NodePath.resolve(dir) : main, main, logout };
    }
    if (config.setupMode === "managed") return undefined;
    const main = this.codexDefault(settings).home;
    const homePath = text(config.shadowHomePath) || text(config.homePath);
    const dir = homePath ? this.resolveHome(homePath) : main;
    return { binary, env: { ...base, CODEX_HOME: dir }, dir, main, logout: ["logout"] };
  }

  /**
   * How to sign `instance` out. Refuses an instance without a home of its
   * own: its logout would sign the default instance out too. None for a
   * managed Codex instance.
   */
  private async logoutOf(
    provider: MoveProvider,
    instance: ProviderInstanceConfig,
    settings: ServerSettings,
  ) {
    const home = await this.signInHome(provider, instance, settings);
    if (home && home.dir === home.main) {
      throw new Error(
        `This account uses the main ${MAIN_HOME[provider]}, so signing it out would sign the main account out.`,
      );
    }
    return home;
  }

  /** Runs a logout; one that fails is only logged. */
  private async logOut(
    name: string,
    binary: string,
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv,
  ) {
    await this.exec(binary, args, env).then(
      (result) => {
        if (result.code !== 0) {
          this.deps.log(
            `Signing ${name} out exited with code ${result.code}`,
            lastLine(result.stderr),
          );
        }
      },
      (error: unknown) => this.deps.log(`Signing ${name} out failed`, error),
    );
  }

  /**
   * `account.signIn`: the provider's own login in an account instance's own
   * config dir or home, run the way the instance runs. Only the account it
   * is counts (any, when its name isn't an email); another one is signed out
   * again. The dir always stays.
   */
  private async existingPlan(
    existing: NonNullable<SignInRequest["existing"]>,
    provider: MoveProvider,
    settings: ServerSettings,
  ): Promise<SignInPlan> {
    const home = await this.signInHome(provider, existing.instance, settings);
    if (!home) throw new Error("Sign in under More provider settings.");
    if (home.dir === home.main) {
      throw new Error(
        `This account shares the main ${MAIN_HOME[provider]}, so it signs in with the main account.`,
      );
    }
    const claude = provider === "claude";
    const signedInEmail = claude
      ? async () => {
          const login = await this.claudeLogin(home.binary, home.env);
          return login?.signedIn ? login.email : undefined;
        }
      : () => codexEmail(home.dir);
    return {
      binary: home.binary,
      args: claude
        ? ["auth", "login", ...(existing.email ? ["--email", existing.email] : [])]
        : ["login"],
      env: home.env,
      acceptsCode: claude,
      marker: claude ? CLAUDE_URL_MARKER : CODEX_URL_MARKER,
      signedInEmail,
      // No `restore`: a cancelled or failed login leaves the dir as it was.
      signOut: () => this.logOut(home.dir, home.binary, home.logout, home.env),
    };
  }

  private async claudePlan(
    entry: MoveEntry | undefined,
    target: MoveTarget,
    settings: ServerSettings,
  ): Promise<SignInPlan> {
    const defaults = this.defaultInstance(settings, "claude");
    const defaultEnv = await this.claudeDefaultEnv(settings);
    const plan = {
      binary: defaults.binary,
      // A new account is whichever one the browser signs in.
      args: entry ? ["auth", "login", "--email", entry.email] : ["auth", "login"],
      acceptsCode: true,
      marker: CLAUDE_URL_MARKER,
    };
    const signedInEmail = (env: NodeJS.ProcessEnv) => async () => {
      const login = await this.claudeLogin(defaults.binary, env);
      return login?.signedIn ? login.email : undefined;
    };
    if (target === "default") {
      return {
        ...plan,
        env: defaultEnv,
        signedInEmail: signedInEmail(defaultEnv),
        signOut: () =>
          this.logOut("the main account", defaults.binary, ["auth", "logout"], defaultEnv),
      };
    }
    const homePath = entry
      ? await this.homePathFor(entry, settings)
      : await this.claimAccountHome("claude", settings);
    const made = entry ? undefined : this.resolveHome(homePath);
    try {
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
        restore: () =>
          this.undoInstance(() => this.exec(defaults.binary, ["auth", "logout"], env), made),
        instance: (email) => ({
          driver: ProviderDriverKind.make("claudeAgent"),
          displayName: email,
          enabled: true,
          config: { homePath, ...defaults.binaryConfig },
        }),
      };
    } catch (error) {
      return this.abandon(made, error);
    }
  }

  /**
   * Shares the main config dir's settings, memory, skills, agents, commands,
   * plugins and output styles with a new account's `dir`, marks it as T3's
   * (`CLAUDE_ACCOUNT_MARKER`) and copies the main MCP servers once. Only fills
   * in what `dir` doesn't have yet.
   */
  private async seedClaudeHome(dir: string, defaultEnv: NodeJS.ProcessEnv) {
    const mainDir = this.claudeMainDir(defaultEnv);
    const mainConfig = text(defaultEnv.CLAUDE_CONFIG_DIR)
      ? NodePath.join(mainDir, ".claude.json")
      : NodePath.join(this.deps.expandHome("~"), ".claude.json");
    if (NodePath.resolve(dir) === mainDir) return;
    await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
    await markClaudeAccountDir(dir, mainDir);
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
    entry: MoveEntry | undefined,
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
      const env = { ...signInEnv(codex.environment), CODEX_HOME: codex.home };
      return {
        ...plan,
        env,
        signedInEmail: () => codexEmail(codex.home),
        signOut: () =>
          saved
            ? NodeFSP.rename(saved, auth)
            : this.logOut("the main account", codex.binary, ["logout"], env),
        ...(saved
          ? {
              restore: async () => {
                if (!(await pathExists(auth))) await NodeFSP.rename(saved, auth);
              },
            }
          : {}),
      };
    }
    const homePath = entry
      ? await this.homePathFor(entry, settings)
      : await this.claimAccountHome("codex", settings);
    const made = entry ? undefined : this.resolveHome(homePath);
    let home: string;
    let config: Record<string, string>;
    try {
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
          if (isMissing(error) || isCode(error, "EEXIST")) return;
          this.deps.log(`Couldn't copy Codex's config.toml into ${home}`, error);
        });
        config = { setupMode: "existing", homePath };
      }
    } catch (error) {
      return this.abandon(made, error);
    }
    const env = { ...signInEnv(this.deps.env), CODEX_HOME: home };
    return {
      ...plan,
      env,
      signedInEmail: () => codexEmail(home),
      restore: () => this.undoInstance(() => this.exec(codex.binary, ["logout"], env), made),
      instance: (email) => ({
        driver: ProviderDriverKind.make("codex"),
        displayName: email,
        enabled: true,
        config: { ...config, ...codex.binaryConfig },
      }),
    };
  }

  /** Runs a short CLI command (status, logout) the way T3 spawns it. */
  private async exec(binary: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) {
    const spawn = await this.deps.resolveSpawn(binary, args, env);
    return runProcess(spawn.command, spawn.args, { env, shell: spawn.shell, timeoutMs: 15_000 });
  }

  private async launch(request: SignInRequest, target: MoveTarget, plan: SignInPlan) {
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
      ...newRun(request, target, plan.acceptsCode, child),
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

    const name = `${PROVIDER_NAME[request.provider]} (${plan.binary})`;
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
      .catch((error: unknown) => this.deps.log("Undoing an unfinished sign-in failed", error));
  }

  /**
   * The CLI finished (or `email` was signed in already): keep the sign-in if
   * it is an account that counts. One that doesn't is signed out again by
   * `plan.restore` (a new instance's dir) or `plan.signOut`.
   */
  private async settle(run: SignInRun, plan: SignInPlan, known?: string) {
    const provider = run.provider;
    const email = known ?? (await plan.signedInEmail());
    const problem = email
      ? await this.accept(run, plan, email)
      : `${PROVIDER_NAME[provider]} finished without a signed-in account.`;
    // The default home's sign-in may have changed: read it again before reporting.
    await this.refreshDefault(provider).catch((error) =>
      this.deps.log(`Reading the default ${provider} sign-in failed`, error),
    );
    const refresh = (instanceId: string) =>
      void this.deps
        .refreshInstance(instanceId)
        .catch((error) => this.deps.log(`Refreshing ${instanceId} failed`, error));
    if (run.target === "default") refresh(DEFAULT_INSTANCE[provider]);
    if (run.existing && !problem) refresh(run.existing.id);
    if (email) run.email = email;
    if (problem) this.fail(run, problem);
    else run.state = "done";
    if (run.state === "done" && provider === "claude" && run.instanceId) {
      this.privacy.afterSignIn(run.instanceId);
    }
  }

  /** Records `email`'s sign-in; returns why it doesn't count, if it doesn't. */
  private async accept(run: SignInRun, plan: SignInPlan, email: string) {
    const signOut = () =>
      plan
        .signOut?.()
        .catch((error: unknown) => this.deps.log(`Signing ${email} out again failed`, error));
    if (run.existing) {
      // The instance is there already; only its own account counts.
      const expected = run.existing.email;
      if (expected && expected.toLowerCase() !== email.toLowerCase()) {
        await signOut();
        return `Signed in as ${email}. Sign your browser in to ${expected} and try again.`;
      }
      run.instanceId = run.existing.id;
      return undefined;
    }
    const account: MoveEntry = { provider: run.provider, email };
    const settings = await this.deps.getSettings();
    // Once the sign-in is saved it counts; a list entry left behind goes at the next boot.
    const dropListed = () =>
      updateMoveList(this.listPath, (entries) =>
        entries.filter((entry) => !sameAccount(entry, account)),
      ).catch((error: unknown) => this.deps.log("Updating the account move list failed", error));
    if (plan.instance) {
      // A listed account's new instance is for that account only; a new account for one
      // T3 doesn't have yet. Either way its id is the account's, so threads bound to an
      // account that was removed and added again find it.
      if (run.entry && !sameAccount(run.entry, account)) {
        return `Signed in as ${email}. Sign your browser in to ${run.entry.email} and try again.`;
      }
      if (!run.entry && this.isKnown(account, settings)) return `${email} is already in T3.`;
      const id = moveAccountId(account);
      const instance = plan.instance(run.entry?.email ?? email);
      await this.changeInstances((current) => ({
        ...current,
        [ProviderInstanceId.make(id)]: instance,
      }));
      await dropListed();
      run.instanceId = id;
      return undefined;
    }
    // The default home keeps whatever signed in (it may be the user's own main account).
    if (run.entry) {
      // It counts for any account on the list.
      const listed = (await readMoveList(this.listPath)).some(
        (entry) =>
          sameAccount(entry, account) && !(moveAccountId(entry) in settings.providerInstances),
      );
      if (!listed) return `Signed in as ${email}, which isn't in this list.`;
    } else if (this.isKnown(account, settings)) {
      // The default home was signed out when this started: it stays so, not a second copy.
      await signOut();
      return `${email} is already in T3, so the main account stays signed out.`;
    }
    await dropListed();
    run.instanceId = DEFAULT_INSTANCE[run.provider];
    return undefined;
  }

  /**
   * Saves a change to the instance map, one at a time. The patch replaces the
   * whole map, so each starts from what is saved right now (never the derived
   * map, which would persist the default instances). A client's own settings
   * write doesn't queue here and can still land between the read and the write.
   */
  private changeInstances(
    change: (current: ServerSettings["providerInstances"]) => ServerSettings["providerInstances"],
  ) {
    const next = this.instanceWrites.then(async () => {
      const current = (await this.deps.getSettings()).providerInstances;
      await this.deps.updateSettings({ providerInstances: change(current) });
    });
    this.instanceWrites = next.catch(() => undefined);
    return next;
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
