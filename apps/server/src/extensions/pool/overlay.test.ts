import type { ProviderInstanceConfig, ProviderInstanceConfigMap } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { assert, describe, it } from "@effect/vitest";

import { launchArgSettings } from "../claudeSettings.ts";
import {
  CODEX_KEY_ENV,
  codexPoolArgs,
  describeRoutes,
  poolOverlay,
  routeInstance,
  type PoolRoutingContext,
} from "./overlay.ts";
import { defaultRouteMode } from "./state.ts";

const endpoint = { baseUrl: "http://127.0.0.1:18417", key: "client-key" };
const context = (over: Partial<PoolRoutingContext> = {}): PoolRoutingContext => ({
  claude: endpoint,
  codex: endpoint,
  modeFor: defaultRouteMode,
  ...over,
});

const claude = (
  config: Record<string, unknown> = {},
  extra: Partial<ProviderInstanceConfig> = {},
) => ({ driver: "claudeAgent", config, ...extra }) as unknown as ProviderInstanceConfig;
const codex = (config: Record<string, unknown> = {}) =>
  ({ driver: "codex", config }) as unknown as ProviderInstanceConfig;

const envOf = (instance: ProviderInstanceConfig) =>
  Object.fromEntries((instance.environment ?? []).map((entry) => [entry.name, entry]));
const launchArgs = (instance: ProviderInstanceConfig) =>
  (instance.config as { launchArgs?: string }).launchArgs ?? "";

describe("routeInstance: Claude", () => {
  it("adds the parity env to the process env AND to flag --settings.env", () => {
    const routed = routeInstance("claudeAgent", claude({ launchArgs: "--chrome" }), context());
    const env = envOf(routed);
    assert.strictEqual(env.ANTHROPIC_BASE_URL?.value, endpoint.baseUrl);
    assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN?.value, endpoint.key);
    assert.isTrue(env.ANTHROPIC_AUTH_TOKEN?.sensitive);
    assert.strictEqual(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL?.value, "1");
    assert.strictEqual(env.ENABLE_TOOL_SEARCH?.value, "true");
    assert.strictEqual(env.CLAUDE_CODE_PROMPT_CACHE_TTL?.value, "1h");

    // Flag settings outrank ~/.claude/settings.json's env block.
    const settings = launchArgSettings(launchArgs(routed)) as {
      env: Record<string, string>;
      advisorModel: string;
    };
    assert.strictEqual(settings.advisorModel, "opus");
    assert.strictEqual(settings.env.ANTHROPIC_BASE_URL, endpoint.baseUrl);
    assert.strictEqual(settings.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, "1");
    assert.isTrue(launchArgs(routed).startsWith("--chrome "));
  });

  it("replaces a user env entry of the same name instead of duplicating it", () => {
    const routed = routeInstance(
      "claudeAgent",
      claude(
        {},
        { environment: [{ name: "ANTHROPIC_BASE_URL", value: "http://old", sensitive: false }] },
      ),
      context(),
    );
    const names = (routed.environment ?? []).map((entry) => entry.name);
    assert.strictEqual(names.filter((name) => name === "ANTHROPIC_BASE_URL").length, 1);
    assert.strictEqual(envOf(routed).ANTHROPIC_BASE_URL?.value, endpoint.baseUrl);
  });

  it("leaves direct, disabled and unserved instances alone", () => {
    const instance = claude({ launchArgs: "--x" });
    assert.strictEqual(
      routeInstance("claudeAgent", instance, context({ modeFor: () => "direct" })),
      instance,
    );
    assert.strictEqual(
      routeInstance("claudeAgent", instance, context({ claude: undefined })),
      instance,
    );
    const disabled = claude({}, { enabled: false });
    assert.strictEqual(routeInstance("claudeAgent", disabled, context()), disabled);
    // Extra instances default to direct.
    assert.strictEqual(routeInstance("claudeAgent_work", instance, context()), instance);
  });
});

describe("routeInstance: Codex", () => {
  it("appends -c overrides after the user's own and puts the key in the env", () => {
    const routed = routeInstance("codex", codex({ launchArgs: "-c 'model=\"gpt-6\"'" }), context());
    const tokens = tokenizeCliArgs(launchArgs(routed));
    assert.deepStrictEqual(tokens.slice(0, 2), ["-c", 'model="gpt-6"']);
    assert.includeMembers(
      [...tokens],
      [
        'model_provider="t3-pool"',
        'model_providers.t3-pool.base_url="http://127.0.0.1:18417/v1"',
        'model_providers.t3-pool.wire_api="responses"',
        `model_providers.t3-pool.env_key="${CODEX_KEY_ENV}"`,
      ],
    );
    assert.strictEqual(envOf(routed)[CODEX_KEY_ENV]?.value, endpoint.key);
    assert.isTrue(envOf(routed)[CODEX_KEY_ENV]?.sensitive);
  });
});

describe("codexPoolArgs", () => {
  it("passes OpenAI's catalog path as a TOML string, whatever the path contains", () => {
    const path = `/Users/o'brien/Library/Application Support/t3/pool/codex-models.json`;
    const tokens = tokenizeCliArgs(codexPoolArgs(endpoint, path));
    assert.include(tokens, `model_catalog_json=${JSON.stringify(path)}`);
    const windows = String.raw`C:\Users\me\AppData\t3\codex-models.json`;
    assert.include(
      tokenizeCliArgs(codexPoolArgs(endpoint, windows)),
      `model_catalog_json=${JSON.stringify(windows)}`,
    );
    assert.notInclude(codexPoolArgs(endpoint), "model_catalog_json");
  });
});

describe("poolOverlay / describeRoutes", () => {
  const map = {
    claudeAgent: claude(),
    codex: codex(),
    claudeAgent_personal: claude({}, { displayName: "Personal" }),
    cursor: { driver: "cursor", config: {} },
  } as unknown as ProviderInstanceConfigMap;

  it("routes only the pooled Claude and Codex instances", () => {
    const next = poolOverlay(context())(map) as Record<string, ProviderInstanceConfig>;
    assert.isDefined(envOf(next.claudeAgent!).ANTHROPIC_BASE_URL);
    assert.isDefined(envOf(next.codex!)[CODEX_KEY_ENV]);
    assert.isUndefined(envOf(next.claudeAgent_personal!).ANTHROPIC_BASE_URL);
    assert.strictEqual(next.cursor, (map as Record<string, unknown>).cursor);
  });

  it("describes routes with a reason when the pool can't serve a provider", () => {
    const routes = describeRoutes(
      map,
      context({ codex: undefined }),
      (provider) => `waiting ${provider}`,
    );
    assert.deepStrictEqual(
      routes.map((route) => [route.instanceId, route.mode, route.active, route.reason ?? null]),
      [
        ["claudeAgent", "pool", true, null],
        ["codex", "pool", false, "waiting codex"],
        ["claudeAgent_personal", "direct", false, null],
      ],
    );
    assert.strictEqual(routes[2]!.displayName, "Personal");
  });
});
