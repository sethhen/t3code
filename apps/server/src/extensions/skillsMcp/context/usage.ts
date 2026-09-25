// @effect-diagnostics nodeBuiltinImport:off - listing uses Node's `Dirent`s, which tell a symlink from a directory without following it; `FileSystem` has no `lstat`.
/**
 * How often Claude Code and Codex actually call each MCP server, tool and
 * skill, counted from their own session transcripts (T3 threads and CLI
 * sessions alike).
 *
 * Transcripts are large (gigabytes), append-only JSONL, so the scan is
 * incremental: `<stateDir>/skills-mcp/usage-cache.json` remembers, per file,
 * its size, mtime and inode, how far it has been parsed, a hash of its first
 * bytes and the events found so far. Unchanged files cost a `stat`, appended
 * files are read from the last complete line on, and truncated, rewritten or
 * replaced files are parsed again from the start. Only lines containing a
 * marker substring are decoded and `JSON.parse`d.
 *
 * Events, not day buckets, are cached: resumed and forked sessions copy
 * earlier records into new files, so calls are de-duplicated across files by
 * their tool-call ids, and a window only counts events whose own timestamp
 * falls inside it.
 */
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import type { AppUsage, UsageStat } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { describeCause } from "../shared/agents.ts";
import { makeJsonDocument } from "../shared/jsonDocument.ts";
import { ExtensionFailure } from "../shared/t3.ts";

export const MIN_USAGE_DAYS = 1;
export const MAX_USAGE_DAYS = 90;
const DEFAULT_USAGE_DAYS = 30;
const DAY_MS = 86_400_000;

/** Whole days within 1–90; anything unusable falls back to 30. */
export const clampUsageDays = (days: number) =>
  Number.isFinite(days)
    ? Math.min(MAX_USAGE_DAYS, Math.max(MIN_USAGE_DAYS, Math.round(days)))
    : DEFAULT_USAGE_DAYS;

export type UsageApp = "claude" | "codex";

/** A directory tree of one app's `.jsonl` transcripts. */
export interface UsageRoot {
  readonly app: UsageApp;
  readonly dir: string;
}

// ---------------------------------------------------------------------------
// Cache document

/** `[call id, epoch ms, server, tool]` */
const McpEvent = Schema.Tuple([Schema.String, Schema.Number, Schema.String, Schema.String]);
/** `[use id, epoch ms, skill]` */
const SkillEvent = Schema.Tuple([Schema.String, Schema.Number, Schema.String]);

const FileEntry = Schema.Struct({
  app: Schema.Literals(["claude", "codex"]),
  size: Schema.Number,
  mtimeMs: Schema.Number,
  ino: Schema.optional(Schema.Number),
  /** Bytes parsed so far: always the end of a complete line. */
  offset: Schema.Number,
  /** sha1 of the first `headLength` bytes, to notice a rewritten file. */
  head: Schema.String,
  headLength: Schema.Number,
  session: Schema.optional(Schema.String),
  /** Claude: the last slash command seen, which names the skill it expands to. */
  command: Schema.optional(Schema.String),
  mcp: Schema.Array(McpEvent),
  skills: Schema.Array(SkillEvent),
});
type FileEntry = typeof FileEntry.Type;
type McpEvent = typeof McpEvent.Type;
type SkillEvent = typeof SkillEvent.Type;

const UsageCache = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Record(Schema.String, FileEntry),
});

const usageCache = makeJsonDocument("usage-cache.json", UsageCache, () => ({
  version: 1 as const,
  files: {},
}));

// ---------------------------------------------------------------------------
// Line parsing

const NEWLINE = 0x0a;
const QUOTE = 0x22;
const CHUNK_BYTES = 1 << 20;
const HEAD_BYTES = 1024;

interface Needle {
  readonly bytes: NodeBuffer.Buffer;
  /** A second substring the line must contain before it is decoded. */
  readonly requires?: NodeBuffer.Buffer;
}

const needle = (bytes: string, requires?: string): Needle => ({
  bytes: NodeBuffer.Buffer.from(bytes),
  ...(requires ? { requires: NodeBuffer.Buffer.from(requires) } : {}),
});

