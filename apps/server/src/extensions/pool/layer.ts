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
  mergeProviderInstanceEnvironment,
  ProviderInstanceRegistryMutator,
  resolveClaudeSdkExecutablePath,
  resolveSpawnCommand,
  ServerConfig,
  ServerSettingsService,
  UsageLimitSources,
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
    // Both exist in the server runtime; optional so the pool degrades instead of failing a
    // layer build if an upstream refactor moves them (the host-seam test catches that).
    const usageSources = yield* Effect.serviceOption(UsageLimitSources);
    const mutator = yield* Effect.serviceOption(ProviderInstanceRegistryMutator);

    const getSettings = () => Effect.runPromise(settings.getSettings);
    const instanceMap = async () => deriveProviderInstanceConfigMap(await getSettings());

    const deps: PoolDeps = {
      paths: poolPaths(config.stateDir),
      instanceMap,
      reconcile: async () => {
        if (Option.isNone(mutator)) {
          console.warn(
            "[pool] no instance registry mutator; routing applies after the next settings change",
          );
          return;
        }
        await Effect.runPromise(mutator.value.reconcile(await instanceMap()));
      },
      usageSource: async () => (await getSettings()).usageLimitSources[POOL_USAGE_SOURCE],
      setUsageSource: async (entry) => {
        await Effect.runPromise(
          settings.updateSettings({ usageLimitSources: { [POOL_USAGE_SOURCE]: entry } }),
        );
      },
      usageAccounts: async () => {
        if (Option.isNone(usageSources)) return [];
        const snapshots = await Effect.runPromise(usageSources.value.current);
        return snapshots.find((snapshot) => snapshot.id === POOL_USAGE_SOURCE_ID)?.accounts ?? [];
      },
      refreshUsage: async () => {
        if (Option.isSome(usageSources)) await Effect.runPromise(usageSources.value.refresh);
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
