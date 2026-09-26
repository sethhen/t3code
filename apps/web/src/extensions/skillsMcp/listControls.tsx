/**
 * List chrome shared by the MCP, Skills and Plugins tabs: the list body and
 * its states, the app columns, rows, the folded "Built in" group, and the
 * per-app switch cell.
 */
import type { AgentApp } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { type ReactElement, type ReactNode } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { APP_LABEL, type AppControl, type ListSections } from "./lists.logic";
import { AppSwitch, ListPlaceholder, LoadError, SectionLabel } from "./shared";

/** T3's keyboard focus ring for the few hand-rolled buttons (Button has its own). */
export const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

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

/** One quiet metadata chip ("44k tok", "project"). */
export function Chip(props: {
  children: ReactNode;
  className?: string;
  hint?: string | undefined;
}) {
  return (
    <Hint hint={props.hint}>
      <span
        className={cn(
          "shrink-0 whitespace-nowrap text-[.65rem] text-muted-foreground tabular-nums",
          props.className,
        )}
      >
        {props.children}
      </span>
    </Hint>
  );
}

export function RefreshFailed({ error }: { error: string }) {
  return (
    <div className="truncate border-b px-3 py-1 text-[.7rem] text-destructive-foreground">
      Last refresh failed: {error}
    </div>
  );
}

/**
 * Everything under the tab bar: the first-load error or placeholder, the
 * empty state, else the scrolling list. `container` names the Tailwind
 * container the rows query.
 */
export function ListBody(props: {
  loaded: boolean;
  error: string | null;
  onRetry: () => void;
  isEmpty: boolean;
  empty: ReactNode;
  container: string;
  children: ReactNode;
}) {
  if (!props.loaded) {
    return props.error ? (
      <LoadError message={props.error} onRetry={props.onRetry} />
    ) : (
      <ListPlaceholder rows={6} />
    );
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className={cn(props.container, "pb-3")}>
        {props.isEmpty ? props.empty : props.children}
      </div>
    </ScrollArea>
  );
}

const APP_COLUMN = "flex w-11 shrink-0 justify-center";

/** "Claude · Codex" over the switch columns. */
export function ColumnHeader(props: { columns: readonly AgentApp[] }) {
  return (
    <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[.65rem] text-muted-foreground">
      <span className="min-w-0 flex-1" />
      {props.columns.map((app) => (
        <span key={app} className={APP_COLUMN}>
          {APP_LABEL[app]}
        </span>
      ))}
    </div>
  );
}

/**
 * Problems first (labelled), then the user's own rows, then the open
 * project's, then everything that came with Claude Code, Codex, T3 or a
 * plugin, folded away.
 */
export function SectionedList<Row>(props: {
  sections: ListSections<Row>;
  /** `builtIn` rows sit in the folded group and keep their problems quiet. */
  render: (row: Row, builtIn: boolean) => ReactNode;
  /** What the folded group holds, after its count. */
  builtInHint?: string;
}) {
  const own = (row: Row) => props.render(row, false);
  const { attention, yours, project, builtIn } = props.sections;
  return (
    <>
      {attention.length > 0 ? (
        <section>
          <SectionLabel className="px-2 pt-2">Needs attention</SectionLabel>
          <ul>{attention.map(own)}</ul>
        </section>
      ) : null}
      {yours.length > 0 ? (
        <ul className={cn(attention.length > 0 && "mt-2 border-t")}>{yours.map(own)}</ul>
      ) : null}
      {project.length > 0 ? (
        <section>
          <SectionLabel className="px-2 pt-3">This project</SectionLabel>
          <ul>{project.map(own)}</ul>
        </section>
      ) : null}
      {builtIn.length > 0 ? (
        <Collapsible className={cn(attention.length + yours.length + project.length > 0 && "mt-3")}>
          <CollapsibleTrigger
            className={cn(
              "group flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[.65rem] text-muted-foreground hover:bg-accent/30",
              FOCUS_RING,
            )}
          >
            <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none" />
            <span className="font-medium uppercase tracking-wider">
              Built in · {builtIn.length}
            </span>
            <span className="min-w-0 truncate text-muted-foreground/70">
              {props.builtInHint ?? "from Claude Code, Codex, T3 and plugins"}
            </span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <ul>{builtIn.map((row) => props.render(row, true))}</ul>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </>
  );
}

/** One row; `below` holds the details or problem lines. */
export function ListRow(props: { children: ReactNode; below?: ReactNode }) {
  return (
    <li>
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
          "size-3 shrink-0 text-muted-foreground/60 transition-transform motion-reduce:transition-none",
          props.expanded && "rotate-90",
        )}
      />
      {props.children}
    </button>
  );
}

/**
 * One app column: a switch wherever the app has the row. When T3 cannot flip
 * it (T3's own server, a plugin's), the switch shows the state, locked, and
 * says where to change it; a dash means the app does not have it.
 */
export function AppCell(props: {
  app: AgentApp;
  subject: string;
  enabled: boolean;
  control: AppControl | null;
  /** The app's CLI could not be asked. */
  unavailable: string | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { control } = props;
  return (
    <div className={APP_COLUMN}>
      {control === null ? (
        <span className="text-muted-foreground/40 text-xs">–</span>
      ) : (
        <AppSwitch
          app={props.app}
          subject={props.subject}
          checked={props.enabled}
          blockedReason={control.kind === "locked" ? control.reason : props.unavailable}
          busy={props.busy}
          onCheckedChange={props.onToggle}
        />
      )}
    </div>
  );
}
