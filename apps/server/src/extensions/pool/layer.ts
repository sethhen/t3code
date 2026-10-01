// @effect-diagnostics globalConsole:off - the controller's log callback runs outside any fiber.
// @effect-diagnostics nodeBuiltinImport:off - the probe resolves the Claude config directory with Node's path and os.
/**
 * The pool's server-lifetime half: builds the one `PoolController`, wires it
 * to T3's settings, instance registry and usage sources, and stops the proxy
 * when the server shuts down. Provided through `ForkServicesLive`
 * (extensions/services.ts), the fork's one server.ts seam.
 *
 * A pool failure never blocks the server: `init` errors are logged and the
 * section shows them.
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId, UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { launchArgSettings } from "../claudeSettings.ts";
import { POOL_USAGE_SOURCE_ID, PoolController, type PoolDeps } from "./controller.ts";
import { runProcess } from "./process.ts";
import { setPoolController } from "./runtime.ts";
import { poolPaths } from "./state.ts";
import {
  buildClaudeCapabilitiesProbeQueryOptions,
  deriveProviderInstanceConfigMap,
  expandHomePath,
  HostProcessArchitecture,
  HostProcessPlatform,
  mergeProviderInstanceEnvironment,
  resolveClaudeSdkExecutablePath,
  resolveSpawnCommand,
  ServerConfig,
  ServerSettingsService,
  UsageLimitSources,
  UsageService,
} from "./t3.ts";

const configRecord = (config: unknown): Record<string, unknown> =>
  typeof config === "object" && config !== null && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};

const POOL_USAGE_SOURCE = UsageLimitSourceId.make(POOL_USAGE_SOURCE_ID);

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export const PoolLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    // Optional so the pool degrades instead of failing a layer build if an upstream
    // refactor moves it.
    const usageSources = yield* Effect.serviceOption(UsageLimitSources);
    const usageService = yield* Effect.serviceOption(UsageService);
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;

    const getSettings = () => Effect.runPromise(settings.getSettings);
    const instanceMap = async () => deriveProviderInstanceConfigMap(await getSettings());

    const deps: PoolDeps = {
      paths: poolPaths(config.stateDir),
      platform,
      arch,
      instanceMap,
      // An empty patch still writes and emits, so the settings watcher (the registry's only
      // reconciler, serial by design) re-derives the instance map with the pool's overlay.
      // Never call the registry mutator directly: concurrent reconciles race.
      reconcile: async () => {
        await Effect.runPromise(settings.updateSettings({}));
      },
      usageSource: async () => (await getSettings()).usageLimitSources[POOL_USAGE_SOURCE],
      setUsageSource: async (entry) => {
        await Effect.runPromise(
          settings.updateSettings({ usageLimitSources: { [POOL_USAGE_SOURCE]: entry } }),
        );
      },
      usageSnapshot: async () => {
        if (Option.isNone(usageSources)) throw new Error("Account quota checks are unavailable.");
        const snapshots = await Effect.runPromise(usageSources.value.current);
        return snapshots.find((snapshot) => snapshot.id === POOL_USAGE_SOURCE_ID);
      },
      refreshUsage: async () => {
        if (Option.isNone(usageSources)) throw new Error("Account quota checks are unavailable.");
        await Effect.runPromise(usageSources.value.refresh);
      },
      claudeProbe: async (instanceId) => {
        const instance = (await instanceMap())[ProviderInstanceId.make(instanceId)];
        const instanceConfig = configRecord(instance?.config);
        const homePath = text(instanceConfig.homePath);
        let env = mergeProviderInstanceEnvironment(instance?.environment);
        const configDir = homePath
          ? NodePath.resolve(expandHomePath(homePath))
          : env.CLAUDE_CONFIG_DIR;
        if (homePath) env = { ...env, CLAUDE_CONFIG_DIR: configDir };
        const executablePath = await Effect.runPromise(
          resolveClaudeSdkExecutablePath(text(instanceConfig.binaryPath) || "claude", env),
        );
        const baseOptions = buildClaudeCapabilitiesProbeQueryOptions({
          executablePath,
          abortController: new AbortController(),
          environment: env,
          cwd: NodeOS.homedir(),
        });
        return {
          executablePath,
          env: baseOptions.env ?? env,
          flagSettings: launchArgSettings(text(instanceConfig.launchArgs)),
          baseOptions,
          ...(configDir ? { configDir } : {}),
        };
      },
      claudeConfigDir: async (instanceId) => {
        const instance = (await instanceMap())[ProviderInstanceId.make(instanceId)];
        const homePath = text(configRecord(instance?.config).homePath);
        if (homePath) return NodePath.resolve(expandHomePath(homePath));
        return mergeProviderInstanceEnvironment(instance?.environment).CLAUDE_CONFIG_DIR;
      },
      codexVersion: async () => {
        const instance = (await instanceMap())[ProviderInstanceId.make("codex")];
        const env = mergeProviderInstanceEnvironment(instance?.environment);
        const spawn = await Effect.runPromise(
          resolveSpawnCommand(
            text(configRecord(instance?.config).binaryPath) || "codex",
            ["--version"],
            {
              env,
            },
          ),
        );
        const { stdout } = await runProcess(spawn.command, spawn.args, {
          env,
          shell: spawn.shell,
          timeoutMs: 15_000,
        }).catch(() => ({ stdout: "" }));
        return /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(stdout)?.[1];
      },
      // The same rate table and overrides as the Usage page, so the two agree on cost.
      ratesCachePath: NodePath.join(config.stateDir, "usage-model-rates.json"),
      ...(Option.isSome(usageService)
        ? {
            refreshRates: async () => {
              await Effect.runPromise(usageService.value.refreshRates);
            },
          }
        : {}),
      usagePriceOverrides: async () => (await getSettings()).usagePriceOverrides,
      log: (message, cause) => console.warn(`[pool] ${message}`, cause ?? ""),
    };

    const controller = new PoolController(deps);
    yield* Effect.tryPromise(() => controller.init()).pipe(
      Effect.catchCause((cause) => Effect.logError("Pool failed to initialise", cause)),
    );
    setPoolController(controller);
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => controller.shutdown()).pipe(
        Effect.catchCause((cause) => Effect.logError("Pool failed to stop", cause)),
        Effect.andThen(Effect.sync(() => setPoolController(undefined))),
      ),
    );
  }),
);
