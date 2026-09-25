/**
 * Skills & MCP server extension: wires the contract's methods to the mcp/,
 * skills/, and plugins/ modules. Handlers run with the services captured here
 * when the ws connection's handlers are built.
 */
import { SkillsMcpExtension } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { serverExtension } from "../registry.ts";
import { listMcp, mcpPresets, mutateMcp } from "./mcp/index.ts";
import { listPlugins, mutatePlugins } from "./plugins/index.ts";
import { ChildProcessSpawner, ServerConfig, ServerSettingsService } from "./shared/t3.ts";
import { discoverSkills, listSkills, mutateSkills, searchSkills } from "./skills/index.ts";

/** Everything the extension's handlers may require. */
export type SkillsMcpServices =
  | ServerConfig
  | ServerSettingsService
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path;

export const makeSkillsMcpServerExtension = Effect.gen(function* () {
  const context = yield* Effect.context<SkillsMcpServices>();
  const run = <A, E>(effect: Effect.Effect<A, E, SkillsMcpServices>) =>
    effect.pipe(Effect.provide(context));

  return serverExtension(SkillsMcpExtension, {
    "mcp.list": (input) => run(listMcp(input)),
    "mcp.mutate": (input) => run(mutateMcp(input)),
    "mcp.presets": () => run(mcpPresets()),
    "skills.list": (input) => run(listSkills(input)),
    "skills.search": (input) => run(searchSkills(input)),
    "skills.discover": (input) => run(discoverSkills(input)),
    "skills.mutate": (input) => run(mutateSkills(input)),
    "plugins.list": (input) => run(listPlugins(input)),
    "plugins.mutate": (input) => run(mutatePlugins(input)),
  });
});
