// @effect-diagnostics nodeBuiltinImport:off globalDate:off - drives the privacy queue in temp homes and state directories.
/**
 * Training settings and session resets against temp homes and state dirs and
 * a fake Claude Code terminal (claudeTerminal.ts's API), so no `claude`, PTY,
 * Keychain or network is ever reached.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { CLAUDE_ACCOUNT_MARKER } from "../claudeHistory.ts";
import { MoveController, type MoveDeps } from "./move.ts";
import type { ClaudeTerminalTarget, PtyLike, PtySpawner, TrainingRead } from "./claudeTerminal.ts";
import {
  HostProcessPlatform,
  mergeProviderInstanceEnvironment,
  resolveCodexLaunchArgs,
} from "./t3.ts";

const PLATFORM = HostProcessPlatform.defaultValue();

const ANN = "claude_aaaaaaaa";
const BOB = "claude_bbbbbbbb";
const WORK = "work";
const OFF = "claude_dddddddd";
const EVE = "codex_eeeeeeee";
const KAY = "codex_kkkkkkkk";
const MANAGED = "codex_managed";

/** On the fixture's failing `claude`, so a logout (`removeAccount`) never reaches a real one. */
const claude = (f: Fixture, homePath: string, over: Partial<ProviderInstanceConfig> = {}) => ({
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  config: { homePath, binaryPath: f.claude },
  ...over,
});
const codex = (config: Record<string, unknown>, over: Partial<ProviderInstanceConfig> = {}) => ({
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  config,
  ...over,
});

interface Fixture {
  readonly home: string;
  readonly stateDir: string;
  /** A `claude` that only fails: `status` reads the default sign-in with it. */
  readonly claude: string;
  readonly statePath: string;
}

const fixture = (): Fixture => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pool-privacy-"));
  const [home, stateDir, bin] = ["home", "state", "bin"].map((name) => {
    const dir = NodePath.join(root, name);
    NodeFS.mkdirSync(dir);
    return dir;
  }) as [string, string, string];
  const claudeBin = NodePath.join(bin, "claude");
  NodeFS.writeFileSync(claudeBin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return {
    home,
    stateDir,
    claude: claudeBin,
    statePath: NodePath.join(stateDir, "pool-privacy.json"),
  };
};

const settingsFor = (f: Fixture): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, binaryPath: f.claude },
    codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, binaryPath: f.claude },
  },
  providerInstances: {
    [ProviderInstanceId.make(ANN)]: claude(f, "~/.claude-ann", { displayName: "ann@example.com" }),
    [ProviderInstanceId.make(WORK)]: claude(f, "~/work-claude"),
    [ProviderInstanceId.make(OFF)]: claude(f, "~/.claude-dee", { enabled: false }),
    [ProviderInstanceId.make(EVE)]: codex(
      { setupMode: "existing", shadowHomePath: "~/.codex-eve", launchArgs: "--strict-config" },
      { displayName: "eve@example.com" },
    ),
    [ProviderInstanceId.make(KAY)]: codex({ setupMode: "existing", shadowHomePath: "~/.codex-k" }),
    [ProviderInstanceId.make(MANAGED)]: codex({ setupMode: "managed" }),
  },
});

interface TerminalCall {
  readonly task: "check" | "turnOff" | "reset";
  /** The config dir it ran on; "main" for the default one. */
  readonly dir: string;
  readonly target: ClaudeTerminalTarget;
  /** Ends a held call (`hold`); `result` replaces its own. */
  readonly release: () => void;
}

/**
 * claudeTerminal.ts's API, faked: each config dir reads `training` (default
 * "on"), turning it off sticks, a reset is used. `hold` keeps every call
 * running until the test releases it; `spawn` makes a call open a PTY and
 * wait for it to exit.
 */
