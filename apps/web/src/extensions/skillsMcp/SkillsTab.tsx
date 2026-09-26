/**
 * Skills: one line per skill with a switch per app, the user's own skills
 * first, the ones that came with Claude Code, Codex, claude.ai or a plugin
 * folded away. A row expands to its description and folders.
 */
import type {
  AgentApp,
  AgentAppInfo,
  SkillRow,
  SkillsMutation,
  SkillsOverview,
} from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { cn } from "~/lib/utils";

import {
  AppCell,
  Chip,
  ColumnHeader,
  ExpandButton,
  ListBody,
  ListRow,
  RefreshFailed,
  SectionedList,
} from "./listControls";
import {
  APP_LABEL,
  type AppControl,
  appUnavailableReason,
  sectionSkills,
  skillAppSwitch,
  skillOrigin,
} from "./lists.logic";
import {
  APPS,
  AppNotices,
  EmptyState,
  type Mutations,
  type OverviewState,
  RowSpinner,
  type SkillsMcpClient,
  WithReason,
  useExpandedSet,
  useMutations,
  useStableActions,
  visibleApps,
} from "./shared";

const EMPTY_SKILLS: readonly SkillRow[] = [];

export function SkillsTab(props: {
  readonly client: SkillsMcpClient;
  readonly list: OverviewState<SkillsOverview>;
  /** A switch went through: context cost may have changed. */
  readonly onChanged: () => void;
}) {
  const { client, list, onChanged } = props;
  const { data, error, reload } = list;
  const mutations = useMutations({ data, reload, onChanged });
  const { expanded, toggle } = useExpandedSet();

  const all = data?.skills ?? EMPTY_SKILLS;
  const columns = useMemo(() => visibleApps(data?.apps, all), [data, all]);
  const sections = useMemo(() => sectionSkills(all), [all]);

  const actions = useStableActions({
    expand: toggle,
    toggle: (row: SkillRow, app: AgentApp, control: AppControl, enabled: boolean) => {
      const input: SkillsMutation | null =
        control.kind === "store"
          ? { action: "setEnabled", id: control.id, app, enabled }
          : control.kind === "native"
            ? {
                action: "setAppEnabled",
                app,
                name: row.name,
                ...(control.path ? { path: control.path } : {}),
                enabled,
              }
            : null;
      if (!input) return;
      mutations.mutate(
        `${row.key}:${app}`,
        [
          {
            call: () => client.call("skills.mutate", input),
            labels: {
              failure: `Could not ${enabled ? "enable" : "disable"} ${row.name} in ${APP_LABEL[app]}`,
            },
          },
        ],
        enabled,
      );
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
            title="No skills"
            description="Ask an agent to install one into ~/.claude/skills or ~/.codex/skills."
          />
        }
        container="@container/skill-list"
      >
        <ColumnHeader columns={columns} />
        <SectionedList
          sections={sections}
          builtInHint="from Claude Code, Codex, claude.ai and plugins"
          render={(row) => (
            <SkillRowView
              key={row.key}
              row={row}
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

interface SkillRowActions {
  readonly expand: (key: string) => void;
  readonly toggle: (row: SkillRow, app: AgentApp, control: AppControl, enabled: boolean) => void;
}

const SkillRowView = memo(function SkillRowView(props: {
  row: SkillRow;
  expanded: boolean;
  apps: readonly AgentAppInfo[];
  columns: readonly AgentApp[];
  mutations: Mutations;
  actions: SkillRowActions;
}) {
  const { row, expanded, columns, mutations, actions } = props;
  const busy = mutations.isBusy(row.key);
  const origin = skillOrigin(row);
  const on = APPS.some((app) => row.apps[app]?.present && row.apps[app]?.enabled);

  return (
    <ListRow below={expanded ? <SkillDetails row={row} /> : null}>
      <ExpandButton expanded={expanded} name={row.name} onClick={() => actions.expand(row.key)}>
        <span
          className={cn(
            "max-w-[60%] shrink-0 truncate text-xs",
            on ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {row.name}
        </span>
        {origin ? <Chip>{origin}</Chip> : null}
        <span className="hidden min-w-0 flex-1 truncate text-[.7rem] text-muted-foreground/80 @xs/skill-list:inline">
          {row.description}
        </span>
      </ExpandButton>
      {busy ? <RowSpinner /> : null}
      {columns.map((app) => {
        const control = skillAppSwitch(row, app);
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

function SkillDetails({ row }: { row: SkillRow }) {
  return (
    <div className="space-y-1.5 px-2 pb-2.5 pl-8 text-[.7rem]">
      {row.description ? <p className="text-muted-foreground">{row.description}</p> : null}
      <ul className="space-y-px">
        {APPS.map((app) => {
          const entry = row.apps[app];
          if (!entry?.present || !entry.path) return null;
          return (
            <li key={app} className="flex min-w-0 items-center gap-1.5">
              <span className="w-11 shrink-0 font-medium text-foreground">{APP_LABEL[app]}</span>
              <WithReason reason={entry.path}>
                <span className="min-w-0 truncate font-mono text-[.65rem] text-muted-foreground/80">
                  {entry.path}
                </span>
              </WithReason>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