/** How a slash-command skill's expanded instructions begin. */
const SKILL_BASE = "Base directory for this skill:";

const CLAUDE_NEEDLES: ReadonlyArray<Needle> = [
  needle('"name":"mcp__', '"tool_use"'),
  needle('"name":"Skill"', '"tool_use"'),
  needle(SKILL_BASE, '"isMeta":true'),
  needle("<command-name>"),
];
const CLAUDE_SESSION = NodeBuffer.Buffer.from('"sessionId":"');

const CODEX_NEEDLES: ReadonlyArray<Needle> = [
  needle("McpToolCall", "item_completed"),
  needle("SKILL.md", "CommandExecution"),
  // `<skill>\n<name>` as it appears inside a JSON string.
  needle("<skill>\\n<name>", "response_item"),
];
const CODEX_NEEDLES_WITH_SESSION: ReadonlyArray<Needle> = [
  needle('"session_meta"'),
  ...CODEX_NEEDLES,
];

interface ScanState {
  readonly app: UsageApp;
  readonly path: Path.Path;
  /** Used when a record has no usable timestamp. */
  readonly fallbackMs: number;
  session: string | undefined;
  command: string | undefined;
  readonly mcp: McpEvent[];
  readonly skills: SkillEvent[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const parseJson = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

const timestampMs = (value: unknown, fallback: number) => {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : fallback;
};

const baseName = (path: Path.Path, file: string) => path.basename(file.replace(/[\\/]+$/, ""));

/** Text of a Claude message body, whether a string or text blocks. */
const claudeText = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block) =>
            isRecord(block) && block.type === "text" && typeof block.text === "string"
              ? block.text
              : "",
          )
          .join("")
      : "";

const COMMAND_NAME = /<command-name>\/?([^<]+)<\/command-name>/;

/**
 * Claude: assistant `tool_use` blocks (`mcp__<server>__<tool>`, `Skill`) and
 * slash-command skills, which arrive as a meta user message naming the
 * skill's base directory (the `Skill` tool's own copy carries
 * `sourceToolUseID` and is not counted twice).
 */
const handleClaudeLine = (line: string, state: ScanState) => {
  const record = parseJson(line);
  if (!isRecord(record)) return;
  const ms = timestampMs(record.timestamp, state.fallbackMs);
  const message = isRecord(record.message) ? record.message : undefined;
  if (record.type === "assistant") {
    if (!Array.isArray(message?.content)) return;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
      const id = text(block.id) ?? `${text(record.uuid) ?? ms}:${block.name}`;
      if (block.name.startsWith("mcp__")) {
        const split = block.name.indexOf("__", 5);
        if (split <= 5 || split + 2 >= block.name.length) continue;
        state.mcp.push([id, ms, block.name.slice(5, split), block.name.slice(split + 2)]);
      } else if (block.name === "Skill" && isRecord(block.input)) {
        const skill = text(block.input.skill)?.replace(/^\//, "");
        if (skill) state.skills.push([id, ms, skill]);
      }
    }
    return;
  }
  if (record.type !== "user") return;
  const body = claudeText(message?.content);
  const command = COMMAND_NAME.exec(body)?.[1]?.trim();
  if (command) {
    state.command = command;
    return;
  }
  if (
    record.isMeta !== true ||
    typeof record.sourceToolUseID === "string" ||
    !body.startsWith(SKILL_BASE)
  ) {
    return;
  }
  const dir = body.slice(SKILL_BASE.length).split("\n", 1)[0]?.trim() ?? "";
  const base = baseName(state.path, dir);
  if (!base) return;
  // `/plugin:skill` expands to `.../skills/skill`: keep the qualified name.
  const name = state.command && state.command.split(":").at(-1) === base ? state.command : base;
  state.skills.push([text(record.uuid) ?? `${ms}:${name}`, ms, name]);
};

const SKILL_TAG = /<skill>\s*<name>([^<]+)<\/name>/g;

