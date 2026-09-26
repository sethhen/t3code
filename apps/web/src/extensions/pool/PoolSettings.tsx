/**
 * Pool: Claude and Codex through a CLIProxyAPI account pool, at the top of
 * Settings → Providers for the environment the page shows. Where the pool
 * runs, its accounts, which provider instances use it, and whether pooled
 * sessions still behave like native ones.
 */
import {
  type PoolCheck,
  type PoolCheckState,
  PoolExtension,
  type PoolRoute,
  type PoolRouteMode,
  type PoolStatus,
} from "@t3tools/contracts";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleXIcon,
  EllipsisIcon,
  InfoIcon,
  type LucideIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useId, useState } from "react";

import { Alert, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { useExtensionClient } from "../client";
import type { ProviderSettingsExtensionProps } from "../providerSettings";
import { PoolAccounts } from "./PoolAccounts";
import { PoolLoginDialog, usePoolLogin } from "./PoolLogin";
import {
  localSourceLabel,
  normalizeExternalUrl,
  parityFailures,
  poolHeaderStatus,
  poolProviderDriver,
  routeWaitingReason,
  statusPollDelay,
  type HeaderStatus,
} from "./pool.logic";
import {
  getRelativeTimeState,
  PROVIDER_STATUS_STYLES,
  ProviderInstanceIcon,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
  useServerConfigs,
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
  const os = useServerConfigs().get(environmentId)?.environment.platform.os;

  if (pool.unsupported) return null;
  const { status } = pool;
  const failures = status ? parityFailures(status.checks) : [];
  const runtimeState = status?.runtime.state;

  const runCheck = () =>
    void actions.run("check", () => client.call("check", {}), "Could not re-check parity");
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
                    ? { label: "Could not refresh", tone: "warning" }
                    : poolHeaderStatus(status)
                }
                detail={pool.error}
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
                <MenuPopup align="end" className="min-w-40">
                  {status.source === "local" ? (
                    <MenuItem disabled={actions.isBusy("restart")} onClick={runRestart}>
                      Restart pool
                    </MenuItem>
                  ) : null}
                  <MenuItem disabled={actions.isBusy("check")} onClick={runCheck}>
                    Re-check parity
                  </MenuItem>
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
            <SourceRow
              status={status}
              client={client}
              actions={actions}
              readOnly={readOnly}
              localLabel={localSourceLabel(os)}
              environmentLabel={environmentLabel}
            />
            <PoolAccounts
              status={status}
              receivedAt={pool.receivedAt}
              client={client}
              actions={actions}
              readOnly={readOnly || login.pending}
              onAdd={(provider) => void login.start(provider)}
            />
            <RoutingRow
              routes={status.routes}
              client={client}
              actions={actions}
              readOnly={readOnly}
              environmentLabel={environmentLabel}
            />
            <ParityRow
              checks={status.checks}
              checkedAt={status.checkedAt ?? null}
              checking={actions.isBusy("check")}
              readOnly={readOnly}
              onCheck={runCheck}
            />
          </>
        )}
      </SettingsSection>
      {failures.length > 0 ? (
        <Alert variant="error" controlAlignment="first-line">
          <CircleAlertIcon />
          {failures.map((failure) => (
            <AlertTitle key={failure} className="break-words">
              {failure}
            </AlertTitle>
          ))}
        </Alert>
      ) : null}
      <PoolLoginDialog
        login={login.login}
        preparing={runtimeState === "downloading" || runtimeState === "starting"}
        onRetry={(provider) => void login.start(provider)}
        onClose={login.close}
      />
    </div>
  );
}

/** Dot and words; long error messages truncate with the full text on hover. */
function HeaderStatusLabel({
  header,
  detail,
}: {
  readonly header: HeaderStatus;
  readonly detail: string | null;
}) {
  const full = detail ?? (header.tone === "error" ? header.label : null);
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
  if (!full) return label;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex min-w-0" />}>{label}</TooltipTrigger>
      <TooltipPopup side="top" className="max-w-80 break-words">
        {full}
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
// Source

function SourceRow({
  status,
  client,
  actions,
  readOnly,
  localLabel,
  environmentLabel,
}: {
  readonly status: PoolStatus;
  readonly client: PoolClient;
  readonly actions: PoolActions;
  readonly readOnly: boolean;
  readonly localLabel: string;
  readonly environmentLabel: string;
}) {
  // Choosing External only opens the form; the source changes when it connects.
  const [externalDraft, setExternalDraft] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const intent = actions.intent("source");
  const view =
    intent === "local" || intent === "external"
      ? intent
      : externalDraft
        ? "external"
        : status.source;

  const switchToLocal = () => {
    setExternalDraft(false);
    setConnectError(null);
    if (status.source === "local") return;
    void actions.run(
      "source",
      () => client.call("setSource", { source: "local" }),
      "Could not change the pool source",
      "local",
    );
  };

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
    setExternalDraft(false);
    return true;
  };

  return (
    <SettingsRow
      title="Source"
      description={
        view === "external"
          ? EXTERNAL_EXPLAINER
          : `The pool runs on ${environmentLabel}, with the accounts you add below.`
      }
      control={
        <ToggleGroup
          aria-label="Pool source"
          variant="segmented"
          disabled={readOnly || actions.isBusy("source")}
          value={[view]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "local") switchToLocal();
            else if (value === "external") setExternalDraft(true);
          }}
        >
          <Toggle value="local">{localLabel}</Toggle>
          <Toggle value="external">External pool</Toggle>
        </ToggleGroup>
      }
    >
      {view === "external" ? (
        <ExternalSourceForm
          key={status.external.url}
          status={status}
          readOnly={readOnly}
          connecting={actions.isBusy("source")}
          error={connectError}
          onConnect={connect}
        />
      ) : null}
    </SettingsRow>
  );
}

