import { assert, describe, it } from "@effect/vitest";

import {
  claudeLiveServer,
  parseClaudeConfig,
  parseCodexConfig,
  parseCodexStatuses,
} from "./parse.ts";

describe("parseClaudeConfig", () => {
  const claudeJson = {
    mcpServers: {
      shared: { type: "stdio", command: "npx", args: ["-y", "shared"], env: {} },
      remote: { type: "http", url: "https://x/mcp" },
      inproc: { type: "sdk", name: "inproc" },
    },
    projects: {
      "/real/proj": {
        mcpServers: { localOnly: { type: "stdio", command: "local-bin", args: [] } },
        disabledMcpServers: ["remote"],
        disabledMcpjsonServers: ["fromMcpJson"],
      },
      "/other": { mcpServers: { elsewhere: { command: "x" } } },
    },
  };
  const projectMcpJson = {
    mcpServers: {
      fromMcpJson: { command: "proj-bin" },
      shared: { command: "proj-shared" },
    },
  };

  it("reads user, local (under any cwd key) and project scopes from every .mcp.json", () => {
    const servers = parseClaudeConfig({
      claudeJson,
      claudeJsonPath: "/cfg/.claude.json",
      projectMcpJsons: [
        { path: "/real/proj/.mcp.json", json: projectMcpJson },
        {
          path: "/real/.mcp.json",
          json: { mcpServers: { shared: { command: "outer" }, outer: { command: "o" } } },
        },
      ],
      cwdKeys: ["/real/proj", "/link/proj"],
    });
    assert.deepStrictEqual(
      servers.map((server) => [server.scope, server.name, server.source, server.disabled]),
      [
        ["user", "shared", "/cfg/.claude.json", false],
        ["user", "remote", "/cfg/.claude.json", true],
        ["user", "inproc", "/cfg/.claude.json", false],
        ["local", "localOnly", "/cfg/.claude.json", false],
        ["project", "fromMcpJson", "/real/proj/.mcp.json", true],
        ["project", "shared", "/real/proj/.mcp.json", false],
        ["project", "outer", "/real/.mcp.json", false],
      ],
    );
    // The closest `.mcp.json` wins.
    assert.deepStrictEqual(servers[5]?.spec, { type: "stdio", command: "proj-shared" });
    assert.strictEqual(servers[2]?.spec, undefined);
    assert.deepStrictEqual(servers[3]?.spec, { type: "stdio", command: "local-bin" });
    assert.isTrue(servers.every((server) => server.app === "claude"));
  });

  it("only applies disabledMcpjsonServers to .mcp.json servers", () => {
    const servers = parseClaudeConfig({
      claudeJson: {
        mcpServers: { a: { command: "a" } },
        projects: { "/p": { disabledMcpjsonServers: ["a"] } },
      },
      claudeJsonPath: "/cfg/.claude.json",
      projectMcpJsons: [],
      cwdKeys: ["/p"],
    });
    assert.deepStrictEqual(
      servers.map((server) => server.disabled),
      [false],
    );
  });

  it("tolerates missing or malformed files", () => {
    assert.deepStrictEqual(
      parseClaudeConfig({
        claudeJson: undefined,
        claudeJsonPath: "/cfg/.claude.json",
        projectMcpJsons: [{ path: "/p/.mcp.json", json: ["not", "an", "object"] }],
        cwdKeys: ["/p"],
      }),
      [],
    );
  });
});

