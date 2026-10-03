// @effect-diagnostics nodeBuiltinImport:off - drives a fake Claude Code over pipes in temp dirs.
/**
 * The terminal driver against a fake Claude Code: a node script that draws
 * the real screens the way Claude Code's renderer does (rows placed with
 * cursor moves, spaces as `CSI n C`, an OSC 8 link, frames split across
 * writes, changed rows redrawn alone), reacts to keys, and logs every key
 * with the screen it landed on. Its "account" is a state file, so a change
 * survives into the next process only if the fake lived to save it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, assert, describe, it } from "@effect/vitest";

import {
  type ClaudeTerminalTarget,
  type ClaudeTerminalTiming,
  type PtySpawner,
  claudeTerminalEnv,
  readClaudeTraining,
  turnClaudeTrainingOff,
  useClaudeSessionReset,
} from "./claudeTerminal.ts";
import { HostProcessPlatform } from "./t3.ts";

const FAKE_CLAUDE = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const config = JSON.parse(process.env.FAKE_TUI || "{}");
const log = (entry) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
const statePath = process.env.FAKE_STATE;
const saved = () =>
  fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")).training : config.training || "on";
log({
  event: "start",
  pid: process.pid,
  env: {
    TERM: process.env.TERM || null,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || null,
    CLAUDE_CODE_CHILD_SESSION: process.env.CLAUDE_CODE_CHILD_SESSION || null,
  },
});

const ESC = "\u001b";
const URL = "https://claude.ai/settings/data-privacy-controls";
// Spaces become cursor moves, rows are placed with them, as Claude Code's renderer draws.
const ink = (text) => text.replace(/ +/g, (gap) => ESC + "[" + gap.length + "C");
const at = (row, text) => ESC + "[" + row + ";1H" + ESC + "[2K" + ink(text);
const link = ESC + "]8;;" + URL + "\u0007" + URL + ESC + "]8;;\u0007";
// Every frame reaches the terminal in two writes, cut anywhere (even inside an escape).
let queue = Promise.resolve();
let lastOutput = Date.now();
const out = (frame) => {
  queue = queue.then(async () => {
    const cut = Math.floor(frame.length / 2);
    process.stdout.write(frame.slice(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.stdout.write(frame.slice(cut));
    lastOutput = Date.now();
  });
};
const paint = (rows) => out(ESC + "[2J" + rows.map((text, i) => at(i + 1, text)).join(""));

const DIALOGS = {
  trust: {
    rows: ["Accessing workspace:", "", process.cwd(), "", "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known", "open source project, or work from your team). If not, take a moment to review what's in this folder first."],
    options: ["No, exit", "Yes, I trust this folder"],
    guide: "Enter to confirm · Esc to cancel",
  },
  chrome: {
    rows: ["Claude in Chrome extension detected", "", "Let Claude use your browser for testing and automation?"],
    options: ["No, keep browser tools off", "Yes, use my browser"],
    guide: "Enter to confirm · Esc to cancel",
  },
  theme: {
    rows: ["Let's get started.", "", "Choose the text style that looks best with your terminal"],
    options: ["1. Dark mode", "2. Light mode"],
    guide: "",
  },
  login: {
    rows: ["Claude Code can be used with your Claude subscription or billed based on API usage.", "", "Select login method:"],
    options: ["1. Claude account with subscription · Pro, Max, Team, or Enterprise", "2. Anthropic Console account · API usage billing"],
    guide: "",
  },
  terms: {
    rows: ["An update to our Consumer Terms and Privacy Policy will take effect on October 8, 2025.", "", "Please select how you'd like to continue"],
    options: ["Accept terms · Help improve our AI models: ON", "Accept terms · Help improve our AI models: OFF"],
    guide: "Enter to confirm",
  },
  privacyTerms: {
    rows: ["Updates to Consumer Terms and Policies", "", "Please select how you'd like to continue"],
    options: ["Accept terms · Help improve our AI models: ON", "Accept terms · Help improve our AI models: OFF"],
    guide: "Enter to confirm · Esc to cancel",
  },
  mystery: { rows: ["Something new happened", "", "Press any key to continue"], options: [], guide: "" },
  confirm: {
    rows: ["Use your reset?", ...(config.warning ? [config.warning] : []), "Refills your session limit now · your weekly reset day stays Monday", "1 reset left · use by Oct 10"],
    options: config.options || ["Yes, use my reset", "No, keep it"],
    guide: "",
  },
};

let screen = "";
let options = [];
let selected = 0;
let firstOption = 0;
let openedAt = 0;
const optionRow = (i) =>
  at(firstOption + i, i === selected ? ESC + "[36m❯ " + options[i] + ESC + "[39m" : "  " + options[i]);
const open = (name) => {
  const dialog = DIALOGS[name];
  screen = name;
  options = dialog.options;
  selected = name === "confirm" ? config.focus || 0 : 0;
  firstOption = dialog.rows.length + 2;
  openedAt = Date.now();
  out(ESC + "[2J" + dialog.rows.map((text, i) => at(i + 1, text)).join("") + options.map((_, i) => optionRow(i)).join("") + at(firstOption + options.length + 1, dialog.guide));
  if (name === "chrome" && config.interrupt) setTimeout(survey, 100);
};
// An unprompted dialog drawn over the one just opened, a row every 100ms; it takes no keys.
const SURVEY = ["How is Claude doing this session? (optional)", "", "1: Bad", "2: Fine", "3: Good", "0: Dismiss", "", "Pick a number"];
const survey = () => {
  screen = "survey";
  out(ESC + "[2J");
  SURVEY.forEach((row, i) => setTimeout(() => out(at(i + 1, row)), 100 * (i + 1)));
};
const move = (by) => {
  const before = selected;
  selected = Math.max(0, Math.min(options.length - 1, selected + by));
  // Only the rows that changed are drawn again.
  out(optionRow(before) + optionRow(selected));
};

const startup = [...(config.before || [])];
const next = () => {
  const name = startup.shift();
  if (name) open(name);
  else prompt();
};

const COMMANDS = [
  ["/privacy-settings", "View and update your privacy settings"],
  ["/limit-reset", "Reset your session limit now and keep working; once a week, still counts toward your weekly limit"],
  ["/login", "Switch Anthropic accounts"],
].filter(([name]) => name !== "/limit-reset" || config.reset);
let buffer = "";
let lastCommand = "";
let armed = false;
const box = (text) => ["╭" + "─".repeat(60) + "╮", "│ " + text, "╰" + "─".repeat(60) + "╯"];
const suggestions = () => {
  const matches = COMMANDS.filter(([name]) => name.startsWith(buffer));
  // Like a fuzzy match: something is always offered.
  return matches.length > 0 ? matches : COMMANDS.filter(([name]) => name === "/login");
};
const prompt = (above = []) => {
  screen = "prompt";
  paint([...above, "", ...box("❯ Try \"fix lint errors\""), "  ? for shortcuts"]);
};
const printLine = (text) => prompt(["❯ " + lastCommand, "  " + text]);
const typed = () => {
  const rows = suggestions().map(([name, description], i) => (i === 0 ? "❯ " : "  ") + name + "      " + description);
  out(at(2, "│ ❯ " + buffer) + at(4, "") + rows.map((row, i) => at(5 + i, row)).join(""));
};

let value = "on";
let shown = "on";
let privacyRuns = 0;
const valueText = () =>
  value === "domain" ? ESC + "[31mfalse (for emails with your domain)" + ESC + "[39m" : value === "on" ? ESC + "[32mtrue" + ESC + "[39m " : ESC + "[31mfalse" + ESC + "[39m";
const privacySettings = () => {
  const mode = config.privacy || "dialog";
  privacyRuns += 1;
  // "url-once": the first load fails, as when Claude Code couldn't fetch the setting.
  if (mode === "url-only" || (mode === "url-once" && privacyRuns === 1)) return printLine("⎿  Review and manage your privacy settings at " + link);
  if (mode === "terms") return open("privacyTerms");
  screen = "privacy";
  value = mode === "domain" ? "domain" : saved();
  shown = value;
  const guide = value === "domain" ? "Esc to cancel" : "Enter/Tab/Space to toggle · Esc to cancel";
  paint(["Data privacy", "", "Review and manage your privacy settings at " + link, "", "Help improve our AI models                  " + valueText(), "", guide]);
};
const privacyKey = (key) => {
  if (key === "esc") return printLine("⎿  \"Help improve our AI models\" set to " + (shown === "on" ? "true" : "false") + ".");
  if (key !== "enter" && key !== "tab" && key !== " ") return;
  if (value === "domain") return log({ event: "toggle-ignored" });
  value = value === "on" ? "off" : "on";
  const to = value;
  log({ event: "toggle", to });
  out(ESC + "[5;45H" + valueText());
  // Like Claude Code, the change is sent without waiting; it lands only if the process lives on.
  setTimeout(() => {
    if (config.persist !== false) fs.writeFileSync(statePath, JSON.stringify({ training: to }));
    log({ event: "saved", to });
  }, 2000);
};

const KEPT = "⎿  Reset kept · run /limit-reset at a limit to use it · use by Oct 10";
// Claude Code shows static text while it claims, then answers: config.answer replaces the
// answer, null never gives one, "exit" quits instead; config.delay is how long it takes.
const claim = (rows, answer) => {
  log({ event: "reset-used" });
  screen = "resetting";
  paint(rows);
  const said = config.answer === undefined ? answer : config.answer;
  if (said === null) return;
  setTimeout(() => (said === "exit" ? process.exit(0) : printLine("⎿  " + said)), config.delay || 300);
};
const limitReset = () => {
  screen = "checking";
  paint(["Checking for a reset…", "", "This takes a moment", "Esc to cancel"]);
  setTimeout(() => {
    if (config.reset === "unavailable") return printLine("⎿  A session-limit reset isn't available right now.");
    if (config.reset === "session") {
      return claim(["Resetting your session limit… this usually takes a few seconds"], "Session limit reset · next reset available Oct 10 · your weekly limit still applies");
    }
    open("confirm");
  }, 150);
};
const confirmKey = (key) => {
  // Claude Code ignores keys for 250ms after the confirm opens; a little longer here, for margin.
  if (Date.now() - openedAt < 350) return log({ event: "refused", key });
  if (key === "up") return move(-1);
  if (key === "down") return move(1);
  if (key === "esc") {
    log({ event: "escaped" });
    return printLine(KEPT);
  }
  if (key !== "enter") return;
  const option = options[selected];
  if (option === "No, keep it") {
    log({ event: "reset-kept" });
    return printLine(KEPT);
  }
  if (option !== "Yes, use my reset") return log({ event: "answered", screen, option });
  claim(["Use your reset?", "", "Resetting your limits… this usually takes a few seconds"], "Limits reset · your weekly reset day stays Monday · no resets left");
};

const choose = (key) => {
  if (key === "up") return move(-1);
  if (key === "down") return move(1);
  if (key !== "enter") return;
  if (screen === "trust" && selected === 0) {
    log({ event: "trust-exit" });
    process.exit(1);
  }
  if (screen === "trust") log({ event: "trusted" });
  if (screen === "chrome" && selected === 1) log({ event: "chrome-enabled" });
  next();
};

const promptKey = (key) => {
  if (key === "enter") {
    const command = COMMANDS.some(([name]) => name === buffer) ? buffer : suggestions()[0][0];
    log({ event: "ran", command });
    lastCommand = command;
    buffer = "";
    if (command === "/privacy-settings") return privacySettings();
    if (command === "/limit-reset") return limitReset();
    return printLine("⎿  Ran " + command);
  }
  if (key.length === 1) {
    buffer += key;
    typed();
  }
};

const ctrlC = () => {
  if (screen === "privacy" || screen === "confirm" || screen === "privacyTerms") return prompt();
  if (screen !== "prompt") process.exit(0);
  if (buffer) {
    buffer = "";
    return prompt();
  }
  if (armed) process.exit(0);
  armed = true;
  setTimeout(() => (armed = false), 1000);
  out(at(20, "Press Ctrl-C again to exit"));
};

const NAMED = { "\r": "enter", "\t": "tab", "\u0003": "ctrl-c" };
process.stdin.on("data", (chunk) => {
  let input = String(chunk);
  while (input.length > 0) {
    let key = NAMED[input[0]] || input[0];
    let size = 1;
    if (input.startsWith(ESC + "[A")) [key, size] = ["up", 3];
    else if (input.startsWith(ESC + "[B")) [key, size] = ["down", 3];
    else if (input[0] === ESC) key = "esc";
    input = input.slice(size);
    if (config.hang) continue;
    if (screen !== "prompt" || key.length > 1) log({ event: "key", screen, key, quiet: Date.now() - lastOutput });
    if (key === "ctrl-c") ctrlC();
    else if (screen === "trust" || screen === "chrome" || screen === "theme") choose(key);
    else if (screen === "login" || screen === "terms" || screen === "privacyTerms" || screen === "mystery") log({ event: "answered", screen, key });
    else if (screen === "privacy") privacyKey(key);
    else if (screen === "confirm") confirmKey(key);
    else if (screen === "prompt") promptKey(key);
  }
});

if (config.hang) {
  // Deaf to everything but SIGKILL, with a child of its own and a spinner that never stops.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => log({ event: "signal", signal }));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
  log({ event: "grandchild", pid: child.pid });
  let frame = 0;
  setInterval(() => process.stdout.write(at(1, "⠋⠙⠹⠸"[frame++ % 4] + " Starting…")), 100);
} else {
  next();
}
`;

interface FakeConfig {
  readonly before?: ReadonlyArray<string>;
  readonly training?: "on" | "off";
  readonly privacy?: "dialog" | "domain" | "url-only" | "url-once" | "terms";
  readonly persist?: boolean;
  readonly reset?: "unavailable" | "session" | "confirm";
  readonly options?: ReadonlyArray<string>;
  readonly focus?: number;
  /** Claude Code's early-use warning on the confirm. */
  readonly warning?: string;
  /** What Claude Code answers after a claim (null: nothing; "exit": it quits) and after how long. */
  readonly answer?: string | null;
  readonly delay?: number;
  /** An unprompted dialog drawn over the Chrome offer right after it opens. */
  readonly interrupt?: boolean;
  readonly hang?: boolean;
}

