/**
 * The provider rows of the accounts section: Claude, then Codex, each with its
 * add button, a line on how its accounts are used, and one line per signed-in
 * account (plan, state, clear cooldown/pause/remove). Every provider is a
 * direct child of the settings card, so it gets the card's dividers.
 */
import type { PoolAccount, PoolProvider, PoolRoute, PoolStatus } from "@t3tools/contracts";
import { EllipsisIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button, InlineButton } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

import {
  accountLabel,
  accountNotice,
  isHeldBack,
  orderAccounts,
  POOL_ACCOUNT_KIND,
  POOL_PROVIDER_LABEL,
  POOL_PROVIDERS,
  poolProviderDriver,
  providerNote,
} from "./pool.logic";
import { PROVIDER_STATUS_STYLES, ProviderInstanceIcon, RedactedSensitiveText } from "./t3";
import type { PoolActions, PoolClient } from "./usePoolStatus";

export function PoolAccounts({
  status,
  client,
  actions,
  readOnly,
  onAdd,
  onClearCooldown,
}: {
  readonly status: PoolStatus;
  readonly client: PoolClient;
  readonly actions: PoolActions;
  readonly readOnly: boolean;
  readonly onAdd: (provider: PoolProvider) => void;
  readonly onClearCooldown: (account: PoolAccount) => void;
}) {
  // The account stays set while the confirm animates closed.
  const [confirm, setConfirm] = useState<{ account: PoolAccount; open: boolean } | null>(null);
  const removing = confirm?.account ?? null;
  const closeConfirm = () => setConfirm((current) => current && { ...current, open: false });

  const accounts = orderAccounts(status.accounts);
  const accountsError = status.accountsError?.trim();

  const setEnabled = (account: PoolAccount, enabled: boolean) =>
    void actions.run(
      `account:${account.id}`,
      () => client.call("account.setEnabled", { id: account.id, enabled }),
      enabled ? "Could not resume the account" : "Could not pause the account",
      enabled,
    );
  const remove = (account: PoolAccount) =>
    void actions.run(
      `account:${account.id}`,
      () => client.call("account.remove", { id: account.id }),
      "Could not remove the account",
    );

  return (
    <>
      {accountsError ? (
        <p className="px-3 py-2.5 text-xs text-warning-foreground sm:px-4">{accountsError}</p>
      ) : null}
      {POOL_PROVIDERS.map((provider) => (
        <ProviderAccounts
          key={provider}
          provider={provider}
          accounts={accounts.filter((account) => account.provider === provider)}
          routes={status.routes}
          readOnly={readOnly}
          actions={actions}
          onAdd={() => onAdd(provider)}
          onSetEnabled={setEnabled}
          onRemove={(account) => setConfirm({ account, open: true })}
          onClearCooldown={onClearCooldown}
        />
      ))}
      {/* A sibling of the row menus: dialogs stack under popovers. Portalled, so no card divider. */}
      <AlertDialog
        open={confirm?.open ?? false}
        onOpenChange={(open) => {
          if (!open) closeConfirm();
        }}
      >
        {removing ? (
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Remove this {POOL_ACCOUNT_KIND[removing.provider]}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {removing.email ? (
                  <>
                    <RedactedSensitiveText
                      value={removing.email}
                      ariaLabel="Toggle account email visibility"
                      revealTooltip="Click to reveal email"
                      hideTooltip="Click to hide email"
                      className="align-baseline"
                    />{" "}
                    is signed out of T3 Code.
                  </>
                ) : (
                  "The account is signed out of T3 Code."
                )}{" "}
                {POOL_PROVIDER_LABEL[removing.provider]} stops using it. To use it again, add it and
                sign in.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button
                variant="destructive"
                onClick={() => {
                  remove(removing);
                  closeConfirm();
                }}
              >
                Remove account
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        ) : null}
      </AlertDialog>
    </>
  );
}

