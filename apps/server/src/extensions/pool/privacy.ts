// @effect-diagnostics globalTimers:off globalDate:off - the privacy queue is plain async Node by design; Effect wraps it at the layer and handler boundary.
// @effect-diagnostics nodeBuiltinImport:off - reads and writes small JSON files in T3's state directory and Claude account dirs with plain Node.
/**
 * Each account's model training setting and Claude's session limit reset.
 * Claude's are only reachable through Claude Code's own `/privacy-settings`
 * and `/limit-reset`, so `claudeTerminal.ts` drives the unmodified `claude` in
 * a PTY, one run at a time server-wide; T3 never reads or sends a token.
 * ChatGPT's setting has no API: T3 remembers what the user says about it.
 *
 * State: `<stateDir>/pool-privacy.json` (0600), what each Claude account read
 * last, the user's Codex word, and whether to keep training off. With that on,
 * a daily sweep checks the Claude accounts and turns training off where it
 * reads "on", and `instanceOverlay` turns off the feedback uploads each CLI
 * can send (Codex `/feedback`, Claude's `/bug` and survey).
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type ClaudeAccountPrivacy,
  type PrivacyStatus,
  type PrivacyTask,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceEnvironmentVariable,
  resolveProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";

import { CLAUDE_ACCOUNT_MARKER, claudeIsRunning, isPreviousReleaseDir } from "../claudeHistory.ts";
import type { ClaudeTerminalTarget, PtyLike, PtySpawner, TrainingRead } from "./claudeTerminal.ts";
import { signInEnv } from "./cli.ts";
import { isMissing, isRecord, text, writeJsonFile } from "./state.ts";
import { deriveProviderInstanceConfigMap, mergeProviderInstanceEnvironment } from "./t3.ts";

const CLAUDE_DRIVER = "claudeAgent";
const CODEX_DRIVER = "codex";
const DAY_MS = 24 * 60 * 60_000;
/** An "off" read this recently isn't checked again; under a day, so each daily sweep checks every account. */
const FRESH_MS = DAY_MS / 2;
/** The first sweep after the server starts, out of the way of startup. */
const BOOT_SWEEP_DELAY_MS = 60_000;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const UNREADABLE = "T3 couldn't read its saved privacy settings. Try again in a moment.";

/** Codex's own switch for `/feedback` uploads, which OpenAI may train on even after an opt-out. */
const CODEX_NO_FEEDBACK_ARG = "-c feedback.enabled=false";
/** Codex's launch args when set (upstream's `resolveCodexLaunchArgs`), instead of `launchArgs`. */
const CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";
/** Claude Code's switches for `/bug` reports and the session-quality survey. */
const CLAUDE_NO_FEEDBACK_ENV: Readonly<Record<string, string>> = {
  DISABLE_BUG_COMMAND: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
};

type ResetOutcome = NonNullable<ClaudeAccountPrivacy["reset"]>["outcome"];

/** claudeTerminal.ts's API, injected so tests drive fakes. */
export interface ClaudeTerminal {
  readonly claudeTerminalEnv: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  readonly readClaudeTraining: (
    pty: PtySpawner,
    target: ClaudeTerminalTarget,
  ) => Promise<TrainingRead>;
  readonly turnClaudeTrainingOff: (
    pty: PtySpawner,
    target: ClaudeTerminalTarget,
  ) => Promise<TrainingRead>;
  readonly useClaudeSessionReset: (
    pty: PtySpawner,
    target: ClaudeTerminalTarget,
  ) => Promise<{ readonly outcome: ResetOutcome; readonly message: string }>;
}