function ExternalSourceForm({
  status,
  readOnly,
  connecting,
  error,
  onConnect,
}: {
  readonly status: PoolStatus;
  readonly readOnly: boolean;
  readonly connecting: boolean;
  readonly error: string | null;
  readonly onConnect: (url: string, key: string) => Promise<boolean>;
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

  const reachability =
    connected && external.reachable === false ? (
      <p className="text-xs text-destructive-foreground">
        {external.message?.trim() || "The pool server did not answer."}
      </p>
    ) : connected && external.reachable && external.message?.trim() ? (
      <p className="text-xs text-muted-foreground">{external.message}</p>
    ) : null;

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
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {connecting ? <Spinner className="size-3.5" /> : null}
          {connected ? "Save" : "Connect"}
        </Button>
      </form>
      {urlInvalid ? (
        <p className="text-xs text-destructive-foreground">Enter an http or https address.</p>
      ) : null}
      {error ? <p className="text-xs break-words text-destructive-foreground">{error}</p> : null}
      {reachability}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Routing

function RoutingRow({
  routes,
  client,
  actions,
  readOnly,
  environmentLabel,
}: {
  readonly routes: readonly PoolRoute[];
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
      title={
        <span className="inline-flex items-center gap-1.5">
          Routing
          <InfoTip label="About routing">
            Pool sends a provider's sessions through the pool; Direct uses its own sign-in.
            Switching restarts that provider's running sessions.
          </InfoTip>
        </span>
      }
      description="Which providers use the pool."
    >
      <div className="space-y-1 pt-2 pb-2">
        {routes.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No Claude or Codex provider is set up on {environmentLabel}.
          </p>
        ) : (
          routes.map((route) => {
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
                  <span className="min-w-0 truncate text-xs text-muted-foreground">{reason}</span>
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
          })
        )}
      </div>
    </SettingsRow>
  );
}

// ---------------------------------------------------------------------------
// Native parity

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
  readOnly,
  onCheck,
}: {
  readonly checks: readonly PoolCheck[];
  readonly checkedAt: string | null;
  readonly checking: boolean;
  readonly readOnly: boolean;
  readonly onCheck: () => void;
}) {
  return (
    <SettingsRow
      title={
        <span className="inline-flex items-center gap-1.5">
          Native parity
          <InfoTip label="About native parity">
            What keeps a pooled session as fast and capable as a direct one. Hover a check for
            details.
          </InfoTip>
        </span>
      }
      description={
        // Nothing routed yet (e.g. a new install with no accounts): one quiet line, not a row of blanks.
        checks.length > 0 && checks.some((check) => check.state !== "unknown") ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {checks.map((check) => (
              <ParityCheck key={check.id} check={check} />
            ))}
          </span>
        ) : (
          "Checked once Claude or Codex goes through the pool."
        )
      }
      control={
        readOnly ? (
          <span className="text-xs text-muted-foreground">
            <LastChecked iso={checkedAt} />
          </span>
        ) : (
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={checking}
            aria-busy={checking}
            onClick={onCheck}
          >
            <RefreshIcon refreshing={checking} />
            <span className="sr-only">Re-check parity</span>
            <span aria-hidden className="hidden sm:inline">
              {checking ? "Checking" : checkedAt ? <LastChecked iso={checkedAt} /> : "Check now"}
            </span>
          </Button>
        )
      }
    />
  );
}

function ParityCheck({ check }: { readonly check: PoolCheck }) {
  const presentation = CHECK_PRESENTATION[check.state];
  const Icon = presentation.icon;
  const detail = check.detail?.trim();
  const content = (
    <>
      <Icon aria-hidden className={cn("size-3.5 shrink-0", presentation.className)} />
      <span className="sr-only">{presentation.srLabel}: </span>
      <span className={check.state === "fail" ? "text-destructive-foreground" : undefined}>
        {check.label}
      </span>
    </>
  );
  if (!detail) return <span className="inline-flex items-center gap-1">{content}</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="inline-flex cursor-default items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {detail}
      </TooltipPopup>
    </Tooltip>
  );
}

/** "Checked 2m ago", ticking like the provider list's own refresh label. */
function LastChecked({ iso }: { readonly iso: string | null }) {
  useRelativeTimeTick();
  const relative = getRelativeTimeState(iso);
  if (relative.status === "missing") return <>Not checked yet</>;
  if (relative.status === "invalid") return <>Checked unavailable</>;
  return relative.suffix ? (
    <>
      Checked <span className="font-mono tabular-nums">{relative.value}</span> {relative.suffix}
    </>
  ) : (
    <>Checked {relative.value}</>
  );
}
