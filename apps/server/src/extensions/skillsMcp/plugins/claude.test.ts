import { assert, describe, it } from "@effect/vitest";

import {
  claudeMutationArgs,
  claudeUpdateAvailable,
  marketplaceLatest,
  parseClaudeMutationOutput,
  parseClaudePluginDetails,
  parseClaudePluginList,
  parseKnownMarketplaces,
} from "./claude.ts";

// Captured from Claude Code 2.1.282 against a throwaway CLAUDE_CONFIG_DIR.
const LIST_JSON = JSON.stringify([
  {
    id: "demo@t3-test-mkt",
    version: "1.1.0",
    scope: "user",
    enabled: true,
    installPath: "/tmp/claude-cfg/plugins/cache/t3-test-mkt/demo/1.1.0",
    installedAt: "2026-09-25T20:36:14.393Z",
    lastUpdated: "2026-09-25T20:36:14.393Z",
    mcpServers: { "demo-mcp": { command: "echo", args: ["hi"] } },
  },
]);

const LIST_AVAILABLE_JSON = JSON.stringify({
  installed: [],
  available: [
    {
      pluginId: "demo@t3-test-mkt",
      name: "demo",
      description: "Demo plugin for T3 tests",
      marketplaceName: "t3-test-mkt",
      version: "1.1.0",
      source: "./plugins/demo",
    },
  ],
});

const DEMO_DETAILS = `demo 1.1.0
  Description: Demo plugin for T3 tests
  Source: demo@t3-test-mkt

Component inventory
  Skills (2)  greet, hello
  Agents (1)  reviewer
  Hooks (0)
  MCP servers (1)  demo-mcp  (tool schemas resolved at runtime; not counted)
  LSP servers (0)

Projected token cost
  Always-on:   ~34 tok   added to every session
`;

const VERCEL_DETAILS = `\u001b[1mvercel 0.44.0\u001b[0m
  Description: Build and deploy web apps and agents
  Source: vercel@claude-plugins-official

Component inventory
  Skills (28)  ai-gateway, ai-sdk, auth, bootstrap, chat-sdk, deployments-cicd, env-vars, knowledge-update, marketplace, microfrontends, next-cache-components, next-forge, next-upgrade, nextjs, react-best-practices, routing-middleware, runtime-cache, shadcn, turbopack, vercel-agent, vercel-cli, vercel-connect, vercel-firewall, vercel-functions, vercel-sandbox, vercel-storage, verification, workflow
  Agents (0)
  Hooks (2)  SessionStart, SessionEnd  (harness-only — no model context cost)
  MCP servers (1)  vercel  (tool schemas resolved at runtime; not counted)
  LSP servers (0)

Per-component (rounded)
  Component        Always-on   On invoke
  auth             ~90         ~3.1k
  Skills (3)  not, a, real-inventory-line
`;

const output = (stdout: string, code = 0, stderr = "") => ({ stdout, stderr, code });

describe("parseClaudePluginList", () => {
  it("reads installed entries with their MCP servers", () => {
    const parsed = parseClaudePluginList(LIST_JSON);
    assert.deepStrictEqual(parsed, {
      installed: [
        {
          id: "demo@t3-test-mkt",
          name: "demo",
          marketplace: "t3-test-mkt",
          version: "1.1.0",
          enabled: true,
          scope: "user",
          installPath: "/tmp/claude-cfg/plugins/cache/t3-test-mkt/demo/1.1.0",
          mcpServers: ["demo-mcp"],
        },
      ],
      available: [],
    });
  });

  it("reads the --available envelope", () => {
    const parsed = parseClaudePluginList(LIST_AVAILABLE_JSON);
    assert.deepStrictEqual(parsed?.installed, []);
    assert.deepStrictEqual(parsed?.available, [
      {
        app: "claude",
        id: "demo@t3-test-mkt",
        name: "demo",
        marketplace: "t3-test-mkt",
        version: "1.1.0",
        description: "Demo plugin for T3 tests",
        installed: false,
        enabled: false,
        contributes: { skills: [], mcpServers: [], commands: [], agents: [] },
      },
    ]);
  });

  it("keeps one row per plugin, preferring user scope, and skips installed ones from available", () => {
    const parsed = parseClaudePluginList(
      JSON.stringify({
        installed: [
          { id: "a@m", scope: "project", enabled: false, version: "1" },
          { id: "a@m", scope: "user", enabled: true, version: "2" },
          { id: "a@m", scope: "local", enabled: false, version: "3" },
          { nope: true },
        ],
        available: [{ pluginId: "a@m" }, { pluginId: "z@m" }, { pluginId: "b@m" }],
      }),
    );
    assert.strictEqual(parsed?.installed.length, 1);
    assert.strictEqual(parsed?.installed[0]?.scope, "user");
    assert.strictEqual(parsed?.installed[0]?.version, "2");
    assert.deepStrictEqual(
      parsed?.available.map((row) => row.id),
      ["b@m", "z@m"],
    );
  });

  it("tolerates a banner before the JSON and rejects non-JSON", () => {
    assert.strictEqual(
      parseClaudePluginList(`warning: something\n${LIST_JSON}`)?.installed.length,
      1,
    );
    assert.strictEqual(parseClaudePluginList("No plugins installed"), undefined);
  });
});

