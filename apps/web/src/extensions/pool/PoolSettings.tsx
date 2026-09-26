/**
 * Pool: Claude and Codex through a CLIProxyAPI account pool, at the top of
 * Settings → Providers for the environment the page shows.
 *
 * Problems first, everything else one line: the header carries the state and
 * the rare actions; accounts are the only always-open part (local pools only);
 * routing and the checks collapse to a sentence each and only appear once
 * the pool serves something. A failing or warning check is shown inline
 * without a click.
 */
import {
  type EnvironmentId,
  type PoolCheck,
  type PoolCheckState,
  PoolExtension,
  type PoolModelIssue,
  type PoolRoute,
  type PoolRouteMode,
  type PoolStatus,
} from "@t3tools/contracts";
import {
  CheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  EllipsisIcon,
  InfoIcon,
  type LucideIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { type ReactNode, useCallback, useId, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { useExtensionClient } from "../client";
import type { ProviderSettingsExtensionProps } from "../providerSettings";
import { PoolAccounts } from "./PoolAccounts";
import { PoolLoginDialog, usePoolLogin } from "./PoolLogin";
import {
  isParityVisible,
  isRoutingVisible,
  modelIssueHint,
  normalizeExternalUrl,
  orderRoutes,
  parityHeadline,
  parityProblems,
  parityProblemText,
  poolHeaderStatus,
  poolStartFailure,
  type PoolStartFailure,
  withLiveStartFailure,
  poolProviderDriver,
  routeWaitingReason,
  routingSummary,
  statusPollDelay,
  withoutCustomModel,
  type HeaderStatus,
} from "./pool.logic";
import {
  buildProviderInstanceUpdatePatch,
  getRelativeTimeState,
  PROVIDER_STATUS_STYLES,
  ProviderInstanceIcon,
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
  serverEnvironment,
  SettingsRow,
  SettingsSection,
  shellEnvironment,
  useAtomCommand,
  useEnvironmentSettings,
  useRelativeTimeTick,
  useUpdateEnvironmentSettings,
  writeTextToClipboard,
} from "./t3";
import {
  type PoolActions,
  type PoolClient,
  usePoolActions,
  usePolling,
  usePoolStatus,
} from "./usePoolStatus";

const EXTERNAL_EXPLAINER =
  "Connect to a pool server someone else runs. Sign-ins and quotas live on that server.";

const ROUTING_EXPLAINER =
  "Pool: sessions go through the pool's accounts. Direct: the provider signs in the way it would without the pool. Switching restarts that provider's running sessions.";

const ROUTE_OPTIONS = [
  { value: "pool", label: "Pool" },
  { value: "direct", label: "Direct" },
] as const satisfies ReadonlyArray<{ value: PoolRouteMode; label: string }>;

export function PoolSettings({
  environmentId,
  environmentLabel,
  readOnly,
}: ProviderSettingsExtensionProps) {
  const client = useExtensionClient(PoolExtension, environmentId);
  const pool = usePoolStatus(client, readOnly);
  const { refresh } = pool;
  const onAdded = useCallback(() => void refresh(), [refresh]);
  const login = usePoolLogin(client, onAdded);
  usePolling(refresh, pool.unsupported ? null : statusPollDelay(login.pending));
  const actions = usePoolActions(pool.apply);
  // The external form, opened from the menu before any server is connected.
  const [externalFormOpen, setExternalFormOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);

  if (pool.unsupported) return null;
  const { status } = pool;
  const runtimeState = status?.runtime.state;
  const routingVisible = status ? isRoutingVisible(status) : false;

  const runCheck = () =>
    void actions.run("check", () => client.call("check", {}), "Could not run the checks");
  const runRestart = () =>
    void actions.run("restart", () => client.call("restart", {}), "Could not restart the pool");

  return (
    <div className="flex flex-col gap-2.5">
      <SettingsSection
        title="Pool"
        headerAction={
          status ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <HeaderStatusLabel
                header={
                  pool.error
                    ? { label: "Could not refresh", tone: "warning", detail: pool.error }
                    : poolHeaderStatus(status)
                }
              />
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground hover:text-foreground"
                      disabled={readOnly}
                      aria-label="Pool actions"
                    />
                  }
                >
                  <EllipsisIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end" className="min-w-44">
                  {status.source === "local" ? (
                    <MenuItem onClick={() => setExternalFormOpen(true)}>
                      Use an external pool…
                    </MenuItem>
                  ) : null}
                  {status.source === "local" ? (
                    <MenuItem disabled={actions.isBusy("restart")} onClick={runRestart}>
                      Restart pool
                    </MenuItem>
                  ) : null}
                  <MenuItem disabled={actions.isBusy("check")} onClick={runCheck}>
                    Run checks
                  </MenuItem>
                  {routingVisible ? (
                    <MenuItem onClick={() => setRoutingOpen(true)}>Routing…</MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            </div>
          ) : null
        }
      >
        {status === null ? (
          pool.error ? (
            <SettingsRow
              title="Could not load the pool"
              description={pool.error}
              control={
                <Button size="sm" variant="outline" onClick={() => void refresh()}>
                  Retry
                </Button>
              }
            />
          ) : (
            <div className="px-3 py-3 text-sm text-muted-foreground sm:px-4">Loading…</div>
          )
        ) : (
          <>
            {status.source === "external" || externalFormOpen ? (
              <ExternalRow
                key={status.source}
                status={status}
                client={client}
                actions={actions}
                readOnly={readOnly}
                onClose={() => setExternalFormOpen(false)}
              />
            ) : null}
            {status.source === "local" ? (
              <PoolAccounts
                status={status}
                receivedAt={pool.receivedAt}
                client={client}
                actions={actions}
                readOnly={readOnly || login.pending}
                onAdd={(provider) => void login.start(provider)}
              />
            ) : null}
            {routingVisible ? (
              <RoutingRow
                routes={status.routes}
                open={routingOpen}
                onToggle={() => setRoutingOpen((open) => !open)}
                client={client}
                actions={actions}
                readOnly={readOnly}
                environmentLabel={environmentLabel}
              />
            ) : null}
            {isParityVisible(status) ? (
              <ParityRow
                checks={status.checks}
                checkedAt={status.checkedAt ?? null}
                checking={actions.isBusy("check")}
                modelIssues={status.modelIssues ?? []}
                startFailure={poolStartFailure(status)}
                environmentId={environmentId}
                readOnly={readOnly}
              />
            ) : null}
          </>
        )}
      </SettingsSection>
      <PoolLoginDialog
        login={login.login}
        preparing={runtimeState === "downloading" || runtimeState === "starting"}
        onRetry={(provider) => void login.start(provider)}
        onClose={login.close}
      />
    </div>
  );
}

/** Dot and words; the longer reason (e.g. why the pool can't start) on hover. */
function HeaderStatusLabel({ header }: { readonly header: HeaderStatus }) {
  const label = (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs",
        header.tone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", PROVIDER_STATUS_STYLES[header.tone].dot)}
      />
      <span className="max-w-72 truncate">{header.label}</span>
    </span>
  );
  if (!header.detail) return label;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex min-w-0" />}>{label}</TooltipTrigger>
      <TooltipPopup side="top" className="max-w-80 break-words">
        {header.detail}
      </TooltipPopup>
    </Tooltip>
  );
}

/** An info affordance beside a row title, styled like the page's policy tooltips. */
function InfoTip({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <Button size="icon-micro" variant="ghost-muted" aria-label={label}>
            <InfoIcon className="size-3.5" />
          </Button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        {children}
      </TooltipPopup>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// External pool

/**
 * Connected: one line with Change and Disconnect. Not yet connected (opened
 * from the menu), or changing: the URL and key form.
 */
function ExternalRow({
  status,
  client,
  actions,
  readOnly,
  onClose,
}: {
  readonly status: PoolStatus;
  readonly client: PoolClient;
  readonly actions: PoolActions;
  readonly readOnly: boolean;
  readonly onClose: () => void;
}) {
  const connected = status.source === "external";
  const [editing, setEditing] = useState(!connected);
  const [connectError, setConnectError] = useState<string | null>(null);
  const busy = actions.isBusy("source");
  const { external } = status;

  const disconnect = () =>
    void actions
      .run(
        "source",
        () => client.call("setSource", { source: "local" }),
        "Could not disconnect from the pool server",
      )
      .then(onClose);

  const connect = async (externalUrl: string, externalKey: string) => {
    setConnectError(null);
    const outcome = await actions.run(
      "source",
      () =>
        client.call("setSource", {
          source: "external",
          externalUrl,
          ...(externalKey ? { externalKey } : {}),
        }),
      null,
    );
    if (outcome === null) return false;
    if (!outcome.ok) {
      setConnectError(outcome.message);
      return false;
    }
    setEditing(false);
    onClose();
    return true;
  };

  const cancel = () => {
    setConnectError(null);
    if (connected) setEditing(false);
    else onClose();
  };

  if (connected && !editing) {
    const unreachable = external.reachable === false;
    return (
      <SettingsRow
        title={
          <span className="break-all">
            {unreachable ? "Can't reach " : "Connected to "}
            <span className="font-mono text-[0.8125rem]">{external.url}</span>
          </span>
        }
        description={
          unreachable ? (
            <span className="text-destructive-foreground">
              {external.message?.trim() || "The pool server did not answer."}
            </span>
          ) : (
            "Sign-ins and quotas live on that server."
          )
        }
        control={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={readOnly || busy}
              onClick={() => setEditing(true)}
            >
              Change
            </Button>
            <Button size="sm" variant="ghost" disabled={readOnly || busy} onClick={disconnect}>
              {busy ? <Spinner className="size-3.5" /> : null}
              Disconnect
            </Button>
          </div>
        }
      />
    );
  }

  return (
    <SettingsRow title="External pool" description={EXTERNAL_EXPLAINER}>
      <ExternalSourceForm
        status={status}
        readOnly={readOnly}
        connecting={busy}
        error={connectError}
        onConnect={connect}
        onCancel={cancel}
      />
    </SettingsRow>
  );
}

function ExternalSourceForm({
  status,
  readOnly,
  connecting,
  error,
  onConnect,
  onCancel,
}: {
  readonly status: PoolStatus;
  readonly readOnly: boolean;
  readonly connecting: boolean;
  readonly error: string | null;
  readonly onConnect: (url: string, key: string) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const id = useId();
  const { external } = status;
  const connected = status.source === "external";
  const [url, setUrl] = useState(external.url);
  const [key, setKey] = useState("");
  const normalized = normalizeExternalUrl(url);
  const changed = !connected || normalized !== external.url || key.trim() !== "";
  const canSubmit = !readOnly && !connecting && normalized !== null && changed;
  const urlInvalid = url.trim() !== "" && normalized === null;

  const submit = async () => {
    if (!canSubmit || normalized === null) return;
    if (await onConnect(normalized, key.trim())) setKey("");
  };

  return (
    <div className="space-y-2 pt-3 pb-2">
      <form
        className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-url`}>Server URL</Label>
          <Input
            id={`${id}-url`}
            size="sm"
            placeholder="https://pool.example.ts.net:8317"
            value={url}
            disabled={readOnly}
            aria-invalid={urlInvalid || undefined}
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-key`}>Key</Label>
          <Input
            id={`${id}-key`}
            size="sm"
            type="password"
            autoComplete="off"
            placeholder={external.hasKey ? "Saved" : "From the pool's owner"}
            value={key}
            disabled={readOnly}
            onChange={(event) => setKey(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canSubmit}>
            {connecting ? <Spinner className="size-3.5" /> : null}
            {connected ? "Save" : "Connect"}
          </Button>
        </div>
      </form>
      {urlInvalid ? (
        <p className="text-xs text-destructive-foreground">Enter an http or https address.</p>
      ) : null}
      {error ? <p className="text-xs break-words text-destructive-foreground">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Routing

function RoutingRow({
  routes,
  open,
  onToggle,
  client,
  actions,
  readOnly,
  environmentLabel,
}: {
  readonly routes: readonly PoolRoute[];
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly client: PoolClient;
  readonly actions: PoolActions;
  readonly readOnly: boolean;
  readonly environmentLabel: string;
}) {
  const setRoute = (route: PoolRoute, mode: PoolRouteMode) =>
    void actions.run(
      `route:${route.instanceId}`,
      () => client.call("setRoute", { instanceId: route.instanceId, mode }),
      `Could not change routing for ${route.displayName}`,
      mode,
    );

  return (
    <SettingsRow
      title="Routing"
      description={routingSummary(routes)}
      control={
        <Button size="xs" variant="ghost-muted" aria-expanded={open} onClick={onToggle}>
          {open ? "Done" : "Change"}
        </Button>
      }
    >
      {open ? (
        <div className="space-y-2 pt-2 pb-2">
          <p className="text-xs text-muted-foreground">{ROUTING_EXPLAINER}</p>
          {routes.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No Claude or Codex provider is set up on {environmentLabel}.
            </p>
          ) : (
            <div className="space-y-1">
              {orderRoutes(routes).map((route) => {
                const key = `route:${route.instanceId}`;
                const intent = actions.intent(key);
                const mode = intent === "pool" || intent === "direct" ? intent : route.mode;
                const reason = intent === undefined ? routeWaitingReason(route) : null;
                return (
                  <div key={route.instanceId} className="flex min-h-8 min-w-0 items-center gap-2">
                    <ProviderInstanceIcon
                      driverKind={poolProviderDriver(route.provider)}
                      displayName={route.displayName}
                      className="size-4"
                      iconClassName="size-3.5 text-foreground/80"
                    />
                    <span className="shrink-0 text-sm text-foreground">{route.displayName}</span>
                    {reason ? (
                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {reason}
                      </span>
                    ) : null}
                    <div className="ms-auto shrink-0">
                      <Select
                        items={ROUTE_OPTIONS}
                        value={mode}
                        disabled={readOnly || actions.isBusy(key)}
                        onValueChange={(next) => {
                          if (next === null || next === mode) return;
                          setRoute(route, next);
                        }}
                      >
                        <SelectTrigger
                          size="xs"
                          className="w-24 min-w-0"
                          aria-label={`${route.displayName} routing`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup align="end" alignItemWithTrigger={false}>
                          {ROUTE_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </SettingsRow>
  );
}

// ---------------------------------------------------------------------------
// Checks (native parity)

const CHECK_PRESENTATION: Readonly<
  Record<
    PoolCheckState,
    { readonly icon: LucideIcon; readonly className: string; readonly srLabel: string }
  >
> = {
  ok: { icon: CheckIcon, className: "text-success", srLabel: "OK" },
  warn: { icon: TriangleAlertIcon, className: "text-warning", srLabel: "Warning" },
  fail: { icon: CircleXIcon, className: "text-destructive", srLabel: "Failing" },
  unknown: { icon: CircleDashedIcon, className: "text-muted-foreground", srLabel: "Not checked" },
};

function ParityRow({
  checks,
  checkedAt,
  checking,
  modelIssues,
  startFailure,
  environmentId,
  readOnly,
}: {
  readonly checks: readonly PoolCheck[];
  readonly checkedAt: string | null;
  readonly checking: boolean;
  readonly modelIssues: readonly PoolModelIssue[];
  readonly startFailure: PoolStartFailure | null;
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const liveChecks = withLiveStartFailure(checks, startFailure);
  const problems = parityProblems(liveChecks);

  const summary =
    checking && !startFailure ? (
      <span className="inline-flex items-center gap-1.5">
        <Spinner className="size-3" /> Checking…
      </span>
    ) : problems.length > 0 ? (
      <span className="flex flex-col gap-1">
        {problems.map((check) =>
          check.id === "modelFamilies" && modelIssues.length > 0 ? (
            modelIssues.map((issue) => (
              <ModelIssueLine
                key={`${issue.instanceId}:${issue.where}:${issue.setting ?? issue.slug}`}
                issue={issue}
                environmentId={environmentId}
                readOnly={readOnly}
              />
            ))
          ) : check.id === "proxy" && startFailure ? (
            <StartFailureLine key={check.id} failure={startFailure} environmentId={environmentId} />
          ) : (
            <ParityLine key={check.id} check={check} text={parityProblemText(check)} />
          ),
        )}
      </span>
    ) : parityHeadline(checks) === "passed" ? (
      <span>
        All checks passed · <CheckedAgo iso={checkedAt} />
      </span>
    ) : (
      "Not checked yet"
    );

  return (
    <SettingsRow
      title={
        <span className="inline-flex items-center gap-1.5">
          Checks
          <InfoTip label="About checks">
            Whether a pooled session is as fast and capable as a direct one: the pool is up, each
            session keeps one account, tool search, the 1-hour cache, the advisor, and each model
            stays in its own app.
          </InfoTip>
        </span>
      }
      description={summary}
      control={
        <Button
          size="xs"
          variant="ghost-muted"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {detailsOpen ? "Hide details" : "Details"}
        </Button>
      }
    >
      {detailsOpen ? (
        <div className="space-y-1 pt-2 pb-2">
          {liveChecks.map((check) => (
            <ParityLine
              key={check.id}
              check={check}
              text={check.detail?.trim() ? `${check.label}: ${check.detail.trim()}` : check.label}
            />
          ))}
          <p className="pt-1 text-xs text-muted-foreground">
            <CheckedAgo iso={checkedAt} capitalized />
          </p>
        </div>
      ) : null}
    </SettingsRow>
  );
}

/**
 * A model of the other family on a pooled instance. T3's own custom model can
 * be removed here (the same settings write the provider card makes); aliases in
 * the user's files only say where to edit them, since the pool never writes those.
 */
function ModelIssueLine({
  issue,
  environmentId,
  readOnly,
}: {
  readonly issue: PoolModelIssue;
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const edit = withoutCustomModel(settings, issue);
  const hint = modelIssueHint(issue);
  return (
    <span className="flex flex-wrap items-start gap-x-2 gap-y-1 text-xs">
      <span className="flex min-w-0 flex-1 items-start gap-1.5">
        <CircleXIcon aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />
        <span className="sr-only">Failing: </span>
        <span className="min-w-0 break-words text-destructive-foreground">{issue.message}</span>
      </span>
      {edit ? (
        <Button
          size="xs"
          variant="outline"
          disabled={readOnly}
          onClick={() =>
            void updateSettings(
              buildProviderInstanceUpdatePatch({
                settings,
                instanceId: edit.instanceId,
                instance: edit.instance,
                driver: edit.driver,
                isDefault: edit.isDefault,
              }),
            )
          }
        >
          Remove
        </Button>
      ) : hint ? (
        <span className="text-muted-foreground">{hint}</span>
      ) : null}
    </span>
  );
}

/**
 * The local proxy not starting, in one calm line: the proxy's own words on
 * hover (and in Details), and "Show log" to reveal `proxy.log` in the file
 * manager of the machine the pool runs on (or copy its path where T3 can't).
 */
function StartFailureLine({
  failure,
  environmentId,
}: {
  readonly failure: PoolStartFailure;
  readonly environmentId: EnvironmentId;
}) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const canReveal =
    serverConfig?.shellRevealInFileManager === true &&
    serverConfig.availableEditors.includes("file-manager");
  const revealLabel = canReveal
    ? serverConfig.shellRevealInFileManagerKind === undefined
      ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
      : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind)
    : "Copy the log's path";
  const { logPath } = failure;

  const copyPath = async (path: string) => {
    try {
      await writeTextToClipboard(path, "log path");
      toastManager.add({ type: "success", title: "Log path copied", description: path });
    } catch {
      toastManager.add({ type: "error", title: "Could not copy the log path", description: path });
    }
  };
  const showLog = async () => {
    if (!logPath) return;
    if (!canReveal) return copyPath(logPath);
    const result = await openInEditor({
      environmentId,
      input: { cwd: logPath, editor: "file-manager", reveal: true },
    });
    if (result._tag === "Failure") await copyPath(logPath);
  };

  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              className="flex min-w-0 cursor-default items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <CircleXIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
          <span className="sr-only">Failing: </span>
          <span className="text-destructive-foreground">{failure.text}</span>
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-96 break-words">
          {failure.technical}
        </TooltipPopup>
      </Tooltip>
      {logPath ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="xs" variant="outline" onClick={() => void showLog()}>
                Show log
              </Button>
            }
          />
          <TooltipPopup side="top">{revealLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}

function ParityLine({ check, text }: { readonly check: PoolCheck; readonly text: string }) {
  const presentation = CHECK_PRESENTATION[check.state];
  const Icon = presentation.icon;
  return (
    <span className="flex items-start gap-1.5 text-xs">
      <Icon aria-hidden className={cn("mt-px size-3.5 shrink-0", presentation.className)} />
      <span className="sr-only">{presentation.srLabel}: </span>
      <span
        className={cn(
          "min-w-0 break-words",
          check.state === "fail"
            ? "text-destructive-foreground"
            : check.state === "warn"
              ? "text-warning-foreground"
              : "text-muted-foreground",
        )}
      >
        {text}
      </span>
    </span>
  );
}

/** "checked 2m ago", ticking like the provider list's own refresh label. */
function CheckedAgo({
  iso,
  capitalized = false,
}: {
  readonly iso: string | null;
  readonly capitalized?: boolean;
}) {
  useRelativeTimeTick();
  const verb = capitalized ? "Checked" : "checked";
  const relative = getRelativeTimeState(iso);
  if (relative.status === "missing")
    return <>{capitalized ? "Not checked yet" : "not checked yet"}</>;
  if (relative.status === "invalid") return <>{verb} at an unknown time</>;
  return relative.suffix ? (
    <>
      {verb} <span className="tabular-nums">{relative.value}</span> {relative.suffix}
    </>
  ) : (
    <>
      {verb} {relative.value}
    </>
  );
}
