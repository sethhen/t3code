// @effect-diagnostics nodeBuiltinImport:off - lays out fake Claude config dirs in a temp home.
/**
 * Account dirs against a temp home, so nothing reaches the real `~/.claude`.
 * The key tests (real home) use dirs outside it without a marker, which
 * `shareClaudeHistory` leaves alone.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { afterAll } from "vite-plus/test";

import { makeClaudeContinuationGroupKey } from "../provider/Drivers/ClaudeHome.ts";
import {
  CLAUDE_ACCOUNT_MARKER,
  claudeSharedHistoryKey,
  shareClaudeHistory,
} from "./claudeHistory.ts";

// Real paths: macOS temp dirs sit behind the /var -> /private/var link.
const root = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-history-")),
);
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));

let homes = 0;
/** A fresh home with a main dir (`.claude`). */
const makeHome = () => {
  const home = NodePath.join(root, `home-${++homes}`);
  NodeFS.mkdirSync(NodePath.join(home, ".claude"), { recursive: true });
  return { home, main: NodePath.join(home, ".claude") };
};

/** Writes `files` (relative path → content) under `dir`. */
const write = (dir: string, files: Record<string, string>) => {
  for (const [relative, content] of Object.entries(files)) {
    const file = NodePath.join(dir, relative);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, content);
  }
};

const read = (file: string) => NodeFS.readFileSync(file, "utf8");

const isLinkTo = (path: string, target: string) =>
  NodeFS.lstatSync(path).isSymbolicLink() &&
  NodeFS.realpathSync(path) === NodeFS.realpathSync(target);