const fakeTerminal = () => {
  const training = new Map<string, "on" | "off">();
  const calls: TerminalCall[] = [];
  const started: TerminalCall[] = [];
  const waiting: Array<(call: TerminalCall) => void> = [];
  const next: { result?: TrainingRead; error?: Error } = {};
  let running = 0;
  const state = { hold: false, spawn: false, maxRunning: 0 };

  const call = async (
    task: TerminalCall["task"],
    pty: PtySpawner,
    target: ClaudeTerminalTarget,
  ) => {
    running += 1;
    state.maxRunning = Math.max(state.maxRunning, running);
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const entry = { task, dir: target.env.CLAUDE_CONFIG_DIR ?? "main", target, release };
    calls.push(entry);
    const waiter = waiting.shift();
    if (waiter) waiter(entry);
    else started.push(entry);
    try {
      if (state.spawn) {
        const process = await pty({
          shell: target.binary,
          cwd: target.cwd,
          cols: 120,
          rows: 40,
          env: target.env,
        });
        await new Promise<void>((resolve) => process.onExit(() => resolve()));
        throw new Error("Claude Code exited.");
      }
      if (state.hold) await released;
      const { error, result } = next;
      delete next.error;
      delete next.result;
      if (error) throw error;
      return result;
    } finally {
      running -= 1;
    }
  };

  return {
    calls,
    training,
    next,
    state,
    runs: () => calls.map(({ task, dir }) => [task, dir]),
    /** The next call to start (already started or not yet). */
    nextCall: () =>
      new Promise<TerminalCall>((resolve) => {
        const first = started.shift();
        if (first) resolve(first);
        else waiting.push(resolve);
      }),
    terminal: {
      claudeTerminalEnv: (base: NodeJS.ProcessEnv) => ({ ...base, FAKE_TERMINAL_ENV: "1" }),
      readClaudeTraining: async (pty: PtySpawner, target: ClaudeTerminalTarget) => {
        const result = await call("check", pty, target);
        return result ?? { training: training.get(target.env.CLAUDE_CONFIG_DIR ?? "main") ?? "on" };
      },
      turnClaudeTrainingOff: async (pty: PtySpawner, target: ClaudeTerminalTarget) => {
        const result = await call("turnOff", pty, target);
        training.set(target.env.CLAUDE_CONFIG_DIR ?? "main", "off");
        return result ?? { training: "off" as const };
      },
      useClaudeSessionReset: async (pty: PtySpawner, target: ClaudeTerminalTarget) => {
        await call("reset", pty, target);
        return { outcome: "used" as const, message: "Your session limit was reset." };
      },
    },
  };
};

/** A PTY whose `kill` ends it (an exit listener added later hears at once, like node-pty's); records kills. */
const fakePty = () => {
  const killed: number[] = [];
  const spawn: PtySpawner = async () => {
    const listeners = new Set<(event: { exitCode: number; signal: number | null }) => void>();
    let exited = false;
    const exit = { exitCode: 0, signal: null };
    const process: PtyLike = {
      pid: 4242,
      write: () => undefined,
      kill: () => {
        killed.push(4242);
        exited = true;
        for (const listener of listeners) listener(exit);
      },
      onData: () => () => undefined,
      onExit: (listener) => {
        if (exited) listener(exit);
        else listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return process;
  };
  return { killed, spawn };
};

const makePrivacy = (
  f: Fixture,
  over: Partial<MoveDeps> = {},
  initial: ServerSettings = settingsFor(f),
) => {
  let settings = initial;
  const refreshed: string[] = [];
  const logged: string[] = [];
  let reconciles = 0;
  const fake = fakeTerminal();
  const expandHome = (path: string) =>
    path === "~" ? f.home : path.startsWith("~/") ? NodePath.join(f.home, path.slice(2)) : path;
  const deps: MoveDeps = {
    stateDir: f.stateDir,
    platform: PLATFORM,
    // Never the real environment: no real `claude` on PATH, and the key must be stripped.
    env: { PATH: "/usr/bin:/bin", HOME: f.home, ANTHROPIC_API_KEY: "sk-leak" },
    expandHome,
    getSettings: async () => settings,
    updateSettings: async (patch) => {
      settings = applyServerSettingsPatch(settings, patch);
    },
    claudeEnvironment: async (homePath, base) =>
      homePath ? { ...base, CLAUDE_CONFIG_DIR: NodePath.resolve(expandHome(homePath)) } : base,
    materializeCodexHome: async () => {
      throw new Error("These tests sign nothing in.");
    },
    resolveSpawn: async (command, args) => ({ command, args, shell: false }),
    refreshInstance: async (instanceId) => {
      refreshed.push(instanceId);
    },
    canSymlink: async () => true,
    claudeExecutable: async (binary) => binary,
    claudeTerminal: fake.terminal,
    pty: async () => {
      throw new Error("No PTY here.");
    },
    providerEmail: async () => undefined,
    reconcile: async () => {
      reconciles += 1;
    },
    log: (message) => logged.push(message),
    ...over,
  };
  return {
    move: new MoveController(deps),
    fake,
    refreshed,
    logged,
    reconciles: () => reconciles,
  };
};

const readState = (f: Fixture) => JSON.parse(NodeFS.readFileSync(f.statePath, "utf8"));

const writeJson = (path: string, value: unknown, mode = 0o600) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, JSON.stringify(value), { mode });
};

