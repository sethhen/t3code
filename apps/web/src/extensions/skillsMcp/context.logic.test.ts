import type {
  AppContext,
  AppUsage,
  ContextOverview,
  McpAppEntry,
  McpServerRow,
  SkillAppEntry,
  SkillRow,
  UsageReport,
} from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  arrangeRows,
  bareToolName,
  contextSummaries,
  contextSummary,
  deferredChip,
  formatCalls,
  formatTokens,
  joinMcpStats,
  joinSkillStats,
  needsUsage,
  normalizeName,
  sortRowsBy,
  statsDetail,
  statsFor,
  tokenChip,
  toolChips,
  unusedCost,
  unusedRows,
  usageChip,
  usageFootnote,
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
  apps: { claude: entry() },
  ...patch,
});

const skillEntry = (patch: Partial<SkillAppEntry> = {}): SkillAppEntry => ({
  present: true,
  enabled: true,
  scope: "user",
  editable: true,
  ...patch,
});

const skill = (name: string, patch: Partial<SkillRow> = {}): SkillRow => ({
  key: name,
  name,
  managed: false,
  apps: { claude: skillEntry() },
  ...patch,
});

const appContext = (patch: Partial<AppContext> = {}): AppContext => ({
  exact: true,
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

const appUsage = (patch: Partial<AppUsage> = {}): AppUsage => ({
  mcpServers: [],
  skills: [],
  sessions: 0,
  scannedFiles: 0,
  scannedBytes: 0,
  ...patch,
});

const usage = (claude: Partial<AppUsage> = {}, codex: Partial<AppUsage> = {}): UsageReport => ({
  days: 7,
  apps: { claude: appUsage(claude), codex: appUsage(codex) },
  scannedAt: "2026-09-26T10:00:00.000Z",
});

describe("formatTokens", () => {
  it("keeps small numbers and shortens large ones", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(850), "850");
    assert.equal(formatTokens(1000), "1k");
    assert.equal(formatTokens(3240), "3.2k");
    assert.equal(formatTokens(9_960), "10k");
    assert.equal(formatTokens(38_400), "38k");
    assert.equal(formatTokens(200_000), "200k");
    assert.equal(formatTokens(1_200_000), "1.2M");
    assert.equal(formatTokens(Number.NaN), "0");
  });

  it("pluralizes calls", () => {
    assert.equal(formatCalls(1), "1 call");
    assert.equal(formatCalls(0), "0 calls");
  });
});

describe("contextSummary", () => {
  it("lays used then buffer segments over the window and labels the baseline", () => {
    const summary = contextSummary(
      "claude",
      appContext({
        categories: [
          { name: "Free space", tokens: 120_000, kind: "free" },
          { name: "Autocompact buffer", tokens: 40_000, kind: "buffer" },
          { name: "System prompt", tokens: 20_000, kind: "used" },
          { name: "MCP tools", tokens: 18_000, kind: "used" },
          { name: "MCP tools (deferred)", tokens: 9_000, kind: "deferred" },
          { name: "Empty", tokens: 0, kind: "used" },
        ],
      }),
    );
    assert.equal(summary.label, "new thread 38k / 200k");
    assert.deepEqual(
      summary.segments.map((segment) => [segment.name, segment.kind, segment.share]),
      [
        ["System prompt", "used", 0.1],
        ["MCP tools", "used", 0.09],
        ["Autocompact buffer", "buffer", 0.2],
      ],
    );
    assert.equal(summary.deferredTokens, 9_000);
    assert.equal(summary.categories.length, 6);
  });

  it("marks Claude's estimate and falls back to the category total without a window", () => {
    const summary = contextSummary("claude", {
      exact: false,
      note: "Claude's local estimate",
      baselineTokens: 12_000,
      categories: [
        { name: "Tools", tokens: 10_000, kind: "used" },
        { name: "Free", tokens: 30_000, kind: "free" },
      ],
      mcpServers: [],
      skills: [],
      memoryFiles: [],
    });
    assert.equal(summary.label, "new thread ~12k");
    assert.equal(summary.partial, false);
    assert.equal(summary.note, "Claude's local estimate");
    assert.equal(summary.segments[0]?.share, 0.25);
  });

  it("labels Codex's partial count without a bar or window", () => {
    const summary = contextSummary(
      "codex",
      appContext({
        exact: false,
        note: "MCP tools and skills only",
        windowTokens: 272_000,
        baselineTokens: 58_000,
        categories: [
          { name: "MCP tools", tokens: 50_000, kind: "used" },
          { name: "Skills", tokens: 8_000, kind: "used" },
          { name: "Free space", tokens: 214_000, kind: "free" },
        ],
      }),
    );
    assert.equal(summary.label, "~58k MCP + skills");
    assert.deepEqual(
      summary.categories.map((category) => category.name),
      ["MCP tools", "Skills"],
    );
    assert.equal(summary.partial, true);
    assert.equal(summary.windowTokens, undefined);
    assert.deepEqual(summary.segments, []);
  });

  it("clamps an overfull window", () => {
    const summary = contextSummary(
      "claude",
      appContext({
        windowTokens: 100,
        categories: [
          { name: "A", tokens: 80, kind: "used" },
          { name: "B", tokens: 80, kind: "used" },
        ],
      }),
    );
    const shares = summary.segments.map((segment) => segment.share);
    assert.equal(shares.length, 2);
    assert.equal(shares[0], 0.8);
    assert.closeTo(shares[1] ?? 0, 0.2, 1e-9);
  });

  it("lists apps that reported", () => {
    assert.deepEqual(contextSummaries(null), []);
    assert.deepEqual(
      contextSummaries(context({ codex: appContext({ exact: false }) })).map((s) => s.app),
      ["codex"],
    );
  });
});

