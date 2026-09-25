/**
 * Codex `skills/list` against the real `codex` CLI, with HOME and CODEX_HOME
 * pointed at a throwaway folder. Checks the folders Codex reads and how
 * `codexSkillsFromResponse` scopes them. Opt in with `SKILLS_MCP_LIVE_TESTS=1`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { withCodexAppServerClient } from "../shared/t3.ts";
import { codexSkillsFromResponse } from "./scan.ts";

const LIVE = process.env.SKILLS_MCP_LIVE_TESTS === "1";
const TIMEOUT = 5 * 60_000;

const skillMd = (name: string) => `---\nname: ${name}\ndescription: Live ${name}\n---\nBody.\n`;

const writeSkill = Effect.fn("writeSkill")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(path.join(dir, "SKILL.md"), skillMd(path.basename(dir)));
});

describe.skipIf(!LIVE)("skills live (codex)", () => {
  it.layer(NodeServices.layer, { excludeTestServices: true })("codex skills/list", (it) => {
    it.effect(
      "reads CODEX_HOME/skills, ~/.agents/skills and <cwd>/.agents/skills",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-sk-" }));
          const home = path.join(root, "home");
          const codexHome = path.join(root, "codex-home");
          const cwd = path.join(root, "project");
          const appDir = path.join(codexHome, "skills");

          yield* writeSkill(path.join(appDir, "plain"));
          yield* writeSkill(path.join(appDir, "synced", "bucket", "synced-skill"));
          yield* writeSkill(path.join(root, "store", "linked"));
          yield* fs.symlink(path.join(root, "store", "linked"), path.join(appDir, "linked"));
          yield* writeSkill(path.join(home, ".agents", "skills", "agents-skill"));
          yield* writeSkill(path.join(cwd, ".agents", "skills", "proj"));
          yield* writeSkill(path.join(cwd, ".claude", "skills", "claude-proj"));

          const response = yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* withCodexAppServerClient({
                binaryPath: "codex",
                homePath: codexHome,
                cwd,
                environment: { HOME: home, CODEX_HOME: codexHome },
              });
              return yield* client.request("skills/list", { cwds: [cwd], forceReload: true });
            }),
          );
          const skills = codexSkillsFromResponse(
            response,
            cwd,
            { lexical: appDir, real: appDir },
            path,
          );
          const byName = new Map(skills.map((skill) => [skill.name, skill]));
          const summary = skills.map((skill) => `${skill.scope}:${skill.name} ${skill.dir}`).sort();
          yield* Effect.logInfo(`codex skills/list:\n${summary.join("\n")}`);

          assert.strictEqual(byName.get("plain")?.scope, "user");
          assert.isTrue(byName.get("plain")?.inAppDir);
          assert.strictEqual(byName.get("linked")?.dir, path.join(root, "store", "linked"));
          assert.strictEqual(byName.get("agents-skill")?.scope, "user");
          assert.isFalse(byName.get("agents-skill")?.inAppDir);
          assert.strictEqual(byName.get("proj")?.scope, "project");
          assert.isFalse(byName.has("claude-proj"));
          const synced = byName.get("synced-skill");
          if (synced !== undefined) assert.strictEqual(synced.scope, "synced");
          for (const skill of skills) {
            assert.isFalse(skill.dir.startsWith(`${process.env.HOME ?? "/nonexistent"}/`));
            if (skill.dir.includes(`${path.sep}.system${path.sep}`)) {
              assert.strictEqual(skill.scope, "system");
            }
          }
        }).pipe(Effect.scoped),
      TIMEOUT,
    );
  });
});
