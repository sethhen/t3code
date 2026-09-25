import type { McpMutation, McpOverview, McpPreset, MutationResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ExtensionFailure } from "../shared/t3.ts";

// Stubs: replaced by the MCP implementation.
export const listMcp = (_input: {
  readonly cwd?: string | undefined;
  readonly refresh?: boolean | undefined;
}) =>
  Effect.fail(
    new ExtensionFailure({ message: "mcp.list is not implemented yet" }),
  ) as Effect.Effect<McpOverview, ExtensionFailure>;
export const mutateMcp = (_input: McpMutation) =>
  Effect.fail(
    new ExtensionFailure({ message: "mcp.mutate is not implemented yet" }),
  ) as Effect.Effect<MutationResult, ExtensionFailure>;
export const mcpPresets = () => Effect.succeed<ReadonlyArray<McpPreset>>([]);
