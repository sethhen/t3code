/**
 * End-to-end plugin flows against the real `claude` and `codex` CLIs, each
 * pointed at a throwaway config dir (CLAUDE_CONFIG_DIR / CODEX_HOME) and a
 * throwaway local marketplace. Opt in with `SKILLS_MCP_LIVE_TESTS=1`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AgentApp, PluginRow, PluginsMutation } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { resolveAgentClis, runAgentCliOk } from "../shared/agents.ts";
import { listPlugins, mutatePlugins } from "./index.ts";
import { serverConfigLayerTest, serverSettingsLayerTest } from "./t3.ts";

const LIVE = process.env.SKILLS_MCP_LIVE_TESTS === "1";
const TIMEOUT = 5 * 60_000;

const writeTree = Effect.fn("writeTree")(function* (
  root: string,
  files: Readonly<Record<string, string>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, content);
  }
});

const SKILL = "---\nname: hello\ndescription: Say hello\n---\nSay hello.\n";
const MCP = JSON.stringify({ mcpServers: { "demo-mcp": { command: "echo", args: ["hi"] } } });

const claudeMarketplace = (version: string) => ({
  ".claude-plugin/marketplace.json": JSON.stringify({
    name: "t3-test-mkt",
    owner: { name: "T3" },
    plugins: [
      { name: "demo", source: "./plugins/demo", version, description: "Demo plugin for T3 tests" },
    ],
  }),
  "plugins/demo/.claude-plugin/plugin.json": JSON.stringify({
    name: "demo",
    version,
    description: "Demo plugin for T3 tests",
  }),
  "plugins/demo/.mcp.json": MCP,
  "plugins/demo/skills/hello/SKILL.md": SKILL,
  "plugins/demo/commands/greet.md": "---\ndescription: Greet\n---\nGreet the user.\n",
  "plugins/demo/agents/reviewer.md":
    "---\nname: reviewer\ndescription: Reviews code\n---\nReview.\n",
});

const codexMarketplace = (version: string) => ({
  ".agents/plugins/marketplace.json": JSON.stringify({
    name: "t3-test-mkt",
    interface: { displayName: "T3 Test" },
    plugins: [
      {
        name: "demo-plugin",
        source: { source: "local", path: "./plugins/demo-plugin" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Coding",
      },
    ],
  }),
  "plugins/demo-plugin/.codex-plugin/plugin.json": JSON.stringify({
    name: "demo-plugin",
    version,
    description: "Demo plugin for T3 tests",
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: { displayName: "Demo Plugin", shortDescription: "A demo", category: "Coding" },
  }),
  "plugins/demo-plugin/.mcp.json": MCP,
  "plugins/demo-plugin/skills/hello/SKILL.md": SKILL,
});

/** Temp config dirs + marketplaces, with T3 settings pointing both providers at them. */
const withSandbox = <A, E, R>(
  use: (sandbox: {
    readonly claudeMarketplace: string;
    readonly codexMarketplace: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugins-live-" }),
    );
    const claudeHome = path.join(root, "claude-config");
    const codexHome = path.join(root, "codex-home");
    const claudeMkt = path.join(root, "claude-mkt");
    const codexMkt = path.join(root, "codex-mkt");
    yield* writeTree(claudeMkt, claudeMarketplace("1.1.0"));
    yield* writeTree(codexMkt, codexMarketplace("1.1.0"));
    yield* writeTree(codexHome, {
      "config.toml": `[marketplaces.t3-test-mkt]\nsource_type = "local"\nsource = "${codexMkt}"\n`,
    });
    yield* fs.makeDirectory(claudeHome, { recursive: true });

    const layer = Layer.mergeAll(
      serverSettingsLayerTest({
        providers: { claudeAgent: { homePath: claudeHome }, codex: { homePath: codexHome } },
      }),
      serverConfigLayerTest(root, path.join(root, "t3")),
    );
    return yield* Effect.gen(function* () {
      // Never touch the real configs: refuse to run unless both CLIs are sandboxed.
      const { claude, codex } = yield* resolveAgentClis;
      assert.strictEqual(claude.env.CLAUDE_CONFIG_DIR, claudeHome);
      assert.strictEqual(codex.configDir, codexHome);
      assert.strictEqual(codex.codexHomeSetting, codexHome);
      yield* runAgentCliOk(claude, ["plugin", "marketplace", "add", claudeMkt], { cwd: root });
      return yield* use({ claudeMarketplace: claudeMkt, codexMarketplace: codexMkt });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

const overview = (app: AgentApp, includeAvailable = false) =>
  listPlugins({ includeAvailable }).pipe(
    Effect.map((result) => {
      const info = result.apps.find((entry) => entry.app === app);
      assert.isTrue(info?.available, `${app} unavailable: ${info?.error}`);
      assert.isUndefined(info?.error);
      return {
        installed: result.installed.filter((row) => row.app === app),
        available: result.available.filter((row) => row.app === app),
      };
    }),
  );

const installedRow = (app: AgentApp, id: string) =>
  overview(app).pipe(Effect.map(({ installed }) => installed.find((row) => row.id === id)));

const mutate = (mutation: PluginsMutation) =>
  mutatePlugins(mutation).pipe(
    Effect.tap((result) => Effect.log(`[live] ${mutation.app} ${mutation.action}`, result)),
  );

const expectOk = (mutation: PluginsMutation) =>
  mutate(mutation).pipe(
    Effect.tap((result) =>
      Effect.sync(() => assert.deepStrictEqual(result.failures, [], result.failures[0]?.message)),
    ),
  );

const expectFailure = (mutation: PluginsMutation) =>
  mutate(mutation).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        assert.strictEqual(result.failures.length, 1);
        assert.strictEqual(result.failures[0]?.app, mutation.app);
      }),
    ),
  );

