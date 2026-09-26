import type { AgentApp, McpServerSpec } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { builtinRow } from "./builtin.ts";
import { claudeLiveServer, type ConfigServer, type LiveServer } from "./parse.ts";
import { type AppSnapshot, buildRows, effectiveConfig } from "./rows.ts";
import type { StoredMcpServer } from "./store.ts";

const stdio: McpServerSpec = { type: "stdio", command: "node", args: ["server.js"] };

const config = (
  app: AgentApp,
  name: string,
  overrides: Partial<ConfigServer> = {},
): ConfigServer => ({
  app,
  name,
  scope: "user",
  source: `/${app}/config`,
  entry: {},
  spec: stdio,
  disabled: false,
  ...overrides,
});

const stored = (name: string, overrides: Partial<StoredMcpServer> = {}): StoredMcpServer => ({
  id: `id-${name}`,
  name,
  spec: stdio,
  apps: { claude: true, codex: true },
  tags: [],
  ...overrides,
});

const EMPTY: AppSnapshot = { config: [], live: undefined };

describe("effectiveConfig", () => {
  it("keeps the most specific definition: local, then project, then user", () => {
    const byName = effectiveConfig([
      config("claude", "a", { scope: "user" }),
      config("claude", "a", { scope: "local" }),
      config("claude", "a", { scope: "project" }),
      config("claude", "b", { scope: "managed" }),
      config("claude", "b", { scope: "user" }),
    ]);
    assert.strictEqual(byName.get("a")?.scope, "local");
    assert.strictEqual(byName.get("b")?.scope, "user");
  });
});

describe("buildRows", () => {
  it("merges an unmanaged name found in both apps into one row", () => {
    const live: LiveServer = {
      name: "echo",
      status: "connected",
      serverVersion: "1.2.3",
      tools: [{ name: "echo" }],
    };
    const rows = buildRows({
      store: [],
      apps: {
        claude: { config: [config("claude", "echo")], live: [live] },
        codex: { config: [config("codex", "echo", { disabled: true })], live: [] },
      },
    });
    assert.strictEqual(rows.length, 1);
    const row = rows[0]!;
    assert.strictEqual(row.key, "user:echo");
    assert.isFalse(row.managed);
    assert.deepStrictEqual(row.spec, stdio);
    assert.deepStrictEqual(row.apps.claude, {
      present: true,
      enabled: true,
      scope: "user",
      source: "/claude/config",
      status: "connected",
      serverVersion: "1.2.3",
      tools: [{ name: "echo" }],
      editable: true,
    });
    assert.deepStrictEqual(row.apps.codex, {
      present: true,
      enabled: false,
      scope: "user",
      source: "/codex/config",
      status: "disabled",
      editable: true,
    });
  });

  it("keys unmanaged rows by the scope Claude loads, and live-only servers too", () => {
    const rows = buildRows({
      store: [],
      apps: {
        claude: {
          config: [config("claude", "proj", { scope: "project", spec: undefined })],
          live: [{ name: "remote", scope: "connector", source: "claude.ai", status: "needs-auth" }],
        },
        codex: {
          config: [],
          live: [{ name: "plug", scope: "plugin", status: "failed", error: "x" }],
        },
      },
    });
    assert.deepStrictEqual(
      rows.map((row) => [row.key, row.spec, row.apps.claude?.editable, row.apps.codex?.status]),
      [
        ["plugin:plug", undefined, undefined, "failed"],
        ["project:proj", undefined, false, undefined],
        ["connector:remote", undefined, false, undefined],
      ],
    );
    assert.strictEqual(rows[2]?.apps.claude?.source, "claude.ai");
    assert.strictEqual(rows[1]?.apps.claude?.status, "unknown");
  });

  it("shows a Claude plugin's server as a read-only plugin row", () => {
    const [row] = buildRows({
      store: [],
      apps: {
        claude: {
          config: [],
          live: [
            claudeLiveServer({
              name: "plugin:vercel:vercel",
              status: "needs-auth",
              scope: "dynamic",
              source: "plugin",
            }),
          ],
        },
        codex: { config: [], live: [] },
      },
    });
    assert.strictEqual(row?.key, "plugin:plugin:vercel:vercel");
    assert.include(row?.apps.claude, { scope: "plugin", source: "vercel", editable: false });
  });

  it("keys managed rows by store id and applies the desired per-app flag", () => {
    const rows = buildRows({
      store: [
        stored("echo", {
          apps: { claude: true, codex: false },
          description: "Echo",
          homepage: "https://x",
          tags: ["t"],
        }),
      ],
      apps: {
        claude: {
          config: [config("claude", "echo")],
          live: [{ name: "echo", status: "connected" }],
        },
        codex: { config: [config("codex", "echo")], live: undefined },
      },
    });
    assert.strictEqual(rows.length, 1);
    const row = rows[0]!;
    assert.include(row, {
      key: "id-echo",
      id: "id-echo",
      managed: true,
      builtin: false,
      description: "Echo",
      homepage: "https://x",
    });
    assert.deepStrictEqual(row.tags, ["t"]);
    assert.include(row.apps.claude, { enabled: true, status: "connected", editable: true });
    // Codex still has it (e.g. a pending disable); the desired flag wins.
    assert.include(row.apps.codex, {
      present: true,
      enabled: false,
      status: "unknown",
      editable: true,
    });
  });

  it("reports a desired but missing server, and a switched-off one", () => {
    const rows = buildRows({
      store: [stored("gone"), stored("off", { apps: { claude: false, codex: false } })],
      apps: { claude: EMPTY, codex: EMPTY },
    });
    assert.deepStrictEqual(rows[0]?.apps.claude, {
      present: false,
      enabled: true,
      scope: "user",
      status: "unknown",
      error: "Missing from Claude Code config",
      editable: true,
    });
    assert.strictEqual(rows[0]?.apps.codex?.error, "Missing from Codex config");
    assert.deepStrictEqual(rows[1]?.apps.codex, {
      present: false,
      enabled: false,
      scope: "user",
      status: "disabled",
      editable: true,
    });
  });

  it("marks Codex unsupported for an SSE server", () => {
    const rows = buildRows({
      store: [stored("sse", { spec: { type: "sse", url: "https://x/sse" } })],
      apps: { claude: EMPTY, codex: { config: [config("codex", "sse")], live: undefined } },
    });
    assert.include(rows[0]?.apps.codex, {
      present: false,
      enabled: false,
      error: "Codex has no SSE transport",
      editable: false,
    });
  });

  it("does not duplicate a managed name as an unmanaged row", () => {
    const rows = buildRows({
      store: [stored("echo")],
      apps: {
        claude: { config: [config("claude", "echo", { scope: "local" })], live: undefined },
        codex: EMPTY,
      },
    });
    assert.deepStrictEqual(
      rows.map((row) => row.key),
      ["id-echo"],
    );
    // The local definition is what Claude loads, so the managed entry reflects it.
    assert.strictEqual(rows[0]?.apps.claude?.scope, "local");
  });

  it("puts the builtin row first, then sorts by name", () => {
    const rows = buildRows({
      store: [stored("zeta")],
      apps: { claude: { config: [config("claude", "alpha")], live: undefined }, codex: EMPTY },
      builtin: builtinRow({ browser: false, device: false }),
    });
    assert.deepStrictEqual(
      rows.map((row) => row.name),
      ["t3-code", "alpha", "zeta"],
    );
  });
});

