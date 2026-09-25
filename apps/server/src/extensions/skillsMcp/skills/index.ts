import type {
  DiscoverableSkill,
  MutationResult,
  SkillRepo,
  SkillSearchResult,
  SkillsMutation,
  SkillsOverview,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ExtensionFailure } from "../shared/t3.ts";

// Stubs: replaced by the skills implementation.
const notYet = (method: string) =>
  Effect.fail(new ExtensionFailure({ message: `${method} is not implemented yet` }));
export const listSkills = (_input: { readonly cwd?: string | undefined }) =>
  notYet("skills.list") as Effect.Effect<SkillsOverview, ExtensionFailure>;
export const searchSkills = (_input: {
  readonly query: string;
  readonly limit?: number | undefined;
}) => notYet("skills.search") as Effect.Effect<ReadonlyArray<SkillSearchResult>, ExtensionFailure>;
export const discoverSkills = (_input: { readonly repo?: SkillRepo | undefined }) =>
  notYet("skills.discover") as Effect.Effect<ReadonlyArray<DiscoverableSkill>, ExtensionFailure>;
export const mutateSkills = (_input: SkillsMutation) =>
  notYet("skills.mutate") as Effect.Effect<MutationResult, ExtensionFailure>;