describe("name joins", () => {
  it("normalizes like Claude's tool names", () => {
    assert.equal(normalizeName("claude.ai Gmail"), "claude_ai_gmail");
    assert.equal(normalizeName("my-server_2"), "my-server_2");
  });

  it("strips the mcp prefix", () => {
    assert.equal(bareToolName("mcp__github__create_issue", "github"), "create_issue");
    assert.equal(bareToolName("mcp__claude_ai_Gmail__search", "claude.ai Gmail"), "search");
    assert.equal(bareToolName("mcp__other__thing", "github"), "thing");
    assert.equal(bareToolName("create_issue", "github"), "create_issue");
  });
});

describe("joinMcpStats", () => {
  const rows = [
    server("github", { apps: { claude: entry(), codex: entry() } }),
    server("claude.ai Gmail"),
    server("figma", { apps: { claude: entry({ scope: "plugin", source: "figma@official" }) } }),
    server("idle"),
  ];

  it("joins context by exact, normalized and plugin names", () => {
    const stats = joinMcpStats(
      rows,
      context({
        claude: appContext({
          mcpServers: [
            {
              name: "github",
              toolCount: 2,
              loadedTokens: 3_200,
              deferredTokens: 1_100,
              tools: [
                { name: "mcp__github__create_issue", tokens: 2_000, loaded: true },
                { name: "mcp__github__search", tokens: 1_100, loaded: false },
              ],
            },
            {
              name: "claude_ai_Gmail",
              toolCount: 1,
              loadedTokens: 900,
              deferredTokens: 0,
              tools: [],
            },
            {
              name: "plugin:figma:figma",
              toolCount: 1,
              loadedTokens: 500,
              deferredTokens: 0,
              tools: [],
            },
          ],
        }),
        codex: appContext({
          exact: false,
          mcpServers: [
            { name: "github", toolCount: 2, loadedTokens: 2_800, deferredTokens: 0, tools: [] },
          ],
        }),
      }),
      null,
    );
    const github = statsFor(stats, "github");
    assert.equal(github.tokens, 3_200);
    assert.equal(github.deferredTokens, 1_100);
    assert.deepEqual(github.perAppTokens, {
      claude: { loaded: 3_200, deferred: 1_100, exact: true },
      codex: { loaded: 2_800, deferred: 0, exact: false },
    });
    assert.deepEqual(github.tools?.get("create_issue"), {
      claude: { tokens: 2_000, loaded: true },
    });
    assert.equal(github.calls, undefined);
    assert.equal(statsFor(stats, "claude.ai Gmail").tokens, 900);
    assert.equal(statsFor(stats, "figma").tokens, 500);
    assert.deepEqual(statsFor(stats, "idle"), {});
    assert.deepEqual(statsFor(stats, "missing"), {});
  });

  it("ignores context for apps the row is not in and apps that errored", () => {
    const stats = joinMcpStats(
      [server("solo")],
      context({
        claude: appContext({
          error: "boom",
          mcpServers: [
            { name: "solo", toolCount: 0, loadedTokens: 10, deferredTokens: 0, tools: [] },
          ],
        }),
        codex: appContext({
          mcpServers: [
            { name: "solo", toolCount: 0, loadedTokens: 20, deferredTokens: 0, tools: [] },
          ],
        }),
      }),
      null,
    );
    assert.equal(statsFor(stats, "solo").tokens, undefined);
  });

  it("sums calls over scanned apps and zero-fills unused rows", () => {
    const stats = joinMcpStats(
      rows,
      null,
      usage(
        {
          mcpServers: [
            {
              name: "github",
              calls: 10,
              lastUsedAt: "2026-09-25T10:00:00.000Z",
              tools: [{ name: "mcp__github__create_issue", calls: 10 }],
            },
          ],
        },
        {
          mcpServers: [
            {
              name: "github",
              calls: 4,
              lastUsedAt: "2026-09-26T09:00:00.000Z",
              tools: [{ name: "create_issue", calls: 4 }],
            },
          ],
        },
      ),
    );
    const github = statsFor(stats, "github");
    assert.equal(github.calls, 14);
    assert.deepEqual(github.perAppCalls, { claude: 10, codex: 4 });
    assert.equal(github.lastUsedAt, "2026-09-26T09:00:00.000Z");
    assert.deepEqual(github.tools?.get("create_issue"), {
      claude: { calls: 10 },
      codex: { calls: 4 },
    });
    assert.equal(github.unused, undefined);
    assert.deepEqual(statsFor(stats, "idle").perAppCalls, { claude: 0 });
    assert.equal(statsFor(stats, "idle").unused, true);
  });

  it("only flags rows unused when every app they are on in scanned zero calls", () => {
    const both = server("both", { apps: { claude: entry(), codex: entry() } });
    const offInCodex = server("half", {
      apps: { claude: entry(), codex: entry({ enabled: false }) },
    });
    const off = server("off", { apps: { claude: entry({ status: "disabled" }) } });
    const rows = [both, offInCodex, off];
    const claudeOnly = joinMcpStats(rows, null, usage({}, { error: "no transcripts" }));
    assert.equal(statsFor(claudeOnly, "both").unused, undefined);
    assert.equal(statsFor(claudeOnly, "half").unused, true);
    assert.equal(statsFor(claudeOnly, "off").unused, undefined);
    const usedInCodex = joinMcpStats(
      rows,
      null,
      usage({}, { mcpServers: [{ name: "both", calls: 2, tools: [] }] }),
    );
    assert.equal(statsFor(usedInCodex, "both").unused, undefined);
    assert.equal(statsFor(joinMcpStats(rows, null, usage()), "both").unused, true);
  });

  it("treats a failed scan as unknown", () => {
    const stats = joinMcpStats(
      [server("x")],
      null,
      usage({ error: "no transcripts" }, { error: "x" }),
    );
    assert.equal(statsFor(stats, "x").calls, undefined);
  });
});

