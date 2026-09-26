/**
 * Shared plumbing for the Skills & MCP tabs: the overview loader (from
 * overviewStore), background mutations with optimistic values, mutation
 * toasts, and small pieces of row chrome.
 */
import type { AgentApp, AgentAppInfo, MutationResult, SkillsMcpMethods } from "@t3tools/contracts";
import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Checkbox } from "~/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import type { ExtensionCallOutcome, ExtensionClient } from "../client";
import {
  APP_LABEL,
  APPS,
  appUnavailableReason,
  formatRelativeTime,
  type StatusTone,
} from "./lists.logic";
export { type OverviewState, useOverviewLoader } from "./overviewStore";

export type SkillsMcpClient = ExtensionClient<SkillsMcpMethods>;
export type Outcome<Value> = ExtensionCallOutcome<Value>;

export { APPS };

/** Apps worth a column: available, or holding at least one row's entry. */
export function visibleApps(
  apps: readonly AgentAppInfo[] | undefined,
  rows: readonly {
    readonly apps: Partial<Record<AgentApp, { readonly present: boolean } | undefined>>;
  }[],
): AgentApp[] {
  return APPS.filter(
    (app) =>
      apps?.some((info) => info.app === app && info.available) ||
      rows.some((row) => row.apps[app]?.present),
  );
}

/** Dialog state; the key remounts the dialog so each opening starts fresh. */
export interface Opened<Value> {
  readonly key: number;
  readonly open: boolean;
  readonly value: Value;
}

export function reopen<Value>(previous: Opened<Value> | null, value: Value): Opened<Value> {
  return { key: (previous?.key ?? 0) + 1, open: true, value };
}

export function closed<Value>(previous: Opened<Value> | null): Opened<Value> | null {
  return previous ? { ...previous, open: false } : null;
}

/**
 * Handlers with stable identities that always run the latest render's
 * version, so memoized rows can take them without re-rendering.
 */
export function useStableActions<Actions extends Record<string, (...args: never[]) => void>>(
  actions: Actions,
): Actions {
  const ref = useRef(actions);
  useLayoutEffect(() => {
    ref.current = actions;
  });
  const [stable] = useState(() => {
    const wrapped: Record<string, (...args: never[]) => void> = {};
    for (const name of Object.keys(actions)) {
      wrapped[name] = (...args: never[]) => ref.current[name]?.(...args);
    }
    return wrapped as Actions;
  });
  return stable;
}

/** Row keys that are expanded. */
export function useExpandedSet(): {
  readonly expanded: ReadonlySet<string>;
  readonly toggle: (key: string) => void;
} {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  return { expanded, toggle };
}

// ---------------------------------------------------------------------------
// Mutations

export interface MutationLabels {
  readonly failure: string;
  /** Used when the server sends no message of its own. */
  readonly success?: string;
}

export interface MutationStep {
  readonly call: () => Promise<Outcome<MutationResult>>;
  readonly labels: MutationLabels;
}

interface MutationEntry {
  readonly running: boolean;
  readonly value?: boolean | undefined;
  /** The list data the settled value was set against; fresh data retires it. */
  readonly settledOn?: unknown;
}

export interface Mutations {
  /** True only while the key's own calls run (never during the reload after). */
  readonly isBusy: (key: string) => boolean;
  /**
   * The value a toggle is heading to, held from the click until fresh data
   * lands. On a row key, `false` means the row is being removed.
   */
  readonly optimistic: (key: string) => boolean | undefined;
  /** Runs `task` unless `key` is already busy. */
  readonly run: (key: string, task: () => Promise<unknown>) => void;
  /**
   * Runs the steps in order, toasting each. Once any call went through, the
   * list reloads in the background and `onChanged` refreshes context and usage.
   */
  readonly mutate: (key: string, steps: readonly MutationStep[], optimistic?: boolean) => void;
}

/** Runs the steps in order, toasting each; `clean` means every call fully succeeded. */
async function runSteps(steps: readonly MutationStep[]) {
  let changed = false;
  let clean = true;
  for (const step of steps) {
    const outcome = await step.call();
    if (!reportMutation(outcome, step.labels)) clean = false;
    if (outcome.ok) changed = true;
  }
  return { changed, clean };
}

/**
 * Per-key mutations for a list. Rows unlock as soon as their calls return and
 * keep the optimistic value until the reload replaces the data; the loader
 * drops superseded responses, so an older reload never overwrites a newer one.
 */
