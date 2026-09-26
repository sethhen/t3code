/**
 * `<stateDir>/skills-mcp/mcp.json`: the user-scope MCP servers the panel
 * manages, each with a desired per-app enabled flag. The apps' own configs stay
 * the source of truth for what actually loads; the store remembers servers
 * that are switched off in an app (Claude has no disabled flag, so a disabled
 * server is removed from Claude and only the store keeps its entry).
 */
import { AgentAppFlags, McpServerSpec } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { makeJsonDocument } from "../shared/jsonDocument.ts";

const Extras = Schema.Record(Schema.String, Schema.Unknown);

export const StoredMcpServer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  spec: McpServerSpec,
  apps: AgentAppFlags,
  description: Schema.optional(Schema.String),
  homepage: Schema.optional(Schema.String),
  tags: Schema.Array(Schema.String),
  /**
   * Raw app fields the spec does not model (Claude `timeout`, Codex
   * `startup_timeout_sec`, ...), written back with the spec. They always belong
   * to the stored spec's transport and are dropped when it changes.
   */
  extras: Schema.optional(
    Schema.Struct({ claude: Schema.optional(Extras), codex: Schema.optional(Extras) }),
  ),
  /**
   * An app's own complete entry, written back verbatim instead of one built
   * from `spec`: Claude's entry while the server is disabled there (Claude
   * keeps nothing for a removed server; re-added on enable, then cleared), and
   * Codex's table when an import found it defined differently from Claude's
   * (restored if the table goes missing). An upsert drops both.
   */
  raw: Schema.optional(
    Schema.Struct({ claude: Schema.optional(Extras), codex: Schema.optional(Extras) }),
  ),
});
export type StoredMcpServer = typeof StoredMcpServer.Type;

const McpStore = Schema.Struct({
  /** Set by the first import; until then `mcp.list` adopts the apps' user servers. */
  importedAt: Schema.optional(Schema.String),
  servers: Schema.Array(StoredMcpServer),
});
export type McpStore = typeof McpStore.Type;

export const mcpStore = makeJsonDocument("mcp.json", McpStore, () => ({ servers: [] }));