describe("joinSkillStats", () => {
  it("joins tokens and calls, including plugin-prefixed names", () => {
    const rows = [skill("pdf"), skill("review", { pluginId: "toolkit@market" }), skill("idle")];
    const stats = joinSkillStats(
      rows,
      context({
        claude: appContext({
          skills: [
            { name: "pdf", tokens: 120 },
            { name: "toolkit:review", tokens: 80 },
          ],
        }),
      }),
      usage({
        skills: [{ name: "toolkit:review", calls: 3, lastUsedAt: "2026-09-20T00:00:00.000Z" }],
      }),
    );
    assert.equal(statsFor(stats, "pdf").tokens, 120);
    assert.equal(statsFor(stats, "pdf").calls, 0);
    assert.equal(statsFor(stats, "review").tokens, 80);
    assert.equal(statsFor(stats, "review").calls, 3);
    assert.equal(statsFor(stats, "review").lastUsedAt, "2026-09-20T00:00:00.000Z");
    assert.equal(statsFor(stats, "idle").tokens, undefined);
    assert.equal(statsFor(stats, "idle").unused, true);
    assert.equal(statsFor(stats, "review").unused, undefined);
  });
});

describe("chips", () => {
  const stats = {
    perAppTokens: {
      claude: { loaded: 12_000, deferred: 1_100, exact: false },
      codex: { loaded: 45_000, deferred: 0, exact: true },
    },
    perAppCalls: { claude: 2, codex: 0 },
    calls: 2,
  };

  it("keeps apps apart and drops initials for a single app", () => {
    assert.equal(tokenChip({}, ["claude", "codex"]), null);
    assert.equal(tokenChip(stats, ["claude", "codex"]), "C 12k · X 45k tok");
    assert.equal(tokenChip(stats, ["codex"]), "45k tok");
    assert.equal(deferredChip(stats, ["claude", "codex"]), "C +1.1k deferred");
    assert.equal(deferredChip(stats, ["codex"]), null);
    assert.equal(usageChip({}, 7), null);
    assert.equal(usageChip({ calls: 14 }, 7), "14 calls · 7d");
    assert.equal(usageChip({ calls: 1 }, 30), "1 call · 30d");
  });

  it("formats one tool per app", () => {
    const apps = ["claude", "codex"] as const;
    assert.deepEqual(
      toolChips(
        {
          claude: { tokens: 1_200, loaded: true, calls: 3 },
          codex: { tokens: 900, loaded: false },
        },
        apps,
      ),
      { cost: "C 1.2k tok · X 900 deferred", deferredOnly: false, calls: "C 3 calls" },
    );
    assert.deepEqual(toolChips({ codex: { tokens: 900, loaded: false } }, ["codex"]), {
      cost: "900 deferred",
      deferredOnly: true,
      calls: null,
    });
    assert.deepEqual(toolChips(undefined, apps), { cost: null, deferredOnly: false, calls: null });
  });

  it("details exact numbers per app", () => {
    assert.deepEqual(statsDetail(stats, 7), [
      "Claude: ~12,000 tok per request, 1,100 deferred, 2 calls in 7d",
      "Codex: 45,000 tok per request, 0 calls in 7d",
    ]);
  });
});

