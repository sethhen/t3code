/**
 * `runAgentCli` failure messages against a fake CLI script in a temp dir. They
 * must name the command without the rest of argv, which can carry secrets.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { type AgentCli, runAgentCli } from "./agents.ts";

const SECRET = "sk-live-do-not-leak";
const ADD_JSON = ["mcp", "add-json", "github", JSON.stringify({ env: { TOKEN: SECRET } })];

const fakeClaude = (binaryPath: string): AgentCli => ({
  app: "claude",
  binaryPath,
  env: process.env,
  configDir: "/nonexistent",
});

const failureOf = (cli: AgentCli, timeout: Duration.Input = "5 seconds") =>
  runAgentCli(cli, [...ADD_JSON, "-s", "user"], { timeout }).pipe(
    Effect.flip,
    Effect.map((failure) => failure.message),
  );

// The real clock drives the CLI timeout.
it.layer(NodeServices.layer, { excludeTestServices: true })("runAgentCli", (it) => {
  it.effect("keeps argv out of a timeout message", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-cli-" });
      const script = path.join(dir, "claude");
      yield* fs.writeFileString(script, "#!/bin/sh\nsleep 10\n");
      yield* fs.chmod(script, 0o755);

      const message = yield* failureOf(fakeClaude(script), "200 millis");
      assert.strictEqual(message, "`claude mcp add-json github` timed out");
    }),
  );

  it.effect("keeps argv out of a spawn failure message", () =>
    Effect.gen(function* () {
      const message = yield* failureOf(fakeClaude("/nonexistent/t3-fake-claude"));
      assert.strictEqual(
        message,
        "Could not run `claude mcp add-json github`: /nonexistent/t3-fake-claude was not found",
      );
    }),
  );
});