export function useMutations(
  options: {
    readonly data?: unknown;
    readonly reload?: (refresh?: boolean) => Promise<void>;
    readonly onChanged?: () => void;
  } = {},
): Mutations {
  const [entries, setEntries] = useState<ReadonlyMap<string, MutationEntry>>(() => new Map());
  const running = useRef(new Set<string>());
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });

  const start = useCallback((key: string, value?: boolean): boolean => {
    if (running.current.has(key)) return false;
    running.current.add(key);
    const { data } = latest.current;
    setEntries((previous) => {
      const next = new Map<string, MutationEntry>();
      for (const [other, entry] of previous) {
        if (entry.running || entry.settledOn === data) next.set(other, entry);
      }
      return next.set(key, { running: true, value });
    });
    return true;
  }, []);

  const settle = useCallback((key: string, entry: MutationEntry | null) => {
    running.current.delete(key);
    setEntries((previous) => {
      const next = new Map(previous);
      if (entry) next.set(key, entry);
      else next.delete(key);
      return next;
    });
  }, []);

  const run = useCallback(
    (key: string, task: () => Promise<unknown>) => {
      if (!start(key)) return;
      void task().finally(() => settle(key, null));
    },
    [start, settle],
  );

  const mutate = useCallback(
    (key: string, steps: readonly MutationStep[], value?: boolean) => {
      if (!start(key, value)) return;
      void runSteps(steps).then(
        ({ changed, clean }) => {
          const { data, reload, onChanged } = latest.current;
          const keep = clean && value !== undefined;
          settle(key, keep ? { running: false, value, settledOn: data } : null);
          if (changed) {
            void reload?.(false);
            onChanged?.();
          }
        },
        () => settle(key, null),
      );
    },
    [start, settle],
  );

  // Stable between mutation changes, so memoized rows can take it as a prop.
  const { data } = options;
  return useMemo(
    () => ({
      isBusy: (key) => entries.get(key)?.running === true,
      optimistic: (key) => {
        const entry = entries.get(key);
        return entry && (entry.running || entry.settledOn === data) ? entry.value : undefined;
      },
      run,
      mutate,
    }),
    [entries, data, run, mutate],
  );
}

// ---------------------------------------------------------------------------
// Mutation reporting

function failureLines(result: MutationResult): string {
  return result.failures
    .map((failure) =>
      failure.app ? `${APP_LABEL[failure.app]}: ${failure.message}` : failure.message,
    )
    .join("\n");
}

/**
 * Toasts the outcome of a mutation. Returns true only when the call went
 * through with no per-app failures.
 */
export function reportMutation(outcome: Outcome<MutationResult>, labels: MutationLabels): boolean {
  if (!outcome.ok) {
    toastManager.add({ type: "error", title: labels.failure, description: outcome.message });
    return false;
  }
  const { failures, message } = outcome.value;
  if (failures.length > 0) {
    toastManager.add({
      type: "error",
      title: message ? `${labels.failure} (${message})` : labels.failure,
      description: failureLines(outcome.value),
    });
    return false;
  }
  const title = message ?? labels.success;
  if (title) toastManager.add({ type: "success", title });
  return true;
}

// ---------------------------------------------------------------------------
// Small UI pieces

const TONE_CLASS: Readonly<Record<StatusTone, string>> = {
  success: "bg-success",
  destructive: "bg-destructive",
  warning: "bg-warning",
  info: "bg-info",
  muted: "bg-muted-foreground/50",
};

export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", TONE_CLASS[tone], className)}
    />
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "px-1.5 pt-3 pb-1 font-medium text-[.65rem] text-muted-foreground uppercase tracking-wider",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Wraps a control in a tooltip when there is a reason to explain; disabled controls need the span. */
export function WithReason({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{children}</TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64">
        {reason}
      </TooltipPopup>
    </Tooltip>
  );
}

export function AppSwitch(props: {
  app: AgentApp;
  checked: boolean;
  /** Locks the switch and explains why in a tooltip. */
  blockedReason: string | null;
  busy: boolean;
  onCheckedChange: (checked: boolean) => void;
  subject: string;
  /** Hide the visible app name (the list has a column header instead). */
  compact?: boolean;
}) {
  const label = `${props.checked ? "Disable" : "Enable"} ${props.subject} for ${APP_LABEL[props.app]}`;
  return (
    <WithReason reason={props.blockedReason}>
      <label className="inline-flex items-center gap-1 text-[.7rem] text-muted-foreground">
        {props.compact ? null : <span>{APP_LABEL[props.app]}</span>}
        <Switch
          aria-label={label}
          size="sm"
          checked={props.checked}
          disabled={props.blockedReason !== null || props.busy}
          onCheckedChange={(checked) => props.onCheckedChange(checked)}
        />
      </label>
    </WithReason>
  );
}

