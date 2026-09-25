/**
 * Pure helpers for the MCP server dialog: text fields <-> McpServerSpec,
 * pasted Claude/CC Switch JSON -> spec, and secret masking for display.
 */
import type { AgentAppFlags, McpMutation, McpServerSpec } from "@t3tools/contracts";

export type McpTransport = McpServerSpec["type"];

export type Parsed<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: string };

const ok = <Value>(value: Value): Parsed<Value> => ({ ok: true, value });
const fail = (error: string): { readonly ok: false; readonly error: string } => ({
  ok: false,
  error,
});

/** Every field is text so the form can hold half-typed input. */
export interface McpServerForm {
  readonly name: string;
  readonly transport: McpTransport;
  /** A plain command, a quoted path, or a whole command line when Arguments is empty. */
  readonly command: string;
  /** One line, shell-style quoting. */
  readonly args: string;
  /** KEY=VALUE per line. */
  readonly env: string;
  readonly cwd: string;
  readonly url: string;
  /** `Name: value` per line. */
  readonly headers: string;
  readonly bearerTokenEnvVar: string;
  readonly description: string;
  readonly homepage: string;
  /** Not edited in the form; carried so an edit does not drop them. */
  readonly tags: readonly string[];
  readonly apps: AgentAppFlags;
}

export function emptyMcpServerForm(apps: AgentAppFlags): McpServerForm {
  return {
    name: "",
    transport: "stdio",
    command: "",
    args: "",
    env: "",
    cwd: "",
    url: "",
    headers: "",
    bearerTokenEnvVar: "",
    description: "",
    homepage: "",
    tags: [],
    apps,
  };
}

// ---------------------------------------------------------------------------
// Names and small validators

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^`|~0-9A-Za-z_-]+$/;

/** Codex only accepts `[A-Za-z0-9_-]` in server names; use that rule for both apps. */
export function serverNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Name is required.";
  if (!SERVER_NAME.test(trimmed)) return "Use letters, digits, - and _ only.";
  return null;
}

/** Turns a display name like "GitHub Copilot" into a valid server name. */
export function toServerName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function httpUrlError(value: string, label: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${label} must be a full URL.`;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? null
    : `${label} must start with http:// or https://.`;
}

/** Codex has no SSE transport, so SSE servers are Claude-only. */
export function codexTransportBlock(transport: McpTransport): string | null {
  return transport === "sse" ? "Codex has no SSE transport; use HTTP or stdio." : null;
}

// ---------------------------------------------------------------------------
// KEY=VALUE and Name: value lines

function stripQuotes(value: string): string {
  const first = value.charAt(0);
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

function contentLines(text: string): { readonly line: string; readonly number: number }[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line !== "" && !line.startsWith("#"));
}

export function parseEnvLines(text: string): Parsed<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const { line, number } of contentLines(text)) {
    const body = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) return fail(`Env line ${number}: expected KEY=VALUE.`);
    const key = body.slice(0, eq).trim();
    if (!ENV_NAME.test(key)) return fail(`Env line ${number}: "${key}" is not a valid name.`);
    env[key] = stripQuotes(body.slice(eq + 1).trim());
  }
  return ok(env);
}

export function formatEnvLines(env: Readonly<Record<string, string>> | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .map(([key, value]) => {
      const needsQuotes = value !== value.trim() || /^["']/.test(value);
      return `${key}=${needsQuotes ? `"${value}"` : value}`;
    })
    .join("\n");
}

export function parseHeaderLines(text: string): Parsed<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const { line, number } of contentLines(text)) {
    const colon = line.indexOf(":");
    if (colon <= 0) return fail(`Header line ${number}: expected Name: value.`);
    const name = line.slice(0, colon).trim();
    if (!HEADER_NAME.test(name)) {
      return fail(`Header line ${number}: "${name}" is not a valid header name.`);
    }
    headers[name] = line.slice(colon + 1).trim();
  }
  return ok(headers);
}

