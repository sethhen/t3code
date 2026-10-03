// @effect-diagnostics globalTimers:off globalDate:off - the terminal driver is plain async Node by design; Effect wraps it at the handler boundary.
/**
 * Drives the unmodified interactive `claude` in a terminal, typing what the
 * user would: `/privacy-settings` to read or turn off "Help improve our AI
 * models", `/limit-reset` to use the session limit reset. T3 only reads the
 * screen and presses keys; Claude Code does the work with its own login, so
 * T3 never sees a token.
 *
 * Claude Code draws with cursor moves (spaces between words are often
 * `CSI n C`), so a screen is matched on what it drew since the last key with
 * escapes and all whitespace removed. T3 acts only on a step it recognises,
 * once that output has matched the same step for `SETTLE_MS` with nothing new
 * drawn meanwhile (Claude Code ignores keys right after a dialog opens). The
 * matched screen stays in that output, so a dialog drawn over it afterwards
 * only delays the key; Claude Code itself holds unprompted dialogs back while
 * the user types or a command panel is open. Questions that are the user's to
 * answer (first-run setup, signing in, Claude's updated terms) are never
 * answered: the session just ends. Anything else ends it too, reporting what
 * Claude Code showed.
 */
import { stripAnsi } from "./cli.ts";
import type { PtyProcess, PtySpawnInput } from "./t3.ts";

export interface ClaudeTerminalTarget {
  readonly binary: string;
  /**
   * The account's environment, cleaned with `claudeTerminalEnv` here. A
   * separate account sets `CLAUDE_CONFIG_DIR`; the default one must leave it
   * unset (`~/.claude` spelled out names a different Keychain item).
   */
  readonly env: NodeJS.ProcessEnv;
  /** Where Claude Code starts; it asks once per (real) path whether to trust it. */
  readonly cwd: string;
  /** The host's `HostProcessPlatform`. */
  readonly platform: string;
}

/** The part of upstream's `PtyProcess` the driver uses (node-pty's, or a test's). */
export type PtyLike = Pick<PtyProcess, "pid" | "write" | "kill" | "onData" | "onExit">;

/** Upstream `PtyAdapter.spawn` as plain async code (node-pty in the server, pipes in tests). */
export type PtySpawner = (input: PtySpawnInput) => Promise<PtyLike>;

/** `fixed`: off for the account's email domain, which the user can't change. */
export type TrainingRead =
  | { readonly training: "on" | "off"; readonly fixed?: true }
  | { readonly problem: string };

export interface ClaudeTerminalTiming {
  /** Hard cap on one Claude Code session. */
  readonly sessionMs: number;
  /** How long an unrecognised screen may sit still before the session gives up. */
  readonly quietMs: number;
  /** How long Claude Code gets to save a changed setting (it doesn't wait for the save). */
  readonly saveMs: number;
  /**
   * Once Claude Code may be using a reset: how long it may sit still before it
   * answers. It shows static text while it reads its limits (up to 12s, twice)
   * and claims the reset (up to 35s).
   */
  readonly claimQuietMs: number;
  /** The cap on a session that may be using a reset, from its start. */
  readonly claimSessionMs: number;
}

const TIMING: ClaudeTerminalTiming = {
  sessionMs: 45_000,
  quietMs: 12_000,
  saveMs: 3_000,
  claimQuietMs: 60_000,
  claimSessionMs: 120_000,
};

const COLS = 120;
const ROWS = 40;
/** How often the screen is looked at while a session runs. */
const TICK_MS = 250;
/** How long a recognised screen must hold before T3 acts on it. */
const SETTLE_MS = 400;
/** The slash-command list needs a moment to catch up with typing. */
const TYPE_MS = 600;
/** How long Claude Code gets to exit after Ctrl-C twice. */
const EXIT_GRACE_MS = 1_500;

const ENTER = "\r";
const ESC = "\u001b";
const UP = "\u001b[A";
const DOWN = "\u001b[B";
const CTRL_C = "\u0003";

