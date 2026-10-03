// @effect-diagnostics nodeBuiltinImport:off - drives fake CLIs in temp homes and state directories.
/**
 * The move and account sign-ins against temp state directories, a temp home and a fake `claude` /
 * `codex` (a small node script that prints the real CLIs' sign-in lines and
 * keeps its "login" in a file), so nothing reaches the real home, Keychain or
 * network.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { assert, describe, it } from "@effect/vitest";

import { CLAUDE_ACCOUNT_MARKER } from "../claudeHistory.ts";
import { MoveController, type MoveDeps, POOL_USAGE_SOURCE_ID } from "./move.ts";
import type { ClaudeTerminalTarget } from "./claudeTerminal.ts";
import { type MoveEntry, moveAccountId } from "./state.ts";
import { HostProcessPlatform } from "./t3.ts";

/** The fake CLIs are POSIX shell scripts. */
const PLATFORM = HostProcessPlatform.defaultValue();

/**
 * One script for both CLIs. It appends every call (argv, the config dir it
 * ran with, whether an API key leaked through, any pasted code) to $FAKE_LOG.
 * `auth login` signs in as $FAKE_EMAIL, else the `--email` it was given.
 * $FAKE_AUTH_METHOD makes `auth status` report that method; $FAKE_CODEX_LOGIN
 * makes `codex login` fail ("fail"), save nothing ("nothing") or leave a
 * process holding its output behind ("grandchild"), and $FAKE_CODEX_KEYRING
 * keeps a Codex login only `login status` knows about.
 */
const FAKE_CLI = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const command = args.join(" ");
const log = (entry) =>
  fs.appendFileSync(
    process.env.FAKE_LOG,
    JSON.stringify({
      args,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
      CODEX_HOME: process.env.CODEX_HOME ?? null,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      ...entry,
    }) + "\n",
  );
