// @effect-diagnostics globalConsole:off - the controller's log callback runs outside any fiber.
/**
 * The pool's server-lifetime half: builds the one `MoveController`, wires it
 * to T3's settings, provider homes and provider refresh, and retires the pool
 * in the background. Provided through `ForkServicesLive`
 * (extensions/services.ts), the fork's one server.ts seam.
 *
 * Never blocks or fails the server start: the boot runs detached and logs its
 * failures (the next start retries).
 */
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { canCreateSymlinks, MoveController } from "./move.ts";
import { setMoveController } from "./runtime.ts";
import {
  expandHomePath,
  HostProcessEnvironment,
  HostProcessPlatform,
  makeClaudeEnvironment,
  materializeCodexShadowHome,
  ProviderInstanceRegistry,
  ProviderRegistry,
  resolveCodexHomeLayout,
  resolveSpawnCommand,
  ServerConfig,
  ServerSettingsService,
} from "./t3.ts";

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

export const PoolLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const providers = yield* ProviderRegistry;
    const instances = yield* ProviderInstanceRegistry;
    const platform = yield* HostProcessPlatform;
    const env = yield* HostProcessEnvironment;
    // The controller is plain async code; its effects run with the layer's services.
    const run = Effect.runPromiseWith(yield* Effect.context<FileSystem.FileSystem | Path.Path>());

    // What Settings' refresh does for one instance (ws.ts serverRefreshProviders with
    // refreshModels): drop its caches, re-probe, then re-read its models.
    const refresh = (instanceId: ProviderInstanceId) =>
      Effect.gen(function* () {
        const instance = yield* instances.getInstance(instanceId);
        if (instance?.invalidateCaches) yield* instance.invalidateCaches;
        const snapshots = yield* providers.refreshInstance(instanceId);
        const snapshot = snapshots.find((provider) => provider.instanceId === instanceId);
        if (instance?.refreshModels && snapshot?.enabled && snapshot.installed) {
          yield* instance.refreshModels();
          yield* providers.refreshInstance(instanceId);
        }
      });

    const controller = new MoveController({
      stateDir: config.stateDir,
      platform,
      env,
      expandHome: expandHomePath,
      getSettings: () => run(settings.getSettings),
      updateSettings: async (patch) => {
        await run(settings.updateSettings(patch));
      },
      claudeEnvironment: (homePath, base) => run(makeClaudeEnvironment({ homePath }, base)),
      // The same layout the codex driver builds for an instance with this config.
      materializeCodexHome: (homePath, shadowHomePath) =>
        run(
          Effect.gen(function* () {
            const layout = yield* resolveCodexHomeLayout(
              decodeCodexSettings({ setupMode: "existing", homePath, shadowHomePath }),
            );
            yield* materializeCodexShadowHome(layout);
            return layout.effectiveHomePath ?? layout.sharedHomePath;
          }),
        ),
      resolveSpawn: (command, args, spawnEnv) =>
        run(resolveSpawnCommand(command, args, { env: spawnEnv })),
      refreshInstance: (instanceId) => run(refresh(ProviderInstanceId.make(instanceId))),
      canSymlink: canCreateSymlinks,
      log: (message, cause) => console.warn(`[pool] ${message}`, cause ?? ""),
    });

    setMoveController(controller);
    void controller.boot();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        controller.close();
        setMoveController(undefined);
      }),
    );
  }),
);
