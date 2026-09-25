/**
 * Skills: managed skills in the store (deployed into Claude's and Codex's
 * skills folders) side by side with the skills each app finds on its own.
 */
import * as NodeOS from "node:os";

import type {
  AgentAppInfo,
  DiscoverableSkill,
  MutationResult,
  SkillRepo,
  SkillSearchResult,
  SkillsMutation,
  SkillsOverview,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import type { SkillsMcpServices } from "../index.ts";
import { agentAppInfo } from "../shared/agents.ts";
import { ExtensionFailure } from "../shared/t3.ts";
import { failWith, findSkillDirs, readSkillInfo } from "./archive.ts";
import { deploymentState, listBackups } from "./deploy.ts";
import { mutate } from "./mutate.ts";
import { searchSkillsSh, withRepoCheckout } from "./remote.ts";
import {
  type ManagedState,
  buildRows,
  listCodexSkills,
  scanClaude,
  withoutDeployments,
} from "./scan.ts";
import { resolveSkillsPaths, skillsDocument } from "./store.ts";

const withError = (info: AgentAppInfo, error: string | undefined): AgentAppInfo =>
  error === undefined || info.error !== undefined ? info : { ...info, error };

const listSkillsEffect = Effect.fn("skillsMcp.skills.list")(
  function* (input: { readonly cwd?: string | undefined }) {
    const cwd = input.cwd?.trim() || NodeOS.homedir();
    const { paths, clis } = yield* resolveSkillsPaths;
    const [claudeInfo, codexInfo] = yield* Effect.all(
      [agentAppInfo(clis.claude), agentAppInfo(clis.codex)],
      { concurrency: "unbounded" },
    );
    const [claudeSkills, codex, doc, backups] = yield* Effect.all(
      [
        scanClaude(paths, clis.claude, cwd),
        listCodexSkills(paths, clis.codex, cwd, codexInfo.available),
        skillsDocument.read,
        listBackups(paths),
      ],
      { concurrency: "unbounded" },
    );
    const managed: Array<ManagedState> = [];
    for (const skill of doc.skills) {
      managed.push({
        skill,
        states: {
          claude: yield* deploymentState(paths, "claude", skill),
          codex: yield* deploymentState(paths, "codex", skill),
        },
      });
    }
    const unmanaged = yield* withoutDeployments(paths, [...claudeSkills, ...codex.skills], managed);
    return {
      apps: [claudeInfo, withError(codexInfo, codex.error)],
      storageDir: paths.storeDir,
      appDirs: paths.appDirs,
      skills: buildRows(managed, unmanaged),
      backups: backups.map((entry) => entry.backup),
      repos: doc.repos,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies SkillsOverview;
  },
  (effect) => Effect.mapError(effect, failWith("Could not list skills")),
);

const discoverSkillsEffect = Effect.fn("skillsMcp.skills.discover")(
  function* (input: { readonly repo?: SkillRepo | undefined }) {
    const path = yield* Path.Path;
    const { paths } = yield* resolveSkillsPaths;
    const doc = yield* skillsDocument.read;
    const repos = input.repo !== undefined ? [input.repo] : doc.repos;
    const found: Array<DiscoverableSkill> = [];
    const errors: Array<string> = [];
    for (const repo of repos) {
      const listed = yield* Effect.result(
        withRepoCheckout(paths, repo, ({ root, branch }) =>
          Effect.gen(function* () {
            const skills: Array<DiscoverableSkill> = [];
            for (const rel of yield* findSkillDirs(root)) {
              const info = yield* readSkillInfo(
                rel === "" ? root : path.join(root, ...rel.split("/")),
              );
              const name = rel.split("/").at(-1) || repo.repo;
              const installed = doc.skills.some((skill) =>
                skill.source.type === "github"
                  ? skill.source.owner.toLowerCase() === repo.owner.toLowerCase() &&
                    skill.source.repo.toLowerCase() === repo.repo.toLowerCase() &&
                    (skill.source.path ?? "") === rel
                  : skill.name.toLowerCase() === name.toLowerCase(),
              );
              skills.push({
                owner: repo.owner,
                repo: repo.repo,
                branch,
                path: rel,
                name,
                ...(info.description !== undefined ? { description: info.description } : {}),
                installed,
              });
            }
            return skills;
          }),
        ),
      );
      if (Result.isSuccess(listed)) found.push(...listed.success);
      else errors.push(listed.failure.message);
    }
    if (repos.length > 0 && errors.length === repos.length) {
      return yield* new ExtensionFailure({ message: errors.join("; ") });
    }
    return found;
  },
  (effect) => Effect.mapError(effect, failWith("Could not discover skills")),
);

export const listSkills = (input: {
  readonly cwd?: string | undefined;
}): Effect.Effect<SkillsOverview, ExtensionFailure, SkillsMcpServices> => listSkillsEffect(input);

export const searchSkills = (input: {
  readonly query: string;
  readonly limit?: number | undefined;
}): Effect.Effect<ReadonlyArray<SkillSearchResult>, ExtensionFailure, SkillsMcpServices> =>
  searchSkillsSh(input.query, input.limit);

export const discoverSkills = (input: {
  readonly repo?: SkillRepo | undefined;
}): Effect.Effect<ReadonlyArray<DiscoverableSkill>, ExtensionFailure, SkillsMcpServices> =>
  discoverSkillsEffect(input);

export const mutateSkills = (
  input: SkillsMutation,
): Effect.Effect<MutationResult, ExtensionFailure, SkillsMcpServices> => mutate(input);