const CLAUDE_PRIVACY_URL = "https://claude.ai/settings/data-privacy-controls";
const NOT_OFFERED = `Claude Code only showed the claude.ai privacy link: the setting isn't offered for this account, or Claude Code couldn't load it just now. Check again, or open ${CLAUDE_PRIVACY_URL}.`;
const NO_PRIVACY_SETTINGS = "Claude Code doesn't offer /privacy-settings for this account";
const TERMS = `Claude asks you to review its updated terms for this account first: ${CLAUDE_PRIVACY_URL}`;
const SIGN_IN = "Claude Code wants to sign this account in again; sign it in again first";
const FIRST_RUN =
  "Claude Code hasn't finished its first-run setup for this account; run `claude` once in a terminal, then check again.";
const NO_RESET = "Claude Code doesn't offer a session reset for this account right now";
const STILL_CHECKING = "Claude Code was still checking for a reset when T3 stopped waiting";
const STILL_RESETTING = "Claude Code was still resetting when T3 stopped waiting";

/**
 * Variables that would make Claude Code use something other than its own
 * login, the retired pool's routing, and the markers of a Claude Code session
 * T3 may itself run in (Claude warns that transcript saving is off when it
 * inherits them).
 */
const STRIPPED_ENV = new Set([
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
]);
const STRIPPED_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_CODE_OAUTH_",
  "CLAUDE_CODE_USE_",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION",
  "T3_POOL_",
];

export const claudeTerminalEnv = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    const stripped =
      STRIPPED_ENV.has(name) || STRIPPED_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (!stripped) env[name] = value;
  }
  return { ...env, TERM: "xterm-256color" };
};

