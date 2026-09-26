/**
 * Codex's context cost, estimated locally: Codex has no `/context` report, so
 * its system prompt (from the model catalog), the AGENTS.md files it loads,
 * MCP tool definitions (from the MCP module's live probe) and the skills list
 * are sized at about four characters per token. Built-in tools are not counted.
 */
import type { AppContext, ContextCategory, McpContextCost } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { readJsonFile } from "../mcp/claude.ts";
import {
  codexSnapshot,
  type CodexMcpServerStatus,
  type CodexMcpTool,
  gatedRead,
} from "../mcp/probes.ts";
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
// Model, window and system prompt

const DEFAULT_EFFECTIVE_PERCENT = 95;

/**
 * The usable window when no catalog names the model (pool setups often leave
 * `model` unset): every model in Codex's catalog has a 272k window, 95% usable.
 * `max_context_window` is only the ceiling `model_context_window` may raise it to.
 */
const CODEX_DEFAULT_WINDOW = 258_400;

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

/** What a model catalog says about one model. */
export interface CodexModelFacts {
  readonly model: string;
  /** Usable window: Codex keeps a share of the raw window in reserve, 95% unless the catalog says otherwise. */
  readonly windowTokens?: number;
  /** The system prompt each thread starts with. */
  readonly instructionsTokens?: number;
}

const priorityOf = (entry: Record<string, unknown>) =>
  typeof entry.priority === "number" ? entry.priority : Number.POSITIVE_INFINITY;

/**
 * `model` from a model catalog (`{ models: [...] }`), or without a model the
 * catalog's default: its first-priority listed model.
 */
export const codexModelFrom = (
  catalog: unknown,
  model: string | undefined,
  contextWindowOverride?: number,
): CodexModelFacts | undefined => {
  const models = (isRecord(catalog) && Array.isArray(catalog.models) ? catalog.models : []).filter(
    isRecord,
  );
  const entry =
    model !== undefined
      ? models.find((candidate) => candidate.slug === model)
      : models
          .filter((candidate) => candidate.visibility === "list")
          .toSorted((a, b) => priorityOf(a) - priorityOf(b))[0];
  if (!entry || typeof entry.slug !== "string") return undefined;
  const raw =
    contextWindowOverride ??
    (typeof entry.context_window === "number" ? entry.context_window : undefined);
  const percent =
    typeof entry.effective_context_window_percent === "number"
      ? entry.effective_context_window_percent
      : DEFAULT_EFFECTIVE_PERCENT;
  const messages = isRecord(entry.model_messages) ? entry.model_messages : {};
  const instructions = [messages.instructions_template, entry.base_instructions].find(
    (text): text is string => typeof text === "string" && text.length > 0,
  );
  return {
    model: entry.slug,
    ...(raw !== undefined && raw > 0 ? { windowTokens: Math.floor((raw * percent) / 100) } : {}),
    ...(instructions ? { instructionsTokens: estimateTokens(instructions) } : {}),
  };
};

/** The configured catalog first, then Codex's cached model list; files are only read. */
const codexModel = Effect.fn("skillsMcp.context.codexModel")(function* (
  cli: AgentCli,
  config: ReturnType<typeof codexModelConfig>,
) {
  const path = yield* Path.Path;
  const catalogs = [
    ...(config.catalogPath
      ? [path.resolve(cli.configDir, expandHomePath(config.catalogPath))]
      : []),
    path.join(cli.configDir, "models_cache.json"),
  ];
  for (const file of catalogs) {
    const facts = codexModelFrom(yield* readJsonFile(file), config.model, config.contextWindow);
    if (facts !== undefined) return facts;
  }
  return undefined;
});

// ---------------------------------------------------------------------------
// AGENTS.md

/** Codex's default `project_doc_max_bytes`. */
const PROJECT_DOC_MAX_CHARS = 32 * 1024;
const DOC_NAMES = ["AGENTS.override.md", "AGENTS.md"];

/**
 * The AGENTS.md files Codex adds to a thread at `cwd`: its home's, then one
 * per directory from the git root down to `cwd` (`AGENTS.override.md` wins in
 * a directory), the project ones capped at Codex's 32 KiB default.
 */