const assertRow = (row: PluginRow | undefined, expected: Partial<PluginRow>) => {
  assert.isDefined(row);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepStrictEqual(row?.[key as keyof PluginRow], value, key);
  }
};

describe.skipIf(!LIVE)("plugins (live CLIs, sandboxed)", () => {
  // Real clock: CLI timeouts must not run on the TestClock.
  it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect(
      "Claude: install, disable, enable, update, uninstall",
      () =>
        withSandbox(({ claudeMarketplace: marketplace }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const id = "demo@t3-test-mkt";
            const base = { app: "claude", id } as const;

            const before = yield* overview("claude", true);
            assert.deepStrictEqual(before.installed, []);
            assertRow(
              before.available.find((row) => row.id === id),
              { installed: false, enabled: false, version: "1.1.0" },
            );
            assert.deepStrictEqual((yield* overview("claude")).available, []);

            yield* expectOk({ ...base, action: "install" });
            assertRow(yield* installedRow("claude", id), {
              name: "demo",
              marketplace: "t3-test-mkt",
              version: "1.1.0",
              description: "Demo plugin for T3 tests",
              installed: true,
              enabled: true,
              updateAvailable: false,
              contributes: {
                skills: ["hello"],
                mcpServers: ["demo-mcp"],
                commands: ["greet"],
                agents: ["reviewer"],
              },
            });

            yield* expectOk({ ...base, action: "disable" });
            assertRow(yield* installedRow("claude", id), { enabled: false });
            yield* expectOk({ ...base, action: "disable" });
            yield* expectOk({ ...base, action: "enable" });
            assertRow(yield* installedRow("claude", id), { enabled: true });

            yield* writeTree(marketplace, claudeMarketplace("1.2.0"));
            assertRow(yield* installedRow("claude", id), {
              version: "1.1.0",
              updateAvailable: true,
            });
            const updated = yield* expectOk({ ...base, action: "update" });
            assert.include(updated.message, "1.2.0");
            assertRow(yield* installedRow("claude", id), {
              version: "1.2.0",
              updateAvailable: false,
            });

            yield* expectOk({ ...base, action: "uninstall" });
            assert.isUndefined(yield* installedRow("claude", id));
            yield* expectFailure({ ...base, action: "uninstall" });
            yield* expectFailure({ app: "claude", id: "missing@t3-test-mkt", action: "install" });
            yield* expectFailure({ app: "claude", id: "--help", action: "install" });
            assert.isFalse(yield* fs.exists(path.join(marketplace, "..", "t3", "userdata", "x")));
          }),
        ),
      TIMEOUT,
    );

    it.effect(
      "Codex: install, disable, enable, update (auto-synced), uninstall",
      () =>
        withSandbox(({ codexMarketplace: marketplace }) =>
          Effect.gen(function* () {
            const id = "demo-plugin@t3-test-mkt";
            const base = { app: "codex", id } as const;

            const before = yield* overview("codex", true);
            assert.isUndefined(before.installed.find((row) => row.id === id));
            assertRow(
              before.available.find((row) => row.id === id),
              { installed: false, enabled: false, version: "1.1.0" },
            );

            yield* expectOk({ ...base, action: "install" });
            assertRow(yield* installedRow("codex", id), {
              name: "demo-plugin",
              marketplace: "t3-test-mkt",
              version: "1.1.0",
              installed: true,
              enabled: true,
              updateAvailable: false,
              contributes: {
                skills: ["hello"],
                mcpServers: ["demo-mcp"],
                commands: [],
                agents: [],
              },
            });
            yield* expectOk({ ...base, action: "install" });

            yield* expectOk({ ...base, action: "disable" });
            assertRow(yield* installedRow("codex", id), { enabled: false });
            yield* expectOk({ ...base, action: "enable" });
            assertRow(yield* installedRow("codex", id), { enabled: true });

            yield* expectOk({ ...base, action: "disable" });
            yield* writeTree(marketplace, codexMarketplace("1.2.0"));
            // Codex's app-server re-syncs plugins from local marketplaces by itself, so
            // the listing already shows the new version and update just says so.
            assertRow(yield* installedRow("codex", id), {
              version: "1.2.0",
              updateAvailable: false,
              enabled: false,
            });
            const updated = yield* expectOk({ ...base, action: "update" });
            assert.include(updated.message, "1.2.0");
            assertRow(yield* installedRow("codex", id), {
              version: "1.2.0",
              updateAvailable: false,
              enabled: false,
            });

            yield* expectOk({ ...base, action: "uninstall" });
            assert.isUndefined(yield* installedRow("codex", id));
            yield* expectFailure({ ...base, action: "uninstall" });
            yield* expectFailure({ ...base, action: "enable" });
            yield* expectFailure({ app: "codex", id: "missing@t3-test-mkt", action: "install" });
          }),
        ),
      TIMEOUT,
    );
  });
});
