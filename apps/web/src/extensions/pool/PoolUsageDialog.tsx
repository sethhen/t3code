/**
 * What each signed-in account served over a period: requests, tokens, cache
 * use and what those tokens would cost at API list prices, with a stacked
 * chart by account, a model breakdown and the latest requests and errors.
 * Current subscription quotas stay separate from the selected usage period.
 * Selecting an account narrows both views to it. Polls only while open;
 * the server does every sum.
 */
import type {
  PoolAccount,
  PoolUsage,
  PoolUsageAccount,
  PoolUsageEvent,
  PoolUsageModel,
  PoolUsageRange,
  PoolUsageTotals,
} from "@t3tools/contracts";
import {
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button, InlineButton } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Skeleton } from "~/components/ui/skeleton";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { accountLabel, accountNotice, POOL_PROVIDER_LABEL, poolProviderDriver } from "./pool.logic";
import { PoolQuota } from "./PoolQuota";
import {
  bucketAxisLabel,
  buildUsageChart,
  buildUsageSeries,
  cacheHitRate,
  DEFAULT_POOL_USAGE_RANGE,
  emptyUsageMessage,
  eventStatusLabel,
  findUsageAccount,
  formatEventTime,
  formatLatency,
  inputTokens,
  isCostUnknown,
  isModelUnpriced,
  POOL_USAGE_RANGES,
  scopeUsage,
  stackSegments,
  successRate,
  totalTokens,
  type UsageChart,
  type UsageChartMetric,
  type UsageSeriesIndex,
  usageAccountShortLabel,
} from "./poolUsage.logic";
import {
  getRelativeTimeState,
  niceScale,
  PROVIDER_STATUS_STYLES,
  ProviderInstanceIcon,
  RedactedSensitiveText,
} from "./t3";
import type { PoolClient } from "./usePoolStatus";
import { usePoolUsage } from "./usePoolUsage";

const METRICS: ReadonlyArray<{ readonly value: UsageChartMetric; readonly label: string }> = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
];

const HEADING = "text-sm font-medium text-foreground";
const TH = "py-2 pe-3 font-normal";
const TH_NUM = "py-2 ps-3 text-right font-normal";
const TD = "py-2 pe-3";
const TD_NUM = "py-2 ps-3 text-right text-muted-foreground tabular-nums";