const codexMemoryFiles = Effect.fn("skillsMcp.context.codexMemoryFiles")(function* (
  cli: AgentCli,
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const docIn = (dir: string) =>
    Effect.gen(function* () {
      for (const name of DOC_NAMES) {
        const file = path.join(dir, name);
        const text = yield* fs.readFileString(file).pipe(Effect.option);
        if (Option.isSome(text) && text.value.trim() !== "")
          return { path: file, text: text.value };
      }
      return undefined;
    });
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (yield* fs.exists(path.join(dir, ".git")).pipe(Effect.orElseSucceed(() => false))) break;
    if (path.dirname(dir) === dir) {
      dirs.splice(0, dirs.length, path.resolve(cwd));
      break;
    }
  }
  const files: Array<{ path: string; tokens: number }> = [];
  const global = yield* docIn(cli.configDir);
  if (global) files.push({ path: global.path, tokens: estimateTokens(global.text) });
  let budget = PROJECT_DOC_MAX_CHARS;
  for (const dir of dirs) {
    const doc = budget > 0 ? yield* docIn(dir) : undefined;
    if (!doc) continue;
    const text = doc.text.slice(0, budget);
    budget -= text.length;
    files.push({ path: doc.path, tokens: estimateTokens(text) });
  }
  return files;
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

// Gated like the MCP probes: the app-server rewrites config.toml at startup, so
// a Codex config write stops it and the listing reruns afterwards.
const listSkills = (cli: AgentCli, cwd: string) =>
  gatedRead(
    "codex",
    withCodexClient(cli, cwd, (client) => client.request("skills/list", { cwds: [cwd] })),
  ).pipe(
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

const CODEX_NOTE = "Estimated here; Codex's built-in tools are not counted";

/** Assembles the estimate; exported for tests. */
export const codexAppContextFrom = (input: {
  readonly model?: string | undefined;
  readonly windowTokens: number;
  readonly instructionsTokens?: number | undefined;
  readonly memoryFiles: ReadonlyArray<{ readonly path: string; readonly tokens: number }>;
  readonly statuses: ReadonlyArray<CodexMcpServerStatus>;
  readonly skills: ReadonlyArray<CodexSkillCost>;
  readonly errors: ReadonlyArray<string | undefined>;
}): AppContext => {
  const mcpServers = codexMcpCosts(input.statuses);
  const total = (items: ReadonlyArray<{ readonly tokens: number }>) =>
    items.reduce((sum, item) => sum + item.tokens, 0);
  const used: ContextCategory[] = [
    ...(input.instructionsTokens !== undefined
      ? [{ name: "System prompt", tokens: input.instructionsTokens, kind: "used" as const }]
      : []),
    { name: "Memory files", tokens: total(input.memoryFiles), kind: "used" },
    {
      name: "MCP tools",
      tokens: mcpServers.reduce((sum, server) => sum + server.loadedTokens, 0),
      kind: "used",
    },
    { name: "Skills", tokens: total(input.skills), kind: "used" },
  ];
  const baselineTokens = total(used);
  const error = joinErrors(input.errors);
  return {
    exact: false,
    note: CODEX_NOTE,
    ...(input.model ? { model: input.model } : {}),
    windowTokens: input.windowTokens,
    baselineTokens,
    categories: [
      ...used,
      {
        name: "Free space",
        tokens: Math.max(0, input.windowTokens - baselineTokens),
        kind: "free",
      },
    ],
    mcpServers,
    skills: input.skills,
    memoryFiles: input.memoryFiles,
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
    const [facts, memoryFiles] = yield* Effect.all(
      [
        codexModel(cli, config).pipe(Effect.catch(() => Effect.succeed(undefined))),
        codexMemoryFiles(cli, cwd).pipe(Effect.catch(() => Effect.succeed([]))),
      ],
      { concurrency: 2 },
    );
    const override = config.contextWindow
      ? Math.floor((config.contextWindow * DEFAULT_EFFECTIVE_PERCENT) / 100)
      : undefined;
    return codexAppContextFrom({
      model: config.model ?? facts?.model,
      windowTokens: facts?.windowTokens ?? override ?? CODEX_DEFAULT_WINDOW,
      instructionsTokens: facts?.instructionsTokens,
      memoryFiles,
      statuses: snapshot.statuses ?? [],
      skills: skills.skills,
      errors: [snapshot.error, skills.error],
    });
  });
