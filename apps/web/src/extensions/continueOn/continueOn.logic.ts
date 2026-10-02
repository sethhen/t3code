/**
 * Pure helpers for "Continue on…": whether a Claude or Codex thread stopped on
 * its account's usage limit, which of the user's other accounts can take it
 * over (same driver, same conversation store, ready like the model picker
 * offers them), most quota left first, and the line each one shows.
 */
import type {
  ModelSelection,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThreadActivity,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { formatResetsIn, remainingPercent } from "@t3tools/shared/usageLimits";

import type { ProviderInstanceEntry, QueuedComposerMessage } from "./t3";

/** The prompt a moved thread resumes with; upstream's own wording for a continued turn. */
export const CONTINUE_PROMPT = "Continue where you left off.";

/** The drivers whose accounts can take a thread over, as the Providers list names them. */
export const CONTINUE_PROVIDER_LABEL: Readonly<Record<string, string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
};

/** Claude's own pause row, and the fork's row for a long rate-limit wait (claudeRetryWait.ts). */
const PAUSED_PREFIXES = ["Claude usage limit reached.", "Claude is rate limited."];

const FAILED_PREFIXES = [
  "Claude usage limit reached.",
  "Claude stopped: a usage limit blocked the request.",
  "Codex usage limit reached.",
];

export interface UsageLimitStop {
  /** `paused`: the turn still runs, parked until the limit resets. `failed`: the turn ended. */
  readonly kind: "paused" | "failed";
  /** New for each stop: the pause's warning row, or the failed turn. */
  readonly key: string;
}

type StopActivity = Pick<
  OrchestrationThreadActivity,
  "id" | "kind" | "payload" | "turnId" | "sequence" | "createdAt"
>;

export interface StopThread {
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId" | "lastError"> | null;
  readonly latestTurn: { readonly turnId: string } | null;
  readonly activities: ReadonlyArray<StopActivity>;
  readonly messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "turnId" | "updatedAt">>;
}

/** Live arrays are sorted, but a snapshot loaded from the database is not, so order by sequence. */
function compareActivities(a: StopActivity, b: StopActivity): number {
  return (a.sequence ?? -1) - (b.sequence ?? -1) || a.createdAt.localeCompare(b.createdAt);
}

function isLimitWarning(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const message =
    "message" in payload && typeof payload.message === "string" ? payload.message : "";
  if (PAUSED_PREFIXES.some((prefix) => message.startsWith(prefix))) return true;
  // Claude's pause row carries the SDK's rate-limit info, which says "rejected" for a parked window.
  const detail = "detail" in payload ? payload.detail : undefined;
  return (
    typeof detail === "object" &&
    detail !== null &&
    "status" in detail &&
    detail.status === "rejected"
  );
}

/**
 * The thread's current usage-limit stop, or null. A Claude turn that hit its
 * limit mid-turn stays running, parked; its newest warning says so until the
 * turn moves on (any newer activity, or any newer message from the agent:
 * reasoning, assistant text or a system note). A turn that failed on
 * its limit leaves the reason in `session.lastError`, which the next turn keeps
 * while it runs, so a running or starting session never counts as failed.
 */
export function usageLimitStop(thread: StopThread): UsageLimitStop | null {
  const session = thread.session;
  if (session === null) return null;
  if (session.status === "running") {
    const turnId = session.activeTurnId;
    if (turnId === null) return null;
    const turnActivities = thread.activities.filter((activity) => activity.turnId === turnId);
    const warning = turnActivities
      .filter((activity) => activity.kind === "runtime.warning")
      .reduce<StopActivity | null>(
        (newest, activity) =>
          newest === null || compareActivities(activity, newest) > 0 ? activity : newest,
        null,
      );
    if (warning === null || !isLimitWarning(warning.payload)) return null;
    const movedOn =
      turnActivities.some(
        (activity) =>
          activity.kind !== "runtime.warning" && compareActivities(activity, warning) > 0,
      ) ||
      thread.messages.some(
        (message) =>
          message.role !== "user" &&
          message.turnId === turnId &&
          message.updatedAt > warning.createdAt,
      );
    return movedOn ? null : { kind: "paused", key: warning.id };
  }
  if (session.status === "starting") return null;
  const error = session.lastError;
  return error !== null && FAILED_PREFIXES.some((prefix) => error.startsWith(prefix))
    ? { kind: "failed", key: thread.latestTurn?.turnId ?? error }
    : null;
}