interface FakeEvent {
  readonly event: string;
  readonly screen?: string;
  readonly key?: string;
  /** For a key: how long the fake's screen had been still when it arrived. */
  readonly quiet?: number;
  readonly command?: string;
  readonly env?: Record<string, string | null>;
}

const PLATFORM = HostProcessPlatform.defaultValue();
const SIGN_IN = "Claude Code wants to sign this account in again; sign it in again first";
const TERMS =
  "Claude asks you to review its updated terms for this account first: https://claude.ai/settings/data-privacy-controls";
const NOT_OFFERED =
  "Claude Code only showed the claude.ai privacy link: the setting isn't offered for this account, or Claude Code couldn't load it just now. Check again, or open https://claude.ai/settings/data-privacy-controls.";
/** `SETTLE_MS` in the driver. */
const SETTLE_MS = 400;

const timing = (overrides: Partial<ClaudeTerminalTiming>): ClaudeTerminalTiming => ({
  sessionMs: 45_000,
  quietMs: 12_000,
  saveMs: 3_000,
  claimQuietMs: 60_000,
  claimSessionMs: 120_000,
  ...overrides,
});

const dirs: Array<string> = [];
// Tests run concurrently, so the temp dirs go once they're all done.
afterAll(() => {
  for (const dir of dirs) NodeFS.rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake Claude Code for one test, and a spawner that runs it over pipes as
 * its own process group (as node-pty's child leads its own session).
 * `closed` settles once a process and everything holding its output is gone.
 */
const fakeClaude = (config: FakeConfig, env: NodeJS.ProcessEnv = {}) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-terminal-"));
  dirs.push(dir);
  const script = NodePath.join(dir, "claude.cjs");
  const logPath = NodePath.join(dir, "log.jsonl");
  NodeFS.writeFileSync(script, FAKE_CLAUDE);
  NodeFS.writeFileSync(logPath, "");
  const closed: Array<Promise<void>> = [];
  const pty: PtySpawner = async (input) => {
    const child = NodeChildProcess.spawn(process.execPath, [input.shell, ...(input.args ?? [])], {
      cwd: input.cwd,
      env: input.env,
      stdio: "pipe",
      detached: true,
    });
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    closed.push(new Promise((resolve) => child.once("close", () => resolve())));
    const exited = new Promise<number>((resolve) =>
      child.once("exit", (code) => resolve(code ?? 1)),
    );
    return {
      pid: child.pid ?? 0,
      write: (data) => void child.stdin.write(data),
      kill: (signal) => void child.kill(signal as NodeJS.Signals | undefined),
      onData: (callback) => {
        child.stdout.on("data", callback);
        return () => child.stdout.off("data", callback);
      },
      onExit: (callback) => {
        let listening = true;
        void exited.then((exitCode) => listening && callback({ exitCode, signal: null }));
        return () => (listening = false);
      },
    };
  };
  const target: ClaudeTerminalTarget = {
    binary: script,
    cwd: dir,
    platform: PLATFORM,
    env: {
      ...process.env,
      ...env,
      FAKE_TUI: JSON.stringify(config),
      FAKE_LOG: logPath,
      FAKE_STATE: NodePath.join(dir, "state.json"),
    },
  };
  const events = (): ReadonlyArray<FakeEvent> =>
    NodeFS.readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FakeEvent);
  const keysOn = (screen: string) =>
    events()
      .filter((entry) => entry.event === "key" && entry.screen === screen)
      .map((entry) => entry.key);
  const count = (event: string) => events().filter((entry) => entry.event === event).length;
  /** Every Claude Code the test started has exited, with nothing left holding its output. */
  const allGone = () => Promise.all(closed);
  return { pty, target, events, keysOn, count, allGone, state: NodePath.join(dir, "state.json") };
};

const ran = (fake: ReturnType<typeof fakeClaude>) =>
  fake
    .events()
    .filter((entry) => entry.event === "ran")
    .map((entry) => entry.command);

describe("claudeTerminalEnv", () => {
  it("drops what would bypass Claude Code's own login or mark a nested session, and sets TERM", () => {
    const env = claudeTerminalEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
      T3_POOL_URL: "http://127.0.0.1:8317",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
      TERM: "dumb",
    });
    assert.deepStrictEqual(env, {
      PATH: "/usr/bin",
      HOME: "/home/me",
      CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
      TERM: "xterm-256color",
    });
  });
});

