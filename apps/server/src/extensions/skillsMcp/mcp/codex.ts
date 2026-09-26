/**
 * Codex's side of the MCP panel, all through a short-lived `codex app-server`:
 * `config/read` for definitions, `mcpServerStatus/list` for live status and
 * tools, and `config/value/write` on `mcp_servers.<name>` for user-scope
 * writes (so Codex owns its TOML). The cached reads live in `probes.ts`.
 * Requests go through `client.raw` because the MCP methods are newer than the
 * generated schemas.
 */
import * as Effect from "effect/Effect";

import {
  type AgentCli,
  type CodexAppServerClient,
  describeCause,
  withCodexClient,
} from "../shared/agents.ts";
import { ExtensionFailure } from "../shared/t3.ts";
import { effectiveCwd } from "./claude.ts";
import { parseCodexConfig } from "./parse.ts";
import { codexExtras, isRecord, type JsonObject, specFromCodex } from "./spec.ts";

/** One app-server request, failing with `Codex <method>: <reason>`. */
export const codexCall = (client: CodexAppServerClient, method: string, payload?: unknown) =>
  client.raw
    .request(method, payload)
    .pipe(
      Effect.mapError(
        (cause) =>
          new ExtensionFailure({ message: `Codex ${method}: ${describeCause(cause)}`, cause }),
      ),
    );

/** Guards against a server that keeps returning a cursor. */
const MAX_STATUS_PAGES = 20;

/** Every `mcpServerStatus/list {detail: "full"}` item, following `nextCursor`. */
export const listCodexStatuses = Effect.fn("skillsMcp.mcp.codexListStatuses")(function* (
  client: CodexAppServerClient,
) {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_STATUS_PAGES; page++) {
    const response = yield* codexCall(client, "mcpServerStatus/list", {
      detail: "full",
      ...(cursor ? { cursor } : {}),
    });
    if (!isRecord(response)) break;
    if (Array.isArray(response.data)) items.push(...response.data);
    const next = response.nextCursor;
    if (typeof next !== "string" || next.length === 0) break;
    cursor = next;
  }
  return items;
});

/** Codex's server definitions at `cwd`, read fresh (the explicit import uses this). */
export const readCodexConfigServers = (cli: AgentCli, cwd: string) =>
  withCodexClient(cli, cwd, (client) =>
    codexCall(client, "config/read", { includeLayers: false, cwd }).pipe(
      Effect.map(parseCodexConfig),
    ),
  );

/**
 * One user-scope write: the full `mcp_servers.<name>` table (null deletes it),
 * or a toggle that sets only the table's `enabled` key.
 */
export type CodexWrite =
  | {
      readonly name: string;
      readonly value: JsonObject | null;
      /** Only write when the user config already has the name (e.g. disabling). */
      readonly ifPresent?: boolean;
    }
  | {
      readonly name: string;
      readonly enabled: boolean;
      /** The full table to write when the user config has none (restoring a drifted server). */
      readonly restore?: JsonObject | undefined;
    };

const sameTransport = (a: JsonObject, b: JsonObject) =>
  specFromCodex(a)?.type === specFromCodex(b)?.type;

/** The key path and value `write` sets, or undefined when there is nothing to write. */
const planWrite = (write: CodexWrite, existing: JsonObject | undefined) => {
  const table = `mcp_servers.${write.name}`;
  if ("enabled" in write) {
    if (existing) return { keyPath: `${table}.enabled`, value: write.enabled };
    return write.restore ? { keyPath: table, value: write.restore } : undefined;
  }
  if (!existing && (write.value === null || write.ifPresent)) return undefined;
  const value =
    write.value && existing && sameTransport(existing, write.value)
      ? { ...codexExtras(existing), ...write.value }
      : write.value;
  return { keyPath: table, value };
};

/**
 * Applies `writes` in order in one app-server session against the user
 * `config.toml`. Toggles touch only `enabled`, so they never overwrite a table
 * that changed outside T3. Deletes, `ifPresent` writes and plain toggles are
 * skipped for names the user config does not have, since Codex rejects
 * partial or dangling tables. A full write keeps the fields the spec does not
 * model from the table it replaces while the transport is unchanged (e.g. a
 * hand-added `startup_timeout_sec`).
 */
export const applyCodexWrites = (cli: AgentCli, writes: ReadonlyArray<CodexWrite>) =>
  writes.length === 0
    ? Effect.void
    : withCodexClient(cli, effectiveCwd(undefined), (client) =>
        Effect.gen(function* () {
          const userTables = new Map(
            parseCodexConfig(yield* codexCall(client, "config/read", { includeLayers: false }))
              .filter((server) => server.scope === "user" || server.scope === "unknown")
              .map((server) => [server.name, server.entry]),
          );
          for (const write of writes) {
            const existing = userTables.get(write.name);
            const plan = planWrite(write, existing);
            if (!plan) continue;
            yield* codexCall(client, "config/value/write", { ...plan, mergeStrategy: "replace" });
            if (plan.value === null) userTables.delete(write.name);
            else if (typeof plan.value === "boolean") {
              userTables.set(write.name, { ...existing, enabled: plan.value });
            } else userTables.set(write.name, plan.value);
          }
        }),
      );
