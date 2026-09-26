import { assert, describe, it } from "@effect/vitest";

import type { CodexMcpServerStatus, CodexMcpTool } from "../mcp/probes.ts";
import {
  codexAppContextFrom,
  codexMcpCosts,
  codexModelConfig,
  codexSkillCosts,
  codexToolTokens,
  codexModelFrom,
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
    const window = (model: string, override?: number) =>
      codexModelFrom(catalog, model, override)?.windowTokens;
    assert.strictEqual(window("model-a"), 190_000);
    assert.strictEqual(window("model-b"), 90_000);
    assert.strictEqual(window("model-a", 100_000), 95_000);
    assert.strictEqual(codexModelFrom(catalog, "unknown"), undefined);
    assert.strictEqual(codexModelFrom({}, "model-a"), undefined);
  });

  it("sizes the system prompt, and without a model uses the catalog's default", () => {
    const prompts = {
      models: [
        { slug: "later", priority: 2, visibility: "list", base_instructions: "x".repeat(40) },
        {
          slug: "first",
          priority: 1,
          visibility: "list",
          context_window: 272_000,
          model_messages: { instructions_template: "y".repeat(400) },
        },
        { slug: "hidden", priority: 0, visibility: "hide" },
      ],
    };
    assert.deepStrictEqual(codexModelFrom(prompts, undefined), {
      model: "first",
      windowTokens: 258_400,
      instructionsTokens: 100,
    });
    assert.deepStrictEqual(codexModelFrom(prompts, "later"), {
      model: "later",
      instructionsTokens: 10,
    });
  });
});

describe("codexAppContextFrom", () => {
  it("adds the system prompt, AGENTS.md, MCP tools and skills into an estimated baseline", () => {
    const statuses = [server("docs", { mcp__docs__search: tool("search", "Search", SCHEMA) })];
    const skills = [{ name: "alpha", tokens: 30 }];
    const memoryFiles = [{ path: "/repo/AGENTS.md", tokens: 200 }];
    const context = codexAppContextFrom({
      model: "model-a",
      windowTokens: 10_000,
      instructionsTokens: 500,
      memoryFiles,
      statuses,
      skills,
      errors: [undefined],
    });
    const mcpTokens = codexToolTokens("mcp__docs__search", statuses[0]!.tools.mcp__docs__search!);
    const baseline = 500 + 200 + mcpTokens + 30;
    assert.strictEqual(context.exact, false);
    assert.strictEqual(context.model, "model-a");
    assert.strictEqual(context.windowTokens, 10_000);
    assert.strictEqual(context.baselineTokens, baseline);
    assert.deepStrictEqual(context.categories, [
      { name: "System prompt", tokens: 500, kind: "used" },
      { name: "Memory files", tokens: 200, kind: "used" },
      { name: "MCP tools", tokens: mcpTokens, kind: "used" },
      { name: "Skills", tokens: 30, kind: "used" },
      { name: "Free space", tokens: 10_000 - baseline, kind: "free" },
    ]);
    assert.deepStrictEqual(context.memoryFiles, memoryFiles);
    assert.deepStrictEqual(context.skills, skills);
    assert.strictEqual(context.error, undefined);
  });

  it("joins the errors", () => {
    const context = codexAppContextFrom({
      windowTokens: 258_400,
      memoryFiles: [],
      statuses: [],
      skills: [],
      errors: ["MCP status failed", undefined, "Skills: timed out"],
    });
    assert.strictEqual(context.baselineTokens, 0);
    assert.strictEqual(context.error, "MCP status failed; Skills: timed out");
  });
});
