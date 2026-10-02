/**
 * Fork sections of Settings → Providers. The upstream page wraps its own
 * sections (provider list, usage hubs, advanced, dialogs) in
 * `ProviderSettingsExtensions` and knows nothing else. The device switcher sits
 * on top because it picks the environment for the whole page; the accounts
 * section follows and folds the upstream sections away under "More provider
 * settings" where the server runs its sign-ins. Each section follows the device
 * the page shows and must disable its writes when `readOnly` is set.
 */
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { AccountsSettings } from "./pool";

export interface ProviderSettingsExtensionProps {
  readonly environmentId: EnvironmentId;
  /** The device's name, for copy such as "can view …'s accounts". */
  readonly environmentLabel: string;
  /** This session can view the device's providers but not change them. */
  readonly readOnly: boolean;
  /**
   * The page was opened on this provider instance, so the upstream list must
   * show. Required (not optional) so a merge that drops the host prop fails typecheck.
   */
  readonly targetInstanceId: ProviderInstanceId | undefined;
  /** The upstream sections. */
  readonly children: ReactNode;
}

export function ProviderSettingsExtensions({
  deviceTabs,
  ...props
}: ProviderSettingsExtensionProps & { readonly deviceTabs?: ReactNode }) {
  return (
    <>
      {deviceTabs ? (
        <div className="flex min-h-11 min-w-0 items-center px-3 sm:px-4">{deviceTabs}</div>
      ) : null}
      {/* Keyed so one device's accounts, sign-in and fold never show on another. */}
      <AccountsSettings key={props.environmentId} {...props} />
    </>
  );
}
