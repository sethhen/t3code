// @effect-diagnostics globalConsole:off - overlays run inside a pure, synchronous upstream function with no Effect context to log through.
/**
 * Runtime overlays on provider instances - the fork's seam for changing how an
 * instance launches without writing to the user's settings.
 *
 * Upstream derives the instance map from settings in
 * `deriveProviderInstanceConfigMap` (ProviderInstanceRegistryHydration.ts); the
 * host edit there returns `applyForkInstanceOverlays(map)`. That map feeds the
 * instance registry, terminals and provider installation, and never reaches a
 * client, so an overlay may carry secrets. Overlays are never persisted: remove
 * the overlay (or the fork) and the user's own configuration is untouched.
 *
 * The accounts extension registers one (keep training off, pool/privacy.ts);
 * a new overlay needs no upstream edit. An overlay must be pure and cheap: it
 * runs on every settings emission. When the state an overlay reads changes
 * outside settings, its owner calls `requestOverlayReconcile()`: the registry's
 * settings watcher (second host edit, `withOverlayReconciles`) re-derives the
 * map from the current settings, serially with settings changes, and never
 * writes settings.json (a file that failed to decode stays on disk for repair).
 */
import type { ProviderInstanceConfigMap, ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

export type InstanceOverlay = (map: ProviderInstanceConfigMap) => ProviderInstanceConfigMap;

const overlays = new Map<string, InstanceOverlay>();

/** Registers (or replaces) the overlay named `id`; returns its removal. */
export const registerInstanceOverlay = (id: string, overlay: InstanceOverlay) => {
  overlays.set(id, overlay);
  return () => {
    if (overlays.get(id) === overlay) overlays.delete(id);
  };
};

/** Called by the host seam. A failing overlay is skipped, never the whole map. */
export const applyForkInstanceOverlays = (
  map: ProviderInstanceConfigMap,
): ProviderInstanceConfigMap => {
  let next = map;
  for (const [id, overlay] of overlays) {
    try {
      next = overlay(next);
    } catch (cause) {
      console.error(`[fork] instance overlay "${id}" failed; skipping it`, cause);
    }
  }
  return next;
};

/**
 * Pending reconcile requests: a burst collapses into one, and the last is
 * replayed to a watcher that subscribes after it.
 */
const reconcileRequests = Effect.runSync(PubSub.sliding<void>({ capacity: 1, replay: 1 }));

/** Rebuilds the provider instances whose overlaid config changed, from the current settings. */
export const requestOverlayReconcile = () => {
  PubSub.publishUnsafe(reconcileRequests, undefined);
};

/**
 * The settings watcher's stream with reconcile requests merged in. A request
 * reads the settings when its turn comes, after every change that arrived
 * before it, so the last reconcile always sees the newest settings. Ends with
 * the settings stream; a failed read is logged and skipped.
 */
export const withOverlayReconciles =
  <E, R>(getSettings: Effect.Effect<ServerSettings, E, R>) =>
  (changes: Stream.Stream<ServerSettings>): Stream.Stream<ServerSettings, never, R> =>
    Stream.merge(changes, Stream.fromPubSub(reconcileRequests).pipe(Stream.map(() => undefined)), {
      haltStrategy: "left",
    }).pipe(
      Stream.filterMapEffect((change) =>
        change !== undefined
          ? Effect.succeed(Result.succeed(change))
          : getSettings.pipe(
              Effect.map(Result.succeed),
              Effect.catchCause((cause) =>
                Effect.logError("Reading settings for an overlay reconcile failed", cause).pipe(
                  Effect.as(Result.fail(undefined)),
                ),
              ),
            ),
      ),
    );
