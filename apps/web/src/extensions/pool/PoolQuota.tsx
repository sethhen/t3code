/** The provider's current subscription allowance, independent of recorded pool requests. */
import type { PoolAccount } from "@t3tools/contracts";

import { accountQuotaNotice, poolProviderDriver } from "./pool.logic";
import { LimitWindows } from "./t3";

export function PoolQuota({
  account,
  now,
  sourceError,
}: {
  readonly account: PoolAccount;
  readonly now: number;
  readonly sourceError: boolean;
}) {
  const notice = accountQuotaNotice(account, sourceError);
  return (
    <div className="flex flex-col gap-1">
      {account.windows.length > 0 ? (
        <LimitWindows
          driver={poolProviderDriver(account.provider)}
          windows={account.windows}
          now={now}
          compact
        />
      ) : null}
      {notice ? (
        <p
          className={
            notice.warning ? "text-xs text-warning-foreground" : "text-xs text-muted-foreground"
          }
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
