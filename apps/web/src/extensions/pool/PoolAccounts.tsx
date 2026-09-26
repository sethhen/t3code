/**
 * The Accounts rows of the Pool section: one row per signed-in account with
 * its plan, state and quota bars (the usage page's own `LimitWindows`), the
 * add-account menu, the empty state, and the remove confirm. Every element is
 * a direct child of the settings card, so rows get the card's dividers.
 */
import type { PoolAccount, PoolProvider, PoolStatus } from "@t3tools/contracts";
import { ChevronDownIcon, EllipsisIcon, PlusIcon } from "lucide-react";
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
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

import {
  accountLabel,
  accountNotice,
  orderAccounts,
  POOL_ACCOUNT_KIND,
  POOL_PROVIDER_LABEL,
  poolProviderDriver,
} from "./pool.logic";
import {
  ClaudeAI,
  LimitWindows,
  OpenAI,
  PROVIDER_STATUS_STYLES,
  ProviderInstanceIcon,
  RedactedSensitiveText,
  SettingsRow,
} from "./t3";
import type { PoolActions, PoolClient } from "./usePoolStatus";

const PROVIDER_MARK = { claude: ClaudeAI, codex: OpenAI } as const;

/** Menu and button copy for adding each kind of account. */
const ADD_LABEL: Readonly<Record<PoolProvider, { menu: string; button: string }>> = {
  claude: { menu: "Claude account", button: "Add Claude account" },
  codex: { menu: "ChatGPT account (Codex)", button: "Add ChatGPT account" },
};

export function PoolAccounts({
  status,
  receivedAt,
  client,
  actions,
  readOnly,
  onAdd,
}: {
  readonly status: PoolStatus;
  readonly receivedAt: number;
  readonly client: PoolClient;
  readonly actions: PoolActions;
  readonly readOnly: boolean;
  readonly onAdd: (provider: PoolProvider) => void;
}) {
  // The account stays set while the confirm animates closed.
  const [confirm, setConfirm] = useState<{ account: PoolAccount; open: boolean } | null>(null);
  const removing = confirm?.account ?? null;
  const closeConfirm = () => setConfirm((current) => current && { ...current, open: false });

  const accounts = orderAccounts(status.accounts);
  const accountsError = status.accountsError?.trim() ? (
    <span className="text-warning-foreground">{status.accountsError}</span>
  ) : null;

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
      {accounts.length === 0 ? (
        <SettingsRow
          title="Accounts"
          description="Add a Claude or ChatGPT account to start your pool. T3 routes Claude and Codex through it automatically."
          status={accountsError}
          control={
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              {(["claude", "codex"] as const).map((provider) => {
                const Mark = PROVIDER_MARK[provider];
                return (
                  <Button
                    key={provider}
                    size="sm"
                    variant="outline"
                    disabled={readOnly}
                    onClick={() => onAdd(provider)}
                  >
                    <Mark aria-hidden />
                    {ADD_LABEL[provider].button}
                  </Button>
                );
              })}
            </div>
          }
        />
      ) : (
        <SettingsRow
          title="Accounts"
          status={accountsError}
          control={<AddAccountMenu disabled={readOnly} onAdd={onAdd} />}
        />
      )}
      {accounts.map((account) => (
        <PoolAccountRow
          key={account.id}
          account={account}
          now={receivedAt}
          readOnly={readOnly}
          busy={actions.isBusy(`account:${account.id}`)}
          intent={actions.intent(`account:${account.id}`)}
          onSetEnabled={(enabled) => setEnabled(account, enabled)}
          onRemove={() => setConfirm({ account, open: true })}
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
                    is signed out of the pool.
                  </>
                ) : (
                  "The account is signed out of the pool."
                )}{" "}
                Pooled sessions stop using it. To use it again, add it and sign in.
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

function AddAccountMenu({
  disabled,
  onAdd,
}: {
  readonly disabled: boolean;
  readonly onAdd: (provider: PoolProvider) => void;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" disabled={disabled} />}>
        <PlusIcon aria-hidden />
        Add account
        <ChevronDownIcon className="-me-1 opacity-60" aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-52">
        {(["claude", "codex"] as const).map((provider) => {
          const Mark = PROVIDER_MARK[provider];
          return (
            <MenuItem key={provider} onClick={() => onAdd(provider)}>
              <Mark aria-hidden />
              {ADD_LABEL[provider].menu}
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

/**
 * Icon, provider and plan, the masked email, then the quota bars: under the
 * name on narrow screens, in their own column from `md` up.
 */
function PoolAccountRow({
  account,
  now,
  readOnly,
  busy,
  intent,
  onSetEnabled,
  onRemove,
}: {
  readonly account: PoolAccount;
  readonly now: number;
  readonly readOnly: boolean;
  readonly busy: boolean;
  /** The enabled value a running pause/resume is heading to. */
  readonly intent: unknown;
  readonly onSetEnabled: (enabled: boolean) => void;
  readonly onRemove: () => void;
}) {
  const paused = typeof intent === "boolean" ? !intent : account.status === "disabled";
  const notice = paused ? ({ kind: "paused" } as const) : accountNotice(account);
  const providerLabel = POOL_PROVIDER_LABEL[account.provider];
  const label = accountLabel(account);
  const showWindows = account.windows.length > 0;

  return (
    <div
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:px-4",
        "md:grid-cols-[auto_minmax(0,1fr)_minmax(0,24rem)_auto]",
      )}
    >
      <ProviderInstanceIcon
        driverKind={poolProviderDriver(account.provider)}
        displayName={providerLabel}
        className={cn("row-start-1 size-5", paused && "opacity-60")}
        iconClassName="size-4 text-foreground/80"
      />
      <div className={cn("row-start-1 min-w-0", paused && "opacity-60")}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{providerLabel}</span>
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
          ) : null}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {account.email ? (
            <RedactedSensitiveText
              value={account.email}
              ariaLabel="Toggle account email visibility"
              revealTooltip="Click to reveal email"
              hideTooltip="Click to hide email"
              className="max-w-full truncate"
            />
          ) : (
            <span>{label}</span>
          )}
          {notice?.kind === "error" ? (
            <span className="flex min-w-0 items-center gap-1.5 text-warning-foreground">
              <span
                aria-hidden
                className={cn("size-1.5 shrink-0 rounded-full", PROVIDER_STATUS_STYLES.warning.dot)}
              />
              <span className="line-clamp-2 [overflow-wrap:anywhere]">{notice.text}</span>
            </span>
          ) : null}
        </div>
      </div>
      <div
        className={cn(
          "col-[2/-1] row-start-2 min-w-0 md:col-[3/4] md:row-start-1",
          paused && "opacity-60",
        )}
      >
        {showWindows ? (
          <LimitWindows
            compact
            driver={poolProviderDriver(account.provider)}
            windows={account.windows}
            now={now}
          />
        ) : notice === null || notice.kind === "cooling" ? (
          <span className="text-xs text-muted-foreground">No quota reported yet</span>
        ) : null}
      </div>
      <div className="col-start-3 row-start-1 flex justify-end md:col-start-4">
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground"
                disabled={readOnly || busy}
                aria-label={`Actions for ${providerLabel} account ${label}`}
              />
            }
          >
            {busy ? <Spinner className="size-3.5" /> : <EllipsisIcon className="size-3.5" />}
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-36">
            <MenuItem onClick={() => onSetEnabled(paused)}>{paused ? "Resume" : "Pause"}</MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={onRemove}>
              Remove…
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
