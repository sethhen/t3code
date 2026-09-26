/**
 * Skills the apps already see that the store doesn't manage, and the merge of
 * those with the managed skills into one row per name for `skills.list`.
 *
 * Claude: `<configDir>/skills` (user), `<configDir>/skills/synced/<bucket>/*`
 * (Claude Desktop's sync, read-only) and `<cwd>/.claude/skills` (project).
 * Codex: its own `skills/list`, which also covers `.system`, `~/.agents/skills`,
 * repo skills and plugins; a plain folder scan stands in when Codex can't run.
 */
import type { AgentApp, SkillAppEntry, SkillRow, SkillScope } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { type AgentCli, withCodexClient } from "../shared/agents.ts";
import { gatedRead } from "../mcp/probes.ts";
import { ExtensionFailure, discoverClaudeSkills } from "../shared/t3.ts";
import { isSymlink, readSkillInfo } from "./archive.ts";
import type { DeploymentState } from "./deploy.ts";
import type { ManagedSkill, SkillsPaths } from "./store.ts";

const CODEX_LIST_TIMEOUT = Duration.seconds(20);
const SYNCED_DIR = "synced";

/** A skill folder one app loads that the store doesn't manage. */
export interface UnmanagedSkill {
  readonly app: AgentApp;
  /** Folder name; rows merge on it. */
  readonly name: string;
  readonly description?: string | undefined;
  readonly scope: SkillScope;
  /** The skill folder (not its SKILL.md). */
  readonly dir: string;
  readonly enabled: boolean;
  readonly pluginId?: string | undefined;
  /** A plain folder (not a link) directly inside the app's user skills folder, so `adopt` can take it. */
  readonly inAppDir: boolean;
}

/** A managed skill and what currently sits at its name in each app folder. */
export interface ManagedState {
  readonly skill: ManagedSkill;
  readonly states: { readonly [K in AgentApp]: DeploymentState };
}

const realPathOr = (target: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.realPath(target).pipe(Effect.orElseSucceed(() => target)),
  );

const hasSkillFile = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const info = yield* fs.stat(path.join(dir, "SKILL.md")).pipe(Effect.option);
    return Option.isSome(info) && info.value.type === "File";
  });

const sortedEntries = (dir: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readDirectory(dir).pipe(
      Effect.map((names) => names.filter((name) => !name.startsWith(".")).sort()),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    ),
  );

/** Skill folders one level below `dir`, as unmanaged entries with the given scope. */
const scanFolder = (
  app: AgentApp,
  dir: string,
  scope: SkillScope,
  inAppDir: boolean,
  skip: ReadonlySet<string> = new Set(),
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const found: Array<UnmanagedSkill> = [];
    for (const name of yield* sortedEntries(dir)) {
      if (skip.has(name)) continue;
      const skillDir = path.join(dir, name);
      if (!(yield* hasSkillFile(skillDir))) continue;
      const info = yield* readSkillInfo(skillDir);
      found.push({
        app,
        name,
        description: info.description,
        scope,
        dir: skillDir,
        enabled: true,
        inAppDir: inAppDir && !(yield* isSymlink(skillDir)),
      });
    }
    return found;
  });

/** `<appDir>/synced/<bucket>/<skill>/SKILL.md`: Claude Desktop's synced skills. */
const scanSynced = (app: AgentApp, appDir: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const syncedDir = path.join(appDir, SYNCED_DIR);
    const found: Array<UnmanagedSkill> = [];
    for (const bucket of yield* sortedEntries(syncedDir)) {
      found.push(...(yield* scanFolder(app, path.join(syncedDir, bucket), "synced", false)));
    }
    return found;
  });

/** Claude's user and project skills plus Claude Desktop's synced ones. */
export const scanClaude = Effect.fn("skillsMcp.skills.scanClaude")(function* (
  paths: SkillsPaths,
  cli: AgentCli,
  cwd: string,
) {
  const path = yield* Path.Path;
  const appDirs = new Set([paths.appDirs.claude, yield* realPathOr(paths.appDirs.claude)]);
  const discovered = yield* discoverClaudeSkills({ homePath: cli.configDir }, cwd, cli.env);
  const skills: Array<UnmanagedSkill> = [];
  for (const skill of discovered) {
    const scope: SkillScope = skill.scope === "project" ? "project" : "user";
    const dir = path.dirname(skill.path);
    skills.push({
      app: "claude",
      name: skill.name,
      description: skill.description,
      scope,
      dir,
      enabled: skill.enabled,
      inAppDir: scope === "user" && appDirs.has(path.dirname(dir)) && !(yield* isSymlink(dir)),
    });
  }
  // T3's discovery rejects frontmatter Claude Code itself accepts (e.g. an
  // unquoted ": " inside `description`; Claude 2.1.282 still loads and counts
  // those skills in /context), so every folder with a SKILL.md is listed.
  const loaded = new Set(skills.map((skill) => skill.dir));
  const lenient = [
    ...(yield* scanFolder("claude", paths.appDirs.claude, "user", true, new Set(["synced"]))),
    ...(yield* scanFolder("claude", path.join(cwd, ".claude", "skills"), "project", false)),
  ].filter((skill) => !loaded.has(skill.dir));
  return [...skills, ...lenient, ...(yield* scanSynced("claude", paths.appDirs.claude))];
});

