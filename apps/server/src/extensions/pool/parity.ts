// @effect-diagnostics globalTimers:off - the pool's process manager is plain async Node by design; Effect wraps it at the layer and handler boundary.
// @effect-diagnostics nodeBuiltinImport:off - reads the user's Claude settings file and home directory with plain Node.
/**
 * Native-parity checks: a pooled session must behave like direct Claude Code
 * and Codex. The most important one launches a Claude probe session exactly
 * as a pooled session launches (same env, same flag settings; no prompt, so no
 * API call) and asks it whether tool search is on. That catches the day a
 * Claude Code release drops `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, which
 * would otherwise silently load every MCP tool schema into every thread.
 */
import * as NodeFsPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { PoolCheck } from "@t3tools/contracts";

/** Env keys that undo a parity setting when the user's own Claude settings set them. */
const CONFLICTING_ENV: ReadonlyArray<{
  readonly name: string;
  readonly bad: (value: string) => boolean;
  readonly why: string;
}> = [
  { name: "FORCE_PROMPT_CACHING_5M", bad: Boolean, why: "forces the 5-minute cache" },
  { name: "DISABLE_PROMPT_CACHING", bad: Boolean, why: "turns prompt caching off" },
  {
    name: "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
    bad: Boolean,
    why: "turns off tool search and other native features",
  },
  {
    name: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    bad: (value) => /\[1m\]/i.test(value),
    why: "asks for a 1M Haiku, which doesn't exist (WebFetch and small tasks fail)",
  },
  {
    name: "ANTHROPIC_SMALL_FAST_MODEL",
    bad: (value) => /\[1m\]/i.test(value),
    why: "asks for a 1M small model, which doesn't exist",
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Conflicts in the user's Claude `settings.json` `env` block and T3's own environment. */
export const findEnvConflicts = (
  settingsEnv: Readonly<Record<string, unknown>>,
  processEnv: NodeJS.ProcessEnv,
): string[] =>
  CONFLICTING_ENV.flatMap(({ name, bad, why }) => {
    const fromSettings = settingsEnv[name];
    const value = typeof fromSettings === "string" ? fromSettings : processEnv[name];
    return typeof value === "string" &&
      value !== "" &&
      value !== "0" &&
      value !== "false" &&
      bad(value)
      ? [`${name} ${why}`]
      : [];
  });

export const readClaudeSettingsEnv = async (
  claudeConfigDir: string | undefined,
): Promise<Record<string, unknown>> => {
  const path = NodePath.join(
    claudeConfigDir || NodePath.join(NodeOS.homedir(), ".claude"),
    "settings.json",
  );
  try {
    const parsed: unknown = JSON.parse(await NodeFsPromises.readFile(path, "utf8"));
    return isRecord(parsed) && isRecord(parsed.env) ? parsed.env : {};
  } catch {
    return {};
  }
};

export interface ToolSearchProbe {
  readonly executablePath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly flagSettings: Readonly<Record<string, unknown>>;
  readonly baseOptions: ClaudeQueryOptions;
}

/**
 * True when the probe session defers tool schemas (tool search on). Claude
 * reports deferred categories ("System tools (deferred)", "MCP tools
 * (deferred)") only when tool search is active, whether or not MCP is used.
 */
export const probeToolSearch = async (probe: ToolSearchProbe): Promise<boolean> => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  const { mcpServers: _mcpServers, ...base } = probe.baseOptions;
  const session = claudeQuery({
    prompt: (async function* () {
      await new Promise((resolve) => abort.signal.addEventListener("abort", resolve));
    })(),
    options: {
      ...base,
      abortController: abort,
      strictMcpConfig: false,
      settings: {
        ...(isRecord(base.settings) ? base.settings : {}),
        ...probe.flagSettings,
      } as Exclude<ClaudeQueryOptions["settings"], string | undefined>,
      env: probe.env as Record<string, string | undefined>,
    },
  });
  try {
    await session.initializationResult();
    const usage = await session.getContextUsage({ detail: "summary" });
    return usage.categories.some((category) => {
      const kind = (category as { readonly kind?: unknown }).kind;
      return (kind === "deferred" || category.isDeferred === true) && category.tokens > 0;
    });
  } finally {
    clearTimeout(timer);
    abort.abort();
    session.close();
  }
};

export const check = (
  id: string,
  label: string,
  state: PoolCheck["state"],
  detail?: string,
): PoolCheck => ({ id, label, state, ...(detail ? { detail } : {}) });