describe.concurrent("reading the training setting", () => {
  it(
    "reads it from the main prompt with a clean environment, and quits",
    { timeout: 20_000 },
    async () => {
      const fake = fakeClaude(
        { training: "off" },
        {
          CLAUDE_CONFIG_DIR: "/tmp/claude-work",
          ANTHROPIC_API_KEY: "sk-ant",
          CLAUDE_CODE_CHILD_SESSION: "1",
        },
      );
      assert.deepStrictEqual(await readClaudeTraining(fake.pty, fake.target), { training: "off" });
      await fake.allGone();
      const [start] = fake.events();
      assert.deepStrictEqual(start?.env, {
        TERM: "xterm-256color",
        CLAUDE_CONFIG_DIR: "/tmp/claude-work",
        ANTHROPIC_API_KEY: null,
        CLAUDE_CODE_CHILD_SESSION: null,
      });
      assert.deepStrictEqual(ran(fake), ["/privacy-settings"]);
      // Esc closed the dialog without a toggle.
      assert.deepStrictEqual(fake.keysOn("privacy"), ["esc"]);
    },
  );

  it(
    'trusts the folder by moving off the default "No, exit" first',
    { timeout: 20_000 },
    async () => {
      const fake = fakeClaude({ before: ["trust"], training: "on" });
      assert.deepStrictEqual(await readClaudeTraining(fake.pty, fake.target), { training: "on" });
      await fake.allGone();
      assert.deepStrictEqual(fake.keysOn("trust"), ["down", "enter"]);
      assert.strictEqual(fake.count("trusted"), 1);
      assert.strictEqual(fake.count("trust-exit"), 0);
    },
  );

  it("keeps browser tools off when Claude in Chrome is offered", { timeout: 20_000 }, async () => {
    const fake = fakeClaude({ before: ["trust", "chrome"], training: "off" });
    assert.deepStrictEqual(await readClaudeTraining(fake.pty, fake.target), { training: "off" });
    await fake.allGone();
    assert.deepStrictEqual(fake.keysOn("chrome"), ["enter"]);
    assert.strictEqual(fake.count("chrome-enabled"), 0);
  });

  it("stops at the login method and never answers it", { timeout: 20_000 }, async () => {
    const fake = fakeClaude({ before: ["login"] });
    assert.deepStrictEqual(await readClaudeTraining(fake.pty, fake.target), { problem: SIGN_IN });
    await fake.allGone();
    assert.deepStrictEqual(fake.keysOn("login"), ["ctrl-c"]);
    assert.strictEqual(fake.count("answered"), 0);
  });

  it(
    "stops at the theme picker of an unfinished first run without a key",
    { timeout: 20_000 },
    async () => {
      const fake = fakeClaude({ before: ["theme", "login"] });
      assert.deepStrictEqual(await readClaudeTraining(fake.pty, fake.target), {
        problem:
          "Claude Code hasn't finished its first-run setup for this account; run `claude` once in a terminal, then check again.",
      });
      await fake.allGone();
      // Only the Ctrl-C that quits; Enter would have picked a theme and moved on to signing in.
      assert.deepStrictEqual(fake.keysOn("theme"), ["ctrl-c"]);
      assert.deepStrictEqual(fake.keysOn("login"), []);
    },
  );

  it(
    "stops at Claude's updated terms on startup without answering them",
    { timeout: 20_000 },
    async () => {
      const fake = fakeClaude({ before: ["terms"] });
      assert.deepStrictEqual(await readClaudeTraining(fake.pty, fake.target), { problem: TERMS });
      await fake.allGone();
      assert.deepStrictEqual(fake.keysOn("terms"), ["ctrl-c"]);
      assert.strictEqual(fake.count("answered"), 0);
    },
  );

  it(
    "stops at the terms /privacy-settings asks for without answering them",
    { timeout: 20_000 },
    async () => {
      const fake = fakeClaude({ privacy: "terms" });
      assert.deepStrictEqual(await readClaudeTraining(fake.pty, fake.target), { problem: TERMS });
      await fake.allGone();
      assert.isTrue(fake.keysOn("privacyTerms").every((key) => key === "ctrl-c"));
      assert.strictEqual(fake.count("answered"), 0);
    },
  );

  it("reads the email-domain variant as off and fixed", { timeout: 20_000 }, async () => {
    const fake = fakeClaude({ privacy: "domain" });
    assert.deepStrictEqual(await readClaudeTraining(fake.pty, fake.target), {
      training: "off",
      fixed: true,
    });
    await fake.allGone();
  });

  it(
    "asks again in the same Claude Code before saying it only printed the link",
    { timeout: 20_000 },
    async () => {
      const fake = fakeClaude({ privacy: "url-only" });
      assert.deepStrictEqual(await readClaudeTraining(fake.pty, fake.target), {
        problem: NOT_OFFERED,
      });
      await fake.allGone();
      assert.deepStrictEqual(ran(fake), ["/privacy-settings", "/privacy-settings"]);
      assert.strictEqual(fake.count("start"), 1);
    },
  );

  it("reads the setting when the second ask loads it", { timeout: 20_000 }, async () => {
    const fake = fakeClaude({ privacy: "url-once", training: "off" });
    assert.deepStrictEqual(await readClaudeTraining(fake.pty, fake.target), { training: "off" });
    await fake.allGone();
    assert.deepStrictEqual(ran(fake), ["/privacy-settings", "/privacy-settings"]);
  });

  it(
    "reports a screen it doesn't know, with its last line, and presses nothing",
    { timeout: 20_000 },
    async () => {
      const fake = fakeClaude({ before: ["mystery"] });
      assert.deepStrictEqual(
        await readClaudeTraining(fake.pty, fake.target, timing({ quietMs: 1_000 })),
        {
          problem: "Claude Code showed a screen T3 doesn't know: Press any key to continue",
        },
      );
      await fake.allGone();
      assert.strictEqual(fake.count("answered"), 0);
    },
  );

  it(
    "ends a Claude Code that outlives the cap, and everything it started",
    { timeout: 20_000 },
    async () => {
      const fake = fakeClaude({ hang: true });
      assert.deepStrictEqual(
        await readClaudeTraining(fake.pty, fake.target, timing({ sessionMs: 1_500 })),
        { problem: "Claude Code didn't finish in time" },
      );
      // Resolves only once the fake and its child, which shares its output, are both gone.
      await fake.allGone();
      assert.strictEqual(fake.count("grandchild"), 1);
    },
  );

  it(
    "holds a key until a dialog drawn over the matched one has been still for the settle time",
    { timeout: 20_000 },
    async () => {
      // A survey starts drawing 100ms after the Chrome offer opens and keeps drawing for 800ms,
      // inside the time T3 holds the offer's Enter. That output still holds the offer T3
      // matched, so the Enter does land on the survey, only later: this proves the hold
      // restarts on new output, not that T3 tells the dialogs apart.
      const fake = fakeClaude({ before: ["chrome"], interrupt: true });
      assert.deepStrictEqual(
        await readClaudeTraining(fake.pty, fake.target, timing({ quietMs: 1_000 })),
        { problem: "Claude Code showed a screen T3 doesn't know: Pick a number" },
      );
      await fake.allGone();
      const keys = fake.events().filter((entry) => entry.event === "key");
      assert.deepStrictEqual(
        keys.map((entry) => [entry.screen, entry.key]),
        [
          ["survey", "enter"],
          ["survey", "ctrl-c"],
        ],
      );
      assert.isAtLeast(keys[0]?.quiet ?? 0, SETTLE_MS);
    },
  );
});