describe("claudeLiveServer", () => {
  it("maps status, scope, version and tool annotations", () => {
    assert.deepStrictEqual(
      claudeLiveServer({
        name: "echo",
        status: "connected",
        scope: "user",
        serverInfo: { version: "1.2.3" },
        tools: [
          {
            name: "echo",
            description: "Echo the input",
            annotations: { readOnly: true, openWorld: false },
          },
          { name: "bare" },
        ],
      }),
      {
        name: "echo",
        scope: "user",
        status: "connected",
        serverVersion: "1.2.3",
        tools: [
          { name: "echo", description: "Echo the input", readOnly: true, openWorld: false },
          { name: "bare" },
        ],
      },
    );
  });

  it("maps claude.ai and enterprise servers to managed, anything else to unknown", () => {
    const of = (scope: string | undefined, status: string) =>
      claudeLiveServer({ name: "s", status, scope, error: "boom" });
    assert.deepStrictEqual(of("claudeai", "needs-auth"), {
      name: "s",
      scope: "managed",
      source: "claude.ai",
      status: "needs-auth",
      error: "boom",
    });
    assert.include(of("enterprise", "pending"), {
      scope: "managed",
      source: "enterprise",
      status: "pending",
    });
    assert.include(of("dynamic", "weird"), { scope: "unknown", status: "unknown" });
    assert.include(of(undefined, "failed"), { scope: "unknown", status: "failed" });
    assert.include(of("plugin", "disabled"), { scope: "plugin", status: "disabled" });
  });
});

// Captured from codex-cli 0.157.0 (`config/read {includeLayers: false}`) against a
// throwaway CODEX_HOME; the TOML set `type = "stdio"` on echo. Origins trimmed.
const USER_LAYER = {
  name: { type: "user", file: "/tmp/home/config.toml", profile: null },
  version: "sha256:81fde8",
};
const CONFIG_READ = {
  config: {
    model: "gpt-5",
    mcp_servers: {
      broken: {
        command: "/nonexistent/bin",
        args: [],
        environment_id: "local",
        enabled: true,
        tool_timeout_sec: null,
      },
      remote: {
        url: "https://example.invalid/mcp",
        bearer_token_env_var: "EXAMPLE_TOKEN",
        environment_id: "local",
        enabled: true,
        tool_timeout_sec: null,
      },
      off: {
        command: "node",
        args: ["/tmp/echo-server.mjs"],
        environment_id: "local",
        enabled: false,
        tool_timeout_sec: null,
      },
      echo: {
        command: "node",
        args: ["/tmp/echo-server.mjs"],
        environment_id: "local",
        enabled: true,
        startup_timeout_sec: 20,
        tool_timeout_sec: null,
      },
    },
  },
  origins: {
    "mcp_servers.broken.command": USER_LAYER,
    "mcp_servers.remote.url": USER_LAYER,
    "mcp_servers.off.enabled": USER_LAYER,
    "mcp_servers.off.command": USER_LAYER,
    "mcp_servers.echo.args.0": USER_LAYER,
    "mcp_servers.echo.command": USER_LAYER,
  },
};

describe("parseCodexConfig", () => {
  it("parses the captured config/read response", () => {
    const servers = parseCodexConfig(CONFIG_READ);
    assert.deepStrictEqual(
      servers.map((server) => [server.name, server.scope, server.source, server.disabled]),
      [
        ["broken", "user", "/tmp/home/config.toml", false],
        ["remote", "user", "/tmp/home/config.toml", false],
        ["off", "user", "/tmp/home/config.toml", true],
        ["echo", "user", "/tmp/home/config.toml", false],
      ],
    );
    assert.deepStrictEqual(servers[1]?.spec, {
      type: "http",
      url: "https://example.invalid/mcp",
      bearerTokenEnvVar: "EXAMPLE_TOKEN",
    });
    assert.strictEqual(servers[3]?.entry.startup_timeout_sec, 20);
    assert.isTrue(servers.every((server) => server.app === "codex"));
  });

  it("takes the scope from the layer that set command/url, falling back to any key", () => {
    const servers = parseCodexConfig({
      config: {
        mcp_servers: {
          proj: { command: "p" },
          admin: { url: "https://admin/mcp" },
          partial: { command: "x" },
          orphan: { command: "y" },
        },
      },
      origins: {
        "mcp_servers.proj.command": {
          name: { type: "project", dotCodexFolder: "/repo/.codex" },
        },
        "mcp_servers.admin.url": { name: { type: "enterpriseManaged" } },
        "mcp_servers.partial.args.0": { name: { type: "legacyManagedConfigTomlFromFile" } },
      },
    });
    assert.deepStrictEqual(
      servers.map((server) => [server.name, server.scope, server.source]),
      [
        ["proj", "project", "/repo/.codex"],
        ["admin", "managed", undefined],
        ["partial", "managed", undefined],
        ["orphan", "unknown", undefined],
      ],
    );
  });

  it("returns nothing without mcp_servers", () => {
    assert.deepStrictEqual(parseCodexConfig({ config: {} }), []);
    assert.deepStrictEqual(parseCodexConfig(null), []);
  });
});

