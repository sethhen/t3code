/**
 * Switches a skill the store does not manage with the app's own setting, so
 * any skill an app loads can be turned off without moving its folder: Claude's
 * `skillOverrides` (Claude keys skills by folder name, and ignores it for
 * plugin skills) and Codex's `skills/config/write` (by the skill's SKILL.md).
 */
import * as NodeOS from "node:os";

import type { MutationResult, SkillsMutation } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import type { SkillsMcpServices } from "../index.ts";
import { withAgentWrite } from "../mcp/probes.ts";
import { type AgentCli, agentAppInfo, withCodexClient } from "../shared/agents.ts";
import { updateClaudeUserSettings, withSkillOff } from "../shared/claudeUserSettings.ts";
import { ExtensionFailure } from "../shared/t3.ts";

type Input = Extract<SkillsMutation, { readonly action: "setAppEnabled" }>;

const APP_LABEL = { claude: "Claude", codex: "Codex" } as const;
const CODEX_WRITE_TIMEOUT = Duration.seconds(20);

const writeCodex = (cli: AgentCli, input: Input) =>
  Effect.gen(function* () {
    if (input.path === undefined) {
      return yield* new ExtensionFailure({ message: `Codex needs ${input.name}'s folder` });
    }
    const path = yield* Path.Path;
    const skillFile = path.join(input.path, "SKILL.md");
    const response = yield* withCodexClient(cli, NodeOS.homedir(), (client) =>
      client.request("skills/config/write", { path: skillFile, enabled: input.enabled }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: CODEX_WRITE_TIMEOUT,
        orElse: () =>
          Effect.fail(new ExtensionFailure({ message: "Codex skills/config/write timed out" })),
      }),
    );
    if (response.effectiveEnabled !== input.enabled) {
      return yield* new ExtensionFailure({
        message: `${input.name} stays ${response.effectiveEnabled ? "on" : "off"}: another Codex config sets it`,
      });
    }
  });

export const setAppEnabled = Effect.fn("skillsMcp.skills.setAppEnabled")(function* (
  clis: { readonly claude: AgentCli; readonly codex: AgentCli },
  input: Input,
) {
  const cli = clis[input.app];
  const info = yield* agentAppInfo(cli);
  if (!info.available) {
    return {
      failures: [{ app: input.app, message: `${APP_LABEL[input.app]} is unavailable` }],
    } satisfies MutationResult;
  }
  const write: Effect.Effect<void, ExtensionFailure, SkillsMcpServices> =
    input.app === "claude"
      ? updateClaudeUserSettings(cli, (settings) =>
          withSkillOff(settings, input.name, !input.enabled),
        )
      : writeCodex(cli, input);
  return yield* withAgentWrite([input.app], write).pipe(
    Effect.as<MutationResult>({
      failures: [],
      message: `${input.enabled ? "Enabled" : "Disabled"} ${input.name} in ${APP_LABEL[input.app]}`,
    }),
    Effect.catch((failure) =>
      Effect.succeed<MutationResult>({
        failures: [{ app: input.app, message: failure.message }],
      }),
    ),
  );
});