export function formatHeaderLines(headers: Readonly<Record<string, string>> | undefined): string {
  if (!headers) return "";
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Arguments

/**
 * Splits one line into arguments. Single quotes are literal, double quotes
 * honour `\"` and `\\`, and an unquoted backslash only escapes whitespace,
 * quotes, or another backslash (so `C:\tools` survives).
 */
export function splitArgs(line: string): Parsed<string[]> {
  const args: string[] = [];
  let current = "";
  let inArg = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    const next = line.charAt(index + 1);
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && (next === '"' || next === "\\")) {
        current += next;
        index += 1;
      } else if (char === '"') quote = null;
      else current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (inArg) args.push(current);
      current = "";
      inArg = false;
      continue;
    }
    inArg = true;
    if (char === '"' || char === "'") quote = char;
    else if (char === "\\" && next !== "" && /[\s"'\\]/.test(next)) {
      current += next;
      index += 1;
    } else current += char;
  }
  if (quote) return fail("Unclosed quote.");
  if (inArg) args.push(current);
  return ok(args);
}

const PLAIN_ARG = /^[^\s"'\\]+$/;

function quoteArg(arg: string): string {
  if (PLAIN_ARG.test(arg)) return arg;
  if (!arg.includes("'")) return `'${arg}'`;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function formatArgs(args: readonly string[] | undefined): string {
  return (args ?? []).map(quoteArg).join(" ");
}

/** A command with no spaces or quotes is taken verbatim so Windows paths keep their backslashes. */
function commandToField(command: string): string {
  return /[\s"']/.test(command) ? quoteArg(command) : command;
}

function parseCommand(
  commandField: string,
  argsField: string,
): Parsed<{ command: string; args: string[] }> {
  const raw = commandField.trim();
  if (raw === "") return fail("Command is required.");
  const extra = splitArgs(argsField);
  if (!extra.ok) return fail(`Arguments: ${extra.error}`);
  if (!/[\s"']/.test(raw)) return ok({ command: raw, args: extra.value });
  const parts = splitArgs(raw);
  if (!parts.ok) return fail(`Command: ${parts.error}`);
  const [command, ...inline] = parts.value;
  if (command === undefined || command === "") return fail("Command is required.");
  // "npx -y pkg" typed into Command is split into command + arguments.
  return ok({ command, args: [...inline, ...extra.value] });
}

// ---------------------------------------------------------------------------
// Spec <-> form

export type McpSpecFields = Pick<
  McpServerForm,
  "transport" | "command" | "args" | "env" | "cwd" | "url" | "headers" | "bearerTokenEnvVar"
>;

export function specToFormFields(spec: McpServerSpec): McpSpecFields {
  const blank: McpSpecFields = {
    transport: spec.type,
    command: "",
    args: "",
    env: "",
    cwd: "",
    url: "",
    headers: "",
    bearerTokenEnvVar: "",
  };
  switch (spec.type) {
    case "stdio":
      return {
        ...blank,
        command: commandToField(spec.command),
        args: formatArgs(spec.args),
        env: formatEnvLines(spec.env),
        cwd: spec.cwd ?? "",
      };
    case "http":
      return {
        ...blank,
        url: spec.url,
        headers: formatHeaderLines(spec.headers),
        bearerTokenEnvVar: spec.bearerTokenEnvVar ?? "",
      };
    case "sse":
      return { ...blank, url: spec.url, headers: formatHeaderLines(spec.headers) };
  }
}

const hasKeys = (value: Readonly<Record<string, string>>): boolean => Object.keys(value).length > 0;

export function formToSpec(form: McpSpecFields): Parsed<McpServerSpec> {
  if (form.transport === "stdio") {
    const command = parseCommand(form.command, form.args);
    if (!command.ok) return command;
    const env = parseEnvLines(form.env);
    if (!env.ok) return env;
    const cwd = form.cwd.trim();
    return ok({
      type: "stdio",
      command: command.value.command,
      ...(command.value.args.length > 0 ? { args: command.value.args } : {}),
      ...(hasKeys(env.value) ? { env: env.value } : {}),
      ...(cwd ? { cwd } : {}),
    });
  }
  const url = form.url.trim();
  if (url === "") return fail("URL is required.");
  const urlError = httpUrlError(url, "URL");
  if (urlError) return fail(urlError);
  const headers = parseHeaderLines(form.headers);
  if (!headers.ok) return headers;
  const headerFields = hasKeys(headers.value) ? { headers: headers.value } : {};
  if (form.transport === "sse") return ok({ type: "sse", url, ...headerFields });
  const bearer = form.bearerTokenEnvVar.trim();
  if (bearer && !ENV_NAME.test(bearer)) return fail(`"${bearer}" is not a valid variable name.`);
  return ok({
    type: "http",
    url,
    ...headerFields,
    ...(bearer ? { bearerTokenEnvVar: bearer } : {}),
  });
}

export type McpUpsert = Extract<McpMutation, { action: "upsert" }>;

export function formToUpsert(form: McpServerForm, id: string | undefined): Parsed<McpUpsert> {
  const nameError = serverNameError(form.name);
  if (nameError) return fail(nameError);
  const spec = formToSpec(form);
  if (!spec.ok) return spec;
  const homepage = form.homepage.trim();
  if (homepage) {
    const homepageError = httpUrlError(homepage, "Homepage");
    if (homepageError) return fail(homepageError);
  }
  const apps = { claude: form.apps.claude, codex: form.apps.codex && spec.value.type !== "sse" };
  if (!apps.claude && !apps.codex) return fail("Pick at least one app.");
  const description = form.description.trim();
  return ok({
    action: "upsert",
    ...(id ? { id } : {}),
    name: form.name.trim(),
    spec: spec.value,
    apps,
    ...(description ? { description } : {}),
    ...(homepage ? { homepage } : {}),
    ...(form.tags.length > 0 ? { tags: [...form.tags] } : {}),
  });
}

// ---------------------------------------------------------------------------
// Pasted JSON

export interface PastedServer {
  readonly name?: string;
  readonly spec: McpServerSpec;
  readonly description?: string;
  readonly homepage?: string;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SERVER_MAP_KEYS = ["mcpServers", "mcp_servers", "servers"] as const;

function looksLikeSpec(value: JsonObject): boolean {
  return (
    typeof value.command === "string" ||
    typeof value.url === "string" ||
    typeof value.serverUrl === "string" ||
    typeof value.type === "string"
  );
}

function parseJsonLoosely(text: string): Parsed<unknown> {
  try {
    return ok(JSON.parse(text));
  } catch (error) {
    // A bare `"name": { ... }` entry copied out of a larger file.
    try {
      return ok(JSON.parse(`{${text.replace(/,\s*$/, "")}}`));
    } catch {
      return fail(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function stringMap(value: unknown, label: string): Parsed<Record<string, string> | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  if (!isObject(value)) return fail(`"${label}" must be an object.`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const text = scalarText(entry);
    if (text === null) return fail(`"${label}.${key}" must be a string.`);
    result[key] = text;
  }
  return ok(hasKeys(result) ? result : undefined);
}

function stringList(value: unknown, label: string): Parsed<string[]> {
  if (value === undefined || value === null) return ok([]);
  if (!Array.isArray(value)) return fail(`"${label}" must be an array.`);
  const result: string[] = [];
  for (const entry of value) {
    const text = scalarText(entry);
    if (text === null) return fail(`"${label}" must hold strings.`);
    result.push(text);
  }
  return ok(result);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function transportOf(value: JsonObject): Parsed<McpTransport> {
  const raw = optionalString(value.type) ?? optionalString(value.transport);
  if (raw === undefined) {
    if (typeof value.command === "string") return ok("stdio");
    if (typeof value.url === "string" || typeof value.serverUrl === "string") return ok("http");
    return fail("The server needs a command or a url.");
  }
  const normalized = raw.toLowerCase().replace(/[-_]/g, "");
  if (normalized === "stdio") return ok("stdio");
  if (normalized === "sse") return ok("sse");
  if (normalized === "http" || normalized === "streamablehttp") return ok("http");
  return fail(`Unsupported transport "${raw}".`);
}

function specFromJson(value: JsonObject): Parsed<McpServerSpec> {
  const transport = transportOf(value);
  if (!transport.ok) return transport;
  if (transport.value === "stdio") {
    const command = optionalString(value.command);
    if (!command) return fail('A stdio server needs a "command".');
    const args = stringList(value.args, "args");
    if (!args.ok) return args;
    const env = stringMap(value.env, "env");
    if (!env.ok) return env;
    const cwd = optionalString(value.cwd);
    return ok({
      type: "stdio",
      command,
      ...(args.value.length > 0 ? { args: args.value } : {}),
      ...(env.value ? { env: env.value } : {}),
      ...(cwd ? { cwd } : {}),
    });
  }
  const url = optionalString(value.url) ?? optionalString(value.serverUrl);
  if (!url) return fail(`An ${transport.value.toUpperCase()} server needs a "url".`);
  const headers = stringMap(value.headers ?? value.http_headers ?? value.httpHeaders, "headers");
  if (!headers.ok) return headers;
  const headerFields = headers.value ? { headers: headers.value } : {};
  if (transport.value === "sse") return ok({ type: "sse", url, ...headerFields });
  const bearer =
    optionalString(value.bearerTokenEnvVar) ?? optionalString(value.bearer_token_env_var);
  return ok({
    type: "http",
    url,
    ...headerFields,
    ...(bearer ? { bearerTokenEnvVar: bearer } : {}),
  });
}

function serverEntries(root: JsonObject): [string | undefined, unknown][] {
  for (const key of SERVER_MAP_KEYS) {
    const map = root[key];
    if (isObject(map)) return Object.entries(map);
  }
  if (looksLikeSpec(root)) return [[optionalString(root.name), root]];
  return Object.entries(root).filter(([, value]) => isObject(value));
}

/**
 * Accepts `{"mcpServers": {"name": {...}}}` (Claude / CC Switch), a
 * `"name": {...}` fragment, `{"name": {...}}`, or one bare server object
 * (optionally carrying its own `name`).
 */
export function parsePastedServerJson(text: string): Parsed<PastedServer> {
  const trimmed = text.trim();
  if (trimmed === "") return fail("Paste a server definition first.");
  const parsed = parseJsonLoosely(trimmed);
  if (!parsed.ok) return parsed;
  if (!isObject(parsed.value)) return fail("Expected a JSON object.");
  const entries = serverEntries(parsed.value);
  if (entries.length > 1) return fail(`Found ${entries.length} servers; paste one at a time.`);
  const [entry] = entries;
  if (!entry) return fail("No server definition found.");
  const [name, value] = entry;
  if (!isObject(value) || !looksLikeSpec(value)) return fail("No server definition found.");
  const spec = specFromJson(value);
  if (!spec.ok) return spec;
  const description = optionalString(value.description);
  const homepage = optionalString(value.homepage);
  return ok({
    ...(name ? { name } : {}),
    spec: spec.value,
    ...(description ? { description } : {}),
    ...(homepage ? { homepage } : {}),
  });
}

// ---------------------------------------------------------------------------
// Display with secrets masked

const MASK = "••••••••";
const SECRETISH_PARAM = /key|token|secret|auth|pass|sig|cred/i;

/** Hides a secret without revealing its length; long values keep their last 4 characters. */
export function maskSecret(value: string): string {
  if (value === "") return "";
  return value.length >= 16 ? `${MASK}${value.slice(-4)}` : MASK;
}

/** Masks URL passwords and secret-looking query parameters. */
export function maskUrl(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/[^/:@]+):[^/@]+@/i, "$1:••••@")
    .replace(/([?&])([^=&#]+)=([^&#]+)/g, (match, separator: string, key: string) =>
      SECRETISH_PARAM.test(key) ? `${separator}${key}=••••` : match,
    );
}

export interface SpecLine {
  readonly label: string;
  readonly value: string;
}

export function describeSpec(spec: McpServerSpec): SpecLine[] {
  const lines: SpecLine[] = [];
  if (spec.type === "stdio") {
    const commandLine = [commandToField(spec.command), formatArgs(spec.args)].join(" ").trim();
    lines.push({ label: "Command", value: commandLine });
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      lines.push({ label: "Env", value: `${key}=${maskSecret(value)}` });
    }
    if (spec.cwd) lines.push({ label: "Cwd", value: spec.cwd });
    return lines;
  }
  lines.push({ label: spec.type === "sse" ? "SSE" : "HTTP", value: maskUrl(spec.url) });
  for (const [name, value] of Object.entries(spec.headers ?? {})) {
    lines.push({ label: "Header", value: `${name}: ${maskSecret(value)}` });
  }
  if (spec.type === "http" && spec.bearerTokenEnvVar) {
    lines.push({ label: "Bearer", value: `$${spec.bearerTokenEnvVar}` });
  }
  return lines;
}
