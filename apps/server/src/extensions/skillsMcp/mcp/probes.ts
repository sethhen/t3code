/**
 * The live MCP probes, shared by `mcp.list` and the context module so one
 * panel open starts at most one Claude session and one Codex app-server per
 * cwd. Results are cached for a minute per CLI and cwd (`refresh` bypasses the
 * cache) and concurrent callers share a probe in flight. Probes never fail the
 * caller: problems land in `error`.
 */
import type {
  McpServerStatus,
  Query,
  SDKControlGetContextUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";

import { type AgentCli, describeCause, withCodexClient } from "../shared/agents.ts";
import { ExtensionFailure } from "../shared/t3.ts";
import { claudeCall, withClaudeQuery } from "./claude.ts";
import { codexCall, listCodexStatuses } from "./codex.ts";
import { isRecord } from "./spec.ts";

export type {
  McpServerStatus as ClaudeMcpServerStatus,
  SDKControlGetContextUsageResponse as ClaudeContextUsage,
} from "@anthropic-ai/claude-agent-sdk";

export interface ProbeOptions {
  /** Start a new probe even when a cached one is under a minute old. */
  readonly refresh?: boolean | undefined;
}

const CACHE_TTL_MS = 60_000;
/** Failed probes are retried sooner, but not by every request in a burst. */
const FAILURE_TTL_MS = 10_000;

/** One cached probe per CLI and cwd; `settledAt` stays undefined while it runs. */
interface Slot {
  settledAt: number | undefined;
  failed: boolean;
}

const isFresh = (slot: Slot, now: number) =>
  slot.settledAt === undefined ||
  now - slot.settledAt < (slot.failed ? FAILURE_TTL_MS : CACHE_TTL_MS);

const slotKey = (cli: AgentCli, cwd: string) => `${cli.binaryPath}|${cli.configDir}|${cwd}`;

/**
 * The fresh slot for `key`, or a new one whose probe runs detached, so a
 * caller that goes away does not strand the others waiting on it.
 */
const slotFor = <S extends Slot, R>(
  slots: Map<string, S>,
  key: string,
  refresh: boolean,
  make: () => S,
  run: (slot: S) => Effect.Effect<void, never, R>,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cached = slots.get(key);
    if (!refresh && cached && isFresh(cached, now)) return cached;
    const slot = make();
    slots.set(key, slot);
    yield* Effect.forkDetach(run(slot));
    return slot;
  });

const settle = (slot: Slot, failed: boolean) =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    slot.settledAt = now;
    slot.failed = failed;
  });

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const causeMessage = (cause: Cause.Cause<ExtensionFailure>) =>
  Cause.hasInterruptsOnly(cause) ? "Probe was interrupted" : describeCause(Cause.squash(cause));

// ---------------------------------------------------------------------------
// Claude

export interface ClaudeProbe {
  /** `query.mcpServerStatus()` once no server is pending (or the wait ran out); empty on error. */
  readonly statuses: ReadonlyArray<McpServerStatus>;
  /** `query.getContextUsage()` from the same session; undefined when both detail levels failed. */
  readonly contextUsage?: SDKControlGetContextUsageResponse | undefined;
  /** `"full"` counts tokens through the API; `"summary"` is Claude's local estimate. */
  readonly contextDetail?: "full" | "summary" | undefined;
  /** Why `contextUsage` is missing. */
  readonly contextError?: string | undefined;
  /** The session or status listing failed. */
  readonly error?: string | undefined;
  readonly checkedAt: string;
}

type ClaudeStatuses = Pick<ClaudeProbe, "statuses" | "error" | "checkedAt">;

interface ClaudeSlot extends Slot {
  /** Completes once the statuses settle, before context usage (what `mcp.list` waits for). */
  readonly statuses: Deferred.Deferred<ClaudeStatuses>;
  readonly probe: Deferred.Deferred<ClaudeProbe>;
}

/** How long to wait for servers still connecting before reporting them as pending. */
const PENDING_DEADLINE_MS = 15_000;
const PENDING_POLL = Duration.millis(500);
const CONTEXT_TIMEOUT = Duration.seconds(15);