// Captured from codex-cli 0.157.0 (`mcpServerStatus/list {detail: "full"}`, no
// thread) for the config above: runtimeStatus is always null.
const STATUS_DATA = [
  {
    name: "broken",
    runtimeStatus: null,
    serverInfo: null,
    tools: {},
    resources: [],
    resourceTemplates: [],
    authStatus: "unsupported",
    toolsError: "MCP startup failed: No such file or directory (os error 2)",
  },
  {
    name: "echo",
    runtimeStatus: null,
    serverInfo: {
      name: "echo",
      title: null,
      version: "1.2.3",
      description: null,
      icons: null,
      websiteUrl: null,
    },
    serverCapabilities: { tools: {} },
    tools: {
      echo: {
        name: "echo",
        description: "Echo the input",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
    },
    resources: [],
    resourceTemplates: [],
    authStatus: "unsupported",
    toolsError: null,
  },
  {
    name: "off",
    runtimeStatus: null,
    serverInfo: null,
    tools: {},
    resources: [],
    resourceTemplates: [],
    authStatus: "unsupported",
    toolsError: null,
  },
  {
    name: "remote",
    runtimeStatus: null,
    httpOrigin: "https://example.invalid",
    serverInfo: null,
    tools: {},
    resources: [],
    resourceTemplates: [],
    authStatus: "bearerToken",
    toolsError:
      "MCP startup failed: Environment variable EXAMPLE_TOKEN for MCP server 'remote' is not set",
  },
];

describe("parseCodexStatuses", () => {
  it("infers status from the captured thread-less listing", () => {
    assert.deepStrictEqual(parseCodexStatuses(STATUS_DATA, new Set(["off"])), [
      {
        name: "broken",
        status: "failed",
        error: "MCP startup failed: No such file or directory (os error 2)",
      },
      {
        name: "echo",
        status: "connected",
        serverVersion: "1.2.3",
        tools: [{ name: "echo", description: "Echo the input", readOnly: true, openWorld: false }],
      },
      { name: "off", status: "disabled" },
      {
        name: "remote",
        status: "failed",
        error:
          "MCP startup failed: Environment variable EXAMPLE_TOKEN for MCP server 'remote' is not set",
      },
    ]);
  });

  it("reports an unreached server without an error as unknown", () => {
    assert.deepStrictEqual(parseCodexStatuses([STATUS_DATA[2]], new Set()), [
      { name: "off", status: "unknown" },
    ]);
  });

  it("maps notLoggedIn to needs-auth and plugin servers to the plugin scope", () => {
    assert.deepStrictEqual(
      parseCodexStatuses(
        [
          {
            name: "linear",
            authStatus: "notLoggedIn",
            toolsError: "401",
            tools: {},
            pluginId: "linear@openai-curated",
          },
        ],
        new Set(),
      ),
      [
        {
          name: "linear",
          scope: "plugin",
          source: "linear@openai-curated",
          status: "needs-auth",
          error: "401",
        },
      ],
    );
  });

  it("prefers a runtime status when a thread reports one", () => {
    const statuses = ["notStarted", "starting", "ready", "authenticationRequired", "cancelled"].map(
      (runtimeStatus) =>
        parseCodexStatuses([{ name: "s", runtimeStatus, serverInfo: {}, tools: {} }], new Set())[0]
          ?.status,
    );
    assert.deepStrictEqual(statuses, [
      "not-started",
      "pending",
      "connected",
      "needs-auth",
      "failed",
    ]);
  });

  it("names tools by key when the value has no name, and skips malformed items", () => {
    assert.deepStrictEqual(
      parseCodexStatuses([{ name: "s", tools: { t: {} } }, { tools: {} }, "x"], new Set()),
      [{ name: "s", status: "connected", tools: [{ name: "t" }] }],
    );
  });
});
