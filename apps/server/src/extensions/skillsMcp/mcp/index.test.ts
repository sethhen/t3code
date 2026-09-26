import type { AgentApp } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { adoptUserServers, codexWriteHeld, reconcileUserServers } from "./index.ts";
import type { ConfigServer } from "./parse.ts";
import { makeMcpPresets } from "./presets.ts";
import { specFromClaude, specFromCodex } from "./spec.ts";
import type { StoredMcpServer } from "./store.ts";

const claude = (name: string, entry: Record<string, unknown>, scope = "user"): ConfigServer => ({
  app: "claude",
  name,
  scope: scope as ConfigServer["scope"],
  entry,
  spec: specFromClaude(entry),
  disabled: false,
});

const codex = (name: string, entry: Record<string, unknown>, scope = "user"): ConfigServer => ({
  app: "codex",
  name,
  scope: scope as ConfigServer["scope"],
  entry,
  spec: specFromCodex(entry),
  disabled: entry.enabled === false,
});

const sequentialIds = () => {
  let next = 0;
  return () => `id-${++next}`;
};

const adopt = (
  configs: Partial<Record<AgentApp, ReadonlyArray<ConfigServer>>>,
  existing: ReadonlyArray<StoredMcpServer> = [],
) =>
  adoptUserServers(
    existing,
    { claude: configs.claude ?? [], codex: configs.codex ?? [] },
    sequentialIds(),
  );

describe("reconcileUserServers", () => {
  const node = { type: "stdio", command: "node" } as const;
  const stored = (name: string, apps: StoredMcpServer["apps"]): StoredMcpServer => ({
    id: `stored-${name}`,
    name,
    spec: node,
    apps,
    tags: [],
  });

  it("adopts a user server added after the first list", () => {
    const { servers, changed } = reconcileUserServers(
      [stored("old", { claude: true, codex: true })],
      {
        claude: [claude("old", node), claude("mixpanel", node)],
        codex: [codex("old", { command: "node" })],
      },
      sequentialIds(),
    );
    assert.isTrue(changed);
    assert.deepStrictEqual(
      servers.map((server) => [server.name, server.apps]),
      [
        ["old", { claude: true, codex: true }],
        ["mixpanel", { claude: true, codex: false }],
      ],
    );
  });

  it("drops a server removed with the CLI from every app it was on in", () => {
    const { servers, changed } = reconcileUserServers(
      [
        stored("gone", { claude: true, codex: true }),
        stored("half", { claude: true, codex: true }),
      ],
      { claude: [claude("half", node)], codex: [] },
      sequentialIds(),
    );
    assert.isTrue(changed);
    // `half` lost only its Codex entry: it stays, so the panel can restore it.
    assert.deepStrictEqual(
      servers.map((server) => server.name),
      ["half"],
    );
  });

  it("keeps servers switched off everywhere and those in an app it could not read", () => {
    const existing = [
      stored("off", { claude: false, codex: false }),
      stored("codexOnly", { claude: false, codex: true }),
    ];
    const { servers, changed } = reconcileUserServers(
      existing,
      { claude: [], codex: undefined },
      sequentialIds(),
    );
    assert.isFalse(changed);
    assert.deepStrictEqual(servers, existing);
  });
});

