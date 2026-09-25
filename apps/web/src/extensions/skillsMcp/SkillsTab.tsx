/**
 * Skills: one dense line per skill (updates first), per-app switches for the
 * managed ones, adopt for unmanaged folders, install from skills.sh, a repo or
 * a zip, and the uninstall backups.
 */
import type {
  AgentApp,
  AgentAppInfo,
  SkillBackup,
  SkillRow,
  SkillsMutation,
  SkillsOverview,
} from "@t3tools/contracts";
import { ChevronRightIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
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
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

import {
  formatTokens,
  isUnused,
  joinSkillStats,
  type RowStats,
  skillIsOn,
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
  filterSkills,
  formatRelativeTime,
  type RowSection,
  resolveFacet,
  sectionSkills,
  skillAdoptPath,
  skillFacetMatches,
  skillFacets,
  skillSourceLabel,
  skillToggleBlock,
} from "./lists.logic";
import {
  AppCheckboxes,
  AppNotices,
  AppSwitch,
  CheckedAgo,
  ConfirmDialog,
  EmptyState,
  ListPlaceholder,
  LoadError,
  RowSpinner,
  SectionLabel,
  WithReason,
  reportMutation,
  safeCall,
  useBusyKeys,
  useOverviewLoader,
} from "./shared";
import { SkillInstallDialog } from "./SkillInstallDialog";

const APPS = ["claude", "codex"] as const satisfies readonly AgentApp[];
const EMPTY_SKILLS: readonly SkillRow[] = [];

type SkillRowAction =
  | { readonly type: "expand"; readonly row: SkillRow }
  | {
      readonly type: "set-enabled";
      readonly row: SkillRow;
      readonly app: AgentApp;
      readonly enabled: boolean;
    }
  | { readonly type: "update"; readonly row: SkillRow }
  | { readonly type: "uninstall"; readonly row: SkillRow }
  | { readonly type: "adopt"; readonly row: SkillRow };

interface MutationStep {
  readonly input: SkillsMutation;
  readonly labels: { readonly failure: string; readonly success?: string };
}

type Confirm =
  | { readonly kind: "uninstall"; readonly row: SkillRow }
  | { readonly kind: "delete-backup"; readonly backup: SkillBackup };

interface Opened<Value> {
  readonly key: number;
  readonly open: boolean;
  readonly value: Value;
}

function reopen<Value>(previous: Opened<Value> | null, value: Value): Opened<Value> {
  return { key: (previous?.key ?? 0) + 1, open: true, value };
}

export function SkillsTab(props: ListTabProps) {
  const { client, scopeKey, cwd, active, view, viewActions, context, usage, onChanged } = props;
  const overview = useOverviewLoader<SkillsOverview>({
    active,
    key: scopeKey,
    fetch: () => safeCall(client, "skills.list", cwd ? { cwd } : {}),
  });
  const { data, error, loading, reload } = overview;
  const busy = useBusyKeys();
  const runBusy = busy.run;
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [facetChoice, setFacetChoice] = useState(ALL_FACET);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [adopt, setAdopt] = useState<Opened<SkillRow> | null>(null);
  const [install, setInstall] = useState<Opened<null> | null>(null);

  const all = data?.skills ?? EMPTY_SKILLS;
  const stats = useMemo(() => joinSkillStats(all, context, usage), [all, context, usage]);
  const facets = useMemo(() => skillFacets(all), [all]);
  const facet = resolveFacet(facets, facetChoice);
  const updates = useMemo(() => all.filter((row) => row.updateAvailable && row.id).length, [all]);
  const installedNames = useMemo(() => new Set(all.map((row) => row.name.toLowerCase())), [all]);
  const unusedRows = useMemo(
    () =>
      usage
        ? all.filter((row) => isUnused(skillIsOn(row), statsFor(stats, row.key)))
        : EMPTY_SKILLS,
    [all, stats, usage],
  );
  const unusedCost = useMemo(() => unusedTokens(unusedRows, stats), [unusedRows, stats]);
  const matched = useMemo(
    () => filterSkills(all, deferredQuery).filter((row) => skillFacetMatches(row, facet)),
    [all, deferredQuery, facet],
  );
  const unusedOnly = view.unusedOnly && usage !== null;
  const shown = useMemo(
    () =>
      unusedOnly
        ? matched.filter((row) => isUnused(skillIsOn(row), statsFor(stats, row.key)))
        : matched,
    [matched, unusedOnly, stats],
  );
  const sort = view.sort;
  const sections = useMemo<RowSection<SkillRow>[]>(() => {
    if (sort === "status") return sectionSkills(shown);
    return [{ id: "sorted", label: "", rows: sortRowsBy(shown, sort, stats) }];
  }, [shown, sort, stats]);
  const apps = data?.apps;
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
    (busyKey: string, steps: readonly MutationStep[], optimistic?: boolean) => {
      runBusy(
        busyKey,
        async () => {
          let changed = false;
          for (const step of steps) {
            const outcome = await safeCall(client, "skills.mutate", step.input);
            reportMutation(outcome, step.labels);
            if (outcome.ok) changed = true;
          }
          await reload(false);
          if (changed) onChanged();
        },
        optimistic,
      );
    },
    [runBusy, client, reload, onChanged],
  );

  const handleAction = (action: SkillRowAction) => {
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
          action.enabled,
        );
        return;
      }
      case "update":
        if (!row.id) return;
        mutate(row.key, [
          {
            input: { action: "update", id: row.id },
            labels: { failure: `Could not update ${row.name}`, success: `Updated ${row.name}` },
          },
        ]);
        return;
      case "uninstall":
        setConfirm({ kind: "uninstall", row });
        return;
      case "adopt":
        setAdopt((previous) => reopen(previous, row));
        return;
    }
  };
  const actionRef = useRef(handleAction);
  useLayoutEffect(() => {
    actionRef.current = handleAction;
  });
  const onAction = useCallback((action: SkillRowAction) => actionRef.current(action), []);

  const openInstall = () => setInstall((previous) => reopen(previous, null));
  const checkUpdates = () =>
    mutate("check-updates", [
      { input: { action: "checkUpdates" }, labels: { failure: "Could not check for updates" } },
    ]);
  const updateAll = () =>
    mutate("update-all", [
      {
        input: { action: "update" },
        labels: { failure: "Some skills could not be updated", success: "Skills updated" },
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
  const runConfirm = () => {
    const target = confirm;
    setConfirm(null);
    if (!target) return;
    if (target.kind === "uninstall") {
      const { row } = target;
      if (!row.id) return;
      mutate(row.key, [
        {
          input: { action: "uninstall", id: row.id },
          labels: {
            failure: `Could not uninstall ${row.name}`,
            success: `Uninstalled ${row.name}`,
          },
        },
      ]);
      return;
    }
    const { backup } = target;
    mutate(`backup:${backup.id}`, [
      {
        input: { action: "deleteBackup", backupId: backup.id },
        labels: { failure: `Could not delete the ${backup.skillName} backup` },
      },
    ]);
  };
  const restoreBackup = (backup: SkillBackup) =>
    mutate(`backup:${backup.id}`, [
      {
        input: { action: "restoreBackup", backupId: backup.id },
        labels: {
          failure: `Could not restore ${backup.skillName}`,
          success: `Restored ${backup.skillName}`,
        },
      },
    ]);

  let body: ReactNode;
  if (data === null) {
    body = error ? (
      <LoadError message={error} onRetry={() => void reload(true)} />
    ) : (
      <ListPlaceholder rows={6} />
    );
  } else {
    let list: ReactNode;
    if (all.length === 0) {
      list = (
        <EmptyState
          title="No skills"
          description="Install one from skills.sh, a GitHub repository or a zip file."
        >
          <Button size="xs" variant="outline" onClick={openInstall}>
            <PlusIcon />
            Install skill
          </Button>
        </EmptyState>
      );
    } else if (shown.length === 0) {
      list = (
        <EmptyState
          title="No matches"
          description="Nothing matches the current search and filters."
        >
          <Button size="xs" variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        </EmptyState>
      );
    } else {
      list = (
        <>
          <div className="flex items-center gap-1.5 border-b px-2 py-1 text-[.65rem] text-muted-foreground">
            <span className="min-w-0 flex-1 pl-4.5">Skill</span>
            {columns.map((app) => (
              <span key={app} className="w-9 shrink-0 text-center">
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
                  <SkillRowView
                    key={row.key}
                    row={row}
                    stats={statsFor(stats, row.key)}
                    days={view.days}
                    showUsage={view.showUsage}
                    expanded={expanded.has(row.key)}
                    apps={data.apps}
                    columns={columns}
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
              Use counts: {usageFootnote(usage)}
            </div>
          ) : null}
        </>
      );
    }
    body = (
      <ScrollArea className="min-h-0 flex-1">
        <div className="@container/skill-list pb-3">
          {list}
          <Backups
            backups={data.backups}
            isBusy={(id) => busy.isBusy(`backup:${id}`)}
            onRestore={restoreBackup}
            onDelete={(backup) => setConfirm({ kind: "delete-backup", backup })}
          />
          <StorageFooter storageDir={data.storageDir} appDirs={data.appDirs} />
        </div>
      </ScrollArea>
    );
  }

  const confirmCopy =
    confirm?.kind === "uninstall"
      ? {
          title: `Uninstall ${confirm.row.name}?`,
          description:
            "Removes it from Claude and Codex. A backup is taken first; restore it any time under Backups.",
          label: "Uninstall",
        }
      : confirm?.kind === "delete-backup"
        ? {
            title: `Delete the ${confirm.backup.skillName} backup?`,
            description: "The backup folder is deleted for good.",
            label: "Delete backup",
          }
        : { title: "", description: "", label: "" };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1 border-b px-2 py-1.5">
        <div className="flex items-center gap-1">
          <SearchField value={query} onChange={setQuery} placeholder="Search skills" />
          <FacetMenu facets={facets} value={facet} total={all.length} onChange={setFacetChoice} />
          <SortMenu view={view} actions={viewActions} />
          <RefreshButton refreshing={loading} onClick={refresh} label="Refresh skills" />
          <Button size="xs" variant="outline" onClick={openInstall}>
            <PlusIcon />
            Install
          </Button>
        </div>
        <div className="flex min-h-5 items-center gap-2 text-[.7rem] text-muted-foreground">
          <span className="shrink-0 tabular-nums">
            {shown.length === all.length ? all.length : `${shown.length} of ${all.length}`}{" "}
            {all.length === 1 ? "skill" : "skills"}
          </span>
          {data ? <CheckedAgo iso={data.checkedAt} visible={active} /> : null}
          <Button
            size="micro"
            variant="ghost"
            disabled={data === null || busy.isBusy("check-updates")}
            onClick={checkUpdates}
          >
            {busy.isBusy("check-updates") ? <RowSpinner /> : null}
            Check for updates
          </Button>
          {updates > 0 ? (
            <Button
              size="micro"
              variant="warning-outline"
              disabled={busy.isBusy("update-all")}
              onClick={updateAll}
            >
              Update all ({updates})
            </Button>
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
          <UsageControls view={view} actions={viewActions} noun="skills" />
        </div>
        {data ? <AppNotices apps={data.apps} /> : null}
        {data && error ? (
          <div className="truncate text-[.7rem] text-destructive-foreground">
            Last refresh failed: {error}
          </div>
        ) : null}
      </div>
      {body}
      {install ? (
        <SkillInstallDialog
          key={install.key}
          open={install.open}
          onOpenChange={(open) =>
            setInstall((previous) => (previous ? { ...previous, open } : previous))
          }
          client={client}
          apps={data?.apps ?? []}
          repos={data?.repos ?? []}
          installedNames={installedNames}
          onInstalled={() => {
            void reload(false);
            onChanged();
          }}
          onReposChanged={() => void reload(false)}
        />
      ) : null}
      {adopt ? (
        <AdoptDialog
          key={adopt.key}
          open={adopt.open}
          onOpenChange={(open) =>
            setAdopt((previous) => (previous ? { ...previous, open } : previous))
          }
          row={adopt.value}
          apps={data?.apps ?? []}
          onAdopt={(path, flags) =>
            mutate(adopt.value.key, [
              {
                input: { action: "adopt", path, apps: flags },
                labels: {
                  failure: `Could not adopt ${adopt.value.name}`,
                  success: `${adopt.value.name} is now managed`,
                },
              },
            ])
          }
        />
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirmCopy.title}
        description={confirmCopy.description}
        confirmLabel={confirmCopy.label}
        onConfirm={runConfirm}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row

interface SkillRowProps {
  readonly row: SkillRow;
  readonly stats: RowStats;
  readonly days: number;
  readonly showUsage: boolean;
  readonly expanded: boolean;
  readonly apps: readonly AgentAppInfo[];
  readonly columns: readonly AgentApp[];
  readonly busyRow: boolean;
  readonly busyClaude: boolean;
  readonly busyCodex: boolean;
  readonly optimisticClaude: boolean | undefined;
  readonly optimisticCodex: boolean | undefined;
  readonly onAction: (action: SkillRowAction) => void;
}

function skillScope(row: SkillRow): string | null {
  const scope = row.apps.claude?.scope ?? row.apps.codex?.scope;
  return scope && scope !== "user" && !row.managed ? scope : null;
}

const SkillRowView = memo(function SkillRowView(props: SkillRowProps) {
  const { row, stats, expanded, onAction } = props;
  const tokens = tokenChip(stats);
  const calls = props.showUsage ? usageChip(stats, props.days) : null;
  const unused = isUnused(skillIsOn(row), stats);
  const scope = skillScope(row);
  const source = skillSourceLabel(row);

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
          <span className="max-w-[60%] shrink-0 truncate font-medium text-xs">{row.name}</span>
          {row.description ? (
            <span className="hidden min-w-0 flex-1 truncate text-[.7rem] text-muted-foreground @xs/skill-list:inline">
              {row.description}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {tokens ? <Chip className="hidden @xs/skill-list:inline">{tokens}</Chip> : null}
          {calls ? (
            <Chip
              className={cn("hidden @sm/skill-list:inline", unused && "text-warning-foreground")}
            >
              {calls}
            </Chip>
          ) : null}
          {source?.kind === "plugin" ? (
            <Badge
              size="sm"
              variant="outline"
              className="hidden shrink-0 @xs/skill-list:inline-flex"
            >
              plugin
            </Badge>
          ) : null}
          {scope && source?.kind !== "plugin" ? (
            <Badge size="sm" variant="outline" className="shrink-0">
              {scope}
            </Badge>
          ) : null}
          {row.updateAvailable ? (
            <Badge size="sm" variant="warning" className="shrink-0">
              update
            </Badge>
          ) : null}
        </button>
        {row.updateAvailable && row.id ? (
          <Button
            size="micro"
            variant="warning-outline"
            disabled={props.busyRow}
            onClick={() => onAction({ type: "update", row })}
          >
            Update
          </Button>
        ) : null}
        {props.busyRow ? <RowSpinner /> : null}
        {props.columns.map((app) => {
          const entry = row.apps[app];
          if (!entry && !row.managed) {
            return (
              <span key={app} className="w-9 shrink-0 text-center text-muted-foreground/40 text-xs">
                –
              </span>
            );
          }
          const optimistic = app === "claude" ? props.optimisticClaude : props.optimisticCodex;
          return (
            <div key={app} className="flex w-9 shrink-0 justify-center">
              <AppSwitch
                compact
                app={app}
                subject={row.name}
                checked={optimistic ?? entry?.enabled ?? false}
                blockedReason={appUnavailableReason(props.apps, app) ?? skillToggleBlock(row, app)}
                busy={props.busyRow || (app === "claude" ? props.busyClaude : props.busyCodex)}
                onCheckedChange={(enabled) => onAction({ type: "set-enabled", row, app, enabled })}
              />
            </div>
          );
        })}
        <SkillMenu row={row} busy={props.busyRow} onAction={onAction} />
      </div>
      {expanded ? <SkillDetails row={row} stats={stats} days={props.days} /> : null}
    </li>
  );
});

function SkillMenu(props: {
  row: SkillRow;
  busy: boolean;
  onAction: (action: SkillRowAction) => void;
}) {
  const { row, onAction } = props;
  const canUpdate = row.managed && row.id !== undefined && row.source?.type === "github";
  const canUninstall = row.managed && row.id !== undefined;
  const canAdopt = skillAdoptPath(row) !== undefined;
  if (!canUpdate && !canUninstall && !canAdopt) return <span className="w-6 shrink-0" />;
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
      <MenuPopup align="end" className="w-48">
        {canAdopt ? (
          <MenuItem disabled={props.busy} onClick={() => onAction({ type: "adopt", row })}>
            Adopt…
          </MenuItem>
        ) : null}
        {canUpdate ? (
          <MenuItem disabled={props.busy} onClick={() => onAction({ type: "update", row })}>
            {row.updateAvailable ? "Update" : "Reinstall latest"}
          </MenuItem>
        ) : null}
        {canUninstall ? (
          <>
            {canAdopt || canUpdate ? <MenuSeparator /> : null}
            <MenuItem variant="destructive" onClick={() => onAction({ type: "uninstall", row })}>
              Uninstall…
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function SkillDetails(props: { row: SkillRow; stats: RowStats; days: number }) {
  const { row } = props;
  const source = skillSourceLabel(row);
  const detail = statsDetail(props.stats, props.days);
  const [now] = useState(Date.now);
  const installed = row.installedAt ? formatRelativeTime(row.installedAt, now) : null;
  return (
    <div className="space-y-1.5 px-2 pb-2.5 pl-6.5 text-[.7rem]">
      {row.description ? <p className="text-muted-foreground">{row.description}</p> : null}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
        {source ? (
          <span>
            {source.kind === "github"
              ? "GitHub "
              : source.kind === "zip"
                ? "Zip "
                : source.kind === "plugin"
                  ? "Plugin "
                  : ""}
            {source.href ? (
              <a
                href={source.href}
                target="_blank"
                rel="noreferrer"
                className="text-info-foreground hover:underline"
              >
                {source.label}
              </a>
            ) : (
              <span className="text-foreground">{source.label}</span>
            )}
          </span>
        ) : null}
        {installed ? <span>installed {installed}</span> : null}
        {row.managed ? <span>managed by T3</span> : null}
      </div>
      <ul className="space-y-px">
        {APPS.map((app) => {
          const entry = row.apps[app];
          if (!entry?.present) return null;
          const meta = [entry.scope, entry.mode, entry.enabled ? undefined : "off"]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={app} className="flex min-w-0 items-center gap-1.5">
              <span className="w-11 shrink-0 font-medium text-foreground">{APP_LABEL[app]}</span>
              <span className="shrink-0 text-muted-foreground">{meta}</span>
              {entry.path ? (
                <WithReason reason={entry.path}>
                  <span className="min-w-0 truncate font-mono text-[.65rem] text-muted-foreground/80">
                    {entry.path}
                  </span>
                </WithReason>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backups and footer

function Backups(props: {
  backups: readonly SkillBackup[];
  isBusy: (id: string) => boolean;
  onRestore: (backup: SkillBackup) => void;
  onDelete: (backup: SkillBackup) => void;
}) {
  const { backups } = props;
  const [now] = useState(Date.now);
  if (backups.length === 0) return null;
  const sorted = [...backups].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return (
    <Collapsible className="mt-2 border-t">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[.7rem] text-muted-foreground hover:bg-accent/30">
        <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none" />
        <span className="font-medium uppercase tracking-wider">Backups · {backups.length}</span>
        <span className="text-muted-foreground/70">
          taken before each uninstall, update or adopt
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ul className="pb-1">
          {sorted.map((backup) => (
            <li
              key={backup.id}
              className="flex min-h-7 items-center gap-1.5 px-2 pl-6.5 text-[.7rem]"
            >
              <WithReason reason={backup.path}>
                <span className="min-w-0 truncate font-medium text-foreground">
                  {backup.skillName}
                </span>
              </WithReason>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {formatRelativeTime(backup.createdAt, now) ?? backup.createdAt}
              </span>
              {props.isBusy(backup.id) ? <RowSpinner /> : null}
              <Button
                size="micro"
                variant="ghost"
                disabled={props.isBusy(backup.id)}
                onClick={() => props.onRestore(backup)}
              >
                Restore
              </Button>
              <Button
                size="micro"
                variant="ghost"
                className="text-destructive-foreground"
                disabled={props.isBusy(backup.id)}
                onClick={() => props.onDelete(backup)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function StorageFooter(props: {
  storageDir: string;
  appDirs: { readonly claude: string; readonly codex: string };
}) {
  const lines: [string, string][] = [
    ["Store", props.storageDir],
    ["Claude", props.appDirs.claude],
    ["Codex", props.appDirs.codex],
  ];
  return (
    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-px border-t px-2 pt-2 text-[.65rem] text-muted-foreground/80">
      {lines.map(([label, path]) => (
        <div key={label} className="contents">
          <dt>{label}</dt>
          <dd className="min-w-0">
            <WithReason reason={path}>
              <span className="block truncate font-mono">{path}</span>
            </WithReason>
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Adopt

function AdoptDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: SkillRow;
  apps: readonly AgentAppInfo[];
  onAdopt: (path: string, apps: { claude: boolean; codex: boolean }) => void;
}) {
  const { row } = props;
  const path = skillAdoptPath(row);
  const [flags, setFlags] = useState(() => ({
    claude: row.apps.claude?.present ?? false,
    codex: row.apps.codex?.present ?? false,
  }));
  const usable = {
    claude: flags.claude && appUnavailableReason(props.apps, "claude") === null,
    codex: flags.codex && appUnavailableReason(props.apps, "codex") === null,
  };
  const canAdopt = path !== undefined && (usable.claude || usable.codex);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adopt {row.name}</DialogTitle>
          <DialogDescription>
            Moves the folder into T3's skill store (after a backup) and links it back into each
            selected app, so it can be toggled and updated here.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3 text-sm">
          {path ? (
            <div className="break-all rounded-md bg-muted/50 px-2 py-1 font-mono text-xs">
              {path}
            </div>
          ) : (
            <p className="text-destructive-foreground text-xs">
              This skill has no folder that can be adopted.
            </p>
          )}
          <AppCheckboxes value={flags} onChange={setFlags} apps={props.apps} />
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canAdopt}
            onClick={() => {
              if (!path) return;
              props.onAdopt(path, usable);
              props.onOpenChange(false);
            }}
          >
            Adopt
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
