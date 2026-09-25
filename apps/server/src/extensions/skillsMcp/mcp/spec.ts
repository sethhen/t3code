/**
 * Converts between the contract's `McpServerSpec` and each app's own server
 * entry: Claude's `.claude.json` / `.mcp.json` shape (the JSON that
 * `claude mcp add-json` takes) and Codex's `mcp_servers.<name>` TOML table as
 * `config/read` returns it. Fields a spec does not model are kept as "extras"
 * so writing an imported server back does not drop them.
 */
import type { McpServerSpec } from "@t3tools/contracts";

export type JsonObject = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** The string-valued entries of an object; undefined when there are none. */
export const stringMap = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const stringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
};

const stdioSpec = (
  command: string,
  args: string[] | undefined,
  env: Record<string, string> | undefined,
  cwd: string | undefined,
): McpServerSpec => ({
  type: "stdio",
  command,
  ...(args ? { args } : {}),
  ...(env ? { env } : {}),
  ...(cwd ? { cwd } : {}),
});

/** A Claude server entry as a spec; undefined for transports the contract lacks (sdk, ws, ...). */
export const specFromClaude = (entry: unknown): McpServerSpec | undefined => {
  if (!isRecord(entry)) return undefined;
  const url = nonEmptyString(entry.url);
  const headers = stringMap(entry.headers);
  if (url && (entry.type === "http" || entry.type === "sse" || entry.type === undefined)) {
    return { type: entry.type === "sse" ? "sse" : "http", url, ...(headers ? { headers } : {}) };
  }
  const command = nonEmptyString(entry.command);
  if (command && (entry.type === "stdio" || entry.type === undefined)) {
    return stdioSpec(
      command,
      stringArray(entry.args),
      stringMap(entry.env),
      nonEmptyString(entry.cwd),
    );
  }
  return undefined;
};

/**
 * The JSON for `claude mcp add-json`. Claude has no bearer-token env var, and
 * it keeps but ignores a stdio `cwd`.
 */
export const specToClaude = (spec: McpServerSpec): JsonObject => {
  switch (spec.type) {
    case "stdio":
      return {
        type: "stdio",
        command: spec.command,
        args: [...(spec.args ?? [])],
        ...(spec.env ? { env: { ...spec.env } } : {}),
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
      };
    case "http":
    case "sse":
      return {
        type: spec.type,
        url: spec.url,
        ...(spec.headers ? { headers: { ...spec.headers } } : {}),
      };
  }
};

/** A normalized Codex `mcp_servers.<name>` table as a spec. */
export const specFromCodex = (entry: unknown): McpServerSpec | undefined => {
  if (!isRecord(entry)) return undefined;
  const command = nonEmptyString(entry.command);
  if (command) {
    return stdioSpec(
      command,
      stringArray(entry.args),
      stringMap(entry.env),
      nonEmptyString(entry.cwd),
    );
  }
  const url = nonEmptyString(entry.url);
  if (!url) return undefined;
  const headers = stringMap(entry.http_headers);
  const bearerTokenEnvVar = nonEmptyString(entry.bearer_token_env_var);
  return {
    type: "http",
    url,
    ...(headers ? { headers } : {}),
    ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
  };
};

/** The Codex `mcp_servers.<name>` value, without `enabled`; undefined for SSE (Codex has none). */
export const specToCodex = (spec: McpServerSpec): JsonObject | undefined => {
  switch (spec.type) {
    case "stdio":
      return {
        command: spec.command,
        ...(spec.args && spec.args.length > 0 ? { args: [...spec.args] } : {}),
        ...(spec.env ? { env: { ...spec.env } } : {}),
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
      };
    case "http":
      return {
        url: spec.url,
        ...(spec.headers ? { http_headers: { ...spec.headers } } : {}),
        ...(spec.bearerTokenEnvVar ? { bearer_token_env_var: spec.bearerTokenEnvVar } : {}),
      };
    case "sse":
      return undefined;
  }
};

const CLAUDE_SPEC_KEYS = new Set(["type", "command", "args", "env", "cwd", "url", "headers"]);
/**
 * Keys the spec owns in a Codex table. `type` is not a Codex key (Codex infers
 * the transport from `command` vs `url` and warns that `type` is ignored), but
 * tools such as CC Switch write it; it is dropped so it is never written back.
 */
const CODEX_SPEC_KEYS = new Set([
  "type",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "http_headers",
  "bearer_token_env_var",
  "enabled",
]);

/** Claude entry fields the spec does not model (e.g. `timeout`, `oauth`). */
export const claudeExtras = (entry: JsonObject): JsonObject | undefined => {
  const extras = Object.entries(entry).filter(([key]) => !CLAUDE_SPEC_KEYS.has(key));
  return extras.length > 0 ? Object.fromEntries(extras) : undefined;
};

/**
 * Codex table fields the spec does not model (e.g. `startup_timeout_sec`).
 * Drops the nulls and the `environment_id = "local"` default that `config/read`
 * fills in.
 */
export const codexExtras = (entry: JsonObject): JsonObject | undefined => {
  const extras = Object.entries(entry).filter(
    ([key, value]) =>
      !CODEX_SPEC_KEYS.has(key) &&
      value !== null &&
      value !== undefined &&
      !(key === "environment_id" && value === "local"),
  );
  return extras.length > 0 ? Object.fromEntries(extras) : undefined;
};

/** The `add-json` payload: extras only survive while the transport is unchanged. */
export const claudeEntryFor = (
  spec: McpServerSpec,
  extras: { readonly spec?: McpServerSpec | undefined; readonly fields?: JsonObject | undefined },
): JsonObject => ({
  ...(extras.spec?.type === spec.type ? extras.fields : undefined),
  ...specToClaude(spec),
});

/** The Codex table to write, or undefined for SSE. */
export const codexEntryFor = (
  spec: McpServerSpec,
  enabled: boolean,
  extras: { readonly spec?: McpServerSpec | undefined; readonly fields?: JsonObject | undefined },
): JsonObject | undefined => {
  const value = specToCodex(spec);
  if (!value) return undefined;
  const fields = extras.spec?.type === spec.type ? extras.fields : undefined;
  return {
    ...(fields ? codexExtras(fields) : undefined),
    ...value,
    enabled,
  };
};
