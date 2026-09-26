/**
 * The live MCP probes, shared by `mcp.list` and the context module so one
 * panel open starts at most one Claude session and one Codex app-server per
 * cwd. Results are cached for a minute per CLI and cwd and concurrent callers
 * share a probe in flight; `refresh` skips a settled result but still joins a
 * probe in flight (a listing only while its statuses are pending).
 * Probes never fail the caller: problems land in `error`.
 *
 * Claude and Codex rewrite their config files when they start (and Claude
 * again on exit), so a probe overlapping a config write can put back its stale
 * copy and silently drop the write. Every read that spawns an app goes through
 * `gatedRead` and every write to its config through `withAgentWrite`: a write
 * first interrupts the reads in flight for that app and waits for their
 * processes to exit, and new reads wait until the write is done (then rerun,
 * so their callers get post-write results).
 */
import type { AgentApp } from "@t3tools/contracts";
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
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

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
  /**
   * Skip a settled result even when it is under a minute old. A probe in flight
   * is still shared, except one whose Claude statuses were already listed.
   */
  readonly refresh?: boolean | undefined;
}

/**
 * `cached` reuses a fresh slot, `refresh` only one still in flight, `force`
 * none (the probe must do something an in-flight one will not).
 */
export type SlotMode = "cached" | "refresh" | "force";

const CACHE_TTL_MS = 60_000;
/** Failed probes are retried sooner, but not by every request in a burst. */
const FAILURE_TTL_MS = 10_000;

/** One cached probe per CLI and cwd; `settledAt` stays undefined while it runs. */
export interface Slot {
  settledAt: number | undefined;
  failed: boolean;
}

const isFresh = (slot: Slot, now: number) =>
  slot.settledAt === undefined ||
  now - slot.settledAt < (slot.failed ? FAILURE_TTL_MS : CACHE_TTL_MS);

const slotKey = (cli: AgentCli, cwd: string) => `${cli.binaryPath}|${cli.configDir}|${cwd}`;

const modeOf = (options: ProbeOptions | undefined): SlotMode =>
  options?.refresh ? "refresh" : "cached";

/**
 * The reusable slot for `key` under `mode`, or a new one whose probe runs
 * detached, so a caller that goes away does not strand the others waiting on it.
 * Exported for tests.
 */
export const slotFor = <S extends Slot, R>(
  slots: Map<string, S>,
  key: string,
  mode: SlotMode,
  make: () => S,
  run: (slot: S) => Effect.Effect<void, never, R>,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cached = slots.get(key);
    const reusable =
      cached !== undefined &&
      (mode === "cached"
        ? isFresh(cached, now)
        : mode === "refresh" && cached.settledAt === undefined);
    if (reusable) return cached;
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
// Write gate

interface Reader {
  /** Completed by a write that needs this read out of the way. */
  readonly preempt: Deferred.Deferred<void>;
  /** Completed once the read (and so its process) is gone. */
  readonly done: Deferred.Deferred<void>;
}

interface Gate {
  /** One write at a time per app. */
  readonly lock: Semaphore.Semaphore;
  /** Set while a write runs; new reads wait for it. */
  writing: Deferred.Deferred<void> | undefined;
  readonly readers: Set<Reader>;
}

const makeGate = (): Gate => ({
  lock: Semaphore.makeUnsafe(1),
  writing: undefined,
  readers: new Set(),
});

/** Module-level, like the slots: one gate per app for the whole server. */
const gates: Record<AgentApp, Gate> = { claude: makeGate(), codex: makeGate() };

/**
 * Runs `read`, a session of `app` that may rewrite its config, outside that
 * app's writes: it waits while a write runs, and a write that starts while it
 * runs interrupts it (its process exits before the write begins) and then
 * reruns it. Never call it inside a write to the same app.
 */
export const gatedRead = <A, E, R>(
  app: AgentApp,
  read: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const gate = gates[app];
    if (gate.writing) return Effect.andThen(Deferred.await(gate.writing), gatedRead(app, read));
    const reader: Reader = { preempt: Deferred.makeUnsafe(), done: Deferred.makeUnsafe() };
    gate.readers.add(reader);
    return Effect.raceFirst(
      Effect.map(read, Option.some),
      Effect.as(Deferred.await(reader.preempt), Option.none<A>()),
    ).pipe(
      // `raceFirst` returns only after the loser's finalizers ran.
      Effect.ensuring(
        Effect.suspend(() => {
          gate.readers.delete(reader);
          return Deferred.succeed(reader.done, undefined);
        }),
      ),
      Effect.flatMap((result) =>
        Option.isSome(result) ? Effect.succeed(result.value) : gatedRead(app, read),
      ),
    );
  });

/** Cached results from before a write to `app`; probes still running rerun after it. */
const dropSettledSlots = (app: AgentApp) => {
  if (app === "claude") {
    for (const [key, slot] of claudeSlots) {
      if (slot.settledAt !== undefined || Deferred.isDoneUnsafe(slot.statuses)) {
        claudeSlots.delete(key);
      }
    }
  } else {
    for (const [key, slot] of codexSlots) {
      if (slot.settledAt !== undefined) codexSlots.delete(key);
    }
  }
};

