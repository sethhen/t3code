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
 * Nothing registers an overlay at the moment (the retired pool was the only
 * one); the seam stays so the next one needs no upstream edit. An overlay must
 * be pure and cheap: it runs on every settings emission. When the state an
 * overlay reads changes outside settings, its owner must re-run the registry
 * reconcile itself.
 */
import type { ProviderInstanceConfigMap } from "@t3tools/contracts";

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
