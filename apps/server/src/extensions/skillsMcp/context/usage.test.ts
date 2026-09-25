/**
 * The usage scanner against synthetic transcripts in temp dirs. Every fixture
 * line is made up here; file times are set explicitly and the clock is the
 * TestClock, so nothing depends on when the test runs.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { AppUsage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../shared/t3.ts";
import { serverConfigLayerTest } from "./t3.ts";
import { clampUsageDays, collectUsage, scanUsage, type UsageRoot } from "./usage.ts";

const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

// ---------------------------------------------------------------------------
// Synthetic records

const jsonl = (...records: ReadonlyArray<unknown>) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");

/** One record without its trailing newline. */
const line = (record: unknown) => jsonl(record).slice(0, -1);

/** The parts of the saved cache file the tests look at. */
const SavedCache = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Number,
    files: Schema.Record(Schema.String, Schema.Struct({ mcp: Schema.Array(Schema.Unknown) })),
  }),
);
const decodeSavedCache = Schema.decodeUnknownEffect(SavedCache);

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: "tool_use",
  id,
  name,
  input,
});

const claudeAssistant = (
  uuid: string,
  at: number,
  content: ReadonlyArray<unknown>,
  sessionId = "claude-session-a",
) => ({
  type: "assistant",
  uuid,
  sessionId,
  timestamp: iso(at),
  message: { role: "assistant", content },
});

const claudeUser = (
  uuid: string,
  at: number,
  content: unknown,
  extra: Record<string, unknown> = {},
  sessionId = "claude-session-a",
) => ({
  type: "user",
  uuid,
  sessionId,
  timestamp: iso(at),
  message: { role: "user", content },
  ...extra,
});

const skillBody = (dir: string) => [
  { type: "text", text: `Base directory for this skill: ${dir}\n\n# Instructions\nDo the thing.` },
];

/** A Claude transcript line with one MCP call. */
const claudeMcp = (id: string, at: number, name = "mcp__docs__search", sessionId?: string) =>
  claudeAssistant(`uuid-${id}`, at, [toolUse(id, name)], sessionId);

/** A large record that matches no needle, to push later records past the head hash. */
const filler = (bytes: number) => ({ type: "progress", data: "x".repeat(bytes) });

const codexMeta = (id: string, at: number) => ({
  timestamp: iso(at),
  type: "session_meta",
  payload: { id, cwd: "/work/repo" },
});

const codexItem = (
  kind: "item_started" | "item_completed",
  at: number,
  item: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  timestamp: iso(at),
  type: "event_msg",
  payload: { type: kind, turn_id: `turn-${at}`, item, ...extra },
});

const codexMcp = (id: string, at: number, server = "docs", tool = "search") =>
  codexItem("item_completed", at, { type: "McpToolCall", id, server, tool });

const codexMessage = (role: string, at: number, text: string) => ({
  timestamp: iso(at),
  type: "response_item",
  payload: { type: "message", role, content: [{ type: "input_text", text }] },
});

// ---------------------------------------------------------------------------
// Harness

interface Dirs {
  readonly claude: string;
  readonly codex: string;
  readonly roots: ReadonlyArray<UsageRoot>;
}

/** Fresh transcript roots and a fresh T3 state dir (so a fresh cache) per test. */
const withScanner = <A, E, R>(body: (dirs: Dirs) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "skills-mcp-usage-" });
    const claude = path.join(base, "claude", "projects");
    const codex = path.join(base, "codex", "sessions");
    const roots: UsageRoot[] = [
      { app: "claude", dir: claude },
      { app: "codex", dir: codex },
    ];
    return yield* body({ claude, codex, roots }).pipe(
      Effect.provide(serverConfigLayerTest(base, path.join(base, "t3"))),
    );
  }).pipe(Effect.scoped);

/** Writes (or appends) `content`, then sets the file's mtime to `mtimeMs`. */
const writeAt = (file: string, content: string, mtimeMs: number, append = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, content, append ? { flag: "a" } : undefined);
    yield* touch(file, mtimeMs);
  });

const touch = (file: string, mtimeMs: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
  });

const sizeOf = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return Number((yield* fs.stat(file)).size);
  });

/** `server/tool` → calls, for compact assertions. */
const toolCalls = (usage: AppUsage) =>
  Object.fromEntries(
    usage.mcpServers.flatMap((server) =>
      server.tools.map((tool) => [`${server.name}/${tool.name}`, tool.calls] as const),
    ),
  );

