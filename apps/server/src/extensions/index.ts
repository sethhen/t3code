/**
 * Fork extensions registered with the server extension host. Add one line per
 * extension; nothing upstream needs to change.
 */
import * as Effect from "effect/Effect";

import { makeSkillsMcpServerExtension } from "./skillsMcp/index.ts";

export const makeServerExtensions = Effect.all([makeSkillsMcpServerExtension]);