/** The message a rejected call failed with. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  );

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60_000).toISOString();

describe.skipIf(PLATFORM === "win32")("privacy", () => {
  it("lists every Claude account and keeps what it read in pool-privacy.json (0600)", async () => {
    const f = fixture();
    const { move, fake } = makePrivacy(f);
    const before = (await move.status()).privacy;
    assert.deepEqual(before, {
      keepTrainingOff: false,
      claude: [ANN, WORK, OFF, "claudeAgent"].map((instanceId) => ({
        instanceId,
        training: "unknown" as const,
      })),
      codexMarkedOff: {},
    });
    assert.isFalse(NodeFS.existsSync(f.statePath));

    fake.training.set(NodePath.join(f.home, ".claude-ann"), "off");
    await move.privacy.enqueue(ANN, "check");
    await move.privacy.enqueue("claudeAgent", "check");
    await move.privacy.idle();

    const state = readState(f);
    assert.equal(NodeFS.statSync(f.statePath).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(state), [
      "version",
      "keepTrainingOff",
      "claude",
      "codexMarkedOff",
    ]);
    assert.equal(state.version, 1);
    assert.isFalse(state.keepTrainingOff);
    assert.deepEqual(state.codexMarkedOff, {});
    assert.deepEqual(
      Object.entries(state.claude).map(([id, entry]) => [
        id,
        (entry as { training: string }).training,
      ]),
      [
        [ANN, "off"],
        ["claudeAgent", "on"],
      ],
    );
    const claude = (await move.status()).privacy?.claude ?? [];
    assert.deepEqual(
      claude.map((entry) => [entry.instanceId, entry.training, typeof entry.checkedAt]),
      [
        [ANN, "off", "string"],
        [WORK, "unknown", "undefined"],
        [OFF, "unknown", "undefined"],
        ["claudeAgent", "on", "string"],
      ],
    );

    // Each ran the instance's own claude, in its own config dir (the main one: none), in a
    // folder of T3's, without the auth overrides, through claudeTerminalEnv.
    const [ann, main] = fake.calls;
    const cwd = NodeFS.realpathSync(NodePath.join(f.stateDir, "claude-privacy"));
    assert.deepEqual(
      [ann?.target.binary, ann?.target.cwd, ann?.target.platform, ann?.dir],
      [f.claude, cwd, PLATFORM, NodePath.join(f.home, ".claude-ann")],
    );
    assert.deepEqual([main?.target.binary, main?.target.cwd, main?.dir], [f.claude, cwd, "main"]);
    assert.notProperty(main?.target.env, "CLAUDE_CONFIG_DIR");
    for (const call of fake.calls) {
      assert.notProperty(call.target.env, "ANTHROPIC_API_KEY");
      assert.equal(call.target.env.FAKE_TERMINAL_ENV, "1");
    }
  });

  it("records each task's result, busy while it runs", async () => {
    const f = fixture();
    const { move, fake, refreshed } = makePrivacy(f);
    fake.state.hold = true;
    const entry = async () =>
      (await move.status()).privacy?.claude.find((account) => account.instanceId === ANN);

    await move.privacy.enqueue(ANN, "check");
    const check = await fake.nextCall();
    assert.deepEqual((await move.status()).privacy?.busy, { instanceId: ANN, task: "check" });
    check.release();
    await move.privacy.idle();
    assert.isUndefined((await move.status()).privacy?.busy);
    const checked = await entry();
    assert.equal(checked?.training, "on");
    assert.isString(checked?.checkedAt);

    await move.privacy.enqueue(ANN, "turnOff");
    const turnOff = await fake.nextCall();
    assert.deepEqual((await move.status()).privacy?.busy, { instanceId: ANN, task: "turnOff" });
    turnOff.release();
    await move.privacy.idle();
    assert.equal((await entry())?.training, "off");

    // A screen it can't read: the message, the last reading kept.
    const read = await entry();
    fake.next.result = {
      problem: "Claude asks you to review its updated terms for this account first.",
    };
    await move.privacy.enqueue(ANN, "check");
    (await fake.nextCall()).release();
    await move.privacy.idle();
    assert.deepEqual(await entry(), {
      ...read!,
      message: "Claude asks you to review its updated terms for this account first.",
    });
    // The next reading clears it.
    await move.privacy.enqueue(ANN, "check");
    (await fake.nextCall()).release();
    await move.privacy.idle();
    assert.isUndefined((await entry())?.message);

    await move.privacy.enqueue(ANN, "reset");
    const reset = await fake.nextCall();
    assert.deepEqual((await move.status()).privacy?.busy, { instanceId: ANN, task: "reset" });
    reset.release();
    await move.privacy.idle();
    assert.deepEqual(
      { ...(await entry())?.reset, at: "" },
      { at: "", outcome: "used", message: "Your session limit was reset." },
    );
    assert.deepEqual(refreshed, [ANN]);

    // A terminal that fails midway: T3 can't tell whether it was used, and refreshes nothing.
    fake.next.error = new Error("Claude Code exited before its screen showed.");
    await move.privacy.enqueue(ANN, "reset");
    (await fake.nextCall()).release();
    await move.privacy.idle();
    assert.deepEqual(
      { ...(await entry())?.reset, at: "" },
      { at: "", outcome: "unknown", message: "Claude Code exited before its screen showed." },
    );
    assert.deepEqual(refreshed, [ANN]);
  });

  it("runs one terminal task at a time, in order, ignoring a repeat", async () => {
    const f = fixture();
    const { move, fake } = makePrivacy(f);
    fake.state.hold = true;
    await move.privacy.enqueue("claudeAgent", "check");
    await move.privacy.enqueue(ANN, "turnOff");
    await move.privacy.enqueue(ANN, "reset");
    // Queued or running already: a double click doesn't run (or redeem) it twice.
    await move.privacy.enqueue(ANN, "reset");
    await move.privacy.enqueue("claudeAgent", "check");

    for (const [task, instanceId] of [
      ["check", "claudeAgent"],
      ["turnOff", ANN],
      ["reset", ANN],
    ] as const) {
      const call = await fake.nextCall();
      assert.equal(call.task, task);
      assert.deepEqual((await move.status()).privacy?.busy, { instanceId, task });
      call.release();
    }
    await move.privacy.idle();
    assert.equal(fake.calls.length, 3);
    assert.equal(fake.state.maxRunning, 1);
  });

  it("lets a keep-off check take over a plain one, so an 'on' reading is turned off", async () => {
    const f = fixture();
    const ann = NodePath.join(f.home, ".claude-ann");
    const work = NodePath.join(f.home, "work-claude");
    const { move, fake } = makePrivacy(f);
    fake.state.hold = true;
    await move.privacy.enqueue("claudeAgent", "check");
    const first = await fake.nextCall();
    await move.privacy.enqueue(ANN, "check");
    await move.privacy.setKeepOff(true);
    fake.state.hold = false;
    first.release();
    await move.privacy.idle();
    // Ann's queued check became the sweep's; the main account's running one couldn't, so
    // the sweep checks it again.
    assert.deepEqual(fake.runs(), [
      ["check", "main"],
      ["check", ann],
      ["turnOff", ann],
      ["check", work],
      ["turnOff", work],
      ["check", "main"],
      ["turnOff", "main"],
    ]);
    assert.deepEqual(
      (await move.status()).privacy?.claude.map((entry) => entry.training),
      ["off", "off", "unknown", "off"],
    );
  });

  it("refuses other providers, turned-off and unknown accounts", async () => {
    const f = fixture();
    const { move, fake } = makePrivacy(f);
    assert.equal(
      await failure(move.privacy.enqueue(EVE, "check")),
      "Only Claude accounts can do this here.",
    );
    assert.equal(await failure(move.privacy.enqueue(OFF, "reset")), "This account is turned off.");
    assert.equal(
      await failure(move.privacy.enqueue("claude_gone", "turnOff")),
      "That account isn't in T3 anymore.",
    );
    await move.privacy.idle();
    assert.deepEqual(fake.calls, []);
  });

  it("keeps training off: checks stale accounts, turns 'on' off, skips fresh 'off' readings", async () => {
    const f = fixture();
    const work = NodePath.join(f.home, "work-claude");
    writeJson(f.statePath, {
      version: 1,
      keepTrainingOff: false,
      claude: {
        [ANN]: { training: "off", checkedAt: hoursAgo(1) },
        [WORK]: { training: "off", checkedAt: hoursAgo(25) },
      },
      codexMarkedOff: {},
    });
    const { move, fake, reconciles } = makePrivacy(f);
    fake.training.set(work, "on");
    fake.training.set("main", "off");

    await move.privacy.setKeepOff(true);
    await move.privacy.idle();
    assert.equal(reconciles(), 1);
    // Ann read "off" an hour ago, Dee is turned off; Work read "on" now and was turned off.
    assert.deepEqual(fake.runs(), [
      ["check", work],
      ["turnOff", work],
      ["check", "main"],
    ]);
    const state = readState(f);
    assert.isTrue(state.keepTrainingOff);
    assert.deepEqual(state.claude[ANN], {
      training: "off",
      checkedAt: state.claude[ANN].checkedAt,
    });
    assert.equal(state.claude[WORK].training, "off");
    assert.isAbove(Date.parse(state.claude[WORK].checkedAt), Date.parse(hoursAgo(1)));
    assert.equal(state.claude.claudeAgent.training, "off");

    // Unchanged: nothing rebuilds. Off: the instances are rebuilt without the overlay.
    await move.privacy.setKeepOff(true);
    assert.equal(reconciles(), 1);
    await move.privacy.setKeepOff(false);
    assert.equal(reconciles(), 2);
    assert.isFalse(readState(f).keepTrainingOff);
    // A sign-in while it's off checks nothing.
    move.privacy.afterSignIn(ANN);
    await move.privacy.idle();
    assert.equal(fake.calls.length, 3);
  });

  it("turns Codex feedback and Claude's /bug off through the overlay, only while kept off", async () => {
    const f = fixture();
    const { move } = makePrivacy(f);
    const map = {
      [ProviderInstanceId.make(EVE)]: codex({
        setupMode: "existing",
        launchArgs: "--strict-config",
      }),
      [ProviderInstanceId.make(KAY)]: codex({ setupMode: "existing" }),
      [ProviderInstanceId.make(MANAGED)]: codex({ setupMode: "managed" }),
      [ProviderInstanceId.make(ANN)]: claude(f, "~/.claude-ann", {
        environment: [
          { name: "DISABLE_BUG_COMMAND", value: "0", sensitive: false },
          { name: "MY_VAR", value: "kept", sensitive: true },
        ],
      }),
    } as ProviderInstanceConfigMap;
    await move.privacy.load();
    assert.strictEqual(move.privacy.instanceOverlay(map), map);

    await move.privacy.setKeepOff(true);
    const overlaid = move.privacy.instanceOverlay(map);
    const config = (id: string) => overlaid[ProviderInstanceId.make(id)]?.config;
    assert.deepEqual(config(EVE), {
      setupMode: "existing",
      launchArgs: "--strict-config -c feedback.enabled=false",
    });
    assert.deepEqual(config(KAY), {
      setupMode: "existing",
      launchArgs: "-c feedback.enabled=false",
    });
    assert.strictEqual(
      overlaid[ProviderInstanceId.make(MANAGED)],
      map[ProviderInstanceId.make(MANAGED)],
    );
    assert.deepEqual(overlaid[ProviderInstanceId.make(ANN)]?.environment, [
      { name: "MY_VAR", value: "kept", sensitive: true },
      { name: "DISABLE_BUG_COMMAND", value: "1", sensitive: false },
      { name: "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY", value: "1", sensitive: false },
    ]);
    // Never persisted: the input map is as it was.
    assert.deepEqual(config(ANN), { homePath: "~/.claude-ann", binaryPath: f.claude });
    assert.deepEqual(map[ProviderInstanceId.make(EVE)]?.config, {
      setupMode: "existing",
      launchArgs: "--strict-config",
    });

    await move.privacy.setKeepOff(false);
    assert.strictEqual(move.privacy.instanceOverlay(map), map);
  });

  it("completes onboarding only in account dirs T3 made, never while Claude runs there", async () => {
    const f = fixture();
    const ann = NodePath.join(f.home, ".claude-ann");
    const bob = NodePath.join(f.home, ".claude-bob");
    const cy = NodePath.join(f.home, ".claude-cy");
    const work = NodePath.join(f.home, "work-claude");
    const account = (email: string) => ({
      oauthAccount: { emailAddress: email },
      numStartups: 3,
      projects: { "/tmp": { allowedTools: [] } },
    });
    // Marked by T3, with a theme already.
    NodeFS.mkdirSync(ann);
    NodeFS.writeFileSync(
      NodePath.join(ann, CLAUDE_ACCOUNT_MARKER),
      NodePath.join(f.home, ".claude"),
    );
    writeJson(NodePath.join(ann, ".claude.json"), {
      ...account("ann@example.com"),
      theme: "light",
    });
    // Unmarked, made by the previous release for a `claude_<hash>` instance.
    writeJson(NodePath.join(bob, ".claude.json"), account("bob@example.com"), 0o644);
    // Marked, but a Claude session (this live process) holds it.
    NodeFS.mkdirSync(cy);
    NodeFS.writeFileSync(NodePath.join(cy, CLAUDE_ACCOUNT_MARKER), "");
    writeJson(NodePath.join(cy, ".claude.json"), account("cy@example.com"));
    writeJson(NodePath.join(cy, "sessions", "1.json"), { pid: process.pid });
    // The user's own dir, and the default config.
    writeJson(NodePath.join(work, ".claude.json"), account("work@example.com"));
    writeJson(NodePath.join(f.home, ".claude.json"), account("main@example.com"));
    const untouched = [cy, work, f.home].map((dir) => NodePath.join(dir, ".claude.json"));
    const before = untouched.map((file) => NodeFS.readFileSync(file, "utf8"));

    const settings = settingsFor(f);
    const CY = "claude_cccccccc";
    const { move, fake, logged } = makePrivacy(
      f,
      {},
      {
        ...settings,
        providerInstances: {
          ...settings.providerInstances,
          [ProviderInstanceId.make(BOB)]: claude(f, "~/.claude-bob"),
          [ProviderInstanceId.make(CY)]: claude(f, "~/.claude-cy"),
        },
      },
    );
    for (const id of [ANN, BOB, CY, WORK, "claudeAgent"]) await move.privacy.enqueue(id, "check");
    await move.privacy.idle();
    assert.equal(fake.calls.length, 5);

    const read = (dir: string) =>
      JSON.parse(NodeFS.readFileSync(NodePath.join(dir, ".claude.json"), "utf8"));
    assert.deepEqual(read(ann), {
      ...account("ann@example.com"),
      theme: "light",
      hasCompletedOnboarding: true,
    });
    assert.deepEqual(read(bob), {
      ...account("bob@example.com"),
      hasCompletedOnboarding: true,
      theme: "dark",
    });
    // Each keeps its mode.
    assert.equal(NodeFS.statSync(NodePath.join(ann, ".claude.json")).mode & 0o777, 0o600);
    assert.equal(NodeFS.statSync(NodePath.join(bob, ".claude.json")).mode & 0o777, 0o644);
    assert.deepEqual(
      untouched.map((file) => NodeFS.readFileSync(file, "utf8")),
      before,
    );
    assert.include(logged, `Claude is running on ${cy}; left its .claude.json as it is`);
  });

  it("remembers the user's word about a Codex account, by its email", async () => {
    const f = fixture();
    const emails: Record<string, string> = { [EVE]: "Eve@Example.com" };
    const { move } = makePrivacy(f, { providerEmail: async (id) => emails[id] });

    await move.privacy.markCodexOff(EVE, true);
    const marked = (await move.status()).privacy?.codexMarkedOff ?? {};
    assert.deepEqual(Object.keys(marked), ["eve@example.com"]);
    assert.deepEqual(readState(f).codexMarkedOff, marked);

    // No snapshot email yet: an email display name will do; none at all is refused.
    const settings = settingsFor(f);
    const named = makePrivacy(
      f,
      {},
      {
        ...settings,
        providerInstances: {
          ...settings.providerInstances,
          [ProviderInstanceId.make(KAY)]: codex(
            { setupMode: "existing" },
            { displayName: "KAY@example.com" },
          ),
        },
      },
    );
    await named.move.privacy.markCodexOff(KAY, true);
    assert.deepEqual(Object.keys(readState(f).codexMarkedOff).sort(), [
      "eve@example.com",
      "kay@example.com",
    ]);
    assert.equal(
      await failure(move.privacy.markCodexOff(KAY, true)),
      "T3 doesn't know this Codex account's email yet.",
    );
    assert.equal(
      await failure(move.privacy.markCodexOff(ANN, true)),
      "Only Codex accounts can be marked here.",
    );

    await move.privacy.markCodexOff(EVE, false);
    assert.deepEqual((await move.status()).privacy?.codexMarkedOff, {});
  });

  it("drops removed accounts from the status and the file", async () => {
    const f = fixture();
    writeJson(f.statePath, {
      version: 1,
      keepTrainingOff: false,
      claude: {
        [ANN]: { training: "off", checkedAt: hoursAgo(1) },
        claude_gone: { training: "on", checkedAt: hoursAgo(2) },
      },
      codexMarkedOff: {},
    });
    const { move, fake } = makePrivacy(f);
    const listed = async () =>
      (await move.status()).privacy?.claude.map((entry) => entry.instanceId);
    assert.deepEqual(await listed(), [ANN, WORK, OFF, "claudeAgent"]);

    // Its queued task goes with it.
    fake.state.hold = true;
    await move.privacy.enqueue("claudeAgent", "check");
    const running = await fake.nextCall();
    await move.privacy.enqueue(ANN, "reset");
    await move.removeAccount(ANN);
    running.release();
    await move.privacy.idle();
    assert.deepEqual(fake.runs(), [["check", "main"]]);
    assert.deepEqual(await listed(), [WORK, OFF, "claudeAgent"]);
    assert.notProperty(readState(f).claude, ANN);
  });

  it("at start, rebuilds the instances once and sweeps a minute later; close ends it all", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const f = fixture();
      writeJson(f.statePath, { version: 1, keepTrainingOff: true, claude: {}, codexMarkedOff: {} });
      const pty = fakePty();
      const { move, fake, reconciles } = makePrivacy(f, { pty: pty.spawn });
      fake.state.spawn = true;

      await move.privacy.start();
      assert.equal(reconciles(), 1);
      assert.deepEqual(fake.calls, []);
      vi.advanceTimersByTime(60_000);
      const first = await fake.nextCall();
      assert.equal(first.dir, NodePath.join(f.home, ".claude-ann"));
      // The next sweep is a day away.
      assert.equal(vi.getTimerCount(), 1);

      move.close();
      await move.privacy.idle();
      assert.deepEqual(pty.killed, [4242]);
      assert.equal(vi.getTimerCount(), 0);
      // Nothing after the running task, and nothing recorded at shutdown.
      assert.equal(fake.calls.length, 1);
      assert.isFalse(NodeFS.readFileSync(f.statePath, "utf8").includes(ANN));
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads resets saved as used or not; a used one refreshes even when its save fails", async () => {
    const f = fixture();
    writeJson(f.statePath, {
      version: 1,
      keepTrainingOff: false,
      claude: {
        [ANN]: {
          training: "off",
          reset: { at: hoursAgo(2), used: true, message: "Limits reset." },
        },
        [WORK]: { training: "on", reset: { at: hoursAgo(3), used: false, message: "None left." } },
      },
      codexMarkedOff: {},
    });
    const { move, refreshed, logged } = makePrivacy(f);
    const resets = async () =>
      ((await move.status()).privacy?.claude ?? []).map((entry) => [
        entry.instanceId,
        entry.reset?.outcome,
        entry.reset?.message,
      ]);
    assert.deepEqual(await resets(), [
      [ANN, "used", "Limits reset."],
      [WORK, "notUsed", "None left."],
      [OFF, undefined, undefined],
      ["claudeAgent", undefined, undefined],
    ]);

    // The file can't be replaced now: the result stands, the failure is only logged.
    NodeFS.rmSync(f.statePath);
    NodeFS.mkdirSync(NodePath.join(f.statePath, "in-the-way"), { recursive: true });
    await move.privacy.enqueue(ANN, "reset");
    await move.privacy.idle();
    assert.deepEqual(refreshed, [ANN]);
    assert.deepEqual((await resets())[0], [ANN, "used", "Your session limit was reset."]);
    assert.include(logged, `Saving ${f.statePath} failed`);
  });

  it("never saves over a file it couldn't read, and reads it again next time", async () => {
    const f = fixture();
    const unreadable = "T3 couldn't read its saved privacy settings. Try again in a moment.";
    // A read that fails (EISDIR here, like EACCES or EMFILE) isn't a damaged file.
    NodeFS.mkdirSync(f.statePath);
    const { move, fake, reconciles, logged } = makePrivacy(f);
    await move.privacy.start();
    assert.equal(reconciles(), 0);
    assert.equal(await failure(move.privacy.setKeepOff(false)), unreadable);
    assert.equal(await failure(move.privacy.enqueue(ANN, "check")), unreadable);
    assert.equal(await failure(move.privacy.markCodexOff(EVE, true)), unreadable);
    assert.isTrue(NodeFS.statSync(f.statePath).isDirectory());
    assert.include(logged, `Reading ${f.statePath} failed; reading it again next time`);

    // Readable again: the next call reads it, and the start it missed applies keep-off.
    NodeFS.rmdirSync(f.statePath);
    writeJson(f.statePath, {
      version: 1,
      keepTrainingOff: true,
      claude: {},
      codexMarkedOff: { "eve@example.com": hoursAgo(1) },
    });
    const privacy = (await move.status()).privacy;
    assert.isTrue(privacy?.keepTrainingOff);
    assert.deepEqual(Object.keys(privacy?.codexMarkedOff ?? {}), ["eve@example.com"]);
    assert.equal(reconciles(), 1);
    move.close();
    await move.privacy.idle();
    assert.deepEqual(fake.calls, []);

    // A damaged file stands for the defaults until the next change replaces it.
    const g = fixture();
    NodeFS.writeFileSync(g.statePath, "{ not json", { mode: 0o600 });
    const damaged = makePrivacy(g);
    assert.isFalse((await damaged.move.status()).privacy?.keepTrainingOff);
    assert.include(damaged.logged, `${g.statePath} is damaged; using the defaults`);
    await damaged.move.privacy.markCodexOff(EVE, false);
    assert.deepEqual(readState(g), {
      version: 1,
      keepTrainingOff: false,
      claude: {},
      codexMarkedOff: {},
    });
  });

  it("checks every account again each day, even one that finished a while into the sweep", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const f = fixture();
      const ann = NodePath.join(f.home, ".claude-ann");
      const work = NodePath.join(f.home, "work-claude");
      writeJson(f.statePath, { version: 1, keepTrainingOff: true, claude: {}, codexMarkedOff: {} });
      const { move, fake } = makePrivacy(f);
      for (const dir of [ann, work, "main"]) fake.training.set(dir, "off");
      await move.privacy.start();
      fake.state.hold = true;
      vi.advanceTimersByTime(60_000);
      // The first check takes a minute: every reading lands a minute after the sweep began.
      const first = await fake.nextCall();
      vi.advanceTimersByTime(60_000);
      fake.state.hold = false;
      first.release();
      await move.privacy.idle();
      const all = [
        ["check", ann],
        ["check", work],
        ["check", "main"],
      ];
      assert.deepEqual(fake.runs(), all);

      // The next sweep, a day after the first: under a day since those readings, checked anyway.
      vi.advanceTimersByTime(24 * 60 * 60_000 - 60_000);
      await move.privacy.idle();
      assert.deepEqual(fake.runs(), [...all, ...all]);
      move.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never checks or runs on a main account turned off in the legacy settings", async () => {
    const f = fixture();
    const settings = settingsFor(f);
    const { move, fake } = makePrivacy(
      f,
      {},
      {
        ...settings,
        providers: {
          ...settings.providers,
          claudeAgent: { ...settings.providers.claudeAgent, enabled: false },
        },
      },
    );
    await move.privacy.setKeepOff(true);
    await move.privacy.idle();
    assert.deepEqual(fake.runs(), [
      ["check", NodePath.join(f.home, ".claude-ann")],
      ["turnOff", NodePath.join(f.home, ".claude-ann")],
      ["check", NodePath.join(f.home, "work-claude")],
      ["turnOff", NodePath.join(f.home, "work-claude")],
    ]);
    assert.equal(
      await failure(move.privacy.enqueue("claudeAgent", "check")),
      "This account is turned off.",
    );
  });

  it("won't start Claude Code inside a git repository, or a script on Windows", async () => {
    const f = fixture();
    // T3's state inside a repository (a worktree's `.git` is a file): Claude would trust all of it.
    NodeFS.writeFileSync(NodePath.join(NodePath.dirname(f.stateDir), ".git"), "gitdir: /x\n");
    const { move, fake } = makePrivacy(f);
    const entry = async (privacy: MoveController) =>
      (await privacy.status()).privacy?.claude.find(({ instanceId }) => instanceId === ANN);
    await move.privacy.enqueue(ANN, "check");
    await move.privacy.enqueue(ANN, "reset");
    await move.privacy.idle();
    const refused =
      "T3's Claude Code folder is inside a git repository, so Claude Code would trust the whole repository; T3 won't run it there.";
    const inRepo = await entry(move);
    assert.equal(inRepo?.message, refused);
    assert.deepEqual(
      { ...inRepo?.reset, at: "" },
      { at: "", outcome: "notUsed", message: refused },
    );
    assert.deepEqual(fake.calls, []);

    const windows = makePrivacy(fixture(), { platform: "win32" });
    await windows.move.privacy.enqueue(ANN, "check");
    await windows.move.privacy.idle();
    assert.equal(
      (await entry(windows.move))?.message,
      "This Claude Code install can't run in a terminal here. Update Claude Code (claude update), then try again.",
    );
    assert.deepEqual(windows.fake.calls, []);
  });

  it("carries the feedback switch into T3CODE_CODEX_LAUNCH_ARGS, which Codex prefers", async () => {
    const f = fixture();
    const env = { PATH: "/usr/bin:/bin", HOME: f.home, T3CODE_CODEX_LAUNCH_ARGS: "--search " };
    const { move } = makePrivacy(f, { env });
    const map = {
      [ProviderInstanceId.make(EVE)]: codex({ setupMode: "existing", launchArgs: "--strict" }),
      [ProviderInstanceId.make(KAY)]: codex(
        { setupMode: "existing" },
        {
          environment: [
            { name: "T3CODE_CODEX_LAUNCH_ARGS", value: "-c model=o3", sensitive: true },
            { name: "MY_VAR", value: "kept", sensitive: false },
          ],
        },
      ),
      [ProviderInstanceId.make(MANAGED)]: codex({ setupMode: "managed" }),
    } as ProviderInstanceConfigMap;
    await move.privacy.setKeepOff(true);
    await move.privacy.idle();
    const overlaid = move.privacy.instanceOverlay(map);
    // What each one launches with, as the Codex driver resolves it.
    const launched = (id: string) => {
      const instance = overlaid[ProviderInstanceId.make(id)];
      const config = instance?.config as { readonly launchArgs?: string };
      return resolveCodexLaunchArgs(
        config.launchArgs,
        mergeProviderInstanceEnvironment(instance?.environment, env),
      );
    };
    assert.equal(launched(EVE), "--search -c feedback.enabled=false");
    assert.equal(launched(KAY), "-c model=o3 -c feedback.enabled=false");
    assert.deepEqual(overlaid[ProviderInstanceId.make(KAY)]?.environment, [
      { name: "MY_VAR", value: "kept", sensitive: false },
      {
        name: "T3CODE_CODEX_LAUNCH_ARGS",
        value: "-c model=o3 -c feedback.enabled=false",
        sensitive: true,
      },
    ]);
    assert.strictEqual(
      overlaid[ProviderInstanceId.make(MANAGED)],
      map[ProviderInstanceId.make(MANAGED)],
    );

    // Without the variable, launchArgs carries it alone.
    const plain = makePrivacy(fixture());
    await plain.move.privacy.setKeepOff(true);
    await plain.move.privacy.idle();
    const eve = plain.move.privacy.instanceOverlay(map)[ProviderInstanceId.make(EVE)];
    assert.isUndefined(eve?.environment);
    assert.deepEqual(eve?.config, {
      setupMode: "existing",
      launchArgs: "--strict -c feedback.enabled=false",
    });
  });

  it("ends an account's running task before removing it", async () => {
    const f = fixture();
    const pty = fakePty();
    const { move, fake } = makePrivacy(f, { pty: pty.spawn });
    fake.state.spawn = true;
    await move.privacy.enqueue(ANN, "check");
    await move.privacy.enqueue(ANN, "reset");
    await fake.nextCall();
    await move.removeAccount(ANN);
    assert.deepEqual(pty.killed, [4242]);
    await move.privacy.idle();
    assert.deepEqual(fake.runs(), [["check", NodePath.join(f.home, ".claude-ann")]]);
    assert.notProperty(readState(f).claude, ANN);
  });
});
