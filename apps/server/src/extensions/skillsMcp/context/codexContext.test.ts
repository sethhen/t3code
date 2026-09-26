import { assert, describe, it } from "@effect/vitest";

import type { CodexMcpServerStatus, CodexMcpTool } from "../mcp/probes.ts";
import {
  codexAppContextFrom,
  codexMcpCosts,
  codexModelConfig,
  codexSkillCosts,
  codexToolTokens,
  codexWindowFrom,
  estimateTokens,
} from "./codexContext.ts";

const tool = (name: string, description: string, inputSchema: unknown): CodexMcpTool => ({
  name,
  description,
  inputSchema,
});

const server = (name: string, tools: Record<string, CodexMcpTool>): CodexMcpServerStatus => ({
  name,
  tools,
  resources: [],
  resourceTemplates: [],
});

const SCHEMA = { type: "object", properties: { query: { type: "string" } } };

describe("estimateTokens", () => {
  it("counts about four characters per token, rounding up", () => {
    assert.strictEqual(estimateTokens(""), 0);
    assert.strictEqual(estimateTokens("abcd"), 1);
    assert.strictEqual(estimateTokens("abcde"), 2);
    assert.strictEqual(estimateTokens("x".repeat(400)), 100);
  });
});

describe("codexToolTokens", () => {
  it("sizes the qualified name, description and JSON input schema", () => {
    const search = tool("search", "Search the docs", SCHEMA);
    assert.strictEqual(
      codexToolTokens("mcp__docs__search", search),
      Math.ceil(`mcp__docs__searchSearch the docs${JSON.stringify(SCHEMA)}`.length / 4),
    );
    assert.strictEqual(codexToolTokens("t", { name: "t" }), Math.ceil("t{}".length / 4));
  });
});

describe("codexMcpCosts", () => {
  it("loads every tool up front and sorts servers and tools by cost", () => {
    const costs = codexMcpCosts([
      server("small", { mcp__small__ping: tool("ping", "", {}) }),
      server("docs", {
        mcp__docs__search: tool("search", "Search the docs", SCHEMA),
        mcp__docs__fetch: tool("fetch", "Fetch one page by its URL".repeat(10), SCHEMA),
      }),
    ]);
    assert.deepStrictEqual(
      costs.map((entry) => [entry.name, entry.toolCount, entry.deferredTokens]),
      [
        ["docs", 2, 0],
        ["small", 1, 0],
      ],
    );
    const docs = costs[0]!;
    assert.deepStrictEqual(
      docs.tools.map((entry) => [entry.name, entry.loaded]),
      [
        ["fetch", true],
        ["search", true],
      ],
    );
    assert.strictEqual(
      docs.loadedTokens,
      docs.tools.reduce((total, entry) => total + entry.tokens, 0),
    );
  });
});

describe("codexSkillCosts", () => {
  it("keeps enabled skills once, sized as Codex lists them", () => {
    const skills = codexSkillCosts({
      data: [
        {
          cwd: "/work",
          skills: [
            {
              name: "alpha",
              description: "Does alpha things",
              path: "/s/alpha/SKILL.md",
              scope: "user",
            },
            { name: "off", description: "Disabled", path: "/s/off/SKILL.md", enabled: false },
            { name: "beta", description: "B", path: "/s/beta/SKILL.md", scope: "repo" },
          ],
        },
        // The same skill seen from a second cwd.
        { cwd: "/other", skills: [{ name: "alpha", description: "x", path: "/s/alpha/SKILL.md" }] },
        { cwd: "/broken", skills: "nope" },
      ],
    });
    assert.deepStrictEqual(skills, [
      {
        name: "alpha",
        source: "user",
        tokens: estimateTokens("- alpha: Does alpha things (file: /s/alpha/SKILL.md)"),
      },
      {
        name: "beta",
        source: "repo",
        tokens: estimateTokens("- beta: B (file: /s/beta/SKILL.md)"),
      },
    ]);
    assert.deepStrictEqual(codexSkillCosts(undefined), []);
  });
});

describe("codex model window", () => {
  const catalog = {
    models: [
      { slug: "model-a", context_window: 200_000 },
      { slug: "model-b", context_window: 100_000, effective_context_window_percent: 90 },
    ],
  };

  it("reads the configured model from config/read", () => {
    assert.deepStrictEqual(
      codexModelConfig({
        config: { model: "model-a", model_context_window: 50_000, model_catalog_json: "~/c.json" },
      }),
      { model: "model-a", contextWindow: 50_000, catalogPath: "~/c.json" },
    );
    assert.deepStrictEqual(codexModelConfig({ config: { model: "" } }), {
      model: undefined,
      contextWindow: undefined,
      catalogPath: undefined,
    });
  });

  it("keeps Codex's reserve: 95% unless the catalog says otherwise", () => {
    assert.strictEqual(codexWindowFrom(catalog, "model-a"), 190_000);
    assert.strictEqual(codexWindowFrom(catalog, "model-b"), 90_000);
    assert.strictEqual(codexWindowFrom(catalog, "model-a", 100_000), 95_000);
    assert.strictEqual(codexWindowFrom(catalog, "unknown"), undefined);
    assert.strictEqual(codexWindowFrom({}, "model-a"), undefined);
  });
});

describe("codexAppContextFrom", () => {
  it("adds MCP tools and skills into an estimated baseline, with no free space", () => {
    const statuses = [server("docs", { mcp__docs__search: tool("search", "Search", SCHEMA) })];
    const skills = [{ name: "alpha", tokens: 30 }];
    const context = codexAppContextFrom({
      model: "model-a",
      windowTokens: 1_000,
      statuses,
      skills,
      errors: [undefined],
    });
    const mcpTokens = codexToolTokens("mcp__docs__search", statuses[0]!.tools.mcp__docs__search!);
    assert.strictEqual(context.exact, false);
    assert.match(context.note ?? "", /MCP tools and skills only/);
    assert.strictEqual(context.model, "model-a");
    assert.strictEqual(context.windowTokens, 1_000);
    assert.strictEqual(context.baselineTokens, mcpTokens + 30);
    assert.deepStrictEqual(context.categories, [
      { name: "MCP tools", tokens: mcpTokens, kind: "used" },
      { name: "Skills", tokens: 30, kind: "used" },
    ]);
    assert.deepStrictEqual(context.skills, skills);
    assert.strictEqual(context.error, undefined);
  });

  it("joins the errors and omits an unknown window", () => {
    const context = codexAppContextFrom({
      statuses: [],
      skills: [],
      errors: ["MCP status failed", undefined, "Skills: timed out"],
    });
    assert.strictEqual(context.windowTokens, undefined);
    assert.strictEqual(context.baselineTokens, 0);
    assert.strictEqual(context.categories.length, 2);
    assert.strictEqual(context.error, "MCP status failed; Skills: timed out");
  });
});
