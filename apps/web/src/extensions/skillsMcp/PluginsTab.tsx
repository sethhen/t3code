/**
 * Installed plugins per app (enable, update, uninstall) and, on request, the
 * marketplace plugins that can be installed.
 */
import type { AgentAppInfo, PluginRow, PluginsMutation, PluginsOverview } from "@t3tools/contracts";
import { MoreHorizontalIcon, StoreIcon } from "lucide-react";
import { memo, useDeferredValue, useMemo, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Switch } from "~/components/ui/switch";
import { Toggle } from "~/components/ui/toggle";

import {
  Chip,
  CountLabel,
  Hint,
  ListBody,
  ListRow,
  RefreshButton,
  RefreshFailed,
  SearchField,
  Sections,
} from "./listControls";
import {
  APP_LABEL,
  appUnavailableReason,
  contributionChips,
  filterPlugins,
  sectionPlugins,
} from "./lists.logic";
import {
  AppNotices,
  CheckedAgo,
  ConfirmDialog,
  EmptyState,
  type Mutations,
  RowSpinner,
  type SkillsMcpClient,
  WithReason,
  useMutations,
  useOverviewLoader,
  useStableActions,
} from "./shared";

export interface PluginsTabProps {
  readonly client: SkillsMcpClient;
  readonly scopeKey: string;
  readonly cwd: string | null;
  /** Panel visible and this tab selected. */
  readonly active: boolean;
  /** A mutation went through: skills, MCP servers and context cost may have changed. */
  readonly onChanged: () => void;
}

/** One snapshot; `market` says whether it was read with the marketplaces. */
type PluginsSnapshot = PluginsOverview & { readonly market: boolean };

const EMPTY_PLUGINS: readonly PluginRow[] = [];
const ACTION_LABEL: Record<PluginsMutation["action"], { failure: string; success?: string }> = {
  enable: { failure: "Could not enable" },
  disable: { failure: "Could not disable" },
  install: { failure: "Could not install", success: "Installed" },
  uninstall: { failure: "Could not uninstall", success: "Uninstalled" },
  update: { failure: "Could not update", success: "Updated" },
};

const rowKey = (row: PluginRow) => `${row.app}:${row.id}`;
const switchKey = (row: PluginRow) => `${rowKey(row)}:on`;

export function PluginsTab(props: PluginsTabProps) {
  const { client, scopeKey, cwd, active, onChanged } = props;
  const [browse, setBrowse] = useState(false);
  // While browsing, every reload (refresh, after a mutation) includes the
  // marketplaces, so the one snapshot always matches what is shown.
  const market = useRef(false);
  const { data, error, loading, reload } = useOverviewLoader<PluginsSnapshot>({
    name: "plugins",
    active,
    key: scopeKey,
    fetch: async () => {
      const includeAvailable = market.current;
      const outcome = await client.call("plugins.list", {
        ...(cwd ? { cwd } : {}),
        ...(includeAvailable ? { includeAvailable } : {}),
      });
      return outcome.ok
        ? { ok: true, value: { ...outcome.value, market: includeAvailable } }
        : outcome;
    },
  });
  const mutations = useMutations({ data, reload, onChanged });
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [confirm, setConfirm] = useState<PluginRow | null>(null);

  const installed = data?.installed ?? EMPTY_PLUGINS;
  const available = browse && data?.market ? data.available : EMPTY_PLUGINS;
  const shownInstalled = useMemo(
    () =>
      filterPlugins(installed, deferredQuery).filter(
        (row) => mutations.optimistic(rowKey(row)) !== false,
      ),
    [installed, deferredQuery, mutations],
  );
  const shownAvailable = useMemo(
    () => filterPlugins(available, deferredQuery),
    [available, deferredQuery],
  );
  const sections = useMemo(
    () => sectionPlugins(shownInstalled, shownAvailable),
    [shownInstalled, shownAvailable],
  );
  const updates = installed.filter((row) => row.updateAvailable).length;

  const run = (action: PluginsMutation["action"], row: PluginRow) => {
    const labels = ACTION_LABEL[action];
    const toggle = action === "enable" || action === "disable";
    mutations.mutate(
      toggle ? switchKey(row) : rowKey(row),
      [
        {
          call: () => client.call("plugins.mutate", { action, app: row.app, id: row.id }),
          labels: {
            failure: `${labels.failure} ${row.name}`,
            ...(labels.success ? { success: `${labels.success} ${row.name}` } : {}),
          },
        },
      ],
      toggle ? action === "enable" : action === "uninstall" ? false : undefined,
    );
  };
  const actions = useStableActions({
    run: (action: PluginsMutation["action"], row: PluginRow) =>
      action === "uninstall" ? setConfirm(row) : run(action, row),
  });

  // Reads the marketplaces when a snapshot without them is showing, or when a
  // load in flight may have left without them (a stored snapshot can carry them
  // while the reopened panel's first load does not); the installed list stays
  // up meanwhile.
  const showMarket = (on: boolean) => {
    setBrowse(on);
    market.current = on;
    if (on && (!data?.market || loading)) void reload(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1 border-b px-2 py-1.5">
        <div className="flex items-center gap-1">
          <SearchField value={query} onChange={setQuery} placeholder="Search plugins" />
          <Toggle
            size="xs"
            variant="outline"
            pressed={browse}
            onPressedChange={showMarket}
            aria-label="Browse marketplace"
          >
            <StoreIcon />
            <span className="hidden @xs/panel:inline">Marketplace</span>
          </Toggle>
          <RefreshButton
            refreshing={loading}
            onClick={() => void reload(true)}
            label="Refresh plugins"
          />
        </div>
        <div className="flex min-h-5 items-center gap-2 text-[.7rem] text-muted-foreground">
          <CountLabel
            shown={shownInstalled.length}
            total={installed.length}
            noun={["installed", "installed"]}
          />
          {browse && data?.market ? (
            <span className="shrink-0 tabular-nums">{data.available.length} available</span>
          ) : null}
          {updates > 0 ? (
            <span className="shrink-0 text-warning-foreground">
              {updates} {updates === 1 ? "update" : "updates"}
            </span>
          ) : null}
          {data ? <CheckedAgo iso={data.checkedAt} visible={active} /> : null}
        </div>
        {data ? <AppNotices apps={data.apps} /> : null}
        {data && error && (data.market || !browse) ? <RefreshFailed error={error} /> : null}
      </div>
      <ListBody
        loaded={data !== null}
        error={error}
        onRetry={() => void reload(true)}
        total={installed.length + available.length}
        shown={shownInstalled.length + shownAvailable.length}
        onClearFilters={() => setQuery("")}
        container="@container/plugin-list"
        empty={
          <EmptyState
            title="No plugins installed"
            description="Plugins bundle skills, MCP servers, commands and agents."
          >
            {browse ? null : (
              <Button size="xs" variant="outline" onClick={() => showMarket(true)}>
                <StoreIcon />
                Browse marketplace
              </Button>
            )}
          </EmptyState>
        }
        after={
          browse && data ? (
            <MarketStatus
              snapshot={data}
              error={error}
              matches={shownAvailable.length}
              others={shownInstalled.length}
            />
          ) : null
        }
      >
        <Sections
          sections={sections}
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
          const row = confirm;
          setConfirm(null);
          if (row) run("uninstall", row);
        }}
      />
    </div>
  );
}