export interface PrivacyDeps {
  readonly stateDir: string;
  /** The host's `HostProcessPlatform`. */
  readonly platform: NodeJS.Platform;
  /** The environment the CLIs start from, before an instance's own variables. */
  readonly env: NodeJS.ProcessEnv;
  /** `~` expansion as the provider drivers do it (`expandHomePath`). */
  readonly expandHome: (path: string) => string;
  readonly getSettings: () => Promise<ServerSettings>;
  /** The environment Claude Code runs with for `homePath` (upstream's `makeClaudeEnvironment`). */
  readonly claudeEnvironment: (
    homePath: string,
    base: NodeJS.ProcessEnv,
  ) => Promise<NodeJS.ProcessEnv>;
  /** The executable a terminal runs for a configured `binary` (`resolveClaudeSdkExecutablePath`). */
  readonly claudeExecutable: (binary: string, env: NodeJS.ProcessEnv) => Promise<string>;
  readonly claudeTerminal: ClaudeTerminal;
  readonly pty: PtySpawner;
  /** The account email in an instance's provider snapshot, if it has one. */
  readonly providerEmail: (instanceId: string) => Promise<string | undefined>;
  /** Re-probes an instance with its caches invalidated, like Settings' refresh. */
  readonly refreshInstance: (instanceId: string) => Promise<void>;
  /**
   * Asks for the provider instances to be rebuilt from settings, so
   * `instanceOverlay` applies (or stops); resolves before the rebuild lands.
   */
  readonly reconcile: () => Promise<void>;
  readonly log: (message: string, cause?: unknown) => void;
}

type ClaudeEntry = Omit<ClaudeAccountPrivacy, "instanceId">;

interface PrivacyState {
  readonly keepTrainingOff: boolean;
  readonly claude: Readonly<Record<string, ClaudeEntry>>;
  readonly codexMarkedOff: Readonly<Record<string, string>>;
}

interface Job {
  readonly instanceId: string;
  readonly task: PrivacyTask;
  /** The sweep's check: turns training off when it reads "on". */
  readonly keepOff?: boolean;
}

const EMPTY: PrivacyState = { keepTrainingOff: false, claude: {}, codexMarkedOff: {} };

const privacyStatePath = (stateDir: string) => NodePath.join(stateDir, "pool-privacy.json");

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const configOf = (instance: ProviderInstanceConfig) =>
  isRecord(instance.config) ? instance.config : {};

/** A saved reset's outcome; files from before `unknown` existed say `used: boolean`. */
const readOutcome = (reset: Record<string, unknown>): ResetOutcome | undefined => {
  const { outcome, used } = reset;
  if (outcome === "used" || outcome === "notUsed" || outcome === "unknown") return outcome;
  if (typeof used === "boolean") return used ? "used" : "notUsed";
  return undefined;
};

const readEntry = (value: unknown): ClaudeEntry | undefined => {
  if (!isRecord(value)) return undefined;
  const training =
    value.training === "on" || value.training === "off" ? value.training : ("unknown" as const);
  const checkedAt = text(value.checkedAt);
  const message = text(value.message);
  const reset = isRecord(value.reset) ? value.reset : undefined;
  const outcome = reset && readOutcome(reset);
  return {
    training,
    ...(checkedAt ? { checkedAt } : {}),
    ...(message ? { message } : {}),
    ...(reset && text(reset.at) && outcome
      ? { reset: { at: text(reset.at), outcome, message: text(reset.message) } }
      : {}),
  };
};

/**
 * The state on disk: a missing file is the defaults, a damaged one (not JSON,
 * or not an object) `undefined`. A read that fails rejects.
 */
const readPrivacyState = async (path: string): Promise<PrivacyState | undefined> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await NodeFSP.readFile(path, "utf8"));
  } catch (error) {
    if (isMissing(error)) return EMPTY;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isRecord(raw)) return undefined;
  const claude: Record<string, ClaudeEntry> = {};
  for (const [id, value] of Object.entries(isRecord(raw.claude) ? raw.claude : {})) {
    const entry = readEntry(value);
    if (entry) claude[id] = entry;
  }
  const codexMarkedOff: Record<string, string> = {};
  for (const [email, at] of Object.entries(
    isRecord(raw.codexMarkedOff) ? raw.codexMarkedOff : {},
  )) {
    if (text(at)) codexMarkedOff[email.toLowerCase()] = text(at);
  }
  return { keepTrainingOff: raw.keepTrainingOff === true, claude, codexMarkedOff };
};

/** `environment` with `entries` set, each replacing a variable of its name. */
const withVariables = (
  environment: ProviderInstanceConfig["environment"],
  entries: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
) => [
  ...(environment ?? []).filter((entry) => !entries.some(({ name }) => name === entry.name)),
  ...entries,
];

