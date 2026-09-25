import type { MutationResult, PluginsMutation, PluginsOverview } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ExtensionFailure } from "../shared/t3.ts";

// Stubs: replaced by the plugins implementation.
export const listPlugins = (_input: {
  readonly cwd?: string | undefined;
  readonly includeAvailable?: boolean | undefined;
}) =>
  Effect.fail(
    new ExtensionFailure({ message: "plugins.list is not implemented yet" }),
  ) as Effect.Effect<PluginsOverview, ExtensionFailure>;
export const mutatePlugins = (_input: PluginsMutation) =>
  Effect.fail(
    new ExtensionFailure({ message: "plugins.mutate is not implemented yet" }),
  ) as Effect.Effect<MutationResult, ExtensionFailure>;
