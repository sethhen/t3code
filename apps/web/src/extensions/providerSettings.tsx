/**
 * Fork sections at the top of Settings → Providers. The upstream page renders
 * `ProviderSettingsExtensions` above its provider list and knows nothing else,
 * so a new fork feature adds one line here. Each section follows the device
 * the page shows and must disable its writes when `readOnly` is set.
 */
import { type EnvironmentId, POOL_EXTENSION_ID } from "@t3tools/contracts";
import type { ComponentType } from "react";

import { PoolSettings } from "./pool";

export interface ProviderSettingsExtensionProps {
  readonly environmentId: EnvironmentId;
  /** The device's name, for copy such as "runs on …". */
  readonly environmentLabel: string;
  /** This session can view the device's providers but not change them. */
  readonly readOnly: boolean;
}

export interface ProviderSettingsExtension {
  readonly id: string;
  /** Renders nothing when its environment does not support it. */
  readonly Section: ComponentType<ProviderSettingsExtensionProps>;
}

export const PROVIDER_SETTINGS_EXTENSIONS: readonly ProviderSettingsExtension[] = [
  { id: POOL_EXTENSION_ID, Section: PoolSettings },
];

/** Every registered section, in order. */
export function ProviderSettingsExtensions(props: ProviderSettingsExtensionProps) {
  return (
    <>
      {PROVIDER_SETTINGS_EXTENSIONS.map(({ id, Section }) => (
        <Section key={id} {...props} />
      ))}
    </>
  );
}
