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
import { DownloadIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { memo, useDeferredValue, useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";

import {
  arrangeRows,
  bareToolName,
  deferredChip,
  joinMcpStats,
  type RowStats,
  statsDetail,
  statsFor,
  tokenChip,
  toolChips,
  unusedCost,
  unusedRows,
  usageChip,
} from "./context.logic";
import {
  AppCell,
  Chip,
  ColumnHeader,
  CountLabel,
  ExpandButton,
  FacetMenu,
  FOCUS_RING,
  Hint,
  ListBody,
  type ListTabProps,
  ListRow,
  RefreshButton,
  RefreshFailed,
  SearchField,
  Sections,
  SortMenu,
  UsageControls,
  UsageFootnote,
  UsageStatus,
} from "./listControls";
import {
  ALL_FACET,
  APP_LABEL,
  appUnavailableReason,
  countAttention,
  countImportable,
  filterMcpServers,
  capToolGroups,
  groupTools,
  type McpPrimaryAction,
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
  resolveFacet,
  sectionMcpServers,
} from "./lists.logic";
import { describeSpec } from "./mcpForm.logic";
import { McpServerDialog } from "./McpServerDialog";
import {
  APPS,
  AppNotices,
  CheckedAgo,
  ConfirmDialog,
  EmptyState,
  type Mutations,
  type Opened,
  RowSpinner,
  StatusDot,
  WithReason,
  closed,
  reopen,
  useExpandedSet,
  useMutations,
  useOverviewLoader,
  useStableActions,
  visibleApps,
} from "./shared";
import { consumeLoginRefresh } from "./login";

const EMPTY_SERVERS: readonly McpServerRow[] = [];
const TOOL_CAP = 40;
const LOGIN_HINT = "Signs in from a terminal on the machine running T3";

export function McpTab(
  props: ListTabProps & {
    /** Opens a terminal running the app's `mcp login`; resolves to an error message or null. */
    readonly onLogin: (name: string, app: AgentApp) => Promise<string | null>;
  },
) {
  const { client, scopeKey, cwd, active, view, viewActions, context, usage, onChanged } = props;
  const { data, error, loading, reload } = useOverviewLoader<McpOverview>({
    name: "mcp",
    active,
    key: scopeKey,
    fetch: (refresh) => {
      // A login finished in a terminal outside the panel: skip the cached probe.
      const fresh = consumeLoginRefresh() || refresh;
      return client.call("mcp.list", {
        ...(cwd ? { cwd } : {}),
        ...(fresh ? { refresh: true } : {}),
      });
    },
  });
  const mutations = useMutations({ data, reload, onChanged });
  const { expanded, toggle } = useExpandedSet();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [facetChoice, setFacetChoice] = useState(ALL_FACET);
  const [dialog, setDialog] = useState<Opened<McpServerRow | null> | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<McpServerRow | null>(null);

  const all = data?.servers ?? EMPTY_SERVERS;
  const columns = useMemo(() => visibleApps(data?.apps, all), [data, all]);
  const stats = useMemo(() => joinMcpStats(all, context, usage), [all, context, usage]);
  const facets = useMemo(() => mcpFacets(all), [all]);
  const facet = resolveFacet(facets, facetChoice);
  const attention = useMemo(() => countAttention(all), [all]);
  const importable = useMemo(() => countImportable(all), [all]);
  const unused = useMemo(
    () => (usage ? unusedRows(all, stats) : EMPTY_SERVERS),
    [all, stats, usage],
  );
  const unusedOnly = view.unusedOnly && usage !== null;
  const shown = useMemo(
    () =>
      filterMcpServers(all, deferredQuery).filter(
        (row) =>
          mcpFacetMatches(row, facet) &&
          mutations.optimistic(row.key) !== false &&
          (!unusedOnly || stats.get(row.key)?.unused === true),
      ),
    [all, deferredQuery, facet, mutations, unusedOnly, stats],
  );
  const sections = useMemo(
    () => arrangeRows(shown, view.sort, stats, sectionMcpServers),
    [shown, view.sort, stats],
  );

  const step = (input: McpMutation, failure: string, success?: string) => ({
    call: () => client.call("mcp.mutate", input),
    labels: { failure, ...(success ? { success } : {}) },
  });
  const reconnect = (row: McpServerRow, app: AgentApp) =>
    step(
      { action: "reconnect", name: row.name, app, ...(cwd ? { cwd } : {}) },
      `Could not reconnect ${row.name} in ${APP_LABEL[app]}`,
    );
  const actions = useStableActions({
    expand: toggle,
    toggle: (row: McpServerRow, app: AgentApp, enabled: boolean) => {
      if (!row.id) return;
      const verb = enabled ? "enable" : "disable";
      mutations.mutate(
        `${row.key}:${app}`,
        [
          step(
            { action: "setEnabled", id: row.id, app, enabled },
            `Could not ${verb} ${row.name} for ${APP_LABEL[app]}`,
          ),
        ],
        enabled,
      );
    },
    primary: (row: McpServerRow, primary: McpPrimaryAction) => {
      const { id, name } = row;
      if (primary.kind === "login") {
        const app = primary.apps[0];
        if (!app) return;
        void props.onLogin(name, app).then((problem) => {
          if (problem) {
            toastManager.add({
              type: "error",
              title: `Could not sign in to ${name}`,
              description: problem,
            });
          }
        });
        return;
      }
      const steps = primary.apps.flatMap((app, index) => {
        const last = index === primary.apps.length - 1;
        if (primary.kind === "reconnect") return [reconnect(row, app)];
        if (!id) return [];
        return [
          step(
            { action: "setEnabled", id, app, enabled: true },
            `Could not restore ${name} in ${APP_LABEL[app]}`,
            last ? `Restored ${name}` : undefined,
          ),
        ];
      });
      mutations.mutate(row.key, steps);
    },
    reconnect: (row: McpServerRow, app: AgentApp) =>
      mutations.mutate(row.key, [reconnect(row, app)]),
    project: (row: McpServerRow, enabled: boolean) => {
      if (!cwd) return;
      mutations.mutate(row.key, [
        step(
          { action: "setProjectEnabled", name: row.name, cwd, enabled },
          `Could not ${enabled ? "enable" : "disable"} ${row.name} for this project`,
        ),
      ]);
    },
    edit: (row: McpServerRow) => setDialog((previous) => reopen(previous, row)),
    remove: (row: McpServerRow) => setConfirmDelete(row),
  });

  const openAdd = () => setDialog((previous) => reopen(previous, null));
  const clearFilters = () => {
    setQuery("");
    setFacetChoice(ALL_FACET);
    if (view.unusedOnly) viewActions.setUnusedOnly(false);
  };
  const liveProbeNotes = data
    ? APPS.flatMap((app) => {
        const probe = data.liveProbe[app];
        if (probe.ok || appUnavailableReason(data.apps, app)) return [];
        return [
          `${APP_LABEL[app]} live status unavailable${probe.error ? `: ${probe.error}` : ""}`,
        ];
      })
    : [];

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
          <RefreshButton
            refreshing={loading}
            onClick={() => {
              void reload(true);
              props.onRefreshContext();
            }}
            label="Refresh MCP servers"
          />
          <Button size="xs" variant="outline" onClick={openAdd}>
            <PlusIcon />
            Add
          </Button>
        </div>
        <div className="flex min-h-5 items-center gap-2 text-[.7rem] text-muted-foreground">
          <CountLabel shown={shown.length} total={all.length} noun={["server", "servers"]} />
          {attention > 0 && facet !== "attention" ? (
            <button
              type="button"
              className={cn(
                "shrink-0 rounded-sm text-warning-foreground hover:underline",
                FOCUS_RING,
              )}
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
                disabled={mutations.isBusy("import")}
                onClick={() =>
                  mutations.mutate("import", [
                    step({ action: "import" }, "Could not import servers", "Imported servers"),
                  ])
                }
              >
                <DownloadIcon />
                Import {importable}
              </Button>
            </WithReason>
          ) : null}
          <UsageStatus
            view={view}
            usage={usage}
            loading={props.usageLoading}
            error={props.usageError}
            unused={unused.length}
            cost={unusedCost(unused, stats, columns)}
          />
          <UsageControls view={view} actions={viewActions} noun="servers" />
        </div>
        {data ? <AppNotices apps={data.apps} /> : null}
        {liveProbeNotes.map((note) => (
          <div key={note} className="truncate text-[.7rem] text-muted-foreground">
            {note}
          </div>
        ))}
        {data && error ? <RefreshFailed error={error} /> : null}
      </div>
      <ListBody
        loaded={data !== null}
        error={error}
        onRetry={() => void reload(true)}
        total={all.length}
        shown={shown.length}
        onClearFilters={clearFilters}
        container="@container/mcp-list"
        empty={
          <EmptyState
            title="No MCP servers"
            description="Add a server to make its tools available in Claude and Codex."
          >
            <Button size="xs" variant="outline" onClick={openAdd}>
              <PlusIcon />
              Add server
            </Button>
          </EmptyState>
        }
        after={<UsageFootnote usage={usage} show={view.showUsage} label="Call counts" />}
      >
        <ColumnHeader label="Server" columns={columns} />
        <Sections
          sections={sections}
          render={(row) => (
            <McpRow
              key={row.key}
              row={row}
              stats={statsFor(stats, row.key)}
              days={view.days}
              showUsage={view.showUsage}
              expanded={expanded.has(row.key)}
              apps={data?.apps ?? []}
              columns={columns}
              canProject={cwd !== null}
              mutations={mutations}
              actions={actions}
            />
          )}
        />
      </ListBody>
      {dialog ? (
        <McpServerDialog
          key={dialog.key}
          open={dialog.open}
          onOpenChange={(open) => {
            if (!open) setDialog(closed);
          }}
          row={dialog.value}
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
          const failure = `Could not delete ${row.name}`;
          mutations.mutate(
            row.key,
            [step({ action: "delete", id: row.id }, failure, `Deleted ${row.name}`)],
            false,
          );
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row

interface McpRowActions {
  readonly expand: (key: string) => void;
  readonly toggle: (row: McpServerRow, app: AgentApp, enabled: boolean) => void;
  readonly primary: (row: McpServerRow, primary: McpPrimaryAction) => void;
  readonly reconnect: (row: McpServerRow, app: AgentApp) => void;
  readonly project: (row: McpServerRow, enabled: boolean) => void;
  readonly edit: (row: McpServerRow) => void;
  readonly remove: (row: McpServerRow) => void;
}

interface McpRowProps {
  readonly row: McpServerRow;
  readonly stats: RowStats;
  readonly days: number;
  readonly showUsage: boolean;
  readonly expanded: boolean;
  readonly apps: readonly AgentAppInfo[];
  readonly columns: readonly AgentApp[];
  readonly canProject: boolean;
  readonly mutations: Mutations;
  readonly actions: McpRowActions;
}

const McpRow = memo(function McpRow(props: McpRowProps) {
  const { row, stats, expanded, columns, mutations, actions } = props;
  const busy = mutations.isBusy(row.key);
  const issues = expanded ? [] : mcpIssues(row);
  const primary = mcpPrimaryAction(row);
  const toolCount = mcpToolCount(row);
  const tokens = tokenChip(stats, columns);
  const deferred = deferredChip(stats, columns);
  const calls = props.showUsage ? usageChip(stats, props.days) : null;
  const detail = statsDetail(stats, props.days).join("\n") || undefined;
  const scope = primaryScope(row);

  return (
    <ListRow
      below={
        <>
          {issues.length > 0 ? (
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
        </>
      }
    >
      <ExpandButton expanded={expanded} name={row.name} onClick={() => actions.expand(row.key)}>
        <StatusDot tone={mcpRowTone(row)} />
        <span className="min-w-0 truncate font-medium text-xs">{row.name}</span>
        {toolCount > 0 ? (
          <Chip className="hidden @xs/mcp-list:inline">
            {toolCount} {toolCount === 1 ? "tool" : "tools"}
          </Chip>
        ) : null}
        {tokens ? (
          <Chip hint={detail} className="hidden @xs/mcp-list:inline">
            {tokens}
          </Chip>
        ) : null}
        {deferred ? (
          <Chip dim hint={detail} className="hidden @sm/mcp-list:inline">
            {deferred}
          </Chip>
        ) : null}
        {calls ? (
          <Chip
            hint={detail}
            className={cn("hidden @sm/mcp-list:inline", stats.unused && "text-warning-foreground")}
          >
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
      </ExpandButton>
      {primary ? (
        <WithReason reason={primary.kind === "login" ? LOGIN_HINT : null}>
          <Button
            size="micro"
            variant="warning-outline"
            disabled={busy}
            onClick={() => actions.primary(row, primary)}
          >
            {primary.label}
          </Button>
        </WithReason>
      ) : null}
      {busy ? <RowSpinner /> : null}
      {columns.map((app) => (
        <AppCell
          key={app}
          app={app}
          subject={row.name}
          entry={row.apps[app]}
          managed={row.managed && !row.builtin}
          optimistic={mutations.optimistic(`${row.key}:${app}`)}
          reason={mcpToggleBlock(row, app) ?? appUnavailableReason(props.apps, app)}
          busy={busy || mutations.isBusy(`${row.key}:${app}`)}
          onToggle={(enabled) => actions.toggle(row, app, enabled)}
        />
      ))}
      <RowMenu row={row} canProject={props.canProject} busy={busy} actions={actions} />
    </ListRow>
  );
});

function RowMenu(props: {
  row: McpServerRow;
  canProject: boolean;
  busy: boolean;
  actions: McpRowActions;
}) {
  const { row, actions } = props;
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
        {editable ? <MenuItem onClick={() => actions.edit(row)}>Edit…</MenuItem> : null}
        {reconnectApps.map((app) => (
          <MenuItem key={app} disabled={props.busy} onClick={() => actions.reconnect(row, app)}>
            Reconnect in {APP_LABEL[app]}
          </MenuItem>
        ))}
        {project ? (
          <MenuItem disabled={props.busy} onClick={() => actions.project(row, projectOff)}>
            {projectOff ? "Enable" : "Disable"} for this project (Claude)
          </MenuItem>
        ) : null}
        {editable ? (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => actions.remove(row)}>
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
  const [showAll, setShowAll] = useState(false);
  const groups = capToolGroups(groupTools(row), showAll ? Number.POSITIVE_INFINITY : TOOL_CAP);
  const spec = row.spec ? describeSpec(row.spec) : [];
  const detail = statsDetail(stats, props.days);
  const toolTotal = groups.reduce((sum, group) => sum + group.total, 0);
  return (
    <div className="space-y-2 px-2 pb-2.5 pl-8 text-[.7rem]">
      <ul className="space-y-0.5">
        {APPS.map((app) => {
          const entry = row.apps[app];
          if (!entry) return null;
          const status = entry.present ? mcpStatusLabel(entry) : null;
          const meta = [entry.scope, entry.source, entry.serverVersion && `v${entry.serverVersion}`]
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
            Tools · {group.apps.map((app) => APP_LABEL[app]).join(" & ")} · {group.total}
          </div>
          <ul className="space-y-px">
            {group.tools.map((tool) => {
              const chips = toolChips(
                stats.tools?.get(bareToolName(tool.name, row.name)),
                group.apps,
              );
              return (
                <li key={tool.name} className="flex min-w-0 items-center gap-1.5">
                  <Hint hint={tool.name}>
                    <span className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-[.65rem] text-foreground">
                      {tool.name}
                    </span>
                  </Hint>
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
                  <Hint hint={tool.description}>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {tool.description}
                    </span>
                  </Hint>
                  {chips.cost ? <Chip dim={chips.deferredOnly}>{chips.cost}</Chip> : null}
                  {chips.calls ? <Chip>{chips.calls}</Chip> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {toolTotal > TOOL_CAP && !showAll ? (
        <Button size="micro" variant="ghost" onClick={() => setShowAll(true)}>
          Show all {toolTotal} tools
        </Button>
      ) : null}
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
              className="mr-1 truncate rounded-sm text-info-foreground hover:underline"
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