/**
 * Codex: completed `McpToolCall` items; skills either attached explicitly
 * (a `<skill>` block in the user message) or read by the model itself (a
 * command that reads some `SKILL.md`).
 */
const handleCodexLine = (line: string, state: ScanState) => {
  const record = parseJson(line);
  if (!isRecord(record) || !isRecord(record.payload)) return;
  const payload = record.payload;
  if (record.type === "session_meta") {
    state.session ??= text(payload.session_id) ?? text(payload.id);
    return;
  }
  const ms =
    typeof payload.completed_at_ms === "number" && payload.completed_at_ms > 0
      ? payload.completed_at_ms
      : timestampMs(record.timestamp, state.fallbackMs);
  if (payload.type === "item_completed" && isRecord(payload.item)) {
    const item = payload.item;
    if (item.type === "McpToolCall") {
      const server = text(item.server);
      const tool = text(item.tool);
      if (server && tool)
        state.mcp.push([text(item.id) ?? `${ms}:${server}:${tool}`, ms, server, tool]);
      return;
    }
    if (item.type !== "CommandExecution" || !Array.isArray(item.parsed_cmd)) return;
    const names = new Set<string>();
    for (const command of item.parsed_cmd) {
      if (!isRecord(command) || command.type !== "read") continue;
      const file = text(command.path);
      if (!file || baseName(state.path, file) !== "SKILL.md") continue;
      const cwd = text(item.cwd);
      const absolute = cwd ? state.path.resolve(cwd, file) : file;
      const name = baseName(state.path, state.path.dirname(absolute));
      if (name) names.add(name);
    }
    const turn = text(payload.turn_id) ?? text(item.id) ?? String(ms);
    for (const name of names) state.skills.push([`${turn}:${name}`, ms, name]);
    return;
  }
  if (
    record.type !== "response_item" ||
    payload.type !== "message" ||
    payload.role !== "user" ||
    !Array.isArray(payload.content)
  ) {
    return;
  }
  for (const block of payload.content) {
    if (!isRecord(block) || typeof block.text !== "string") continue;
    for (const match of block.text.matchAll(SKILL_TAG)) {
      const name = match[1]?.trim();
      if (name) state.skills.push([`${text(record.timestamp) ?? ms}:${name}`, ms, name]);
    }
  }
};

/** Start and end of every line containing a needle, in file order. */
const matchingLines = (region: NodeBuffer.Buffer, needles: ReadonlyArray<Needle>) => {
  const lines = new Map<number, number>();
  for (const { bytes, requires } of needles) {
    let from = 0;
    while (from < region.length) {
      const hit = region.indexOf(bytes, from);
      if (hit === -1) break;
      const start = region.lastIndexOf(NEWLINE, hit) + 1;
      const newline = region.indexOf(NEWLINE, hit);
      const end = newline === -1 ? region.length : newline;
      from = end + 1;
      if (lines.has(start)) continue;
      if (requires && region.subarray(start, end).indexOf(requires) === -1) continue;
      lines.set(start, end);
    }
  }
  return [...lines].toSorted((a, b) => a[0] - b[0]);
};

/** Parses the complete lines in `region`. */
const scanRegion = (region: NodeBuffer.Buffer, state: ScanState) => {
  if (state.app === "claude" && state.session === undefined) {
    const at = region.indexOf(CLAUDE_SESSION);
    if (at !== -1) {
      const from = at + CLAUDE_SESSION.length;
      const end = region.indexOf(QUOTE, from);
      if (end > from && end - from <= 128) state.session = region.toString("utf8", from, end);
    }
  }
  const needles =
    state.app === "claude"
      ? CLAUDE_NEEDLES
      : state.session === undefined
        ? CODEX_NEEDLES_WITH_SESSION
        : CODEX_NEEDLES;
  const handle = state.app === "claude" ? handleClaudeLine : handleCodexLine;
  for (const [start, end] of matchingLines(region, needles)) {
    handle(region.toString("utf8", start, end), state);
  }
};

