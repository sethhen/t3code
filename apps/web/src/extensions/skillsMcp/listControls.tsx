/**
 * List chrome shared by the MCP, Skills and Plugins tabs: search, the filter
 * and sort menus, the Unused toggle, and the list body with its rows, app
 * cells and empty states.
 */
import type { AgentApp, ContextOverview, UsageReport } from "@t3tools/contracts";
import { ArrowDownUpIcon, ChevronRightIcon, FilterIcon, SearchIcon, XIcon } from "lucide-react";
import { type ReactElement, type ReactNode, memo } from "react";

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
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle } from "~/components/ui/toggle";
import { Toggle as SegmentToggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { SORT_LABEL, type SortMode, usageFootnote } from "./context.logic";
import { ALL_FACET, APP_LABEL, type Facet, type RowSection } from "./lists.logic";
import {
  AppState,
  AppSwitch,
  EmptyState,
  ListPlaceholder,
  LoadError,
  SectionLabel,
  type SkillsMcpClient,
  WithReason,
} from "./shared";

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

/** T3's keyboard focus ring for the few hand-rolled buttons (Button has its own). */
export const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

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
          className={cn(
            "absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground",
            FOCUS_RING,
          )}
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

/** The only "refreshing" signal: background reloads never blank or lock the list. */
export function RefreshButton(props: { refreshing: boolean; onClick: () => void; label: string }) {
  return (
    <Button size="icon-xs" variant="ghost" aria-label={props.label} onClick={props.onClick}>
      <RefreshIcon refreshing={props.refreshing} />
    </Button>
  );
}

/** Hover hint on an inline element; without a hint the element renders as-is. */
export function Hint(props: { hint: ReactNode; children: ReactElement }) {
  if (props.hint === undefined || props.hint === null || props.hint === "") return props.children;
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-line break-words">
        {props.hint}
      </TooltipPopup>
    </Tooltip>
  );
}

/** One dense metadata chip ("12 tools", "C 3.2k · X 1k tok"). */
export function Chip(props: {
  children: ReactNode;
  dim?: boolean;
  className?: string;
  hint?: string | undefined;
}) {
  return (
    <Hint hint={props.hint}>
      <span
        className={cn(
          "shrink-0 whitespace-nowrap text-[.65rem] tabular-nums",
          props.dim ? "text-muted-foreground/55" : "text-muted-foreground",
          props.className,
        )}
      >
        {props.children}
      </span>
    </Hint>
  );
}

/** "12 of 40 servers" (or just "40 servers"). */
export function CountLabel(props: { shown: number; total: number; noun: [string, string] }) {
  const { shown, total } = props;
  return (
    <span className="shrink-0 tabular-nums">
      {shown === total ? total : `${shown} of ${total}`} {props.noun[total === 1 ? 0 : 1]}
    </span>
  );
}

/** The status line's usage text: loading, the error, or what the unused rows cost. */
export function UsageStatus(props: {
  view: ListView;
  usage: UsageReport | null;
  loading: boolean;
  error: string | null;
  unused: number;
  cost: string | null;
}) {
  const { view, loading } = props;
  let text: string | null = null;
  if (loading && view.showUsage) text = "Loading usage…";
  else if (props.error && view.showUsage) text = `Usage unavailable: ${props.error}`;
  else if (props.usage && props.unused > 0 && !loading)
    text = `${props.unused} unused${props.cost ? ` · ${props.cost}` : ""}`;
  return <span className="min-w-0 flex-1 truncate">{text}</span>;
}

/** "Call counts: 412 sessions in 7d" under the list while counts show. */
export function UsageFootnote(props: { usage: UsageReport | null; show: boolean; label: string }) {
  if (!props.usage || !props.show) return null;
  return (
    <p className="px-2 pt-3 text-[.65rem] text-muted-foreground/70">
      {props.label}: {usageFootnote(props.usage)}
    </p>
  );
}

export function RefreshFailed({ error }: { error: string }) {
  return (
    <div className="truncate text-[.7rem] text-destructive-foreground">
      Last refresh failed: {error}
    </div>
  );
}

/**
 * Everything under the toolbar: the first-load error or placeholder, then the
 * empty or no-match state, else the scrolling list. `container` names the
 * Tailwind container the rows query.
 */