log({});
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, ".claude");
const claudeLogin = path.join(claudeDir, "fake-login.json");
if (command === "auth status --json" && process.env.FAKE_AUTH_METHOD) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: process.env.FAKE_AUTH_METHOD }));
} else if (command === "auth status --json") {
  const login = fs.existsSync(claudeLogin) ? JSON.parse(fs.readFileSync(claudeLogin, "utf8")) : null;
  console.log(JSON.stringify(login ? { loggedIn: true, authMethod: "claude.ai", email: login.email } : { loggedIn: false, authMethod: "none" }));
  process.exit(login ? 0 : 1);
} else if (command.startsWith("auth login")) {
  const url = "https://claude.ai/oauth/authorize?code=true&state=abc";
  console.log("Opening browser to sign in…");
  console.log("If the browser didn't open, visit: \u001b]8;;" + url + "\u0007" + url + "\u001b]8;;\u0007");
  process.stdin.once("data", (code) => {
    log({ code: String(code) });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(claudeLogin, JSON.stringify({ email: process.env.FAKE_EMAIL || args[3] }));
    console.log("Login successful.");
    process.exit(0);
  });
} else if (command === "auth logout") {
  fs.rmSync(claudeLogin, { force: true });
} else if (command === "login status") {
  if (!fs.existsSync(process.env.CODEX_HOME)) {
    console.error("Error: CODEX_HOME points to " + process.env.CODEX_HOME + ", but that path does not exist");
    process.exit(1);
  }
  const signedIn = process.env.FAKE_CODEX_KEYRING || fs.existsSync(path.join(process.env.CODEX_HOME, "auth.json"));
  console.error(signedIn ? "Logged in using ChatGPT" : "Not logged in");
  process.exit(signedIn ? 0 : 1);
} else if (command === "login" && process.env.FAKE_CODEX_LOGIN === "fail") {
  console.error("Error: port 1455 is in use");
  process.exit(1);
} else if (command === "login") {
  console.error("Starting local login server on http://localhost:1455.");
  console.error("If your browser did not open, navigate to this URL to authenticate:\n");
  console.error("https://auth.openai.com/oauth/authorize?response_type=code&state=xyz");
  const claims = Buffer.from(JSON.stringify({ email: process.env.FAKE_EMAIL })).toString("base64url");
  if (process.env.FAKE_CODEX_LOGIN === "grandchild") {
    const sleeper = require("node:child_process").spawn("sleep", ["30"], { stdio: ["ignore", "inherit", "inherit"] });
    sleeper.unref();
    log({ grandchild: sleeper.pid });
  }
  if (process.env.FAKE_CODEX_LOGIN !== "nothing") {
    fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: "e30." + claims + ".sig" } }));
  }
  console.error("Successfully logged in");
} else if (command === "logout") {
  fs.rmSync(path.join(process.env.CODEX_HOME, "auth.json"), { force: true });
}
`;

const CLAUDE_URL = "https://claude.ai/oauth/authorize?code=true&state=abc";
const CODEX_URL = "https://auth.openai.com/oauth/authorize?response_type=code&state=xyz";

interface Fixture {
  readonly home: string;
  readonly stateDir: string;
  readonly bin: string;
  readonly log: string;
  readonly listPath: string;
}

const fixture = (): Fixture => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pool-move-"));
  const [home, stateDir, bin] = ["home", "state", "bin"].map((name) => {
    const dir = NodePath.join(root, name);
    NodeFS.mkdirSync(dir);
    return dir;
  }) as [string, string, string];
  const script = NodePath.join(bin, "fake-cli.cjs");
  NodeFS.writeFileSync(script, FAKE_CLI);
  for (const name of ["claude", "codex"]) {
    NodeFS.writeFileSync(
      NodePath.join(bin, name),
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  return {
    home,
    stateDir,
    bin,
    log: NodePath.join(root, "calls.jsonl"),
    listPath: NodePath.join(stateDir, "pool-move.json"),
  };
};

/** Default instances on the fake CLIs, homes left at their defaults (inside the temp home). */
const settingsFor = (f: Fixture, over: Partial<ServerSettings> = {}): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    claudeAgent: {
      ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
      binaryPath: NodePath.join(f.bin, "claude"),
    },
    codex: {
      ...DEFAULT_SERVER_SETTINGS.providers.codex,
      binaryPath: NodePath.join(f.bin, "codex"),
    },
  },
  ...over,
});

const makeMove = (
  f: Fixture,
  initial: ServerSettings,
  over: { readonly env?: NodeJS.ProcessEnv } & Partial<Omit<MoveDeps, "env">> = {},
) => {
  let settings = initial;
  const patches: ServerSettingsPatch[] = [];
  const refreshed: string[] = [];
  /** Claude Code terminal runs (privacy.ts); each reads training "off". */
  const terminals: Array<{ readonly task: string; readonly target: ClaudeTerminalTarget }> = [];
  const terminal = (task: string) => async (_pty: unknown, target: ClaudeTerminalTarget) => {
    terminals.push({ task, target });
    return { training: "off" as const, outcome: "notUsed" as const, message: "" };
  };
  const expandHome = (path: string) =>
    path === "~" ? f.home : path.startsWith("~/") ? NodePath.join(f.home, path.slice(2)) : path;
  const deps: MoveDeps = {
    stateDir: f.stateDir,
    platform: PLATFORM,
    expandHome,
    getSettings: async () => settings,
    updateSettings: async (patch) => {
      patches.push(patch);
      settings = applyServerSettingsPatch(settings, patch);
    },
    claudeEnvironment: async (homePath, base) =>
      homePath ? { ...base, CLAUDE_CONFIG_DIR: NodePath.resolve(expandHome(homePath)) } : base,
    materializeCodexHome: async (_homePath, shadowHomePath) => {
      const dir = NodePath.resolve(expandHome(shadowHomePath));
      NodeFS.mkdirSync(dir, { recursive: true });
      return dir;
    },
    resolveSpawn: async (command, args) => ({ command, args, shell: false }),
    refreshInstance: async (instanceId) => {
      refreshed.push(instanceId);
    },
    canSymlink: async () => true,
    claudeExecutable: async (binary) => binary,
    claudeTerminal: {
      claudeTerminalEnv: (base) => base,
      readClaudeTraining: terminal("check"),
      turnClaudeTrainingOff: terminal("turnOff"),
      useClaudeSessionReset: terminal("reset"),
    },
    pty: async () => {
      throw new Error("These tests run no terminal.");
    },
    providerEmail: async () => undefined,
    reconcile: async () => undefined,
    log: () => undefined,
    ...over,
    // Never the real environment: the fakes get a temp HOME, and the key must be stripped.
    env: {
      PATH: process.env.PATH,
      HOME: f.home,
      FAKE_LOG: f.log,
      ANTHROPIC_API_KEY: "sk-leak",
      ...over.env,
    },
  };
  return {
    move: new MoveController(deps),
    patches,
    refreshed,
    terminals,
    settings: () => settings,
  };
};

type Call = {
  readonly args: ReadonlyArray<string>;
  readonly CLAUDE_CONFIG_DIR: string | null;
  readonly CODEX_HOME: string | null;
  readonly ANTHROPIC_API_KEY: string | null;
  readonly code?: string;
  readonly grandchild?: number;
};
const calls = (f: Fixture): Call[] =>
  NodeFS.existsSync(f.log)
    ? NodeFS.readFileSync(f.log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Call)
    : [];
const callsOf = (f: Fixture, command: string) =>
  calls(f).filter((call) => call.args.join(" ").startsWith(command) && call.code === undefined);

const writeList = (f: Fixture, accounts: ReadonlyArray<MoveEntry>) =>
  NodeFS.writeFileSync(f.listPath, JSON.stringify({ version: 1, accounts }));
const readList = (f: Fixture) => JSON.parse(NodeFS.readFileSync(f.listPath, "utf8"));

/** Signs the default (`~/.claude`) home in, the way the fake keeps it. */
const signInDefaultClaude = (f: Fixture, email: string) => {
  const dir = NodePath.join(f.home, ".claude");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "fake-login.json"), JSON.stringify({ email }));
};

const jwt = (claims: unknown) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

const writeJson = (path: string, value: unknown) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, JSON.stringify(value));
};

/** Signs a Codex home in with ChatGPT, the way `codex login` saves it. */
const signInCodex = (home: string, email: string) =>
  writeJson(NodePath.join(home, "auth.json"), { tokens: { id_token: jwt({ email }) } });

/** The message a rejected start (or other call) failed with. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  );

const ANN: MoveEntry = { provider: "claude", email: "ann@example.com" };
const EVE: MoveEntry = { provider: "codex", email: "eve@example.com" };

const byEmail = (a: { readonly email: string }, b: { readonly email: string }) =>
  a.email.localeCompare(b.email);

const USAGE_SOURCE = {
  [POOL_USAGE_SOURCE_ID]: {
    kind: "cliproxy",
    url: "http://127.0.0.1:18417",
    managementKey: "",
    enabled: true,
  },
} as const;

describe.skipIf(PLATFORM === "win32")("boot", () => {
  it("saves the pool's accounts, deletes the pool and its usage source, once", async () => {
    const f = fixture();
    const pool = NodePath.join(f.stateDir, "pool");
    const auth = NodePath.join(pool, "auth");
    writeJson(NodePath.join(pool, "pool.json"), {
      version: 1,
      source: "local",
      managementKey: "fake-mgmt",
    });
    writeJson(NodePath.join(auth, "claude-Ann@Example.com.json"), {
      type: "claude",
      email: "Ann@Example.com",
      access_token: "fake-access",
      refresh_token: "fake-refresh",
    });
    writeJson(NodePath.join(auth, "codex-bob@example.com-plus.json"), {
      type: "codex",
      email: "bob@example.com",
      id_token: jwt({
        email: "bob@example.com",
        "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
      }),
      refresh_token: "fake-refresh",
    });
    // Paused, and no id_token: the plan comes from the file name.
    writeJson(NodePath.join(auth, "codex-cy@example.com-prolite.json"), {
      type: "codex",
      email: "cy@example.com",
      disabled: true,
    });
    writeJson(NodePath.join(auth, "notes.json"), { hello: "world" });
    writeJson(NodePath.join(auth, "nested", "claude-deep@example.com.json"), {
      type: "claude",
      email: "deep@example.com",
    });
    writeJson(NodePath.join(pool, "keys", "abc"), "fake-key");
    writeJson(NodePath.join(pool, "bin", "7.3.17", "cli-proxy-api"), "binary");
    NodeFS.writeFileSync(NodePath.join(pool, "proxy.pid"), "2147483646");
    // An earlier start saved Ann already, in another case.
    writeList(f, [{ provider: "claude", email: "ANN@example.com" }]);

    const first = makeMove(f, settingsFor(f, { usageLimitSources: USAGE_SOURCE }));
    await first.move.boot();

    const list = readList(f);
    assert.equal(list.version, 1);
    assert.deepEqual([...list.accounts].sort(byEmail), [
      { provider: "claude", email: "ANN@example.com" },
      { provider: "codex", email: "bob@example.com", plan: "ChatGPT Pro 20x Subscription" },
      { provider: "codex", email: "cy@example.com", plan: "ChatGPT Pro 5x Subscription" },
    ]);
    assert.notInclude(NodeFS.readFileSync(f.listPath, "utf8"), "fake-");
    assert.equal(NodeFS.statSync(f.listPath).mode & 0o777, 0o600);
    assert.isFalse(NodeFS.existsSync(pool));
    assert.deepEqual(first.patches, [{ usageLimitSources: { [POOL_USAGE_SOURCE_ID]: null } }]);

    // Neither default home is signed in, so each provider's accounts start there.
    const status = await first.move.status();
    assert.deepEqual(
      status.accounts.map((account) => [account.email, account.id]),
      list.accounts.map((entry: MoveEntry) => [entry.email, moveAccountId(entry)]),
    );
    assert.deepEqual(status.addTarget, { claude: "default", codex: "default" });

    const second = makeMove(f, first.settings());
    await second.move.boot();
    assert.deepEqual(readList(f), list);
    assert.deepEqual(second.patches, []);
  });

  it("keeps the sign-ins an external pool still holds from before", async () => {
    const f = fixture();
    const pool = NodePath.join(f.stateDir, "pool");
    writeJson(NodePath.join(pool, "pool.json"), {
      version: 1,
      source: "external",
      external: { url: "https://pool.example.com", key: "fake-team-key" },
    });
    writeJson(NodePath.join(pool, "auth", "claude-ann@example.com.json"), {
      type: "claude",
      email: "ann@example.com",
    });
    const { move, patches } = makeMove(f, settingsFor(f, { usageLimitSources: USAGE_SOURCE }));
    await move.boot();
    assert.deepEqual(readList(f).accounts, [{ provider: "claude", email: "ann@example.com" }]);
    assert.isFalse(NodeFS.existsSync(pool));
    assert.deepEqual(patches, [{ usageLimitSources: { [POOL_USAGE_SOURCE_ID]: null } }]);
  });

  it("isn't stopped by a damaged pool.json", async () => {
    const f = fixture();
    const pool = NodePath.join(f.stateDir, "pool");
    NodeFS.mkdirSync(pool);
    NodeFS.writeFileSync(NodePath.join(pool, "pool.json"), '{"version": 1, "sour');
    writeJson(NodePath.join(pool, "auth", "codex-bob@example.com-plus.json"), {
      type: "codex",
      email: "bob@example.com",
    });
    const { move } = makeMove(f, settingsFor(f));
    await move.boot();
    assert.deepEqual(readList(f).accounts, [
      { provider: "codex", email: "bob@example.com", plan: "ChatGPT Plus Subscription" },
    ]);
    assert.isFalse(NodeFS.existsSync(pool));
    // With nothing to move, no CLI runs.
    const empty = fixture();
    NodeFS.mkdirSync(NodePath.join(empty.stateDir, "pool"));
    NodeFS.writeFileSync(NodePath.join(empty.stateDir, "pool", "pool.json"), "{");
    await makeMove(empty, settingsFor(empty)).move.boot();
    assert.isFalse(NodeFS.existsSync(NodePath.join(empty.stateDir, "pool")));
    assert.isFalse(NodeFS.existsSync(empty.listPath));
    assert.deepEqual(calls(empty), []);
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps the pool while an account file can't be read",
    async () => {
      const f = fixture();
      const pool = NodePath.join(f.stateDir, "pool");
      const file = NodePath.join(pool, "auth", "claude-ann@example.com.json");
      writeJson(file, { type: "claude", email: "ann@example.com" });
      NodeFS.chmodSync(file, 0o000);
      const logged: string[] = [];
      const { move } = makeMove(f, settingsFor(f), { log: (message) => logged.push(message) });
      await move.boot();
      assert.isTrue(NodeFS.existsSync(file));
      assert.isFalse(NodeFS.existsSync(f.listPath));
      assert.include(logged, "Moving off the account pool failed; retrying at the next start");
    },
  );

  it("drops accounts already signed in directly", async () => {
    const f = fixture();
    signInDefaultClaude(f, "ANN@example.com");
    writeJson(NodePath.join(f.home, ".codex", "auth.json"), {
      tokens: { id_token: jwt({ email: "bob@example.com" }) },
    });
    const dee: MoveEntry = { provider: "claude", email: "dee@example.com" };
    const fay: MoveEntry = { provider: "claude", email: "fay@example.com" };
    const eve: MoveEntry = { provider: "codex", email: "eve@example.com" };
    writeList(f, [
      { provider: "claude", email: "ann@example.com" },
      dee,
      fay,
      { provider: "codex", email: "bob@example.com" },
      eve,
    ]);
    const { move } = makeMove(
      f,
      settingsFor(f, {
        providerInstances: {
          [ProviderInstanceId.make(moveAccountId(dee))]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { homePath: "~/.claude-dee-example-com" },
          },
          // Made by hand: known by its name.
          [ProviderInstanceId.make("claude_work")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Fay@example.com",
            config: { homePath: "~/.claude-work" },
          },
        },
      }),
    );
    await move.boot();
    assert.deepEqual(readList(f).accounts, [eve]);
    // Codex's default home is taken, so Eve gets an instance of her own.
    assert.equal((await move.status()).addTarget.codex, "instance");
  });

  it("stops offering a listed account T3 got another way", async () => {
    const f = fixture();
    const { move } = makeMove(
      f,
      settingsFor(f, {
        providerInstances: {
          [ProviderInstanceId.make("claude_work")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Ann@example.com",
            config: { homePath: "~/.claude-work" },
          },
        },
      }),
    );
    await move.boot();
    // Listed after the start's cleanup ran.
    writeList(f, [ANN, EVE]);
    assert.deepEqual(
      (await move.status()).accounts.map((account) => account.email),
      [EVE.email],
    );
    assert.lengthOf(readList(f).accounts, 2);
  });
});

describe.skipIf(PLATFORM === "win32")("sign-in", () => {
  it("signs an extra Claude account into an instance of its own", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    const main = NodePath.join(f.home, ".claude");
    NodeFS.writeFileSync(NodePath.join(main, "settings.json"), "{}");
    NodeFS.mkdirSync(NodePath.join(main, "skills"));
    writeJson(NodePath.join(f.home, ".claude.json"), {
      oauthAccount: { emailAddress: "main@example.com" },
      mcpServers: { github: { command: "github-mcp" } },
      projects: { "/repo": {} },
    });
    writeList(f, [{ provider: "claude", email: "Ann@Example.com" }]);
    const { move, patches, refreshed } = makeMove(f, settingsFor(f));

    const { accounts, addTarget } = await move.status();
    assert.equal(addTarget.claude, "instance");
    const [account] = accounts;
    const started = await move.startSignIn(account!.id);
    assert.deepEqual(
      { ...started, signInId: "" },
      { signInId: "", url: CLAUDE_URL, acceptsCode: true },
    );
    assert.deepEqual((await move.status()).signIn, {
      signInId: started.signInId,
      provider: "claude",
      accountId: account!.id,
    });
    // Checked like the CLI checks it, and never handed over half.
    assert.throws(
      () => move.submitCode(started.signInId, "code-without-state"),
      "Paste the whole code, including the part after #.",
    );
    assert.throws(() => move.submitCode(started.signInId, "code#"), "the part after #");
    assert.throws(() => move.submitCode("unknown", "code#state"), "no longer running");
    move.submitCode(started.signInId, "  code#state  ");
    const id = ProviderInstanceId.make(
      moveAccountId({ provider: "claude", email: "ann@example.com" }),
    );
    assert.deepEqual(await move.settled(started.signInId), {
      state: "done",
      acceptsCode: true,
      url: CLAUDE_URL,
      email: "Ann@Example.com",
      instanceId: id,
    });
    // A late paste (another tab) gets the outcome, not an error.
    assert.equal(move.submitCode(started.signInId, "code#state").state, "done");

    assert.deepEqual(patches, [
      {
        providerInstances: {
          [id]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Ann@Example.com",
            enabled: true,
            config: {
              homePath: "~/.claude-ann-example-com",
              binaryPath: NodePath.join(f.bin, "claude"),
            },
          },
        },
      },
    ]);
    const dir = NodePath.join(f.home, ".claude-ann-example-com");
    assert.equal(
      NodeFS.readlinkSync(NodePath.join(dir, "settings.json")),
      NodePath.join(main, "settings.json"),
    );
    assert.equal(NodeFS.readlinkSync(NodePath.join(dir, "skills")), NodePath.join(main, "skills"));
    assert.deepEqual(JSON.parse(NodeFS.readFileSync(NodePath.join(dir, ".claude.json"), "utf8")), {
      mcpServers: { github: { command: "github-mcp" } },
    });
    const marker = NodePath.join(dir, CLAUDE_ACCOUNT_MARKER);
    assert.equal(NodeFS.statSync(marker).mode & 0o777, 0o600);
    // It names the main config dir the account shares.
    assert.equal(NodeFS.readFileSync(marker, "utf8"), main);
    assert.isFalse(NodeFS.existsSync(NodePath.join(main, CLAUDE_ACCOUNT_MARKER)));
    const [login] = callsOf(f, "auth login");
    assert.equal(login?.CLAUDE_CONFIG_DIR, dir);
    assert.isNull(login?.ANTHROPIC_API_KEY ?? null);
    assert.equal(calls(f).find((call) => call.code !== undefined)?.code, "code#state\n");
    assert.isFalse(NodeFS.existsSync(f.listPath));
    assert.deepEqual(refreshed, []);
  });

  it("signs a wrong account out of the new instance again", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    writeList(f, [{ provider: "claude", email: "ann@example.com" }]);
    const { move, patches } = makeMove(f, settingsFor(f), {
      env: { FAKE_EMAIL: "Other@example.com" },
    });

    const started = await move.startSignIn(
      moveAccountId({ provider: "claude", email: "ann@example.com" }),
    );
    move.submitCode(started.signInId, "code#state");
    const state = await move.settled(started.signInId);
    assert.equal(state.state, "error");
    assert.equal(state.email, "Other@example.com");
    assert.equal(
      state.message,
      "Signed in as Other@example.com. Sign your browser in to ann@example.com and try again.",
    );
    const logouts = callsOf(f, "auth logout");
    assert.lengthOf(logouts, 1);
    assert.equal(logouts[0]?.CLAUDE_CONFIG_DIR, NodePath.join(f.home, ".claude-ann-example-com"));
    assert.deepEqual(patches, []);
    assert.lengthOf(readList(f).accounts, 1);
  });

  it("keeps a wrong account that signed into the default home", async () => {
    const f = fixture();
    writeList(f, [{ provider: "claude", email: "ann@example.com" }]);
    const { move, patches, refreshed } = makeMove(f, settingsFor(f), {
      env: { FAKE_EMAIL: "other@example.com" },
    });
    const { accounts, addTarget } = await move.status();
    assert.equal(addTarget.claude, "default");

    const started = await move.startSignIn(accounts[0]!.id);
    move.submitCode(started.signInId, "code#state");
    const state = await move.settled(started.signInId);
    assert.equal(state.message, "Signed in as other@example.com, which isn't in this list.");
    assert.lengthOf(callsOf(f, "auth logout"), 0);
    assert.isNull(callsOf(f, "auth login")[0]?.CLAUDE_CONFIG_DIR ?? null);
    assert.deepEqual(patches, []);
    assert.deepEqual(refreshed, ["claudeAgent"]);
    // The default home is signed in now, so Ann would get an instance of her own.
    assert.equal((await move.status()).addTarget.claude, "instance");
  });

  it("refuses a separate Claude login without CLAUDE_CONFIG_DIR", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    writeList(f, [{ provider: "claude", email: "ann@example.com" }]);
    const { move } = makeMove(f, settingsFor(f), {
      claudeEnvironment: async (_homePath, base) => base,
    });
    const error = await move
      .startSignIn(moveAccountId({ provider: "claude", email: "ann@example.com" }))
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    assert.instanceOf(error, Error);
    assert.include((error as Error).message, "CLAUDE_CONFIG_DIR");
    assert.lengthOf(callsOf(f, "auth login"), 0);
  });

  it("signs Codex into the default home, keeping the API key login it replaces", async () => {
    const f = fixture();
    const codexHome = NodePath.join(f.home, ".codex");
    writeJson(NodePath.join(codexHome, "auth.json"), { OPENAI_API_KEY: "sk-fake-openai" });
    const bob: MoveEntry = {
      provider: "codex",
      email: "bob@example.com",
      plan: "ChatGPT Plus Subscription",
    };
    writeList(f, [bob]);
    const { move, patches, refreshed } = makeMove(f, settingsFor(f), {
      env: { FAKE_EMAIL: "bob@example.com" },
    });

    const started = await move.startSignIn(moveAccountId(bob));
    assert.deepEqual(
      { ...started, signInId: "" },
      { signInId: "", url: CODEX_URL, acceptsCode: false },
    );
    assert.equal((await move.settled(started.signInId)).state, "done");
    assert.include(
      NodeFS.readFileSync(NodePath.join(codexHome, "auth.json.before-t3-move"), "utf8"),
      "sk-fake-openai",
    );
    assert.equal(callsOf(f, "login")[0]?.CODEX_HOME, codexHome);
    assert.deepEqual(patches, []);
    assert.deepEqual(refreshed, ["codex"]);
    assert.isFalse(NodeFS.existsSync(f.listPath));
  });

  it("finishes when the CLI exits, even while something it started holds its output", async () => {
    const f = fixture();
    writeList(f, [EVE]);
    const { move } = makeMove(f, settingsFor(f), {
      env: { FAKE_EMAIL: "eve@example.com", FAKE_CODEX_LOGIN: "grandchild" },
    });
    const grandchild = () => calls(f).find((call) => call.grandchild !== undefined)?.grandchild;
    try {
      const started = await move.startSignIn(moveAccountId(EVE));
      assert.equal((await move.settled(started.signInId)).state, "done");
      // Still running: the sign-in didn't wait for it.
      assert.isTrue(process.kill(grandchild()!, 0));
    } finally {
      const pid = grandchild();
      if (pid !== undefined) process.kill(pid);
    }
  });

  it("only keeps the clicked account in its new instance", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    const bob: MoveEntry = { provider: "claude", email: "bob@example.com" };
    writeList(f, [ANN, bob]);
    // Bob is on the list too, but Ann's row was clicked.
    const { move, patches } = makeMove(f, settingsFor(f), {
      env: { FAKE_EMAIL: "Bob@example.com" },
    });
    const started = await move.startSignIn(moveAccountId(ANN));
    move.submitCode(started.signInId, "code#state");
    const state = await move.settled(started.signInId);
    assert.equal(
      state.message,
      "Signed in as Bob@example.com. Sign your browser in to ann@example.com and try again.",
    );
    const logouts = callsOf(f, "auth logout");
    assert.deepEqual(
      logouts.map((call) => call.CLAUDE_CONFIG_DIR),
      [NodePath.join(f.home, ".claude-ann-example-com")],
    );
    assert.deepEqual(patches, []);
    assert.deepEqual(readList(f).accounts, [ANN, bob]);
  });

  it("keeps an account its new dir is signed in to already, without a login", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    // An earlier sign-in that landed but was never saved.
    writeJson(NodePath.join(f.home, ".claude-ann-example-com", "fake-login.json"), {
      email: "ann@example.com",
    });
    writeList(f, [ANN]);
    const { move, patches } = makeMove(f, settingsFor(f));
    const started = await move.startSignIn(moveAccountId(ANN));
    assert.deepEqual(started, { signInId: started.signInId, acceptsCode: true });
    assert.deepEqual(move.signInState(started.signInId), {
      state: "done",
      acceptsCode: true,
      email: "ann@example.com",
      instanceId: moveAccountId(ANN),
    });
    assert.lengthOf(callsOf(f, "auth login"), 0);
    assert.lengthOf(patches, 1);
    assert.isFalse(NodeFS.existsSync(f.listPath));
  });

  it("refuses Claude sign-ins while settings use something else instead", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    writeList(f, [ANN]);
    const { move, patches } = makeMove(f, settingsFor(f), {
      env: { FAKE_AUTH_METHOD: "api_key_helper" },
    });
    assert.equal(
      await failure(move.startSignIn(moveAccountId(ANN))),
      "Claude Code is set to use an API key helper (in its settings.json), which overrides any sign-in. Remove it, then sign in.",
    );
    assert.lengthOf(callsOf(f, "auth login"), 0);
    assert.lengthOf(callsOf(f, "auth logout"), 0);
    assert.isTrue(NodeFS.existsSync(NodePath.join(f.home, ".claude", "fake-login.json")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(f.home, ".claude-ann-example-com")));
    assert.deepEqual(patches, []);
  });

  it("tells a replaced sign-in's poller that another one started", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    const bob: MoveEntry = { provider: "claude", email: "bob@example.com" };
    writeList(f, [ANN, bob]);
    const { move } = makeMove(f, settingsFor(f));
    const first = await move.startSignIn(moveAccountId(ANN));
    const second = await move.startSignIn(moveAccountId(bob));
    assert.deepEqual(move.signInState(first.signInId), {
      state: "error",
      acceptsCode: false,
      message: "Another sign-in started.",
    });
    assert.throws(() => move.submitCode(first.signInId, "code#state"), "Another sign-in started.");
    assert.equal(move.signInState("unknown").message, "This sign-in is no longer running.");
    await move.cancelSignIn(second.signInId);
    assert.equal(move.submitCode(second.signInId, "code#state").message, "Sign-in cancelled.");
    assert.lengthOf(
      calls(f).filter((call) => call.code !== undefined),
      0,
    );
  });

  it("launches nothing once the server is stopping", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    writeList(f, [ANN]);
    const { move } = makeMove(f, settingsFor(f));
    await move.status();
    const started = move.startSignIn(moveAccountId(ANN));
    move.close();
    assert.equal(await failure(started), "The server stopped.");
    assert.lengthOf(callsOf(f, "auth login"), 0);
    assert.isFalse(NodeFS.existsSync(NodePath.join(f.home, ".claude-ann-example-com")));
  });

  it("ends a login the server stopped during", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    writeList(f, [ANN]);
    let stopServer = () => {};
    const { move } = makeMove(f, settingsFor(f), {
      // The server stops while the login is being spawned.
      resolveSpawn: async (command, args) => {
        if (args[1] === "login") stopServer();
        return { command, args, shell: false };
      },
    });
    stopServer = () => move.close();
    // Resolves only once the login (which waits for a code) is gone.
    assert.equal(await failure(move.startSignIn(moveAccountId(ANN))), "The server stopped.");
    assert.isUndefined((await move.status()).signIn);
  });

  it("signs Codex into a missing default home, creating it", async () => {
    const f = fixture();
    writeList(f, [EVE]);
    const { move } = makeMove(f, settingsFor(f), { env: { FAKE_EMAIL: "eve@example.com" } });
    const { accounts, addTarget } = await move.status();
    assert.equal(addTarget.codex, "default");
    // A home that doesn't exist is signed out: no CLI asked.
    assert.lengthOf(callsOf(f, "login status"), 0);
    const started = await move.startSignIn(accounts[0]!.id);
    assert.equal((await move.settled(started.signInId)).state, "done");
    const auth = NodePath.join(f.home, ".codex", "auth.json");
    assert.include(NodeFS.readFileSync(auth, "utf8"), "id_token");
  });

  it("counts a Codex login kept outside auth.json", async () => {
    const f = fixture();
    NodeFS.mkdirSync(NodePath.join(f.home, ".codex"));
    writeList(f, [EVE]);
    const signedOut = makeMove(f, settingsFor(f));
    assert.equal((await signedOut.move.status()).addTarget.codex, "default");
    const keyring = makeMove(f, settingsFor(f), { env: { FAKE_CODEX_KEYRING: "1" } });
    assert.equal((await keyring.move.status()).addTarget.codex, "instance");
    assert.deepEqual(
      callsOf(f, "login status").map((call) => call.CODEX_HOME),
      [NodePath.join(f.home, ".codex"), NodePath.join(f.home, ".codex")],
    );
  });

  it("never signs into the shared home of a managed default Codex", async () => {
    const f = fixture();
    writeList(f, [EVE]);
    const base = settingsFor(f);
    const { move, patches } = makeMove(
      f,
      {
        ...base,
        providers: { ...base.providers, codex: { ...base.providers.codex, setupMode: "managed" } },
      },
      { env: { FAKE_EMAIL: "eve@example.com" } },
    );
    assert.equal((await move.status()).addTarget.codex, "instance");
    const started = await move.startSignIn(moveAccountId(EVE));
    assert.equal((await move.settled(started.signInId)).state, "done");
    assert.equal(
      callsOf(f, "login")[0]?.CODEX_HOME,
      NodePath.join(f.home, ".codex-eve-example-com"),
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(f.home, ".codex", "auth.json")));
    assert.lengthOf(patches, 1);
  });

  it("shares the CODEX_HOME the default Codex runs with", async () => {
    const f = fixture();
    const shared = NodePath.join(f.home, "work-codex");
    signInCodex(shared, "main@example.com");
    writeList(f, [EVE]);
    const materialized: Array<readonly [string, string]> = [];
    const { move, patches } = makeMove(f, settingsFor(f), {
      env: { CODEX_HOME: shared, FAKE_EMAIL: "eve@example.com" },
      materializeCodexHome: async (homePath, shadowHomePath) => {
        materialized.push([homePath, shadowHomePath]);
        const dir = NodePath.join(f.home, shadowHomePath.slice(2));
        NodeFS.mkdirSync(dir, { recursive: true });
        return dir;
      },
    });
    // Signed in there, so Eve gets an instance of her own on it.
    assert.equal((await move.status()).addTarget.codex, "instance");
    const started = await move.startSignIn(moveAccountId(EVE));
    assert.equal((await move.settled(started.signInId)).state, "done");
    assert.deepEqual(materialized, [[shared, "~/.codex-eve-example-com"]]);
    assert.deepEqual(patches, [
      {
        providerInstances: {
          [ProviderInstanceId.make(moveAccountId(EVE))]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "eve@example.com",
            enabled: true,
            config: {
              setupMode: "existing",
              shadowHomePath: "~/.codex-eve-example-com",
              homePath: shared,
              binaryPath: NodePath.join(f.bin, "codex"),
            },
          },
        },
      },
    ]);
    assert.isFalse(NodeFS.existsSync(NodePath.join(f.home, ".codex")));
  });

  it("gives Codex a standalone home where symlinks can't be made", async () => {
    const f = fixture();
    const shared = NodePath.join(f.home, ".codex");
    signInCodex(shared, "main@example.com");
    NodeFS.writeFileSync(NodePath.join(shared, "config.toml"), 'model = "gpt-5"\n');
    writeList(f, [EVE]);
    const { move, patches } = makeMove(f, settingsFor(f), {
      env: { FAKE_EMAIL: "eve@example.com" },
      canSymlink: async () => false,
      materializeCodexHome: async () => {
        throw new Error("no shadow home without symlinks");
      },
    });
    const started = await move.startSignIn(moveAccountId(EVE));
    assert.equal((await move.settled(started.signInId)).state, "done");
    const home = NodePath.join(f.home, ".codex-eve-example-com");
    assert.equal(callsOf(f, "login")[0]?.CODEX_HOME, home);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(home, "config.toml"), "utf8"),
      'model = "gpt-5"\n',
    );
    assert.deepEqual(patches, [
      {
        providerInstances: {
          [ProviderInstanceId.make(moveAccountId(EVE))]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "eve@example.com",
            enabled: true,
            config: {
              setupMode: "existing",
              homePath: "~/.codex-eve-example-com",
              binaryPath: NodePath.join(f.bin, "codex"),
            },
          },
        },
      },
    ]);
  });

  it("signs a new Codex home out when the login saved no account", async () => {
    const f = fixture();
    signInCodex(NodePath.join(f.home, ".codex"), "main@example.com");
    writeList(f, [EVE]);
    const { move, patches } = makeMove(f, settingsFor(f), {
      env: { FAKE_CODEX_LOGIN: "nothing" },
    });
    const started = await move.startSignIn(moveAccountId(EVE));
    const state = await move.settled(started.signInId);
    assert.equal(state.message, "Codex finished without a signed-in account.");
    assert.deepEqual(
      callsOf(f, "logout").map((call) => call.CODEX_HOME),
      [NodePath.join(f.home, ".codex-eve-example-com")],
    );
    assert.deepEqual(patches, []);
  });

  it("puts the replaced Codex login back when the sign-in fails", async () => {
    const f = fixture();
    const codexHome = NodePath.join(f.home, ".codex");
    writeJson(NodePath.join(codexHome, "auth.json"), { OPENAI_API_KEY: "sk-fake-openai" });
    writeList(f, [EVE]);
    const { move } = makeMove(f, settingsFor(f), { env: { FAKE_CODEX_LOGIN: "fail" } });
    assert.equal(await failure(move.startSignIn(moveAccountId(EVE))), "Error: port 1455 is in use");
    assert.include(
      NodeFS.readFileSync(NodePath.join(codexHome, "auth.json"), "utf8"),
      "sk-fake-openai",
    );
    assert.deepEqual(NodeFS.readdirSync(codexHome), ["auth.json"]);
  });
});

/** The new account dirs (`~/.claude-account-<hex>`, `~/.codex-account-<hex>`) in the temp home. */
const accountDirs = (f: Fixture) =>
  NodeFS.readdirSync(f.home).filter((name) => /^\.(claude|codex)-account-/.test(name));

describe.skipIf(PLATFORM === "win32")("accounts", () => {
  it("adds a Claude account as an instance of its own, whichever one signs in", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    const main = NodePath.join(f.home, ".claude");
    NodeFS.writeFileSync(NodePath.join(main, "settings.json"), "{}");
    const zed: MoveEntry = { provider: "claude", email: "zed@example.com" };
    writeList(f, [zed, ANN]);
    const { move, patches, refreshed } = makeMove(f, settingsFor(f), {
      env: { FAKE_EMAIL: "Zed@Example.com" },
    });
    // Codex's default home doesn't exist yet, so a new Codex account would land there.
    assert.deepEqual((await move.status()).addTarget, { claude: "instance", codex: "default" });

    const started = await move.addAccount("claude");
    assert.deepEqual(
      { ...started, signInId: "" },
      { signInId: "", url: CLAUDE_URL, acceptsCode: true },
    );
    assert.deepEqual((await move.status()).signIn, {
      signInId: started.signInId,
      provider: "claude",
    });
    move.submitCode(started.signInId, "code#state");
    const id = moveAccountId(zed);
    assert.deepEqual(await move.settled(started.signInId), {
      state: "done",
      acceptsCode: true,
      url: CLAUDE_URL,
      email: "Zed@Example.com",
      instanceId: id,
    });

    const [login] = callsOf(f, "auth login");
    assert.deepEqual(login?.args, ["auth", "login"]);
    const dir = login!.CLAUDE_CONFIG_DIR!;
    const homePath = `~/${NodePath.basename(dir)}`;
    assert.match(homePath, /^~\/\.claude-account-[0-9a-f]{6}$/);
    assert.equal(NodePath.dirname(dir), f.home);
    assert.deepEqual(patches, [
      {
        providerInstances: {
          [ProviderInstanceId.make(id)]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Zed@Example.com",
            enabled: true,
            config: { homePath, binaryPath: NodePath.join(f.bin, "claude") },
          },
        },
      },
    ]);
    assert.equal(NodeFS.readFileSync(NodePath.join(dir, CLAUDE_ACCOUNT_MARKER), "utf8"), main);
    assert.equal(
      NodeFS.readlinkSync(NodePath.join(dir, "settings.json")),
      NodePath.join(main, "settings.json"),
    );
    // The list's entry for that account is done with.
    assert.deepEqual(readList(f).accounts, [ANN]);
    assert.deepEqual(refreshed, []);
  });

  it("checks a new Claude account's training as soon as it signs in, while kept off", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    const { move, terminals } = makeMove(f, settingsFor(f), {
      env: { FAKE_EMAIL: "zed@example.com" },
    });
    const runs = () =>
      terminals.map(({ task, target }) => [task, target.env.CLAUDE_CONFIG_DIR ?? "main"]);
    await move.privacy.setKeepOff(true);
    await move.privacy.idle();
    assert.deepEqual(runs(), [["check", "main"]]);

    const started = await move.addAccount("claude");
    move.submitCode(started.signInId, "code#state");
    const { instanceId } = await move.settled(started.signInId);
    await move.privacy.idle();
    const dir = callsOf(f, "auth login")[0]?.CLAUDE_CONFIG_DIR;
    assert.deepEqual(runs(), [
      ["check", "main"],
      ["check", dir],
    ]);
    assert.deepEqual(
      (await move.status()).privacy?.claude.map((entry) => [entry.instanceId, entry.training]),
      [
        [instanceId, "off"],
        ["claudeAgent", "off"],
      ],
    );
  });

  it("refuses an account T3 has already, signing its new dir out and deleting it", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    // The browser is still signed in to the main account.
    const { move, patches } = makeMove(f, settingsFor(f), {
      env: { FAKE_EMAIL: "Main@example.com" },
    });
    const started = await move.addAccount("claude");
    const dir = callsOf(f, "auth login")[0]!.CLAUDE_CONFIG_DIR!;
    assert.isTrue(NodeFS.existsSync(dir));
    move.submitCode(started.signInId, "code#state");
    assert.deepEqual(await move.settled(started.signInId), {
      state: "error",
      acceptsCode: true,
      url: CLAUDE_URL,
      email: "Main@example.com",
      message: "Main@example.com is already in T3.",
    });
    assert.deepEqual(
      callsOf(f, "auth logout").map((call) => call.CLAUDE_CONFIG_DIR),
      [dir],
    );
    assert.isFalse(NodeFS.existsSync(dir));
    assert.deepEqual(accountDirs(f), []);
    assert.deepEqual(patches, []);
    // The main account stays signed in.
    assert.isTrue(NodeFS.existsSync(NodePath.join(f.home, ".claude", "fake-login.json")));

    // An instance made by hand counts too, by its display name.
    const g = fixture();
    signInDefaultClaude(g, "main@example.com");
    const other = makeMove(
      g,
      settingsFor(g, {
        providerInstances: {
          [ProviderInstanceId.make("claude_work")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "ann@example.com",
            config: { homePath: "~/.claude-work" },
          },
        },
      }),
      { env: { FAKE_EMAIL: "ann@example.com" } },
    );
    const again = await other.move.addAccount("claude");
    other.move.submitCode(again.signInId, "code#state");
    assert.equal(
      (await other.move.settled(again.signInId)).message,
      "ann@example.com is already in T3.",
    );
    assert.deepEqual(accountDirs(g), []);
    assert.deepEqual(other.patches, []);
  });

  it("deletes a cancelled account's dir, never what its links point to", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    const main = NodePath.join(f.home, ".claude");
    NodeFS.writeFileSync(NodePath.join(main, "settings.json"), '{"model":"opus"}');
    writeJson(NodePath.join(main, "skills", "review", "SKILL.md"), "review");
    const { move, patches } = makeMove(f, settingsFor(f));
    const started = await move.addAccount("claude");
    const dir = callsOf(f, "auth login")[0]!.CLAUDE_CONFIG_DIR!;
    assert.isTrue(NodeFS.lstatSync(NodePath.join(dir, "skills")).isSymbolicLink());

    assert.isUndefined((await move.cancelSignIn(started.signInId)).signIn);
    assert.equal(move.signInState(started.signInId).message, "Sign-in cancelled.");
    assert.isFalse(NodeFS.existsSync(dir));
    assert.equal(
      NodeFS.readFileSync(NodePath.join(main, "settings.json"), "utf8"),
      '{"model":"opus"}',
    );
    assert.isTrue(NodeFS.existsSync(NodePath.join(main, "skills", "review", "SKILL.md")));
    assert.deepEqual(
      callsOf(f, "auth logout").map((call) => call.CLAUDE_CONFIG_DIR),
      [dir],
    );
    assert.deepEqual(patches, []);
  });

  it("adds an account into a default home that has no sign-in yet", async () => {
    const f = fixture();
    const { move, patches, refreshed } = makeMove(f, settingsFor(f), {
      env: { FAKE_EMAIL: "ann@example.com" },
    });
    assert.equal((await move.status()).addTarget.claude, "default");
    const started = await move.addAccount("claude");
    move.submitCode(started.signInId, "code#state");
    const state = await move.settled(started.signInId);
    assert.deepEqual(
      [state.state, state.email, state.instanceId],
      ["done", "ann@example.com", "claudeAgent"],
    );
    const [login] = callsOf(f, "auth login");
    assert.deepEqual(login?.args, ["auth", "login"]);
    assert.isNull(login?.CLAUDE_CONFIG_DIR ?? null);
    assert.deepEqual(patches, []);
    assert.deepEqual(refreshed, ["claudeAgent"]);
    assert.deepEqual(accountDirs(f), []);
    // Signed in there now: the next account gets an instance of its own.
    assert.equal((await move.status()).addTarget.claude, "instance");
  });

  it("signs the default home out again when the account added there is one T3 has", async () => {
    const f = fixture();
    const { move, patches } = makeMove(
      f,
      settingsFor(f, {
        providerInstances: {
          [ProviderInstanceId.make("claude_work")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "ann@example.com",
            config: { homePath: "~/.claude-work" },
          },
        },
      }),
      { env: { FAKE_EMAIL: "ann@example.com" } },
    );
    assert.equal((await move.status()).addTarget.claude, "default");
    const started = await move.addAccount("claude");
    move.submitCode(started.signInId, "code#state");
    const state = await move.settled(started.signInId);
    assert.deepEqual(
      [state.state, state.message],
      ["error", "ann@example.com is already in T3, so the main account stays signed out."],
    );
    assert.deepEqual(
      callsOf(f, "auth logout").map((call) => call.CLAUDE_CONFIG_DIR),
      [null],
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(f.home, ".claude", "fake-login.json")));
    assert.equal((await move.status()).addTarget.claude, "default");
    assert.deepEqual(patches, []);
  });

  it("puts the default Codex home back when the account added there is one T3 has", async () => {
    const providerInstances = {
      [ProviderInstanceId.make("codex_work")]: {
        driver: ProviderDriverKind.make("codex"),
        displayName: "eve@example.com",
        config: { setupMode: "existing", shadowHomePath: "~/.codex-work" },
      },
    };
    const message = "eve@example.com is already in T3, so the main account stays signed out.";
    // The API key login the sign-in moved aside comes back.
    const f = fixture();
    const codexHome = NodePath.join(f.home, ".codex");
    writeJson(NodePath.join(codexHome, "auth.json"), { OPENAI_API_KEY: "sk-fake-openai" });
    const { move } = makeMove(f, settingsFor(f, { providerInstances }), {
      env: { FAKE_EMAIL: "eve@example.com" },
    });
    assert.equal((await move.status()).addTarget.codex, "default");
    const started = await move.addAccount("codex");
    assert.equal((await move.settled(started.signInId)).message, message);
    assert.include(
      NodeFS.readFileSync(NodePath.join(codexHome, "auth.json"), "utf8"),
      "sk-fake-openai",
    );
    assert.deepEqual(NodeFS.readdirSync(codexHome), ["auth.json"]);
    assert.lengthOf(callsOf(f, "logout"), 0);
    assert.equal((await move.status()).addTarget.codex, "default");

    // With none moved aside, Codex's own logout signs it out.
    const g = fixture();
    const other = makeMove(g, settingsFor(g, { providerInstances }), {
      env: { FAKE_EMAIL: "eve@example.com" },
    });
    const again = await other.move.addAccount("codex");
    assert.equal((await other.move.settled(again.signInId)).message, message);
    assert.deepEqual(
      callsOf(g, "logout").map((call) => call.CODEX_HOME),
      [NodePath.join(g.home, ".codex")],
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(g.home, ".codex", "auth.json")));
    assert.equal((await other.move.status()).addTarget.codex, "default");
  });

  it("adds a Codex account in a shadow home on the shared home", async () => {
    const f = fixture();
    signInCodex(NodePath.join(f.home, ".codex"), "main@example.com");
    const materialized: Array<readonly [string, string]> = [];
    const { move, patches } = makeMove(f, settingsFor(f), {
      env: { FAKE_EMAIL: "eve@example.com" },
      materializeCodexHome: async (homePath, shadowHomePath) => {
        materialized.push([homePath, shadowHomePath]);
        return NodePath.join(f.home, shadowHomePath.slice(2));
      },
    });
    assert.equal((await move.status()).addTarget.codex, "instance");
    const started = await move.addAccount("codex");
    assert.deepEqual(
      { ...started, signInId: "" },
      { signInId: "", url: CODEX_URL, acceptsCode: false },
    );
    const state = await move.settled(started.signInId);
    assert.equal(state.instanceId, moveAccountId(EVE));
    assert.lengthOf(materialized, 1);
    const [shared, shadowHomePath] = materialized[0]!;
    assert.equal(shared, "");
    assert.match(shadowHomePath, /^~\/\.codex-account-[0-9a-f]{6}$/);
    assert.equal(
      callsOf(f, "login")[0]?.CODEX_HOME,
      NodePath.join(f.home, shadowHomePath.slice(2)),
    );
    assert.deepEqual(patches, [
      {
        providerInstances: {
          [ProviderInstanceId.make(moveAccountId(EVE))]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "eve@example.com",
            enabled: true,
            config: {
              setupMode: "existing",
              shadowHomePath,
              binaryPath: NodePath.join(f.bin, "codex"),
            },
          },
        },
      },
    ]);
  });

  it("deletes a failed Codex account's shadow home, keeping the shared home", async () => {
    const f = fixture();
    const shared = NodePath.join(f.home, ".codex");
    signInCodex(shared, "main@example.com");
    writeJson(NodePath.join(shared, "sessions", "rollout.jsonl"), "history");
    const { move, patches } = makeMove(f, settingsFor(f), {
      env: { FAKE_CODEX_LOGIN: "fail" },
      // Like the driver: the shadow home links the shared home's entries.
      materializeCodexHome: async (_homePath, shadowHomePath) => {
        const dir = NodePath.join(f.home, shadowHomePath.slice(2));
        NodeFS.symlinkSync(NodePath.join(shared, "sessions"), NodePath.join(dir, "sessions"));
        return dir;
      },
    });
    assert.equal(await failure(move.addAccount("codex")), "Error: port 1455 is in use");
    const home = callsOf(f, "login")[0]!.CODEX_HOME!;
    assert.isFalse(NodeFS.existsSync(home));
    assert.deepEqual(
      callsOf(f, "logout").map((call) => call.CODEX_HOME),
      [home],
    );
    assert.isTrue(NodeFS.existsSync(NodePath.join(shared, "sessions", "rollout.jsonl")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(shared, "auth.json")));
    assert.deepEqual(patches, []);
  });

  it("removes an account instance, signed out with its own CLI, and only that one", async () => {
    const f = fixture();
    const claude = NodePath.join(f.bin, "claude");
    const codex = NodePath.join(f.bin, "codex");
    const ann = NodePath.join(f.home, ".claude-ann-example-com");
    writeJson(NodePath.join(ann, "fake-login.json"), { email: "ann@example.com" });
    const eve = NodePath.join(f.home, ".codex-eve-example-com");
    signInCodex(eve, "eve@example.com");
    const instances = {
      claude_1a2b3c4d: {
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "ann@example.com",
        config: { homePath: "~/.claude-ann-example-com", binaryPath: claude },
      },
      claude_2b3c4d5e: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { homePath: "~/.claude-bob-example-com", binaryPath: "/missing/claude" },
      },
      // Shares the main config dir: its logout would sign the main account out.
      claude_shared: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { binaryPath: claude },
      },
      codex_1a2b3c4d: {
        driver: ProviderDriverKind.make("codex"),
        config: {
          setupMode: "existing",
          shadowHomePath: "~/.codex-eve-example-com",
          binaryPath: codex,
        },
      },
      codex_managed: {
        driver: ProviderDriverKind.make("codex"),
        config: { setupMode: "managed", binaryPath: codex },
      },
      cursor_work: { driver: ProviderDriverKind.make("cursor") },
    };
    const logged: string[] = [];
    const { move, settings } = makeMove(
      f,
      settingsFor(f, {
        providerInstances: Object.fromEntries(
          Object.entries(instances).map(([id, instance]) => [
            ProviderInstanceId.make(id),
            instance,
          ]),
        ),
      }),
      { log: (message) => logged.push(message) },
    );
    const saved = () => Object.keys(settings().providerInstances).sort();

    await move.removeAccount("claude_1a2b3c4d");
    const [claudeLogout] = callsOf(f, "auth logout");
    assert.equal(claudeLogout?.CLAUDE_CONFIG_DIR, ann);
    assert.isNull(claudeLogout?.ANTHROPIC_API_KEY ?? null);
    assert.isFalse(NodeFS.existsSync(NodePath.join(ann, "fake-login.json")));
    // The dir stays: its threads' transcripts point into it.
    assert.isTrue(NodeFS.existsSync(ann));

    await move.removeAccount("codex_1a2b3c4d");
    assert.deepEqual(
      callsOf(f, "logout").map((call) => call.CODEX_HOME),
      [eve],
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(eve, "auth.json")));
    assert.isTrue(NodeFS.existsSync(eve));

    // T3 keeps a managed instance's sign-in: removing it is enough.
    await move.removeAccount("codex_managed");
    assert.lengthOf(
      calls(f).filter((call) => call.args.includes("logout")),
      2,
    );

    // A logout that can't run is logged, not fatal.
    await move.removeAccount("claude_2b3c4d5e");
    assert.include(logged, "Signing claude_2b3c4d5e out failed");

    assert.deepEqual(saved(), ["claude_shared", "cursor_work"]);
    for (const [id, message] of [
      ["claudeAgent", "The main account can't be removed."],
      ["codex", "The main account can't be removed."],
      ["cursor_work", "Only Claude and Codex accounts can be removed here."],
      ["claude_gone", "That account isn't in T3 anymore."],
      [
        "claude_shared",
        "This account uses the main Claude config dir, so signing it out would sign the main account out.",
      ],
    ] as const) {
      assert.equal(await failure(move.removeAccount(id)), message);
    }
    assert.deepEqual(saved(), ["claude_shared", "cursor_work"]);
    assert.lengthOf(callsOf(f, "auth logout"), 1);
  });

  it("doesn't sign out a sign-in another instance still uses", async () => {
    const f = fixture();
    const claude = NodePath.join(f.bin, "claude");
    const codex = NodePath.join(f.bin, "codex");
    const ann = NodePath.join(f.home, ".claude-ann-example-com");
    writeJson(NodePath.join(ann, "fake-login.json"), { email: "ann@example.com" });
    const eve = NodePath.join(f.home, ".codex-eve-example-com");
    signInCodex(eve, "eve@example.com");
    const instances = {
      claude_1a2b3c4d: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { homePath: "~/.claude-ann-example-com", binaryPath: claude },
      },
      // The same dir, written another way.
      claude_copy: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { homePath: ann, binaryPath: claude },
      },
      codex_1a2b3c4d: {
        driver: ProviderDriverKind.make("codex"),
        config: {
          setupMode: "existing",
          shadowHomePath: "~/.codex-eve-example-com",
          binaryPath: codex,
        },
      },
      codex_copy: {
        driver: ProviderDriverKind.make("codex"),
        config: { setupMode: "existing", homePath: "~/.codex-eve-example-com", binaryPath: codex },
      },
    };
    const logged: string[] = [];
    const { move, settings } = makeMove(
      f,
      settingsFor(f, {
        providerInstances: Object.fromEntries(
          Object.entries(instances).map(([id, instance]) => [
            ProviderInstanceId.make(id),
            instance,
          ]),
        ),
      }),
      { log: (message) => logged.push(message) },
    );

    await move.removeAccount("claude_1a2b3c4d");
    await move.removeAccount("codex_1a2b3c4d");

    assert.deepEqual(
      calls(f).filter((call) => call.args.includes("logout")),
      [],
    );
    assert.isTrue(NodeFS.existsSync(NodePath.join(ann, "fake-login.json")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(eve, "auth.json")));
    assert.deepEqual(Object.keys(settings().providerInstances).sort(), [
      "claude_copy",
      "codex_copy",
    ]);
    assert.include(
      logged,
      `Didn't sign claude_1a2b3c4d out: claude_copy uses the same sign-in (${ann})`,
    );
    // The last instance on it is signed out.
    await move.removeAccount("claude_copy");
    assert.deepEqual(
      callsOf(f, "auth logout").map((call) => call.CLAUDE_CONFIG_DIR),
      [ann],
    );

    // A default Codex on a shadow home of its own counts too.
    const g = fixture();
    const shadow = NodePath.join(g.home, ".codex-main");
    signInCodex(shadow, "main@example.com");
    const base = settingsFor(g);
    const other = makeMove(g, {
      ...base,
      providers: {
        ...base.providers,
        codex: { ...base.providers.codex, shadowHomePath: "~/.codex-main" },
      },
      providerInstances: {
        [ProviderInstanceId.make("codex_main")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { setupMode: "existing", shadowHomePath: "~/.codex-main", binaryPath: codex },
        },
      },
    });
    await other.move.removeAccount("codex_main");
    assert.lengthOf(callsOf(g, "logout"), 0);
    assert.isTrue(NodeFS.existsSync(NodePath.join(shadow, "auth.json")));
    assert.deepEqual(other.settings().providerInstances, {});
  });
});

