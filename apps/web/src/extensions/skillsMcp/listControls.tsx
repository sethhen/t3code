/**
 * Toolbar pieces shared by the MCP and Skills tabs: search, the filter menu,
 * the sort menu (with the usage window) and the Unused toggle.
 */
import type { ContextOverview, UsageReport } from "@t3tools/contracts";
import { ArrowDownUpIcon, FilterIcon, SearchIcon, XIcon } from "lucide-react";
import { type ReactNode, memo } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Toggle } from "~/components/ui/toggle";
import { Toggle as SegmentToggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";

import { SORT_LABEL, type SortMode } from "./context.logic";
import { ALL_FACET, type Facet } from "./lists.logic";
import { type SkillsMcpClient, WithReason } from "./shared";

export type UsageDays = 7 | 30;

/** The sort/filter state the MCP and Skills tabs share (owned by the panel). */
export interface ListView {
  readonly sort: SortMode;
  readonly unusedOnly: boolean;
  readonly days: UsageDays;
  /** Call counts are shown (requested explicitly or needed by the sort/filter). */
  readonly showUsage: boolean;
}

export interface ListViewActions {
  readonly setSort: (sort: SortMode) => void;
  readonly setUnusedOnly: (unusedOnly: boolean) => void;
  readonly setDays: (days: UsageDays) => void;
  readonly setShowUsage: (show: boolean) => void;
}

/** What the panel hands the MCP and Skills tabs. */
export interface ListTabProps {
  readonly client: SkillsMcpClient;
  /** Changes when the environment or workspace changes; keys the tab's loader. */
  readonly scopeKey: string;
  readonly cwd: string | null;
  /** Panel visible and this tab selected. */
  readonly active: boolean;
  readonly view: ListView;
  readonly viewActions: ListViewActions;
  readonly context: ContextOverview | null;
  readonly usage: UsageReport | null;
  readonly usageLoading: boolean;
  readonly usageError: string | null;
  /** A mutation went through: context cost may have changed. */
  readonly onChanged: () => void;
  /** The tab's Refresh button also re-measures context. */
  readonly onRefreshContext: () => void;
}

const SORT_MODES = ["status", "name", "context", "usage"] as const satisfies readonly SortMode[];

export function SearchField(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        size="sm"
        type="search"
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        className="w-full [&_input]:ps-7"
        onChange={(event) => props.onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && props.value) {
            event.preventDefault();
            props.onChange("");
          }
        }}
      />
      {props.value ? (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => props.onChange("")}
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

/** Filter by facet (status, tag, origin, source); grouped by `facet.group`, with counts. */
export const FacetMenu = memo(function FacetMenu(props: {
  facets: readonly Facet[];
  value: string;
  total: number;
  onChange: (facet: string) => void;
}) {
  const { facets, value, total, onChange } = props;
  const groups: { name: string; facets: Facet[] }[] = [];
  for (const facet of facets) {
    const group = groups.find((entry) => entry.name === facet.group);
    if (group) group.facets.push(facet);
    else groups.push({ name: facet.group, facets: [facet] });
  }
  const selected = facets.find((facet) => facet.id === value);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size={selected ? "xs" : "icon-xs"}
            variant={selected ? "secondary" : "ghost"}
            aria-label={selected ? `Filter: ${selected.label}` : "Filter"}
            className={cn(selected && "max-w-32")}
          />
        }
      >
        <FilterIcon />
        {selected ? <span className="truncate">{selected.label}</span> : null}
      </MenuTrigger>
      <MenuPopup align="end" className="w-56">
        <MenuRadioGroup value={value} onValueChange={(next) => onChange(String(next))}>
          <MenuRadioItem value={ALL_FACET}>
            <FacetLabel label="All" count={total} />
          </MenuRadioItem>
          {groups.map((group) => (
            <MenuGroup key={group.name}>
              <MenuSeparator />
              <MenuGroupLabel>{group.name}</MenuGroupLabel>
              {group.facets.map((facet) => (
                <MenuRadioItem key={facet.id} value={facet.id}>
                  <FacetLabel label={facet.label} count={facet.count} />
                </MenuRadioItem>
              ))}
            </MenuGroup>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});

function FacetLabel({ label, count }: { label: string; count: number }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
    </span>
  );
}

/** Sort order, whether call counts show, and the usage window. */
export const SortMenu = memo(function SortMenu(props: {
  view: ListView;
  actions: ListViewActions;
}) {
  const { view, actions } = props;
  const nonDefault = view.sort !== "status";
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size={nonDefault ? "xs" : "icon-xs"}
            variant={nonDefault ? "secondary" : "ghost"}
            aria-label={`Sort: ${SORT_LABEL[view.sort]}`}
          />
        }
      >
        <ArrowDownUpIcon />
        {nonDefault ? <span>{SORT_LABEL[view.sort]}</span> : null}
      </MenuTrigger>
      <MenuPopup align="end" className="w-52">
        <MenuGroup>
          <MenuGroupLabel>Sort by</MenuGroupLabel>
          <MenuRadioGroup
            value={view.sort}
            onValueChange={(next) => {
              const mode = SORT_MODES.find((candidate) => candidate === next);
              if (mode) actions.setSort(mode);
            }}
          >
            {SORT_MODES.map((mode) => (
              <MenuRadioItem key={mode} value={mode}>
                {SORT_LABEL[mode]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Usage</MenuGroupLabel>
          <MenuCheckboxItem
            checked={view.showUsage}
            onCheckedChange={(checked) => actions.setShowUsage(checked)}
          >
            Show call counts
          </MenuCheckboxItem>
          <MenuCheckboxItem
            checked={view.unusedOnly}
            onCheckedChange={(checked) => actions.setUnusedOnly(checked)}
          >
            Only unused
          </MenuCheckboxItem>
          <MenuRadioGroup
            value={String(view.days)}
            onValueChange={(next) => actions.setDays(next === "30" ? 30 : 7)}
          >
            <MenuRadioItem value="7">Last 7 days</MenuRadioItem>
            <MenuRadioItem value="30">Last 30 days</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

/**
 * The second toolbar line's right side: the Unused toggle and, once usage is
 * in play, the 7d/30d window.
 */
export const UsageControls = memo(function UsageControls(props: {
  view: ListView;
  actions: ListViewActions;
  noun: string;
}) {
  const { view, actions } = props;
  return (
    <div className="flex shrink-0 items-center gap-1">
      <WithReason reason={`Show ${props.noun} that are on but had 0 calls in the window`}>
        <Toggle
          size="xs"
          variant="ghost"
          pressed={view.unusedOnly}
          onPressedChange={(pressed) => actions.setUnusedOnly(pressed)}
          className="h-5 px-1.5 text-[.7rem] sm:h-5"
        >
          Unused
        </Toggle>
      </WithReason>
      {view.showUsage ? (
        <ToggleGroup
          aria-label="Usage window"
          value={[String(view.days)]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "7" || value === "30") actions.setDays(value === "30" ? 30 : 7);
          }}
          className="p-px"
        >
          <SegmentToggle value="7" className="h-4.5 px-1.5 text-[.65rem]">
            7d
          </SegmentToggle>
          <SegmentToggle value="30" className="h-4.5 px-1.5 text-[.65rem]">
            30d
          </SegmentToggle>
        </ToggleGroup>
      ) : null}
    </div>
  );
});

export function RefreshButton(props: { refreshing: boolean; onClick: () => void; label: string }) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={props.label}
      disabled={props.refreshing}
      onClick={props.onClick}
    >
      <RefreshIcon refreshing={props.refreshing} />
    </Button>
  );
}

/** One dense metadata chip ("12 tools", "3.2k tok"). */
export function Chip(props: { children: ReactNode; dim?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap text-[.65rem] tabular-nums",
        props.dim ? "text-muted-foreground/55" : "text-muted-foreground",
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}
