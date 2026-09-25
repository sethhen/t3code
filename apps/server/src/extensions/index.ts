/**
 * Fork extensions registered with the server extension host. Add one line per
 * extension; nothing upstream needs to change.
 */
import * as Effect from "effect/Effect";

import type { ServerExtension } from "./registry.ts";

export const makeServerExtensions: Effect.Effect<ReadonlyArray<ServerExtension>> = Effect.succeed(
  [],
);
