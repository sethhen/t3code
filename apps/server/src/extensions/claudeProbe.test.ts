import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { probeClaudeCapabilities } from "../provider/Layers/ClaudeProvider.ts";
import { DEFAULT_TIMEOUT_MS } from "../provider/providerSnapshot.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const settings = Schema.decodeSync(ClaudeSettings)({ binaryPath: "claude" });

it.effect("keeps a Claude usage read that takes longer than upstream's 4s", () =>
  Effect.gen(function* () {
    const usageStarted = yield* Deferred.make<void>();
    let answerUsage: (usage: ClaudeSdk.SDKControlGetUsageResponse) => void = () => {};
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
      () =>
        ({
          initializationResult: async () => ({
            account: { email: "dev@example.com", subscriptionType: "max", tokenSource: "oauth" },
            commands: [{ name: "review", description: "Review changes", argumentHint: "" }],
          }),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
            Deferred.doneUnsafe(usageStarted, Effect.void);
            return new Promise((resolve) => {
              answerUsage = resolve;
            });
          },
        }) as ReturnType<typeof ClaudeSdk.query>,
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const probe = yield* probeClaudeCapabilities(settings).pipe(Effect.forkChild);
    yield* Deferred.await(usageStarted);
    yield* TestClock.adjust(DEFAULT_TIMEOUT_MS);
    answerUsage({
      rate_limits_available: true,
      rate_limits: null,
    } as ClaudeSdk.SDKControlGetUsageResponse);
    const capabilities = yield* Fiber.join(probe);
    assert.equal(capabilities?.usage?.rate_limits_available, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