/** A final line whose newline is not written yet, but which is already a whole record. */
const isWholeRecord = (tail: NodeBuffer.Buffer) => {
  let last = tail.length - 1;
  while (last >= 0 && (tail[last] === 0x20 || tail[last] === 0x0d || tail[last] === 0x09)) last--;
  return last >= 0 && tail[last] === 0x7d && parseJson(tail.toString("utf8")) !== undefined;
};

const sha1 = (bytes: Uint8Array) => NodeCrypto.createHash("sha1").update(bytes).digest("hex");

// ---------------------------------------------------------------------------
// Files

interface FileStat {
  readonly file: string;
  readonly app: UsageApp;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number | undefined;
}

const unchanged = (entry: FileEntry | undefined, stat: FileStat): entry is FileEntry =>
  entry !== undefined &&
  entry.app === stat.app &&
  entry.size === stat.size &&
  entry.mtimeMs === stat.mtimeMs &&
  entry.ino === stat.ino;

/**
 * Parses `stat.file` from where `previous` stopped when the file only grew,
 * or from the start. Reads at most `stat.size` bytes.
 */
const scanFile = (stat: FileStat, previous: FileEntry | undefined, path: Path.Path) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const handle = yield* fs.open(stat.file, { flag: "r" });
      const chunk = NodeBuffer.Buffer.allocUnsafe(
        Math.min(CHUNK_BYTES, Math.max(stat.size, HEAD_BYTES)),
      );
      let bytesRead = 0;

      let base: FileEntry | undefined;
      if (
        previous !== undefined &&
        previous.app === stat.app &&
        previous.ino === stat.ino &&
        previous.offset > 0 &&
        stat.size >= previous.offset &&
        stat.size >= previous.headLength
      ) {
        const head = chunk.subarray(0, previous.headLength);
        const read = Number(yield* handle.read(head));
        bytesRead += read;
        if (read === previous.headLength && sha1(head) === previous.head) base = previous;
      }

      const state: ScanState = {
        app: stat.app,
        path,
        fallbackMs: stat.mtimeMs,
        session: base?.session,
        command: base?.command,
        mcp: base ? [...base.mcp] : [],
        skills: base ? [...base.skills] : [],
      };
      let head = base?.head;
      let headLength = base?.headLength ?? 0;
      let position = base?.offset ?? 0;
      let offset = position;
      let pending: NodeBuffer.Buffer[] = [];
      yield* handle.seek(position, "start");

      while (position < stat.size) {
        const read = Number(
          yield* handle.read(chunk.subarray(0, Math.min(chunk.length, stat.size - position))),
        );
        if (read <= 0) break;
        bytesRead += read;
        const data = chunk.subarray(0, read);
        if (head === undefined) {
          headLength = Math.min(HEAD_BYTES, read);
          head = sha1(data.subarray(0, headLength));
        }
        position += read;
        const lastNewline = data.lastIndexOf(NEWLINE);
        if (lastNewline === -1) {
          pending.push(NodeBuffer.Buffer.from(data));
          continue;
        }
        let from = 0;
        if (pending.length > 0) {
          // Only the line straddling the chunk boundary is copied.
          const firstNewline = data.indexOf(NEWLINE);
          scanRegion(
            NodeBuffer.Buffer.concat([...pending, data.subarray(0, firstNewline + 1)]),
            state,
          );
          pending = [];
          from = firstNewline + 1;
        }
        if (lastNewline + 1 > from) scanRegion(data.subarray(from, lastNewline + 1), state);
        offset = position - read + lastNewline + 1;
        if (lastNewline + 1 < read)
          pending.push(NodeBuffer.Buffer.from(data.subarray(lastNewline + 1)));
      }
      if (pending.length > 0) {
        const tail = NodeBuffer.Buffer.concat(pending);
        if (isWholeRecord(tail)) {
          scanRegion(tail, state);
          offset = position;
        }
      }

      const entry: FileEntry = {
        app: stat.app,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ...(stat.ino !== undefined ? { ino: stat.ino } : {}),
        offset,
        head: head ?? sha1(new Uint8Array()),
        headLength,
        ...(state.session !== undefined ? { session: state.session } : {}),
        ...(state.command !== undefined ? { command: state.command } : {}),
        mcp: state.mcp,
        skills: state.skills,
      };
      return { entry, bytesRead };
    }),
  );

