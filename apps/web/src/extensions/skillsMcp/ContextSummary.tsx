/**
 * The footer: what a new thread starts with in each app, as the same thin bar
 * Usage → Limits draws (one fill in the provider's colour), with the breakdown
 * on hover.
 */
import type { AgentApp } from "@t3tools/contracts";
import { memo } from "react";

import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { type ContextSummary, formatTokens } from "./context.logic";
import { FOCUS_RING } from "./listControls";
import { APP_LABEL } from "./lists.logic";
import { SectionLabel } from "./shared";
import { PROVIDER_PRESENTATION } from "./t3";

const FILL: Readonly<Record<AgentApp, string>> = {
  claude: PROVIDER_PRESENTATION.claude.color,
  codex: PROVIDER_PRESENTATION.codex.color,
};

function Breakdown({ summary }: { summary: ContextSummary }) {
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-foreground">
          {APP_LABEL[summary.app]}
          {summary.model ? (
            <span className="ms-1.5 font-normal text-muted-foreground">{summary.model}</span>
          ) : null}
        </span>
        <span className="text-muted-foreground tabular-nums">{summary.label}</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {summary.categories.map((category) => (
          <li
            key={`${category.kind}:${category.name}`}
            className="flex items-center justify-between gap-3 text-muted-foreground"
          >
            <span className="min-w-0 truncate">
              {category.kind === "deferred"
                ? `${category.name.replace(/\s*\(deferred\)$/i, "")}, on demand`
                : category.name}
            </span>
            <span className="shrink-0 tabular-nums">{formatTokens(category.tokens)}</span>
          </li>
        ))}
      </ul>
      {summary.memoryFiles.length > 0 ? (
        <div className="flex flex-col gap-0.5 border-t pt-1.5 text-muted-foreground">
          {summary.memoryFiles.map((file) => (
            <div key={file.path} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate font-mono text-[.65rem]">{file.path}</span>
              <span className="shrink-0 tabular-nums">{formatTokens(file.tokens)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {summary.note ? <div className="text-muted-foreground/70">{summary.note}</div> : null}
    </div>
  );
}

function ContextBar({ summary }: { summary: ContextSummary }) {
  if (summary.error) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-[.7rem]">
        <span className="w-11 shrink-0 text-muted-foreground">{APP_LABEL[summary.app]}</span>
        <span className="min-w-0 truncate text-muted-foreground/70">
          unavailable: {summary.error}
        </span>
      </div>
    );
  }
  const percent = Math.round(summary.share * 100);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="img"
            tabIndex={0}
            aria-label={`${APP_LABEL[summary.app]}: a new thread starts with ${summary.label} tokens`}
            className={`flex min-w-0 cursor-default items-center gap-2 rounded-sm text-[.7rem] ${FOCUS_RING}`}
          />
        }
      >
        <span className="w-11 shrink-0 text-muted-foreground">{APP_LABEL[summary.app]}</span>
        <span className="relative h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-muted">
          {percent > 0 ? (
            <span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${Math.max(percent, 1)}%`, backgroundColor: FILL[summary.app] }}
            />
          ) : null}
        </span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{summary.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="w-72 max-w-none">
        <Breakdown summary={summary} />
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * `error` is a whole-call failure; it shows as a muted note, never a toast.
 * A background reload keeps the last numbers.
 */
export const ContextFooter = memo(function ContextFooter(props: {
  summaries: readonly ContextSummary[];
  loading: boolean;
  error: string | null;
}) {
  const { summaries, loading, error } = props;
  return (
    <div className="border-t px-3 pt-1 pb-2.5">
      <SectionLabel className="px-0 pt-1.5">New thread context</SectionLabel>
      {summaries.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {summaries.map((summary) => (
            <ContextBar key={summary.app} summary={summary} />
          ))}
        </div>
      ) : loading ? (
        <div className="flex items-center gap-1.5 text-[.7rem] text-muted-foreground">
          <Spinner className="size-3" />
          Measuring…
        </div>
      ) : (
        <div className="truncate text-[.7rem] text-muted-foreground/70">
          {error ? `Unavailable: ${error}` : "Unavailable"}
        </div>
      )}
    </div>
  );
});