export function ListBody(props: {
  loaded: boolean;
  error: string | null;
  onRetry: () => void;
  total: number;
  shown: number;
  empty: ReactNode;
  onClearFilters: () => void;
  container: string;
  children: ReactNode;
  /** Rendered below the list even when it is empty (backups, footnotes). */
  after?: ReactNode;
}) {
  if (!props.loaded) {
    return props.error ? (
      <LoadError message={props.error} onRetry={props.onRetry} />
    ) : (
      <ListPlaceholder rows={6} />
    );
  }
  let list = props.children;
  if (props.total === 0) list = props.empty;
  else if (props.shown === 0) {
    list = (
      <EmptyState title="No matches" description="Nothing matches the current search and filters.">
        <Button size="xs" variant="outline" onClick={props.onClearFilters}>
          Clear filters
        </Button>
      </EmptyState>
    );
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className={cn(props.container, "pb-3")}>
        {list}
        {props.after}
      </div>
    </ScrollArea>
  );
}

const APP_COLUMN = "flex w-11 shrink-0 justify-center";

/** "Server · Claude · Codex" over the rows. */
export function ColumnHeader(props: { label: string; columns: readonly AgentApp[] }) {
  return (
    <div className="flex items-center gap-1.5 border-b px-2 py-1 text-[.65rem] text-muted-foreground">
      <span className="min-w-0 flex-1 pl-4.5">{props.label}</span>
      {props.columns.map((app) => (
        <span key={app} className={APP_COLUMN}>
          {APP_LABEL[app]}
        </span>
      ))}
      <span className="w-6 shrink-0" />
    </div>
  );
}

/** Labelled sections ("Needs attention · 2"); an empty label renders the rows bare. */
export function Sections<Row>(props: {
  sections: readonly RowSection<Row>[];
  render: (row: Row) => ReactNode;
}) {
  return (
    <>
      {props.sections.map((section) => (
        <section key={section.id}>
          {section.label ? (
            <SectionLabel className="px-2">
              {section.label} · {section.rows.length}
            </SectionLabel>
          ) : null}
          <ul>{section.rows.map(props.render)}</ul>
        </section>
      ))}
    </>
  );
}

/** One dense list row; `below` holds the expanded details. */
export function ListRow(props: { children: ReactNode; below?: ReactNode }) {
  return (
    <li className="border-border/50 border-b last:border-b-0">
      <div className="flex min-h-8 items-center gap-1.5 px-2 py-1 hover:bg-accent/30">
        {props.children}
      </div>
      {props.below}
    </li>
  );
}

/** The row's name area; clicking it expands the details. */
export function ExpandButton(props: {
  expanded: boolean;
  name: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={props.expanded}
      aria-label={`${props.expanded ? "Collapse" : "Expand"} ${props.name}`}
      className={cn("flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left", FOCUS_RING)}
      onClick={props.onClick}
    >
      <ChevronRightIcon
        className={cn(
          "size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
          props.expanded && "rotate-90",
        )}
      />
      {props.children}
    </button>
  );
}

/**
 * One app column. Rows T3 manages get a real switch; everything else shows a
 * read-only dot with the entry's origin in the tooltip (or a dash when absent).
 */
export function AppCell(props: {
  app: AgentApp;
  subject: string;
  entry: { readonly present: boolean; readonly enabled: boolean } | undefined;
  managed: boolean;
  optimistic: boolean | undefined;
  /** Why the switch is locked (managed) or where the entry lives (read-only). */
  reason: string | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { app, entry } = props;
  let cell: ReactNode;
  if (props.managed) {
    cell = (
      <AppSwitch
        compact
        app={app}
        subject={props.subject}
        checked={props.optimistic ?? entry?.enabled ?? false}
        blockedReason={props.reason}
        busy={props.busy}
        onCheckedChange={props.onToggle}
      />
    );
  } else if (entry?.present) {
    cell = <AppState app={app} enabled={entry.enabled} origin={props.reason} />;
  } else {
    cell = <span className="text-muted-foreground/40 text-xs">–</span>;
  }
  return <div className={APP_COLUMN}>{cell}</div>;
}
