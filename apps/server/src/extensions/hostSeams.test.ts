// @effect-diagnostics nodeBuiltinImport:off - reads upstream source files to prove each host seam is still wired.
/**
 * The fork's host seams, checked after every upstream merge (scripts/fork/update.sh
 * runs the extension tests). An upstream refactor that moves or drops a seam
 * fails here by name instead of silently disabling a fork feature, e.g. a
 * Claude instance's `--settings` launch argument being dropped again, which
 * would look like it works.
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
    "runtime overlays on provider instances",
  ],
  [
    "apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts",
    "withOverlayReconciles(serverSettings.getSettings)",
    "overlay reconcile requests in the settings watcher (no settings.json write)",
  ],
  [
    "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    "...launchArgSettings(claudeSettings.launchArgs)",
    "flag --settings for Claude sessions (launch args)",
  ],
  [
    "apps/server/src/provider/Layers/ClaudeAdapter.ts",
    "describeClaudeRetryWait(message)",
    "work-log row while a Claude turn waits out a rate limit",
  ],
  [
    "apps/server/src/textGeneration/ClaudeTextGeneration.ts",
    "...launchArgSettings(claudeSettings.launchArgs)",
    "flag --settings for Claude text generation",
  ],
  [
    "apps/server/src/server.ts",
    "Layer.provideMerge(ForkServicesLive)",
    "server-lifetime fork services (the pool's retirement)",
  ],
  [
    "apps/web/src/components/settings/ProviderSettingsPanel.tsx",
    "<ProviderSettingsExtensions",
    "fork sections at the top of Settings → Providers",
  ],
  [
    "apps/web/src/components/settings/ProviderSettingsPanel.tsx",
    // The prop's other lines in this file are upstream's own; the marker makes this one unique.
    "targetInstanceId={targetInstanceId} // t3-ext",
    "upstream provider list unfolded for a linked instance",
  ],
  [
    "apps/web/src/components/ChatView.tsx",
    "useForkComposerBannerItems(composerBannerItems",
    "Continue on… next to a usage-limit stop",
  ],
  [
    "apps/web/src/components/ChatView.tsx",
    "bannerItems={bannerItemsWithFork}",
    "composer notices with Continue on… added",
  ],
  [
    "apps/server/src/provider/Layers/CodexProvider.ts",
    "codexHasNoSubscriptionUsage(accountResponse)",
    "no usage read for a Codex without ChatGPT (API key, custom model_provider)",
  ],
  [
    "apps/server/src/provider/Layers/CodexProvider.ts",
    "codexHasNoSubscriptionUsage(snapshot.account)",
    "unsupported (not failed) usage for a Codex without ChatGPT",
  ],
  [
    "apps/server/src/provider/Layers/ProviderService.ts",
    "resumesPersisted = true",
    "persisted resume cursor for an instance with the same continuation key",
  ],
  [
    "apps/server/src/provider/Drivers/ClaudeDriver.ts",
    "claudeSharedHistoryKey(",
    "shared continuation key for Claude accounts on one conversation store",
  ],
  [
    "apps/server/src/provider/Drivers/ClaudeDriver.ts",
    "consumeResetCredit: () =>",
    "no Claude reset claim with its OAuth token",
  ],
  [
    "apps/server/src/provider/Layers/ClaudeProvider.ts",
    "Effect.timeout(CLAUDE_USAGE_TIMEOUT_MS)",
    "longer deadline for Claude Code's usage read",
  ],
  [
    "apps/web/src/components/AgentsPanel.tsx",
    "agentElapsedClock(agent)",
    "elapsed for live agents, pending workflow members included",
  ],
  [
    "apps/web/src/components/AgentsPanel.tsx",
    "{group.workflow.startedAt ? (",
    "elapsed on a running workflow's header",
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

  // Upstream reads and claims Claude's resets with its OAuth token (claudeResetCredits.ts); a
  // merge that brings any of that back into the server outside that file fails here.
  it("apps/server/src keeps Claude's OAuth token in claudeResetCredits.ts alone", () => {
    const token =
      /claudeResetCredits|readClaudeResetCredits|consumeClaudeResetCredit|claudeAiOauth|\.credentials\.json/;
    const reaching = NodeFS.readdirSync(NodePath.join(repo, "apps/server/src"), { recursive: true })
      .map((file) => `apps/server/src/${String(file).split(NodePath.sep).join("/")}`)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => file !== "apps/server/src/provider/Layers/claudeResetCredits.ts")
      .filter((file) => token.test(source(file)));
    assert.deepEqual(
      reaching,
      [],
      "these reach for Claude's OAuth token again; re-apply the host edits (FORK.md)",
    );
  });

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