describe.skipIf(PLATFORM === "win32")("signing an account in again", () => {
  const ANN_ID = "claude_1a2b3c4d";
  const annInstance = (f: Fixture) => ({
    [ProviderInstanceId.make(ANN_ID)]: {
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "ann@example.com",
      config: { homePath: "~/.claude-ann-example-com", binaryPath: NodePath.join(f.bin, "claude") },
    },
  });

  it("signs a Claude account in again in its own config dir", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    const dir = NodePath.join(f.home, ".claude-ann-example-com");
    writeJson(NodePath.join(dir, ".claude.json"), { mcpServers: {} });
    const { move, patches, refreshed } = makeMove(
      f,
      settingsFor(f, { providerInstances: annInstance(f) }),
    );

    const started = await move.signInAgain(ANN_ID);
    assert.deepEqual(
      { ...started, signInId: "" },
      { signInId: "", url: CLAUDE_URL, acceptsCode: true },
    );
    assert.deepEqual((await move.status()).signIn, {
      signInId: started.signInId,
      provider: "claude",
      instanceId: ANN_ID,
    });
    // Only `done` names the instance.
    assert.isUndefined(move.signInState(started.signInId).instanceId);
    move.submitCode(started.signInId, "code#state");
    assert.deepEqual(await move.settled(started.signInId), {
      state: "done",
      acceptsCode: true,
      url: CLAUDE_URL,
      email: "ann@example.com",
      instanceId: ANN_ID,
    });

    const [login] = callsOf(f, "auth login");
    assert.deepEqual(login?.args, ["auth", "login", "--email", "ann@example.com"]);
    assert.equal(login?.CLAUDE_CONFIG_DIR, dir);
    assert.isNull(login?.ANTHROPIC_API_KEY ?? null);
    assert.deepEqual(
      JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "fake-login.json"), "utf8")),
      { email: "ann@example.com" },
    );
    assert.lengthOf(callsOf(f, "auth logout"), 0);
    assert.deepEqual(patches, []);
    assert.deepEqual(refreshed, [ANN_ID]);
  });

  it("signs another account out of the dir again, keeping the dir", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    const dir = NodePath.join(f.home, ".claude-ann-example-com");
    writeJson(NodePath.join(dir, ".claude.json"), { mcpServers: {} });
    const { move, patches, refreshed } = makeMove(
      f,
      settingsFor(f, { providerInstances: annInstance(f) }),
      { env: { FAKE_EMAIL: "Other@example.com" } },
    );

    const started = await move.signInAgain(ANN_ID);
    move.submitCode(started.signInId, "code#state");
    const state = await move.settled(started.signInId);
    assert.deepEqual(
      [state.state, state.email, state.message, state.instanceId],
      [
        "error",
        "Other@example.com",
        "Signed in as Other@example.com. Sign your browser in to ann@example.com and try again.",
        undefined,
      ],
    );
    assert.deepEqual(
      callsOf(f, "auth logout").map((call) => call.CLAUDE_CONFIG_DIR),
      [dir],
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "fake-login.json")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(dir, ".claude.json")));
    // The main account is untouched.
    assert.isTrue(NodeFS.existsSync(NodePath.join(f.home, ".claude", "fake-login.json")));
    assert.deepEqual(patches, []);
    assert.deepEqual(refreshed, []);
  });

  it("signs a Codex account in again in its shadow home", async () => {
    const f = fixture();
    signInCodex(NodePath.join(f.home, ".codex"), "main@example.com");
    const home = NodePath.join(f.home, ".codex-eve-example-com");
    NodeFS.mkdirSync(home);
    const id = "codex_1a2b3c4d";
    const { move, patches, refreshed } = makeMove(
      f,
      settingsFor(f, {
        providerInstances: {
          [ProviderInstanceId.make(id)]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "eve@example.com",
            config: {
              setupMode: "existing",
              shadowHomePath: "~/.codex-eve-example-com",
              binaryPath: NodePath.join(f.bin, "codex"),
            },
          },
        },
      }),
      { env: { FAKE_EMAIL: "eve@example.com" } },
    );

    const started = await move.signInAgain(id);
    assert.deepEqual(
      { ...started, signInId: "" },
      { signInId: "", url: CODEX_URL, acceptsCode: false },
    );
    const state = await move.settled(started.signInId);
    assert.deepEqual([state.state, state.email, state.instanceId], ["done", "eve@example.com", id]);
    assert.equal(callsOf(f, "login")[0]?.CODEX_HOME, home);
    assert.isTrue(NodeFS.existsSync(NodePath.join(home, "auth.json")));
    assert.deepEqual(patches, []);
    assert.deepEqual(refreshed, [id]);
  });

  it("ends a sign-in again when its account is removed, before the logout", async () => {
    const f = fixture();
    signInDefaultClaude(f, "main@example.com");
    const dir = NodePath.join(f.home, ".claude-ann-example-com");
    const { move, settings } = makeMove(f, settingsFor(f, { providerInstances: annInstance(f) }));

    const started = await move.signInAgain(ANN_ID);
    await move.removeAccount(ANN_ID);

    // Ended (CLI gone) by the time the removal answers.
    const state = move.signInState(started.signInId);
    assert.deepEqual([state.state, state.message], ["error", "The account was removed."]);
    assert.deepEqual(
      calls(f)
        .filter((call) => call.args[0] === "auth" && call.args[1] !== "status")
        .map((call) => [call.args.slice(0, 2).join(" "), call.CLAUDE_CONFIG_DIR]),
      [
        ["auth login", dir],
        ["auth logout", dir],
      ],
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "fake-login.json")));
    assert.deepEqual(settings().providerInstances, {});
  });

  it("refuses main accounts, managed Codex, shared dirs and other providers", async () => {
    const f = fixture();
    const { move } = makeMove(
      f,
      settingsFor(f, {
        providerInstances: {
          [ProviderInstanceId.make("claude_shared")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "ann@example.com",
            config: {},
          },
          [ProviderInstanceId.make("codex_managed")]: {
            driver: ProviderDriverKind.make("codex"),
            config: { setupMode: "managed" },
          },
          [ProviderInstanceId.make("cursor_work")]: { driver: ProviderDriverKind.make("cursor") },
        },
      }),
    );
    for (const [id, message] of [
      ["claudeAgent", "Sign the main account in with Add account."],
      ["codex", "Sign the main account in with Add account."],
      ["codex_managed", "Sign in under More provider settings."],
      [
        "claude_shared",
        "This account shares the main Claude config dir, so it signs in with the main account.",
      ],
      ["cursor_work", "Only Claude and Codex accounts can be signed in here."],
      ["claude_gone", "That account isn't in T3 anymore."],
    ] as const) {
      assert.equal(await failure(move.signInAgain(id)), message);
    }
    assert.deepEqual(
      calls(f).filter((call) => call.args.includes("login") || call.args.includes("logout")),
      [],
    );
  });
});
