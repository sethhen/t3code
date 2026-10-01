/**
 * Fork sections of Settings → Providers. The upstream page wraps its own
 * sections (provider list, usage hubs, advanced, dialogs) in
 * `ProviderSettingsExtensions` and knows nothing else. The device switcher sits
 * on top because it picks the environment for the whole page; the fork sections
 * follow, then the upstream sections, always shown. Each section follows the
 * device the page shows and must disable its writes when `readOnly` is set.
 */
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { MoveAccounts } from "./pool";

export interface ProviderSettingsExtensionProps {
  readonly environmentId: EnvironmentId;
  /** The device's name. */
  readonly environmentLabel: string;
  /** This session can view the device's providers but not change them. */
  readonly readOnly: boolean;
  /** The page was opened on this provider instance. */
  readonly targetInstanceId?: ProviderInstanceId | undefined;
  /** The upstream sections. */
  readonly children: ReactNode;
}

export function ProviderSettingsExtensions({
  deviceTabs,
  environmentId,
  readOnly,
  children,
}: ProviderSettingsExtensionProps & { readonly deviceTabs?: ReactNode }) {
  return (
    <>
      {deviceTabs ? (
        <div className="flex min-h-11 min-w-0 items-center px-3 sm:px-4">{deviceTabs}</div>
      ) : null}
      {/* Keyed so one device's list and sign-in never show on another. */}
      <MoveAccounts key={environmentId} environmentId={environmentId} readOnly={readOnly} />
      {children}
    </>
  );
}