/**
 * What keeping training off changes in how instances launch: Codex (not
 * managed) gets `CODEX_NO_FEEDBACK_ARG` after its own launch args (and after
 * `T3CODE_CODEX_LAUNCH_ARGS`, which `env` or the instance may set to replace
 * them), Claude `CLAUDE_NO_FEEDBACK_ENV`. Pure; never persisted.
 */
const keepTrainingOffOverlay = (
  map: ProviderInstanceConfigMap,
  env: NodeJS.ProcessEnv,
): ProviderInstanceConfigMap =>
  Object.fromEntries(
    Object.entries(map).map(([id, instance]) => {
      const config = configOf(instance);
      if (instance.driver === CODEX_DRIVER && config.setupMode !== "managed") {
        const own = text(config.launchArgs);
        // The instance's own variable wins over the server's (`mergeProviderInstanceEnvironment`).
        const variable = instance.environment?.find(({ name }) => name === CODEX_LAUNCH_ARGS_ENV);
        const override = text(variable ? variable.value : env[CODEX_LAUNCH_ARGS_ENV]);
        return [
          id,
          {
            ...instance,
            config: {
              ...config,
              launchArgs: [own, CODEX_NO_FEEDBACK_ARG].filter(Boolean).join(" "),
            },
            ...(override
              ? {
                  environment: withVariables(instance.environment, [
                    {
                      name: CODEX_LAUNCH_ARGS_ENV,
                      value: `${override} ${CODEX_NO_FEEDBACK_ARG}`,
                      sensitive: variable?.sensitive ?? false,
                    },
                  ]),
                }
              : {}),
          },
        ];
      }
      if (instance.driver === CLAUDE_DRIVER) {
        const environment = withVariables(
          instance.environment,
          Object.entries(CLAUDE_NO_FEEDBACK_ENV).map(([name, value]) => ({
            name,
            value,
            sensitive: false,
          })),
        );
        return [id, { ...instance, environment }];
      }
      return [id, instance];
    }),
  ) as ProviderInstanceConfigMap;

/** Whether `dir` or a folder above it holds a `.git` (a repository's dir, or a worktree's file). */
const insideGitRepository = async (dir: string) => {
  for (let at = dir; ; at = NodePath.dirname(at)) {
    const found = await NodeFSP.lstat(NodePath.join(at, ".git")).then(
      () => true,
      (error: unknown) => {
        if (isMissing(error)) return false;
        throw error;
      },
    );
    if (found) return true;
    if (NodePath.dirname(at) === at) return false;
  }
};

/** `instanceId`'s config as the registry derives it (default slots included). */
const instanceOf = (settings: ServerSettings, instanceId: string) =>
  Object.entries(deriveProviderInstanceConfigMap(settings)).find(([id]) => id === instanceId)?.[1];

/** The instances a status lists: every Claude one, the default slot included. */
const claudeInstances = (settings: ServerSettings) =>
  Object.entries(deriveProviderInstanceConfigMap(settings)).filter(
    ([, instance]) => instance.driver === CLAUDE_DRIVER,
  );

/** One terminal task at a time, server-wide; results land in `pool-privacy.json`. */
export class ClaudePrivacy {
  private readonly deps: PrivacyDeps;
  private readonly path: string;
  private state: PrivacyState = EMPTY;
  private loading: Promise<void> | undefined;
  /** Whether a read succeeded (or found the file damaged); until then nothing is saved. */
  private readable = false;
  /** `start` found the file unreadable: the first read that succeeds resumes it. */
  private resumeOnRead = false;
  private writes: Promise<void> = Promise.resolve();
  private readonly queue: Job[] = [];
  private running: Job | undefined;
  /** The running task, settled (`stop` waits for it). */
  private current: Promise<void> = Promise.resolve();
  /** `stop` ended the running task: it starts no other terminal. */
  private ending = false;
  private pumping = false;
  private draining: Promise<void> = Promise.resolve();
  private sweeping: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** What the running task's terminal spawned, for `close` and `stop`. */
  private readonly live = new Set<PtyLike>();
  private closed = false;

