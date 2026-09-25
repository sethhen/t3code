/**
 * Installed plugins per app (enable, update, uninstall) and, on request, the
 * marketplace plugins that can be installed.
 */
import type {
  AgentApp,
  AgentAppInfo,
  PluginRow,
  PluginsMutation,
  PluginsOverview,
} from "@t3tools/contracts";
import { MoreHorizontalIcon, StoreIcon } from "lucide-react";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Switch } from "~/components/ui/switch";
import { Toggle } from "~/components/ui/toggle";

import { Chip, RefreshButton, SearchField } from "./listControls";
import {
  APP_LABEL,
  appUnavailableReason,
  contributionChips,
  filterPlugins,
  sortPlugins,
} from "./lists.logic";
import {
  AppNotices,
  CheckedAgo,
  ConfirmDialog,
  EmptyState,
  ListPlaceholder,
  LoadError,
  RowSpinner,
  SectionLabel,
  type SkillsMcpClient,
  WithReason,
  reportMutation,
  safeCall,
  useBusyKeys,
  useOverviewLoader,
} from "./shared";

const APPS = ["claude", "codex"] as const satisfies readonly AgentApp[];

export interface PluginsTabProps {
  readonly client: SkillsMcpClient;
  readonly scopeKey: string;
  readonly cwd: string | null;
  /** Panel visible and this tab selected. */
  readonly active: boolean;
  /** A mutation went through: skills, MCP servers and context cost may have changed. */
  readonly onChanged: () => void;
}

type PluginAction = Pick<PluginsMutation, "action"> & { readonly row: PluginRow };

const ACTION_LABEL: Record<PluginsMutation["action"], { failure: string; success?: string }> = {
  enable: { failure: "Could not enable" },
  disable: { failure: "Could not disable" },
  install: { failure: "Could not install", success: "Installed" },
  uninstall: { failure: "Could not uninstall", success: "Uninstalled" },
  update: { failure: "Could not update", success: "Updated" },
};

function busyKey(row: PluginRow): string {
  return `${row.app}:${row.id}`;
}