const writeGate = <A, E, R>(app: AgentApp, write: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const gate = gates[app];
    return gate.lock.withPermit(
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const writing = Deferred.makeUnsafe<void>();
          gate.writing = writing;
          return writing;
        }),
        () =>
          Effect.suspend(() => {
            const readers = [...gate.readers];
            return Effect.forEach(
              readers,
              (reader) => Deferred.succeed(reader.preempt, undefined),
              {
                discard: true,
              },
            ).pipe(
              Effect.andThen(
                Effect.forEach(readers, (reader) => Deferred.await(reader.done), { discard: true }),
              ),
              Effect.andThen(write),
            );
          }),
        (writing) =>
          Effect.suspend(() => {
            gate.writing = undefined;
            dropSettledSlots(app);
            return Deferred.succeed(writing, undefined);
          }),
      ),
    );
  });

/**
 * Runs `write` (to the config of each of `apps`) with no gated read of those
 * apps running: reads in flight are interrupted and awaited first, new ones
 * wait, and cached probe results of those apps are dropped afterwards. Gates
 * are taken in a fixed order (Claude, then Codex).
 */
export const withAgentWrite = <A, E, R>(
  apps: ReadonlyArray<AgentApp>,
  write: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  (["claude", "codex"] as const)
    .filter((app) => apps.includes(app))
    .reduceRight((inner, app) => writeGate(app, inner), write);

// ---------------------------------------------------------------------------
// Claude

export interface ClaudeProbe {
  /** `query.mcpServerStatus()` once no server is pending (or the wait ran out); empty on error. */
  readonly statuses: ReadonlyArray<McpServerStatus>;
  /**
   * `query.getContextUsage({ detail: "summary" })` from the same session:
   * Claude's local estimate (the "full" detail calls the token-count API).
   */
  readonly contextUsage?: SDKControlGetContextUsageResponse | undefined;
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

/** Claude's local estimate; the "full" detail calls the token-count API per category. */
const contextUsageOf = (query: Query) =>
  claudeCall("context usage", () => query.getContextUsage({ detail: "summary" })).pipe(
    Effect.timeoutOrElse({
      duration: CONTEXT_TIMEOUT,
      orElse: () =>
        Effect.fail(new ExtensionFailure({ message: "Claude context usage timed out" })),
    }),
    Effect.map((contextUsage) => ({ contextUsage })),
    Effect.catch((failure) => Effect.succeed({ contextError: failure.message })),
  );

const runClaudeProbe = (cli: AgentCli, cwd: string, slot: ClaudeSlot) =>
  gatedRead(
    "claude",
    withClaudeQuery(cli, cwd, (query) =>
      Effect.gen(function* () {
        const statuses = yield* settledStatuses(query);
        const checkedAt = yield* nowIso;
        // A no-op when a run interrupted by a write already sent its statuses.
        yield* Deferred.succeed(slot.statuses, { statuses, checkedAt });
        const usage = yield* contextUsageOf(query);
        return { statuses, checkedAt, ...usage } satisfies ClaudeProbe;
      }),
    ),
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

/**
 * A refreshed listing (`statusesOnly`) does not join a probe whose statuses
 * already went out: that one is only finishing context usage.
 */
const claudeSlot = (
  cli: AgentCli,
  cwd: string,
  options: ProbeOptions | undefined,
  statusesOnly = false,
) =>
  Effect.suspend(() => {
    const key = slotKey(cli, cwd);
    const current = claudeSlots.get(key);
    const listed =
      statusesOnly &&
      options?.refresh === true &&
      current !== undefined &&
      Deferred.isDoneUnsafe(current.statuses);
    return slotFor(
      claudeSlots,
      key,
      listed ? "force" : modeOf(options),
      (): ClaudeSlot => ({
        settledAt: undefined,
        failed: false,
        statuses: Deferred.makeUnsafe(),
        probe: Deferred.makeUnsafe(),
      }),
      (slot) => runClaudeProbe(cli, cwd, slot),
    );
  });

/**
 * Claude's live MCP servers and context usage at `cwd`, from one thread-less
 * Agent SDK session that loads MCP config the way a thread does.
 */
export const probeClaude = (cli: AgentCli, cwd: string, options?: ProbeOptions) =>
  Effect.flatMap(claudeSlot(cli, cwd, options), (slot) => Deferred.await(slot.probe));

/** The statuses part of `probeClaude`, without waiting for context usage. */
export const probeClaudeStatuses = (cli: AgentCli, cwd: string, options?: ProbeOptions) =>
  Effect.flatMap(claudeSlot(cli, cwd, options, true), (slot) => Deferred.await(slot.statuses));

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
  gatedRead(
    "codex",
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
    ),
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
 * `reload` first restarts the MCP servers from config, so it never joins a
 * probe that did not.
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
      reload ? "force" : modeOf(options),
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

/**
 * Drops every cached Claude and Codex probe after a write to agent config (MCP
 * servers, plugins, skills). Probes in flight still finish for their callers,
 * but later ones start fresh.
 */
export const invalidateAgentProbes = Effect.sync(() => {
  claudeSlots.clear();
  codexSlots.clear();
});
