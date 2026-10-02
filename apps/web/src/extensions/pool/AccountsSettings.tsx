/**
 * The Accounts section on top of Settings → Providers: every Claude and Codex
 * account on the environment the page shows, each a normal provider instance
 * (the default one is the main account), with its plan, status and quota. An
 * account is added with its provider's own sign-in, paused, resumed or removed
 * here; the upstream sections fold away under "More provider settings".
 *
 * Rows come from settings and the provider snapshots, exactly like the
 * provider list. The pool extension only runs sign-ins and removals, and lists
 * the accounts the retired pool left. On a server without it the rows still
 * show (Pause and Resume are plain settings writes) and nothing is folded away.
 */
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type MoveAccount,
  type MoveProvider,
  PoolExtension,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { limitsNotice } from "@t3tools/shared/usageLimits";
import { ChevronRightIcon, EllipsisIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button, InlineButton } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { useExtensionClient } from "../client";
import type { ProviderSettingsExtensionProps } from "../providerSettings";
import {
  ACCOUNT_KIND,
  ACCOUNT_PROVIDERS,
  type AccountRow,
  accountSignIn,
  accountTone,
  buildAccountRows,
  foldFor,
  foldReasons,
  type FoldState,
  isManagedCodex,
  limitsClock,
  MAIN_ACCOUNT_HINT,
  removeQuestion,
  visiblePendingAccounts,
} from "./accounts.logic";
import { MOVE_DRIVER, MOVE_PROVIDER_LABEL, PENDING_HINT } from "./move.logic";
import {
  confirmAction,
  type SignIn,
  SignInDetails,
  useMoveStatus,
  useSignIn,
  useStatusPolling,
} from "./signIn";
import {
  buildProviderInstanceUpdatePatch,
  EMPTY_SERVER_PROVIDERS,
  getProviderSummary,
  isProviderSettingsUpdateCandidate,
  LimitWindows,
  PROVIDER_STATUS_STYLES,
  ProviderInstanceIcon,
  RedactedSensitiveText,
  resolveAppModelSelectionState,
  searchableSetting,
  serverEnvironment,
  SettingsSection,
  useAtomCommand,
  useEnvironmentSettings,
  useSettingsSearchTargetId,
  useUpdateEnvironmentSettings,
} from "./t3";

/** Settings search entries that live in the upstream sections; a jump to one unfolds them. */
const UPSTREAM_SEARCH_IDS: ReadonlySet<string> = new Set(
  (
    [
      "providers",
      "usage-providers",
      "provider-health-check-interval",
      "cursor-keychain-usage",
    ] as const
  ).map((id) => searchableSetting(id).id),
);