/** Every path under `dir` with its type and content (a link's target), to compare before and after. */
const tree = (dir: string) => {
  const entries: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of NodeFS.readdirSync(at)) {
      const path = NodePath.join(at, name);
      const stat = NodeFS.lstatSync(path);
      const key = NodePath.relative(dir, path);
      if (stat.isSymbolicLink()) entries[key] = `link ${NodeFS.readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        entries[key] = "dir";
        walk(path);
      } else entries[key] = `file ${read(path)}`;
    }
  };
  walk(dir);
  return entries;
};

const share = async (configDir: string, home: string, instanceId?: string) => {
  const logs: Array<string> = [];
  await shareClaudeHistory(configDir, {
    home,
    platform: HostProcessPlatform.defaultValue(),
    ...(instanceId ? { instanceId } : {}),
    log: (m) => logs.push(m),
  });
  return logs;
};

/** An account dir the fork made. */
const markedAccount = (home: string, name: string) => {
  const dir = NodePath.join(home, name);
  write(dir, { [CLAUDE_ACCOUNT_MARKER]: "" });
  return dir;
};

describe("shareClaudeHistory", () => {
  it("links a marked account dir's projects and plans to the main dir", async () => {
    const { home, main } = makeHome();
    const dir = markedAccount(home, "claude-work");
    assert.deepStrictEqual(await share(dir, home), []);
    assert.isTrue(isLinkTo(NodePath.join(dir, "projects"), NodePath.join(main, "projects")));
    assert.isTrue(isLinkTo(NodePath.join(dir, "plans"), NodePath.join(main, "plans")));
    // Idempotent and quiet once linked.
    assert.deepStrictEqual(await share(dir, home), []);
  });

  it("links a ~/.claude-* dir the previous release made for a claude_<hash> instance", async () => {
    const { home, main } = makeHome();
    const dir = NodePath.join(home, ".claude-ann-example-com");
    NodeFS.mkdirSync(dir);
    await share(dir, home, "claude_1a2b3c4d");
    assert.isTrue(isLinkTo(NodePath.join(dir, "projects"), NodePath.join(main, "projects")));
    assert.isTrue(isLinkTo(NodePath.join(dir, "plans"), NodePath.join(main, "plans")));
  });

  it("leaves dirs that aren't accounts alone, and the main dir", async () => {
    const { home, main } = makeHome();
    write(main, { "projects/-repo/main.jsonl": "main", "settings.json": "{}" });
    // A `~/.claude-*` dir linked into the main dir, but the user's own instance.
    const unmarked = NodePath.join(home, ".claude-work");
    write(unmarked, { "projects/-repo/a.jsonl": "a" });
    NodeFS.symlinkSync(
      NodePath.join(main, "settings.json"),
      NodePath.join(unmarked, "settings.json"),
    );
    // A `claude_<hash>` instance, but not on a `~/.claude-*` dir.
    const elsewhere = NodePath.join(home, "work", ".claude-x");
    NodeFS.mkdirSync(elsewhere, { recursive: true });
    NodeFS.symlinkSync(NodePath.join(main, "projects"), NodePath.join(elsewhere, "linked"));

    for (const [dir, instanceId] of [
      [main, "claudeAgent"],
      [unmarked, "claude_work"],
      [elsewhere, "claude_1a2b3c4d"],
    ] as const) {
      assert.deepStrictEqual(await share(dir, home, instanceId), []);
    }

    assert.isTrue(NodeFS.lstatSync(NodePath.join(main, "projects")).isDirectory());
    assert.isFalse(NodeFS.existsSync(NodePath.join(main, "plans")));
    assert.isTrue(NodeFS.lstatSync(NodePath.join(unmarked, "projects")).isDirectory());
    assert.equal(read(NodePath.join(unmarked, "projects/-repo/a.jsonl")), "a");
    assert.isFalse(NodeFS.existsSync(NodePath.join(unmarked, "plans")));
    assert.deepStrictEqual(NodeFS.readdirSync(elsewhere), ["linked"]);
  });

  it("links to the main dir the marker names", async () => {
    const { home } = makeHome();
    const main = NodePath.join(root, `x-${homes}`, "main");
    NodeFS.mkdirSync(main, { recursive: true });
    const dir = NodePath.join(home, ".claude-work");
    write(dir, { [CLAUDE_ACCOUNT_MARKER]: `${main}\n`, "projects/-repo/a.jsonl": "a" });

    assert.deepStrictEqual(await share(dir, home), []);

    assert.isTrue(isLinkTo(NodePath.join(dir, "projects"), NodePath.join(main, "projects")));
    assert.isTrue(isLinkTo(NodePath.join(dir, "plans"), NodePath.join(main, "plans")));
    assert.equal(read(NodePath.join(main, "projects/-repo/a.jsonl")), "a");
    assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(home, ".claude")), []);
    // A marker naming its own dir: that dir is the main one.
    write(main, { [CLAUDE_ACCOUNT_MARKER]: main });
    assert.deepStrictEqual(await share(main, home), []);
    assert.isTrue(NodeFS.lstatSync(NodePath.join(main, "projects")).isDirectory());
  });

  it("leaves a main dir whose projects and plans link into the account alone", async () => {
    const { home, main } = makeHome();
    const dir = markedAccount(home, ".claude-work");
    write(dir, {
      "projects/-repo/a.jsonl": "a",
      "projects/-repo/a/subagents/agent-1.jsonl": "sub",
      "plans/plan.md": "plan",
    });
    NodeFS.symlinkSync(NodePath.join(dir, "projects"), NodePath.join(main, "projects"));
    NodeFS.symlinkSync(NodePath.join(dir, "plans"), NodePath.join(main, "plans"));
    const before = tree(home);

    const logs = await share(dir, home);

    assert.deepStrictEqual(tree(home), before);
    assert.lengthOf(
      logs.filter((log) => log.includes("one directory already")),
      2,
    );
  });

  it("merges an account's conversations and plans into the main dir, then links them", async () => {
    const { home, main } = makeHome();
    write(main, {
      "projects/-repo/same.jsonl": "same",
      "projects/-repo/differs.jsonl": "main's",
      "projects/-repo/memory/MEMORY.md": "main memory",
      "plans/main-plan.md": "main plan",
    });
    const dir = markedAccount(home, ".claude-work");
    write(dir, {
      "projects/-repo/same.jsonl": "same",
      "projects/-repo/differs.jsonl": "account's",
      "projects/-repo/session-1.jsonl": "s1",
      "projects/-repo/session-1/subagents/agent-1.jsonl": "sub",
      "projects/-repo/memory/notes.md": "account notes",
      "projects/-other/session-2.jsonl": "s2",
      "plans/account-plan.md": "account plan",
    });
    // A session file left behind by a Claude that has exited doesn't hold the merge back.
    const exited = NodeChildProcess.spawnSync(process.execPath, ["-e", ""]).pid;
    write(dir, { "sessions/old.json": JSON.stringify({ pid: exited }), "sessions/bad.json": "{" });

    const logs = await share(dir, home);

    const projects = NodePath.join(main, "projects");
    const differs = NodePath.join(projects, "-repo/differs.jsonl");
    assert.deepStrictEqual(logs, [
      `Kept both copies of ${differs}: the account's is ${differs}.from-.claude-work`,
    ]);
    assert.isTrue(isLinkTo(NodePath.join(dir, "projects"), projects));
    assert.isTrue(isLinkTo(NodePath.join(dir, "plans"), NodePath.join(main, "plans")));
    assert.equal(read(NodePath.join(projects, "-repo/same.jsonl")), "same");
    assert.equal(read(NodePath.join(projects, "-repo/differs.jsonl")), "main's");
    assert.equal(
      read(NodePath.join(projects, "-repo/differs.jsonl.from-.claude-work")),
      "account's",
    );
    assert.equal(read(NodePath.join(projects, "-repo/session-1.jsonl")), "s1");
    assert.equal(read(NodePath.join(projects, "-repo/session-1/subagents/agent-1.jsonl")), "sub");
    assert.equal(read(NodePath.join(projects, "-repo/memory/MEMORY.md")), "main memory");
    assert.equal(read(NodePath.join(projects, "-repo/memory/notes.md")), "account notes");
    assert.equal(read(NodePath.join(projects, "-other/session-2.jsonl")), "s2");
    assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(main, "plans")).sort(), [
      "account-plan.md",
      "main-plan.md",
    ]);
    assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "projects.t3-link")));
  });

  it("keeps a dir separate while a Claude process uses it", async () => {
    const { home, main } = makeHome();
    const dir = markedAccount(home, ".claude-busy");
    write(dir, {
      "projects/-repo/live.jsonl": "live",
      "sessions/1.json": JSON.stringify({ pid: process.pid }),
    });

    const logs = await share(dir, home);

    assert.isTrue(NodeFS.lstatSync(NodePath.join(dir, "projects")).isDirectory());
    assert.equal(read(NodePath.join(dir, "projects/-repo/live.jsonl")), "live");
    assert.isFalse(NodeFS.existsSync(NodePath.join(main, "projects/-repo")));
    assert.isTrue(logs.some((log) => log.includes("Claude is running")));
    // `plans` didn't exist yet, so nothing had to move: it's linked.
    assert.isTrue(isLinkTo(NodePath.join(dir, "plans"), NodePath.join(main, "plans")));
  });

  it("links a dir whose merge can't finish, keeping what is left aside", async () => {
    const { home, main } = makeHome();
    write(main, {
      "projects/-repo/differs.jsonl": "main's",
      "projects/-repo/differs.jsonl.from-.claude-work": "an earlier copy",
    });
    const dir = markedAccount(home, ".claude-work");
    write(dir, { "projects/-repo/differs.jsonl": "account's", "projects/-repo/new.jsonl": "new" });

    const logs = await share(dir, home);

    assert.isTrue(isLinkTo(NodePath.join(dir, "projects"), NodePath.join(main, "projects")));
    const aside = NodeFS.readdirSync(dir).filter((name) => name.startsWith("projects.unmerged-"));
    assert.lengthOf(aside, 1);
    const leftover = NodePath.join(dir, aside[0]!);
    assert.deepStrictEqual(tree(leftover), {
      "-repo": "dir",
      "-repo/differs.jsonl": "file account's",
    });
    assert.equal(read(NodePath.join(main, "projects/-repo/differs.jsonl")), "main's");
    assert.equal(
      read(NodePath.join(main, "projects/-repo/differs.jsonl.from-.claude-work")),
      "an earlier copy",
    );
    assert.equal(read(NodePath.join(main, "projects/-repo/new.jsonl")), "new");
    assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "projects.t3-link")));
    assert.isTrue(logs.some((log) => log.includes(leftover)));
  });

  it("leaves a projects link that points elsewhere", async () => {
    const { home } = makeHome();
    const dir = markedAccount(home, ".claude-own");
    const other = NodePath.join(root, `other-projects-${homes}`);
    NodeFS.mkdirSync(other);
    NodeFS.symlinkSync(other, NodePath.join(dir, "projects"));

    const logs = await share(dir, home);

    assert.equal(NodeFS.realpathSync(NodePath.join(dir, "projects")), other);
    assert.isTrue(logs.some((log) => log.includes("links elsewhere")));
  });
});

