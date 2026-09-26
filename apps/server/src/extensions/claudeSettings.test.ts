import { parseCliArgs } from "@t3tools/shared/cliArgs";
import { assert, describe, it } from "@effect/vitest";

import { launchArgSettings, mergeClaudeSettings, withLaunchArgSettings } from "./claudeSettings.ts";

describe("launchArgSettings", () => {
  it("reads an inline JSON --settings", () => {
    assert.deepStrictEqual(launchArgSettings(`--chrome --settings '{"advisorModel":"opus"}'`), {
      advisorModel: "opus",
    });
  });

  it("ignores a settings file path, invalid JSON and non-objects", () => {
    assert.deepStrictEqual(launchArgSettings("--settings ~/my-settings.json"), {});
    assert.deepStrictEqual(launchArgSettings(`--settings '{nope'`), {});
    assert.deepStrictEqual(launchArgSettings(`--settings '[1]'`), {});
    assert.deepStrictEqual(launchArgSettings(""), {});
    assert.deepStrictEqual(launchArgSettings(undefined), {});
  });
});

describe("mergeClaudeSettings", () => {
  it("merges env one level deep; later keys win", () => {
    assert.deepStrictEqual(
      mergeClaudeSettings(
        { env: { A: "1", B: "1" }, model: "x" },
        { env: { B: "2", C: "2" }, advisorModel: "opus" },
      ),
      { env: { A: "1", B: "2", C: "2" }, model: "x", advisorModel: "opus" },
    );
  });
});

describe("withLaunchArgSettings", () => {
  it("appends a merged --settings that parseCliArgs reads back", () => {
    const args = withLaunchArgSettings(`--chrome --settings '{"env":{"A":"1"}}'`, {
      env: { B: "it's" },
    });
    const parsed = parseCliArgs(args);
    assert.strictEqual(parsed.flags.chrome, null);
    assert.deepStrictEqual(launchArgSettings(args), { env: { A: "1", B: "it's" } });
    assert.isTrue(args.startsWith(`--chrome --settings '{"env":{"A":"1"}}'`));
  });

  it("works with no launch arguments", () => {
    assert.deepStrictEqual(launchArgSettings(withLaunchArgSettings("", { x: 1 })), { x: 1 });
  });
});