// eslint-disable-next-line no-control-regex
const CURSOR_FORWARD = /\u001b\[(\d*)C/g;
// eslint-disable-next-line no-control-regex
const CURSOR_COLUMN = /\u001b\[\d*G/g;
// eslint-disable-next-line no-control-regex
const CURSOR_ROW = /\u001b\[[\d;]*[ABEFHf]/g;
// eslint-disable-next-line no-control-regex
const LEFTOVER = /\u001b[\s\S]?|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Terminal output as text: cursor moves become the spaces and line breaks they stand for. */
const screenText = (output: string) =>
  stripAnsi(
    output
      .replace(CURSOR_FORWARD, (_, count: string) => " ".repeat(Math.min(Number(count || 1), COLS)))
      .replace(CURSOR_COLUMN, " ")
      .replace(CURSOR_ROW, "\n"),
  )
    .replace(/\r\n?/g, "\n")
    .replace(LEFTOVER, "");

const squash = (line: string) => line.replace(/\s+/g, " ").trim();

const finalLine = (text: string) =>
  text
    .split("\n")
    .map(squash)
    .findLast((line) => line.length > 0);

/**
 * What a command printed under its last `⎿`, with lines it wrapped onto
 * (indented, before the next blank line or the prompt box).
 */
const commandOutput = (text: string) => {
  const lines = text.split("\n");
  const at = lines.findLastIndex((line) => line.includes("⎿"));
  const first = lines[at];
  if (first === undefined) return undefined;
  const parts = [first.slice(first.indexOf("⎿") + 1)];
  for (const line of lines.slice(at + 1)) {
    if (!/^\s{2,}\S/.test(line) || /[─│╭╰❯⎿]/.test(line)) break;
    parts.push(line);
  }
  const output = squash(parts.join(" "));
  return output.length > 0 ? output : undefined;
};

const unknownScreen = (line: string) => `Claude Code showed a screen T3 doesn't know: ${line}`;

interface Screen {
  /** What Claude Code drew since the last key, as text. */
  readonly text: string;
  /** The same without any whitespace, which is what screens are matched on. */
  readonly flat: string;
}

/**
 * What to do about a screen: press a key (and maybe stop after it), finish,
 * stop, or wait while Claude Code works (`wait` is why the session ends if
 * nothing changes for the quiet window).
 */
type Step<T> =
  | { readonly key: string; readonly stop?: string }
  | { readonly done: T }
  | { readonly stop: string }
  | { readonly wait: string };

/** Ends a session early; its message is for the user. */
class Stop extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const within = (event: Promise<unknown>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise((resolve) => (timer = setTimeout(resolve, ms)));
  return Promise.race([event, cap]).finally(() => clearTimeout(timer));
};

/**
 * Ends Claude Code and whatever it started (MCP servers). node-pty's child
 * leads its own session and process group outside Windows, so the group goes;
 * on Windows node-pty ends every process on the console itself.
 */
const killTree = (terminal: PtyLike, pid: number, platform: string) => {
  if (platform !== "win32" && Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Not a group leader: end the process alone.
    }
  }
  try {
    terminal.kill("SIGKILL");
  } catch {
    // Gone already.
  }
};

/**
 * Up to the main prompt: trusts the folder and keeps browser tools off. The
 * first-run setup (the theme picker, the login method) and Claude's updated
 * terms are the user's to answer, so T3 stops there without a key.
 */
const startup = ({ flat }: Screen): Step<true> | undefined => {
  if (/Selectloginmethod/.test(flat)) return { stop: SIGN_IN };
  if (/Choosethetextstylethatlooksbestwithyourterminal/.test(flat)) return { stop: FIRST_RUN };
  if (/ConsumerTerms|\[ACTIONREQUIRED\]/.test(flat)) return { stop: TERMS };
  // "No, exit" is the default and Enter on it quits: move to "Yes" and see it highlighted first.
  if (/❯Yes,Itrustthisfolder/.test(flat)) return { key: ENTER };
  if (/❯No,exit/.test(flat)) return { key: DOWN };
  if (/❯No,keepbrowsertoolsoff/.test(flat)) return { key: ENTER };
  if (/\?forshortcuts|❯Try"|\/effort/.test(flat)) return { done: true };
  return undefined;
};

/** `/privacy-settings` printed only the claude.ai link instead of its dialog. */
const LINK_ONLY = "linkOnly";

/** `/privacy-settings`: the "Help improve our AI models" value, read once its frame is complete. */
const privacy = ({ flat }: Screen): Step<TrainingRead | typeof LINK_ONLY> | undefined => {
  if (/ConsumerTerms|\[ACTIONREQUIRED\]/.test(flat)) return { stop: TERMS };
  const value =
    /HelpimproveourAImodels(true|false)(\(foremailswithyourdomain\))?.*Esctocancel/.exec(flat);
  if (value?.[2] !== undefined) return { done: { training: "off", fixed: true } };
  if (value) return { done: { training: value[1] === "true" ? "on" : "off" } };
  // When the account doesn't get the setting, or Claude Code couldn't load it.
  if (/⎿Reviewandmanageyourprivacysettings/.test(flat)) return { done: LINK_ONLY };
  return undefined;
};

/** What came of `/limit-reset`: `unknown` when T3 can't tell whether Claude Code used the reset. */
export interface ResetOutcome {
  readonly outcome: "used" | "notUsed" | "unknown";
  readonly message: string;
}

/** Claude Code's answers that say it used the reset, and ones that say it didn't. */
const RESET_USED = /^(?:Session limit reset|Limits reset)\b/;
const RESET_NOT_USED =
  /isn't available|Reset kept|wasn't used|nothing was used|nothing changed|^No reset to use/;

/** Where on the whitespace-free screen Claude Code last drew any of `marks` (-1: nowhere). */
const lastAt = (flat: string, ...marks: ReadonlyArray<string>) =>
  Math.max(...marks.map((mark) => flat.lastIndexOf(mark)));

/** Claude Code's static progress text while it reads its limits and claims a reset. */
const resetWork = (flat: string): Step<never> | undefined => {
  const checking = lastAt(flat, "Checkingforareset");
  if (lastAt(flat, "Resettingyour") > checking) return { wait: STILL_RESETTING };
  if (checking >= 0) return { wait: STILL_CHECKING };
  return undefined;
};

/** Claude Code's answer under its last `⎿`, unless that is its progress text. */
const resetReply = (text: string) => {
  const output = commandOutput(text);
  return output !== undefined && resetWork(output.replace(/\s+/g, "")) === undefined
    ? output
    : undefined;
};

/** Once Claude Code may be using the reset: its answer, waiting while it works. */
const resetAnswer = ({ flat, text }: Screen): Step<string> | undefined => {
  const reply = resetReply(text);
  return reply !== undefined ? { done: reply } : resetWork(flat);
};

type LimitReset = { readonly answer: string } | { readonly confirm: string | undefined };

/**
 * Right after `/limit-reset`: as `resetAnswer`, or a confirm when that is what
 * Claude Code drew last, with the early-use warning it put on it, if any ("You
 * still have 40% of your session limit left — use your reset anyway?").
 */
const limitReset = (screen: Screen): Step<LimitReset> | undefined => {
  const reply = resetReply(screen.text);
  if (reply !== undefined) return { done: { answer: reply } };
  const confirm = lastAt(screen.flat, "Useyourreset?");
  if (confirm >= 0 && confirm > lastAt(screen.flat, "Checkingforareset", "Resettingyour")) {
    const warning = screen.text
      .split("\n")
      .map(squash)
      .findLast((line) => line.includes("use your reset anyway?"));
    return { done: { confirm: warning?.replace(/^[│\s]+|[│\s]+$/g, "") } };
  }
  return resetWork(screen.flat);
};

/**
 * The confirm: settles on a highlighted "Yes, use my reset", moving up to it
 * from "No, keep it". Anything else on it is escaped, never guessed at.
 */
const confirmYes = ({ flat, text }: Screen): Step<true> | undefined => {
  const yes = /❯Yes,usemyreset/.test(flat);
  const no = /❯No,keepit/.test(flat);
  if (yes && !no) return { done: true };
  if (no && !yes) return { key: UP };
  if (/Useyourreset\?/.test(flat)) {
    return { key: ESC, stop: unknownScreen(finalLine(text) ?? "(nothing)") };
  }
  return undefined;
};

/**
 * The user's outcome from Claude Code's answer, or from why T3 stopped:
 * nothing can have been used before a claim key, and after one only Claude
 * Code's known answers count.
 */
const resetOutcome = (
  answer: string | Stop,
  claimed: boolean,
  warning: string | undefined,
): ResetOutcome => {
  if (answer instanceof Stop && !claimed) return { outcome: "notUsed", message: answer.message };
  const said = (message: string) => (warning === undefined ? message : `${warning} ${message}`);
  if (typeof answer === "string" && RESET_USED.test(answer)) {
    return { outcome: "used", message: said(answer) };
  }
  if (typeof answer === "string" && RESET_NOT_USED.test(answer)) {
    return { outcome: "notUsed", message: said(answer) };
  }
  const why = (typeof answer === "string" ? answer : answer.message).replace(/[\s.]+$/, "");
  return {
    outcome: "unknown",
    message: said(
      `T3 couldn't tell whether Claude Code used the reset: ${why}. Check /usage in Claude Code.`,
    ),
  };
};

class ClaudeSession {
  private readonly terminal: PtyLike;
  private readonly pid: number;
  private readonly platform: string;
  private readonly timing: ClaudeTerminalTiming;
  private readonly started = Date.now();
  private deadline: number;
  private readonly exit: Promise<void>;
  private readonly stopListening: () => void;
  private output = "";
  /** Where the output stood at the last key. */
  private mark = 0;
  private lastChange = Date.now();
  private exited = false;

  constructor(terminal: PtyLike, platform: string, timing: ClaudeTerminalTiming) {
    this.terminal = terminal;
    this.pid = terminal.pid;
    this.platform = platform;
    this.timing = timing;
    this.deadline = this.started + timing.sessionMs;
    const stopData = terminal.onData((data) => {
      this.output += data;
      this.lastChange = Date.now();
    });
    let stopExit = () => {};
    this.exit = new Promise((resolve) => {
      stopExit = terminal.onExit(() => {
        this.exited = true;
        resolve();
      });
    });
    this.stopListening = () => {
      stopData();
      stopExit();
    };
  }

  press(key: string) {
    if (!this.exited) {
      try {
        this.terminal.write(key);
      } catch {
        // Exited meanwhile; the screen loop notices.
      }
    }
    this.mark = this.output.length;
    this.lastChange = Date.now();
  }

  /** Lets the session run until `ms` after it started, if that is later than its cap. */
  extendTo(ms: number) {
    this.deadline = Math.max(this.deadline, this.started + ms);
  }

  private screen(): Screen {
    const text = screenText(this.output.slice(this.mark));
    return { text, flat: text.replace(/\s+/g, "") };
  }

  /** The last line Claude Code drew, for a message. */
  private lastLine(screen: Screen) {
    return finalLine(screen.text) ?? finalLine(screenText(this.output)) ?? "(nothing)";
  }

  /**
   * Looks at what Claude Code drew since the last key until `look` settles on
   * a step (the same one for `SETTLE_MS`, with no new output meanwhile), and
   * takes it. Gives up past the session's cap, when Claude Code exits, or when
   * nothing changes for `quiet.ms` on a screen it doesn't act on.
   */
  async until<T>(
    look: (screen: Screen) => Step<T> | undefined,
    quiet?: { readonly ms: number; readonly stop?: string },
  ): Promise<T> {
    let held: { readonly id: string; readonly since: number } | undefined;
    for (;;) {
      await sleep(TICK_MS);
      const screen = this.screen();
      const step = look(screen);
      if (this.exited) {
        if (step !== undefined && "done" in step) return step.done;
        if (step !== undefined && "stop" in step && !("key" in step)) throw new Stop(step.stop);
        throw new Stop(`Claude Code closed: ${this.lastLine(screen)}`);
      }
      const now = Date.now();
      const id = step === undefined || "wait" in step ? undefined : stepId(step);
      // New output restarts the hold, so whatever Claude Code draws meanwhile settles too.
      if (id !== held?.id || (held !== undefined && this.lastChange > held.since)) {
        held = id === undefined ? undefined : { id, since: now };
      }
      if (
        step !== undefined &&
        !("wait" in step) &&
        held !== undefined &&
        now - held.since >= SETTLE_MS
      ) {
        if ("key" in step) {
          this.press(step.key);
          held = undefined;
          if (step.stop !== undefined) throw new Stop(step.stop);
          continue;
        }
        if ("done" in step) return step.done;
        throw new Stop(step.stop);
      }
      if (now >= this.deadline) throw new Stop("Claude Code didn't finish in time");
      // A step T3 acts on settles once the output holds still; only other screens time out.
      if (
        (step === undefined || "wait" in step) &&
        now - this.lastChange >= (quiet?.ms ?? this.timing.quietMs)
      ) {
        throw new Stop(step?.wait ?? quiet?.stop ?? unknownScreen(this.lastLine(screen)));
      }
    }
  }

  /**
   * Types a slash command and runs it, but only once the command list shows
   * `listed` (the command's own description): if the command isn't there,
   * Enter would run whichever command is highlighted instead.
   */
  async run(command: string, listed: RegExp, missing: string) {
    this.press(command);
    await sleep(TYPE_MS);
    await this.until(({ flat }) => (listed.test(flat) ? { done: true } : undefined), {
      ms: 2_000,
      stop: missing,
    });
    this.press(ENTER);
  }

  async readTraining(): Promise<TrainingRead> {
    await this.until(startup);
    const ask = async () => {
      await this.run("/privacy-settings", /Viewandupdateyourprivacysettings/, NO_PRIVACY_SETTINGS);
      return this.until(privacy);
    };
    const first = await ask();
    // Claude Code loads the setting again after a failed load: ask once more before reporting.
    const read = first === LINK_ONLY ? await ask() : first;
    if (read === LINK_ONLY) throw new Stop(NOT_OFFERED);
    return read;
  }

  /** Ctrl-C twice, as the user quits; then the process tree, if it's still there. */
  async end() {
    if (!this.exited) {
      // A key right behind an Esc would read as Alt+key.
      await sleep(200);
      this.press(CTRL_C);
      await sleep(200);
      this.press(CTRL_C);
      await within(this.exit, EXIT_GRACE_MS);
    }
    if (!this.exited) {
      killTree(this.terminal, this.pid, this.platform);
      await within(this.exit, 2_000);
    }
    this.stopListening();
  }
}

const stepId = (step: Exclude<Step<unknown>, { readonly wait: string }>) =>
  "key" in step
    ? `key:${step.key}:${step.stop ?? ""}`
    : "done" in step
      ? `done:${String(JSON.stringify(step.done))}`
      : `stop:${step.stop}`;

/** Runs `use` against a fresh Claude Code and always ends it; a `Stop` comes back as a value. */
const withClaude = async <T>(
  pty: PtySpawner,
  target: ClaudeTerminalTarget,
  timing: ClaudeTerminalTiming,
  use: (claude: ClaudeSession) => Promise<T>,
): Promise<T | Stop> => {
  let terminal: PtyLike;
  try {
    terminal = await pty({
      shell: target.binary,
      cwd: target.cwd,
      env: claudeTerminalEnv(target.env),
      cols: COLS,
      rows: ROWS,
    });
  } catch (error) {
    return new Stop(
      `Couldn't start Claude Code: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const claude = new ClaudeSession(terminal, target.platform, timing);
  try {
    return await use(claude);
  } catch (error) {
    if (error instanceof Stop) return error;
    throw error;
  } finally {
    await claude.end();
  }
};

/** Reads "Help improve our AI models" with Claude Code's `/privacy-settings`, changing nothing. */
export const readClaudeTraining = async (
  pty: PtySpawner,
  target: ClaudeTerminalTarget,
  timing: ClaudeTerminalTiming = TIMING,
): Promise<TrainingRead> => {
  const read = await withClaude(pty, target, timing, async (claude) => {
    const read = await claude.readTraining();
    claude.press(ESC);
    return read;
  });
  return read instanceof Stop ? { problem: read.message } : read;
};

/**
 * Turns "Help improve our AI models" off with Claude Code's `/privacy-settings`
 * (one toggle, only when it reads on), then reads it again in a fresh Claude
 * Code, since the dialog's own echo can be stale. Returns that final read.
 */
export const turnClaudeTrainingOff = async (
  pty: PtySpawner,
  target: ClaudeTerminalTarget,
  timing: ClaudeTerminalTiming = TIMING,
): Promise<TrainingRead> => {
  const first = await withClaude(pty, target, timing, async (claude) => {
    const read = await claude.readTraining();
    if (!("training" in read) || read.training === "off") {
      claude.press(ESC);
      return read;
    }
    claude.press(ENTER);
    await claude.until(({ flat }) => (flat.includes("false") ? { done: true } : undefined), {
      ms: 5_000,
      stop: "Claude Code didn't show the setting turning off",
    });
    // Claude Code saves the change without waiting for it: give the save time before quitting.
    await sleep(timing.saveMs);
    claude.press(ESC);
    return undefined;
  });
  if (first instanceof Stop) return { problem: first.message };
  if (first !== undefined) return first;
  const verify = await readClaudeTraining(pty, target, timing);
  if ("training" in verify && verify.training === "off") return verify;
  return readClaudeTraining(pty, target, timing);
};

/**
 * Uses the account's session limit reset with Claude Code's `/limit-reset`.
 * `message` is Claude Code's own answer (after the warning it put on its
 * confirm, if any), or why T3 couldn't get one.
 */
export const useClaudeSessionReset = async (
  pty: PtySpawner,
  target: ClaudeTerminalTarget,
  timing: ClaudeTerminalTiming = TIMING,
): Promise<ResetOutcome> => {
  // Whether a claim key went in: the `/limit-reset` Enter (Claude Code may reset
  // straight away), until its confirm shows; then the Enter on "Yes, use my reset".
  let claimed = false;
  let warning: string | undefined;
  const answer = await withClaude(pty, target, timing, async (claude) => {
    await claude.until(startup);
    await claude.run("/limit-reset", /Resetyoursessionlimitnow|Useanavailablelimitreset/, NO_RESET);
    claimed = true;
    claude.extendTo(timing.claimSessionMs);
    const quiet = { ms: timing.claimQuietMs };
    const first = await claude.until(limitReset, quiet);
    if ("answer" in first) return first.answer;
    claimed = false;
    await claude.until(confirmYes);
    warning = first.confirm;
    claude.press(ENTER);
    claimed = true;
    return claude.until(resetAnswer, quiet);
  });
  return resetOutcome(answer, claimed, warning);
};