describe("claudeSharedHistoryKey", () => {
  const key = (configDir: string) =>
    Effect.gen(function* () {
      const upstreamKey = yield* makeClaudeContinuationGroupKey({ homePath: configDir });
      return {
        upstreamKey,
        key: yield* claudeSharedHistoryKey(configDir, upstreamKey, "claudeAgent"),
      };
    }).pipe(Effect.provide(NodeServices.layer));

  it.effect("keys an account linked to the main dir by the main dir", () =>
    Effect.gen(function* () {
      const { home, main } = makeHome();
      NodeFS.mkdirSync(NodePath.join(main, "projects"));
      const dir = NodePath.join(home, "account");
      NodeFS.mkdirSync(dir);
      NodeFS.symlinkSync(NodePath.join(main, "projects"), NodePath.join(dir, "projects"));

      const linked = yield* key(dir);
      const mainKey = yield* key(main);
      assert.equal(linked.key, `claude:home:${main}`);
      assert.equal(mainKey.key, linked.key);
      // The default dir keeps upstream's key.
      assert.equal(mainKey.key, mainKey.upstreamKey);
    }),
  );

  it.effect("keeps upstream's key for a dir with conversations of its own, or none", () =>
    Effect.gen(function* () {
      const { home } = makeHome();
      const own = NodePath.join(home, "own");
      NodeFS.mkdirSync(NodePath.join(own, "projects"), { recursive: true });
      const empty = NodePath.join(home, "empty");
      NodeFS.mkdirSync(empty);

      for (const dir of [own, empty]) {
        const result = yield* key(dir);
        assert.equal(result.key, result.upstreamKey);
      }
      assert.equal((yield* key(own)).key, `claude:home:${own}`);
    }),
  );

  it.effect("keeps upstream's key when projects links to a dir with another name", () =>
    Effect.gen(function* () {
      const { home } = makeHome();
      const dir = NodePath.join(home, "account");
      const history = NodePath.join(home, "history");
      NodeFS.mkdirSync(dir);
      NodeFS.mkdirSync(history);
      NodeFS.symlinkSync(history, NodePath.join(dir, "projects"));

      const result = yield* key(dir);
      assert.equal(result.key, result.upstreamKey);
      assert.equal(result.key, `claude:home:${dir}`);
    }),
  );
});