  constructor(deps: PrivacyDeps) {
    this.deps = deps;
    this.path = privacyStatePath(deps.stateDir);
  }

  /** Registered with the instance-overlay seam; reads the flag from memory. */
  readonly instanceOverlay = (map: ProviderInstanceConfigMap): ProviderInstanceConfigMap =>
    this.state.keepTrainingOff ? keepTrainingOffOverlay(map, this.deps.env) : map;

  /**
   * Reads the state once a read succeeds. A damaged file is logged and stands
   * for the defaults until the user changes something; a read that fails (no
   * permission, too many open files) is tried again by the next call.
   */
  load(): Promise<void> {
    this.loading ??= readPrivacyState(this.path).then(
      (state) => {
        if (state) this.state = state;
        else this.deps.log(`${this.path} is damaged; using the defaults`);
        this.readable = true;
        if (this.resumeOnRead) {
          this.resumeOnRead = false;
          void this.resume();
        }
      },
      (error: unknown) => {
        this.loading = undefined;
        this.deps.log(`Reading ${this.path} failed; reading it again next time`, error);
      },
    );
    return this.loading;
  }

  /**
   * Server start: with training kept off, rebuild the instances once so the
   * overlay (registered before this) applies, and sweep a minute later. An
   * unreadable file waits for the first read that succeeds. Never rejects.
   */
  async start() {
    await this.load();
    if (this.readable) await this.resume();
    else this.resumeOnRead = true;
  }

  private async resume() {
    if (!this.state.keepTrainingOff || this.closed) return;
    await this.deps
      .reconcile()
      .catch((error: unknown) => this.deps.log("Applying keep training off failed", error));
    this.schedule(BOOT_SWEEP_DELAY_MS);
  }

  status(settings: ServerSettings): PrivacyStatus {
    const running = this.running;
    return {
      keepTrainingOff: this.state.keepTrainingOff,
      claude: claudeInstances(settings).map(([instanceId]) => ({
        instanceId,
        ...(this.state.claude[instanceId] ?? { training: "unknown" }),
      })),
      codexMarkedOff: this.state.codexMarkedOff,
      ...(running ? { busy: { instanceId: running.instanceId, task: running.task } } : {}),
    };
  }

  /**
   * Turning it on rebuilds the instances (ending sessions running on them),
   * sweeps now and daily; off rebuilds them without the overlay and drops
   * queued sweep checks.
   */
  async setKeepOff(enabled: boolean) {
    await this.loadForChange();
    if (this.state.keepTrainingOff === enabled) return;
    this.state = { ...this.state, keepTrainingOff: enabled };
    await this.save();
    await this.deps
      .reconcile()
      .catch((error: unknown) => this.deps.log("Applying keep training off failed", error));
    // As it is now: another call may have flipped it back meanwhile.
    if (this.state.keepTrainingOff) {
      this.schedule(DAY_MS);
      this.sweeping = this.sweep();
    } else {
      clearTimeout(this.timer);
      this.drop((job) => job.keepOff === true);
    }
  }

  /** Queues `task` for a Claude account; a duplicate of one queued or running is ignored. */
  async enqueue(instanceId: string, task: PrivacyTask) {
    await this.loadForChange();
    this.claudeInstance(await this.deps.getSettings(), instanceId);
    this.push({ instanceId, task });
  }

  /** Records (or clears) the user's word that a Codex account is opted out in ChatGPT. */
  async markCodexOff(instanceId: string, off: boolean) {
    await this.loadForChange();
    const instance = instanceOf(await this.deps.getSettings(), instanceId);
    if (!instance) throw new Error("That account isn't in T3 anymore.");
    if (instance.driver !== CODEX_DRIVER) {
      throw new Error("Only Codex accounts can be marked here.");
    }
    const name = text(instance.displayName);
    const email = (
      text(await this.deps.providerEmail(instanceId)) || (EMAIL.test(name) ? name : "")
    ).toLowerCase();
    if (!email) throw new Error("T3 doesn't know this Codex account's email yet.");
    const { [email]: _previous, ...rest } = this.state.codexMarkedOff;
    this.state = {
      ...this.state,
      codexMarkedOff: off ? { ...rest, [email]: new Date().toISOString() } : rest,
    };
    await this.save();
  }