export function PoolUsageDialog({
  client,
  open,
  onOpenChange,
  accounts,
  now,
  onRefreshQuotas,
  refreshingQuotas,
  quotaRefreshDisabled,
  quotaError,
  initialAccountId,
}: {
  readonly client: PoolClient;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly accounts: readonly PoolAccount[];
  readonly now: number;
  readonly onRefreshQuotas: () => void;
  readonly refreshingQuotas: boolean;
  readonly quotaRefreshDisabled: boolean;
  readonly quotaError: string | null;
  readonly initialAccountId?: string;
}) {
  const [range, setRange] = useState<PoolUsageRange>(DEFAULT_POOL_USAGE_RANGE);
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const [selectedId, setSelectedId] = useState<string | null>(initialAccountId ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const { usage, error, refresh } = usePoolUsage(client, open ? range : null);

  // The dialog stays mounted between opens: each open starts from the account it was opened for.
  const [openedFor, setOpenedFor] = useState({ open, initialAccountId });
  if (openedFor.open !== open || openedFor.initialAccountId !== initialAccountId) {
    setOpenedFor({ open, initialAccountId });
    if (open) setSelectedId(initialAccountId ?? null);
  }

  const refreshNow = () => {
    if (refreshing) return;
    setRefreshing(true);
    void refresh().finally(() => setRefreshing(false));
  };

  const seriesIndex = useMemo(
    () => buildUsageSeries(usage?.accounts ?? [], accounts),
    [usage, accounts],
  );
  // A removed account the new period doesn't list falls back to every account.
  const selected = useMemo(
    () => (usage === null ? null : findUsageAccount(usage, selectedId)),
    [usage, selectedId],
  );
  const quotaAccountId = usage === null ? selectedId : (selected?.id ?? null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Account usage</DialogTitle>
          <DialogDescription>
            Current subscription quota, plus requests, tokens and their API-equivalent cost.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-6">
            <CurrentQuotas
              accounts={accounts}
              selectedId={quotaAccountId}
              now={now}
              onRefreshQuotas={onRefreshQuotas}
              refreshingQuotas={refreshingQuotas}
              quotaRefreshDisabled={quotaRefreshDisabled}
              quotaError={quotaError}
            />
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
                aria-label="Usage period"
                variant="segmented"
                value={[range]}
                onValueChange={(next) => {
                  const option = POOL_USAGE_RANGES.find((entry) => entry.value === next[0]);
                  if (option) setRange(option.value);
                }}
              >
                {POOL_USAGE_RANGES.map((option) => (
                  <Toggle key={option.value} value={option.value}>
                    {option.label}
                  </Toggle>
                ))}
              </ToggleGroup>
              {selected ? (
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={`${usageAccountShortLabel(selected)} only. Show every account`}
                  onClick={() => setSelectedId(null)}
                >
                  <SeriesSwatch color={seriesIndex.colorOf(selected.id)} />
                  {usageAccountShortLabel(selected)} only
                  <XIcon aria-hidden />
                </Button>
              ) : null}
              <div className="ms-auto flex min-w-0 items-center gap-2">
                {error !== null && usage !== null ? (
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-warning-foreground">
                    <Tooltip>
                      <TooltipTrigger render={<span className="truncate" />}>
                        Couldn't refresh.
                      </TooltipTrigger>
                      <TooltipPopup>{error}</TooltipPopup>
                    </Tooltip>
                    <InlineButton onClick={refreshNow}>Retry</InlineButton>
                  </span>
                ) : null}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Refresh usage history"
                  aria-busy={refreshing}
                  disabled={refreshing || usage === null}
                  onClick={refreshNow}
                >
                  <RefreshIcon size="sm" refreshing={refreshing} />
                </Button>
              </div>
            </div>

            {usage === null ? (
              error !== null ? (
                <Alert variant="error">
                  <AlertTitle>Couldn't load usage</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                  <AlertAction>
                    <Button size="xs" variant="outline" onClick={refreshNow} disabled={refreshing}>
                      Retry
                    </Button>
                  </AlertAction>
                </Alert>
              ) : (
                <UsageSkeleton />
              )
            ) : (
              <UsageDashboard
                usage={usage}
                accounts={accounts}
                seriesIndex={seriesIndex}
                selected={selected}
                onSelect={(id) => setSelectedId((current) => (current === id ? null : id))}
                metric={metric}
                onMetricChange={setMetric}
              />
            )}

            {usage !== null ? (
              <UsageNotes
                usage={usage}
                // An empty period already leads with the recording note.
                showRecordingNote={emptyUsageMessage(usage) !== usage.recordingNote?.trim()}
                onNavigate={() => onOpenChange(false)}
              />
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** Quotas render before request history, including before the pool records its first request. */
function CurrentQuotas({
  accounts,
  selectedId,
  now,
  onRefreshQuotas,
  refreshingQuotas,
  quotaRefreshDisabled,
  quotaError,
}: {
  readonly accounts: readonly PoolAccount[];
  readonly selectedId: string | null;
  readonly now: number;
  readonly onRefreshQuotas: () => void;
  readonly refreshingQuotas: boolean;
  readonly quotaRefreshDisabled: boolean;
  readonly quotaError: string | null;
}) {
  const selectedAccounts =
    selectedId === null ? accounts : accounts.filter((account) => account.id === selectedId);
  return (
    <section className="flex flex-col gap-3" aria-label="Current subscription quota">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className={HEADING}>Current subscription quota</h3>
          <p className="text-xs text-muted-foreground">
            Remaining allowance reported by the provider, independent of the usage period below.
          </p>
        </div>
        <Button
          size="xs"
          variant="ghost-muted"
          aria-label="Refresh quotas"
          aria-busy={refreshingQuotas}
          disabled={quotaRefreshDisabled || refreshingQuotas}
          onClick={onRefreshQuotas}
        >
          <RefreshIcon size="sm" refreshing={refreshingQuotas} />
          Refresh quotas
        </Button>
      </div>
      {quotaError ? (
        <p role="status" className="text-xs text-warning-foreground">
          Could not read quotas: {quotaError}{" "}
          <InlineButton
            disabled={quotaRefreshDisabled || refreshingQuotas}
            onClick={onRefreshQuotas}
          >
            Retry
          </InlineButton>
        </p>
      ) : null}
      {selectedAccounts.length === 0 ? (
        <p className="text-xs text-muted-foreground">No current quota for this account.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {selectedAccounts.map((account) => (
            <div
              key={account.id}
              className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/70 p-3"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <ProviderInstanceIcon
                  driverKind={poolProviderDriver(account.provider)}
                  displayName={POOL_PROVIDER_LABEL[account.provider]}
                  className="size-4 shrink-0"
                  iconClassName="size-3.5 text-foreground/80"
                />
                {account.email ? (
                  <RedactedSensitiveText
                    value={account.email}
                    ariaLabel="Toggle account email visibility"
                    revealTooltip="Click to reveal email"
                    hideTooltip="Click to hide email"
                    className="max-w-full truncate text-sm text-foreground"
                  />
                ) : (
                  <span className="truncate text-sm text-foreground">{accountLabel(account)}</span>
                )}
                {account.plan ? (
                  <span className="text-xs text-muted-foreground">{account.plan}</span>
                ) : null}
                {account.status === "disabled" ? (
                  <Badge variant="outline" size="sm">
                    Paused
                  </Badge>
                ) : null}
              </div>
              <PoolQuota account={account} now={now} sourceError={quotaError !== null} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function UsageDashboard({
  usage,
  accounts,
  seriesIndex,
  selected,
  onSelect,
  metric,
  onMetricChange,
}: {
  readonly usage: PoolUsage;
  readonly accounts: readonly PoolAccount[];
  readonly seriesIndex: UsageSeriesIndex;
  readonly selected: PoolUsageAccount | null;
  readonly onSelect: (accountId: string) => void;
  readonly metric: UsageChartMetric;
  readonly onMetricChange: (metric: UsageChartMetric) => void;
}) {
  const liveById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const scoped = useMemo(() => scopeUsage(usage, selected), [usage, selected]);
  const chart = useMemo(
    () => buildUsageChart(usage.buckets, seriesIndex, metric, selected?.id ?? null),
    [usage.buckets, seriesIndex, metric, selected],
  );
  const empty = emptyUsageMessage(usage);
  if (empty !== null) {
    return <p className="py-10 text-center text-sm text-muted-foreground">{empty}</p>;
  }

  return (
    <>
      <UsageTiles usage={usage} totals={scoped.totals} />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className={HEADING}>
            {usage.resolution === "hour" ? "Hourly" : "Daily"}{" "}
            {metric === "cost" ? "cost" : "tokens"}
            {selected ? null : " by account"}
          </h3>
          <ToggleGroup
            aria-label="Chart metric"
            variant="segmented"
            value={[metric]}
            onValueChange={(next) => {
              const option = METRICS.find((entry) => entry.value === next[0]);
              if (option) onMetricChange(option.value);
            }}
          >
            {METRICS.map((option) => (
              <Toggle key={option.value} value={option.value}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
        <UsageColumnChart
          chart={chart}
          metric={metric}
          resolution={usage.resolution}
          timeZone={usage.timeZone}
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className={HEADING}>Accounts</h3>
          <span className="text-xs text-muted-foreground">
            {selected
              ? "Select it again to see every account."
              : "Select an account to see only its usage."}
          </span>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {usage.accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              live={liveById.get(account.id)}
              color={seriesIndex.colorOf(account.id)}
              costUnknown={isCostUnknown(usage, account.totals)}
              selected={selected?.id === account.id}
              onSelect={() => onSelect(account.id)}
            />
          ))}
        </div>
        {usage.unattributed && usage.unattributed.requests > 0 ? (
          <NoAccountLine totals={usage.unattributed} color={seriesIndex.colorOf(undefined)} />
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className={HEADING}>Models</h3>
        <ModelTable models={scoped.models} />
      </section>

      {scoped.recentErrors.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h3 className={HEADING}>Recent errors</h3>
          <EventTable
            kind="errors"
            events={scoped.recentErrors}
            seriesIndex={seriesIndex}
            timeZone={usage.timeZone}
          />
        </section>
      ) : null}

      {scoped.recentEvents.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex min-h-7 items-center gap-2 rounded-md text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90 motion-reduce:transition-none"
            />
            Recent requests
            <span className="font-normal text-muted-foreground tabular-nums">
              {formatCount(scoped.recentEvents.length)}
            </span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="pt-3">
              <EventTable
                kind="requests"
                events={scoped.recentEvents}
                seriesIndex={seriesIndex}
                timeZone={usage.timeZone}
              />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </>
  );
}

/** The colour key beside a name: a rect, like the columns it stands for. */
function SeriesSwatch({ color }: { readonly color: string }) {
  return (
    <span aria-hidden className="size-2.5 shrink-0 rounded-xs" style={{ backgroundColor: color }} />
  );
}

function Tile({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold text-foreground">{value}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

function requestsDetail(totals: PoolUsageTotals): string {
  const rate = successRate(totals);
  if (rate === null) return "None in this period";
  const parts = [`${formatPercent(rate)} succeeded`];
  if (totals.failed > 0) parts.push(`${formatCount(totals.failed)} failed`);
  if (totals.rateLimited > 0) parts.push(`${formatCount(totals.rateLimited)} rate limited`);
  return parts.join(" · ");
}

function UsageTiles({
  usage,
  totals,
}: {
  readonly usage: PoolUsage;
  readonly totals: PoolUsageTotals;
}) {
  const costUnknown = isCostUnknown(usage, totals);
  const hit = cacheHitRate(totals.tokens);
  return (
    <section className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
      <Tile
        label="API-equivalent cost"
        value={costUnknown ? "—" : formatUsd(totals.costUsd)}
        detail={
          costUnknown
            ? "Prices unavailable"
            : `${formatUsd(totals.cacheSavingsUsd)} saved by caching`
        }
      />
      <Tile label="Requests" value={formatCount(totals.requests)} detail={requestsDetail(totals)} />
      <Tile
        label="Tokens"
        value={formatTokens(totalTokens(totals.tokens))}
        detail={`${formatTokens(inputTokens(totals.tokens))} in · ${formatTokens(totals.tokens.outputTokens)} out`}
      />
      <Tile
        label="Cache hit rate"
        value={hit === null ? "—" : formatPercent(hit)}
        detail={`${formatTokens(totals.tokens.cachedInputTokens)} read from cache`}
      />
    </section>
  );
}

const TICK_COUNT = 4;

/**
 * Stacked columns, one per bucket, bottom-up in slot order. The 2px gaps
 * between segments are cut out of the upper segment so the column top stays
 * exact; the dialog surface is translucent, so a painted gap would not read.
 * Hover (or focus and the arrow keys) shows every account's value for a column.
 */
function UsageColumnChart({
  chart,
  metric,
  resolution,
  timeZone,
}: {
  readonly chart: UsageChart;
  readonly metric: UsageChartMetric;
  readonly resolution: "hour" | "day";
  readonly timeZone: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const { max, ticks } = useMemo(() => niceScale(chart.peak, TICK_COUNT), [chart.peak]);
  const format = metric === "cost" ? formatUsd : formatTokens;
  const count = chart.columns.length;
  const activeColumn = active === null ? undefined : chart.columns[active];
  const first = chart.columns[0];
  const middle = count > 2 ? chart.columns[Math.floor((count - 1) / 2)] : undefined;
  const last = count > 1 ? chart.columns[count - 1] : undefined;
  const axisLabel = (key: string) => bucketAxisLabel(key, resolution, timeZone);
  const tickTop = (tick: number) => `${max === 0 ? 100 : (1 - tick / max) * 100}%`;
  const periodWord = resolution === "hour" ? "hours" : "days";

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step !== 0) {
      event.preventDefault();
      setActive((current) =>
        Math.min(count - 1, Math.max(0, (current ?? (step > 0 ? -1 : count)) + step)),
      );
    } else if (event.key === "Escape" && active !== null) {
      // Close the readout, not the dialog.
      event.stopPropagation();
      setActive(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        {/* Axis labels sit outside the plot so they stay aligned to gridlines. */}
        <div className="relative h-48 w-12 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
              style={{ top: tickTop(tick) }}
            >
              {tick === 0 ? "0" : format(tick)}
            </span>
          ))}
        </div>
        <div
          role="group"
          tabIndex={0}
          aria-label={`${resolution === "hour" ? "Hourly" : "Daily"} ${metric === "cost" ? "cost" : "tokens"}. Arrow keys step through the ${periodWord}.`}
          className="relative h-48 min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onMouseLeave={() => setActive(null)}
          onBlur={() => setActive(null)}
          onFocus={() => setActive((current) => current ?? (count > 0 ? count - 1 : null))}
          onKeyDown={onKeyDown}
        >
          {ticks.map((tick) => (
            <div
              key={tick}
              aria-hidden
              className={cn(
                "absolute inset-x-0 border-t",
                tick === 0 ? "border-border" : "border-border/50",
              )}
              style={{ top: tickTop(tick) }}
            />
          ))}
          <div className="absolute inset-0 flex" aria-hidden>
            {chart.columns.map((column, index) => (
              <div
                key={column.key}
                className={cn("relative h-full min-w-0 flex-1", active === index && "bg-muted/60")}
                onMouseEnter={() => setActive(index)}
              >
                <div className="absolute inset-y-0 left-1/2 w-[min(24px,70%)] -translate-x-1/2">
                  {stackSegments(column.values, max).map((segment) => (
                    <div
                      key={chart.series[segment.at]!.key}
                      className={cn("absolute inset-x-0", segment.last && "rounded-t-xs")}
                      style={{
                        backgroundColor: chart.series[segment.at]!.color,
                        bottom: segment.first
                          ? `${segment.bottom}%`
                          : `calc(${segment.bottom}% + 2px)`,
                        // A sliver of usage still shows on the baseline.
                        height: segment.first
                          ? `max(2px, ${segment.height}%)`
                          : `max(0px, calc(${segment.height}% - 2px))`,
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {chart.peak === 0 ? (
            <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
              {metric === "cost" ? "No priced usage in this period." : "No tokens in this period."}
            </p>
          ) : null}
          {activeColumn !== undefined && active !== null ? (
            <div
              aria-live="polite"
              className="surface-glass pointer-events-none absolute top-0 z-10 min-w-40 rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={
                active < count / 2
                  ? { left: `calc(${((active + 1) / count) * 100}% + 8px)` }
                  : { right: `calc(${((count - active) / count) * 100}% + 8px)` }
              }
            >
              <div className="mb-1 text-muted-foreground">
                {resolution === "hour"
                  ? formatDateTimeShort(activeColumn.key, timeZone)
                  : formatDayShort(activeColumn.key)}
              </div>
              {chart.series.map((series, at) => (
                <div key={series.key} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    <span
                      aria-hidden
                      className="h-0.5 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: series.color }}
                    />
                    <span className="truncate">{series.label}</span>
                  </span>
                  <span className="font-medium text-foreground tabular-nums">
                    {format(activeColumn.values[at] ?? 0)}
                  </span>
                </div>
              ))}
              {chart.series.length > 1 ? (
                <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-medium text-foreground tabular-nums">
                    {format(activeColumn.total)}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex justify-between ps-14 text-3xs text-muted-foreground uppercase">
        <span>{first ? axisLabel(first.key) : ""}</span>
        <span>{middle ? axisLabel(middle.key) : ""}</span>
        <span>{last ? axisLabel(last.key) : ""}</span>
      </div>
      {chart.series.length > 1 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 ps-14 text-xs text-muted-foreground">
          {chart.series.map((series) => (
            <li key={series.key} className="flex items-center gap-1.5">
              <SeriesSwatch color={series.color} />
              {series.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Removed or paused: a short badge in the card's header (longer states get their own line). */
function AccountBadge({
  account,
  live,
}: {
  readonly account: PoolUsageAccount;
  readonly live: PoolAccount | undefined;
}) {
  const label = !account.current
    ? "Removed"
    : live && accountNotice(live)?.kind === "paused"
      ? "Paused"
      : null;
  if (label === null) return null;
  return (
    <Badge variant="outline" size="sm">
      {label}
    </Badge>
  );
}

/** Cooling, in error or held back by a stale cooldown: the same words the Settings row shows. */
function AccountNoticeLine({ live }: { readonly live: PoolAccount | undefined }) {
  const notice = live ? accountNotice(live) : null;
  if (notice === null || notice.kind === "paused") return null;
  const cooling = notice.kind === "cooling";
  return (
    <p
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs",
        cooling ? "text-info-foreground" : "text-warning-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          cooling ? "bg-info" : PROVIDER_STATUS_STYLES.warning.dot,
        )}
      />
      <span className="line-clamp-2 [overflow-wrap:anywhere]">{notice.text}</span>
    </p>
  );
}

function Stat({
  label,
  value,
  warn = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly warn?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "truncate text-sm tabular-nums",
          warn ? "text-warning-foreground" : "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * One account: its address (masked), plan, state, cost and the numbers behind
 * it. The whole card selects it through a stretched button; the address sits
 * above that button so it can still be revealed.
 */
function AccountCard({
  account,
  live,
  color,
  costUnknown,
  selected,
  onSelect,
}: {
  readonly account: PoolUsageAccount;
  readonly live: PoolAccount | undefined;
  readonly color: string;
  /** Prices could not be loaded: no confident $0.00. */
  readonly costUnknown: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { totals } = account;
  const label = usageAccountShortLabel(account);
  const hit = cacheHitRate(totals.tokens);
  const lastUsed = getRelativeTimeState(account.lastUsedAt ?? null);
  const plan = live?.plan?.trim();

  return (
    <div
      className={cn(
        "relative flex min-w-0 flex-col gap-3 rounded-lg border p-3 transition-colors",
        selected ? "border-ring bg-accent/40" : "border-border/70 hover:bg-muted/40",
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={selected ? "Show every account" : `Show only ${label}`}
        className="absolute inset-0 cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onSelect}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <SeriesSwatch color={color} />
          <ProviderInstanceIcon
            driverKind={poolProviderDriver(account.provider)}
            displayName={POOL_PROVIDER_LABEL[account.provider]}
            className="size-4 shrink-0"
            iconClassName="size-3.5 text-foreground/80"
          />
          {account.email ? (
            <RedactedSensitiveText
              value={account.email}
              ariaLabel="Toggle account email visibility"
              revealTooltip="Click to reveal email"
              hideTooltip="Click to hide email"
              className="relative z-10 max-w-full truncate text-foreground"
            />
          ) : (
            <span className="truncate text-sm text-foreground">{label}</span>
          )}
          {plan ? <span className="shrink-0 text-xs text-muted-foreground">{plan}</span> : null}
          <span className="ms-auto shrink-0">
            <AccountBadge account={account} live={live} />
          </span>
        </div>
        {account.current ? <AccountNoticeLine live={live} /> : null}
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-lg font-semibold text-foreground">
          {costUnknown ? "—" : formatUsd(totals.costUsd)}
        </span>
        {lastUsed.status === "relative" ? (
          <span className="text-xs text-muted-foreground">
            Last used {lastUsed.value}
            {lastUsed.suffix ? ` ${lastUsed.suffix}` : ""}
          </span>
        ) : null}
      </div>
      <dl className="grid grid-cols-4 gap-x-3 gap-y-2">
        <Stat label="Requests" value={formatCount(totals.requests)} />
        <Stat label="Failed" value={formatCount(totals.failed)} warn={totals.failed > 0} />
        <Stat
          label="Rate limited"
          value={formatCount(totals.rateLimited)}
          warn={totals.rateLimited > 0}
        />
        <Stat label="Cache hit" value={hit === null ? "—" : formatPercent(hit)} />
        <Stat label="Input" value={formatTokens(inputTokens(totals.tokens))} />
        <Stat label="Output" value={formatTokens(totals.tokens.outputTokens)} />
        <Stat label="Latency" value={formatLatency(totals.avgLatencyMs)} />
        <Stat label="First token" value={formatLatency(totals.avgTtftMs)} />
      </dl>
    </div>
  );
}

/** Requests that reached no account at all (every one was cooling down). */
function NoAccountLine({
  totals,
  color,
}: {
  readonly totals: PoolUsageTotals;
  readonly color: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/70 px-3 py-2 text-xs text-muted-foreground">
      <SeriesSwatch color={color} />
      <span className="text-sm text-foreground">No account</span>
      <span>
        {formatCount(totals.requests)} {totals.requests === 1 ? "request" : "requests"} arrived
        while every account was cooling down
        {totals.failed > 0 && totals.failed < totals.requests
          ? ` (${formatCount(totals.failed)} failed)`
          : ""}
        .
      </span>
    </div>
  );
}

function ModelTable({ models }: { readonly models: readonly PoolUsageModel[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-160 text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className={TH}>Model</th>
            <th className={TH_NUM}>Requests</th>
            <th className={TH_NUM}>Uncached input</th>
            <th className={TH_NUM}>Cache read</th>
            <th className={TH_NUM}>Cache write</th>
            <th className={TH_NUM}>Output</th>
            <th className={TH_NUM}>Cost</th>
          </tr>
        </thead>
        <tbody>
          {models.length === 0 ? (
            <tr>
              <td colSpan={7} className="py-6 text-center text-muted-foreground">
                No model usage in this period.
              </td>
            </tr>
          ) : (
            models.map((model) => {
              const { tokens } = model.totals;
              return (
                <tr
                  key={`${model.provider}:${model.model}`}
                  className="border-b border-border/50 transition-colors hover:bg-muted/50"
                >
                  <td className={TD}>
                    <span className="flex min-w-0 items-center gap-2 text-foreground">
                      <ProviderInstanceIcon
                        driverKind={poolProviderDriver(model.provider)}
                        displayName={POOL_PROVIDER_LABEL[model.provider]}
                        className="size-4 shrink-0"
                        iconClassName="size-3.5 text-foreground/80"
                      />
                      <span className="truncate">{model.model}</span>
                    </span>
                  </td>
                  <td className={cn(TD_NUM, "text-foreground")}>
                    {formatCount(model.totals.requests)}
                  </td>
                  <td className={TD_NUM}>{formatTokens(tokens.uncachedInputTokens)}</td>
                  <td className={TD_NUM}>{formatTokens(tokens.cachedInputTokens)}</td>
                  <td className={TD_NUM}>{formatTokens(tokens.cacheCreationTokens)}</td>
                  <td className={TD_NUM}>{formatTokens(tokens.outputTokens)}</td>
                  <td className={cn(TD_NUM, !isModelUnpriced(model) && "text-foreground")}>
                    {isModelUnpriced(model) ? "Unpriced" : formatUsd(model.totals.costUsd)}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function EventTable({
  kind,
  events,
  seriesIndex,
  timeZone,
}: {
  readonly kind: "errors" | "requests";
  readonly events: readonly PoolUsageEvent[];
  readonly seriesIndex: UsageSeriesIndex;
  readonly timeZone: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full min-w-160 text-sm"
        aria-label={kind === "errors" ? "Recent errors" : "Recent requests"}
      >
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className={TH}>Time</th>
            <th className={TH}>Account</th>
            <th className={TH}>Model</th>
            {kind === "errors" ? (
              <>
                <th className={TH}>Status</th>
                <th className={TH}>Message</th>
              </>
            ) : (
              <>
                <th className={TH_NUM}>Tokens</th>
                <th className={TH_NUM}>Cost</th>
                <th className={TH_NUM}>Latency</th>
                <th className={TH_NUM}>Status</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {events.map((event, at) => (
            <tr
              // oxlint-disable-next-line react/no-array-index-key -- newest first, and two requests can share a millisecond.
              key={`${event.at}:${at}`}
              className="border-b border-border/50 align-top transition-colors hover:bg-muted/50"
            >
              <td className={cn(TD, "whitespace-nowrap text-muted-foreground tabular-nums")}>
                {formatEventTime(event.at, timeZone)}
              </td>
              <td className={cn(TD, "whitespace-nowrap")}>
                <span className="flex items-center gap-1.5 text-foreground">
                  <SeriesSwatch color={seriesIndex.colorOf(event.accountId)} />
                  {seriesIndex.labelOf(event.accountId)}
                </span>
              </td>
              <td className={cn(TD, "max-w-56 truncate text-foreground")}>{event.model}</td>
              {kind === "errors" ? (
                <>
                  <td className={cn(TD, "text-warning-foreground tabular-nums")}>
                    {eventStatusLabel(event)}
                  </td>
                  <td className={cn(TD, "min-w-64 text-muted-foreground")}>
                    <span className="line-clamp-3 [overflow-wrap:anywhere]">
                      {event.message ?? "—"}
                    </span>
                  </td>
                </>
              ) : (
                <>
                  <td className={TD_NUM}>{formatTokens(event.tokens)}</td>
                  <td className={TD_NUM}>{formatUsd(event.costUsd)}</td>
                  <td className={TD_NUM}>{formatLatency(event.latencyMs)}</td>
                  <td className={cn(TD_NUM, event.failed && "text-warning-foreground")}>
                    {eventStatusLabel(event)}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What the costs mean, where prices come from, and how far back history goes. */
function UsageNotes({
  usage,
  showRecordingNote,
  onNavigate,
}: {
  readonly usage: PoolUsage;
  readonly showRecordingNote: boolean;
  readonly onNavigate: () => void;
}) {
  const { pricing, totals } = usage;
  const recordingNote = showRecordingNote ? usage.recordingNote?.trim() : undefined;
  return (
    <footer className="flex flex-col gap-1 border-t border-border/60 pt-4 text-xs text-muted-foreground">
      <p>
        Costs are what these tokens would cost at API list prices. Subscriptions bill separately.
      </p>
      <p>
        {pricing.status === "unavailable"
          ? "Prices couldn't be loaded, so costs are missing. "
          : `Prices from ${pricing.source}${
              pricing.fetchedAt
                ? `, updated ${formatDateTimeShort(pricing.fetchedAt, usage.timeZone)}`
                : ""
            }. `}
        Set custom prices under Model prices on the{" "}
        <InlineButton tone="muted" render={<Link to="/usage" />} onClick={onNavigate}>
          Usage page
        </InlineButton>
        .
      </p>
      {totals.unpricedRequests > 0 ? (
        <p>
          {formatCount(totals.unpricedRequests)}{" "}
          {totals.unpricedRequests === 1 ? "request" : "requests"} used a model without a price and{" "}
          {totals.unpricedRequests === 1 ? "isn't" : "aren't"} in the cost.
        </p>
      ) : null}
      {usage.recordedSince || recordingNote ? (
        <p>
          {usage.recordedSince
            ? `Recorded since ${formatDateTimeShort(usage.recordedSince, usage.timeZone)}.`
            : null}
          {usage.recordedSince && recordingNote ? " " : null}
          {recordingNote}
        </p>
      ) : null}
    </footer>
  );
}

/** The loaded dialog's shape, so the first answer doesn't move anything. */
function UsageSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
        {["API-equivalent cost", "Requests", "Tokens", "Cache hit rate"].map((label) => (
          <div key={label} className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{label}</span>
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-3.5 w-32" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="ms-14 h-48" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton shape="card" className="h-36" />
        <Skeleton shape="card" className="h-36" />
      </div>
    </div>
  );
}
