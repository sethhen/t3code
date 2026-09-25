/**
 * MCP servers: one dense line per server (problems first), expandable to the
 * per-app status, tools with their cost and usage, and the masked spec.
 */
import type {
  AgentApp,
  AgentAppInfo,
  McpMutation,
  McpOverview,
  McpServerRow,
} from "@t3tools/contracts";
import { ChevronRightIcon, DownloadIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import {
  type ReactNode,
  memo,
  useCallback,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

import {
  bareToolName,
  deferredChip,
  formatCalls,
  formatTokens,
  isUnused,
  joinMcpStats,
  mcpIsOn,
  type RowStats,
  sortRowsBy,
  statsDetail,
  statsFor,
  tokenChip,
  unusedTokens,
  usageChip,
  usageFootnote,
} from "./context.logic";
import {
  Chip,
  FacetMenu,
  type ListTabProps,
  RefreshButton,
  SearchField,
  SortMenu,
  UsageControls,
} from "./listControls";
import {
  ALL_FACET,
  APP_LABEL,
  appUnavailableReason,
  countAttention,
  countImportable,
  filterMcpServers,
  groupTools,
  mcpCheckedAt,
  mcpFacetMatches,
  mcpFacets,
  mcpIssues,
  mcpPrimaryAction,
  mcpRowTone,
  mcpStatusLabel,
  mcpToggleBlock,
  mcpToolCount,
  primaryScope,
  type RowSection,
  resolveFacet,
  sectionMcpServers,
} from "./lists.logic";
import { describeSpec } from "./mcpForm.logic";
import { McpServerDialog } from "./McpServerDialog";
import {
  AppNotices,
  AppSwitch,
  CheckedAgo,
  ConfirmDialog,
  EmptyState,
  ListPlaceholder,
  LoadError,
  RowSpinner,
  SectionLabel,
  StatusDot,
  WithReason,
  reportMutation,
  safeCall,
  useBusyKeys,
  useOverviewLoader,
} from "./shared";

const APPS = ["claude", "codex"] as const satisfies readonly AgentApp[];
const EMPTY_SERVERS: readonly McpServerRow[] = [];

type McpRowAction =
  | { readonly type: "expand"; readonly row: McpServerRow }
  | {
      readonly type: "set-enabled";
      readonly row: McpServerRow;
      readonly app: AgentApp;
      readonly enabled: boolean;
    }
  | { readonly type: "edit"; readonly row: McpServerRow }
  | { readonly type: "delete"; readonly row: McpServerRow }
  | { readonly type: "reconnect"; readonly row: McpServerRow; readonly apps: readonly AgentApp[] }
  | { readonly type: "project"; readonly row: McpServerRow; readonly enabled: boolean };

interface MutationStep {
  readonly input: McpMutation;
  readonly labels: { readonly failure: string; readonly success?: string };
}

interface DialogState {
  readonly key: number;
  readonly open: boolean;
  readonly row: McpServerRow | null;
}

export function McpTab(props: ListTabProps) {
  const { client, scopeKey, cwd, active, view, viewActions, context, usage, onChanged } = props;
  const overview = useOverviewLoader<McpOverview>({
    active,
    key: scopeKey,
    fetch: (refresh) =>
      safeCall(client, "mcp.list", {
        ...(cwd ? { cwd } : {}),
        ...(refresh ? { refresh: true } : {}),
      }),
  });
  const { data, error, loading, reload } = overview;
  const busy = useBusyKeys();
  const runBusy = busy.run;
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [facetChoice, setFacetChoice] = useState(ALL_FACET);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<McpServerRow | null>(null);

  const all = data?.servers ?? EMPTY_SERVERS;
  const apps = data?.apps;
  const stats = useMemo(() => joinMcpStats(all, context, usage), [all, context, usage]);
  const facets = useMemo(() => mcpFacets(all), [all]);
  const facet = resolveFacet(facets, facetChoice);
  const attention = useMemo(() => countAttention(all), [all]);
  const importable = useMemo(() => countImportable(all), [all]);
  const unusedRows = useMemo(
    () =>
      usage ? all.filter((row) => isUnused(mcpIsOn(row), statsFor(stats, row.key))) : EMPTY_SERVERS,
    [all, stats, usage],
  );
  const unusedCost = useMemo(() => unusedTokens(unusedRows, stats), [unusedRows, stats]);
  const matched = useMemo(
    () => filterMcpServers(all, deferredQuery).filter((row) => mcpFacetMatches(row, facet)),
    [all, deferredQuery, facet],
  );
  const unusedOnly = view.unusedOnly && usage !== null;
  const shown = useMemo(
    () =>
      unusedOnly
        ? matched.filter((row) => isUnused(mcpIsOn(row), statsFor(stats, row.key)))
        : matched,
    [matched, unusedOnly, stats],
  );
  const sort = view.sort;
  const sections = useMemo<RowSection<McpServerRow>[]>(() => {
    if (sort === "status") return sectionMcpServers(shown);
    return [{ id: "sorted", label: "", rows: sortRowsBy(shown, sort, stats) }];
  }, [shown, sort, stats]);
  const columns = useMemo<readonly AgentApp[]>(
    () =>
      APPS.filter(
        (app) =>
          (apps ?? []).some((info) => info.app === app && info.available) ||
          all.some((row) => row.apps[app]?.present),
      ),
    [apps, all],
  );

  const mutate = useCallback(
    (
      busyKey: string,
      steps: readonly MutationStep[],
      options: { optimistic?: boolean; refresh?: boolean } = {},
    ) => {
      runBusy(
        busyKey,
        async () => {
          let changed = false;
          for (const step of steps) {
            const outcome = await safeCall(client, "mcp.mutate", step.input);
            reportMutation(outcome, step.labels);
            if (outcome.ok) changed = true;
          }
          await reload(options.refresh ?? false);
          if (changed) onChanged();
        },
        options.optimistic,
      );
    },
    [runBusy, client, reload, onChanged],
  );

  const handleAction = (action: McpRowAction) => {
    const { row } = action;
    switch (action.type) {
      case "expand":
        setExpanded((previous) => {
          const next = new Set(previous);
          if (next.has(row.key)) next.delete(row.key);
          else next.add(row.key);
          return next;
        });
        return;
      case "set-enabled": {
        if (!row.id) return;
        const verb = action.enabled ? "enable" : "disable";
        mutate(
          `${row.key}:${action.app}`,
          [
            {
              input: { action: "setEnabled", id: row.id, app: action.app, enabled: action.enabled },
              labels: { failure: `Could not ${verb} ${row.name} for ${APP_LABEL[action.app]}` },
            },
          ],
          { optimistic: action.enabled },
        );
        return;
      }
      case "edit":
        setDialog((previous) => ({ key: (previous?.key ?? 0) + 1, open: true, row }));
        return;
      case "delete":
        setConfirmDelete(row);
        return;
      case "reconnect":
        mutate(
          row.key,
          action.apps.map((app) => ({
            input: { action: "reconnect", name: row.name, app, ...(cwd ? { cwd } : {}) },
            labels: { failure: `Could not reconnect ${row.name} in ${APP_LABEL[app]}` },
          })),
          { refresh: true },
        );
        return;
      case "project": {
        if (!cwd) return;
        mutate(
          row.key,
          [
            {
              input: { action: "setProjectEnabled", name: row.name, cwd, enabled: action.enabled },
              labels: {
                failure: `Could not ${action.enabled ? "enable" : "disable"} ${row.name} for this project`,
              },
            },
          ],
          { refresh: true },
        );
        return;
      }
    }
  };
  const actionRef = useRef(handleAction);
  useLayoutEffect(() => {
    actionRef.current = handleAction;
  });
  const onAction = useCallback((action: McpRowAction) => actionRef.current(action), []);

  const openAdd = () =>
    setDialog((previous) => ({ key: (previous?.key ?? 0) + 1, open: true, row: null }));
  const runImport = () =>
    mutate("import", [
      {
        input: { action: "import" },
        labels: { failure: "Could not import servers", success: "Imported servers" },
      },
    ]);
  const refresh = () => {
    void reload(true);
    props.onRefreshContext();
  };
  const clearFilters = () => {
    setQuery("");
    setFacetChoice(ALL_FACET);
    if (view.unusedOnly) viewActions.setUnusedOnly(false);
  };

  const liveProbeNotes = data
    ? APPS.flatMap((app) => {
        const probe = data.liveProbe[app];
        const info = data.apps.find((entry) => entry.app === app);
        if (probe.ok || info?.available === false) return [];
        return [
          `${APP_LABEL[app]} live status unavailable${probe.error ? `: ${probe.error}` : ""}`,
        ];
      })
    : [];

  let body: ReactNode;
  if (data === null) {
    body = error ? (
      <LoadError message={error} onRetry={() => void reload(true)} />
    ) : (
      <ListPlaceholder rows={6} />
    );
  } else if (all.length === 0) {
    body = (
      <EmptyState
        title="No MCP servers"
        description="Add a server to make its tools available in Claude and Codex."
      >
        <Button size="xs" variant="outline" onClick={openAdd}>
          <PlusIcon />
          Add server
        </Button>
      </EmptyState>
    );
  } else if (shown.length === 0) {
    body = (
      <EmptyState title="No matches" description="Nothing matches the current search and filters.">
        <Button size="xs" variant="outline" onClick={clearFilters}>
          Clear filters
        </Button>
      </EmptyState>
    );
  } else {
    body = (
      <ScrollArea className="min-h-0 flex-1">
        <div className="@container/mcp-list pb-2">
          <div className="flex items-center gap-1.5 border-b px-2 py-1 text-[.65rem] text-muted-foreground">
            <span className="min-w-0 flex-1 pl-4.5">Server</span>
            {columns.map((app) => (
              <span key={app} className="w-12 shrink-0 text-center">
                {APP_LABEL[app]}
              </span>
            ))}
            <span className="w-6 shrink-0" />
          </div>
          {sections.map((section) => (
            <section key={section.id}>
              {section.label ? (
                <SectionLabel className="px-2">
                  {section.label} · {section.rows.length}
                </SectionLabel>
              ) : null}
              <ul>
                {section.rows.map((row) => (
                  <McpRow
                    key={row.key}
                    row={row}
                    stats={statsFor(stats, row.key)}
                    days={view.days}
                    showUsage={view.showUsage}
                    expanded={expanded.has(row.key)}
                    apps={data.apps}
                    columns={columns}
                    canProject={cwd !== null}
                    busyRow={busy.isBusy(row.key)}
                    busyClaude={busy.isBusy(`${row.key}:claude`)}
                    busyCodex={busy.isBusy(`${row.key}:codex`)}
                    optimisticClaude={busy.optimistic(`${row.key}:claude`)}
                    optimisticCodex={busy.optimistic(`${row.key}:codex`)}
                    onAction={onAction}
                  />
                ))}
              </ul>
            </section>
          ))}
          {usage && view.showUsage ? (
            <div className="px-2 pt-3 text-[.65rem] text-muted-foreground/70">
              Call counts: {usageFootnote(usage)}
            </div>
          ) : null}
        </div>
      </ScrollArea>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1 border-b px-2 py-1.5">
        <div className="flex items-center gap-1">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search servers, tools, tags"
          />
          <FacetMenu facets={facets} value={facet} total={all.length} onChange={setFacetChoice} />
          <SortMenu view={view} actions={viewActions} />
          <RefreshButton refreshing={loading} onClick={refresh} label="Refresh MCP servers" />
          <Button size="xs" variant="outline" onClick={openAdd}>
            <PlusIcon />
            Add
          </Button>
        </div>
        <div className="flex min-h-5 items-center gap-2 text-[.7rem] text-muted-foreground">
          <span className="shrink-0 tabular-nums">
            {shown.length === all.length ? all.length : `${shown.length} of ${all.length}`}{" "}
            {all.length === 1 ? "server" : "servers"}
          </span>
          {attention > 0 && facet !== "attention" ? (
            <button
              type="button"
              className="shrink-0 text-warning-foreground hover:underline"
              onClick={() => setFacetChoice("attention")}
            >
              {attention} need{attention === 1 ? "s" : ""} attention
            </button>
          ) : null}
          {data ? <CheckedAgo iso={mcpCheckedAt(data)} visible={active} /> : null}
          {importable > 0 ? (
            <WithReason reason="Adopt the servers already in your Claude and Codex user config so they can be toggled and edited here.">
              <Button
                size="micro"
                variant="ghost"
                disabled={busy.isBusy("import")}
                onClick={runImport}
              >
                <DownloadIcon />
                Import {importable}
              </Button>
            </WithReason>
          ) : null}
          <span className="min-w-0 flex-1 truncate">
            {props.usageLoading && view.showUsage ? "Loading usage…" : null}
            {!props.usageLoading && props.usageError && view.showUsage
              ? `Usage unavailable: ${props.usageError}`
              : null}
            {usage && unusedRows.length > 0 && !props.usageLoading
              ? `${unusedRows.length} unused${unusedCost > 0 ? ` · ${formatTokens(unusedCost)} tok` : ""}`
              : null}
          </span>
          <UsageControls view={view} actions={viewActions} noun="servers" />
        </div>
        {data ? <AppNotices apps={data.apps} /> : null}
        {liveProbeNotes.map((note) => (
          <div key={note} className="truncate text-[.7rem] text-muted-foreground">
            {note}
          </div>
        ))}
        {data && error ? (
          <div className="truncate text-[.7rem] text-destructive-foreground">
            Last refresh failed: {error}
          </div>
        ) : null}
      </div>
      {body}
      {dialog ? (
        <McpServerDialog
          key={dialog.key}
          open={dialog.open}
          onOpenChange={(open) =>
            setDialog((previous) => (previous ? { ...previous, open } : previous))
          }
          row={dialog.row}
          apps={data?.apps ?? []}
          client={client}
          onSaved={() => {
            void reload(false);
            onChanged();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
        title={`Delete ${confirmDelete?.name ?? "server"}?`}
        description="Removes the server from Claude, Codex and T3's store. This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          const row = confirmDelete;
          setConfirmDelete(null);
          if (!row?.id) return;
          mutate(row.key, [
            {
              input: { action: "delete", id: row.id },
              labels: { failure: `Could not delete ${row.name}`, success: `Deleted ${row.name}` },
            },
          ]);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row

interface McpRowProps {
  readonly row: McpServerRow;
  readonly stats: RowStats;
  readonly days: number;
  readonly showUsage: boolean;
  readonly expanded: boolean;
  readonly apps: readonly AgentAppInfo[];
  readonly columns: readonly AgentApp[];
  readonly canProject: boolean;
  readonly busyRow: boolean;
  readonly busyClaude: boolean;
  readonly busyCodex: boolean;
  readonly optimisticClaude: boolean | undefined;
  readonly optimisticCodex: boolean | undefined;
  readonly onAction: (action: McpRowAction) => void;
}

const McpRow = memo(function McpRow(props: McpRowProps) {
  const { row, stats, expanded, onAction } = props;
  const issues = mcpIssues(row);
  const primary = mcpPrimaryAction(row);
  const toolCount = mcpToolCount(row);
  const tokens = tokenChip(stats);
  const deferred = deferredChip(stats);
  const calls = props.showUsage ? usageChip(stats, props.days) : null;
  const unused = isUnused(mcpIsOn(row), stats);
  const scope = primaryScope(row);

  return (
    <li className="border-border/50 border-b last:border-b-0">
      <div className="flex min-h-8 items-center gap-1.5 px-2 py-1 hover:bg-accent/30">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${row.name}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => onAction({ type: "expand", row })}
        >
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              expanded && "rotate-90",
            )}
          />
          <StatusDot tone={mcpRowTone(row)} />
          <span className="min-w-0 truncate font-medium text-xs">{row.name}</span>
          {toolCount > 0 ? (
            <Chip className="hidden @xs/mcp-list:inline">
              {toolCount} {toolCount === 1 ? "tool" : "tools"}
            </Chip>
          ) : null}
          {tokens ? <Chip className="hidden @xs/mcp-list:inline">{tokens}</Chip> : null}
          {deferred ? (
            <Chip dim className="hidden @sm/mcp-list:inline">
              {deferred}
            </Chip>
          ) : null}
          {calls ? (
            <Chip className={cn("hidden @sm/mcp-list:inline", unused && "text-warning-foreground")}>
              {calls}
            </Chip>
          ) : null}
          {scope !== "user" && !row.builtin ? (
            <Badge size="sm" variant="outline" className="shrink-0">
              {scope}
            </Badge>
          ) : null}
          {row.builtin ? (
            <Badge size="sm" variant="info" className="shrink-0">
              built in
            </Badge>
          ) : null}
        </button>
        {primary ? (
          <Button
            size="micro"
            variant="warning-outline"
            disabled={props.busyRow}
            onClick={() => onAction({ type: "reconnect", row, apps: primary.apps })}
          >
            {primary.label}
          </Button>
        ) : null}
        {props.busyRow ? <RowSpinner /> : null}
        {props.columns.map((app) => (
          <AppCell
            key={app}
            row={row}
            app={app}
            apps={props.apps}
            busy={props.busyRow || (app === "claude" ? props.busyClaude : props.busyCodex)}
            optimistic={app === "claude" ? props.optimisticClaude : props.optimisticCodex}
            onAction={onAction}
          />
        ))}
        <RowMenu row={row} canProject={props.canProject} busy={props.busyRow} onAction={onAction} />
      </div>
      {!expanded && issues.length > 0 ? (
        <div className="-mt-1 space-y-px px-2 pb-1 pl-8">
          {issues.map((issue) => (
            <div
              key={issue.app}
              className={cn(
                "truncate text-[.7rem]",
                issue.tone === "destructive"
                  ? "text-destructive-foreground"
                  : "text-warning-foreground",
              )}
            >
              {APP_LABEL[issue.app]}: {issue.label}
              {issue.message ? ` · ${issue.message}` : ""}
            </div>
          ))}
        </div>
      ) : null}
      {expanded ? <McpRowDetails row={row} stats={stats} days={props.days} /> : null}
    </li>
  );
});

function AppCell(props: {
  row: McpServerRow;
  app: AgentApp;
  apps: readonly AgentAppInfo[];
  busy: boolean;
  optimistic: boolean | undefined;
  onAction: (action: McpRowAction) => void;
}) {
  const { row, app } = props;
  const entry = row.apps[app];
  if (!entry && !row.managed) {
    return <span className="w-12 shrink-0 text-center text-muted-foreground/40 text-xs">–</span>;
  }
  const status = entry?.present ? mcpStatusLabel(entry) : null;
  const block = appUnavailableReason(props.apps, app) ?? mcpToggleBlock(row, app);
  return (
    <div className="flex w-12 shrink-0 items-center justify-center gap-1">
      <WithReason reason={`${APP_LABEL[app]}: ${status?.label ?? "not configured"}`}>
        <StatusDot tone={status?.tone ?? "muted"} className={cn(!status && "opacity-40")} />
      </WithReason>
      <AppSwitch
        compact
        app={app}
        subject={row.name}
        checked={props.optimistic ?? entry?.enabled ?? false}
        blockedReason={block}
        busy={props.busy}
        onCheckedChange={(enabled) => props.onAction({ type: "set-enabled", row, app, enabled })}
      />
    </div>
  );
}

function RowMenu(props: {
  row: McpServerRow;
  canProject: boolean;
  busy: boolean;
  onAction: (action: McpRowAction) => void;
}) {
  const { row, onAction } = props;
  const editable = row.managed && !row.builtin && row.id !== undefined;
  const reconnectApps = APPS.filter((app) => row.apps[app]?.present && row.apps[app]?.enabled);
  const claude = row.apps.claude;
  const project = props.canProject && !row.builtin && claude?.present === true;
  const projectOff = claude?.status === "disabled";
  if (!editable && reconnectApps.length === 0 && !project) return <span className="w-6 shrink-0" />;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Actions for ${row.name}`}
            className="w-6 shrink-0"
          />
        }
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup align="end" className="w-52">
        {editable ? (
          <MenuItem onClick={() => onAction({ type: "edit", row })}>Edit…</MenuItem>
        ) : null}
        {reconnectApps.map((app) => (
          <MenuItem
            key={app}
            disabled={props.busy}
            onClick={() => onAction({ type: "reconnect", row, apps: [app] })}
          >
            Reconnect in {APP_LABEL[app]}
          </MenuItem>
        ))}
        {project ? (
          <MenuItem
            disabled={props.busy}
            onClick={() => onAction({ type: "project", row, enabled: projectOff })}
          >
            {projectOff ? "Enable" : "Disable"} for this project (Claude)
          </MenuItem>
        ) : null}
        {editable ? (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => onAction({ type: "delete", row })}>
              Delete…
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function McpRowDetails(props: { row: McpServerRow; stats: RowStats; days: number }) {
  const { row, stats } = props;
  const groups = groupTools(row);
  const spec = row.spec ? describeSpec(row.spec) : [];
  const detail = statsDetail(stats, props.days);
  return (
    <div className="space-y-2 px-2 pb-2.5 pl-8 text-[.7rem]">
      <ul className="space-y-0.5">
        {APPS.map((app) => {
          const entry = row.apps[app];
          if (!entry) return null;
          const status = entry.present ? mcpStatusLabel(entry) : null;
          const meta = [
            entry.scope,
            entry.source,
            entry.serverVersion ? `v${entry.serverVersion}` : undefined,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={app}>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="w-11 shrink-0 font-medium text-foreground">{APP_LABEL[app]}</span>
                <StatusDot tone={status?.tone ?? "muted"} />
                <span className="shrink-0 text-muted-foreground">
                  {status?.label ?? "Not configured"}
                </span>
                <span className="min-w-0 truncate text-muted-foreground/70">{meta}</span>
              </div>
              {entry.error ? (
                <div className="break-words pl-12.5 text-destructive-foreground">{entry.error}</div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {detail.length > 0 ? (
        <div className="space-y-px text-muted-foreground">
          {detail.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      ) : null}
      {groups.map((group) => (
        <div key={group.apps.join("+")}>
          <div className="pb-0.5 font-medium text-[.65rem] text-muted-foreground uppercase tracking-wider">
            Tools · {group.apps.map((app) => APP_LABEL[app]).join(" & ")} · {group.tools.length}
          </div>
          <ul className="space-y-px">
            {group.tools.map((tool) => {
              const stat = stats.tools?.get(bareToolName(tool.name, row.name));
              return (
                <li key={tool.name} className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 font-mono text-[.65rem] text-foreground">
                    {tool.name}
                  </span>
                  {tool.readOnly ? (
                    <Badge size="sm" variant="outline" className="shrink-0">
                      read-only
                    </Badge>
                  ) : null}
                  {tool.destructive ? (
                    <Badge size="sm" variant="error" className="shrink-0">
                      destructive
                    </Badge>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {tool.description ? (
                      <WithReason reason={tool.description}>
                        <span className="truncate">{tool.description}</span>
                      </WithReason>
                    ) : null}
                  </span>
                  {stat?.tokens !== undefined ? (
                    <Chip dim={stat.loaded === false}>
                      {formatTokens(stat.tokens)}
                      {stat.loaded === false ? " deferred" : " tok"}
                    </Chip>
                  ) : null}
                  {stat?.calls !== undefined ? <Chip>{formatCalls(stat.calls)}</Chip> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {spec.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
          {spec.map((line, index) => (
            <div key={`${line.label}:${index}`} className="contents">
              <dt className="text-muted-foreground">{line.label}</dt>
              <dd className="break-all font-mono text-[.65rem] text-foreground">{line.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {row.description ? <p className="text-muted-foreground">{row.description}</p> : null}
      {row.homepage || row.tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {row.homepage ? (
            <a
              href={row.homepage}
              target="_blank"
              rel="noreferrer"
              className="mr-1 truncate text-info-foreground hover:underline"
            >
              {row.homepage.replace(/^https?:\/\//, "")}
            </a>
          ) : null}
          {row.tags.map((tag) => (
            <Badge key={tag} size="sm" variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