const skillCalls = (usage: AppUsage) =>
  Object.fromEntries(usage.skills.map((skill) => [skill.name, skill.calls] as const));

const scan = (dirs: Dirs, days = 30) => scanUsage({ days, roots: dirs.roots });

// ---------------------------------------------------------------------------

describe("clampUsageDays", () => {
  it("keeps whole days within 1–90", () => {
    assert.strictEqual(clampUsageDays(0), 1);
    assert.strictEqual(clampUsageDays(-5), 1);
    assert.strictEqual(clampUsageDays(7.4), 7);
    assert.strictEqual(clampUsageDays(200), 90);
    assert.strictEqual(clampUsageDays(Number.NaN), 30);
    assert.strictEqual(clampUsageDays(Number.POSITIVE_INFINITY), 30);
  });
});

it.layer(NodeServices.layer)("usage scanner", (it) => {
  it.effect("counts Claude MCP calls, Skill tool calls and slash-command skills", () =>
    withScanner((dirs) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const file = path.join(dirs.claude, "-work-repo", "session-a.jsonl");
        yield* writeAt(
          file,
          jsonl(
            claudeUser("u0", NOW - 3 * HOUR, "hello"),
            claudeAssistant("a1", NOW - 2 * HOUR, [
              { type: "text", text: "Looking it up." },
              toolUse("toolu_1", "mcp__docs__search", { query: "x" }),
              toolUse("toolu_2", "mcp__docs__fetch"),
            ]),
            claudeAssistant("a2", NOW - HOUR, [toolUse("toolu_3", "mcp__docs__search")]),
            claudeAssistant("a3", NOW - 50 * MINUTE, [
              toolUse("toolu_4", "mcp__my_server__run__all"),
              toolUse("toolu_5", "Read", { file_path: "/work/repo/a.ts" }),
              toolUse("toolu_bad", "mcp__broken"),
            ]),
            // The Skill tool, then its own expansion (not a second use).
            claudeAssistant("a4", NOW - 40 * MINUTE, [
              toolUse("toolu_6", "Skill", { skill: "/review" }),
            ]),
            claudeUser("u5", NOW - 40 * MINUTE, skillBody("/home/me/.claude/skills/review"), {
              isMeta: true,
              sourceToolUseID: "toolu_6",
            }),
            // A plugin slash command expanding to its skill.
            claudeUser(
              "u6",
              NOW - 30 * MINUTE,
              "<command-name>/plug:deploy</command-name>\n<command-message>plug:deploy</command-message>",
            ),
            claudeUser("u7", NOW - 30 * MINUTE, skillBody("/plugins/plug/skills/deploy/"), {
              isMeta: true,
            }),
            // A skill expansion after an unrelated command keeps the directory name.
            claudeUser("u8", NOW - 25 * MINUTE, "<command-name>/clear</command-name>"),
            claudeUser("u9", NOW - 20 * MINUTE, skillBody("/home/me/.claude/skills/notes"), {
              isMeta: true,
            }),
            // Quoted, not meta: not a use.
            claudeUser("u10", NOW - 15 * MINUTE, skillBody("/home/me/.claude/skills/quoted")),
            // tool_use blocks only count on assistant records.
            claudeUser("u11", NOW - 10 * MINUTE, [toolUse("toolu_fake", "mcp__fake__tool")]),
          ),
          NOW - 10 * MINUTE,
        );

        const { claude, codex } = yield* scan(dirs);
        assert.deepStrictEqual(claude, {
          mcpServers: [
            {
              name: "docs",
              calls: 3,
              lastUsedAt: iso(NOW - HOUR),
              tools: [
                { name: "search", calls: 2, lastUsedAt: iso(NOW - HOUR) },
                { name: "fetch", calls: 1, lastUsedAt: iso(NOW - 2 * HOUR) },
              ],
            },
            {
              name: "my_server",
              calls: 1,
              lastUsedAt: iso(NOW - 50 * MINUTE),
              tools: [{ name: "run__all", calls: 1, lastUsedAt: iso(NOW - 50 * MINUTE) }],
            },
          ],
          skills: [
            { name: "notes", calls: 1, lastUsedAt: iso(NOW - 20 * MINUTE) },
            { name: "plug:deploy", calls: 1, lastUsedAt: iso(NOW - 30 * MINUTE) },
            { name: "review", calls: 1, lastUsedAt: iso(NOW - 40 * MINUTE) },
          ],
          sessions: 1,
          scannedFiles: 1,
          scannedBytes: yield* sizeOf(file),
        });
        assert.deepStrictEqual(codex, {
          mcpServers: [],
          skills: [],
          sessions: 0,
          scannedFiles: 0,
          scannedBytes: 0,
        });
      }),
    ),
  );

  it.effect("counts Codex MCP calls and explicit and implicit skill uses", () =>
    withScanner((dirs) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const file = path.join(dirs.codex, "2026", "06", "15", "rollout-a.jsonl");
        yield* writeAt(
          file,
          jsonl(
            codexMeta("codex-session-a", NOW - 4 * HOUR),
            codexItem("item_started", NOW - 3 * HOUR, {
              type: "McpToolCall",
              id: "call-1",
              server: "docs",
              tool: "search",
            }),
            // completed_at_ms wins over the record timestamp.
            codexItem(
              "item_completed",
              NOW - 2 * HOUR,
              { type: "McpToolCall", id: "call-1", server: "docs", tool: "search" },
              { completed_at_ms: NOW - 3 * HOUR },
            ),
            codexMcp("call-2", NOW - HOUR, "github", "get_issue"),
            codexItem("item_completed", NOW - 50 * MINUTE, {
              type: "CommandExecution",
              id: "cmd-1",
              cwd: "/work/repo",
              parsed_cmd: [
                { type: "read", path: ".agents/skills/deploy/SKILL.md" },
                { type: "read", path: "/work/repo/.agents/skills/deploy/SKILL.md" },
                { type: "read", path: "README.md" },
                { type: "search", query: "SKILL.md" },
              ],
            }),
            codexMessage(
              "user",
              NOW - 40 * MINUTE,
              "<skill>\n<name>review</name>\n<path>/skills/review/SKILL.md</path>\nSteps.\n</skill>",
            ),
            codexMessage(
              "developer",
              NOW - 30 * MINUTE,
              "<skill>\n<name>ignored</name>\n<path>/skills/ignored/SKILL.md</path>\n</skill>",
            ),
          ),
          NOW - 30 * MINUTE,
        );

        const { claude, codex } = yield* scan(dirs);
        assert.deepStrictEqual(codex, {
          mcpServers: [
            {
              name: "docs",
              calls: 1,
              lastUsedAt: iso(NOW - 3 * HOUR),
              tools: [{ name: "search", calls: 1, lastUsedAt: iso(NOW - 3 * HOUR) }],
            },
            {
              name: "github",
              calls: 1,
              lastUsedAt: iso(NOW - HOUR),
              tools: [{ name: "get_issue", calls: 1, lastUsedAt: iso(NOW - HOUR) }],
            },
          ],
          skills: [
            { name: "deploy", calls: 1, lastUsedAt: iso(NOW - 50 * MINUTE) },
            { name: "review", calls: 1, lastUsedAt: iso(NOW - 40 * MINUTE) },
          ],
          sessions: 1,
          scannedFiles: 1,
          scannedBytes: yield* sizeOf(file),
        });
        assert.strictEqual(claude.scannedFiles, 0);
      }),
    ),
  );

  it.effect("counts only events inside the window and skips files modified before it", () =>
    withScanner((dirs) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const recent = path.join(dirs.claude, "p", "recent.jsonl");
        const old = path.join(dirs.claude, "p", "old.jsonl");
        yield* writeAt(
          recent,
          jsonl(claudeMcp("toolu_r1", NOW - 10 * DAY), claudeMcp("toolu_r2", NOW - 2 * DAY)),
          NOW - HOUR,
        );
        yield* writeAt(
          old,
          jsonl(claudeMcp("toolu_o1", NOW - 20 * DAY, "mcp__docs__search", "claude-session-old")),
          NOW - 20 * DAY,
        );

        const week = (yield* scan(dirs, 7)).claude;
        assert.deepStrictEqual(toolCalls(week), { "docs/search": 1 });
        assert.strictEqual(week.scannedFiles, 1);
        assert.strictEqual(week.sessions, 1);

        // Wider: the recent file comes from the cache, the old one is read now.
        const month = (yield* scan(dirs, 30)).claude;
        assert.deepStrictEqual(toolCalls(month), { "docs/search": 3 });
        assert.strictEqual(month.scannedFiles, 1);
        assert.strictEqual(month.scannedBytes, yield* sizeOf(old));
        assert.strictEqual(month.sessions, 2);

        const again = (yield* scan(dirs, 7)).claude;
        assert.deepStrictEqual(toolCalls(again), { "docs/search": 1 });
        assert.strictEqual(again.scannedFiles, 0);
        assert.strictEqual(again.scannedBytes, 0);
      }),
    ),
  );

  it.effect("reads only the head check and the appended bytes after an append", () =>
    withScanner((dirs) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const file = path.join(dirs.claude, "p", "grows.jsonl");
        yield* writeAt(
          file,
          jsonl(filler(4_000), claudeMcp("toolu_1", NOW - 2 * HOUR)),
          NOW - 2 * HOUR,
        );
        const first = (yield* scan(dirs)).claude;
        assert.strictEqual(first.scannedBytes, yield* sizeOf(file));
        assert.deepStrictEqual(toolCalls(first), { "docs/search": 1 });

        const unchanged = (yield* scan(dirs)).claude;
        assert.strictEqual(unchanged.scannedFiles, 0);
        assert.strictEqual(unchanged.scannedBytes, 0);
        assert.deepStrictEqual(toolCalls(unchanged), { "docs/search": 1 });

        const appended = jsonl(
          claudeMcp("toolu_2", NOW - HOUR, "mcp__docs__fetch"),
          claudeAssistant("a3", NOW - HOUR, [toolUse("toolu_3", "Skill", { skill: "review" })]),
        );
        yield* writeAt(file, appended, NOW - HOUR, true);
        const grown = (yield* scan(dirs)).claude;
        assert.strictEqual(grown.scannedFiles, 1);
        assert.strictEqual(grown.scannedBytes, 1024 + appended.length);
        assert.deepStrictEqual(toolCalls(grown), { "docs/search": 1, "docs/fetch": 1 });
        assert.deepStrictEqual(skillCalls(grown), { review: 1 });
      }),
    ),
  );

  it.effect("waits for a partial last line, but takes a whole record without its newline", () =>
    withScanner((dirs) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const file = path.join(dirs.claude, "p", "live.jsonl");
        const partial = line(claudeMcp("toolu_2", NOW - HOUR, "mcp__docs__fetch"));
        const split = partial.length - 20;
        yield* writeAt(
          file,
          jsonl(claudeMcp("toolu_1", NOW - 2 * HOUR)) + partial.slice(0, split),
          NOW - HOUR,
        );
        assert.deepStrictEqual(toolCalls((yield* scan(dirs)).claude), { "docs/search": 1 });

        yield* writeAt(file, `${partial.slice(split)}\n`, NOW - 50 * MINUTE, true);
        assert.deepStrictEqual(toolCalls((yield* scan(dirs)).claude), {
          "docs/search": 1,
          "docs/fetch": 1,
        });

        // Complete but not yet newline-terminated: counted now, and only once later.
        yield* writeAt(
          file,
          line(claudeMcp("toolu_3", NOW - 40 * MINUTE, "mcp__git__log")),
          NOW - 40 * MINUTE,
          true,
        );
        assert.deepStrictEqual(toolCalls((yield* scan(dirs)).claude), {
          "docs/search": 1,
          "docs/fetch": 1,
          "git/log": 1,
        });
        yield* writeAt(
          file,
          `\n${jsonl(claudeMcp("toolu_4", NOW - 30 * MINUTE, "mcp__git__log"))}`,
          NOW - 30 * MINUTE,
          true,
        );
        const final = (yield* scan(dirs)).claude;
        assert.deepStrictEqual(toolCalls(final), {
          "docs/search": 1,
          "docs/fetch": 1,
          "git/log": 2,
        });
        assert.strictEqual(final.mcpServers.find((server) => server.name === "git")?.calls, 2);
      }),
    ),
  );

  it.effect("parses a truncated file again from the start", () =>
    withScanner((dirs) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(dirs.claude, "p", "cut.jsonl");
        const keep = jsonl(claudeMcp("toolu_1", NOW - 2 * HOUR));
        yield* writeAt(
          file,
          keep + jsonl(claudeMcp("toolu_2", NOW - HOUR, "mcp__docs__fetch")),
          NOW - HOUR,
        );
        assert.deepStrictEqual(toolCalls((yield* scan(dirs)).claude), {
          "docs/search": 1,
          "docs/fetch": 1,
        });

        yield* fs.truncate(file, keep.length);
        yield* touch(file, NOW - 30 * MINUTE);
        const cut = (yield* scan(dirs)).claude;
        assert.strictEqual(cut.scannedBytes, keep.length);
        assert.deepStrictEqual(toolCalls(cut), { "docs/search": 1 });
      }),
    ),
  );

  it.effect("parses a file rewritten in place with a new head again from the start", () =>
    withScanner((dirs) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const file = path.join(dirs.claude, "p", "rewritten.jsonl");
        yield* writeAt(file, jsonl(claudeMcp("toolu_1", NOW - 2 * HOUR)), NOW - 2 * HOUR);
        assert.deepStrictEqual(toolCalls((yield* scan(dirs)).claude), { "docs/search": 1 });

        // Longer than before, so only the head hash tells it apart from an append.
        yield* writeAt(
          file,
          jsonl(
            claudeMcp("toolu_9", NOW - HOUR, "mcp__git__log"),
            claudeMcp("toolu_10", NOW - HOUR, "mcp__git__diff"),
          ),
          NOW - HOUR,
        );
        assert.deepStrictEqual(toolCalls((yield* scan(dirs)).claude), {
          "git/diff": 1,
          "git/log": 1,
        });
      }),
    ),
  );

  it.effect("parses a replaced file again even when its head is unchanged", () =>
    withScanner((dirs) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(dirs.claude, "p", "rotated.jsonl");
        const head = jsonl(filler(4_000));
        yield* writeAt(file, head + jsonl(claudeMcp("toolu_1", NOW - 2 * HOUR)), NOW - 2 * HOUR);
        assert.deepStrictEqual(toolCalls((yield* scan(dirs)).claude), { "docs/search": 1 });

        // A new file (new inode) renamed over it: same first KiB, different records.
        const replacement = path.join(dirs.claude, "p", "rotated.tmp");
        yield* writeAt(
          replacement,
          head +
            jsonl(
              claudeMcp("toolu_7", NOW - HOUR, "mcp__git__log"),
              claudeMcp("toolu_8", NOW - HOUR, "mcp__git__diff"),
            ),
          NOW - HOUR,
        );
        yield* fs.rename(replacement, file);
        const rotated = (yield* scan(dirs)).claude;
        assert.strictEqual(rotated.scannedBytes, yield* sizeOf(file));
        assert.deepStrictEqual(toolCalls(rotated), { "git/diff": 1, "git/log": 1 });
      }),
    ),
  );

  it.effect("counts a call copied into a resumed or forked transcript once", () =>
    withScanner((dirs) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const shared = claudeMcp("toolu_shared", NOW - 2 * HOUR, "mcp__docs__search", "s-1");
        yield* writeAt(path.join(dirs.claude, "p", "one.jsonl"), jsonl(shared), NOW - HOUR);
        yield* writeAt(
          path.join(dirs.claude, "p", "two.jsonl"),
          jsonl(
            { ...shared, sessionId: "s-2" },
            claudeMcp("toolu_new", NOW - HOUR, "mcp__docs__search", "s-2"),
          ),
          NOW - HOUR,
        );
        yield* writeAt(
          path.join(dirs.codex, "a.jsonl"),
          jsonl(codexMeta("c-1", NOW - 2 * HOUR), codexMcp("call-1", NOW - 2 * HOUR)),
          NOW - HOUR,
        );
        yield* writeAt(
          path.join(dirs.codex, "b.jsonl"),
          jsonl(codexMeta("c-2", NOW - HOUR), codexMcp("call-1", NOW - 2 * HOUR)),
          NOW - HOUR,
        );

        const { claude, codex } = yield* scan(dirs);
        assert.deepStrictEqual(toolCalls(claude), { "docs/search": 2 });
        assert.strictEqual(claude.sessions, 2);
        assert.deepStrictEqual(toolCalls(codex), { "docs/search": 1 });
        assert.strictEqual(codex.sessions, 2);
      }),
    ),
  );

  it.effect("takes the session from the file name when the transcript has none", () =>
    withScanner((dirs) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const uuid = "0f0e0d0c-0b0a-4908-8706-050403020100";
        for (const name of [`rollout-2026-06-15T10-00-00-${uuid}.jsonl`, "other.jsonl"]) {
          yield* writeAt(
            path.join(dirs.codex, "2026", "06", "15", name),
            jsonl(codexMcp(`call-${name}`, NOW - HOUR)),
            NOW - HOUR,
          );
        }
        yield* writeAt(
          path.join(dirs.codex, "2026", "06", "14", `rollout-2026-06-14T10-00-00-${uuid}.jsonl`),
          jsonl(codexMcp("call-copy", NOW - HOUR)),
          NOW - HOUR,
        );
        assert.strictEqual((yield* scan(dirs)).codex.sessions, 2);
      }),
    ),
  );

  it.effect("reports an unreadable root and ignores a missing one", () =>
    withScanner((dirs) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const notADir = path.join(dirs.claude, "file.jsonl");
        yield* writeAt(notADir, jsonl(claudeMcp("toolu_1", NOW - HOUR)), NOW - HOUR);
        const { claude, codex } = yield* scanUsage({
          days: 30,
          roots: [
            { app: "claude", dir: notADir },
            { app: "codex", dir: path.join(dirs.codex, "missing") },
          ],
        });
        assert.include(claude.error ?? "", "Could not list");
        assert.strictEqual(codex.error, undefined);
        assert.strictEqual(codex.scannedFiles, 0);
      }),
    ),
  );

  it.effect("does not follow symlinked directories or enter node_modules", () =>
    withScanner((dirs) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const project = path.join(dirs.claude, "p");
        yield* writeAt(
          path.join(project, "a.jsonl"),
          jsonl(claudeMcp("toolu_1", NOW - HOUR)),
          NOW - HOUR,
        );
        // A tree elsewhere, reachable only through a link.
        const elsewhere = path.join(path.dirname(dirs.claude), "elsewhere");
        yield* writeAt(
          path.join(elsewhere, "b.jsonl"),
          jsonl(claudeMcp("toolu_2", NOW - HOUR)),
          NOW - HOUR,
        );
        yield* fs.symlink(elsewhere, path.join(project, "linked"));
        // A link back up the tree: following it would never end.
        yield* fs.symlink(dirs.claude, path.join(project, "loop"));
        yield* writeAt(
          path.join(project, "work", "node_modules", "pkg", "c.jsonl"),
          jsonl(claudeMcp("toolu_3", NOW - HOUR)),
          NOW - HOUR,
        );

        const { claude } = yield* scan(dirs);
        assert.deepStrictEqual(toolCalls(claude), { "docs/search": 1 });
        assert.strictEqual(claude.scannedFiles, 1);
        assert.strictEqual(claude.error, undefined);
      }),
    ),
  );

  it.effect("starts over from an unreadable cache and writes a valid one", () =>
    withScanner((dirs) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const cacheFile = path.join(config.stateDir, "skills-mcp", "usage-cache.json");
        yield* fs.makeDirectory(path.dirname(cacheFile), { recursive: true });
        yield* fs.writeFileString(cacheFile, "{not json");
        const file = path.join(dirs.claude, "p", "a.jsonl");
        yield* writeAt(file, jsonl(claudeMcp("toolu_1", NOW - HOUR)), NOW - HOUR);

        assert.deepStrictEqual(toolCalls((yield* scan(dirs)).claude), { "docs/search": 1 });
        const saved = yield* decodeSavedCache(yield* fs.readFileString(cacheFile));
        assert.strictEqual(saved.version, 1);
        assert.deepStrictEqual(Object.keys(saved.files), [file]);
        assert.strictEqual(saved.files[file]?.mcp.length, 1);
      }),
    ),
  );

  it.effect("shares one scan between concurrent callers and reuses it briefly", () =>
    withScanner((dirs) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* writeAt(
          path.join(dirs.claude, "p", "a.jsonl"),
          jsonl(claudeMcp("toolu_1", NOW - HOUR)),
          NOW - HOUR,
        );
        const input = { days: 30, refresh: false, roots: dirs.roots };
        const [first, second] = yield* Effect.all([collectUsage(input), collectUsage(input)], {
          concurrency: "unbounded",
        });
        assert.strictEqual(first, second);
        assert.strictEqual(first.claude.scannedFiles, 1);

        assert.strictEqual(yield* collectUsage(input), first);
        const refreshed = yield* collectUsage({ ...input, refresh: true });
        assert.notStrictEqual(refreshed, first);
        assert.strictEqual(refreshed.claude.scannedFiles, 0);
        assert.deepStrictEqual(toolCalls(refreshed.claude), { "docs/search": 1 });

        yield* TestClock.adjust("16 seconds");
        assert.notStrictEqual(yield* collectUsage(input), refreshed);
      }),
    ),
  );
});
