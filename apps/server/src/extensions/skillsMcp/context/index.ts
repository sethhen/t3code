import type { ContextOverview, UsageReport } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ExtensionFailure } from "../shared/t3.ts";

// Stubs: replaced by the context/usage implementation.
export const getContext = (_input: {
  readonly cwd?: string | undefined;
  readonly refresh?: boolean | undefined;
}) =>
  Effect.fail(
    new ExtensionFailure({ message: "context.get is not implemented yet" }),
  ) as Effect.Effect<ContextOverview, ExtensionFailure>;
export const getUsage = (_input: {
  readonly days: number;
  readonly refresh?: boolean | undefined;
}) =>
  Effect.fail(
    new ExtensionFailure({ message: "usage.get is not implemented yet" }),
  ) as Effect.Effect<UsageReport, ExtensionFailure>;