/** How an account is named: its signed-in address, else the instance name. */
export function accountName(entry: ProviderInstanceEntry): string {
  return entry.snapshot.auth.email ?? entry.displayName;
}

export interface ContinueCandidate {
  readonly entry: ProviderInstanceEntry;
  /** Quota left in the account's tightest window, 0..100, or null when it reports none. */
  readonly headroom: number | null;
  /** That window, for its reset time. */
  readonly window: ServerProviderUsageWindow | null;
}

/**
 * The accounts that can continue a thread running on `current`. `readyEntries`
 * are the instances the model picker would offer (`isProviderInstancePickerReady`).
 * A candidate runs the same driver and shares the conversation store (same
 * continuation key), so it can resume the conversation; both keys must be known.
 * Most headroom first, accounts that report no quota last.
 */
export function continueCandidates(
  readyEntries: ReadonlyArray<ProviderInstanceEntry>,
  current: ProviderInstanceEntry,
): ContinueCandidate[] {
  const groupKey = current.continuationGroupKey;
  if (!groupKey) return [];
  return readyEntries
    .filter(
      (entry) =>
        entry.instanceId !== current.instanceId &&
        entry.driverKind === current.driverKind &&
        entry.continuationGroupKey === groupKey,
    )
    .map((entry) => {
      const window =
        entry.snapshot.usageLimits?.windows.reduce<ServerProviderUsageWindow | null>(
          (tightest, candidate) =>
            tightest === null || remainingPercent(candidate) < remainingPercent(tightest)
              ? candidate
              : tightest,
          null,
        ) ?? null;
      return { entry, window, headroom: window === null ? null : remainingPercent(window) };
    })
    .toSorted((a, b) => (b.headroom ?? -1) - (a.headroom ?? -1));
}

/** The line under a candidate: `Claude Max · 82% left · resets in 2h 13m`. */
export function candidateSummary(candidate: ContinueCandidate, now: number): string {
  const { entry, headroom, window } = candidate;
  const quota =
    headroom === null || window === null
      ? "usage unknown"
      : [`${headroom}% left`, formatResetsIn(window, now)].filter(Boolean).join(" · ");
  return [entry.snapshot.auth.label, quota].filter(Boolean).join(" · ");
}

type QueuesByThreadKey = Record<string, QueuedComposerMessage[]>;

/**
 * Holds a thread's waiting queued messages while it moves, each pointed at
 * the picked account (`retarget` gets the message's own selection). Messages
 * already being sent are left alone. `held` names the ones this held, which
 * `releaseQueueAfterMove` lets go once the move lands; other threads' queues
 * are untouched.
 */
export function holdQueueForMove(
  queuesByThreadKey: QueuesByThreadKey,
  threadKey: string,
  retarget: (selection: ModelSelection) => ModelSelection,
): { readonly queuesByThreadKey: QueuesByThreadKey; readonly held: ReadonlySet<string> } {
  const held = new Set<string>();
  const queue = queuesByThreadKey[threadKey];
  if (!queue) return { queuesByThreadKey, held };
  const next = queue.map((message) => {
    if (message.sending) return message;
    if (!message.holdUntilUserAction) held.add(message.id);
    return {
      ...message,
      holdUntilUserAction: true,
      sendSettings: {
        ...message.sendSettings,
        modelSelection: retarget(message.sendSettings.modelSelection),
      },
    };
  });
  return { queuesByThreadKey: { ...queuesByThreadKey, [threadKey]: next }, held };
}

/** Lets go of the messages `holdQueueForMove` held that are still waiting; the rest stay as they are. */
export function releaseQueueAfterMove(
  queuesByThreadKey: QueuesByThreadKey,
  threadKey: string,
  held: ReadonlySet<string>,
): QueuesByThreadKey {
  const queue = queuesByThreadKey[threadKey];
  const releases = (message: QueuedComposerMessage) => held.has(message.id) && !message.sending;
  if (!queue?.some(releases)) return queuesByThreadKey;
  return {
    ...queuesByThreadKey,
    [threadKey]: queue.map((message) =>
      releases(message) ? { ...message, holdUntilUserAction: false } : message,
    ),
  };
}
