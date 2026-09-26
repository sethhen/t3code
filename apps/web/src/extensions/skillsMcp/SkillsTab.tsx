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
import { ChevronRightIcon, InfoIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { memo, useDeferredValue, useMemo, useState } from "react";

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
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import {
  arrangeRows,
  joinSkillStats,
  type RowStats,
  statsDetail,
  statsFor,
  tokenChip,
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
  filterSkills,
  formatRelativeTime,
  resolveFacet,
  sectionSkills,
  skillAdoptPath,
  skillFacetMatches,
  skillFacets,
  skillSourceLabel,
  skillToggleBlock,
} from "./lists.logic";
import {
  APPS,
  AppCheckboxes,
  AppNotices,
  CheckedAgo,
  ConfirmDialog,
  EmptyState,
  type Mutations,
  type Opened,
  RowSpinner,
  WithReason,
  closed,
  reopen,
  useExpandedSet,
  useMutations,
  useOverviewLoader,
  useStableActions,
  visibleApps,
} from "./shared";
import { SkillInstallDialog } from "./SkillInstallDialog";

const EMPTY_SKILLS: readonly SkillRow[] = [];
const SOURCE_PREFIX = { github: "GitHub ", zip: "Zip ", plugin: "Plugin ", local: "" } as const;

type Confirm =
  | { readonly kind: "uninstall"; readonly row: SkillRow }
  | { readonly kind: "delete-backup"; readonly backup: SkillBackup };

export function SkillsTab(props: ListTabProps) {
  const { client, scopeKey, cwd, active, view, viewActions, context, usage, onChanged } = props;
  const { data, error, loading, reload } = useOverviewLoader<SkillsOverview>({
    active,
    key: scopeKey,
    fetch: () => client.call("skills.list", cwd ? { cwd } : {}),
  });
  const mutations = useMutations({ data, reload, onChanged });
  const { expanded, toggle } = useExpandedSet();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [facetChoice, setFacetChoice] = useState(ALL_FACET);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [adopt, setAdopt] = useState<Opened<SkillRow> | null>(null);
  const [install, setInstall] = useState<Opened<null> | null>(null);

  const all = data?.skills ?? EMPTY_SKILLS;
  const columns = useMemo(() => visibleApps(data?.apps, all), [data, all]);
  const stats = useMemo(() => joinSkillStats(all, context, usage), [all, context, usage]);
  const facets = useMemo(() => skillFacets(all), [all]);
  const facet = resolveFacet(facets, facetChoice);
  const updates = useMemo(() => all.filter((row) => row.updateAvailable && row.id).length, [all]);
  const installedNames = useMemo(() => new Set(all.map((row) => row.name.toLowerCase())), [all]);
  const unused = useMemo(
    () => (usage ? unusedRows(all, stats) : EMPTY_SKILLS),
    [all, stats, usage],
  );
  const unusedOnly = view.unusedOnly && usage !== null;
  const shown = useMemo(
    () =>
      filterSkills(all, deferredQuery).filter(
        (row) =>
          skillFacetMatches(row, facet) &&
          mutations.optimistic(row.key) !== false &&
          (!unusedOnly || stats.get(row.key)?.unused === true),
      ),
    [all, deferredQuery, facet, mutations, unusedOnly, stats],
  );
  const sections = useMemo(
    () => arrangeRows(shown, view.sort, stats, sectionSkills),
    [shown, view.sort, stats],
  );

  const step = (input: SkillsMutation, failure: string, success?: string) => ({
    call: () => client.call("skills.mutate", input),
    labels: { failure, ...(success ? { success } : {}) },
  });
  const actions = useStableActions({
    expand: toggle,
    toggle: (row: SkillRow, app: AgentApp, enabled: boolean) => {
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
    update: (row: SkillRow) => {
      if (!row.id) return;
      mutations.mutate(row.key, [
        step(
          { action: "update", id: row.id },
          `Could not update ${row.name}`,
          `Updated ${row.name}`,
        ),
      ]);
    },
    uninstall: (row: SkillRow) => setConfirm({ kind: "uninstall", row }),
    adopt: (row: SkillRow) => setAdopt((previous) => reopen(previous, row)),
  });

  const openInstall = () => setInstall((previous) => reopen(previous, null));
  const clearFilters = () => {
    setQuery("");
    setFacetChoice(ALL_FACET);
    if (view.unusedOnly) viewActions.setUnusedOnly(false);
  };
  const backupStep = (backup: SkillBackup, restore: boolean) =>
    restore
      ? step(
          { action: "restoreBackup", backupId: backup.id },
          `Could not restore ${backup.skillName}`,
          `Restored ${backup.skillName}`,
        )
      : step(
          { action: "deleteBackup", backupId: backup.id },
          `Could not delete the ${backup.skillName} backup`,
        );
  const runConfirm = () => {
    const target = confirm;
    setConfirm(null);
    if (target?.kind === "delete-backup") {
      mutations.mutate(`backup:${target.backup.id}`, [backupStep(target.backup, false)]);
      return;
    }
    const row = target?.row;
    if (!row?.id) return;
    const steps = [
      step(
        { action: "uninstall", id: row.id },
        `Could not uninstall ${row.name}`,
        `Uninstalled ${row.name}`,
      ),
    ];
    mutations.mutate(row.key, steps, false);
  };
  const checking = mutations.isBusy("check-updates") || mutations.isBusy("update-all");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1 border-b px-2 py-1.5">
        <div className="flex items-center gap-1">
          <SearchField value={query} onChange={setQuery} placeholder="Search skills" />
          <FacetMenu facets={facets} value={facet} total={all.length} onChange={setFacetChoice} />
          <SortMenu view={view} actions={viewActions} />
          <RefreshButton
            refreshing={loading || checking}
            onClick={() => {
              void reload(true);
              props.onRefreshContext();
            }}
            label="Refresh skills"
          />
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="More skill actions" />}
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end" className="w-48">
              <MenuItem
                disabled={data === null || checking}
                onClick={() =>
                  mutations.mutate("check-updates", [
                    step({ action: "checkUpdates" }, "Could not check for updates"),
                  ])
                }
              >
                Check for updates
              </MenuItem>
              {updates > 0 ? (
                <MenuItem
                  disabled={checking}
                  onClick={() =>
                    mutations.mutate("update-all", [
                      step(
                        { action: "update" },
                        "Some skills could not be updated",
                        "Skills updated",
                      ),
                    ])
                  }
                >
                  Update all ({updates})
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
          <Button size="xs" variant="outline" onClick={openInstall}>
            <PlusIcon />
            Install
          </Button>
        </div>
        <div className="flex min-h-5 items-center gap-2 text-[.7rem] text-muted-foreground">
          <CountLabel shown={shown.length} total={all.length} noun={["skill", "skills"]} />
          {data ? <CheckedAgo iso={data.checkedAt} visible={active} /> : null}
          {data ? <StorageInfo storageDir={data.storageDir} appDirs={data.appDirs} /> : null}
          <UsageStatus
            view={view}
            usage={usage}
            loading={props.usageLoading}
            error={props.usageError}
            unused={unused.length}
            cost={unusedCost(unused, stats, columns)}
          />
          <UsageControls view={view} actions={viewActions} noun="skills" />
        </div>
        {data ? <AppNotices apps={data.apps} /> : null}
        {data && error ? <RefreshFailed error={error} /> : null}
      </div>
      <ListBody
        loaded={data !== null}
        error={error}
        onRetry={() => void reload(true)}
        total={all.length}
        shown={shown.length}
        onClearFilters={clearFilters}
        container="@container/skill-list"
        empty={
          <EmptyState
            title="No skills"
            description="Install one from skills.sh, a GitHub repository or a zip file."
          >
            <Button size="xs" variant="outline" onClick={openInstall}>
              <PlusIcon />
              Install skill
            </Button>
          </EmptyState>
        }
        after={
          <>
            <UsageFootnote usage={usage} show={view.showUsage} label="Use counts" />
            <Backups
              backups={data?.backups ?? []}
              mutations={mutations}
              onRestore={(backup) =>
                mutations.mutate(`backup:${backup.id}`, [backupStep(backup, true)])
              }
              onDelete={(backup) => setConfirm({ kind: "delete-backup", backup })}
            />
          </>
        }
      >
        <ColumnHeader label="Skill" columns={columns} />
        <Sections
          sections={sections}
          render={(row) => (
            <SkillRowView
              key={row.key}
              row={row}
              stats={statsFor(stats, row.key)}
              days={view.days}
              showUsage={view.showUsage}
              expanded={expanded.has(row.key)}
              apps={data?.apps ?? []}
              columns={columns}
              mutations={mutations}
              actions={actions}
            />
          )}
        />
      </ListBody>
      {install ? (
        <SkillInstallDialog
          key={install.key}
          open={install.open}
          onOpenChange={(open) => {
            if (!open) setInstall(closed);
          }}
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
          onOpenChange={(open) => {
            if (!open) setAdopt(closed);
          }}
          row={adopt.value}
          apps={data?.apps ?? []}
          onAdopt={(path, flags) => {
            const { key, name } = adopt.value;
            mutations.mutate(key, [
              step(
                { action: "adopt", path, apps: flags },
                `Could not adopt ${name}`,
                `${name} is now managed`,
              ),
            ]);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        {...(confirm?.kind === "delete-backup"
          ? {
              title: `Delete the ${confirm.backup.skillName} backup?`,
              description: "The backup folder is deleted for good.",
              confirmLabel: "Delete backup",
            }
          : {
              title: `Uninstall ${confirm?.row.name ?? "skill"}?`,
              description:
                "Removes it from Claude and Codex. A backup is taken first; restore it any time under Backups.",
              confirmLabel: "Uninstall",
            })}
        onConfirm={runConfirm}
      />
    </div>
  );
}

/** The store and app skill folders, behind an info icon instead of a footer. */
function StorageInfo(props: {
  storageDir: string;
  appDirs: { readonly claude: string; readonly codex: string };
}) {
  const lines: [string, string][] = [
    ["Store", props.storageDir],
    ["Claude", props.appDirs.claude],
    ["Codex", props.appDirs.codex],
  ];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Skill folders"
            className={cn("shrink-0 rounded-sm hover:text-foreground", FOCUS_RING)}
          />
        }
      >
        <InfoIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-96">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-px text-[.7rem]">
          {lines.map(([label, path]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-all font-mono">{path}</dd>
            </div>
          ))}
        </dl>
      </TooltipPopup>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Row

interface SkillRowActions {
  readonly expand: (key: string) => void;
  readonly toggle: (row: SkillRow, app: AgentApp, enabled: boolean) => void;
  readonly update: (row: SkillRow) => void;
  readonly uninstall: (row: SkillRow) => void;
  readonly adopt: (row: SkillRow) => void;
}

interface SkillRowProps {
  readonly row: SkillRow;
  readonly stats: RowStats;
  readonly days: number;
  readonly showUsage: boolean;
  readonly expanded: boolean;
  readonly apps: readonly AgentAppInfo[];
  readonly columns: readonly AgentApp[];
  readonly mutations: Mutations;
  readonly actions: SkillRowActions;
}

function skillScope(row: SkillRow): string | null {
  const scope = row.apps.claude?.scope ?? row.apps.codex?.scope;
  return scope && scope !== "user" && !row.managed ? scope : null;
}

const SkillRowView = memo(function SkillRowView(props: SkillRowProps) {
  const { row, stats, expanded, columns, mutations, actions } = props;
  const busy = mutations.isBusy(row.key);
  const tokens = tokenChip(stats, columns);
  const calls = props.showUsage ? usageChip(stats, props.days) : null;
  const detail = statsDetail(stats, props.days).join("\n") || undefined;
  const scope = skillScope(row);
  const plugin = skillSourceLabel(row)?.kind === "plugin";

  return (
    <ListRow below={expanded ? <SkillDetails row={row} stats={stats} days={props.days} /> : null}>
      <ExpandButton expanded={expanded} name={row.name} onClick={() => actions.expand(row.key)}>
        <span className="max-w-[60%] shrink-0 truncate font-medium text-xs">{row.name}</span>
        {row.description ? (
          <Hint hint={row.description}>
            <span className="hidden min-w-0 flex-1 truncate text-[.7rem] text-muted-foreground @xs/skill-list:inline">
              {row.description}
            </span>
          </Hint>
        ) : (
          <span className="flex-1" />
        )}
        {tokens ? (
          <Chip hint={detail} className="hidden @xs/skill-list:inline">
            {tokens}
          </Chip>
        ) : null}
        {calls ? (
          <Chip
            hint={detail}
            className={cn(
              "hidden @sm/skill-list:inline",
              stats.unused && "text-warning-foreground",
            )}
          >
            {calls}
          </Chip>
        ) : null}
        {plugin ? (
          <Badge size="sm" variant="outline" className="hidden shrink-0 @xs/skill-list:inline-flex">
            plugin
          </Badge>
        ) : null}
        {scope && !plugin ? (
          <Badge size="sm" variant="outline" className="shrink-0">
            {scope}
          </Badge>
        ) : null}
        {row.updateAvailable ? (
          <Badge size="sm" variant="warning" className="shrink-0">
            update
          </Badge>
        ) : null}
      </ExpandButton>
      {row.updateAvailable && row.id ? (
        <Button
          size="micro"
          variant="warning-outline"
          disabled={busy}
          onClick={() => actions.update(row)}
        >
          Update
        </Button>
      ) : null}
      {busy ? <RowSpinner /> : null}
      {columns.map((app) => (
        <AppCell
          key={app}
          app={app}
          subject={row.name}
          entry={row.apps[app]}
          managed={row.managed && !row.pluginId}
          optimistic={mutations.optimistic(`${row.key}:${app}`)}
          reason={skillToggleBlock(row, app) ?? appUnavailableReason(props.apps, app)}
          busy={busy || mutations.isBusy(`${row.key}:${app}`)}
          onToggle={(enabled) => actions.toggle(row, app, enabled)}
        />
      ))}
      <SkillMenu row={row} busy={busy} actions={actions} />
    </ListRow>
  );
});

function SkillMenu(props: { row: SkillRow; busy: boolean; actions: SkillRowActions }) {
  const { row, actions } = props;
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
          <MenuItem disabled={props.busy} onClick={() => actions.adopt(row)}>
            Adopt…
          </MenuItem>
        ) : null}
        {canUpdate ? (
          <MenuItem disabled={props.busy} onClick={() => actions.update(row)}>
            {row.updateAvailable ? "Update" : "Reinstall latest"}
          </MenuItem>
        ) : null}
        {canUninstall ? (
          <>
            {canAdopt || canUpdate ? <MenuSeparator /> : null}
            <MenuItem variant="destructive" onClick={() => actions.uninstall(row)}>
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
    <div className="space-y-2 px-2 pb-2.5 pl-8 text-[.7rem]">
      {row.description ? <p className="text-muted-foreground">{row.description}</p> : null}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
        {source ? (
          <span>
            {SOURCE_PREFIX[source.kind]}
            {source.href ? (
              <a
                href={source.href}
                target="_blank"
                rel="noreferrer"
                className="rounded-sm text-info-foreground hover:underline"
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
// Backups

function Backups(props: {
  backups: readonly SkillBackup[];
  mutations: Mutations;
  onRestore: (backup: SkillBackup) => void;
  onDelete: (backup: SkillBackup) => void;
}) {
  const { backups } = props;
  const [now] = useState(Date.now);
  if (backups.length === 0) return null;
  const sorted = [...backups].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return (
    <Collapsible className="mt-2 border-t">
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[.7rem] text-muted-foreground hover:bg-accent/30",
          FOCUS_RING,
        )}
      >
        <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none" />
        <span className="font-medium uppercase tracking-wider">Backups · {backups.length}</span>
        <span className="text-muted-foreground/70">
          taken before each uninstall, update or adopt
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ul className="pb-1">
          {sorted.map((backup) => {
            const busy = props.mutations.isBusy(`backup:${backup.id}`);
            return (
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
                {busy ? <RowSpinner /> : null}
                <Button
                  size="micro"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => props.onRestore(backup)}
                >
                  Restore
                </Button>
                <Button
                  size="micro"
                  variant="ghost"
                  className="text-destructive-foreground"
                  disabled={busy}
                  onClick={() => props.onDelete(backup)}
                >
                  Delete
                </Button>
              </li>
            );
          })}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
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
