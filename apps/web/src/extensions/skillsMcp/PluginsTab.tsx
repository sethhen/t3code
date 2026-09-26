/**
 * Installed plugins, one switch each: Claude's, then Codex's, with the
 * plugins that ship with Codex folded away. Switching a plugin off also
 * switches off the skills and MCP servers it brings.
 */
import type { AgentAppInfo, PluginRow, PluginsOverview } from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { cn } from "~/lib/utils";

import { Chip, ListBody, ListRow, RefreshFailed, SectionedList } from "./listControls";
import {
  APP_LABEL,
  appUnavailableReason,
  contributionSummary,
  sectionPlugins,
} from "./lists.logic";
import {
  AppNotices,
  AppSwitch,
  EmptyState,
  type Mutations,
  type OverviewState,
  RowSpinner,
  type SkillsMcpClient,
  useMutations,
  useStableActions,
} from "./shared";

const EMPTY_PLUGINS: readonly PluginRow[] = [];

const rowKey = (row: PluginRow) => `${row.app}:${row.id}`;

export function PluginsTab(props: {
  readonly client: SkillsMcpClient;
  readonly list: OverviewState<PluginsOverview>;
  /** A switch went through: skills, MCP servers and context cost may have changed. */
  readonly onChanged: () => void;
}) {
  const { client, list, onChanged } = props;
  const { data, error, reload } = list;
  const mutations = useMutations({ data, reload, onChanged });
  const installed = data?.installed ?? EMPTY_PLUGINS;
  const sections = useMemo(() => sectionPlugins(installed), [installed]);

  const actions = useStableActions({
    toggle: (row: PluginRow, enabled: boolean) =>
      mutations.mutate(
        rowKey(row),
        [
          {
            call: () =>
              client.call("plugins.mutate", {
                action: enabled ? "enable" : "disable",
                app: row.app,
                id: row.id,
              }),
            labels: { failure: `Could not ${enabled ? "enable" : "disable"} ${row.name}` },
          },
        ],
        enabled,
      ),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {data ? <AppNotices apps={data.apps} /> : null}
      {data && error ? <RefreshFailed error={error} /> : null}
      <ListBody
        loaded={data !== null}
        error={error}
        onRetry={() => void reload(true)}
        isEmpty={installed.length === 0}
        empty={
          <EmptyState
            title="No plugins"
            description="Ask an agent to install one with `claude plugin install` or Codex's /plugins."
          />
        }
        container="@container/plugin-list"
      >
        <div className="pt-1" />
        <SectionedList
          sections={sections}
          builtInHint="that ship with Codex"
          render={(row) => (
            <PluginRowView
              key={rowKey(row)}
              row={row}
              apps={data?.apps ?? []}
              mutations={mutations}
              actions={actions}
            />
          )}
        />
      </ListBody>
    </div>
  );
}

const PluginRowView = memo(function PluginRowView(props: {
  row: PluginRow;
  apps: readonly AgentAppInfo[];
  mutations: Mutations;
  actions: { readonly toggle: (row: PluginRow, enabled: boolean) => void };
}) {
  const { row, mutations, actions } = props;
  const busy = mutations.isBusy(rowKey(row));
  const enabled = mutations.optimistic(rowKey(row)) ?? row.enabled;
  const summary = contributionSummary(row) || row.description;

  return (
    <ListRow>
      <div className="min-w-0 flex-1 pl-4.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "truncate text-xs",
              enabled ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {row.name}
          </span>
          <Chip>{APP_LABEL[row.app]}</Chip>
        </div>
        {summary ? (
          <div className="truncate text-[.65rem] text-muted-foreground/80">{summary}</div>
        ) : null}
      </div>
      {busy ? <RowSpinner /> : null}
      <div className="flex w-11 shrink-0 justify-center">
        <AppSwitch
          app={row.app}
          subject={row.name}
          checked={enabled}
          blockedReason={appUnavailableReason(props.apps, row.app)}
          busy={busy}
          onCheckedChange={(checked) => actions.toggle(row, checked)}
        />
      </div>
    </ListRow>
  );
});
