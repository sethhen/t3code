/**
 * Skills & MCP: the MCP servers, skills and plugins Claude Code and Codex
 * load, each with a switch per app, and what a new thread starts with.
 */
import {
  type ContextOverview,
  type McpOverview,
  type PluginsOverview,
  SkillsMcpExtension,
  type SkillsOverview,
} from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";

import { useExtensionClient } from "../client";
import type { RightPanelExtensionProps } from "../registry";
import { ContextFooter } from "./ContextSummary";
import { contextSummaries } from "./context.logic";
import { consumeLoginRefresh, useMcpLogin } from "./login";
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
  const login = useMcpLogin(props);
  const client = useExtensionClient(SkillsMcpExtension, environmentId);
  const [tab, setTab] = useState<Tab>("mcp");
  const scopeKey = `${environmentId ?? ""}|${cwd ?? ""}`;
  const cwdInput = cwd ? { cwd } : {};

  const mcp = useOverviewLoader<McpOverview>({
    name: "mcp",
    active: visible && tab === "mcp",
    key: scopeKey,
    fetch: (refresh) => {
      // A login finished in a terminal outside the panel: skip the cached probe.
      const fresh = consumeLoginRefresh() || refresh;
      return client.call("mcp.list", { ...cwdInput, ...(fresh ? { refresh: true } : {}) });
    },
  });
  const skills = useOverviewLoader<SkillsOverview>({
    name: "skills",
    active: visible && tab === "skills",
    key: scopeKey,
    fetch: () => client.call("skills.list", cwdInput),
  });
  const plugins = useOverviewLoader<PluginsOverview>({
    name: "plugins",
    active: visible && tab === "plugins",
    key: scopeKey,
    fetch: () => client.call("plugins.list", cwdInput),
  });
  const context = useOverviewLoader<ContextOverview>({
    name: "context",
    active: visible,
    key: scopeKey,
    staleMs: 60_000,
    fetch: (refresh) =>
      client.call("context.get", { ...cwdInput, ...(refresh ? { refresh: true } : {}) }),
  });

  const lists = { mcp, skills, plugins };
  const current = lists[tab];
  const summaries = useMemo(() => contextSummaries(context.data), [context.data]);

  // After a switch: re-measure in the background; the last numbers stay up meanwhile.
  const reloadContext = context.reload;
  const onChanged = useCallback(() => void reloadContext(true), [reloadContext]);
  // A plugin brings skills and MCP servers, so those lists are stale too.
  const reloadMcp = mcp.reload;
  const reloadSkills = skills.reload;
  const onPluginChanged = useCallback(() => {
    void reloadContext(true);
    void reloadMcp(false);
    void reloadSkills(false);
  }, [reloadContext, reloadMcp, reloadSkills]);

  return (
    <div className="@container/panel flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
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
        <span className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh"
          onClick={() => {
            void current.reload(true);
            void context.reload(true);
          }}
        >
          <RefreshIcon refreshing={current.loading || context.loading} />
        </Button>
      </div>
      {/* Tabs stay mounted so switching keeps their expanded rows. */}
      <div className={cn("min-h-0 flex-1 flex-col", tab === "mcp" ? "flex" : "hidden")}>
        <McpTab
          client={client}
          cwd={cwd}
          list={mcp}
          context={context.data}
          onChanged={onChanged}
          onLogin={login}
        />
      </div>
      <div className={cn("min-h-0 flex-1 flex-col", tab === "skills" ? "flex" : "hidden")}>
        <SkillsTab client={client} list={skills} onChanged={onChanged} />
      </div>
      <div className={cn("min-h-0 flex-1 flex-col", tab === "plugins" ? "flex" : "hidden")}>
        <PluginsTab client={client} list={plugins} onChanged={onPluginChanged} />
      </div>
      <ContextFooter summaries={summaries} loading={context.loading} error={context.error} />
    </div>
  );
}