/** `mcpServerStatus()`, re-polled (bounded) while any server is still connecting. */
const settledStatuses = Effect.fn("skillsMcp.mcp.claudeSettledStatuses")(function* (query: Query) {
  const deadline = (yield* Clock.currentTimeMillis) + PENDING_DEADLINE_MS;
  let statuses = yield* claudeCall("MCP status", () => query.mcpServerStatus());
  while (
    statuses.some((server) => server.status === "pending") &&
    (yield* Clock.currentTimeMillis) < deadline
  ) {
    yield* Effect.sleep(PENDING_POLL);
    statuses = yield* claudeCall("MCP status", () => query.mcpServerStatus());
  }
  return statuses;
});

const contextUsageAt = (query: Query, detail: "full" | "summary") =>
  claudeCall(`context usage (${detail})`, () => query.getContextUsage({ detail })).pipe(
    Effect.timeoutOrElse({
      duration: CONTEXT_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new ExtensionFailure({ message: `Claude context usage (${detail}) timed out` }),
        ),
    }),
    Effect.map((contextUsage) => ({ contextUsage, contextDetail: detail })),
  );

/**
 * Exact token counts first; a local proxy may not support the count API, so
 * fall back to Claude's estimate, and to nothing when that fails too.
 */
const contextUsageOf = (query: Query) =>
  contextUsageAt(query, "full").pipe(
    Effect.catch((full) =>
      contextUsageAt(query, "summary").pipe(
        Effect.catch((summary) =>
          Effect.succeed({ contextError: `${full.message}; ${summary.message}` }),
        ),
      ),
    ),
  );

const runClaudeProbe = (cli: AgentCli, cwd: string, slot: ClaudeSlot) =>
  withClaudeQuery(cli, cwd, (query) =>
    Effect.gen(function* () {
      const statuses = yield* settledStatuses(query);
      const checkedAt = yield* nowIso;
      yield* Deferred.succeed(slot.statuses, { statuses, checkedAt });
      const usage = yield* contextUsageOf(query);
      return { statuses, checkedAt, ...usage } satisfies ClaudeProbe;
    }),
  ).pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const probe: ClaudeProbe = Exit.isSuccess(exit)
          ? exit.value
          : { statuses: [], error: causeMessage(exit.cause), checkedAt: yield* nowIso };
        // Either completion is a no-op when the statuses already went out.
        yield* Deferred.succeed(slot.statuses, probe);
        yield* Deferred.succeed(slot.probe, probe);
        yield* settle(slot, probe.error !== undefined);
      }),
    ),
    Effect.exit,
    Effect.asVoid,
  );

/** Module-level: the handler registry is rebuilt per ws connection. */
const claudeSlots = new Map<string, ClaudeSlot>();

const claudeSlot = (cli: AgentCli, cwd: string, refresh: boolean) =>
  slotFor(
    claudeSlots,
    slotKey(cli, cwd),
    refresh,
    (): ClaudeSlot => ({
      settledAt: undefined,
      failed: false,
      statuses: Deferred.makeUnsafe(),
      probe: Deferred.makeUnsafe(),
    }),
    (slot) => runClaudeProbe(cli, cwd, slot),
  );

/**
 * Claude's live MCP servers and context usage at `cwd`, from one thread-less
 * Agent SDK session that loads MCP config the way a thread does.
 */
export const probeClaude = (cli: AgentCli, cwd: string, options?: ProbeOptions) =>
  Effect.flatMap(claudeSlot(cli, cwd, options?.refresh ?? false), (slot) =>
    Deferred.await(slot.probe),
  );

/** The statuses part of `probeClaude`, without waiting for context usage. */
export const probeClaudeStatuses = (cli: AgentCli, cwd: string, options?: ProbeOptions) =>
  Effect.flatMap(claudeSlot(cli, cwd, options?.refresh ?? false), (slot) =>
    Deferred.await(slot.statuses),
  );

/** Drops every cached Claude probe (after a write); probes in flight still finish. */
export const invalidateClaudeProbes = Effect.sync(() => claudeSlots.clear());

// ---------------------------------------------------------------------------
// Codex

export interface CodexMcpTool {
  readonly name: string;
  readonly title?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: unknown;
}

/**
 * One `mcpServerStatus/list {detail: "full"}` item as the app-server sends it
 * (only `name`, `tools` and the resource lists are normalised).
 */