function ProviderAccounts({
  provider,
  accounts,
  routes,
  readOnly,
  actions,
  onAdd,
  onSetEnabled,
  onRemove,
  onClearCooldown,
}: {
  readonly provider: PoolProvider;
  readonly accounts: readonly PoolAccount[];
  readonly routes: readonly PoolRoute[];
  readonly readOnly: boolean;
  readonly actions: PoolActions;
  readonly onAdd: () => void;
  readonly onSetEnabled: (account: PoolAccount, enabled: boolean) => void;
  readonly onRemove: (account: PoolAccount) => void;
  readonly onClearCooldown: (account: PoolAccount) => void;
}) {
  const label = POOL_PROVIDER_LABEL[provider];
  return (
    <div className="px-3 py-3 sm:px-4">
      <div className="flex items-center gap-3">
        <ProviderInstanceIcon
          driverKind={poolProviderDriver(provider)}
          displayName={label}
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{label}</div>
          <p className="text-xs text-muted-foreground">
            {providerNote(provider, accounts.length, routes)}
          </p>
        </div>
        <Button
          size="xs"
          variant="outline"
          disabled={readOnly}
          aria-label={`Add ${POOL_ACCOUNT_KIND[provider]}`}
          onClick={onAdd}
        >
          <PlusIcon aria-hidden />
          Add account
        </Button>
      </div>
      {accounts.length > 0 ? (
        <div className="mt-2 ms-8">
          {accounts.map((account) => (
            <AccountLine
              key={account.id}
              account={account}
              readOnly={readOnly}
              busy={actions.isBusy(`account:${account.id}`)}
              intent={actions.intent(`account:${account.id}`)}
              onSetEnabled={(enabled) => onSetEnabled(account, enabled)}
              onRemove={() => onRemove(account)}
              onClearCooldown={() => onClearCooldown(account)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The masked email, plan and state of one account, and its clear cooldown/pause/remove menu.
 */
function AccountLine({
  account,
  readOnly,
  busy,
  intent,
  onSetEnabled,
  onRemove,
  onClearCooldown,
}: {
  readonly account: PoolAccount;
  readonly readOnly: boolean;
  readonly busy: boolean;
  /** The enabled value a running pause/resume is heading to. */
  readonly intent: unknown;
  readonly onSetEnabled: (enabled: boolean) => void;
  readonly onRemove: () => void;
  readonly onClearCooldown: () => void;
}) {
  const paused = typeof intent === "boolean" ? !intent : account.status === "disabled";
  const notice = paused ? ({ kind: "paused" } as const) : accountNotice(account);
  const label = accountLabel(account);
  const clearable = !paused && (isHeldBack(account) || account.staleCooldown === true);

  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2">
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm",
          paused && "opacity-60",
        )}
      >
        {account.email ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="max-w-full truncate text-foreground"
          />
        ) : (
          <span className="truncate text-foreground">{label}</span>
        )}
        {account.plan ? (
          <span className="shrink-0 text-xs text-muted-foreground">{account.plan}</span>
        ) : null}
        {notice?.kind === "paused" ? (
          <Badge variant="outline" size="sm" className="font-normal text-muted-foreground">
            Paused
          </Badge>
        ) : notice?.kind === "cooling" ? (
          <Badge variant="info" size="sm" className="min-w-0 truncate font-normal">
            {notice.text}
          </Badge>
        ) : notice?.kind === "error" || notice?.kind === "stale" ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-warning-foreground">
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", PROVIDER_STATUS_STYLES.warning.dot)}
            />
            <span className="line-clamp-2 [overflow-wrap:anywhere]">{notice.text}</span>
            {notice.kind === "stale" ? (
              <InlineButton disabled={readOnly || busy} onClick={onClearCooldown}>
                Clear
              </InlineButton>
            ) : null}
          </span>
        ) : null}
      </div>
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              disabled={readOnly || busy}
              aria-label={`Actions for ${POOL_PROVIDER_LABEL[account.provider]} account ${label}`}
            />
          }
        >
          {busy ? <Spinner className="size-3.5" /> : <EllipsisIcon className="size-3.5" />}
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-36">
          {clearable ? <MenuItem onClick={onClearCooldown}>Clear cooldown</MenuItem> : null}
          <MenuItem onClick={() => onSetEnabled(paused)}>{paused ? "Resume" : "Pause"}</MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={onRemove}>
            Remove…
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
