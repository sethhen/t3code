/**
 * How a routed provider instance launches. Pure: the pool layer registers
 * `poolOverlay` with the fork's instance-overlay seam and re-runs the registry
 * reconcile whenever its inputs change.
 *
 * Claude gets the pool through BOTH the process environment and flag
 * `--settings.env`. Flag settings outrank the user's `settings.json` `env`
 * block, which outranks the process environment, so a stale proxy entry in
 * `~/.claude/settings.json` can't silently take a pooled session elsewhere.
 * The process environment still matters for anything T3 runs without our
 * settings (terminals, the status probe).
 *
 * The parity settings are what direct Claude Code gets on api.anthropic.com
 * and silently loses behind any custom `ANTHROPIC_BASE_URL` (measured against a
 * direct capture, 2026-09-26):
 * - `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`: treat the proxy as first
 *   party, restoring tool search, fine-grained tool streaming, the global
 *   system-prompt cache scope, cache diagnostics and the advisor tool.
 * - `ENABLE_TOOL_SEARCH`: the documented switch, in case the internal one goes.
 * - `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`: subscribers get the 1-hour cache from
 *   their claude.ai login, which a proxied session doesn't carry.
 * - `advisorModel`: the advisor's model normally comes from the account.
 */
import type {
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  PoolProvider,
  PoolRoute,
  PoolRouteMode,
} from "@t3tools/contracts";

import { withLaunchArgSettings } from "../claudeSettings.ts";

export const CLAUDE_DRIVER = "claudeAgent";
export const CODEX_DRIVER = "codex";
export const CODEX_PROVIDER_ID = "t3-pool";
export const CODEX_KEY_ENV = "T3_POOL_API_KEY";

export interface PoolEndpoint {
  /** Anthropic-style base URL for Claude (no `/v1`). */
  readonly baseUrl: string;
  readonly key: string;
}

export interface PoolRoutingContext {
  /** Present when the pool can serve Claude right now. */
  readonly claude?: PoolEndpoint | undefined;
  /** Present when the pool can serve Codex right now. */
  readonly codex?: PoolEndpoint | undefined;
  /** OpenAI's current Codex catalog, fetched through a pool account (native Codex reads the same one). */
  readonly codexCatalogPath?: string | undefined;
  readonly modeFor: (instanceId: string) => PoolRouteMode;
}

/** The environment a pooled Claude session runs with. */
export const claudePoolEnv = (endpoint: PoolEndpoint): Readonly<Record<string, string>> => ({
  ANTHROPIC_BASE_URL: endpoint.baseUrl,
  ANTHROPIC_AUTH_TOKEN: endpoint.key,
  // A real API key would otherwise be sent to the pool alongside the token.
  ANTHROPIC_API_KEY: "",
  _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
  ENABLE_TOOL_SEARCH: "true",
  CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
});

export const CLAUDE_POOL_SETTINGS = { advisorModel: "opus" } as const;

/** `-c key=<TOML string>`, single-quoted for `tokenizeCliArgs` (JSON strings are valid TOML basic strings). */
const codexOverride = (key: string, value: string) =>
  `-c '${`${key}=${JSON.stringify(value)}`.replaceAll("'", `'"'"'`)}'`;

/** Codex `-c` overrides that point `codex app-server` and `codex exec` at the pool. */
export const codexPoolArgs = (endpoint: PoolEndpoint, catalogPath?: string): string =>
  [
    codexOverride("model_provider", CODEX_PROVIDER_ID),
    codexOverride(`model_providers.${CODEX_PROVIDER_ID}.name`, "T3 Pool"),
    codexOverride(
      `model_providers.${CODEX_PROVIDER_ID}.base_url`,
      `${endpoint.baseUrl.replace(/\/+$/, "")}/v1`,
    ),
    codexOverride(`model_providers.${CODEX_PROVIDER_ID}.wire_api`, "responses"),
    codexOverride(`model_providers.${CODEX_PROVIDER_ID}.env_key`, CODEX_KEY_ENV),
    ...(catalogPath ? [codexOverride("model_catalog_json", catalogPath)] : []),
  ].join(" ");

