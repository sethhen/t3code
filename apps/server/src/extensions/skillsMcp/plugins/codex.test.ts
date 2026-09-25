import { assert, describe, it } from "@effect/vitest";

import {
  appsNeedingAuth,
  codexDetailFromRead,
  codexPluginLocator,
  codexPluginsFromList,
  codexUpdateAvailable,
  pickInstalledVersion,
} from "./codex.ts";

// Trimmed from codex-cli 0.157.0 `plugin/list` / `plugin/read` responses.
const LIST_RESULT = {
  marketplaces: [
    {
      name: "t3-test-mkt",
      path: "/tmp/codex-mkt-test/.agents/plugins/marketplace.json",
      interface: null,
      plugins: [
        {
          id: "demo-plugin@t3-test-mkt",
          name: "demo-plugin",
          version: null,
          localVersion: "1.1.0",
          source: { type: "local", path: "/tmp/codex-mkt-test/plugins/demo-plugin" },
          installed: true,
          enabled: true,
          installPolicy: "AVAILABLE",
          authPolicy: "ON_INSTALL",
          availability: "AVAILABLE",
          interface: { displayName: "Demo", shortDescription: "Demo plugin for T3 tests" },
        },
        {
          id: "other-plugin@t3-test-mkt",
          name: "other-plugin",
          version: null,
          localVersion: "2.0.0",
          installed: true,
          enabled: false,
          installPolicy: "AVAILABLE",
          availability: "AVAILABLE",
          interface: null,
        },
        {
          id: "blocked@t3-test-mkt",
          name: "blocked",
          installed: false,
          enabled: false,
          installPolicy: "NOT_AVAILABLE",
          availability: "AVAILABLE",
        },
      ],
    },
    {
      name: "openai-api-curated",
      path: null,
      plugins: [
        {
          id: "sentry@openai-api-curated",
          name: "sentry",
          version: "1.0.3",
          localVersion: null,
          installed: false,
          enabled: true,
          installPolicy: "AVAILABLE",
          availability: "DISABLED_BY_ADMIN",
          interface: { shortDescription: null, longDescription: "Sentry issues" },
        },
        { id: "demo-plugin@t3-test-mkt", name: "duplicate" },
        { broken: true },
      ],
    },
  ],
  marketplaceLoadErrors: [],
  featuredPluginIds: [],
};

const READ_RESULT = {
  plugin: {
    marketplaceName: "t3-test-mkt",
    marketplacePath: "/tmp/codex-mkt-test/.agents/plugins/marketplace.json",
    summary: { id: "demo-plugin@t3-test-mkt" },
    description: "Demo plugin for T3 tests",
    skills: [
      { name: "demo-plugin:hello", description: "Say hello" },
      { name: "demo-plugin:hello" },
    ],
    hooks: [],
    apps: [],
    mcpServers: ["demo-mcp", { name: "other-mcp" }],
  },
};

describe("codexPluginsFromList", () => {
  const plugins = codexPluginsFromList(LIST_RESULT)!;

  it("reads every marketplace, first id wins", () => {
    assert.deepStrictEqual(
      plugins.map((plugin) => plugin.id),
      [
        "demo-plugin@t3-test-mkt",
        "other-plugin@t3-test-mkt",
        "blocked@t3-test-mkt",
        "sentry@openai-api-curated",
      ],
    );
    assert.deepStrictEqual(plugins[0], {
      id: "demo-plugin@t3-test-mkt",
      name: "demo-plugin",
      marketplace: "t3-test-mkt",
      marketplacePath: "/tmp/codex-mkt-test/.agents/plugins/marketplace.json",
      latestVersion: "1.1.0",
      installed: true,
      enabled: true,
      installable: true,
      description: "Demo plugin for T3 tests",
    });
  });

  it("derives enabled and installable state", () => {
    const [, other, blocked, sentry] = plugins;
    assert.isFalse(other!.enabled);
    assert.isFalse(blocked!.installable);
    assert.isFalse(sentry!.installable);
    // Not installed means not enabled, whatever the config says.
    assert.isFalse(sentry!.enabled);
    assert.strictEqual(sentry!.latestVersion, "1.0.3");
    assert.strictEqual(sentry!.description, "Sentry issues");
  });

  it("rejects results without marketplaces", () => {
    assert.strictEqual(codexPluginsFromList({}), undefined);
    assert.strictEqual(codexPluginsFromList(null), undefined);
  });

  it("addresses local marketplaces by path and remote ones by name", () => {
    assert.deepStrictEqual(codexPluginLocator(plugins[0]!), {
      pluginName: "demo-plugin",
      marketplacePath: "/tmp/codex-mkt-test/.agents/plugins/marketplace.json",
    });
    assert.deepStrictEqual(codexPluginLocator(plugins[3]!), {
      pluginName: "sentry",
      remoteMarketplaceName: "openai-api-curated",
    });
  });
});

describe("codexDetailFromRead", () => {
  it("strips the plugin namespace from skills and reads MCP servers", () => {
    assert.deepStrictEqual(codexDetailFromRead(READ_RESULT), {
      description: "Demo plugin for T3 tests",
      contributes: {
        skills: ["hello"],
        mcpServers: ["demo-mcp", "other-mcp"],
        commands: [],
        agents: [],
      },
    });
    assert.strictEqual(codexDetailFromRead({}), undefined);
  });
});

describe("installed versions", () => {
  it("prefers the marketplace version when cached, else the newest", () => {
    assert.strictEqual(pickInstalledVersion(["1.0.0", "1.1.0"], "1.1.0"), "1.1.0");
    assert.strictEqual(pickInstalledVersion(["1.2.0", "1.10.0", "1.9.0"], "2.0.0"), "1.10.0");
    assert.strictEqual(pickInstalledVersion([], "1.0.0"), undefined);
  });

  it("only reports an update when both versions are known", () => {
    const demo = codexPluginsFromList(LIST_RESULT)![0]!;
    assert.strictEqual(codexUpdateAvailable(demo, "1.0.0"), true);
    assert.strictEqual(codexUpdateAvailable(demo, "1.1.0"), false);
    assert.strictEqual(codexUpdateAvailable(demo, undefined), undefined);
    assert.strictEqual(codexUpdateAvailable({ ...demo, installed: false }, "1.0.0"), undefined);
    assert.strictEqual(
      codexUpdateAvailable({ ...demo, latestVersion: undefined }, "1.0.0"),
      undefined,
    );
  });
});

describe("appsNeedingAuth", () => {
  it("names connector apps that still need a sign-in", () => {
    assert.deepStrictEqual(
      appsNeedingAuth({
        appsNeedingAuth: [
          { id: "gh", name: "GitHub" },
          { id: "linear" },
          { id: "gh", name: "GitHub" },
        ],
        authPolicy: "ON_INSTALL",
      }),
      ["GitHub", "linear"],
    );
    assert.deepStrictEqual(appsNeedingAuth({ appsNeedingAuth: [], authPolicy: "ON_USE" }), []);
    assert.deepStrictEqual(appsNeedingAuth({}), []);
  });
});