/** Read-only on/off for rows T3 does not manage; the tooltip says where the entry lives. */
export function AppState(props: { app: AgentApp; enabled: boolean; origin: string | null }) {
  return (
    <WithReason reason={props.origin}>
      <span
        aria-label={`${APP_LABEL[props.app]} ${props.enabled ? "on" : "off"}`}
        className="inline-flex items-center gap-1 text-[.65rem] text-muted-foreground"
      >
        <StatusDot tone={props.enabled ? "success" : "muted"} />
        {props.enabled ? "on" : "off"}
      </span>
    </WithReason>
  );
}

/** Claude/Codex checkboxes for install/adopt/add flows. */
export function AppCheckboxes(props: {
  value: { readonly claude: boolean; readonly codex: boolean };
  onChange: (next: { claude: boolean; codex: boolean }) => void;
  apps?: readonly AgentAppInfo[];
  /** Per-app reason the box is locked (e.g. Codex has no SSE). */
  blocked?: Partial<Record<AgentApp, string | null>>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {APPS.map((app) => {
        const reason =
          props.blocked?.[app] ?? (props.apps ? appUnavailableReason(props.apps, app) : null);
        return (
          <WithReason key={app} reason={reason}>
            <label
              className={cn(
                "inline-flex items-center gap-1.5 text-xs",
                reason ? "text-muted-foreground" : "text-foreground",
              )}
            >
              <Checkbox
                checked={props.value[app] && !reason}
                disabled={reason !== null}
                onCheckedChange={(checked) =>
                  props.onChange({ ...props.value, [app]: checked === true })
                }
              />
              {APP_LABEL[app]}
            </label>
          </WithReason>
        );
      })}
    </div>
  );
}

export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>
            Cancel
          </AlertDialogClose>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              props.onOpenChange(false);
              props.onConfirm();
            }}
          >
            {props.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** One line per app that could not be asked. */
export function AppNotices({ apps }: { apps: readonly AgentAppInfo[] }) {
  const reasons = APPS.map((app) => appUnavailableReason(apps, app)).filter(
    (reason): reason is string => reason !== null,
  );
  if (reasons.length === 0) return null;
  return (
    <div className="space-y-1 border-b bg-warning/5 px-3 py-1.5 text-warning-foreground text-xs">
      {reasons.map((reason) => (
        <div key={reason} className="flex items-start gap-1.5">
          <AlertCircleIcon className="mt-0.5 size-3 shrink-0 text-warning" />
          <span className="min-w-0 break-words">{reason}</span>
        </div>
      ))}
    </div>
  );
}

/** Static placeholder rows (no looping animation). */
export function ListPlaceholder({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy className="space-y-2 p-3">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <Spinner className="size-3.5" />
        Loading…
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="space-y-1.5 rounded-md px-1.5 py-1.5">
          <div className="h-3 w-1/3 rounded-sm bg-muted-foreground/10" />
          <div className="h-2.5 w-2/3 rounded-sm bg-muted-foreground/10" />
        </div>
      ))}
    </div>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b bg-destructive/5 px-3 py-2 text-destructive text-xs"
    >
      <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <Button size="xs" variant="outline" onClick={onRetry}>
        <RefreshCwIcon />
        Retry
      </Button>
    </div>
  );
}

export function EmptyState(props: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Empty className="py-10">
      <EmptyHeader>
        <EmptyTitle className="text-sm">{props.title}</EmptyTitle>
        {props.description ? (
          <EmptyDescription className="text-xs">{props.description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {props.children}
    </Empty>
  );
}

/** "checked 12 s ago", re-rendered every 5 s only while visible. */
export function CheckedAgo({ iso, visible }: { iso: string | null; visible: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible || iso === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [visible, iso]);
  if (iso === null) return null;
  const relative = formatRelativeTime(iso, now);
  if (relative === null) return null;
  return (
    <span className="shrink-0 whitespace-nowrap text-[.7rem] text-muted-foreground tabular-nums">
      checked {relative}
    </span>
  );
}

/** A row's own busy spinner, sized for the action cluster. */
export function RowSpinner() {
  return <Spinner className="size-3.5 text-muted-foreground" />;
}
