/**
 * Codex's context cost, estimated locally: Codex has no `/context` report, so
 * MCP tool definitions (from the MCP module's live probe) and the skills list
 * are sized at about four characters per token. Codex's own system prompt and
 * built-in tools are not included.
 */
import type { AppContext, ContextCategory, McpContextCost } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";

import { readJsonFile } from "../mcp/claude.ts";
import { codexSnapshot, type CodexMcpServerStatus, type CodexMcpTool } from "../mcp/probes.ts";
import { isRecord } from "../mcp/spec.ts";
import { type AgentCli, describeCause, withCodexClient } from "../shared/agents.ts";
import { expandHomePath, ExtensionFailure } from "../shared/t3.ts";

/** Rough token count of text the model sees: about four characters per token. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** One MCP tool as sent to the model: its name, description and input schema. */
export const codexToolTokens = (qualifiedName: string, tool: CodexMcpTool) =>
  estimateTokens(
    `${qualifiedName}${tool.description ?? ""}${JSON.stringify(tool.inputSchema ?? {})}`,
  );

const byTokens = <T extends { readonly tokens: number; readonly name: string }>(a: T, b: T) =>
  b.tokens - a.tokens || a.name.localeCompare(b.name);

/** Codex loads every tool of every running server into each request: nothing is deferred. */
export const codexMcpCosts = (statuses: ReadonlyArray<CodexMcpServerStatus>): McpContextCost[] =>
  statuses
    .map((server) => {
      const tools = Object.entries(server.tools)
        .map(([qualified, tool]) => ({
          name: tool.name || qualified,
          tokens: codexToolTokens(qualified, tool),
          loaded: true,
        }))
        .toSorted(byTokens);
      return {
        name: server.name,
        toolCount: tools.length,
        loadedTokens: tools.reduce((total, tool) => total + tool.tokens, 0),
        deferredTokens: 0,
        tools,
      };
    })
    .toSorted((a, b) => b.loadedTokens - a.loadedTokens || a.name.localeCompare(b.name));

export interface CodexSkillCost {
  readonly name: string;
  readonly source?: string;
  readonly tokens: number;
}

/** Enabled skills from a `skills/list` response, sized as Codex lists them to the model. */
export const codexSkillCosts = (response: unknown): CodexSkillCost[] => {
  const entries = isRecord(response) && Array.isArray(response.data) ? response.data : [];
  const seen = new Set<string>();
  const skills: CodexSkillCost[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.skills)) continue;
    for (const skill of entry.skills) {
      if (!isRecord(skill) || typeof skill.name !== "string" || skill.enabled === false) continue;
      const path = typeof skill.path === "string" ? skill.path : "";
      const key = path || skill.name;
      if (seen.has(key)) continue;
      seen.add(key);
      const description = typeof skill.description === "string" ? skill.description : "";
      skills.push({
        name: skill.name,
        ...(typeof skill.scope === "string" ? { source: skill.scope } : {}),
        tokens: estimateTokens(`- ${skill.name}: ${description} (file: ${path})`),
      });
    }
  }
  return skills.toSorted(byTokens);
};

// ---------------------------------------------------------------------------
// Model and window

const DEFAULT_EFFECTIVE_PERCENT = 95;

/** The configured model and its context-window override from a `config/read` response. */
export const codexModelConfig = (response: unknown) => {
  const config = isRecord(response) && isRecord(response.config) ? response.config : {};
  const text = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  return {
    model: text(config.model),
    contextWindow: number(config.model_context_window),
    catalogPath: text(config.model_catalog_json),
  };
};

/**
 * The usable window for `model` from a model catalog (`{ models: [...] }`):
 * Codex keeps a share of the raw window in reserve, 95% unless the catalog
 * says otherwise.
 */
export const codexWindowFrom = (
  catalog: unknown,
  model: string,
  contextWindowOverride?: number,
): number | undefined => {
  const models = isRecord(catalog) && Array.isArray(catalog.models) ? catalog.models : [];
  const entry = models.find((candidate) => isRecord(candidate) && candidate.slug === model);
  if (!isRecord(entry)) return undefined;
  const raw =
    contextWindowOverride ??
    (typeof entry.context_window === "number" ? entry.context_window : undefined);
  if (raw === undefined || raw <= 0) return undefined;
  const percent =
    typeof entry.effective_context_window_percent === "number"
      ? entry.effective_context_window_percent
      : DEFAULT_EFFECTIVE_PERCENT;
  return Math.floor((raw * percent) / 100);
};

/** The configured catalog first, then Codex's cached model list; files are only read. */
const codexWindow = Effect.fn("skillsMcp.context.codexWindow")(function* (
  cli: AgentCli,
  config: ReturnType<typeof codexModelConfig>,
) {
  if (!config.model) return undefined;
  const path = yield* Path.Path;
  const catalogs = [
    ...(config.catalogPath
      ? [path.resolve(cli.configDir, expandHomePath(config.catalogPath))]
      : []),
    path.join(cli.configDir, "models_cache.json"),
  ];
  for (const file of catalogs) {
    const window = codexWindowFrom(yield* readJsonFile(file), config.model, config.contextWindow);
    if (window !== undefined) return window;
  }
  return undefined;
});

