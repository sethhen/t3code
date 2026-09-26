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
 *
 * The pool key never appears in a command line (argv shows up in `ps`, in trace
 * attributes and in T3's resource telemetry): flag settings blank both token
 * variables, which also neutralises a stale token in `~/.claude/settings.json`,
 * and `apiKeyHelper` reads the key from a 0600 file. Claude Code runs the helper
 * with `shell: true`, i.e. `/bin/sh` or `cmd.exe`.
 *
 * Models stay in their own harness (Seth's rule): Claude models only through
 * Claude Code, OpenAI models only through Codex, although the proxy would serve
 * any model on either endpoint.
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

export interface KeyHelper {
  /** The 0600 file holding the current endpoint's key. */
  readonly path: string;
  /** The platform Claude runs on (the T3 server's). */
  readonly platform: string;
}

/** A shell command that prints the key file: `cmd.exe` on Windows, `/bin/sh` elsewhere. */
export const keyHelperCommand = ({ path, platform }: KeyHelper) =>
  platform === "win32" ? `type "${path}"` : `cat '${path.replaceAll("'", `'\\''`)}'`;

export interface PoolRoutingContext {
  /** Present when the pool can serve Claude right now. */
  readonly claude?: PoolEndpoint | undefined;
  /** Present when the pool can serve Codex right now. */
  readonly codex?: PoolEndpoint | undefined;
  /** OpenAI's current Codex catalog, fetched through a pool account (native Codex reads the same one). */
  readonly codexCatalogPath?: string | undefined;
  readonly modeFor: (instanceId: string) => PoolRouteMode;
  /** Where pooled Claude sessions read the key from (see `keyHelperCommand`). */
  readonly keyHelper: KeyHelper;
}

/** Non-secret settings every pooled Claude session gets, in the env and in flag settings. */
export const claudeParityEnv = (endpoint: PoolEndpoint): Readonly<Record<string, string>> => ({
  ANTHROPIC_BASE_URL: endpoint.baseUrl,
  _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
  ENABLE_TOOL_SEARCH: "true",
  CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
  // Gateway model discovery would list the pool's OpenAI models in Claude Code.
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "0",
});

/**
 * Flag `--settings` for a pooled Claude session: no secret in it. The blank
 * tokens outrank both the process env and `settings.json`, so the key can only
 * come from `apiKeyHelper`.
 */
export const claudeFlagSettings = (endpoint: PoolEndpoint, keyHelper: KeyHelper) => ({
  advisorModel: "opus",
  apiKeyHelper: keyHelperCommand(keyHelper),
  env: { ...claudeParityEnv(endpoint), ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "" },
});

const OPENAI_MODEL = /^(gpt|o\d|codex|chatgpt)/i;
const CLAUDE_MODEL = /(claude|opus|sonnet|haiku|fable)/i;

/** Drops custom models of the other family from a pooled instance. */
export const sameFamilyModels = (customModels: unknown, provider: PoolProvider): unknown => {
  if (!Array.isArray(customModels)) return customModels;
  const foreign = provider === "claude" ? OPENAI_MODEL : CLAUDE_MODEL;
  return customModels.filter((model: unknown) => {
    const slug =
      typeof model === "string"
        ? model
        : typeof model === "object" && model !== null && "slug" in model
          ? String((model as { slug: unknown }).slug)
          : "";
    return !foreign.test(slug);
  });
};

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
    const config = configRecord(instance.config);
    return {
      ...instance,
      // Process env (terminals, the status probe): the key is fine here, env is not argv.
      environment: withEnv(
        instance.environment,
        {
          ...claudeParityEnv(context.claude),
          ANTHROPIC_AUTH_TOKEN: context.claude.key,
          ANTHROPIC_API_KEY: "",
        },
        new Set(["ANTHROPIC_AUTH_TOKEN"]),
      ),
      config: {
        ...config,
        ...("customModels" in config
          ? { customModels: sameFamilyModels(config.customModels, "claude") }
          : {}),
        launchArgs: withLaunchArgSettings(
          launchArgsOf(instance.config),
          claudeFlagSettings(context.claude, context.keyHelper),
        ),
      },
    };
  }
  if (provider === "codex" && context.codex) {
    const codexConfig = configRecord(instance.config);
    const own = launchArgsOf(instance.config).trim();
    return {
      ...instance,
      environment: withEnv(
        instance.environment,
        { [CODEX_KEY_ENV]: context.codex.key },
        new Set([CODEX_KEY_ENV]),
      ),
      config: {
        ...codexConfig,
        ...("customModels" in codexConfig
          ? { customModels: sameFamilyModels(codexConfig.customModels, "codex") }
          : {}),
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