const PLUGIN_SKILL =
  /[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/][^\\/]+[\\/]skills[\\/]/;

const firstText = (...values: ReadonlyArray<string | null | undefined>) =>
  values.find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();

/** Both spellings of a folder, so a symlinked home still matches. */
export interface FolderAliases {
  readonly lexical: string;
  readonly real: string;
}

const isUnder = (path: Path.Path, child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * Maps Codex `skills/list` output to unmanaged entries. Codex reports skills
 * by the real path of their SKILL.md; plugin skills sit under
 * `plugins/cache/<marketplace>/<plugin>/<version>/skills/`.
 */
export const codexSkillsFromResponse = (
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
  appDir: FolderAliases,
  path: Path.Path,
): ReadonlyArray<UnmanagedSkill> => {
  const forCwd = response.data.filter((entry) => entry.cwd === cwd);
  const entries = forCwd.length > 0 ? forCwd : response.data;
  const seen = new Set<string>();
  const found: Array<UnmanagedSkill> = [];
  for (const skill of entries.flatMap((entry) => entry.skills)) {
    if (seen.has(skill.path)) continue;
    seen.add(skill.path);
    const dir = path.dirname(skill.path);
    const plugin = PLUGIN_SKILL.exec(skill.path);
    const pluginId = plugin ? `${plugin[2]}@${plugin[1]}` : undefined;
    const synced = [appDir.lexical, appDir.real].some((root) =>
      isUnder(path, dir, path.join(root, SYNCED_DIR)),
    );
    const scope: SkillScope =
      pluginId !== undefined
        ? "plugin"
        : skill.scope === "repo"
          ? "project"
          : skill.scope === "system" || skill.scope === "admin"
            ? "system"
            : synced
              ? "synced"
              : "user";
    const parent = path.dirname(dir);
    found.push({
      app: "codex",
      name: path.basename(dir),
      description: firstText(
        skill.description,
        skill.shortDescription,
        skill.interface?.shortDescription,
      ),
      scope,
      dir,
      enabled: skill.enabled,
      ...(pluginId !== undefined ? { pluginId } : {}),
      inAppDir: scope === "user" && (parent === appDir.lexical || parent === appDir.real),
    });
  }
  return found;
};

/**
 * Codex's skills from its app-server, or from a scan of its skills folder
 * (user skills plus `.system`) when Codex isn't available or the call fails.
 */
export const listCodexSkills = Effect.fn("skillsMcp.skills.listCodexSkills")(function* (
  paths: SkillsPaths,
  cli: AgentCli,
  cwd: string,
  available: boolean,
) {
  const path = yield* Path.Path;
  const appDir: FolderAliases = {
    lexical: paths.appDirs.codex,
    real: yield* realPathOr(paths.appDirs.codex),
  };
  let error: string | undefined;
  if (available) {
    const listed = yield* Effect.result(
      // Gated: a codex app-server rewrites config.toml at startup, so it must
      // not overlap an MCP config write (see mcp/probes.ts).
      gatedRead(
        "codex",
        withCodexClient(cli, cwd, (client) =>
          client.request("skills/list", { cwds: [cwd], forceReload: true }),
        ),
      ).pipe(
        Effect.timeoutOrElse({
          duration: CODEX_LIST_TIMEOUT,
          orElse: () =>
            Effect.fail(new ExtensionFailure({ message: "Codex skills/list timed out" })),
        }),
      ),
    );
    if (Result.isSuccess(listed)) {
      return { skills: codexSkillsFromResponse(listed.success, cwd, appDir, path), error };
    }
    error = listed.failure.message;
  }
  const skills = [
    ...(yield* scanFolder("codex", paths.appDirs.codex, "user", true, new Set([SYNCED_DIR]))),
    ...(yield* scanFolder("codex", path.join(paths.appDirs.codex, ".system"), "system", false)),
  ];
  return { skills, error };
});

/**
 * Drops entries that are the store's own deployments: folders inside the
 * store (Codex reports symlinks by their target) and the link or copy at a
 * managed skill's app path.
 */
export const withoutDeployments = Effect.fn("skillsMcp.skills.withoutDeployments")(function* (
  paths: SkillsPaths,
  unmanaged: ReadonlyArray<UnmanagedSkill>,
  managed: ReadonlyArray<ManagedState>,
) {
  const path = yield* Path.Path;
  const storeRoots = [paths.storeDir, yield* realPathOr(paths.storeDir)];
  const deployed = new Set<string>();
  for (const entry of managed) {
    for (const state of [entry.states.claude, entry.states.codex]) {
      if (state.kind !== "symlink" && state.kind !== "copy") continue;
      deployed.add(state.path);
      deployed.add(
        yield* realPathOr(path.dirname(state.path)).pipe(
          Effect.map((parent) => path.join(parent, path.basename(state.path))),
        ),
      );
    }
  }
  const kept: Array<UnmanagedSkill> = [];
  for (const skill of unmanaged) {
    const real = yield* realPathOr(skill.dir);
    const candidates = [skill.dir, real];
    if (candidates.some((dir) => storeRoots.some((root) => isUnder(path, dir, root)))) continue;
    if (candidates.some((dir) => deployed.has(dir))) continue;
    kept.push(skill);
  }
  return kept;
});

const SCOPE_RANK: Record<SkillScope, number> = {
  user: 0,
  synced: 1,
  project: 2,
  system: 3,
  plugin: 4,
};

/** The entry an app actually uses for a name: user over synced over project, app folder first. */
const best = (skills: ReadonlyArray<UnmanagedSkill>) =>
  [...skills].sort(
    (left, right) =>
      SCOPE_RANK[left.scope] - SCOPE_RANK[right.scope] ||
      Number(right.inAppDir) - Number(left.inAppDir),
  )[0];

const unmanagedEntry = (skill: UnmanagedSkill): SkillAppEntry => ({
  present: true,
  enabled: skill.enabled,
  scope: skill.scope,
  path: skill.dir,
  mode: "native",
  editable: false,
  adoptable: skill.inAppDir,
});

const managedEntry = (
  state: DeploymentState,
  unmanaged: UnmanagedSkill | undefined,
): SkillAppEntry => {
  switch (state.kind) {
    case "symlink":
    case "copy":
      return {
        present: true,
        enabled: true,
        scope: "user",
        path: state.path,
        mode: state.kind,
        editable: true,
      };
    case "foreign":
      // The name is already managed, so `adopt` would refuse this folder.
      return unmanaged !== undefined
        ? { ...unmanagedEntry(unmanaged), adoptable: false }
        : {
            present: true,
            enabled: true,
            scope: "user",
            path: state.path,
            mode: "native",
            editable: false,
          };
    case "none":
      return { present: false, enabled: false, scope: "user", editable: true };
  }
};

const rowKey = (skill: UnmanagedSkill) =>
  skill.pluginId !== undefined ? `plugin:${skill.pluginId}:${skill.name}` : skill.name;

/**
 * One row per managed skill (keyed by id) and one per unmanaged name (keyed by
 * name, or by plugin and name). Only user-scope folders sharing a managed
 * skill's name fold into its row; project, synced and system skills of that
 * name keep a row of their own, so an active project skill stays visible.
 */
export const buildRows = (
  managed: ReadonlyArray<ManagedState>,
  unmanaged: ReadonlyArray<UnmanagedSkill>,
): ReadonlyArray<SkillRow> => {
  const byKey = new Map<string, Array<UnmanagedSkill>>();
  for (const skill of unmanaged) {
    const key = rowKey(skill);
    byKey.set(key, [...(byKey.get(key) ?? []), skill]);
  }
  const forApp = (skills: ReadonlyArray<UnmanagedSkill>, app: AgentApp) =>
    best(skills.filter((skill) => skill.app === app));

  const rows: Array<SkillRow> = [];
  for (const { skill, states } of managed) {
    const named = byKey.get(skill.name) ?? [];
    const same = named.filter((entry) => entry.scope === "user");
    const rest = named.filter((entry) => entry.scope !== "user");
    if (rest.length > 0) byKey.set(skill.name, rest);
    else byKey.delete(skill.name);
    const description = skill.description ?? same.find((entry) => entry.description)?.description;
    rows.push({
      key: skill.id,
      id: skill.id,
      name: skill.name,
      ...(description !== undefined ? { description } : {}),
      managed: true,
      source: skill.source,
      installedAt: skill.installedAt,
      ...(skill.updateAvailable !== undefined ? { updateAvailable: skill.updateAvailable } : {}),
      apps: {
        claude: managedEntry(states.claude, forApp(same, "claude")),
        codex: managedEntry(states.codex, forApp(same, "codex")),
      },
    });
  }
  for (const [key, skills] of byKey) {
    const claude = forApp(skills, "claude");
    const codex = forApp(skills, "codex");
    const first = skills[0];
    if (first === undefined) continue;
    const description = [claude, codex, ...skills].find((entry) => entry?.description)?.description;
    rows.push({
      key,
      name: first.name,
      ...(description !== undefined ? { description } : {}),
      managed: false,
      ...(first.pluginId !== undefined ? { pluginId: first.pluginId } : {}),
      apps: {
        ...(claude !== undefined ? { claude: unmanagedEntry(claude) } : {}),
        ...(codex !== undefined ? { codex: unmanagedEntry(codex) } : {}),
      },
    });
  }
  return rows.sort(
    (left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key),
  );
};