export interface CodexMcpServerStatus {
  readonly name: string;
  readonly authStatus?: "unknown" | "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
  /** Null without a running thread, which is always the case here. */
  readonly runtimeStatus?: string | null | undefined;
  readonly toolsError?: string | null | undefined;
  readonly pluginId?: string | null | undefined;
  readonly httpOrigin?: string | null | undefined;
  readonly serverInfo?: { readonly name?: string; readonly version?: string } | null | undefined;
  readonly serverCapabilities?: unknown;
  /** Keyed by the tool's qualified name. */
  readonly tools: Readonly<Record<string, CodexMcpTool>>;
  readonly resources: ReadonlyArray<unknown>;
  readonly resourceTemplates: ReadonlyArray<unknown>;
}

export interface CodexProbe {
  /** Empty when the listing failed. */
  readonly statuses: ReadonlyArray<CodexMcpServerStatus>;
  readonly error?: string | undefined;
  readonly checkedAt: string;
}

/** What `mcp.list` needs: the config too, from the same app-server session. */
export interface CodexSnapshot {
  /** The raw `config/read` response; undefined when the session failed. */
  readonly config: unknown;
  /** Undefined when the status listing failed (see `error`); the config still applies. */
  readonly statuses: ReadonlyArray<CodexMcpServerStatus> | undefined;
  readonly error?: string | undefined;
  readonly checkedAt: string;
}

interface CodexSlot extends Slot {
  readonly snapshot: Deferred.Deferred<CodexSnapshot>;
}

const codexStatus = (item: unknown): CodexMcpServerStatus[] =>
  isRecord(item) && typeof item.name === "string"
    ? [
        {
          ...item,
          name: item.name,
          tools: (isRecord(item.tools) ? item.tools : {}) as Record<string, CodexMcpTool>,
          resources: Array.isArray(item.resources) ? item.resources : [],
          resourceTemplates: Array.isArray(item.resourceTemplates) ? item.resourceTemplates : [],
        } as CodexMcpServerStatus,
      ]
    : [];

const runCodexProbe = (cli: AgentCli, cwd: string, reload: boolean, slot: CodexSlot) =>
  withCodexClient(cli, cwd, (client) =>
    Effect.gen(function* () {
      if (reload) yield* codexCall(client, "config/mcpServer/reload");
      const config = yield* codexCall(client, "config/read", { includeLayers: false, cwd });
      const listed = yield* Effect.result(listCodexStatuses(client));
      const checkedAt = yield* nowIso;
      return Result.isFailure(listed)
        ? { config, statuses: undefined, error: listed.failure.message, checkedAt }
        : { config, statuses: listed.success.flatMap(codexStatus), checkedAt };
    }),
  ).pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const snapshot: CodexSnapshot = Exit.isSuccess(exit)
          ? exit.value
          : {
              config: undefined,
              statuses: undefined,
              error: causeMessage(exit.cause),
              checkedAt: yield* nowIso,
            };
        yield* Deferred.succeed(slot.snapshot, snapshot);
        yield* settle(slot, snapshot.error !== undefined);
      }),
    ),
    Effect.exit,
    Effect.asVoid,
  );

/** Module-level: the handler registry is rebuilt per ws connection. */
const codexSlots = new Map<string, CodexSlot>();

/**
 * Codex's config and live MCP status at `cwd` from one app-server session.
 * `reload` first restarts the MCP servers from config (and implies `refresh`).
 */
export const codexSnapshot = (
  cli: AgentCli,
  cwd: string,
  options?: ProbeOptions & { readonly reload?: boolean | undefined },
) => {
  const reload = options?.reload ?? false;
  return Effect.flatMap(
    slotFor(
      codexSlots,
      slotKey(cli, cwd),
      reload || (options?.refresh ?? false),
      (): CodexSlot => ({ settledAt: undefined, failed: false, snapshot: Deferred.makeUnsafe() }),
      (slot) => runCodexProbe(cli, cwd, reload, slot),
    ),
    (slot) => Deferred.await(slot.snapshot),
  );
};

/** Codex's live MCP servers at `cwd`, including each tool's input schema. */
export const probeCodex = (cli: AgentCli, cwd: string, options?: ProbeOptions) =>
  Effect.map(codexSnapshot(cli, cwd, options), (snapshot): CodexProbe => ({
    statuses: snapshot.statuses ?? [],
    ...(snapshot.error ? { error: snapshot.error } : {}),
    checkedAt: snapshot.checkedAt,
  }));

/** Drops every cached Codex probe (after a write); probes in flight still finish. */
export const invalidateCodexProbes = Effect.sync(() => codexSlots.clear());