  /** A Claude account just signed in: check it now while training is kept off. */
  afterSignIn(instanceId: string) {
    if (!this.state.keepTrainingOff || this.closed) return;
    this.sweeping = this.sweep(instanceId);
  }

  /**
   * An account is being removed: its running task's terminal ends (resolves
   * once the task did) and its queued tasks go.
   */
  async stop(instanceId: string) {
    this.drop((job) => job.instanceId === instanceId);
    if (this.running?.instanceId !== instanceId) return;
    this.ending = true;
    for (const process of this.live) process.kill();
    await this.current;
  }

  /**
   * An account was removed: its queued tasks and its entry go (the entry
   * stays while the file can't be read; it lists no account).
   */
  async forget(instanceId: string) {
    await this.load();
    this.drop((job) => job.instanceId === instanceId);
    if (!this.readable || !(instanceId in this.state.claude)) return;
    const { [instanceId]: _removed, ...claude } = this.state.claude;
    this.state = { ...this.state, claude };
    await this.save();
  }

  /** Resolves once queued tasks ran and their results are on disk. */
  async idle() {
    await this.sweeping;
    await this.draining;
    await this.writes;
  }

  /** Server shutdown: no more tasks, no sweep, and the running task's terminal ends. */
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.queue.length = 0;
    for (const process of this.live) process.kill();
  }

  /** `load` before a change: refused while the file can't be read, so a save never overwrites it. */
  private async loadForChange() {
    await this.load();
    if (!this.readable) throw new Error(UNREADABLE);
  }

  /**
   * Queues a check of every enabled Claude account (`only`: that one, now)
   * that hasn't read "off" in the last `FRESH_MS`, so each daily sweep
   * checks every account; each turns training off if it reads "on".
   */
  private async sweep(only?: string) {
    try {
      const settings = await this.deps.getSettings();
      const now = Date.now();
      for (const [instanceId, instance] of claudeInstances(settings)) {
        if (!this.state.keepTrainingOff || this.closed) return;
        if (!resolveProviderInstanceEnabled(instance)) continue;
        if (only !== undefined && instanceId !== only) continue;
        const entry = this.state.claude[instanceId];
        const checkedAt = Date.parse(entry?.checkedAt ?? "");
        const fresh = entry?.training === "off" && now - checkedAt < FRESH_MS;
        if (only === undefined && fresh) continue;
        this.push({ instanceId, task: "check", keepOff: true });
      }
    } catch (error) {
      this.deps.log("Checking the Claude accounts' training setting failed", error);
    }
  }

  /** The next sweep in `delay`, then daily; none while training isn't kept off. */
  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (this.closed || !this.state.keepTrainingOff) return;
    this.timer = setTimeout(() => {
      this.sweeping = this.sweep();
      this.schedule(DAY_MS);
    }, delay);
    this.timer.unref();
  }

  /**
   * Queues `job` unless the same task for the account is queued or running
   * already (a double click never redeems a reset twice); a sweep's check
   * takes the place of a plain one still queued.
   */
  private push(job: Job) {
    if (this.closed) return;
    const same = (other: Job | undefined) =>
      other?.instanceId === job.instanceId && other.task === job.task;
    const covers = (other: Job | undefined) =>
      same(other) && (other?.keepOff === true || job.keepOff !== true);
    if (covers(this.running) || this.queue.some(covers)) return;
    const weaker = this.queue.findIndex(same);
    if (weaker >= 0) this.queue[weaker] = job;
    else this.queue.push(job);
    if (this.pumping) return;
    this.pumping = true;
    this.draining = (async () => {
      try {
        for (let next = this.queue.shift(); next; next = this.queue.shift()) {
          const { instanceId, task } = next;
          this.current = this.run(next).catch((error: unknown) =>
            this.deps.log(`The ${task} task for ${instanceId} failed`, error),
          );
          await this.current;
        }
      } finally {
        this.pumping = false;
      }
    })();
  }

  private drop(match: (job: Job) => boolean) {
    const kept = this.queue.filter((job) => !match(job));
    this.queue.splice(0, this.queue.length, ...kept);
  }

  private async run(job: Job) {
    this.running = job;
    this.ending = false;
    try {
      await (job.task === "reset" ? this.reset(job.instanceId) : this.training(job));
    } finally {
      this.running = undefined;
    }
  }

  /**
   * Uses the session reset. If Claude Code never started it wasn't used; if
   * the terminal failed midway T3 can't tell. A used one refreshes the
   * snapshot before the result is saved, whatever the save does.
   */
  private async reset(instanceId: string) {
    let result: { readonly outcome: ResetOutcome; readonly message: string };
    try {
      const target = await this.target(instanceId);
      result = await this.deps.claudeTerminal
        .useClaudeSessionReset(this.tracked(), target)
        .catch((error: unknown) => ({ outcome: "unknown" as const, message: messageOf(error) }));
    } catch (error) {
      result = { outcome: "notUsed", message: messageOf(error) };
    }
    // Its limits changed; the snapshot catches up on its own, the queue doesn't wait.
    if (result.outcome === "used") {
      void this.deps
        .refreshInstance(instanceId)
        .catch((error: unknown) => this.deps.log(`Refreshing ${instanceId} failed`, error));
    }
    const reset = { at: new Date().toISOString(), ...result };
    await this.record(instanceId, (entry) => ({ ...entry, reset }));
  }

  /** Reads (or turns off) training; a sweep's check that reads "on" turns it off. */
  private async training(job: Job) {
    const { instanceId } = job;
    let result: TrainingRead;
    try {
      const target = await this.target(instanceId);
      const { claudeTerminal } = this.deps;
      const pty = this.tracked();
      result =
        job.task === "check"
          ? await claudeTerminal.readClaudeTraining(pty, target)
          : await claudeTerminal.turnClaudeTrainingOff(pty, target);
      if (
        job.keepOff &&
        "training" in result &&
        result.training === "on" &&
        this.state.keepTrainingOff &&
        !this.closed &&
        !this.ending
      ) {
        await this.recordTraining(instanceId, result);
        this.running = { instanceId, task: "turnOff" };
        result = await claudeTerminal.turnClaudeTrainingOff(pty, target);
      }
    } catch (error) {
      result = { problem: messageOf(error) };
    }
    await this.recordTraining(instanceId, result);
  }

  /** A reading replaces the last one (and its problem); a problem keeps the last reading. */
  private recordTraining(instanceId: string, result: TrainingRead) {
    if ("problem" in result) {
      return this.record(instanceId, (entry) => ({ ...entry, message: result.problem }));
    }
    const checkedAt = new Date().toISOString();
    return this.record(instanceId, ({ message: _message, ...entry }) => ({
      ...entry,
      training: result.training,
      checkedAt,
    }));
  }

  /**
   * Changes the account's entry and saves; nothing once the server is
   * stopping, or for an account removed while its task ran. Never rejects: a
   * failed save is logged (`save`) and the result stands in memory.
   */
  private async record(instanceId: string, change: (entry: ClaudeEntry) => ClaudeEntry) {
    const exists = instanceOf(await this.deps.getSettings(), instanceId) !== undefined;
    if (this.closed || !exists) return;
    const entry = change(this.state.claude[instanceId] ?? { training: "unknown" });
    this.state = { ...this.state, claude: { ...this.state.claude, [instanceId]: entry } };
    await this.save().catch(() => undefined);
  }

  /**
   * Writes the state as it is when the write runs, after every earlier one;
   * refused until a read succeeded, so a failed read never loses what the
   * file holds.
   */
  private save() {
    if (!this.readable) return Promise.reject(new Error(UNREADABLE));
    const next = this.writes.then(() =>
      writeJsonFile(this.path, {
        version: 1,
        keepTrainingOff: this.state.keepTrainingOff,
        claude: this.state.claude,
        codexMarkedOff: this.state.codexMarkedOff,
      }),
    );
    this.writes = next.catch((error: unknown) =>
      this.deps.log(`Saving ${this.path} failed`, error),
    );
    return next;
  }

  /** A Claude instance a terminal may run for; refuses others with a message. */
  private claudeInstance(settings: ServerSettings, instanceId: string) {
    const instance = instanceOf(settings, instanceId);
    if (!instance) throw new Error("That account isn't in T3 anymore.");
    if (instance.driver !== CLAUDE_DRIVER)
      throw new Error("Only Claude accounts can do this here.");
    if (!resolveProviderInstanceEnabled(instance)) throw new Error("This account is turned off.");
    return instance;
  }

  /**
   * How the instance runs `claude`: its binary and environment as the driver
   * builds them (the default instance keeps CLAUDE_CONFIG_DIR unset), auth
   * overrides stripped, in `<stateDir>/claude-privacy` (Claude trusts a folder
   * by its real path, and with it the git repository the folder is in, so
   * never inside one).
   */
  private async target(instanceId: string): Promise<ClaudeTerminalTarget> {
    const instance = this.claudeInstance(await this.deps.getSettings(), instanceId);
    const config = configOf(instance);
    const base = signInEnv(mergeProviderInstanceEnvironment(instance.environment, this.deps.env));
    const env = this.deps.claudeTerminal.claudeTerminalEnv(
      await this.deps.claudeEnvironment(text(config.homePath), base),
    );
    const binary = await this.deps.claudeExecutable(
      this.deps.expandHome(text(config.binaryPath) || "claude"),
      env,
    );
    // A Windows terminal starts only a native executable, not an older npm install's script.
    if (this.deps.platform === "win32" && !/\.(?:exe|com)$/i.test(binary)) {
      throw new Error(
        "This Claude Code install can't run in a terminal here. Update Claude Code (claude update), then try again.",
      );
    }
    const dir = NodePath.join(this.deps.stateDir, "claude-privacy");
    await NodeFSP.mkdir(dir, { recursive: true });
    const cwd = await NodeFSP.realpath(dir);
    if (await insideGitRepository(cwd)) {
      throw new Error(
        "T3's Claude Code folder is inside a git repository, so Claude Code would trust the whole repository; T3 won't run it there.",
      );
    }
    const configDir = text(env.CLAUDE_CONFIG_DIR);
    if (configDir) await this.completeOnboarding(instanceId, NodePath.resolve(configDir));
    return { binary, env, cwd, platform: this.deps.platform };
  }

  /**
   * Claude Code's first run asks for a theme, then a login (which must never
   * be answered). An account dir T3 made is signed in already, so its
   * `.claude.json` gets `hasCompletedOnboarding` (and a theme if it has none),
   * every other key kept. Only while no Claude process uses the dir; never
   * the default config or a dir the user made.
   */
  private async completeOnboarding(instanceId: string, dir: string) {
    const home = NodePath.resolve(this.deps.expandHome("~"));
    const marked = await NodeFSP.access(NodePath.join(dir, CLAUDE_ACCOUNT_MARKER)).then(
      () => true,
      () => false,
    );
    if (!marked && !isPreviousReleaseDir(dir, home, instanceId)) return;
    const file = NodePath.join(dir, ".claude.json");
    let config: unknown;
    let mode: number;
    try {
      config = JSON.parse(await NodeFSP.readFile(file, "utf8"));
      mode = (await NodeFSP.stat(file)).mode & 0o777;
    } catch {
      // Missing (not signed in: Claude stops at its login either way) or mid-write.
      return;
    }
    if (!isRecord(config) || config.hasCompletedOnboarding === true) return;
    if (await claudeIsRunning(dir)) {
      this.deps.log(`Claude is running on ${dir}; left its .claude.json as it is`);
      return;
    }
    await writeJsonFile(
      file,
      { ...config, hasCompletedOnboarding: true, ...("theme" in config ? {} : { theme: "dark" }) },
      mode,
    );
  }

  /** The PTY spawner for one task, remembering what it spawned so `close` and `stop` can end it. */
  private tracked(): PtySpawner {
    return async (input) => {
      const process = await this.deps.pty(input);
      this.live.add(process);
      process.onExit(() => this.live.delete(process));
      if (this.closed || this.ending) process.kill();
      return process;
    };
  }
}
