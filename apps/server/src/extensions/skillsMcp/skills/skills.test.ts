// @effect-diagnostics nodeBuiltinImport:off - crc32 and base64 for building zip fixtures in memory.
/**
 * Skills module against temp dirs only: every Claude/Codex folder comes from a
 * sandboxed `homePath`, the CLIs point at nonexistent binaries, and zips are
 * built in memory. No network.
 */
import * as NodeBuffer from "node:buffer";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { SkillRow } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import { resolveAgentClis } from "../shared/agents.ts";
import {
  MANAGED_MARKER,
  extractToTemp,
  extractZip,
  hashDirectory,
  parseSkillFrontmatter,
  safeEntryPath,
  symlinkStaysInside,
  validSkillName,
} from "./archive.ts";
import {
  MAX_BACKUPS,
  createBackup,
  deploy,
  deploymentState,
  listBackups,
  storeSkillDir,
  undeploy,
  writeStoreSkill,
} from "./deploy.ts";
import { listSkills, mutateSkills } from "./index.ts";
import { branchCandidates } from "./remote.ts";
import {
  type ManagedState,
  type UnmanagedSkill,
  buildRows,
  codexSkillsFromResponse,
} from "./scan.ts";
import { DEFAULT_REPOS, type ManagedSkill, resolveSkillsPaths, skillsDocument } from "./store.ts";
import { serverConfigLayerTest, serverSettingsLayerTest } from "./t3.ts";

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`;

const writeTree = Effect.fn("writeTree")(function* (
  root: string,
  files: Readonly<Record<string, string>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, content);
  }
});

interface ZipEntry {
  readonly name: string;
  readonly data?: string;
  readonly kind?: "file" | "dir" | "symlink";
}

/** A stored (uncompressed) zip; a symlink entry's data is its target. */
const buildZip = (entries: ReadonlyArray<ZipEntry>): Uint8Array => {
  const encoder = new TextEncoder();
  const locals: Array<Uint8Array> = [];
  const centrals: Array<Uint8Array> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.data ?? "");
    const crc = NodeZlib.crc32(data);
    const kind = entry.kind ?? (entry.name.endsWith("/") ? "dir" : "file");
    const mode = kind === "symlink" ? 0o120777 : kind === "dir" ? 0o040755 : 0o100644;

    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(12, 33, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(14, 33, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, (mode << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const toBase64 = (bytes: Uint8Array) => NodeBuffer.Buffer.from(bytes).toString("base64");

interface Sandbox {
  readonly root: string;
  readonly claudeHome: string;
  readonly codexHome: string;
  readonly project: string;
}

/** Runs `use` with both apps' config dirs and the T3 state dir inside one temp folder. */
const withSandbox = <A, E, R>(use: (sandbox: Sandbox) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-" }));
    const claudeHome = path.join(root, "claude-config");
    const codexHome = path.join(root, "codex-home");
    const project = path.join(root, "project");
    for (const dir of [claudeHome, codexHome, project]) {
      yield* fs.makeDirectory(dir, { recursive: true });
    }
    const layer = Layer.mergeAll(
      serverSettingsLayerTest({
        providers: {
          claudeAgent: { homePath: claudeHome, binaryPath: "/nonexistent/claude" },
          codex: { homePath: codexHome, binaryPath: "/nonexistent/codex" },
        },
      }),
      serverConfigLayerTest(root, path.join(root, "t3")),
    );
    return yield* Effect.gen(function* () {
      // Never touch the real configs: refuse to run unless both apps are sandboxed.
      const { claude, codex } = yield* resolveAgentClis;
      assert.strictEqual(claude.env.CLAUDE_CONFIG_DIR, claudeHome);
      assert.strictEqual(codex.configDir, codexHome);
      assert.strictEqual(codex.codexHomeSetting, codexHome);
      return yield* use({ root, claudeHome, codexHome, project });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

const DEMO_ZIP = buildZip([
  { name: "demo/" },
  { name: "demo/SKILL.md", data: skillMd("demo", "Demo skill") },
  { name: "demo/notes.md", data: "notes\n" },
]);

const managedSkill = (overrides: Partial<ManagedSkill> = {}): ManagedSkill => ({
  id: "id-demo",
  name: "demo",
  source: { type: "zip", fileName: "demo.zip" },
  installedAt: "2026-09-26T00:00:00.000Z",
  hash: "h",
  apps: { claude: true, codex: false },
  ...overrides,
});

const unmanaged = (overrides: Partial<UnmanagedSkill> & Pick<UnmanagedSkill, "app" | "name">) =>
  ({
    scope: "user",
    dir: `/x/${overrides.app}/${overrides.name}`,
    enabled: true,
    inAppDir: true,
    ...overrides,
  }) satisfies UnmanagedSkill;

const rowByKey = (rows: ReadonlyArray<SkillRow>, key: string) => {
  const row = rows.find((entry) => entry.key === key);
  assert.isDefined(row, `row ${key}`);
  return row!;
};

describe("pure helpers", () => {
  it("parses frontmatter with a BOM, CRLF, and trimming", () => {
    assert.deepStrictEqual(
      parseSkillFrontmatter("\uFEFF---\r\nname:  spaced  \r\ndescription: Hi\r\n---\r\nBody"),
      { name: "spaced", description: "Hi" },
    );
    assert.deepStrictEqual(parseSkillFrontmatter("---\nname: a\ndescription: ''\n---\n"), {
      name: "a",
    });
    assert.deepStrictEqual(parseSkillFrontmatter("---\nname: [unclosed\n---\n"), {});
    assert.deepStrictEqual(parseSkillFrontmatter("---\n- a list\n---\n"), {});
    assert.deepStrictEqual(parseSkillFrontmatter("# No frontmatter\n"), {});
  });

  it("validates skill names", () => {
    assert.strictEqual(validSkillName("  good-name "), "good-name");
    for (const bad of ["", " ", ".hidden", "a/b", "a\\b", "a:b", "a\0b", "x".repeat(129)]) {
      assert.isUndefined(validSkillName(bad), JSON.stringify(bad));
    }
  });

  it("lists branch candidates", () => {
    assert.deepStrictEqual(branchCandidates(undefined), ["main", "master"]);
    assert.deepStrictEqual(branchCandidates("HEAD"), ["main", "master"]);
    assert.deepStrictEqual(branchCandidates("main"), ["main", "master"]);
    assert.deepStrictEqual(branchCandidates("dev"), ["dev", "main", "master"]);
  });

  it("guards zip entry paths", () => {
    assert.strictEqual(safeEntryPath("a/b/"), "a/b");
    for (const bad of ["", "/abs", "C:/x", "a\\b", "../x", "a/../../x", "a/./b", "a//b"]) {
      assert.isUndefined(safeEntryPath(bad), bad);
    }
  });

  it("keeps symlinks inside the archive", () => {
    const none = new Set<string>();
    assert.isTrue(symlinkStaysInside("p", ".", none));
    assert.isTrue(symlinkStaysInside("a/b", "../c", none));
    assert.isFalse(symlinkStaysInside("a", "../x", none));
    assert.isFalse(symlinkStaysInside("a/b", "/etc", none));
    assert.isFalse(symlinkStaysInside("q", "p/..", new Set(["p", "q"])));
  });

  it("merges rows: managed absorbs same-name folders, plugins key apart, apps merge", () => {
    const managed: ManagedState = {
      skill: managedSkill(),
      states: {
        claude: { kind: "symlink", path: "/c/skills/demo" },
        codex: { kind: "foreign", path: "/x/codex/demo" },
      },
    };
    const rows = buildRows(
      [managed],
      [
        unmanaged({ app: "codex", name: "demo", description: "from codex" }),
        unmanaged({ app: "claude", name: "shared", scope: "project", inAppDir: false }),
        unmanaged({ app: "claude", name: "shared" }),
        unmanaged({ app: "codex", name: "shared", enabled: false }),
        unmanaged({ app: "codex", name: "tool", scope: "plugin", pluginId: "x@m" }),
      ],
    );
    assert.deepStrictEqual(
      rows.map((row) => row.key),
      ["id-demo", "shared", "plugin:x@m:tool"],
    );

    const demo = rowByKey(rows, "id-demo");
    assert.isTrue(demo.managed);
    assert.strictEqual(demo.description, "from codex");
    assert.deepStrictEqual(demo.apps.claude, {
      present: true,
      enabled: true,
      scope: "user",
      path: "/c/skills/demo",
      mode: "symlink",
      editable: true,
    });
    assert.strictEqual(demo.apps.codex?.mode, "native");
    assert.strictEqual(demo.apps.codex?.path, "/x/codex/demo");
    assert.isFalse(demo.apps.codex?.editable);

    const shared = rowByKey(rows, "shared");
    assert.isFalse(shared.managed);
    assert.strictEqual(shared.apps.claude?.scope, "user");
    assert.strictEqual(shared.apps.codex?.enabled, false);

    const tool = rowByKey(rows, "plugin:x@m:tool");
    assert.strictEqual(tool.pluginId, "x@m");
    assert.isUndefined(tool.apps.claude);
    assert.strictEqual(tool.apps.codex?.scope, "plugin");
  });

  it("shows a managed skill that isn't deployed as absent", () => {
    const rows = buildRows(
      [
        {
          skill: managedSkill(),
          states: {
            claude: { kind: "none", path: "/c/skills/demo" },
            codex: { kind: "copy", path: "/x/skills/demo" },
          },
        },
      ],
      [],
    );
    const demo = rowByKey(rows, "id-demo");
    assert.deepStrictEqual(demo.apps.claude, {
      present: false,
      enabled: false,
      scope: "user",
      editable: true,
    });
    assert.strictEqual(demo.apps.codex?.mode, "copy");
  });
});

it.layer(NodeServices.layer)("skills", (it) => {
  it.effect("maps Codex skills/list scopes", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = "/h/.codex";
      const skill = (at: string, scope: string, extra: Record<string, unknown> = {}) => ({
        name: path.basename(path.dirname(at)),
        description: "",
        path: at,
        scope,
        enabled: true,
        ...extra,
      });
      const response = {
        data: [
          {
            cwd: "/other",
            skills: [skill("/elsewhere/ignored/SKILL.md", "user")],
            errors: [],
          },
          {
            cwd: "/proj",
            skills: [
              skill(`${home}/skills/plain/SKILL.md`, "user", { description: "Plain" }),
              skill(`${home}/skills/plain/SKILL.md`, "user"),
              skill("/h/.agents/skills/agents-skill/SKILL.md", "user", {
                interface: { shortDescription: "From interface" },
              }),
              skill(`${home}/skills/synced/bucket/synced-one/SKILL.md`, "user"),
              skill("/proj/.agents/skills/proj/SKILL.md", "repo"),
              skill(`${home}/skills/.system/sys/SKILL.md`, "system"),
              skill(`${home}/plugins/cache/mkt/tools/1.0.0/skills/tool/SKILL.md`, "user"),
            ],
            errors: [],
          },
        ],
      } as unknown as CodexSchema.V2SkillsListResponse;
      const found = codexSkillsFromResponse(
        response,
        "/proj",
        { lexical: `${home}/skills`, real: `${home}/skills` },
        path,
      );
      assert.deepStrictEqual(
        found.map((entry) => [entry.name, entry.scope, entry.inAppDir, entry.pluginId]),
        [
          ["plain", "user", true, undefined],
          ["agents-skill", "user", false, undefined],
          ["synced-one", "synced", false, undefined],
          ["proj", "project", false, undefined],
          ["sys", "system", false, undefined],
          ["tool", "plugin", false, "tools@mkt"],
        ],
      );
      assert.strictEqual(found[0]?.description, "Plain");
      assert.strictEqual(found[0]?.dir, `${home}/skills/plain`);
      assert.strictEqual(found[1]?.description, "From interface");
    }),
  );

  it.effect("round-trips the store document and keeps paths in the sandbox", () =>
    withSandbox(({ root, claudeHome, codexHome }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fresh = yield* skillsDocument.read;
        assert.deepStrictEqual(fresh.skills, []);
        assert.deepStrictEqual(fresh.repos, DEFAULT_REPOS);

        const skill = managedSkill();
        yield* skillsDocument.update((doc) =>
          Effect.succeed([undefined, { ...doc, skills: [skill] }] as const),
        );
        assert.deepStrictEqual((yield* skillsDocument.read).skills, [skill]);

        const { paths } = yield* resolveSkillsPaths;
        assert.isTrue(paths.storeDir.startsWith(`${root}${path.sep}`));
        assert.isTrue(paths.backupDir.startsWith(`${root}${path.sep}`));
        assert.strictEqual(paths.appDirs.claude, path.join(claudeHome, "skills"));
        assert.strictEqual(paths.appDirs.codex, path.join(codexHome, "skills"));
      }),
    ),
  );

  it.effect("deploys by symlink, falls back to a marked copy, and removes only its own", () =>
    withSandbox(({ root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { paths } = yield* resolveSkillsPaths;
        const source = path.join(root, "src-demo");
        yield* writeTree(source, { "SKILL.md": skillMd("demo", "Demo") });
        const ref = { id: "id-demo", name: "demo" };
        const store = yield* writeStoreSkill(paths, "demo", source);
        assert.strictEqual(store, storeSkillDir(path, paths, "demo"));

        assert.strictEqual(yield* deploy(paths, "claude", ref), "symlink");
        const claudeState = yield* deploymentState(paths, "claude", ref);
        assert.strictEqual(claudeState.kind, "symlink");
        assert.strictEqual(yield* fs.readLink(claudeState.path), store);
        assert.strictEqual(yield* deploy(paths, "claude", ref), "symlink");

        const noSymlinks: FileSystem.FileSystem = {
          ...fs,
          symlink: () =>
            Effect.fail(PlatformError.badArgument({ module: "FileSystem", method: "symlink" })),
        };
        const mode = yield* deploy(paths, "codex", ref).pipe(
          Effect.provideService(FileSystem.FileSystem, noSymlinks),
        );
        assert.strictEqual(mode, "copy");
        const codexState = yield* deploymentState(paths, "codex", ref);
        assert.strictEqual(codexState.kind, "copy");
        assert.strictEqual(
          (yield* fs.readFileString(path.join(codexState.path, MANAGED_MARKER))).trim(),
          "id-demo",
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(codexState.path, "SKILL.md")),
          skillMd("demo", "Demo"),
        );

        assert.strictEqual((yield* undeploy(paths, "claude", ref)).kind, "symlink");
        assert.strictEqual((yield* undeploy(paths, "codex", ref)).kind, "copy");
        assert.isFalse(yield* fs.exists(claudeState.path));
        assert.isFalse(yield* fs.exists(codexState.path));
        assert.isTrue(yield* fs.exists(path.join(store, "SKILL.md")));

        // A folder we didn't put there is never replaced or removed.
        const foreign = path.join(paths.appDirs.claude, "demo");
        yield* writeTree(foreign, { "SKILL.md": skillMd("demo", "Mine") });
        const refused = yield* Effect.flip(deploy(paths, "claude", ref));
        assert.include(refused.message, "isn't managed here");
        assert.strictEqual((yield* undeploy(paths, "claude", ref)).kind, "foreign");
        assert.isTrue(yield* fs.exists(path.join(foreign, "SKILL.md")));
      }),
    ),
  );

  it.effect("hashes folders stably, ignoring the marker and .DS_Store", () =>
    withSandbox(({ root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const a = path.join(root, "a");
        const b = path.join(root, "b");
        const files = { "SKILL.md": skillMd("h", "Hash"), "refs/one.md": "1\n", "two.md": "2\n" };
        yield* writeTree(a, files);
        yield* writeTree(b, {
          "two.md": "2\n",
          "refs/one.md": "1\n",
          "SKILL.md": files["SKILL.md"],
        });
        const first = yield* hashDirectory(a);
        assert.strictEqual(yield* hashDirectory(a), first);
        assert.strictEqual(yield* hashDirectory(b), first);

        yield* writeTree(b, { [MANAGED_MARKER]: "id\n", ".DS_Store": "junk" });
        assert.strictEqual(yield* hashDirectory(b), first);

        yield* fs.writeFileString(path.join(b, "refs/one.md"), "changed\n");
        assert.notStrictEqual(yield* hashDirectory(b), first);
      }),
    ),
  );

  it.effect("keeps the newest backups", () =>
    withSandbox(({ root }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { paths } = yield* resolveSkillsPaths;
        const source = path.join(root, "src");
        yield* writeTree(source, { "SKILL.md": skillMd("demo", "Demo") });
        const meta = {
          name: "demo",
          source: { type: "local", path: source } as const,
          apps: { claude: true, codex: false },
        };
        const ids: Array<string> = [];
        for (let n = 0; n <= MAX_BACKUPS; n++) {
          ids.push(yield* createBackup(paths, meta, source));
          yield* TestClock.adjust(Duration.seconds(1));
        }
        const kept = yield* listBackups(paths);
        assert.strictEqual(kept.length, MAX_BACKUPS);
        assert.deepStrictEqual(
          kept.map((entry) => entry.backup.id),
          ids.slice(1).toReversed(),
        );
        assert.strictEqual(kept[0]?.backup.skillName, "demo");
      }),
    ),
  );

  it.effect("refuses zips that escape the destination", () =>
    withSandbox(({ root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dest = path.join(root, "out", "dest");
        const cases: ReadonlyArray<readonly [ReadonlyArray<ZipEntry>, string]> = [
          [[{ name: "../evil", data: "x" }], "Invalid zip"],
          [[{ name: "/abs-evil", data: "x" }], "Invalid zip"],
          [
            [
              { name: "skill/SKILL.md", data: skillMd("s", "S") },
              { name: "skill/link", data: "../../etc", kind: "symlink" },
            ],
            "points outside the archive",
          ],
        ];
        for (const [entries, expected] of cases) {
          yield* fs.makeDirectory(dest, { recursive: true });
          const failure = yield* Effect.flip(extractZip(buildZip(entries), dest));
          assert.include(failure.message, "Invalid zip");
          assert.include(failure.message, expected);
          yield* fs.remove(dest, { recursive: true });
        }
        assert.deepStrictEqual(yield* fs.readDirectory(path.join(root, "out")), []);
        assert.isFalse(yield* fs.exists(path.join(root, "evil")));
      }),
    ),
  );

  it.effect("unpacks a zip, stripping its common root and keeping inside links", () =>
    withSandbox(({ root }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const zip = buildZip([
          { name: "pack/" },
          { name: "pack/SKILL.md", data: skillMd("pack", "Pack") },
          { name: "pack/refs/doc.md", data: "doc\n" },
          { name: "pack/alias.md", data: "refs/doc.md", kind: "symlink" },
        ]);
        const unpacked = yield* Effect.scoped(
          Effect.gen(function* () {
            const { root: dir, rootName } = yield* extractToTemp(path.join(root, "tmp"), zip);
            return {
              dir,
              rootName,
              link: yield* fs.readLink(path.join(dir, "alias.md")),
              doc: yield* fs.readFileString(path.join(dir, "alias.md")),
            };
          }),
        );
        assert.strictEqual(unpacked.rootName, "pack");
        assert.strictEqual(unpacked.link, "refs/doc.md");
        assert.strictEqual(unpacked.doc, "doc\n");
        assert.isFalse(yield* fs.exists(unpacked.dir));
      }),
    ),
  );

  it.effect("installs from a zip, enables, and uninstalls with a backup", () =>
    withSandbox(() =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { paths } = yield* resolveSkillsPaths;
        const installed = yield* mutateSkills({
          action: "installZip",
          fileName: "demo.zip",
          dataBase64: `data:application/zip;base64,${toBase64(DEMO_ZIP)}`,
          apps: { claude: true, codex: false },
        });
        assert.deepStrictEqual(installed, { failures: [], message: "Installed demo" });
        const [skill] = (yield* skillsDocument.read).skills;
        assert.isDefined(skill);
        assert.strictEqual(skill!.description, "Demo skill");
        assert.deepStrictEqual(skill!.source, { type: "zip", fileName: "demo.zip" });
        assert.deepStrictEqual(skill!.apps, { claude: true, codex: false });
        assert.strictEqual((yield* deploymentState(paths, "claude", skill!)).kind, "symlink");
        assert.strictEqual((yield* deploymentState(paths, "codex", skill!)).kind, "none");

        const again = yield* mutateSkills({
          action: "installZip",
          fileName: "demo.zip",
          dataBase64: toBase64(DEMO_ZIP),
          apps: { claude: true, codex: false },
        });
        assert.strictEqual(again.message, "Nothing installed from demo.zip");
        assert.include(again.failures[0]?.message ?? "", "already installed");

        const garbage = yield* Effect.flip(
          mutateSkills({
            action: "installZip",
            fileName: "bad.zip",
            dataBase64: "not*base64",
            apps: { claude: true, codex: false },
          }),
        );
        assert.include(garbage.message, "invalid base64 data");

        const enabled = yield* mutateSkills({
          action: "setEnabled",
          id: skill!.id,
          app: "codex",
          enabled: true,
        });
        assert.strictEqual(enabled.message, "Enabled demo for Codex");
        assert.strictEqual((yield* deploymentState(paths, "codex", skill!)).kind, "symlink");
        assert.deepStrictEqual((yield* skillsDocument.read).skills[0]?.apps, {
          claude: true,
          codex: true,
        });

        const removed = yield* mutateSkills({ action: "uninstall", id: skill!.id });
        assert.match(removed.message ?? "", /^Uninstalled demo \(backup \S+_demo\)$/);
        assert.deepStrictEqual((yield* skillsDocument.read).skills, []);
        assert.isFalse(yield* fs.exists(storeSkillDir(path, paths, "demo")));
        assert.strictEqual((yield* deploymentState(paths, "claude", skill!)).kind, "none");
        assert.strictEqual((yield* deploymentState(paths, "codex", skill!)).kind, "none");
        assert.strictEqual((yield* listBackups(paths)).length, 1);
      }),
    ),
  );

  it.effect("adopts a skill copied into both apps, backing up each copy", () =>
    withSandbox(({ claudeHome, codexHome }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { paths } = yield* resolveSkillsPaths;
        const claudeCopy = path.join(claudeHome, "skills", "foo");
        const codexCopy = path.join(codexHome, "skills", "foo");
        yield* writeTree(claudeCopy, { "SKILL.md": skillMd("foo", "Claude copy") });
        yield* writeTree(codexCopy, { "SKILL.md": skillMd("foo", "Codex copy") });

        const relative = yield* Effect.flip(
          mutateSkills({
            action: "adopt",
            path: "skills/foo",
            apps: { claude: false, codex: false },
          }),
        );
        assert.include(relative.message, "absolute path");

        const adopted = yield* mutateSkills({
          action: "adopt",
          path: claudeCopy,
          apps: { claude: false, codex: false },
        });
        assert.deepStrictEqual(adopted, {
          failures: [],
          message: "Adopted foo (backed up 2 copies)",
        });
        const backups = yield* listBackups(paths);
        assert.strictEqual(backups.length, 2);
        const [skill] = (yield* skillsDocument.read).skills;
        assert.strictEqual(skill?.name, "foo");
        assert.strictEqual(skill?.description, "Claude copy");
        assert.deepStrictEqual(skill?.apps, { claude: true, codex: true });
        const store = storeSkillDir(path, paths, "foo");
        assert.strictEqual(
          yield* fs.readFileString(path.join(store, "SKILL.md")),
          skillMd("foo", "Claude copy"),
        );
        for (const app of ["claude", "codex"] as const) {
          const state = yield* deploymentState(paths, app, skill!);
          assert.strictEqual(state.kind, "symlink", app);
          assert.strictEqual(yield* fs.readLink(state.path), store);
        }
        const backedUp = yield* Effect.forEach(backups, (entry) =>
          fs.readFileString(path.join(entry.backup.path, "SKILL.md")),
        );
        assert.sameMembers(backedUp, [skillMd("foo", "Claude copy"), skillMd("foo", "Codex copy")]);

        const twice = yield* Effect.flip(
          mutateSkills({
            action: "adopt",
            path: claudeCopy,
            apps: { claude: false, codex: false },
          }),
        );
        assert.include(twice.message, "foo");
      }),
    ),
  );

  it.effect("lists managed and unmanaged skills side by side", () =>
    withSandbox(({ claudeHome, codexHome, project }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* writeTree(claudeHome, {
          "skills/shared/SKILL.md": skillMd("shared", "Shared (Claude)"),
          "skills/claude-only/SKILL.md": skillMd("claude-only", "Only Claude"),
          "skills/synced/bucket/synced-one/SKILL.md": skillMd("synced-one", "Synced"),
          "skills/not-a-skill/README.md": "no SKILL.md\n",
        });
        yield* writeTree(codexHome, {
          "skills/shared/SKILL.md": skillMd("shared", "Shared (Codex)"),
          "skills/.system/sys-skill/SKILL.md": skillMd("sys-skill", "Bundled"),
          "skills/synced/bucket/codex-synced/SKILL.md": skillMd("codex-synced", "Nested"),
        });
        yield* writeTree(project, {
          ".claude/skills/proj/SKILL.md": skillMd("proj", "Project skill"),
        });
        yield* mutateSkills({
          action: "installZip",
          fileName: "demo.zip",
          dataBase64: toBase64(DEMO_ZIP),
          apps: { claude: true, codex: true },
        });

        const overview = yield* listSkills({ cwd: project });
        const codexInfo = overview.apps.find((app) => app.app === "codex");
        assert.strictEqual(codexInfo?.available, false);
        assert.strictEqual(overview.appDirs.claude, path.join(claudeHome, "skills"));
        assert.strictEqual(overview.appDirs.codex, path.join(codexHome, "skills"));

        const byName = (name: string) => overview.skills.filter((row) => row.name === name);
        assert.deepStrictEqual(
          overview.skills.map((row) => row.name),
          ["claude-only", "demo", "proj", "shared", "synced-one", "sys-skill"],
        );

        const [demo] = byName("demo");
        assert.isTrue(demo?.managed);
        assert.strictEqual(demo?.apps.claude?.mode, "symlink");
        assert.strictEqual(demo?.apps.codex?.mode, "symlink");

        const [shared] = byName("shared");
        assert.isFalse(shared?.managed);
        assert.strictEqual(shared?.apps.claude?.path, path.join(claudeHome, "skills", "shared"));
        assert.strictEqual(shared?.apps.codex?.path, path.join(codexHome, "skills", "shared"));
        assert.strictEqual(shared?.apps.codex?.scope, "user");

        assert.strictEqual(byName("proj")[0]?.apps.claude?.scope, "project");
        assert.strictEqual(byName("synced-one")[0]?.apps.claude?.scope, "synced");
        assert.strictEqual(byName("sys-skill")[0]?.apps.codex?.scope, "system");
        assert.isUndefined(byName("sys-skill")[0]?.apps.claude);
      }),
    ),
  );
});