describe("parseClaudePluginDetails", () => {
  it("reads the component inventory", () => {
    assert.deepStrictEqual(parseClaudePluginDetails(DEMO_DETAILS), {
      description: "Demo plugin for T3 tests",
      skills: ["greet", "hello"],
      agents: ["reviewer"],
      mcpServers: ["demo-mcp"],
      commands: [],
      hooks: [],
    });
  });

  it("strips ANSI and trailing notes and ignores the per-component table", () => {
    const details = parseClaudePluginDetails(VERCEL_DETAILS);
    assert.strictEqual(details?.description, "Build and deploy web apps and agents");
    assert.strictEqual(details?.skills.length, 28);
    assert.strictEqual(details?.skills[0], "ai-gateway");
    assert.strictEqual(details?.skills.at(-1), "workflow");
    assert.deepStrictEqual(details?.hooks, ["SessionStart", "SessionEnd"]);
    assert.deepStrictEqual(details?.mcpServers, ["vercel"]);
    assert.deepStrictEqual(details?.agents, []);
  });

  it("drops elision markers and returns undefined without an inventory", () => {
    assert.deepStrictEqual(parseClaudePluginDetails("  Skills (5)  a, b, +3 more")?.skills, [
      "a",
      "b",
    ]);
    assert.strictEqual(parseClaudePluginDetails("Plugin not found"), undefined);
  });
});

describe("marketplace versions", () => {
  it("maps known marketplaces to their clones", () => {
    const locations = parseKnownMarketplaces({
      "t3-test-mkt": { source: { source: "directory" }, installLocation: "/tmp/claude-mkt-test" },
      broken: { installLocation: "" },
      other: "nope",
    });
    assert.deepStrictEqual([...locations], [["t3-test-mkt", "/tmp/claude-mkt-test"]]);
  });

  it("reads a plugin's version, git sha or local source", () => {
    const manifest = {
      plugins: [
        { name: "demo", version: "1.2.0", source: "./plugins/demo" },
        { name: "git", source: { source: "github", repo: "o/r", sha: "abcdef1234567" } },
        { name: "local", source: "./plugins/local" },
      ],
    };
    assert.deepStrictEqual(marketplaceLatest(manifest, "demo"), {
      version: "1.2.0",
      sha: undefined,
      localSource: "./plugins/demo",
    });
    assert.strictEqual(marketplaceLatest(manifest, "git")?.sha, "abcdef1234567");
    assert.strictEqual(marketplaceLatest(manifest, "local")?.localSource, "./plugins/local");
    assert.strictEqual(marketplaceLatest(manifest, "missing"), undefined);
  });

  it("compares versions, or short shas for unversioned git plugins", () => {
    assert.strictEqual(claudeUpdateAvailable("1.1.0", { version: "1.2.0" }), true);
    assert.strictEqual(claudeUpdateAvailable("1.2.0", { version: "1.2.0" }), false);
    assert.strictEqual(claudeUpdateAvailable("abcdef123456", { sha: "abcdef1234567890" }), false);
    assert.strictEqual(claudeUpdateAvailable("abcdef123456", { sha: "0123456789abcdef" }), true);
    assert.strictEqual(claudeUpdateAvailable("unknown", { sha: "0123456789abcdef" }), undefined);
    assert.strictEqual(claudeUpdateAvailable(undefined, { version: "1" }), undefined);
    assert.strictEqual(claudeUpdateAvailable("1", undefined), undefined);
  });
});

