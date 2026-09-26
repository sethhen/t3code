import type { AppContext, ContextOverview, McpAppEntry, McpServerRow } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  contextSummaries,
  contextSummary,
  formatTokens,
  joinMcpCosts,
  mcpCostChip,
  normalizeName,
} from "./context.logic";

const entry = (patch: Partial<McpAppEntry> = {}): McpAppEntry => ({
  present: true,
  enabled: true,
  scope: "user",
  status: "connected",
  editable: true,
  ...patch,
});

const server = (name: string, patch: Partial<McpServerRow> = {}): McpServerRow => ({
  key: name,
  name,
  managed: false,
  builtin: false,
  tags: [],
  apps: { claude: entry(), codex: entry() },
  ...patch,
});

const appContext = (patch: Partial<AppContext> = {}): AppContext => ({
  exact: false,
  windowTokens: 200_000,
  baselineTokens: 38_000,
  categories: [],
  mcpServers: [],
  skills: [],
  memoryFiles: [],
  ...patch,
});

const context = (apps: ContextOverview["apps"]): ContextOverview => ({
  apps,
  checkedAt: "2026-09-26T10:00:00.000Z",
});

const cost = (name: string, loadedTokens: number, deferredTokens = 0) => ({
  name,
  toolCount: 1,
  loadedTokens,
  deferredTokens,
  tools: [],
});

describe("formatTokens", () => {
  it("keeps small numbers and shortens large ones", () => {
    assert.equal(formatTokens(850), "850");
    assert.equal(formatTokens(3_240), "3.2k");
    assert.equal(formatTokens(38_000), "38k");
    assert.equal(formatTokens(258_400), "258k");
    assert.equal(formatTokens(1_000_000), "1M");
  });
});

describe("contextSummary", () => {
  it("gives Claude and Codex the same bar: baseline over the window", () => {
    const codex = contextSummary(
      "codex",
      appContext({
        windowTokens: 258_400,
        baselineTokens: 96_000,
        categories: [
          { name: "System prompt", tokens: 5_000, kind: "used" },
          { name: "MCP tools", tokens: 87_000, kind: "used" },
          { name: "Skills", tokens: 4_000, kind: "used" },
          { name: "Free space", tokens: 162_400, kind: "free" },
        ],
      }),
    );
    assert.equal(codex.label, "~96k / 258k");
    assert.closeTo(codex.share, 96_000 / 258_400, 1e-9);
    assert.deepEqual(
      codex.categories.map((category) => category.name),
      ["MCP tools", "System prompt", "Skills"],
    );
  });

  it("keeps deferred tools in the breakdown, drops the buffer, and clamps an overfull window", () => {
    const claude = contextSummary(
      "claude",
      appContext({
        exact: true,
        windowTokens: 1_000,
        baselineTokens: 5_000,
        categories: [
          { name: "System tools", tokens: 5_000, kind: "used" },
          { name: "MCP tools (deferred)", tokens: 9_000, kind: "deferred" },
          { name: "Autocompact buffer", tokens: 300, kind: "buffer" },
        ],
      }),
    );
    assert.equal(claude.label, "5k / 1k");
    assert.equal(claude.share, 1);
    assert.deepEqual(
      claude.categories.map((category) => category.kind),
      ["deferred", "used"],
    );
  });

  it("lists apps that reported", () => {
    assert.deepEqual(
      contextSummaries(context({ codex: appContext() })).map((summary) => summary.app),
      ["codex"],
    );
    assert.deepEqual(contextSummaries(null), []);
  });
});

describe("MCP costs", () => {
  it("joins by exact, normalized and plugin names, for apps the server is on in", () => {
    const rows = [
      server("braintrust"),
      server("claude.ai Docs", { apps: { claude: entry({ scope: "connector" }) } }),
      server("vercel", { apps: { claude: entry({ scope: "plugin", source: "vercel@vercel" }) } }),
      server("off", { apps: { claude: entry({ enabled: false }), codex: entry() } }),
    ];
    const costs = joinMcpCosts(
      rows,
      context({
        claude: appContext({
          mcpServers: [
            cost("braintrust", 0, 78_000),
            cost("claude_ai_docs", 810),
            cost("plugin:vercel:vercel", 0, 275_000),
            cost("off", 5_000),
          ],
        }),
        codex: appContext({ mcpServers: [cost("braintrust", 44_535), cost("off", 1_000)] }),
      }),
    );
    assert.deepEqual(costs.get("braintrust"), {
      claude: { loaded: 0, deferred: 78_000, exact: false },
      codex: { loaded: 44_535, deferred: 0, exact: false },
    });
    assert.equal(costs.get("claude.ai Docs")?.claude?.loaded, 810);
    assert.equal(costs.get("vercel")?.claude?.deferred, 275_000);
    assert.deepEqual(Object.keys(costs.get("off") ?? {}), ["codex"]);
    assert.equal(normalizeName("claude.ai Docs"), "claude_ai_docs");
  });

  it("chips the largest up-front cost, and nothing when every app defers it", () => {
    const chip = mcpCostChip({
      claude: { loaded: 0, deferred: 78_000, exact: false },
      codex: { loaded: 44_535, deferred: 0, exact: false },
    });
    assert.equal(chip?.text, "45k tok");
    assert.equal(
      chip?.hint,
      "Claude: none up front, ~78k loaded on demand\nCodex: ~44,535 tokens in every thread",
    );
    assert.isNull(mcpCostChip({ claude: { loaded: 0, deferred: 900, exact: false } }));
    assert.isNull(mcpCostChip(undefined));
  });
});
