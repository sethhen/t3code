import { assert, describe, it } from "vite-plus/test";

import { agentElapsedClock } from "./agentElapsed";

// The clock remembers runs for the session, so every case uses its own agent id.
const agent = (
  id: string,
  patch: Partial<Parameters<typeof agentElapsedClock>[0]> = {},
): Parameters<typeof agentElapsedClock>[0] => ({
  id,
  status: "pending",
  activationCount: 1,
  attempt: null,
  startedAt: null,
  firstSeenAt: "2026-08-01T10:00:00.000Z",
  ...patch,
});

describe("agentElapsedClock", () => {
  it("a pending workflow member ticks from its first row and keeps that start as its row moves", () => {
    const first = agentElapsedClock(agent("wf-a:wf:0", { attempt: 1 }));
    assert.deepEqual(first, { live: true, startedAt: "2026-08-01T10:00:00.000Z" });
    // Each tool call replaces the member's only row, moving firstSeenAt forward.
    const later = agentElapsedClock(
      agent("wf-a:wf:0", { attempt: 1, firstSeenAt: "2026-08-01T10:07:30.000Z" }),
    );
    assert.deepEqual(later, { live: true, startedAt: "2026-08-01T10:00:00.000Z" });
  });

  it("a settled member freezes from its remembered start", () => {
    agentElapsedClock(agent("wf-b:wf:0", { attempt: 1 }));
    const settled = agentElapsedClock(
      agent("wf-b:wf:0", {
        attempt: 1,
        status: "completed",
        firstSeenAt: "2026-08-01T10:15:00.000Z",
      }),
    );
    assert.deepEqual(settled, { live: false, startedAt: "2026-08-01T10:00:00.000Z" });
  });

  it("a settled member seen only by its completion row shows no time rather than 0s", () => {
    const settled = agentElapsedClock(
      agent("wf-c:wf:0", {
        attempt: 1,
        status: "completed",
        firstSeenAt: "2026-08-01T10:15:00.000Z",
      }),
    );
    assert.deepEqual(settled, { live: false, startedAt: null });
  });

  it("a workflow retry restarts the clock", () => {
    agentElapsedClock(agent("wf-d:wf:0", { attempt: 1 }));
    const retry = agentElapsedClock(
      agent("wf-d:wf:0", { attempt: 2, firstSeenAt: "2026-08-01T10:20:00.000Z" }),
    );
    assert.equal(retry.startedAt, "2026-08-01T10:20:00.000Z");
  });

  it("a known start wins over the first row, and a reactivation restarts the clock", () => {
    // A resumed Codex child: first seen long before this run started.
    const run1 = agentElapsedClock(
      agent("codex-child", { status: "running", startedAt: "2026-08-01T11:00:00.000Z" }),
    );
    assert.deepEqual(run1, { live: true, startedAt: "2026-08-01T11:00:00.000Z" });
    const run2 = agentElapsedClock(
      agent("codex-child", {
        status: "running",
        activationCount: 2,
        startedAt: "2026-08-01T12:00:00.000Z",
      }),
    );
    assert.equal(run2.startedAt, "2026-08-01T12:00:00.000Z");
    const idle = agentElapsedClock(
      agent("codex-child", {
        status: "idle",
        activationCount: 2,
        startedAt: "2026-08-01T12:00:00.000Z",
      }),
    );
    assert.deepEqual(idle, { live: false, startedAt: "2026-08-01T12:00:00.000Z" });
  });
});