export function AccountsSettings({
  environmentId,
  environmentLabel,
  readOnly,
  targetInstanceId,
  children,
}: ProviderSettingsExtensionProps) {
  const client = useExtensionClient(PoolExtension, environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const { status, unsupported, refresh, apply } = useMoveStatus(client, readOnly);
  const navigate = useNavigate();
  const { signIn, start, add, signInAgain, cancel, submitCode, adopt, dismiss } = useSignIn(
    client,
    apply,
    (instanceId) => {
      void refresh();
      if (instanceId === undefined) return;
      void refreshProviders({
        environmentId,
        input: { instanceId: ProviderInstanceId.make(instanceId), refreshModels: true },
      });
    },
  );
  // The account whose skip or removal runs; every Skip / Remove waits for it.
  const [skipping, setSkipping] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProviderInstanceId | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  const rows = useMemo(() => buildAccountRows(settings, providers), [settings, providers]);
  const [openedAt] = useState(() => Date.now());
  const now = limitsClock(rows, openedAt);
  // Sign-ins and removals; `status` answering means the server has them.
  const manageable = !readOnly && status !== null;
  const pending = useMemo(
    () => (manageable ? visiblePendingAccounts(status.accounts, settings, rows) : []),
    [manageable, status, settings, rows],
  );
  const serverSignIn = manageable ? status.signIn : undefined;
  const signInRunning = signIn?.phase === "starting" || signIn?.phase === "waiting";
  useStatusPolling(
    refresh,
    !unsupported &&
      (status === null || pending.length > 0 || serverSignIn !== undefined || signInRunning),
  );
  useEffect(() => {
    if (serverSignIn === undefined) return;
    const { accountId, instanceId, provider } = serverSignIn;
    const account = status?.accounts.find((entry) => entry.id === accountId) ?? null;
    const label =
      rows.find((row) => row.instanceId === instanceId)?.label ?? ACCOUNT_KIND[provider];
    const instance = instanceId === undefined ? null : { id: instanceId, label };
    adopt(serverSignIn.signInId, { provider, account, instance });
  }, [adopt, rows, serverSignIn, status]);

  const searchTargetId = useSettingsSearchTargetId();
  const updateDrivers = useMemo(
    () => providers.filter(isProviderSettingsUpdateCandidate).map((provider) => provider.driver),
    [providers],
  );
  const [fold, setFold] = useState<FoldState>({ open: false, reasons: [] });
  const nextFold = foldFor(
    fold,
    foldReasons({
      targetInstanceId,
      searchTargetId,
      upstreamSearchIds: UPSTREAM_SEARCH_IDS,
      updateDrivers,
    }),
  );
  // Open before the search scroll runs, as upstream's folded sections do.
  if (nextFold !== fold) setFold(nextFold);
  // Opens the upstream list on a managed Codex instance, where it signs in.
  const openSetup = (row: AccountRow) => {
    setFold((current) => ({ ...current, open: true }));
    void navigate({
      to: "/settings/providers",
      search: { environmentId, instanceId: row.instanceId },
    });
  };

  // A sign-in shows under the row it signs in (a listed account, or an account
  // signed in again), else under its provider's header.
  const signInAccountId =
    signIn?.account && pending.some((account) => account.id === signIn.account?.id)
      ? signIn.account.id
      : null;
  const signInInstanceId =
    signIn?.instance && rows.some((row) => row.instanceId === signIn.instance?.id)
      ? signIn.instance.id
      : null;

  const refreshAll = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    if (manageable) void refresh();
    const result = await refreshProviders({ environmentId, input: { refreshModels: true } });
    refreshingRef.current = false;
    setRefreshing(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not refresh the accounts",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  const setEnabled = (row: AccountRow, enabled: boolean) => {
    // Pausing the account that writes titles and commit messages hands that back to the default, as the provider cards do.
    const resetTextGeneration =
      !enabled &&
      row.enabled &&
      resolveAppModelSelectionState(settings, providers).instanceId === row.instanceId;
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: { ...row.instance, enabled },
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: resetTextGeneration
          ? DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection
          : undefined,
      }),
    );
  };

  const remove = async (row: AccountRow, own: "own" | "managed") => {
    if (!(await confirmAction(removeQuestion(row, own)))) return;
    setRemoving(row.instanceId);
    const outcome = await apply(() =>
      client.call("account.remove", { instanceId: row.instanceId }),
    );
    setRemoving(null);
    if (!outcome.ok) {
      toastManager.add({
        type: "error",
        title: "Could not remove the account",
        description: outcome.message,
      });
    }
  };

  const skip = async (account: MoveAccount) => {
    const question = `Skip ${account.email}? It leaves this list for good. You can still add it later with Add account.`;
    if (!(await confirmAction(question))) return;
    setSkipping(account.id);
    const outcome = await apply(() => client.call("skip", { accountId: account.id }));
    setSkipping(null);
    if (!outcome.ok) {
      toastManager.add({
        type: "error",
        title: "Could not skip the account",
        description: outcome.message,
      });
    }
  };

  // Nothing to list on a server without sign-ins: the upstream page as is.
  if (unsupported && rows.length === 0) return children;

  const section = (
    <SettingsSection
      title="Accounts"
      headerAction={
        readOnly ? null : (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={refreshing}
            aria-busy={refreshing}
            onClick={() => void refreshAll()}
          >
            <RefreshIcon refreshing={refreshing} />
            Refresh
          </Button>
        )
      }
    >
      {readOnly ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          This session can view {environmentLabel}'s accounts but can't change them.
        </p>
      ) : null}
      {ACCOUNT_PROVIDERS.map((provider) => {
        const providerRows = rows.filter((row) => row.provider === provider);
        const providerPending = pending.filter((account) => account.provider === provider);
        const groupSignIn =
          signIn !== null &&
          signInAccountId === null &&
          signInInstanceId === null &&
          signIn.provider === provider
            ? signIn
            : null;
        if (!manageable && providerRows.length === 0) return null;
        return (
          <div key={provider} className="px-3 py-3 sm:px-4">
            <ProviderHeader
              provider={provider}
              signIn={groupSignIn}
              manageable={manageable}
              nextIsMain={status?.addTarget[provider] === "default"}
              addBlocked={signInRunning}
              onAdd={() => void add(provider)}
              onCancel={(signInId) => void cancel(signInId)}
            />
            {groupSignIn ? (
              <SignInDetails
                signIn={groupSignIn}
                readOnly={readOnly}
                onCode={submitCode}
                onDismiss={dismiss}
              />
            ) : null}
            {providerRows.length > 0 || providerPending.length > 0 ? (
              <div className="mt-2 grid gap-1">
                {providerRows.map((row) => {
                  const own = accountSignIn(row);
                  const rowSignIn = signInInstanceId === row.instanceId ? signIn : null;
                  return (
                    <AccountLine
                      key={row.instanceId}
                      row={row}
                      now={now}
                      readOnly={readOnly}
                      canRemove={manageable && own !== null}
                      canSignInAgain={manageable && own === "own"}
                      signIn={rowSignIn}
                      signInBlocked={signInRunning && rowSignIn === null}
                      removing={removing === row.instanceId}
                      removeBlocked={removing !== null}
                      onSetEnabled={(enabled) => setEnabled(row, enabled)}
                      onRemove={() => {
                        if (own !== null) void remove(row, own);
                      }}
                      onSignInAgain={() =>
                        void signInAgain(provider, { id: row.instanceId, label: row.label })
                      }
                      onCancel={(signInId) => void cancel(signInId)}
                      onOpenSetup={() => openSetup(row)}
                      details={
                        rowSignIn ? (
                          <SignInDetails
                            signIn={rowSignIn}
                            readOnly={readOnly}
                            onCode={submitCode}
                            onDismiss={dismiss}
                          />
                        ) : null
                      }
                    />
                  );
                })}
                {providerPending.map((account) => {
                  const own = signInAccountId === account.id ? signIn : null;
                  return (
                    <PendingLine
                      key={account.id}
                      account={account}
                      signIn={own}
                      signInBlocked={signInRunning && own === null}
                      skipping={skipping === account.id}
                      skipBlocked={skipping !== null}
                      onSignIn={() => void start(account)}
                      onSkip={() => void skip(account)}
                      onCancel={(signInId) => void cancel(signInId)}
                      details={
                        own ? (
                          <SignInDetails
                            signIn={own}
                            readOnly={readOnly}
                            onCode={submitCode}
                            onDismiss={dismiss}
                          />
                        ) : null
                      }
                    />
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </SettingsSection>
  );

  // Without sign-ins this section can't stand in for the provider list, so nothing folds away.
  if (unsupported) {
    return (
      <>
        {section}
        {children}
      </>
    );
  }
  return (
    <>
      {section}
      <MoreProviderSettings
        open={fold.open}
        onOpenChange={(open) => setFold((current) => ({ ...current, open }))}
      >
        {children}
      </MoreProviderSettings>
    </>
  );
}

/** A provider's name, where its next account lands, and Add account (Cancel while one is added). */
function ProviderHeader({
  provider,
  signIn,
  manageable,
  nextIsMain,
  addBlocked,
  onAdd,
  onCancel,
}: {
  readonly provider: MoveProvider;
  /** The sign-in adding an account of this provider, if any. */
  readonly signIn: SignIn | null;
  readonly manageable: boolean;
  /** The next account becomes the provider's default instance. */
  readonly nextIsMain: boolean;
  /** A sign-in is running somewhere in the section. */
  readonly addBlocked: boolean;
  readonly onAdd: () => void;
  readonly onCancel: (signInId: string) => void;
}) {
  const label = MOVE_PROVIDER_LABEL[provider];
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium text-foreground">{label}</h3>
        {manageable && nextIsMain ? (
          <p className="text-xs text-muted-foreground">
            The next {label} account you add becomes the main one.
          </p>
        ) : null}
      </div>
      {!manageable ? null : signIn?.phase === "waiting" ? (
        <Button
          size="xs"
          variant="outline"
          aria-label={`Cancel adding a ${ACCOUNT_KIND[provider]}`}
          onClick={() => onCancel(signIn.signInId)}
        >
          Cancel
        </Button>
      ) : (
        <Button
          size="xs"
          variant="outline"
          disabled={addBlocked}
          aria-label={`Add account for ${label}`}
          onClick={onAdd}
        >
          {signIn?.phase === "starting" ? <Spinner /> : <PlusIcon aria-hidden />}
          Add account
        </Button>
      )}
    </div>
  );
}

/** An email stays blurred until clicked; a name without one shows as is. */
function AccountName({ label }: { readonly label: string }) {
  return label.includes("@") ? (
    <RedactedSensitiveText
      value={label}
      ariaLabel="Toggle account email visibility"
      revealTooltip="Click to reveal email"
      hideTooltip="Click to hide email"
      className="max-w-full truncate text-foreground"
    />
  ) : (
    <span className="truncate text-foreground">{label}</span>
  );
}

/**
 * One instance: name, plan, main or paused, what needs attention, its quota,
 * Sign in again (Cancel while it waits) when it signed out of its own sign-in,
 * and its menu.
 */
function AccountLine({
  row,
  now,
  readOnly,
  canRemove,
  canSignInAgain,
  signIn,
  signInBlocked,
  removing,
  removeBlocked,
  onSetEnabled,
  onRemove,
  onSignInAgain,
  onCancel,
  onOpenSetup,
  details,
}: {
  readonly row: AccountRow;
  readonly now: number;
  readonly readOnly: boolean;
  readonly canRemove: boolean;
  /** The server can sign this account in again in its own config dir or home. */
  readonly canSignInAgain: boolean;
  /** This account's sign-in, if it is being signed in again. */
  readonly signIn: SignIn | null;
  /** Another sign-in is running. */
  readonly signInBlocked: boolean;
  readonly removing: boolean;
  /** Some account's removal is running. */
  readonly removeBlocked: boolean;
  readonly onSetEnabled: (enabled: boolean) => void;
  readonly onRemove: () => void;
  readonly onSignInAgain: () => void;
  readonly onCancel: (signInId: string) => void;
  /** Opens this instance in the provider list, where a managed Codex signs in. */
  readonly onOpenSetup: () => void;
  readonly details: ReactNode;
}) {
  const tone = accountTone(row);
  const { snapshot } = row;
  const signedOut = snapshot?.auth.status === "unauthenticated";
  const managedSignedOut = signedOut && isManagedCodex(row);
  const summary = getProviderSummary(snapshot);
  const limits = row.enabled && !signedOut ? snapshot?.usageLimits : undefined;
  const notice = limits ? limitsNotice(limits) : null;
  const plan = snapshot?.auth.label;
  const who = `${MOVE_PROVIDER_LABEL[row.provider]} account ${row.label}`;
  const starting = signIn?.phase === "starting";

  return (
    <div className="py-1.5">
      <div className="flex min-w-0 items-start gap-3">
        <ProviderInstanceIcon
          driverKind={row.driver}
          displayName={row.label}
          accentColor={row.instance.accentColor}
          showBadge={Boolean(row.instance.accentColor)}
          statusDotClassName={PROVIDER_STATUS_STYLES[tone].dot}
          className="mt-0.5 size-5"
          iconClassName="size-4 text-foreground/80"
        />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm",
              !row.enabled && "opacity-60",
            )}
          >
            <AccountName label={row.label} />
            {plan ? <span className="shrink-0 text-xs text-muted-foreground">{plan}</span> : null}
            {row.isDefault ? (
              <Tooltip>
                <TooltipTrigger render={<Badge variant="secondary" size="sm" tabIndex={0} />}>
                  Main
                </TooltipTrigger>
                <TooltipPopup side="top">{MAIN_ACCOUNT_HINT[row.provider]}</TooltipPopup>
              </Tooltip>
            ) : null}
            {row.enabled ? null : (
              <Badge variant="outline" size="sm">
                Paused
              </Badge>
            )}
          </div>
          {!row.enabled ? null : managedSignedOut ? (
            <p className="text-xs">
              <InlineButton tone="muted" onClick={onOpenSetup}>
                Sign in under More provider settings
              </InlineButton>
            </p>
          ) : tone === "warning" || tone === "error" ? (
            <p className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {summary.headline}
              {summary.detail ? ` · ${summary.detail}` : null}
            </p>
          ) : null}
          {limits ? (
            notice ? (
              <p className="text-xs text-muted-foreground">{notice}</p>
            ) : (
              <div className="mt-1">
                <LimitWindows compact driver={row.driver} windows={limits.windows} now={now} />
              </div>
            )
          ) : null}
        </div>
        {signIn?.phase === "waiting" ? (
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            aria-label={`Cancel signing in ${who}`}
            onClick={() => onCancel(signIn.signInId)}
          >
            Cancel
          </Button>
        ) : canSignInAgain && row.enabled && signedOut ? (
          <Button
            size="xs"
            className="shrink-0"
            disabled={starting || signInBlocked}
            aria-label={`Sign in again ${who}`}
            onClick={onSignInAgain}
          >
            {starting ? <Spinner /> : null}
            Sign in again
          </Button>
        ) : null}
        {readOnly ? null : (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-xs"
                  disabled={removing}
                  aria-label={`Actions for ${who}`}
                />
              }
            >
              {removing ? <Spinner className="size-3.5" /> : <EllipsisIcon className="size-3.5" />}
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-36">
              <MenuItem onClick={() => onSetEnabled(!row.enabled)}>
                {row.enabled ? "Pause" : "Resume"}
              </MenuItem>
              {canRemove ? (
                <>
                  <MenuSeparator />
                  <MenuItem variant="destructive" disabled={removeBlocked} onClick={onRemove}>
                    Remove…
                  </MenuItem>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        )}
      </div>
      {details ? <div className="ms-8">{details}</div> : null}
    </div>
  );
}

/** An account the retired pool held: Sign in (Retry after a failure), Skip, or Cancel while it waits. */
function PendingLine({
  account,
  signIn,
  signInBlocked,
  skipping,
  skipBlocked,
  onSignIn,
  onSkip,
  onCancel,
  details,
}: {
  readonly account: MoveAccount;
  /** This account's sign-in, if it has one. */
  readonly signIn: SignIn | null;
  /** Another sign-in is running. */
  readonly signInBlocked: boolean;
  readonly skipping: boolean;
  /** Some account's skip is running. */
  readonly skipBlocked: boolean;
  readonly onSignIn: () => void;
  readonly onSkip: () => void;
  readonly onCancel: (signInId: string) => void;
  readonly details: ReactNode;
}) {
  const starting = signIn?.phase === "starting";
  const label = MOVE_PROVIDER_LABEL[account.provider];
  // Names the account for screen readers; the email on screen may be blurred.
  const who = `${label} account ${account.email}`;
  const signInText = signIn?.phase === "error" ? "Retry" : "Sign in";
  return (
    <div className="py-1.5">
      <div className="flex min-w-0 items-center gap-3">
        <ProviderInstanceIcon
          driverKind={MOVE_DRIVER[account.provider]}
          displayName={label}
          className="size-5"
          iconClassName="size-4 text-foreground/50"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <AccountName label={account.email} />
            {account.plan ? (
              <span className="shrink-0 text-xs text-muted-foreground">{account.plan}</span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{PENDING_HINT[account.provider]}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {signIn?.phase === "waiting" ? (
            <Button
              size="xs"
              variant="outline"
              aria-label={`Cancel signing in ${who}`}
              onClick={() => onCancel(signIn.signInId)}
            >
              Cancel
            </Button>
          ) : (
            <>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={starting || skipBlocked}
                aria-label={`Skip ${who}`}
                onClick={onSkip}
              >
                {skipping ? <Spinner /> : null}
                Skip
              </Button>
              <Button
                size="xs"
                disabled={starting || signInBlocked || skipping}
                aria-label={`${signInText} ${who}`}
                onClick={onSignIn}
              >
                {starting ? <Spinner /> : null}
                {signInText}
              </Button>
            </>
          )}
        </div>
      </div>
      {details ? <div className="ms-8">{details}</div> : null}
    </div>
  );
}

/**
 * The upstream provider list, usage hubs and advanced settings, folded away:
 * they still hold models, the other providers and each instance's launch
 * settings. A link to one instance, a settings search into them or a provider
 * update to run opens it (`foldFor`).
 */
function MoreProviderSettings({
  open,
  onOpenChange,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex min-h-7 w-fit items-center gap-1.5 rounded-md px-3 text-sm text-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        More provider settings
      </button>
      {open ? <div className="flex flex-col gap-8">{children}</div> : null}
    </div>
  );
}