export function PluginsTab(props: PluginsTabProps) {
  const { client, scopeKey, cwd, active, onChanged } = props;
  const [browse, setBrowse] = useState(false);
  // Two loaders so turning the marketplace on/off never blanks the installed list.
  const installedLoader = useOverviewLoader<PluginsOverview>({
    active: active && !browse,
    key: scopeKey,
    fetch: () => safeCall(client, "plugins.list", cwd ? { cwd } : {}),
  });
  const marketLoader = useOverviewLoader<PluginsOverview>({
    active: active && browse,
    key: scopeKey,
    staleMs: 120_000,
    fetch: () =>
      safeCall(client, "plugins.list", { ...(cwd ? { cwd } : {}), includeAvailable: true }),
  });
  const current = browse ? marketLoader : installedLoader;
  const data = browse ? (marketLoader.data ?? installedLoader.data) : installedLoader.data;
  const { error, loading } = current;
  const reloadInstalled = installedLoader.reload;
  const reloadMarket = marketLoader.reload;

  const { isBusy, optimistic, run: runBusy } = useBusyKeys();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [confirm, setConfirm] = useState<PluginRow | null>(null);

  const installed = useMemo(
    () => sortPlugins(filterPlugins(data?.installed ?? [], deferredQuery)),
    [data, deferredQuery],
  );
  const available = useMemo(
    () => (browse ? sortPlugins(filterPlugins(data?.available ?? [], deferredQuery)) : []),
    [browse, data, deferredQuery],
  );
  const totalInstalled = data?.installed.length ?? 0;
  const updates = useMemo(
    () => (data?.installed ?? []).filter((row) => row.updateAvailable).length,
    [data],
  );

  const mutate = useCallback(
    (action: PluginsMutation["action"], row: PluginRow) => {
      const labels = ACTION_LABEL[action];
      runBusy(
        busyKey(row),
        async () => {
          const outcome = await safeCall(client, "plugins.mutate", {
            action,
            app: row.app,
            id: row.id,
          });
          reportMutation(outcome, {
            failure: `${labels.failure} ${row.name}`,
            ...(labels.success ? { success: `${labels.success} ${row.name}` } : {}),
          });
          // Both views go stale; the hidden one reloads quietly.
          await Promise.all([reloadInstalled(false), browse ? reloadMarket(false) : null]);
          if (outcome.ok) onChanged();
        },
        action === "enable" ? true : action === "disable" ? false : undefined,
      );
    },
    [runBusy, client, reloadInstalled, reloadMarket, browse, onChanged],
  );

  const handleAction = ({ action, row }: PluginAction) => {
    if (action === "uninstall") setConfirm(row);
    else mutate(action, row);
  };
  const actionRef = useRef(handleAction);
  useLayoutEffect(() => {
    actionRef.current = handleAction;
  });
  const onAction = useCallback((action: PluginAction) => actionRef.current(action), []);

  const refresh = () => void (browse ? reloadMarket(true) : reloadInstalled(true));

  const renderRows = (rows: readonly PluginRow[], apps: readonly AgentAppInfo[]) =>
    rows.map((row) => {
      const key = busyKey(row);
      return (
        <PluginRowView
          key={key}
          row={row}
          blockedReason={appUnavailableReason(apps, row.app)}
          busy={isBusy(key)}
          optimistic={optimistic(key)}
          onAction={onAction}
        />
      );
    });

  let body: ReactNode;
  if (data === null) {
    body = error ? <LoadError message={error} onRetry={refresh} /> : <ListPlaceholder rows={4} />;
  } else {
    const sections: ReactNode[] = [];
    for (const app of APPS) {
      const rows = installed.filter((row) => row.app === app);
      if (rows.length === 0) continue;
      sections.push(
        <section key={`installed:${app}`}>
          <SectionLabel className="px-2">
            {APP_LABEL[app]} · {rows.length}
          </SectionLabel>
          <ul>{renderRows(rows, data.apps)}</ul>
        </section>,
      );
    }
    if (totalInstalled === 0) {
      sections.push(
        <EmptyState
          key="empty"
          title="No plugins installed"
          description="Plugins bundle skills, MCP servers, commands and agents."
        >
          {browse ? null : (
            <Button size="xs" variant="outline" onClick={() => setBrowse(true)}>
              <StoreIcon />
              Browse marketplace
            </Button>
          )}
        </EmptyState>,
      );
    } else if (installed.length === 0 && !browse) {
      sections.push(<EmptyState key="no-match" title="No matches" />);
    }
    if (browse) {
      if (marketLoader.data === null) {
        sections.push(
          marketLoader.error ? (
            <div key="market-error" className="px-2 pt-3 text-[.7rem] text-destructive-foreground">
              Could not read the marketplaces: {marketLoader.error}
            </div>
          ) : (
            <div
              key="market-loading"
              className="flex items-center gap-1.5 px-2 pt-3 text-[.7rem] text-muted-foreground"
            >
              <RowSpinner />
              Reading marketplaces…
            </div>
          ),
        );
      } else {
        for (const app of APPS) {
          const rows = available.filter((row) => row.app === app);
          if (rows.length === 0) continue;
          sections.push(
            <section key={`available:${app}`}>
              <SectionLabel className="px-2">
                Available for {APP_LABEL[app]} · {rows.length}
              </SectionLabel>
              <ul>{renderRows(rows, data.apps)}</ul>
            </section>,
          );
        }
        if (available.length === 0) {
          sections.push(
            <div key="market-empty" className="px-2 pt-3 text-[.7rem] text-muted-foreground">
              {data.available.length === 0
                ? "Every plugin in your configured marketplaces is installed."
                : "No marketplace plugins match."}
            </div>,
          );
        }
      }
    }
    body = (
      <ScrollArea className="min-h-0 flex-1">
        <div className="@container/plugin-list pb-3">{sections}</div>
      </ScrollArea>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1 border-b px-2 py-1.5">
        <div className="flex items-center gap-1">
          <SearchField value={query} onChange={setQuery} placeholder="Search plugins" />
          <Toggle
            size="xs"
            variant="outline"
            pressed={browse}
            onPressedChange={setBrowse}
            aria-label="Browse marketplace"
          >
            <StoreIcon />
            <span className="hidden @xs/panel:inline">Marketplace</span>
          </Toggle>
          <RefreshButton refreshing={loading} onClick={refresh} label="Refresh plugins" />
        </div>
        <div className="flex min-h-5 items-center gap-2 text-[.7rem] text-muted-foreground">
          <span className="shrink-0 tabular-nums">
            {installed.length === totalInstalled
              ? totalInstalled
              : `${installed.length} of ${totalInstalled}`}{" "}
            installed
          </span>
          {browse && marketLoader.data ? (
            <span className="shrink-0 tabular-nums">
              · {marketLoader.data.available.length} available
            </span>
          ) : null}
          {updates > 0 ? (
            <span className="shrink-0 text-warning-foreground">
              {updates} {updates === 1 ? "update" : "updates"}
            </span>
          ) : null}
          {data ? <CheckedAgo iso={data.checkedAt} visible={active} /> : null}
        </div>
        {data ? <AppNotices apps={data.apps} /> : null}
        {data && error ? (
          <div className="truncate text-[.7rem] text-destructive-foreground">
            Last refresh failed: {error}
          </div>
        ) : null}
      </div>
      {body}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm ? `Uninstall ${confirm.name}?` : ""}
        description={
          confirm
            ? `Removes the plugin from ${APP_LABEL[confirm.app]}, along with the skills, MCP servers, commands and agents it brings.`
            : ""
        }
        confirmLabel="Uninstall"
        onConfirm={() => {
          if (confirm) mutate("uninstall", confirm);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row

const PluginRowView = memo(function PluginRowView(props: {
  row: PluginRow;
  blockedReason: string | null;
  busy: boolean;
  optimistic: boolean | undefined;
  onAction: (action: PluginAction) => void;
}) {
  const { row, onAction, busy } = props;
  const chips = contributionChips(row);
  const enabled = props.optimistic ?? row.enabled;
  const meta = [row.marketplace, row.version ? `v${row.version}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="border-border/50 border-b last:border-b-0">
      <div className="flex min-h-8 items-center gap-1.5 px-2 py-1 hover:bg-accent/30">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={
                row.installed && !enabled
                  ? "truncate text-muted-foreground text-xs"
                  : "truncate font-medium text-xs"
              }
            >
              {row.name}
            </span>
            {meta ? <Chip className="hidden @xs/plugin-list:inline">{meta}</Chip> : null}
            {chips.map((chip) => (
              <WithReason key={chip.kind} reason={chip.names.join(", ")}>
                <Chip className="hidden @sm/plugin-list:inline">{chip.label}</Chip>
              </WithReason>
            ))}
            {row.updateAvailable ? (
              <Badge size="sm" variant="warning">
                update
              </Badge>
            ) : null}
          </div>
          {row.description ? (
            <WithReason reason={row.description}>
              <div className="truncate text-[.65rem] text-muted-foreground">{row.description}</div>
            </WithReason>
          ) : null}
        </div>
        {busy ? <RowSpinner /> : null}
        {row.installed ? (
          <>
            {row.updateAvailable ? (
              <Button
                size="micro"
                variant="warning-outline"
                disabled={busy || props.blockedReason !== null}
                onClick={() => onAction({ action: "update", row })}
              >
                Update
              </Button>
            ) : null}
            <WithReason reason={props.blockedReason}>
              <Switch
                size="sm"
                aria-label={`${enabled ? "Disable" : "Enable"} ${row.name} for ${APP_LABEL[row.app]}`}
                checked={enabled}
                disabled={busy || props.blockedReason !== null}
                onCheckedChange={(checked) =>
                  onAction({ action: checked ? "enable" : "disable", row })
                }
              />
            </WithReason>
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
              <MenuPopup align="end" className="w-44">
                <MenuItem
                  disabled={busy || props.blockedReason !== null}
                  onClick={() => onAction({ action: "update", row })}
                >
                  {row.updateAvailable ? "Update" : "Check for update"}
                </MenuItem>
                <MenuItem
                  variant="destructive"
                  disabled={busy || props.blockedReason !== null}
                  onClick={() => onAction({ action: "uninstall", row })}
                >
                  Uninstall…
                </MenuItem>
              </MenuPopup>
            </Menu>
          </>
        ) : (
          <WithReason reason={props.blockedReason}>
            <Button
              size="micro"
              variant="outline"
              aria-label={`Install ${row.name} for ${APP_LABEL[row.app]}`}
              disabled={busy || props.blockedReason !== null}
              onClick={() => onAction({ action: "install", row })}
            >
              Install
            </Button>
          </WithReason>
        )}
      </div>
    </li>
  );
});