// ---------------------------------------------------------------------------
// Skills list, cached like the MCP probes

interface SkillsResult {
  readonly skills: ReadonlyArray<CodexSkillCost>;
  readonly error?: string;
}

interface SkillsSlot {
  settledAt: number | undefined;
  failed: boolean;
  readonly result: Deferred.Deferred<SkillsResult>;
}

const SKILLS_TTL_MS = 60_000;
const SKILLS_FAILURE_TTL_MS = 10_000;
const SKILLS_TIMEOUT = Duration.seconds(30);

/** Module-level: the handler registry is rebuilt per ws connection. */
const skillsSlots = new Map<string, SkillsSlot>();

const listSkills = (cli: AgentCli, cwd: string) =>
  withCodexClient(cli, cwd, (client) => client.request("skills/list", { cwds: [cwd] })).pipe(
    Effect.timeoutOrElse({
      duration: SKILLS_TIMEOUT,
      orElse: () => Effect.fail(new ExtensionFailure({ message: "Codex skills/list timed out" })),
    }),
    Effect.map((response): SkillsResult => ({ skills: codexSkillCosts(response) })),
    Effect.catch((error) =>
      Effect.succeed<SkillsResult>({ skills: [], error: `Skills: ${describeCause(error)}` }),
    ),
  );

/** Codex's enabled skills at `cwd`; concurrent callers share one app-server session. */
const codexSkills = (cli: AgentCli, cwd: string, refresh: boolean) =>
  Effect.gen(function* () {
    const key = `${cli.binaryPath}|${cli.configDir}|${cwd}`;
    const now = yield* Clock.currentTimeMillis;
    const current = skillsSlots.get(key);
    const fresh =
      current !== undefined &&
      (current.settledAt === undefined ||
        (!refresh &&
          now - current.settledAt < (current.failed ? SKILLS_FAILURE_TTL_MS : SKILLS_TTL_MS)));
    if (fresh) return yield* Deferred.await(current.result);
    const slot: SkillsSlot = { settledAt: undefined, failed: false, result: Deferred.makeUnsafe() };
    skillsSlots.set(key, slot);
    yield* listSkills(cli, cwd).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const result: SkillsResult = Exit.isSuccess(exit)
            ? exit.value
            : { skills: [], error: "Skills: the Codex skills request was interrupted" };
          slot.failed = result.error !== undefined;
          slot.settledAt = yield* Clock.currentTimeMillis;
          yield* Deferred.succeed(slot.result, result);
        }),
      ),
      Effect.forkDetach,
    );
    return yield* Deferred.await(slot.result);
  });

// ---------------------------------------------------------------------------

const joinErrors = (errors: ReadonlyArray<string | undefined>) => {
  const present = errors.filter((error): error is string => !!error);
  return present.length > 0 ? present.join("; ") : undefined;
};

/**
 * Only what the panel can size is counted, so there is no "free space": the
 * rest of Codex's baseline is unknown.
 */
const CODEX_NOTE = "MCP tools and skills only; excludes Codex's system prompt and built-in tools";

/** Assembles the estimate; exported for tests. */
export const codexAppContextFrom = (input: {
  readonly model?: string | undefined;
  readonly windowTokens?: number | undefined;
  readonly statuses: ReadonlyArray<CodexMcpServerStatus>;
  readonly skills: ReadonlyArray<CodexSkillCost>;
  readonly errors: ReadonlyArray<string | undefined>;
}): AppContext => {
  const mcpServers = codexMcpCosts(input.statuses);
  const mcpTokens = mcpServers.reduce((total, server) => total + server.loadedTokens, 0);
  const skillTokens = input.skills.reduce((total, skill) => total + skill.tokens, 0);
  const baselineTokens = mcpTokens + skillTokens;
  const categories: ContextCategory[] = [
    { name: "MCP tools", tokens: mcpTokens, kind: "used" },
    { name: "Skills", tokens: skillTokens, kind: "used" },
  ];
  const error = joinErrors(input.errors);
  return {
    exact: false,
    note: CODEX_NOTE,
    ...(input.model ? { model: input.model } : {}),
    ...(input.windowTokens !== undefined ? { windowTokens: input.windowTokens } : {}),
    baselineTokens,
    categories,
    mcpServers,
    skills: input.skills,
    memoryFiles: [],
    ...(error ? { error } : {}),
  };
};

/** Codex's estimated per-thread cost at `cwd`; never fails, problems land in `error`. */
export const codexAppContext = (cli: AgentCli, cwd: string, refresh: boolean) =>
  Effect.gen(function* () {
    const [snapshot, skills] = yield* Effect.all(
      [codexSnapshot(cli, cwd, { refresh }), codexSkills(cli, cwd, refresh)],
      { concurrency: "unbounded" },
    );
    const config = codexModelConfig(snapshot.config);
    const windowTokens = yield* codexWindow(cli, config).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    return codexAppContextFrom({
      model: config.model,
      windowTokens,
      statuses: snapshot.statuses ?? [],
      skills: skills.skills,
      errors: [snapshot.error, skills.error],
    });
  });
