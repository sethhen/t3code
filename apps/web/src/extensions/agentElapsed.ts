/**
 * Where an Agents-panel elapsed timer starts.
 *
 * A Claude workflow member never gets a `startedAt` from the subagent fold: its
 * running state reaches T3 as "pending" (Claude reports `state: "progress"`
 * with a numeric `startedAt`, which ClaudeAdapter's workflowAgentStatus does not
 * read). Its only activity rows are latest-state upserts, so its `firstSeenAt`
 * moves to its last tool call or token tick. The panel therefore remembers the
 * earliest start it saw for each run: a member's clock ticks from when it
 * appeared and never resets. Until the adapter carries the provider's start
 * time, a reload mid-run restarts that clock from the member's latest row.
 * The host edit in AgentsPanel.tsx reads this.
 */
import {
  isActiveSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";

/** Live runs remembered at once; the oldest goes first (a roster holds at most 100). */
const MAX_REMEMBERED_RUNS = 1000;

const earliestStarts = new Map<string, string>();

export interface AgentElapsedClock {
  /** Pending, running or waiting: the timer ticks. */
  readonly live: boolean;
  /** Start of the current run, or `null` when none is known (no timer). */
  readonly startedAt: string | null;
}

/**
 * The elapsed timer for an agent's current run. A live agent (pending too)
 * starts at the earliest start seen for the run: its fold `startedAt`, else its
 * first row. A settled agent never falls back to its first row, which for a
 * workflow member is its completion row and would read 0s.
 */
export function agentElapsedClock(
  agent: Pick<
    RuntimeSubagent,
    "id" | "status" | "activationCount" | "attempt" | "startedAt" | "firstSeenAt"
  >,
): AgentElapsedClock {
  const live = isActiveSubagentStatus(agent.status);
  // A reactivation or a workflow retry is a new run with its own clock.
  const key = `${agent.id}\u001f${agent.activationCount}\u001f${agent.attempt ?? 0}`;
  const remembered = earliestStarts.get(key);
  const startedAt = earliest(
    remembered,
    live ? (agent.startedAt ?? agent.firstSeenAt) : agent.startedAt,
  );
  if (live && startedAt !== null && startedAt !== remembered) {
    earliestStarts.delete(key);
    earliestStarts.set(key, startedAt);
    if (earliestStarts.size > MAX_REMEMBERED_RUNS) {
      const oldest = earliestStarts.keys().next().value;
      if (oldest !== undefined) earliestStarts.delete(oldest);
    }
  }
  return { live, startedAt };
}

function earliest(remembered: string | undefined, candidate: string | null): string | null {
  if (remembered === undefined) return candidate;
  if (candidate === null) return remembered;
  return Date.parse(candidate) < Date.parse(remembered) ? candidate : remembered;
}
