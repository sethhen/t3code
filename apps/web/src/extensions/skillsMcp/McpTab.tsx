/**
 * MCP servers: one line per server with a switch per app, the user's own
 * servers first (problems on top), everything that came with Claude Code,
 * Codex, T3, claude.ai or a plugin folded away. A row expands to the per-app
 * status, its tools and its definition.
 */
import type {
  AgentApp,
  AgentAppInfo,
  ContextOverview,
  McpMutation,
  McpOverview,
  McpServerRow,
} from "@t3tools/contracts";
import { memo, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";

import { type McpCost, joinMcpCosts, mcpCostChip } from "./context.logic";
import {
  AppCell,
  Chip,
  ColumnHeader,
  ExpandButton,
  Hint,
  ListBody,
  ListRow,
  RefreshFailed,
  SectionedList,
} from "./listControls";
import {
  APP_LABEL,
  type AppControl,
  appUnavailableReason,
  capToolGroups,
  groupTools,
  type McpPrimaryAction,
  mcpAppSwitch,
  mcpIssues,
  mcpOrigin,
  mcpPrimaryAction,
  mcpRowTone,
  mcpStatusLabel,
  sectionMcpServers,
} from "./lists.logic";
import {
  APPS,
  AppNotices,
  EmptyState,
  type Mutations,
  type OverviewState,
  RowSpinner,
  type SkillsMcpClient,
  StatusDot,
  WithReason,
  useExpandedSet,
  useMutations,
  useStableActions,
  visibleApps,
} from "./shared";

const EMPTY_SERVERS: readonly McpServerRow[] = [];

/** How the server is reached; URLs lose credentials and query strings, which can carry tokens. */
function specLine(spec: McpServerRow["spec"]): string | null {
  if (!spec) return null;
  if (spec.type === "stdio") return [spec.command, ...(spec.args ?? [])].join(" ");
  try {
    const url = new URL(spec.url);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}
const TOOL_CAP = 40;
const LOGIN_HINT = "Signs in from a terminal on the machine running T3";

export function McpTab(props: {
  readonly client: SkillsMcpClient;
  readonly cwd: string | null;
  readonly list: OverviewState<McpOverview>;
  readonly context: ContextOverview | null;
  /** A switch went through: context cost may have changed. */
  readonly onChanged: () => void;
  /** Opens a terminal running the app's `mcp login`; resolves to an error message or null. */
  readonly onLogin: (name: string, app: AgentApp) => Promise<string | null>;
}) {
  const { client, cwd, list, onChanged } = props;
  const { data, error, reload } = list;
  const mutations = useMutations({ data, reload, onChanged });
  const { expanded, toggle } = useExpandedSet();

  const all = data?.servers ?? EMPTY_SERVERS;
  const columns = useMemo(() => visibleApps(data?.apps, all), [data, all]);
  const costs = useMemo(() => joinMcpCosts(all, props.context), [all, props.context]);
  const sections = useMemo(() => sectionMcpServers(all), [all]);

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
    toggle: (row: McpServerRow, app: AgentApp, control: AppControl, enabled: boolean) => {
      const failure = `Could not ${enabled ? "enable" : "disable"} ${row.name} in ${APP_LABEL[app]}`;
      const input: McpMutation | null =
        control.kind === "store"
          ? { action: "setEnabled", id: control.id, app, enabled }
          : control.kind === "claude"
            ? { action: "setClaudeEnabled", name: row.name, enabled, ...(cwd ? { cwd } : {}) }
            : null;
      if (input) mutations.mutate(`${row.key}:${app}`, [step(input, failure)], enabled);
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
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {data ? <AppNotices apps={data.apps} /> : null}
      {data && error ? <RefreshFailed error={error} /> : null}
      <ListBody
        loaded={data !== null}
        error={error}
        onRetry={() => void reload(true)}
        isEmpty={all.length === 0}
        empty={
          <EmptyState
            title="No MCP servers"
            description="Ask an agent to add one, or run `claude mcp add` / `codex mcp add`."
          />
        }
        container="@container/mcp-list"
      >
        <ColumnHeader columns={columns} />
        <SectionedList
          sections={sections}
          render={(row, builtIn) => (
            <McpRow
              key={row.key}
              row={row}
              quiet={builtIn}
              cost={costs.get(row.key)}
              expanded={expanded.has(row.key)}
              apps={data?.apps ?? []}
              columns={columns}
              mutations={mutations}
              actions={actions}
            />
          )}
        />
      </ListBody>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row

interface McpRowActions {
  readonly expand: (key: string) => void;
  readonly toggle: (
    row: McpServerRow,
    app: AgentApp,
    control: AppControl,
    enabled: boolean,
  ) => void;
  readonly primary: (row: McpServerRow, primary: McpPrimaryAction) => void;
}

const McpRow = memo(function McpRow(props: {
  row: McpServerRow;
  /** A built-in server: its problems show as the dot and the fix, never as warning lines. */
  quiet: boolean;
  cost: McpCost | undefined;
  expanded: boolean;
  apps: readonly AgentAppInfo[];
  columns: readonly AgentApp[];
  mutations: Mutations;
  actions: McpRowActions;
}) {
  const { row, expanded, columns, mutations, actions } = props;
  const busy = mutations.isBusy(row.key);
  const issues = expanded || props.quiet ? [] : mcpIssues(row);
  const primary = mcpPrimaryAction(row);
  const chip = mcpCostChip(props.cost);
  const origin = mcpOrigin(row);
  const on = APPS.some((app) => row.apps[app]?.enabled);

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
          {expanded ? <McpRowDetails row={row} /> : null}
        </>
      }
    >
      <ExpandButton expanded={expanded} name={row.name} onClick={() => actions.expand(row.key)}>
        <StatusDot tone={mcpRowTone(row)} />
        <span
          className={cn(
            "min-w-0 truncate text-xs",
            on ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {row.name}
        </span>
        {origin ? <Chip>{origin}</Chip> : null}
        <span className="flex-1" />
        {chip ? (
          <Chip hint={chip.hint} className="hidden @xs/mcp-list:inline">
            {chip.text}
          </Chip>
        ) : null}
      </ExpandButton>
      {primary ? (
        <WithReason reason={primary.kind === "login" ? LOGIN_HINT : null}>
          <Button
            size="micro"
            variant={props.quiet ? "outline" : "warning-outline"}
            disabled={busy}
            onClick={() => actions.primary(row, primary)}
          >
            {primary.label}
          </Button>
        </WithReason>
      ) : null}
      {busy ? <RowSpinner /> : null}
      {columns.map((app) => {
        const control = mcpAppSwitch(row, app);
        const key = `${row.key}:${app}`;
        return (
          <AppCell
            key={app}
            app={app}
            subject={row.name}
            enabled={mutations.optimistic(key) ?? row.apps[app]?.enabled ?? false}
            control={control}
            unavailable={appUnavailableReason(props.apps, app)}
            busy={busy || mutations.isBusy(key)}
            onToggle={(enabled) => {
              if (control) actions.toggle(row, app, control, enabled);
            }}
          />
        );
      })}
    </ListRow>
  );
});

/** Per-app status, the tools, and how the server is started. */
function McpRowDetails({ row }: { row: McpServerRow }) {
  const [showAll, setShowAll] = useState(false);
  const groups = capToolGroups(groupTools(row), showAll ? Number.POSITIVE_INFINITY : TOOL_CAP);
  const toolTotal = groups.reduce((sum, group) => sum + group.total, 0);
  const command = specLine(row.spec);
  return (
    <div className="space-y-2 px-2 pb-2.5 pl-8 text-[.7rem]">
      {row.description ? <p className="text-muted-foreground">{row.description}</p> : null}
      <ul className="space-y-0.5">
        {APPS.map((app) => {
          const entry = row.apps[app];
          if (!entry) return null;
          const status = entry.present ? mcpStatusLabel(entry) : null;
          return (
            <li key={app}>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="w-11 shrink-0 font-medium text-foreground">{APP_LABEL[app]}</span>
                <StatusDot tone={status?.tone ?? "muted"} />
                <span className="shrink-0 text-muted-foreground">
                  {status?.label ?? "Not configured"}
                </span>
                {entry.serverVersion ? (
                  <span className="text-muted-foreground/70">v{entry.serverVersion}</span>
                ) : null}
              </div>
              {entry.error ? (
                <div className="break-words pl-12.5 text-destructive-foreground">{entry.error}</div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {command ? (
        <div className="break-all font-mono text-[.65rem] text-muted-foreground">{command}</div>
      ) : null}
      {groups.map((group) => (
        <div key={group.apps.join("+")}>
          <div className="pb-0.5 font-medium text-[.65rem] text-muted-foreground uppercase tracking-wider">
            Tools · {group.apps.map((app) => APP_LABEL[app]).join(" & ")} · {group.total}
          </div>
          <ul className="space-y-px">
            {group.tools.map((tool) => (
              <li key={tool.name} className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-[.65rem] text-foreground">
                  {tool.name}
                </span>

                <Hint hint={tool.description}>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {tool.description}
                  </span>
                </Hint>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {toolTotal > TOOL_CAP && !showAll ? (
        <Button size="micro" variant="ghost" onClick={() => setShowAll(true)}>
          Show all {toolTotal} tools
        </Button>
      ) : null}
    </div>
  );
}
