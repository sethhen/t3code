import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { AgentCli } from "./agents.ts";
import {
  deniedServerNames,
  skillsOff,
  updateClaudeUserSettings,
  withDeniedServer,
  withSkillOff,
} from "./claudeUserSettings.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

describe("deniedMcpServers", () => {
  it("adds and removes a name, leaving command and URL entries alone", () => {
    const base = { model: "opus", deniedMcpServers: [{ serverUrl: "https://x/*" }] };
    const denied = withDeniedServer(base, "claude.ai Gmail", true);
    assert.deepStrictEqual([...deniedServerNames(denied)], ["claude.ai Gmail"]);
    assert.strictEqual(withDeniedServer(denied, "claude.ai Gmail", true), denied);
    assert.deepStrictEqual(withDeniedServer(denied, "claude.ai Gmail", false), base);
    assert.deepStrictEqual(
      withDeniedServer({ deniedMcpServers: [{ serverName: "a" }] }, "a", false),
      {},
    );
  });
});

describe("skillOverrides", () => {
  it("switches a skill off and back on by dropping its override", () => {
    const off = withSkillOff({ skillOverrides: { other: "name-only" } }, "pdf", true);
    assert.deepStrictEqual([...skillsOff(off)], ["pdf"]);
    assert.deepStrictEqual(withSkillOff(off, "pdf", false), {
      skillOverrides: { other: "name-only" },
    });
    assert.deepStrictEqual(withSkillOff({ skillOverrides: { pdf: "off" } }, "pdf", false), {});
  });
});

describe("updateClaudeUserSettings", () => {
  const withConfigDir = <A, E, R>(use: (cli: AgentCli, file: string) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-settings-" });
      const cli: AgentCli = { app: "claude", binaryPath: "claude", env: {}, configDir };
      return yield* use(cli, path.join(configDir, "settings.json"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  it.effect("keeps every other key", () =>
    withConfigDir((cli, file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(file, '{"env":{"FOO":"1"},"model":"opus"}');
        yield* updateClaudeUserSettings(cli, (settings) => withSkillOff(settings, "pdf", true));
        const written = yield* decodeJson(yield* fs.readFileString(file));
        assert.deepStrictEqual(written, {
          env: { FOO: "1" },
          model: "opus",
          skillOverrides: { pdf: "off" },
        });
      }),
    ),
  );

  it.effect("refuses to replace a file that is not valid JSON", () =>
    withConfigDir((cli, file) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(file, "{ oops");
        const result = yield* Effect.result(
          updateClaudeUserSettings(cli, (settings) => withSkillOff(settings, "pdf", true)),
        );
        assert.isTrue(result._tag === "Failure");
        assert.strictEqual(yield* fs.readFileString(file), "{ oops");
      }),
    ),
  );
});
