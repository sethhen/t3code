import { assert, describe, it } from "@effect/vitest";

import type { ClaudeContextUsage, ClaudeProbe } from "../mcp/probes.ts";
import { categoryKind, claudeAppContext, normalizeClaudeServerName } from "./claudeContext.ts";

type Category = ClaudeContextUsage["categories"][number];

const category = (name: string, tokens: number, extra: Record<string, unknown> = {}): Category =>
  ({ name, tokens, color: "gray", ...extra }) as Category;

const status = (name: string) =>
  ({ name, status: "connected" }) as unknown as ClaudeProbe["statuses"][number];

const usage = (overrides: Partial<ClaudeContextUsage> = {}): ClaudeContextUsage => ({
  categories: [
    category("System prompt", 3_000, { kind: "used" }),
    category("System tools", 12_000, { kind: "used" }),
    category("MCP tools", 900, { kind: "used" }),
    category("MCP tools (deferred)", 4_000, { kind: "deferred", isDeferred: true }),
    category("Memory files", 700, { kind: "used" }),
    category("Skills", 250, { kind: "used" }),
    category("Messages", 8, { kind: "used" }),
    category("Free space", 150_000, { kind: "free" }),
    category("Autocompact buffer", 33_000, { kind: "buffer" }),
  ],
  totalTokens: 16_858,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  percentage: 8,
  gridRows: [],
  model: "claude-test-model",
  memoryFiles: [{ path: "/work/CLAUDE.md", type: "Project", tokens: 700 }],
  mcpTools: [
    { name: "mcp__docs__search", serverName: "docs", tokens: 500, isLoaded: true },
    { name: "mcp__docs__fetch", serverName: "docs", tokens: 400, isLoaded: true },
    { name: "mcp__docs__admin", serverName: "docs", tokens: 1_500, isLoaded: false },
    { name: "mcp__my_server__run", serverName: "my_server", tokens: 2_500, isLoaded: false },
  ],
  agents: [],
  skills: {
    totalSkills: 2,
    includedSkills: 2,
    tokens: 250,
    skillFrontmatter: [
      { name: "small-skill", source: "userSettings", tokens: 50 },
      { name: "big-skill", source: "plugin", tokens: 200 },
    ],
  },
  isAutoCompactEnabled: true,
  apiUsage: null,
  ...overrides,
});

const probe = (overrides: Partial<ClaudeProbe> = {}): ClaudeProbe => ({
  statuses: [status("docs"), status("my.server")],
  contextUsage: usage(),
  contextDetail: "full",
  checkedAt: "2026-06-15T00:00:00.000Z",
  ...overrides,
});

describe("categoryKind", () => {
  it("uses Claude's own kind when present", () => {
    assert.strictEqual(categoryKind(category("Anything", 1, { kind: "buffer" })), "buffer");
    assert.strictEqual(categoryKind(category("Free space", 1, { kind: "used" })), "used");
  });

  it("falls back to the deferred flag and the names on older CLIs", () => {
    assert.strictEqual(categoryKind(category("MCP tools", 1, { isDeferred: true })), "deferred");
    assert.strictEqual(categoryKind(category("Free space", 1)), "free");
    assert.strictEqual(categoryKind(category("Autocompact buffer", 1)), "buffer");
    assert.strictEqual(categoryKind(category("System prompt", 1)), "used");
    assert.strictEqual(categoryKind(category("Odd", 1, { kind: "unknown" })), "used");
  });
});

describe("normalizeClaudeServerName", () => {
  it("replaces characters Claude does not allow in tool names", () => {
    assert.strictEqual(normalizeClaudeServerName("my.server"), "my_server");
    assert.strictEqual(normalizeClaudeServerName("ok-name_1"), "ok-name_1");
    assert.strictEqual(
      normalizeClaudeServerName("claude.ai Google Drive"),
      "claude_ai_Google_Drive",
    );
  });
});

describe("claudeAppContext", () => {
  it("maps the /context breakdown exactly", () => {
    const context = claudeAppContext(probe());
    assert.strictEqual(context.exact, true);
    assert.strictEqual(context.model, "claude-test-model");
    assert.strictEqual(context.windowTokens, 200_000);
    // Used categories only, without the conversation itself.
    assert.strictEqual(context.baselineTokens, 3_000 + 12_000 + 900 + 700 + 250);
    assert.deepStrictEqual(
      context.categories.map((entry) => [entry.name, entry.kind]),
      [
        ["System prompt", "used"],
        ["System tools", "used"],
        ["MCP tools", "used"],
        ["MCP tools (deferred)", "deferred"],
        ["Memory files", "used"],
        ["Skills", "used"],
        ["Messages", "used"],
        ["Free space", "free"],
        ["Autocompact buffer", "buffer"],
      ],
    );
    assert.deepStrictEqual(context.memoryFiles, [{ path: "/work/CLAUDE.md", tokens: 700 }]);
    assert.deepStrictEqual(context.skills, [
      { name: "big-skill", source: "plugin", tokens: 200 },
      { name: "small-skill", source: "userSettings", tokens: 50 },
    ]);
    assert.strictEqual(context.error, undefined);
  });

  it("groups MCP tools by server, splitting loaded and deferred tokens", () => {
    const context = claudeAppContext(probe());
    assert.deepStrictEqual(context.mcpServers, [
      {
        // `/context` reports the normalized name; the config name comes from the statuses.
        name: "my.server",
        toolCount: 1,
        loadedTokens: 0,
        deferredTokens: 2_500,
        tools: [{ name: "run", tokens: 2_500, loaded: false }],
      },
      {
        name: "docs",
        toolCount: 3,
        loadedTokens: 900,
        deferredTokens: 1_500,
        tools: [
          { name: "admin", tokens: 1_500, loaded: false },
          { name: "search", tokens: 500, loaded: true },
          { name: "fetch", tokens: 400, loaded: true },
        ],
      },
    ]);
  });

  it("counts every tool as loaded when Claude defers nothing", () => {
    const context = claudeAppContext(
      probe({
        contextUsage: usage({
          categories: usage().categories.filter((category) => !category.isDeferred),
        }),
      }),
    );
    const docs = context.mcpServers.find((server) => server.name === "docs");
    assert.strictEqual(docs?.loadedTokens, 2_400);
    assert.strictEqual(docs?.deferredTokens, 0);
  });

  it("treats tools without isLoaded as loaded", () => {
    const context = claudeAppContext(
      probe({
        contextUsage: usage({
          mcpTools: [{ name: "mcp__docs__search", serverName: "docs", tokens: 10 }],
        }),
      }),
    );
    assert.strictEqual(context.mcpServers[0]?.loadedTokens, 10);
    assert.strictEqual(context.mcpServers[0]?.deferredTokens, 0);
  });

  it("marks Claude's local summary estimate as not exact", () => {
    assert.strictEqual(claudeAppContext(probe({ contextDetail: "summary" })).exact, false);
  });

  it("reports why context usage is missing", () => {
    const context = claudeAppContext(
      probe({ contextUsage: undefined, contextError: "context usage timed out" }),
    );
    assert.strictEqual(context.baselineTokens, 0);
    assert.deepStrictEqual(context.mcpServers, []);
    assert.strictEqual(context.error, "context usage timed out");
  });
});