/** Directories that never hold transcripts but can be huge. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);

const readEntries = (dir: string) =>
  Effect.tryPromise({
    try: () => NodeFS.promises.readdir(dir, { withFileTypes: true }),
    catch: (cause) => new ExtensionFailure({ message: describeCause(cause), cause }),
  });

const errorCode = (cause: unknown) =>
  cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;

/**
 * Every `.jsonl` under `dir` (none when it does not exist).
 *
 * Walked one directory at a time without following symlinks: a recursive
 * `readdir` follows symlinked directories, and one symlinked `node_modules`
 * that a session left in a projects tree turned thousands of entries into
 * millions (minutes of listing). Only an unreadable root fails; a
 * subdirectory that vanishes or cannot be read is skipped.
 */
const listTranscripts = (dir: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = yield* Effect.result(readEntries(dir));
    if (root._tag === "Failure") {
      if (errorCode(root.failure.cause) === "ENOENT") return [];
      return yield* root.failure;
    }
    const files: string[] = [];
    const pending: Array<readonly [string, ReadonlyArray<NodeFS.Dirent>]> = [[dir, root.success]];
    while (pending.length > 0) {
      const [current, entries] = pending.pop()!;
      for (const entry of entries) {
        const child = path.join(current, entry.name);
        if (entry.isFile()) {
          if (entry.name.endsWith(".jsonl")) files.push(child);
        } else if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
          const listing = yield* Effect.result(readEntries(child));
          if (listing._tag === "Success") pending.push([child, listing.success]);
        }
      }
      yield* Effect.yieldNow;
    }
    return files;
  });

const statTranscript = (file: string, app: UsageApp) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(file);
    if (info.type !== "File") return undefined;
    return {
      file,
      app,
      size: Number(info.size),
      mtimeMs: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
      ino: Option.getOrUndefined(info.ino),
    } satisfies FileStat;
  }).pipe(Effect.orElseSucceed(() => undefined));

// ---------------------------------------------------------------------------
// Report

interface Tally {
  readonly entries: Array<readonly [string, FileEntry]>;
  readonly errors: string[];
  files: number;
  bytes: number;
}

const newTally = (): Tally => ({ entries: [], errors: [], files: 0, bytes: 0 });

interface Counter {
  calls: number;
  last: number;
}

const bump = <K>(map: Map<K, Counter>, key: K, ms: number) => {
  const counter = map.get(key);
  if (counter) {
    counter.calls += 1;
    counter.last = Math.max(counter.last, ms);
  } else {
    map.set(key, { calls: 1, last: ms });
  }
};