/** Under the list while browsing: reading, failed, or why nothing installable shows. */
function MarketStatus(props: {
  snapshot: PluginsSnapshot;
  error: string | null;
  matches: number;
  others: number;
}) {
  const { snapshot } = props;
  if (!snapshot.market) {
    return props.error ? (
      <div className="px-2 pt-3 text-[.7rem] text-destructive-foreground">
        Could not read the marketplaces: {props.error}
      </div>
    ) : (
      <div className="flex items-center gap-1.5 px-2 pt-3 text-[.7rem] text-muted-foreground">
        <RowSpinner />
        Reading marketplaces…
      </div>
    );
  }
  let text: string | null = null;
  if (snapshot.available.length === 0) {
    text = "Every plugin in your configured marketplaces is installed.";
  } else if (props.matches === 0 && props.others > 0) {
    text = "No marketplace plugins match.";
  }
  return text ? <div className="px-2 pt-3 text-[.7rem] text-muted-foreground">{text}</div> : null;
}

// ---------------------------------------------------------------------------
// Row

interface PluginRowActions {
  readonly run: (action: PluginsMutation["action"], row: PluginRow) => void;
}

const PluginRowView = memo(function PluginRowView(props: {
  row: PluginRow;
  apps: readonly AgentAppInfo[];
  mutations: Mutations;
  actions: PluginRowActions;
}) {
  const { row, mutations, actions } = props;
  const blocked = appUnavailableReason(props.apps, row.app);
  const busy = mutations.isBusy(rowKey(row)) || mutations.isBusy(switchKey(row));
  const locked = busy || blocked !== null;
  const enabled = mutations.optimistic(switchKey(row)) ?? row.enabled;
  const chips = contributionChips(row);
  const meta = [row.marketplace, row.version ? `v${row.version}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <ListRow>
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
            <Chip
              key={chip.kind}
              hint={chip.names.join(", ")}
              className="hidden @sm/plugin-list:inline"
            >
              {chip.label}
            </Chip>
          ))}
          {row.updateAvailable ? (
            <Badge size="sm" variant="warning">
              update
            </Badge>
          ) : null}
        </div>
        {row.description ? (
          <Hint hint={row.description}>
            <div className="line-clamp-2 text-[.65rem] text-muted-foreground">
              {row.description}
            </div>
          </Hint>
        ) : null}
      </div>
      {busy ? <RowSpinner /> : null}
      {row.installed ? (
        <>
          {row.updateAvailable ? (
            <Button
              size="micro"
              variant="warning-outline"
              disabled={locked}
              onClick={() => actions.run("update", row)}
            >
              Update
            </Button>
          ) : null}
          <WithReason reason={blocked}>
            <Switch
              size="sm"
              aria-label={`${enabled ? "Disable" : "Enable"} ${row.name} for ${APP_LABEL[row.app]}`}
              checked={enabled}
              disabled={locked}
              onCheckedChange={(checked) => actions.run(checked ? "enable" : "disable", row)}
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
              <MenuItem disabled={locked} onClick={() => actions.run("update", row)}>
                {row.updateAvailable ? "Update" : "Check for update"}
              </MenuItem>
              <MenuItem
                variant="destructive"
                disabled={locked}
                onClick={() => actions.run("uninstall", row)}
              >
                Uninstall…
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      ) : (
        <WithReason reason={blocked}>
          <Button
            size="micro"
            variant="outline"
            aria-label={`Install ${row.name} for ${APP_LABEL[row.app]}`}
            disabled={locked}
            onClick={() => actions.run("install", row)}
          >
            Install
          </Button>
        </WithReason>
      )}
    </ListRow>
  );
});
