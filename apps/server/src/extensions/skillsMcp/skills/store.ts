/**
 * The managed-skills store: `skills.json` plus one folder per skill in
 * `<stateDir>/skills-mcp/skills/<name>/`, deployed into each app's skills
 * folder by symlink (or a copy where symlinks fail).
 *
 * Ported from CC Switch's skill service ("store once, deploy to each app"):
 * https://github.com/farion1231/cc-switch `src-tauri/src/services/skill.rs`,
 * MIT License, Copyright (c) 2025 Jason Young.
 *
 * Where the apps read user skills from:
 * - Claude Code: `<CLAUDE_CONFIG_DIR or ~/.claude>/skills/<name>/SKILL.md`.
 * - Codex (verified with codex-cli 0.157.0 `skills/list` in temp homes):
 *   user scope is `$CODEX_HOME/skills` plus `$HOME/.agents/skills`; without
 *   CODEX_HOME it is `~/.codex/skills` plus `~/.agents/skills`, and with
 *   CODEX_HOME set `~/.codex/skills` is not read. Repo scope is
 *   `<cwd>/.agents/skills` and `<cwd>/.codex/skills` (not `.claude/skills`),
 *   and bundled skills live in `$CODEX_HOME/skills/.system`. Symlinked skill
 *   folders are followed and reported by their real path. So the store
 *   deploys Codex skills into `<CODEX_HOME>/skills`, the one folder Codex
 *   reads in every configuration.
 */
import {
  AgentAppFlags,
  type AgentApp,
  type SkillRepo as SkillRepoType,
  SkillRepo,
  SkillSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveAgentClis } from "../shared/agents.ts";
import { extensionDataDir, makeJsonDocument } from "../shared/jsonDocument.ts";

export const ManagedSkill = Schema.Struct({
  id: Schema.String,
  /** Folder name in the store and in every app folder. */
  name: Schema.String,
  description: Schema.optional(Schema.String),
  source: SkillSource,
  installedAt: Schema.String,
  /** `hashDirectory` of the store folder; compared against the source by `checkUpdates`. */
  hash: Schema.String,
  /** Which apps the skill is deployed to. */
  apps: AgentAppFlags,
  updateAvailable: Schema.optional(Schema.Boolean),
});
export type ManagedSkill = typeof ManagedSkill.Type;

export const SkillsDocument = Schema.Struct({
  skills: Schema.Array(ManagedSkill),
  repos: Schema.Array(SkillRepo),
});
export type SkillsDocument = typeof SkillsDocument.Type;

/** CC Switch's default discovery repos. */
export const DEFAULT_REPOS: ReadonlyArray<SkillRepoType> = [
  { owner: "anthropics", repo: "skills", branch: "main" },
  { owner: "ComposioHQ", repo: "awesome-claude-skills", branch: "master" },
  { owner: "cexll", repo: "myclaude", branch: "master" },
  { owner: "JimLiu", repo: "baoyu-skills", branch: "main" },
];

export const skillsDocument = makeJsonDocument("skills.json", SkillsDocument, () => ({
  skills: [],
  repos: DEFAULT_REPOS,
}));

/** Every folder the skills module reads or writes. */
export interface SkillsPaths {
  /** `<extensionDataDir>/skills`: one folder per managed skill. */
  readonly storeDir: string;
  /** `<extensionDataDir>/skill-backups`. */
  readonly backupDir: string;
  /** `<extensionDataDir>/skills-tmp`: downloads and staging, on the store's filesystem. */
  readonly tmpDir: string;
  /** Each app's user skills folder. */
  readonly appDirs: { readonly [K in AgentApp]: string };
}

/** Resolves the store and app folders for the configured Claude and Codex homes. */
export const resolveSkillsPaths = Effect.gen(function* () {
  const path = yield* Path.Path;
  const dataDir = yield* extensionDataDir;
  const clis = yield* resolveAgentClis;
  const paths: SkillsPaths = {
    storeDir: path.join(dataDir, "skills"),
    backupDir: path.join(dataDir, "skill-backups"),
    tmpDir: path.join(dataDir, "skills-tmp"),
    appDirs: {
      claude: path.join(clis.claude.configDir, "skills"),
      codex: path.join(clis.codex.configDir, "skills"),
    },
  };
  return { paths, clis, dataDir } as const;
});