const stats = (map: Map<string, Counter>): UsageStat[] =>
  [...map]
    .map(([name, counter]) => ({
      name,
      calls: counter.calls,
      lastUsedAt: DateTime.formatIso(DateTime.makeUnsafe(counter.last)),
    }))
    .toSorted((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The transcript's session id, else the one in its file name, else its path. */
const sessionOf = (file: string, entry: FileEntry, path: Path.Path) =>
  entry.session ?? UUID.exec(path.basename(file))?.[0] ?? file;

const summarize = (errors: ReadonlyArray<string>) =>
  errors.length === 0
    ? undefined
    : errors.length === 1
      ? errors[0]
      : `${errors[0]} (and ${errors.length - 1} more)`;

const appUsage = (tally: Tally, windowStart: number, path: Path.Path): AppUsage => {
  const seenCalls = new Set<string>();
  const seenSkills = new Set<string>();
  const servers = new Map<string, Counter>();
  const tools = new Map<string, Map<string, Counter>>();
  const skills = new Map<string, Counter>();
  const sessions = new Set<string>();
  for (const [file, entry] of tally.entries) {
    sessions.add(sessionOf(file, entry, path));
    for (const [id, ms, server, tool] of entry.mcp) {
      if (ms < windowStart || seenCalls.has(id)) continue;
      seenCalls.add(id);
      bump(servers, server, ms);
      let serverTools = tools.get(server);
      if (!serverTools) {
        serverTools = new Map();
        tools.set(server, serverTools);
      }
      bump(serverTools, tool, ms);
    }
    for (const [id, ms, name] of entry.skills) {
      if (ms < windowStart || seenSkills.has(id)) continue;
      seenSkills.add(id);
      bump(skills, name, ms);
    }
  }
  const error = summarize(tally.errors);
  return {
    mcpServers: stats(servers).map((server) => ({
      ...server,
      tools: stats(tools.get(server.name) ?? new Map()),
    })),
    skills: stats(skills),
    sessions: sessions.size,
    scannedFiles: tally.files,
    scannedBytes: tally.bytes,
    ...(error ? { error } : {}),
  };
};

export interface UsageApps {
  readonly claude: AppUsage;
  readonly codex: AppUsage;
}

// ---------------------------------------------------------------------------
// Scan

/** Module-level: the handler registry is rebuilt per ws connection. */
interface ScanSlot {
  /** The cache as last read or written; loaded from disk once per process. */
  files: Record<string, FileEntry> | undefined;
  readonly lock: Semaphore.Semaphore;
  readonly inflight: Map<string, Deferred.Deferred<UsageApps, ExtensionFailure>>;
  readonly memo: Map<string, { readonly at: number; readonly apps: UsageApps }>;
}

const scanSlots = new Map<string, ScanSlot>();

const scanSlot = (cacheFile: string) => {
  let slot = scanSlots.get(cacheFile);
  if (!slot) {
    slot = {
      files: undefined,
      lock: Semaphore.makeUnsafe(1),
      inflight: new Map(),
      memo: new Map(),
    };
    scanSlots.set(cacheFile, slot);
  }
  return slot;
};

const loadCache = (slot: ScanSlot, cacheFile: string) =>
  Effect.gen(function* () {
    if (slot.files) return { files: slot.files, dirty: false };
    const loaded = yield* Effect.result(usageCache.read);
    if (loaded._tag === "Success") return { files: loaded.success.files, dirty: false };
    // A cache that no longer decodes is only a cache: start over.
    yield* Effect.logWarning(`skillsMcp: discarding unreadable ${cacheFile}`, loaded.failure);
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.ignore(fs.remove(cacheFile));
    return { files: {} as Record<string, FileEntry>, dirty: true };
  });

const saveCache = (cacheFile: string, files: Record<string, FileEntry>) => {
  const write = usageCache.update(() =>
    Effect.succeed([undefined, { version: 1 as const, files }] as const),
  );
  return write.pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.ignore(fs.remove(cacheFile));
        yield* write;
      }),
    ),
    Effect.catch((failure) => Effect.logWarning(`skillsMcp: could not save ${cacheFile}`, failure)),
  );
};