describe.concurrent("turning training off", () => {
  it(
    "toggles once, lets the change save, and confirms it in a fresh Claude Code",
    { timeout: 30_000 },
    async () => {
      const fake = fakeClaude({ training: "on" });
      assert.deepStrictEqual(await turnClaudeTrainingOff(fake.pty, fake.target), {
        training: "off",
      });
      await fake.allGone();
      assert.strictEqual(fake.count("toggle"), 1);
      assert.strictEqual(fake.count("saved"), 1);
      assert.strictEqual(fake.count("start"), 2);
      assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(fake.state, "utf8")), {
        training: "off",
      });
    },
  );

  it(
    "returns the fresh read when the change didn't stick, without toggling again",
    { timeout: 30_000 },
    async () => {
      const fake = fakeClaude({ training: "on", persist: false });
      assert.deepStrictEqual(await turnClaudeTrainingOff(fake.pty, fake.target), {
        training: "on",
      });
      await fake.allGone();
      assert.strictEqual(fake.count("toggle"), 1);
      // The toggle's own process, the check, and its one retry.
      assert.strictEqual(fake.count("start"), 3);
    },
  );

  it("changes nothing when it's off already", { timeout: 20_000 }, async () => {
    const fake = fakeClaude({ training: "off" });
    assert.deepStrictEqual(await turnClaudeTrainingOff(fake.pty, fake.target), { training: "off" });
    await fake.allGone();
    assert.strictEqual(fake.count("toggle"), 0);
    assert.strictEqual(fake.count("start"), 1);
  });
});

