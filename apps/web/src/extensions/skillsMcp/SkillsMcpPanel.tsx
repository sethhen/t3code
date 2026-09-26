/**
 * Skills & MCP: the MCP servers, skills and plugins Claude Code and Codex
 * load, with what they cost in context and how often they are used.
 */
import { type ContextOverview, SkillsMcpExtension, type UsageReport } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";

import { useExtensionClient } from "../client";
import type { RightPanelExtensionProps } from "../registry";
import { ContextStrip } from "./ContextSummary";
import { type SortMode, contextSummaries, needsUsage } from "./context.logic";
import type { ListTabProps, ListView, ListViewActions, UsageDays } from "./listControls";
import { McpTab } from "./McpTab";
import { PluginsTab } from "./PluginsTab";
import { useOverviewLoader } from "./shared";
import { SkillsTab } from "./SkillsTab";

type Tab = "mcp" | "skills" | "plugins";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "plugins", label: "Plugins" },
];

export default function SkillsMcpPanel(props: RightPanelExtensionProps) {
  const { environmentId, cwd, visible } = props;
  const client = useExtensionClient(SkillsMcpExtension, environmentId);
  const [tab, setTab] = useState<Tab>("mcp");

  const [sort, setSort] = useState<SortMode>("status");
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [days, setDays] = useState<UsageDays>(7);
  const [showUsageChoice, setShowUsage] = useState(false);
  const wantUsage = showUsageChoice || needsUsage(sort, unusedOnly);
  const view = useMemo<ListView>(
    () => ({ sort, unusedOnly, days, showUsage: wantUsage }),
    [sort, unusedOnly, days, wantUsage],
  );
  const viewActions = useMemo<ListViewActions>(
    () => ({ setSort, setUnusedOnly, setDays, setShowUsage }),
    [],
  );

  const scopeKey = `${environmentId ?? ""}|${cwd ?? ""}`;

  // Context cost is measured with the lists (it drives the strip and the row chips).
  const context = useOverviewLoader<ContextOverview>({
    active: visible,
    key: scopeKey,
    staleMs: 60_000,
    fetch: (refresh) =>
      client.call("context.get", {
        ...(cwd ? { cwd } : {}),
        ...(refresh ? { refresh: true } : {}),
      }),
  });
  // Usage scans session logs, so it only loads once a sort, filter or chip needs it.
  const usage = useOverviewLoader<UsageReport>({
    active: visible && wantUsage && tab !== "plugins",
    key: `${environmentId ?? ""}|${days}`,
    staleMs: 300_000,
    fetch: (refresh) => client.call("usage.get", { days, ...(refresh ? { refresh: true } : {}) }),
  });

  const summaries = useMemo(() => contextSummaries(context.data), [context.data]);
  const reloadContext = context.reload;
  const reloadUsage = usage.reload;
  const usageLoaded = usage.data !== null;
  // After a mutation: re-measure in the background; the last numbers stay up meanwhile.
  const onChanged = useCallback(() => {
    void reloadContext(false);
    if (usageLoaded) void reloadUsage(false);
  }, [reloadContext, reloadUsage, usageLoaded]);
  const onRefreshContext = useCallback(() => void reloadContext(true), [reloadContext]);

  const listProps = (active: boolean): ListTabProps => ({
    client,
    scopeKey,
    cwd,
    active,
    view,
    viewActions,
    context: context.data,
    usage: usage.data,
    usageLoading: usage.loading,
    usageError: usage.error,
    onChanged,
    onRefreshContext,
  });

  return (
    <div className="@container/panel flex h-full min-h-0 flex-col">
      <div className="flex items-center border-b px-2 py-1.5">
        <ToggleGroup
          aria-label="Show"
          value={[tab]}
          onValueChange={(next) => {
            const value = TABS.find((entry) => entry.id === next[0]);
            if (value) setTab(value.id);
          }}
        >
          {TABS.map((entry) => (
            <Toggle key={entry.id} value={entry.id} size="xs">
              {entry.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <ContextStrip summaries={summaries} loading={context.loading} error={context.error} />
      {/* Tabs stay mounted so switching keeps their search, filters and loaded data. */}
      <div className={cn("min-h-0 flex-1 flex-col", tab === "mcp" ? "flex" : "hidden")}>
        <McpTab {...listProps(visible && tab === "mcp")} />
      </div>
      <div className={cn("min-h-0 flex-1 flex-col", tab === "skills" ? "flex" : "hidden")}>
        <SkillsTab {...listProps(visible && tab === "skills")} />
      </div>
      <div className={cn("min-h-0 flex-1 flex-col", tab === "plugins" ? "flex" : "hidden")}>
        <PluginsTab
          client={client}
          scopeKey={scopeKey}
          cwd={cwd}
          active={visible && tab === "plugins"}
          onChanged={onChanged}
        />
      </div>
    </div>
  );
}