describe("sorting and the Unused filter", () => {
  const rows = [server("b"), server("a"), server("c"), server("d")];
  const cost = (claude: number, codex?: number) => ({
    claude: { loaded: claude, deferred: 0, exact: true },
    ...(codex === undefined ? {} : { codex: { loaded: codex, deferred: 0, exact: true } }),
  });
  const stats = new Map([
    ["a", { tokens: 100, calls: 0, perAppTokens: cost(100), unused: true as const }],
    ["b", { tokens: 5_000, deferredTokens: 10, calls: 3, perAppTokens: cost(5_000, 200) }],
    ["c", { tokens: 5_000, deferredTokens: 20, calls: 3, perAppTokens: cost(1_000, 5_000) }],
    ["d", { perAppTokens: cost(0, 300), unused: true as const }],
  ]);

  it("sorts by name, context cost and usage with unknowns last", () => {
    const names = (mode: "name" | "context" | "usage") =>
      sortRowsBy(rows, mode, stats).map((row) => row.name);
    assert.deepEqual(names("name"), ["a", "b", "c", "d"]);
    assert.deepEqual(names("context"), ["c", "b", "a", "d"]);
    assert.deepEqual(names("usage"), ["b", "c", "a", "d"]);
  });

  it("keeps the status sections, or flattens into one sorted list", () => {
    const byStatus = () => [{ id: "mine", label: "Mine", rows: [rows[0]!] }];
    assert.deepEqual(arrangeRows(rows, "status", stats, byStatus), byStatus());
    const [flat] = arrangeRows(rows, "context", stats, byStatus);
    assert.equal(flat?.label, "");
    assert.deepEqual(
      flat?.rows.map((row) => row.name),
      ["c", "b", "a", "d"],
    );
  });

  it("knows when usage is needed", () => {
    assert.equal(needsUsage("status", false), false);
    assert.equal(needsUsage("context", true), true);
    assert.equal(needsUsage("usage", false), true);
  });

  it("lists unused rows and what they cost per app", () => {
    const unused = unusedRows(rows, stats);
    assert.deepEqual(
      unused.map((row) => row.name),
      ["a", "d"],
    );
    assert.equal(unusedCost(unused, stats, ["claude", "codex"]), "C 100 · X 300 tok");
    assert.equal(unusedCost([], stats, ["claude"]), null);
  });

  it("summarizes the scan", () => {
    assert.equal(usageFootnote(usage({ sessions: 3 }, { sessions: 1 })), "4 sessions in 7d");
    assert.equal(
      usageFootnote(usage({ sessions: 1 }, { error: "nope" })),
      "1 session in 7d; Codex could not be scanned",
    );
  });
});
