// @effect-diagnostics nodeBuiltinImport:off - a temp dir stands in for the provider homes.
/**
 * The registry's settings watcher with the fork's reconcile trigger (the
 * second host edit in ProviderInstanceRegistryHydration.ts): a request rebuilds
 * the instances an overlay changed, and never writes settings.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { AntigravityInstallation } from "../provider/AntigravityInstallation.ts";
import { CodexInstallation } from "../provider/CodexInstallation.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as OpenCodeRuntime from "../provider/opencodeRuntime.ts";
import * as ProviderEventLoggers from "../provider/Layers/ProviderEventLoggers.ts";
import { ProviderInstanceRegistryHydrationLive } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as ResetCreditCoordinator from "../provider/Layers/resetCreditCoordinator.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { registerInstanceOverlay, requestOverlayReconcile } from "./instanceOverlays.ts";

const EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

/** Fake homes, never the real ones. */
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "overlay-reconcile-"));

/** Every built-in provider turned off, so no driver probes or spawns anything. */
const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: Object.fromEntries(
    Object.entries(DEFAULT_SERVER_SETTINGS.providers).map(([kind, config]) => [
      kind,
      { ...config, enabled: false, ...("homePath" in config ? { homePath: home } : {}) },
    ]),
  ) as ServerSettings["providers"],
};

const BaseServices = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-overlay-reconcile-" }),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}))),
    ),
  ),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.mock(CodexInstallation)({ managedDirectory: "unused-managed-installation" }),
  Layer.mock(ServerSecretStore)({}),
  Layer.succeed(ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
  }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    reportHostPowerState: () => Effect.void,
    snapshot: Effect.succeed({
      hostPower: {
        source: "unknown",
        idle: "unknown",
        idleSeconds: null,
        locked: "unknown",
        suspended: false,
        onBattery: "unknown",
        lowPowerMode: "unknown",
        thermalState: "unknown",
        stale: true,
        updatedAt: EPOCH,
      },
      leases: [],
      activeForegroundLeaseCount: 0,
      activeScopeKeys: [],
      shouldRunOpportunisticWork: true,
      updatedAt: EPOCH,
    }),
    streamChanges: Stream.empty,
    hasDemand: () => Effect.succeed(true),
    shouldRunScopeWork: () => Effect.succeed(true),
    shouldRunOpportunisticWork: Effect.succeed(true),
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

const DriverServices = Layer.mergeAll(
  ModelManifest.layerTest,
  ResetCreditCoordinator.layerTest,
  OpenCodeRuntime.OpenCodeRuntimeLive,
  AntigravityInstallation.layer,
).pipe(Layer.provideMerge(BaseServices));

it.effect("a reconcile request rebuilds overlaid instances without writing settings", () =>
  Effect.gen(function* () {
    let writes = 0;
    const changes = yield* PubSub.unbounded<ServerSettings>();
    const settingsService = {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Effect.succeed(settings),
      updateSettings: () =>
        Effect.sync(() => {
          writes += 1;
          return settings;
        }),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    } satisfies ServerSettingsService["Service"];

    let label: string | undefined;
    const remove = registerInstanceOverlay("reconcile-test", (map) =>
      label === undefined
        ? map
        : (Object.fromEntries(
            Object.entries(map).map(([id, instance]) => [id, { ...instance, displayName: label }]),
          ) as ProviderInstanceConfigMap),
    );
    yield* Effect.addFinalizer(() => Effect.sync(remove));

    const context = yield* Layer.build(
      ProviderInstanceRegistryHydrationLive.pipe(
        Layer.provide(Layer.succeed(ServerSettingsService, settingsService)),
        Layer.provide(DriverServices),
      ),
    );
    const registry = yield* ProviderInstanceRegistry.pipe(Effect.provide(context));
    const codex = ProviderInstanceId.make("codex");
    assert.isUndefined((yield* registry.getInstance(codex))?.displayName);

    label = "overlaid";
    const rebuilt = yield* registry.subscribeChanges;
    requestOverlayReconcile();
    yield* PubSub.take(rebuilt);
    assert.equal((yield* registry.getInstance(codex))?.displayName, "overlaid");
    assert.equal(writes, 0);
  }).pipe(Effect.scoped),
);