describe("buildRows with Claude's deniedMcpServers", () => {
  it("keeps a denied server Claude no longer reports, switched off", () => {
    // Denied servers drop out of Claude's live status (claude 2.1.283).
    const rows = buildRows({
      store: [],
      apps: { claude: { config: [], live: [] }, codex: EMPTY },
      claudeDenied: new Set(["claude.ai Gmail", "plugin:vercel:vercel"]),
    });
    assert.deepStrictEqual(
      rows.map((row) => [row.key, row.apps.claude?.scope, row.apps.claude?.source]),
      [
        ["connector:claude.ai Gmail", "connector", "claude.ai"],
        ["plugin:plugin:vercel:vercel", "plugin", "vercel"],
      ],
    );
    for (const row of rows) {
      assert.include(row.apps.claude, { present: true, enabled: false, status: "disabled" });
    }
  });

  it("reports a denied server Claude still runs instead of showing it off", () => {
    const [row] = buildRows({
      store: [],
      apps: {
        claude: {
          config: [],
          live: [{ name: "claude.ai Gmail", scope: "connector", status: "needs-auth" }],
        },
        codex: EMPTY,
      },
      claudeDenied: new Set(["claude.ai Gmail"]),
    });
    assert.include(row?.apps.claude, { enabled: true, status: "needs-auth" });
    assert.match(row?.apps.claude?.error ?? "", /still loads it/);
  });

  it("switches off a denied server that is still configured, in Claude only", () => {
    const [row] = buildRows({
      store: [],
      apps: {
        claude: { config: [config("claude", "xcode", { scope: "project" })], live: [] },
        codex: { config: [config("codex", "xcode")], live: undefined },
      },
      claudeDenied: new Set(["xcode"]),
    });
    assert.include(row?.apps.claude, { scope: "project", enabled: false, status: "disabled" });
    assert.include(row?.apps.codex, { enabled: true });
  });
});

describe("builtinRow", () => {
  it("is read-only and grows with the agent access settings", () => {
    const toolCount = (browser: boolean, device: boolean) =>
      builtinRow({ browser, device }).apps.claude?.tools?.length ?? 0;
    const base = toolCount(false, false);
    const withBrowser = toolCount(true, false);
    const withBoth = toolCount(true, true);
    assert.isTrue(base > 0);
    assert.isTrue(withBrowser > base);
    assert.isTrue(withBoth > withBrowser);

    const row = builtinRow({ browser: true, device: true });
    assert.include(row, { key: "builtin:t3-code", builtin: true, managed: false });
    assert.deepStrictEqual(row.apps.claude, row.apps.codex);
    assert.include(row.apps.claude, { scope: "builtin", status: "connected", editable: false });
    for (const tool of row.apps.claude?.tools ?? []) {
      assert.strictEqual(typeof tool.readOnly, "boolean");
      assert.strictEqual(typeof tool.destructive, "boolean");
      assert.strictEqual(typeof tool.openWorld, "boolean");
    }
  });
});