describe("mutations", () => {
  const install = { action: "install", app: "claude", id: "demo@t3-test-mkt" } as const;
  const disable = { action: "disable", app: "claude", id: "demo@t3-test-mkt" } as const;
  const uninstall = { action: "uninstall", app: "claude", id: "demo@t3-test-mkt" } as const;
  const update = { action: "update", app: "claude", id: "demo@t3-test-mkt" } as const;

  it("always targets user scope and never auto-confirms", () => {
    assert.deepStrictEqual(claudeMutationArgs("enable", "demo@t3-test-mkt"), [
      "plugin",
      "enable",
      "demo@t3-test-mkt",
      "--scope",
      "user",
      "--json",
    ]);
  });

  it("reports success messages", () => {
    const installed = parseClaudeMutationOutput(
      output(
        '{"command":"install","outcome":"ok","plugin":"demo@t3-test-mkt","pluginId":"demo@t3-test-mkt","scope":"user","message":"Successfully installed plugin: demo@t3-test-mkt (scope: user)"}\n',
      ),
      install,
    );
    assert.deepStrictEqual(installed, {
      ok: true,
      message: "Successfully installed plugin: demo@t3-test-mkt (scope: user)",
    });
    const updated = parseClaudeMutationOutput(
      output(
        '{"command":"update","outcome":"ok","pluginId":"demo@t3-test-mkt","updateOutcome":"updated","oldVersion":"1.1.0","newVersion":"1.2.0","message":"Plugin \\"demo\\" updated from 1.1.0 to 1.2.0 for scope user. Restart to apply changes."}\n',
      ),
      update,
    );
    assert.isTrue(updated.ok);
    assert.include(updated.message, "from 1.1.0 to 1.2.0");
  });

  it("treats already-in-goal-state as success", () => {
    const outcome = parseClaudeMutationOutput(
      output(
        '{"command":"disable","outcome":"failed","pluginId":"demo@t3-test-mkt","message":"Plugin \\"demo@t3-test-mkt\\" is already disabled at user scope","failureCode":"already_in_goal_state","alreadyInGoalState":true}\n✘ Failed to disable plugin\n',
        1,
      ),
      disable,
    );
    assert.deepStrictEqual(outcome, {
      ok: true,
      message: 'Plugin "demo@t3-test-mkt" is already disabled at user scope',
    });
  });

  it("surfaces the CLI's failure reason", () => {
    const outcome = parseClaudeMutationOutput(
      output(
        '{"command":"uninstall","outcome":"failed","pluginId":"demo@t3-test-mkt","failureCode":"not_installed","message":"Plugin \\"demo@t3-test-mkt\\" not found in installed plugins"}\n',
        1,
      ),
      uninstall,
    );
    assert.deepStrictEqual(outcome, {
      ok: false,
      message: 'Plugin "demo@t3-test-mkt" not found in installed plugins',
    });
    assert.deepStrictEqual(parseClaudeMutationOutput(output("", 2, "boom\n"), install), {
      ok: false,
      message: "boom",
    });
    assert.deepStrictEqual(parseClaudeMutationOutput(output("", 3), install), {
      ok: false,
      message: "exit code 3",
    });
  });

  it("asks for a terminal when the marketplace declares a command to run", () => {
    const outcome = parseClaudeMutationOutput(
      output(
        '{"command":"install","outcome":"failed","message":"Confirmation required","shownCommand":"npx something"}\n',
        1,
      ),
      install,
    );
    assert.isFalse(outcome.ok);
    assert.include(outcome.message, "claude plugin install demo@t3-test-mkt");
  });
});
