/**
 * The compact "what does a new thread start with" strip at the top of the
 * panel: one line per app with a static stacked bar, expandable to the
 * category and memory-file breakdown.
 */
import { ChevronRightIcon } from "lucide-react";
import { memo, useState } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

import { type ContextSummary, formatTokens } from "./context.logic";
import { APP_LABEL } from "./lists.logic";
import { WithReason } from "./shared";

/** Quiet, theme-aware fills; the buffer is the faintest. Assigned by segment order. */
const SEGMENT_FILLS = [
  "bg-foreground/55",
  "bg-info/70",
  "bg-success/60",
  "bg-warning/65",
  "bg-foreground/30",
  "bg-destructive/50",
  "bg-info/35",
  "bg-success/30",
] as const;
const BUFFER_FILL = "bg-muted-foreground/25";

function fillFor(summary: ContextSummary, name: string): string | null {
  const index = summary.segments.findIndex((segment) => segment.name === name);
  const segment = summary.segments[index];
  if (!segment) return null;
  if (segment.kind === "buffer") return BUFFER_FILL;
  return SEGMENT_FILLS[index % SEGMENT_FILLS.length] ?? BUFFER_FILL;
}

function StackedBar({ summary }: { summary: ContextSummary }) {
  return (
    <div
      aria-hidden
      className="flex h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-muted-foreground/10"
    >
      {summary.segments.map((segment, index) => (
        <div
          key={`${segment.name}:${index}`}
          className={cn(
            "h-full",
            segment.kind === "buffer"
              ? BUFFER_FILL
              : (SEGMENT_FILLS[index % SEGMENT_FILLS.length] ?? BUFFER_FILL),
          )}
          style={{ width: `${(segment.share * 100).toFixed(2)}%` }}
        />
      ))}
    </div>
  );
}

function SummaryLine({ summary }: { summary: ContextSummary }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-[.7rem]">
      <span className="w-11 shrink-0 font-medium text-foreground">{APP_LABEL[summary.app]}</span>
      {summary.error ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          context unavailable: {summary.error}
        </span>
      ) : (
        <>
          <StackedBar summary={summary} />
          <span className="shrink-0 text-muted-foreground tabular-nums">{summary.label}</span>
          {summary.exact ? null : (
            <span className="shrink-0 text-muted-foreground/60">estimate</span>
          )}
        </>
      )}
    </div>
  );
}

function Breakdown({ summary }: { summary: ContextSummary }) {
  const rows = [...summary.categories].sort((left, right) => right.tokens - left.tokens);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-1.5 text-[.7rem]">
        <span className="font-medium text-foreground">{APP_LABEL[summary.app]}</span>
        {summary.model ? (
          <span className="truncate text-muted-foreground">{summary.model}</span>
        ) : null}
        {summary.exact ? null : (
          <span className="text-muted-foreground/60">estimated from config</span>
        )}
      </div>
      <ul className="space-y-0.5">
        {rows.map((category, index) => {
          const fill = fillFor(summary, category.name);
          const dim = category.kind === "free" || category.kind === "deferred";
          return (
            <li
              key={`${category.name}:${index}`}
              className={cn(
                "flex items-center gap-1.5 text-[.7rem]",
                dim ? "text-muted-foreground/60" : "text-muted-foreground",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-[2px]",
                  fill ?? "border border-muted-foreground/30",
                )}
              />
              <span className="min-w-0 flex-1 truncate">
                {category.name}
                {category.kind === "deferred" ? " (deferred, loaded on demand)" : null}
              </span>
              <span className="shrink-0 tabular-nums">{formatTokens(category.tokens)}</span>
            </li>
          );
        })}
      </ul>
      {summary.memoryFiles.length > 0 ? (
        <div className="pt-1">
          <div className="text-[.65rem] text-muted-foreground/80 uppercase tracking-wider">
            Memory files
          </div>
          <ul className="space-y-0.5">
            {summary.memoryFiles.map((file) => (
              <li
                key={file.path}
                className="flex items-center gap-1.5 text-[.7rem] text-muted-foreground"
              >
                <WithReason reason={file.path}>
                  <span className="min-w-0 truncate font-mono text-[.65rem]">{file.path}</span>
                </WithReason>
                <span className="ml-auto shrink-0 tabular-nums">{formatTokens(file.tokens)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * `error` is a whole-call failure (including "not implemented yet" while the
 * server side lands); it shows as a muted note, never a toast.
 */
export const ContextStrip = memo(function ContextStrip(props: {
  summaries: readonly ContextSummary[];
  loading: boolean;
  error: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { summaries, loading, error } = props;

  if (summaries.length === 0) {
    if (loading) {
      return (
        <div className="flex items-center gap-1.5 border-b px-3 py-1.5 text-[.7rem] text-muted-foreground">
          <Spinner className="size-3" />
          Measuring what a new thread loads…
        </div>
      );
    }
    if (error) {
      return (
        <div className="truncate border-b px-3 py-1.5 text-[.7rem] text-muted-foreground/70">
          Context cost unavailable: {error}
        </div>
      );
    }
    return null;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b">
      <CollapsibleTrigger
        aria-label={open ? "Hide context breakdown" : "Show context breakdown"}
        className="group flex w-full items-start gap-1.5 px-3 py-1.5 text-left hover:bg-accent/40"
      >
        <ChevronRightIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none" />
        <div className="min-w-0 flex-1 space-y-1">
          {summaries.map((summary) => (
            <SummaryLine key={summary.app} summary={summary} />
          ))}
        </div>
        {loading ? <Spinner className="mt-0.5 size-3 shrink-0 text-muted-foreground" /> : null}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-3 px-3 pt-1 pb-2.5 pl-7">
          {summaries.map((summary) =>
            summary.error ? null : <Breakdown key={summary.app} summary={summary} />,
          )}
          {error ? (
            <div className="text-[.7rem] text-muted-foreground/70">
              Last refresh failed: {error}
            </div>
          ) : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
});