describe("adoptUserServers", () => {
  it("adopts user servers from either app, one entry per name", () => {
    const { servers, added } = adopt({
      claude: [claude("both", { type: "stdio", command: "node", args: ["a.js"], env: {} })],
      codex: [
        codex("both", { command: "node", args: ["a.js"], enabled: true }),
        codex("codexOnly", { url: "https://x/mcp", enabled: false }),
      ],
    });
    assert.strictEqual(added, 2);
    assert.deepStrictEqual(servers, [
      {
        id: "id-1",
        name: "both",
        spec: { type: "stdio", command: "node", args: ["a.js"] },
        apps: { claude: true, codex: true },
        tags: [],
      },
      {
        id: "id-2",
        name: "codexOnly",
        spec: { type: "http", url: "https://x/mcp" },
        apps: { claude: false, codex: false },
        tags: [],
      },
    ]);
  });

  it("keeps both definitions when the apps disagree, with Claude's as the spec", () => {
    const { servers } = adopt({
      claude: [claude("s", { type: "http", url: "https://c/mcp", timeout: 5000 })],
      codex: [
        codex("s", {
          command: "node",
          startup_timeout_sec: 20,
          enabled_tools: ["a"],
          enabled: true,
        }),
      ],
    });
    assert.deepStrictEqual(servers[0], {
      id: "id-1",
      name: "s",
      spec: { type: "http", url: "https://c/mcp" },
      apps: { claude: true, codex: true },
      tags: [],
      extras: { claude: { timeout: 5000 } },
      raw: {
        codex: { command: "node", startup_timeout_sec: 20, enabled_tools: ["a"], enabled: true },
      },
    });
  });

  it("keeps one definition and both apps' extras when the apps agree", () => {
    const { servers } = adopt({
      claude: [claude("s", { command: "node", timeout: 5000 })],
      codex: [codex("s", { command: "node", startup_timeout_sec: 20, type: "stdio" })],
    });
    assert.deepStrictEqual(servers[0]?.extras, {
      claude: { timeout: 5000 },
      codex: { startup_timeout_sec: 20 },
    });
    assert.isUndefined(servers[0]?.raw);
  });

  it("enables Codex for an SSE server only when Codex has its own definition", () => {
    const sse = claude("s", { type: "sse", url: "https://x/sse" });
    assert.deepStrictEqual(adopt({ claude: [sse] }).servers[0]?.apps, {
      claude: true,
      codex: false,
    });
    const both = adopt({ claude: [sse], codex: [codex("s", { url: "https://x/mcp" })] }).servers[0];
    assert.deepStrictEqual(both?.apps, { claude: true, codex: true });
    assert.deepStrictEqual(both?.raw, { codex: { url: "https://x/mcp", enabled: true } });
  });

  it("skips taken, builtin, invalid, non-user and unmodelled servers", () => {
    const existing: StoredMcpServer = {
      id: "kept",
      name: "taken",
      spec: { type: "stdio", command: "old" },
      apps: { claude: true, codex: true },
      tags: [],
    };
    const { servers, added } = adopt(
      {
        claude: [
          claude("taken", { command: "new" }),
          claude("t3-code", { command: "x" }),
          claude("has.dot", { command: "x" }),
          claude("proj", { command: "x" }, "project"),
          claude("local", { command: "x" }, "local"),
          claude("inproc", { type: "sdk", name: "inproc" }),
        ],
        codex: [
          codex("admin", { command: "x" }, "managed"),
          codex("plug", { command: "x" }, "plugin"),
        ],
      },
      [existing],
    );
    assert.strictEqual(added, 0);
    assert.deepStrictEqual(servers, [existing]);
  });

  it("adopts servers whose layer is unknown", () => {
    const { servers } = adopt({ codex: [codex("orphan", { command: "x" }, "unknown")] });
    assert.deepStrictEqual(
      servers.map((server) => server.name),
      ["orphan"],
    );
  });
});

describe("makeMcpPresets", () => {
  it("wraps npx in cmd /c on Windows only", () => {
    const time = (platform: NodeJS.Platform) =>
      makeMcpPresets(platform).find((preset) => preset.id === "time")?.spec;
    assert.deepStrictEqual(time("darwin"), {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-time"],
    });
    assert.deepStrictEqual(time("win32"), {
      type: "stdio",
      command: "cmd",
      args: ["/c", "npx", "-y", "@modelcontextprotocol/server-time"],
    });
  });

  it("has unique ids and names both apps accept", () => {
    const presets = makeMcpPresets("linux");
    assert.strictEqual(new Set(presets.map((preset) => preset.id)).size, presets.length);
    for (const preset of presets) assert.match(preset.name, /^[A-Za-z0-9_-]+$/);
  });
});

describe("codexWriteHeld", () => {
  const value = { command: "npx", args: ["-y", "srv"], enabled: true };

  it("checks a written table by spec and enabled flag", () => {
    const write = { name: "srv", value };
    assert.isTrue(codexWriteHeld(write, codex("srv", value)));
    // A stale copy put back the old command, or the table is gone.
    assert.isFalse(codexWriteHeld(write, codex("srv", { ...value, args: ["-y", "old"] })));
    assert.isFalse(codexWriteHeld(write, codex("srv", { ...value, enabled: false })));
    assert.isFalse(codexWriteHeld(write, undefined));
    // Update-only writes skip a missing table.
    assert.isTrue(codexWriteHeld({ ...write, ifPresent: true }, undefined));
  });

  it("checks deletes and toggles", () => {
    assert.isTrue(codexWriteHeld({ name: "srv", value: null }, undefined));
    assert.isFalse(codexWriteHeld({ name: "srv", value: null }, codex("srv", value)));
    assert.isTrue(
      codexWriteHeld({ name: "srv", enabled: false }, codex("srv", { ...value, enabled: false })),
    );
    assert.isFalse(codexWriteHeld({ name: "srv", enabled: false }, codex("srv", value)));
    assert.isTrue(codexWriteHeld({ name: "srv", enabled: true }, codex("srv", value)));
    assert.isFalse(codexWriteHeld({ name: "srv", enabled: true, restore: value }, undefined));
    assert.isTrue(codexWriteHeld({ name: "srv", enabled: true }, undefined));
  });
});
