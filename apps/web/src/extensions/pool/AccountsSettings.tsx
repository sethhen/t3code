/**
 * The Accounts section on top of Settings → Providers: every Claude and Codex
 * account on the environment the page shows, each a normal provider instance
 * (the default one is the main account), with its plan, status and quota. An
 * account is added with its provider's own sign-in, paused, resumed or removed
 * here; the upstream sections fold away under "More provider settings".
 *
 * Rows come from settings and the provider snapshots, exactly like the
 * provider list. The pool extension only runs sign-ins and removals, lists
 * the accounts the retired pool left, and runs Claude Code's own model
 * training setting and session limit reset for a Claude account. On a server without
 * it the rows still show (Pause and Resume are plain settings writes) and
 * nothing is folded away. Codex's banked resets are upstream's own redeem.
 */
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type EnvironmentId,
  type MoveAccount,
  type MoveProvider,
  PoolExtension,
  type PrivacyTask,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { limitsNotice } from "@t3tools/shared/usageLimits";
import { ChevronRightIcon, EllipsisIcon, ExternalLinkIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button, InlineButton } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
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
  announcesPrivacyTask,
  accountTone,
  accountWho,
  buildAccountRows,
  type ClaudePrivacyView,
  claudePrivacyView,
  codexMarkedOffAt,
  foldFor,
  foldReasons,
  type FoldState,
  followPrivacyTask,
  isManagedCodex,
  KEEP_TRAINING_OFF_HINT,
  keepOffQuestion,
  limitsClock,
  MAIN_ACCOUNT_HINT,
  PRIVACY_LINKS,
  privacyOutcome,
  removeQuestion,
  resetLine,
  resetQuestion,
  type SeenPrivacyTask,
  visiblePendingAccounts,
} from "./accounts.logic";
import { MOVE_DRIVER, MOVE_PROVIDER_LABEL, PENDING_HINT } from "./move.logic";
import {
  confirmAction,
  openInBrowser,
  PRIVACY_POLL_MS,
  type SignIn,
  SignInDetails,
  useMoveStatus,
  useSignIn,
  useStatusPolling,
} from "./signIn";
import {
  buildProviderInstanceUpdatePatch,
  EMPTY_SERVER_PROVIDERS,
  formatElapsedDurationLabel,
  getProviderSummary,
  isProviderSettingsUpdateCandidate,
  LimitWindows,
  PROVIDER_STATUS_STYLES,
  ProviderInstanceIcon,
  RedactedSensitiveText,
  ResetCredits,
  resetCreditsSummary,
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

const PRIVACY_START_FAILED: Readonly<Record<PrivacyTask, string>> = {
  check: "Could not check model training",
  turnOff: "Could not turn off model training",
  reset: "Could not use the session limit reset",
};

/** `5m ago`, `just now`; told against the last status read, so it never ticks on its own. */
function ago(iso: string, now: number): string {
  const elapsed = formatElapsedDurationLabel(iso, now);
  return elapsed === "just now" || elapsed === "" ? "just now" : `${elapsed} ago`;
}

/** A provider's own settings page, in the system browser on desktop. */
async function openLink(url: string) {
  if (await openInBrowser(url)) return;
  toastManager.add({ type: "error", title: "Could not open your browser", description: url });
}

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
  const { status, receivedAt, unsupported, refresh, apply } = useMoveStatus(client, readOnly);
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
  // The account whose model training check, change or reset waits for the server's answer.
  const [privacyStarting, setPrivacyStarting] = useState<ProviderInstanceId | null>(null);
  const [markingCodex, setMarkingCodex] = useState<ProviderInstanceId | null>(null);
  // The value "Keep model training off" was switched to, until the server answers.
  const [keepOffTarget, setKeepOffTarget] = useState<boolean | null>(null);

  const rows = useMemo(() => buildAccountRows(settings, providers), [settings, providers]);
  const [openedAt] = useState(() => Date.now());
  const now = Math.max(limitsClock(rows, openedAt), receivedAt);
  // Absent before the first status, and on servers without the accounts extension: then none of it shows.
  const privacy = status?.privacy;
  const privacyBusy = privacy?.busy !== undefined;
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
      (status === null ||
        pending.length > 0 ||
        serverSignIn !== undefined ||
        signInRunning ||
        privacyBusy),
    privacyBusy ? PRIVACY_POLL_MS : undefined,
  );
  // Says how each Claude Code task ended once a read shows it gone: always for
  // one this page started, else only when it changed something or failed.
  const seenTask = useRef<SeenPrivacyTask | null>(null);
  const startedHere = useRef(new Set<string>());
  // Every row's name as last seen, for a task whose account was removed before it ended.
  const knownLabels = useRef(new Map<string, string>());
  useEffect(() => {
    for (const row of rows) knownLabels.current.set(row.instanceId, row.label);
    if (privacy === undefined) return;
    const { seen, ended } = followPrivacyTask(seenTask.current, privacy);
    seenTask.current = seen;
    if (ended === null) return;
    const { instanceId } = ended.busy;
    const label = knownLabels.current.get(instanceId) ?? ACCOUNT_KIND.claude;
    const outcome = privacyOutcome(ended, label);
    if (announcesPrivacyTask(ended, outcome, startedHere.current.delete(instanceId))) {
      toastManager.add(outcome);
    }
  }, [privacy, rows]);
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

  const startPrivacyTask = async (row: AccountRow, task: PrivacyTask) => {
    if (task === "reset" && !(await confirmAction(resetQuestion(row)))) return;
    setPrivacyStarting(row.instanceId);
    // Before the call: its answer may already show the task running.
    startedHere.current.add(row.instanceId);
    const input = { instanceId: row.instanceId };
    const outcome = await apply(() =>
      task === "check"
        ? client.call("privacy.check", input)
        : task === "turnOff"
          ? client.call("privacy.turnOff", input)
          : client.call("reset.useClaude", input),
    );
    setPrivacyStarting(null);
    if (!outcome.ok) {
      startedHere.current.delete(row.instanceId);
      toastManager.add({
        type: "error",
        title: PRIVACY_START_FAILED[task],
        description: outcome.message,
      });
    }
  };

  const setKeepOff = async (enabled: boolean) => {
    // The switch stays where it is until the user agrees: it restarts running sessions.
    if (!(await confirmAction(keepOffQuestion(enabled)))) return;
    setKeepOffTarget(enabled);
    const outcome = await apply(() => client.call("privacy.setKeepOff", { enabled }));
    setKeepOffTarget(null);
    if (!outcome.ok) {
      toastManager.add({
        type: "error",
        title: "Could not change Keep model training off",
        description: outcome.message,
      });
    }
  };

  const markCodexOff = async (row: AccountRow, off: boolean) => {
    setMarkingCodex(row.instanceId);
    const outcome = await apply(() =>
      client.call("privacy.markCodexOff", { instanceId: row.instanceId, off }),
    );
    setMarkingCodex(null);
    if (!outcome.ok) {
      toastManager.add({
        type: "error",
        title: "Could not save that",
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
      {privacy ? (
        <KeepTrainingOff
          checked={keepOffTarget ?? privacy.keepTrainingOff}
          disabled={readOnly || keepOffTarget !== null}
          onChange={(enabled) => void setKeepOff(enabled)}
        />
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
                  // Model training and resets act on the signed-in account of an account in use.
                  const signedIn = row.enabled && row.snapshot?.auth.status !== "unauthenticated";
                  const email = row.snapshot?.auth.email;
                  const claudeView =
                    privacy && signedIn && provider === "claude"
                      ? claudePrivacyView(privacy, row.instanceId, privacyStarting)
                      : null;
                  // Removing waits for this account's Claude Code task, paused or signed out too.
                  const privacyRunning =
                    privacy?.busy?.instanceId === row.instanceId ||
                    privacyStarting === row.instanceId;
                  return (
                    <AccountLine
                      key={row.instanceId}
                      row={row}
                      environmentId={environmentId}
                      now={now}
                      readOnly={readOnly}
                      canRemove={manageable && own !== null}
                      canSignInAgain={manageable && own === "own"}
                      signIn={rowSignIn}
                      signInBlocked={signInRunning && rowSignIn === null}
                      removing={removing === row.instanceId}
                      removeBlocked={removing !== null || privacyRunning}
                      onSetEnabled={(enabled) => setEnabled(row, enabled)}
                      onRemove={() => {
                        if (own !== null) void remove(row, own);
                      }}
                      onSignInAgain={() =>
                        void signInAgain(provider, { id: row.instanceId, label: row.label })
                      }
                      onCancel={(signInId) => void cancel(signInId)}
                      onOpenSetup={() => openSetup(row)}
                      onUseReset={claudeView ? () => void startPrivacyTask(row, "reset") : null}
                      resetBlocked={claudeView?.blocked ?? true}
                      training={
                        claudeView ? (
                          <ClaudeTraining
                            row={row}
                            email={email}
                            view={claudeView}
                            now={now}
                            readOnly={readOnly}
                            onCheck={() => void startPrivacyTask(row, "check")}
                            onTurnOff={() => void startPrivacyTask(row, "turnOff")}
                          />
                        ) : privacy &&
                          signedIn &&
                          provider === "codex" &&
                          // ChatGPT's setting; an API key or Bedrock sign-in has none.
                          row.snapshot?.auth.type === "chatgpt" ? (
                          <CodexTraining
                            row={row}
                            email={email}
                            markedAt={codexMarkedOffAt(privacy, email)}
                            readOnly={readOnly}
                            marking={markingCodex === row.instanceId}
                            onMark={(off) => void markCodexOff(row, off)}
                          />
                        ) : null
                      }
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
 * One instance: name, plan, main or paused, what needs attention, its quota
 * and Codex's banked resets, its model training line, Sign in again (Cancel
 * while it waits) when it signed out of its own sign-in, and its menu.
 */
function AccountLine({
  row,
  environmentId,
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
  onUseReset,
  resetBlocked,
  training,
  details,
}: {
  readonly row: AccountRow;
  readonly environmentId: EnvironmentId;
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
  /** Some account's removal, or this account's Claude Code task, is running. */
  readonly removeBlocked: boolean;
  readonly onSetEnabled: (enabled: boolean) => void;
  readonly onRemove: () => void;
  readonly onSignInAgain: () => void;
  readonly onCancel: (signInId: string) => void;
  /** Opens this instance in the provider list, where a managed Codex signs in. */
  readonly onOpenSetup: () => void;
  /** Claude Code's session limit reset, for a signed-in Claude account. */
  readonly onUseReset: (() => void) | null;
  /** A Claude Code task runs or is starting. */
  readonly resetBlocked: boolean;
  /** The model training line. */
  readonly training: ReactNode;
  readonly details: ReactNode;
}) {
  const tone = accountTone(row);
  const { snapshot } = row;
  const signedOut = snapshot?.auth.status === "unauthenticated";
  const managedSignedOut = signedOut && isManagedCodex(row);
  const summary = getProviderSummary(snapshot);
  const limits = row.enabled && !signedOut ? snapshot?.usageLimits : undefined;
  const notice = limits ? limitsNotice(limits) : null;
  // Codex's banked resets, redeemed through the Codex app-server as Usage → Limits does.
  const credits = row.provider === "codex" ? limits?.resetCredits : undefined;
  const plan = snapshot?.auth.label;
  const who = accountWho(row);
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
          {credits === undefined ? null : readOnly ? (
            credits.availableCount > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                {resetCreditsSummary(credits, now)}
              </p>
            ) : null
          ) : (
            // Outside the menu: its confirm is a dialog. Empty (hidden) when no credit is banked.
            <div className="mt-1 empty:hidden">
              <ResetCredits
                environmentId={environmentId}
                input={{ instanceId: row.instanceId }}
                credits={credits}
                now={now}
              />
            </div>
          )}
          {training}
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
              {onUseReset ? (
                <MenuItem disabled={resetBlocked} onClick={onUseReset}>
                  Use session reset…
                </MenuItem>
              ) : null}
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

/**
 * "Keep model training off": the server checks every Claude account daily in
 * Claude Code and turns training off, and turns off Codex /feedback and
 * Claude's /bug and feedback survey; ChatGPT's setting only gets links (it has no API).
 */
function KeepTrainingOff({
  checked,
  disabled,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (enabled: boolean) => void;
}) {
  const hintId = useId();
  return (
    <div className="flex items-start gap-3 px-3 py-3 sm:px-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">Keep model training off</p>
        <p id={hintId} className="text-xs text-muted-foreground">
          {KEEP_TRAINING_OFF_HINT}
        </p>
      </div>
      <span className="flex h-5 shrink-0 items-center">
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onChange(Boolean(next))}
          aria-label="Keep model training off"
          aria-describedby={hintId}
        />
      </span>
    </div>
  );
}

/** Blurred like the row's name; Claude's and OpenAI's pages show whoever the browser is signed in as. */
function SignInAs({ email }: { readonly email: string | undefined }) {
  if (!email) return null;
  return (
    <>
      <span>· sign in there as</span>
      <AccountName label={email} />
    </>
  );
}

/**
 * A signed-in Claude account's model training, as Claude Code's own
 * `/privacy-settings` last showed it, with Turn off and Check, the claude.ai
 * page to change it by hand, and the last session limit reset's result.
 */
function ClaudeTraining({
  row,
  email,
  view,
  now,
  readOnly,
  onCheck,
  onTurnOff,
}: {
  readonly row: AccountRow;
  readonly email: string | undefined;
  readonly view: ClaudePrivacyView;
  readonly now: number;
  readonly readOnly: boolean;
  readonly onCheck: () => void;
  readonly onTurnOff: () => void;
}) {
  const { entry, running } = view;
  const who = accountWho(row);
  const idle = running === null;
  const lastReset = running === "reset" ? undefined : entry?.reset;
  return (
    <div className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
      <p className="flex flex-wrap items-center gap-x-1.5">
        <span>Model training:</span>
        <span
          role="status"
          className={cn(
            "text-foreground",
            idle && entry?.training === "on" && "text-warning-foreground",
          )}
        >
          {view.training}
        </span>
        {idle && entry?.checkedAt ? <span>· checked {ago(entry.checkedAt, now)}</span> : null}
        {readOnly ? null : (
          <>
            {view.showTurnOff ? (
              <InlineButton
                disabled={view.blocked}
                aria-label={`Turn off model training for ${who}`}
                onClick={onTurnOff}
              >
                Turn off
              </InlineButton>
            ) : null}
            {idle ? (
              <InlineButton
                tone="muted"
                disabled={view.blocked}
                aria-label={`Check model training for ${who}`}
                onClick={onCheck}
              >
                Check
              </InlineButton>
            ) : null}
          </>
        )}
      </p>
      {idle && entry?.message ? <p className="[overflow-wrap:anywhere]">{entry.message}</p> : null}
      <p className="flex flex-wrap items-center gap-x-1.5">
        <InlineButton tone="muted" onClick={() => void openLink(PRIVACY_LINKS.claude)}>
          claude.ai privacy
          <ExternalLinkIcon aria-hidden className="size-3" />
        </InlineButton>
        <SignInAs email={email} />
      </p>
      {/* The time stays outside the live region: it moves with every status read. */}
      {running === "reset" || lastReset ? (
        <p className="[overflow-wrap:anywhere]">
          {lastReset ? <span>Session reset {ago(lastReset.at, now)}: </span> : null}
          <span role="status">{lastReset ? resetLine(lastReset) : "Using the session reset…"}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * A signed-in Codex account's model training: ChatGPT has no way for apps to
 * read or change it, so only its pages, and what the user says they did there
 * (never claimed as checked).
 */
function CodexTraining({
  row,
  email,
  markedAt,
  readOnly,
  marking,
  onMark,
}: {
  readonly row: AccountRow;
  readonly email: string | undefined;
  readonly markedAt: string | undefined;
  readonly readOnly: boolean;
  readonly marking: boolean;
  readonly onMark: (off: boolean) => void;
}) {
  const markedId = useId();
  const marked = markedAt
    ? `You marked this off on ${new Date(markedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`
    : null;
  return (
    <div className="mt-1 grid gap-1 text-xs text-muted-foreground">
      <p className="flex flex-wrap items-center gap-x-1.5">
        <span>Model training: set in ChatGPT ·</span>
        <InlineButton tone="muted" onClick={() => void openLink(PRIVACY_LINKS.chatgptDataControls)}>
          Data controls
          <ExternalLinkIcon aria-hidden className="size-3" />
        </InlineButton>
        <span aria-hidden>·</span>
        <InlineButton tone="muted" onClick={() => void openLink(PRIVACY_LINKS.openaiPrivacyPortal)}>
          Privacy Portal
          <ExternalLinkIcon aria-hidden className="size-3" />
        </InlineButton>
        <SignInAs email={email} />
      </p>
      {/* The server keeps the user's word by email, so it needs the signed-in one. */}
      {!email ? null : readOnly ? (
        marked ? (
          <p>{marked}</p>
        ) : null
      ) : (
        <label className="flex w-fit cursor-pointer items-center gap-2">
          <Checkbox
            checked={markedAt !== undefined}
            disabled={marking}
            onCheckedChange={(checked) => onMark(checked === true)}
            aria-label={`I turned off model training in ChatGPT for ${accountWho(row)}`}
            aria-describedby={marked ? markedId : undefined}
          />
          <span id={markedId}>{marked ?? "I turned it off"}</span>
        </label>
      )}
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
