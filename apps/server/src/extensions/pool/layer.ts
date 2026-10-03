// @effect-diagnostics globalConsole:off - the controller's log callback runs outside any fiber.
/**
 * The pool's server-lifetime half: builds the one `MoveController`, wires it
 * to T3's settings, provider homes, snapshots and refresh, a PTY for Claude
 * Code's own screens and the instance-overlay seam, and retires the pool in
 * the background. Provided through `ForkServicesLive` (extensions/services.ts),
 * the fork's one server.ts seam.
 *
 * Never fails the server start: the boot runs detached and logs its failures
 * (the next start retries). The privacy state loads before the server serves.
 * With training kept off, the registry has already built the instances without
 * the overlay by then, so every boot builds the changed ones twice: the reconcile
 * request rebuilds them and interrupts the first build's probes. The rebuild
 * usually lands before any session starts, but nothing guarantees it.
 */
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { registerInstanceOverlay, requestOverlayReconcile } from "../instanceOverlays.ts";
import * as ClaudeTerminal from "./claudeTerminal.ts";
import { canCreateSymlinks, MoveController } from "./move.ts";
import { setMoveController } from "./runtime.ts";
import {
  expandHomePath,
  HostProcessEnvironment,
  HostProcessPlatform,
  makeClaudeEnvironment,
  materializeCodexShadowHome,
  NodePtyAdapterLive,
  ProviderInstanceRegistry,
  ProviderRegistry,
  PtyAdapter,
  resolveClaudeSdkExecutablePath,
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
    const ptyAdapter = yield* PtyAdapter;
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
      claudeExecutable: (binary, binaryEnv) =>
        run(resolveClaudeSdkExecutablePath(binary, binaryEnv)),
      claudeTerminal: ClaudeTerminal,
      pty: (input) => run(ptyAdapter.spawn(input)),
      providerEmail: async (instanceId) =>
        (await run(providers.getProviders)).find((provider) => provider.instanceId === instanceId)
          ?.auth.email,
      // The registry's settings watcher (its only reconciler, serial by design) re-derives the
      // instance map with the overlay; settings.json is never written for it.
      reconcile: async () => requestOverlayReconcile(),
      log: (message, cause) => console.warn(`[pool] ${message}`, cause ?? ""),
    });

    setMoveController(controller);
    const removeOverlay = registerInstanceOverlay(
      "pool-keep-training-off",
      controller.privacy.instanceOverlay,
    );
    yield* Effect.promise(() => controller.privacy.start());
    void controller.boot();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        removeOverlay();
        controller.close();
        setMoveController(undefined);
      }),
    );
  }),
  // The server gives its PTY adapter to the terminals only; this is the same (memoized) layer.
).pipe(Layer.provide(NodePtyAdapterLive));