const runScan = (
  slot: ScanSlot,
  cacheFile: string,
  input: { readonly days: number; readonly roots: ReadonlyArray<UsageRoot> },
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    const windowStart = now - input.days * DAY_MS;
    const retainFrom = now - MAX_USAGE_DAYS * DAY_MS;
    const cache = yield* loadCache(slot, cacheFile);
    const previous = cache.files;
    let dirty = cache.dirty;
    const next: Record<string, FileEntry> = {};
    const listed = new Set<string>();
    const unlistedRoots: string[] = [];
    const tallies: Record<UsageApp, Tally> = { claude: newTally(), codex: newTally() };

    for (const root of input.roots) {
      const tally = tallies[root.app];
      const listing = yield* Effect.result(listTranscripts(root.dir));
      if (listing._tag === "Failure") {
        tally.errors.push(`Could not list ${root.dir}: ${describeCause(listing.failure)}`);
        // Keep what is known about this tree until it can be listed again.
        unlistedRoots.push(root.dir.endsWith(path.sep) ? root.dir : `${root.dir}${path.sep}`);
        continue;
      }
      const statted = yield* Effect.forEach(
        listing.success,
        (file) => statTranscript(file, root.app),
        { concurrency: 32 },
      );
      for (const stat of statted) {
        if (!stat || listed.has(stat.file)) continue;
        listed.add(stat.file);
        const known = previous[stat.file];
        if (stat.mtimeMs < windowStart) {
          // Nothing in it can fall inside the window; keep what is known for wider windows.
          if (known && known.mtimeMs >= retainFrom) next[stat.file] = known;
          else if (known) dirty = true;
          continue;
        }
        if (unchanged(known, stat)) {
          next[stat.file] = known;
          tally.entries.push([stat.file, known]);
          continue;
        }
        const scanned = yield* Effect.result(scanFile(stat, known, path));
        if (scanned._tag === "Failure") {
          tally.errors.push(`Could not read ${stat.file}: ${describeCause(scanned.failure)}`);
          if (known) {
            next[stat.file] = known;
            tally.entries.push([stat.file, known]);
          }
        } else {
          next[stat.file] = scanned.success.entry;
          tally.entries.push([stat.file, scanned.success.entry]);
          tally.files += 1;
          tally.bytes += scanned.success.bytesRead;
          dirty = true;
        }
        yield* Effect.yieldNow;
      }
    }

    for (const [file, entry] of Object.entries(previous)) {
      if (file in next || listed.has(file)) continue;
      if (entry.mtimeMs >= retainFrom && unlistedRoots.some((root) => file.startsWith(root))) {
        next[file] = entry;
      } else {
        dirty = true;
      }
    }

    slot.files = next;
    if (dirty) yield* saveCache(cacheFile, next);
    return {
      claude: appUsage(tallies.claude, windowStart, path),
      codex: appUsage(tallies.codex, windowStart, path),
    } satisfies UsageApps;
  });

const toFailure = (cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.failCause(cause as Cause.Cause<never>)
    : Effect.fail(
        new ExtensionFailure({
          message: `Usage scan failed: ${describeCause(Cause.squash(cause))}`,
          cause: Cause.squash(cause),
        }),
      );

/**
 * One scan of `roots` against the incremental cache. Scans sharing a cache
 * file run one at a time.
 */
export const scanUsage = (input: {
  readonly days: number;
  readonly roots: ReadonlyArray<UsageRoot>;
}) =>
  Effect.gen(function* () {
    const cacheFile = yield* usageCache.filePath;
    const slot = scanSlot(cacheFile);
    return yield* slot.lock.withPermit(runScan(slot, cacheFile, input));
  }).pipe(Effect.catchCause(toFailure));

const MEMO_TTL_MS = 15_000;

/**
 * `scanUsage`, shared: callers asking while a scan of the same window runs
 * await its result, and a result stays good for a few seconds unless
 * `refresh` is set. The scan runs detached, so a caller that goes away does
 * not cancel it for the others.
 */
export const collectUsage = (input: {
  readonly days: number;
  readonly refresh: boolean;
  readonly roots: ReadonlyArray<UsageRoot>;
}) =>
  Effect.gen(function* () {
    const cacheFile = yield* usageCache.filePath.pipe(Effect.catchCause(toFailure));
    const slot = scanSlot(cacheFile);
    const key = [input.days, ...input.roots.map((root) => `${root.app}:${root.dir}`)].join("|");
    const now = yield* Clock.currentTimeMillis;
    const memo = slot.memo.get(key);
    if (!input.refresh && memo && now - memo.at < MEMO_TTL_MS) return memo.apps;
    const running = slot.inflight.get(key);
    if (running) return yield* Deferred.await(running);
    const result = Deferred.makeUnsafe<UsageApps, ExtensionFailure>();
    slot.inflight.set(key, result);
    yield* scanUsage(input).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          slot.inflight.delete(key);
          if (Exit.isSuccess(exit)) {
            slot.memo.set(key, { at: yield* Clock.currentTimeMillis, apps: exit.value });
          }
          yield* Deferred.done(result, exit);
        }),
      ),
      Effect.forkDetach,
    );
    return yield* Deferred.await(result);
  });
