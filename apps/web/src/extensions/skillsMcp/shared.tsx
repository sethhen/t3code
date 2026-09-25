/**
 * Shared plumbing for the Skills & MCP tabs: safe calls, the visible-only
 * overview loader, busy/optimistic keys, mutation toasts, and small pieces of
 * row chrome.
 */
import type {
  AgentApp,
  AgentAppInfo,
  ExtensionMethodInput,
  ExtensionMethodOutput,
  MutationResult,
  SkillsMcpMethods,
} from "@t3tools/contracts";
import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
  appUnavailableReason,
  formatRelativeTime,
  type StatusTone,
} from "./lists.logic";

export type SkillsMcpClient = ExtensionClient<SkillsMcpMethods>;
type Method = keyof SkillsMcpMethods & string;
export type Outcome<Value> = ExtensionCallOutcome<Value>;

/** `client.call` can reject (input encoding runs outside its try); fold that into an outcome. */
export async function safeCall<Name extends Method>(
  client: SkillsMcpClient,
  method: Name,
  input: ExtensionMethodInput<SkillsMcpMethods, Name>,
): Promise<Outcome<ExtensionMethodOutput<SkillsMcpMethods, Name>>> {
  try {
    return await client.call(method, input);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Overview loader

export interface OverviewState<Value> {
  readonly data: Value | null;
  readonly error: string | null;
  readonly loading: boolean;
  /** Reload now. Superseded responses are dropped; old data stays visible meanwhile. */
  readonly reload: (refresh?: boolean) => Promise<void>;
}

interface LoaderSnapshot<Value> {
  readonly key: string;
  readonly data: Value | null;
  readonly error: string | null;
  readonly loadedAt: number | null;
}

/**
 * Loads while `active` (panel visible and tab selected) when the key changed,
 * nothing is loaded yet, or the last load is older than `staleMs`. Never
 * fetches while inactive, except for explicit `reload` calls.
 */
export function useOverviewLoader<Value>(options: {
  readonly active: boolean;
  readonly key: string;
  readonly fetch: (refresh: boolean) => Promise<Outcome<Value>>;
  readonly staleMs?: number;
}): OverviewState<Value> {
  const { active, key, staleMs = 15_000 } = options;
  const [snapshot, setSnapshot] = useState<LoaderSnapshot<Value>>({
    key,
    data: null,
    error: null,
    loadedAt: null,
  });
  const [inFlight, setInFlight] = useState<string | null>(null);
  const latest = useRef({ fetch: options.fetch, key });
  const requestId = useRef(0);
  const pendingKey = useRef<string | null>(null);

  useLayoutEffect(() => {
    latest.current = { fetch: options.fetch, key };
  });

  const reload = useCallback(async (refresh = false) => {
    const { fetch, key: requestKey } = latest.current;
    const id = ++requestId.current;
    pendingKey.current = requestKey;
    setInFlight(requestKey);
    const outcome = await fetch(refresh);
    if (id !== requestId.current) return;
    pendingKey.current = null;
    setInFlight(null);
    setSnapshot((previous) => {
      const sameKey = previous.key === requestKey;
      return outcome.ok
        ? { key: requestKey, data: outcome.value, error: null, loadedAt: Date.now() }
        : {
            key: requestKey,
            data: sameKey ? previous.data : null,
            error: outcome.message,
            loadedAt: Date.now(),
          };
    });
  }, []);

  const current = snapshot.key === key;
  useEffect(() => {
    if (!active) return;
    if (pendingKey.current === key) return;
    const stale =
      !current || snapshot.loadedAt === null || Date.now() - snapshot.loadedAt > staleMs;
    if (stale) void reload();
    // Re-evaluated when the panel becomes visible or the key changes.
  }, [active, key]);

  return {
    data: current ? snapshot.data : null,
    error: current ? snapshot.error : null,
    loading: inFlight === key || (active && !current),
    reload,
  };
}

// ---------------------------------------------------------------------------
// Busy keys with optional optimistic values

export interface BusyKeys {
  readonly isBusy: (key: string) => boolean;
  /** The value a pending toggle is heading to, if any. */
  readonly optimistic: (key: string) => boolean | undefined;
  /** Runs `task` unless `key` is already busy. */
  readonly run: (key: string, task: () => Promise<unknown>, optimisticValue?: boolean) => void;
}

export function useBusyKeys(): BusyKeys {
  const [busy, setBusy] = useState<ReadonlyMap<string, boolean | null>>(() => new Map());
  const running = useRef(new Set<string>());

  const run = useCallback(
    (key: string, task: () => Promise<unknown>, optimisticValue?: boolean) => {
      if (running.current.has(key)) return;
      running.current.add(key);
      setBusy((previous) => new Map(previous).set(key, optimisticValue ?? null));
      void task().finally(() => {
        running.current.delete(key);
        setBusy((previous) => {
          const next = new Map(previous);
          next.delete(key);
          return next;
        });
      });
    },
    [],
  );

  return {
    isBusy: (key) => busy.has(key),
    optimistic: (key) => busy.get(key) ?? undefined,
    run,
  };
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
export function reportMutation(
  outcome: Outcome<MutationResult>,
  labels: { readonly failure: string; readonly success?: string },
): boolean {
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
      {(["claude", "codex"] as const).map((app) => {
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
  const reasons = (["claude", "codex"] as const)
    .map((app) => appUnavailableReason(apps, app))
    .filter((reason): reason is string => reason !== null);
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