type EnvEntry = NonNullable<ProviderInstanceConfig["environment"]>[number];

const withEnv = (
  environment: ProviderInstanceConfig["environment"],
  values: Readonly<Record<string, string>>,
  sensitive: ReadonlySet<string>,
): ReadonlyArray<EnvEntry> => [
  ...(environment ?? []).filter((entry) => !(entry.name in values)),
  ...Object.entries(values).map(([name, value]) => ({
    name,
    value,
    sensitive: sensitive.has(name),
  })),
];

const configRecord = (config: unknown): Record<string, unknown> =>
  typeof config === "object" && config !== null && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};

const launchArgsOf = (config: unknown) => {
  const value = configRecord(config).launchArgs;
  return typeof value === "string" ? value : "";
};

export const providerOfDriver = (driver: string): PoolProvider | undefined =>
  driver === CLAUDE_DRIVER ? "claude" : driver === CODEX_DRIVER ? "codex" : undefined;

/** Routes an instance through the pool, or returns it unchanged. */
export const routeInstance = (
  instanceId: string,
  instance: ProviderInstanceConfig,
  context: PoolRoutingContext,
): ProviderInstanceConfig => {
  if (instance.enabled === false || context.modeFor(instanceId) !== "pool") return instance;
  const provider = providerOfDriver(instance.driver);
  if (provider === "claude" && context.claude) {
    const env = claudePoolEnv(context.claude);
    return {
      ...instance,
      environment: withEnv(instance.environment, env, new Set(["ANTHROPIC_AUTH_TOKEN"])),
      config: {
        ...configRecord(instance.config),
        launchArgs: withLaunchArgSettings(launchArgsOf(instance.config), {
          ...CLAUDE_POOL_SETTINGS,
          env,
        }),
      },
    };
  }
  if (provider === "codex" && context.codex) {
    const own = launchArgsOf(instance.config).trim();
    return {
      ...instance,
      environment: withEnv(
        instance.environment,
        { [CODEX_KEY_ENV]: context.codex.key },
        new Set([CODEX_KEY_ENV]),
      ),
      config: {
        ...configRecord(instance.config),
        // Ours last: a later `-c` for the same key wins.
        launchArgs: [own, codexPoolArgs(context.codex, context.codexCatalogPath)]
          .filter(Boolean)
          .join(" "),
      },
    };
  }
  return instance;
};

export const poolOverlay =
  (context: PoolRoutingContext) =>
  (map: ProviderInstanceConfigMap): ProviderInstanceConfigMap => {
    const next: Record<string, ProviderInstanceConfig> = {};
    for (const [instanceId, instance] of Object.entries(map)) {
      next[instanceId] = routeInstance(instanceId, instance, context);
    }
    return next as ProviderInstanceConfigMap;
  };

const DEFAULT_NAMES: Record<PoolProvider, string> = { claude: "Claude", codex: "Codex" };

/** The Claude and Codex instances in `map`, as the Pool section lists them. */
export const describeRoutes = (
  map: ProviderInstanceConfigMap,
  context: PoolRoutingContext,
  waitingReason: (provider: PoolProvider) => string,
): PoolRoute[] =>
  Object.entries(map).flatMap(([instanceId, instance]): PoolRoute[] => {
    const provider = providerOfDriver(instance.driver);
    if (!provider || instance.enabled === false) return [];
    const mode = context.modeFor(instanceId);
    const active = mode === "pool" && context[provider] !== undefined;
    return [
      {
        instanceId,
        provider,
        displayName: instance.displayName ?? DEFAULT_NAMES[provider],
        mode,
        active,
        ...(mode === "pool" && !active ? { reason: waitingReason(provider) } : {}),
      },
    ];
  });
