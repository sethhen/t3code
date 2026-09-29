// @effect-diagnostics nodeBuiltinImport:off - reads upstream source files to prove each host seam is still wired.
/**
 * The fork's host seams, checked after every upstream merge (scripts/fork/update.sh
 * runs the extension tests). An upstream refactor that moves or drops a seam
 * fails here by name instead of silently disabling a fork feature, e.g. the
 * pool no longer routing Claude, which would look like it works and cost
 * every thread its tool search.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { DEFAULT_SERVER_SETTINGS, type ProviderInstanceConfigMap } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { registerInstanceOverlay } from "./instanceOverlays.ts";

const repo = NodePath.resolve(import.meta.dirname, "../../../..");
const source = (path: string) => NodeFS.readFileSync(NodePath.join(repo, path), "utf8");

/** Upstream file → the expression each seam must still contain (all tagged `t3-ext`). */
const SEAMS: ReadonlyArray<readonly [file: string, needle: string, why: string]> = [
  [
    "apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts",
    "applyForkInstanceOverlays(",
    "runtime overlays (pool routing) on provider instances",
  ],
  [
    "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    "...launchArgSettings(claudeSettings.launchArgs)",
    "flag --settings for Claude sessions (pool env + advisor)",
  ],
  [
    "apps/server/src/textGeneration/ClaudeTextGeneration.ts",
    "...launchArgSettings(claudeSettings.launchArgs)",
    "flag --settings for Claude text generation",
  ],
  [
    "apps/server/src/server.ts",
    "Layer.provideMerge(ForkServicesLive)",
    "server-lifetime fork services (the pool proxy)",
  ],
  [
    "apps/web/src/components/settings/ProviderSettingsPanel.tsx",
    "<ProviderSettingsExtensions",
    "fork sections at the top of Settings → Providers",
  ],
  [
    "apps/server/src/provider/Layers/CodexProvider.ts",
    "codexHasNoSubscriptionUsage(accountResponse)",
    "no usage read for a pooled Codex (custom model_provider)",
  ],
  [
    "apps/server/src/provider/Layers/CodexProvider.ts",
    "codexHasNoSubscriptionUsage(snapshot.account)",
    "unsupported (not failed) usage for a pooled Codex",
  ],
];

describe("fork host seams", () => {
  for (const [file, needle, why] of SEAMS) {
    it(`${file} keeps the ${why} seam`, () => {
      const text = source(file);
      const line = text.split("\n").find((candidate) => candidate.includes(needle));
      assert.isDefined(line, `${needle} is gone from ${file}; re-apply the host edit (FORK.md)`);
      // The marker may trail the line or sit just above it (a JSX comment).
      const at = text.indexOf(needle);
      assert.include(
        text.slice(Math.max(0, at - 120), at + needle.length + 200),
        "t3-ext",
        `the ${needle} line in ${file} lost its t3-ext marker`,
      );
    });
  }

  it("deriveProviderInstanceConfigMap applies registered overlays", () => {
    const remove = registerInstanceOverlay("seam-test", (map) => {
      const next: Record<string, unknown> = {};
      for (const [id, instance] of Object.entries(map)) {
        next[id] = { ...instance, displayName: `overlaid ${id}` };
      }
      return next as ProviderInstanceConfigMap;
    });
    try {
      const map = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
      const names = Object.values(map).map((instance) => instance.displayName);
      assert.isAbove(names.length, 0);
      for (const name of names) assert.match(name ?? "", /^overlaid /);
    } finally {
      remove();
    }
    const plain = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
    for (const instance of Object.values(plain)) {
      assert.notMatch(instance.displayName ?? "", /^overlaid /);
    }
  });
});