const unknownReset = (said: string) =>
  `T3 couldn't tell whether Claude Code used the reset: ${said}. Check /usage in Claude Code.`;

describe.concurrent("using the session reset", () => {
  it("passes on Claude Code's answer when no reset is available", { timeout: 20_000 }, async () => {
    const fake = fakeClaude({ reset: "unavailable" });
    assert.deepStrictEqual(await useClaudeSessionReset(fake.pty, fake.target), {
      outcome: "notUsed",
      message: "A session-limit reset isn't available right now.",
    });
    await fake.allGone();
  });

  it("reports a session reset Claude Code used straight away", { timeout: 20_000 }, async () => {
    const fake = fakeClaude({ reset: "session" });
    assert.deepStrictEqual(await useClaudeSessionReset(fake.pty, fake.target), {
      outcome: "used",
      message:
        "Session limit reset · next reset available Oct 10 · your weekly limit still applies",
    });
    await fake.allGone();
  });

  it(
    "reports a reset Claude Code says it didn't use after going straight to it",
    { timeout: 20_000 },
    async () => {
      const answer =
        "Another reset was just started on your account · this one wasn't used · try again in a minute";
      const fake = fakeClaude({ reset: "session", answer });
      assert.deepStrictEqual(await useClaudeSessionReset(fake.pty, fake.target), {
        outcome: "notUsed",
        message: answer,
      });
      await fake.allGone();
    },
  );

  it(
    "waits out a long claim, past the quiet window and the session cap that apply before it",
    { timeout: 30_000 },
    async () => {
      const fake = fakeClaude({ reset: "confirm", delay: 6_000 });
      const slow = timing({
        sessionMs: 5_000,
        quietMs: 1_000,
        claimQuietMs: 10_000,
        claimSessionMs: 20_000,
      });
      assert.deepStrictEqual(await useClaudeSessionReset(fake.pty, fake.target, slow), {
        outcome: "used",
        message: "Limits reset · your weekly reset day stays Monday · no resets left",
      });
      await fake.allGone();
    },
  );

  it(
    "can't tell when Claude Code is still resetting once the quiet window runs out",
    { timeout: 20_000 },
    async () => {
      const fake = fakeClaude({ reset: "session", answer: null });
      const outcome = await useClaudeSessionReset(
        fake.pty,
        fake.target,
        timing({ claimQuietMs: 1_500 }),
      );
      await fake.allGone();
      assert.deepStrictEqual(outcome, {
        outcome: "unknown",
        message: unknownReset("Claude Code was still resetting when T3 stopped waiting"),
      });
    },
  );

  it("can't tell when Claude Code closes after the claim", { timeout: 20_000 }, async () => {
    const fake = fakeClaude({ reset: "confirm", answer: "exit" });
    const outcome = await useClaudeSessionReset(fake.pty, fake.target);
    await fake.allGone();
    assert.deepStrictEqual(outcome, {
      outcome: "unknown",
      message: unknownReset(
        "Claude Code closed: Resetting your limits… this usually takes a few seconds",
      ),
    });
    assert.strictEqual(fake.count("reset-used"), 1);
  });

  it("can't tell from an answer it doesn't know", { timeout: 20_000 }, async () => {
    const fake = fakeClaude({
      reset: "confirm",
      answer: "Couldn't confirm the reset went through · check /usage in a moment.",
    });
    assert.deepStrictEqual(await useClaudeSessionReset(fake.pty, fake.target), {
      outcome: "unknown",
      message: unknownReset("Couldn't confirm the reset went through · check /usage in a moment"),
    });
    await fake.allGone();
  });

  it(
    "confirms over Claude Code's early-use warning and passes the warning on",
    { timeout: 20_000 },
    async () => {
      const warning = "You still have 40% of your session limit left — use your reset anyway?";
      const fake = fakeClaude({ reset: "confirm", warning, focus: 1 });
      assert.deepStrictEqual(await useClaudeSessionReset(fake.pty, fake.target), {
        outcome: "used",
        message: `${warning} Limits reset · your weekly reset day stays Monday · no resets left`,
      });
      await fake.allGone();
      assert.deepStrictEqual(fake.keysOn("confirm"), ["up", "enter"]);
      assert.strictEqual(fake.count("reset-used"), 1);
    },
  );

  it(
    'confirms a highlighted "Yes, use my reset" once the confirm accepts keys',
    { timeout: 20_000 },
    async () => {
      const fake = fakeClaude({ reset: "confirm" });
      assert.deepStrictEqual(await useClaudeSessionReset(fake.pty, fake.target), {
        outcome: "used",
        message: "Limits reset · your weekly reset day stays Monday · no resets left",
      });
      await fake.allGone();
      assert.deepStrictEqual(fake.keysOn("confirm"), ["enter"]);
      assert.strictEqual(fake.count("refused"), 0);
      assert.strictEqual(fake.count("reset-used"), 1);
    },
  );

  it('moves to "Yes" and sees it highlighted before confirming', { timeout: 20_000 }, async () => {
    const fake = fakeClaude({ reset: "confirm", focus: 1 });
    const outcome = await useClaudeSessionReset(fake.pty, fake.target);
    await fake.allGone();
    assert.strictEqual(outcome.outcome, "used");
    assert.deepStrictEqual(fake.keysOn("confirm"), ["up", "enter"]);
    assert.strictEqual(fake.count("reset-kept"), 0);
  });

  it("escapes a confirm it doesn't know instead of guessing", { timeout: 20_000 }, async () => {
    const fake = fakeClaude({ reset: "confirm", options: ["Use 2 resets", "Cancel"] });
    const outcome = await useClaudeSessionReset(fake.pty, fake.target);
    await fake.allGone();
    assert.strictEqual(outcome.outcome, "notUsed");
    assert.match(outcome.message, /^Claude Code showed a screen T3 doesn't know: /);
    assert.deepStrictEqual(fake.keysOn("confirm"), ["esc"]);
    assert.strictEqual(fake.count("answered"), 0);
    assert.strictEqual(fake.count("reset-used"), 0);
  });

  it(
    "never presses Enter when /limit-reset isn't in the command list",
    { timeout: 20_000 },
    async () => {
      const fake = fakeClaude({});
      assert.deepStrictEqual(await useClaudeSessionReset(fake.pty, fake.target), {
        outcome: "notUsed",
        message: "Claude Code doesn't offer a session reset for this account right now",
      });
      await fake.allGone();
      // Enter would have run the highlighted /login.
      assert.strictEqual(fake.count("ran"), 0);
    },
  );
});
