/**
 * `context.get`: what each agent loads into a new thread before the first
 * message (both estimated: Claude by Claude, Codex by the panel). `usage.get`: what the
 * agents actually called, counted from their own transcripts.
 */
import type { AppContext, ContextOverview, UsageReport } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { effectiveCwd } from "../mcp/claude.ts";
import { probeClaude } from "../mcp/probes.ts";
import { type AgentCli, agentAppInfo, resolveAgentClis } from "../shared/agents.ts";
import { claudeAppContext } from "./claudeContext.ts";
import { codexAppContext } from "./codexContext.ts";
import { clampUsageDays, collectUsage, type UsageRoot } from "./usage.ts";

const APP_NAMES = { claude: "Claude Code", codex: "Codex" } as const;

const unavailable = (cli: AgentCli, reason: string | undefined): AppContext => ({
  exact: false,
  baselineTokens: 0,
  categories: [],
  mcpServers: [],
  skills: [],
  memoryFiles: [],
  error: `${APP_NAMES[cli.app]} is not available${reason ? `: ${reason}` : ""}`,
});

const appContext = (cli: AgentCli, cwd: string, refresh: boolean) =>
  Effect.gen(function* () {
    const info = yield* agentAppInfo(cli);
    if (!info.available) return unavailable(cli, info.error);
    return cli.app === "claude"
      ? claudeAppContext(yield* probeClaude(cli, cwd, { refresh }))
      : yield* codexAppContext(cli, cwd, refresh);
  });

export const getContext = Effect.fn("skillsMcp.context.get")(function* (input: {
  readonly cwd?: string | undefined;
  readonly refresh?: boolean | undefined;
}) {
  const clis = yield* resolveAgentClis;
  const cwd = effectiveCwd(input.cwd);
  const refresh = input.refresh ?? false;
  const [claude, codex] = yield* Effect.all(
    [appContext(clis.claude, cwd, refresh), appContext(clis.codex, cwd, refresh)],
    { concurrency: "unbounded" },
  );
  return {
    apps: { claude, codex },
    checkedAt: DateTime.formatIso(yield* DateTime.now),
  } satisfies ContextOverview;
});

export const getUsage = Effect.fn("skillsMcp.usage.get")(function* (input: {
  readonly days: number;
  readonly refresh?: boolean | undefined;
}) {
  const days = clampUsageDays(input.days);
  const clis = yield* resolveAgentClis;
  const path = yield* Path.Path;
  const roots: ReadonlyArray<UsageRoot> = [
    { app: "claude", dir: path.join(clis.claude.configDir, "projects") },
    { app: "codex", dir: path.join(clis.codex.configDir, "sessions") },
    { app: "codex", dir: path.join(clis.codex.configDir, "archived_sessions") },
  ];
  const apps = yield* collectUsage({ days, refresh: input.refresh ?? false, roots });
  return {
    days,
    apps,
    scannedAt: DateTime.formatIso(yield* DateTime.now),
  } satisfies UsageReport;
});
