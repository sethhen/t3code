/** The provider's current subscription allowance, independent of recorded pool requests. */
import type { PoolAccount } from "@t3tools/contracts";

import { poolProviderDriver } from "./pool.logic";
import { LimitWindows } from "./t3";

export function PoolQuota({
  account,
  now,
}: {
  readonly account: PoolAccount;
  readonly now: number;
}) {
  if (account.windows.length === 0) {
    return <p className="text-xs text-muted-foreground">Quota not reported.</p>;
  }
  return (
    <LimitWindows
      driver={poolProviderDriver(account.provider)}
      windows={account.windows}
      now={now}
      compact
    />
  );
}
