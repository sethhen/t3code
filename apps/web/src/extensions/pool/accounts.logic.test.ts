import {
  type ClaudeAccountPrivacy,
  DEFAULT_UNIFIED_SETTINGS,
  type MoveAccount,
  type PrivacyStatus,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  accountSignIn,
  accountTone,
  announcesPrivacyTask,
  buildAccountRows,
  claudePrivacyView,
  codexMarkedOffAt,
  defaultInstanceEnvelope,
  type EndedPrivacyTask,
  foldFor,
  foldReasons,
  type FoldState,
  followPrivacyTask,
  limitsClock,
  privacyOutcome,
  removeQuestion,
  resetLine,
  resetQuestion,
  visiblePendingAccounts,
} from "./accounts.logic";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");

function snapshot(instanceId: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: instanceId.startsWith("codex") ? codex : claude,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-01T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function settingsWith(providerInstances: Record<string, ProviderInstanceConfig>) {
  return { providers: DEFAULT_UNIFIED_SETTINGS.providers, providerInstances };
}

function pending(overrides: Partial<MoveAccount>): MoveAccount {
  return {
    id: "claude_a",
    provider: "claude",
    email: "a@example.com",
    ...overrides,
  };
}

describe("defaultInstanceEnvelope", () => {
  it("synthesizes a default slot from its legacy settings, enabled moved to the envelope", () => {
    const envelope = defaultInstanceEnvelope(
      {
        providers: {
          ...DEFAULT_UNIFIED_SETTINGS.providers,
          claudeAgent: { ...DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent, enabled: false },
        },
        providerInstances: {},
      },
      claude,
    );
    assert.strictEqual(envelope?.driver, claude);
    assert.strictEqual(envelope?.enabled, false);
    assert.notProperty(envelope?.config, "enabled");
  });

  it("prefers the explicit default instance, and has none when the server predates the driver", () => {
    const explicit: ProviderInstanceConfig = { driver: codex, displayName: "Work" };
    assert.strictEqual(defaultInstanceEnvelope(settingsWith({ codex: explicit }), codex), explicit);
    const { codex: _dropped, ...olderProviders } = DEFAULT_UNIFIED_SETTINGS.providers;
    const olderServer = {
      providers: olderProviders as typeof DEFAULT_UNIFIED_SETTINGS.providers,
      providerInstances: {},
    };
    assert.isUndefined(defaultInstanceEnvelope(olderServer, codex));
    assert.deepEqual(
      buildAccountRows(olderServer, []).map((row) => row.provider),
      ["claude"],
    );
  });
});

describe("buildAccountRows", () => {
  it("lists Claude then Codex instances, each default first and the rest by email", () => {
    const rows = buildAccountRows(
      settingsWith({
        codex_b: { driver: codex, displayName: "b@example.com" },
        claude_z: { driver: claude, displayName: "z@example.com" },
        cursor: { driver: ProviderDriverKind.make("cursor") },
        claude_m: { driver: claude, displayName: "m@example.com" },
      }),
      [
        snapshot("claudeAgent", { auth: { status: "authenticated", email: "zz@example.com" } }),
        snapshot("claude_m", { auth: { status: "authenticated", email: "a@example.com" } }),
      ],
    );
    assert.deepEqual(
      rows.map((row) => [row.instanceId, row.label, row.isDefault]),
      [
        ["claudeAgent", "zz@example.com", true],
        ["claude_m", "a@example.com", false],
        ["claude_z", "z@example.com", false],
        ["codex", "Codex", true],
        ["codex_b", "b@example.com", false],
      ],
    );
  });

  it("reads enabled from settings, not from a snapshot that lags a pause", () => {
    const [row] = buildAccountRows(
      settingsWith({ claudeAgent: { driver: claude, enabled: false } }),
      [snapshot("claudeAgent", { enabled: true })],
    );
    assert.isFalse(row?.enabled);
    assert.strictEqual(row && accountTone(row), "disabled");
  });
});

describe("accountTone", () => {
  it("is warning before the first probe and follows the snapshot after it", () => {
    assert.strictEqual(accountTone({ enabled: true, snapshot: undefined }), "warning");
    assert.strictEqual(accountTone({ enabled: true, snapshot: snapshot("codex") }), "ready");
    assert.strictEqual(
      accountTone({ enabled: true, snapshot: snapshot("codex", { status: "error" }) }),
      "error",
    );
  });
});

describe("limitsClock", () => {
  it("draws quota at the newest usage read, or when the page opened if that is later", () => {
    const limits = (checkedAt: string) => ({ usageLimits: { checkedAt, windows: [] } });
    const rows = buildAccountRows(settingsWith({ claude_b: { driver: claude } }), [
      snapshot("claudeAgent", limits("2026-10-01T12:00:00.000Z")),
      snapshot("claude_b", limits("2026-10-01T12:05:00.000Z")),
      snapshot("codex"),
    ]);
    const opened = Date.parse("2026-10-01T12:01:00.000Z");
    assert.strictEqual(limitsClock(rows, opened), Date.parse("2026-10-01T12:05:00.000Z"));
    assert.strictEqual(limitsClock(rows, opened + 3_600_000), opened + 3_600_000);
  });
});

describe("visiblePendingAccounts", () => {
  it("hides accounts that are an instance already or that a row already is, and orders the rest", () => {
    const settings = settingsWith({
      claude_done: { driver: claude },
      claude_other: { driver: claude, displayName: "Named@Example.com" },
      claude_signed: { driver: claude },
    });
    const rows = buildAccountRows(settings, [
      snapshot("claudeAgent", { auth: { status: "authenticated", email: "Main@Example.com" } }),
      snapshot("claude_signed", { auth: { status: "authenticated", email: "signed@example.com" } }),
    ]);
    const visible = visiblePendingAccounts(
      [
        pending({ id: "codex_x", provider: "codex", email: "main@example.com" }),
        pending({ id: "claude_done", email: "done@example.com" }),
        pending({ id: "claude_main", email: "main@example.com" }),
        pending({ id: "claude_named", email: "named@example.com" }),
        pending({ id: "claude_signed2", email: " SIGNED@example.com" }),
        pending({ id: "claude_b", email: "b@example.com" }),
      ],
      settings,
      rows,
    );
    // The Codex account shares the email but not the provider, so it stays.
    assert.deepEqual(
      visible.map((account) => account.id),
      ["claude_b", "codex_x"],
    );
  });
});

describe("accountSignIn", () => {
  const row = (provider: "claude" | "codex", instance: Omit<ProviderInstanceConfig, "driver">) => ({
    provider,
    isDefault: false,
    instance: { driver: provider === "claude" ? claude : codex, ...instance },
  });

  it("finds a sign-in of its own in a config dir, an environment or a home", () => {
    assert.strictEqual(
      accountSignIn(row("claude", { config: { homePath: "~/.claude-a" } })),
      "own",
    );
    assert.strictEqual(
      accountSignIn(
        row("claude", {
          environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/c", sensitive: false }],
        }),
      ),
      "own",
    );
    assert.strictEqual(
      accountSignIn(
        row("claude", {
          environment: [
            { name: "CLAUDE_CONFIG_DIR", value: "", sensitive: true, valueRedacted: true },
          ],
        }),
      ),
      "own",
    );
    assert.strictEqual(
      accountSignIn(row("codex", { config: { shadowHomePath: "~/.codex-a" } })),
      "own",
    );
    assert.strictEqual(accountSignIn(row("codex", { config: { homePath: "~/.codex-b" } })), "own");
    assert.strictEqual(
      accountSignIn(row("codex", { config: { setupMode: "managed", homePath: "~/.codex-c" } })),
      "managed",
    );
  });

  it("has none for a default instance or one sharing the default's sign-in", () => {
    assert.isNull(
      accountSignIn({ ...row("claude", { config: { homePath: "~/.claude" } }), isDefault: true }),
    );
    assert.isNull(
      accountSignIn({ ...row("codex", { config: { setupMode: "managed" } }), isDefault: true }),
    );
    assert.isNull(accountSignIn(row("claude", { config: { homePath: "  " } })));
    assert.isNull(
      accountSignIn(
        row("claude", {
          environment: [{ name: "CLAUDE_CONFIG_DIR", value: " ", sensitive: false }],
        }),
      ),
    );
    assert.isNull(accountSignIn(row("claude", { config: { shadowHomePath: "~/.claude-a" } })));
    assert.isNull(accountSignIn(row("codex", {})));
  });
});

describe("removeQuestion", () => {
  it("says a managed account is only dropped, not signed out", () => {
    assert.strictEqual(
      removeQuestion({ label: "a@example.com" }, "own"),
      "Remove a@example.com? T3 signs it out and stops using it. Its threads stay in your history.",
    );
    assert.strictEqual(
      removeQuestion({ label: "a@example.com" }, "managed"),
      "Remove a@example.com? T3 stops using it. Its threads stay in your history.",
    );
  });
});

describe("resetQuestion", () => {
  it("adds the session quota left when the row knows its session window", () => {
    const [row] = buildAccountRows(settingsWith({}), [
      snapshot("claudeAgent", {
        auth: { status: "authenticated", email: "a@example.com" },
        usageLimits: {
          checkedAt: "2026-10-01T12:00:00.000Z",
          windows: [
            { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 10 },
            { id: "five_hour", kind: "session", label: "Session", usedPercent: 62.4 },
          ],
        },
      }),
    ]);
    assert.isDefined(row);
    if (!row) return;
    const question = resetQuestion(row);
    assert.match(question, /^Use a@example\.com's session limit reset now\? /);
    assert.isTrue(
      question.endsWith("Usage still counts toward the weekly limit. Session: 38% left."),
    );
    assert.isTrue(
      resetQuestion({ ...row, snapshot: undefined }).endsWith(
        "Usage still counts toward the weekly limit.",
      ),
    );
  });
});

describe("foldReasons", () => {
  const upstreamSearchIds = new Set(["providers", "usage-providers"]);

  it("names a target instance, a search into the upstream sections and each driver to update", () => {
    assert.deepEqual(
      foldReasons({
        targetInstanceId: "codex_work",
        searchTargetId: "providers",
        upstreamSearchIds,
        updateDrivers: ["opencode", "codex", "codex"],
      }),
      ["instance:codex_work", "search:providers", "update:codex", "update:opencode"],
    );
  });

  it("ignores searches elsewhere on the page and an empty update list", () => {
    assert.deepEqual(
      foldReasons({
        targetInstanceId: undefined,
        searchTargetId: "theme",
        upstreamSearchIds,
        updateDrivers: [],
      }),
      [],
    );
  });
});

describe("foldFor", () => {
  const closed: FoldState = { open: false, reasons: [] };

  it("stays closed without a reason and returns the same state", () => {
    assert.strictEqual(foldFor(closed, []), closed);
  });

  it("opens once per reason: closing it afterwards sticks", () => {
    const opened = foldFor(closed, ["instance:codex_work"]);
    assert.isTrue(opened.open);
    const userClosed = { ...opened, open: false };
    assert.strictEqual(foldFor(userClosed, ["instance:codex_work"]), userClosed);
  });

  it("opens again for a search after the user closed it", () => {
    const userClosed: FoldState = { open: false, reasons: ["instance:codex_work"] };
    assert.isTrue(foldFor(userClosed, ["instance:codex_work", "search:providers"]).open);
  });

  it("forgets a reason that went away, so the same search later opens it again", () => {
    const searched: FoldState = { open: false, reasons: ["search:providers"] };
    const handled = foldFor(searched, []);
    assert.isFalse(handled.open);
    assert.deepEqual(handled.reasons, []);
    assert.isTrue(foldFor(handled, ["search:providers"]).open);
  });

  it("opens for a new driver to update, not for another instance of the same driver", () => {
    const reasons = (updateDrivers: string[]) =>
      foldReasons({
        targetInstanceId: undefined,
        searchTargetId: null,
        upstreamSearchIds: new Set(),
        updateDrivers,
      });
    const updated = foldFor(closed, reasons(["codex"]));
    const userClosed = { ...updated, open: false };
    // A second Codex account (added, or resumed) with the same update keeps it closed.
    assert.strictEqual(foldFor(userClosed, reasons(["codex", "codex"])), userClosed);
    assert.isTrue(foldFor(userClosed, reasons(["claudeAgent", "codex"])).open);
  });
});

function privacyWith(overrides: Partial<PrivacyStatus> = {}): PrivacyStatus {
  return { keepTrainingOff: true, claude: [], codexMarkedOff: {}, ...overrides };
}

const yesterday = "2026-10-02T09:00:00.000Z";
const today = "2026-10-03T09:00:00.000Z";

describe("claudePrivacyView", () => {
  const entry = (overrides: Partial<ClaudeAccountPrivacy>): ClaudeAccountPrivacy => ({
    instanceId: "claude_a",
    training: "unknown",
    ...overrides,
  });

  it("reads the setting as Claude Code last showed it, and says when it never could", () => {
    const view = (claude: ClaudeAccountPrivacy[]) =>
      claudePrivacyView(privacyWith({ claude }), "claude_a", null).training;
    assert.strictEqual(view([]), "Not checked yet");
    assert.strictEqual(view([entry({ training: "off", checkedAt: today })]), "Off");
    assert.strictEqual(view([entry({ training: "on", checkedAt: today })]), "On");
    assert.strictEqual(
      view([entry({ message: "Claude doesn't offer this setting for this account" })]),
      "Unknown",
    );
  });

  it("offers Turn off only while training is on and nothing runs on the account", () => {
    const on = [entry({ training: "on", checkedAt: today })];
    assert.isTrue(claudePrivacyView(privacyWith({ claude: on }), "claude_a", null).showTurnOff);
    const turningOff = claudePrivacyView(
      privacyWith({ claude: on, busy: { instanceId: "claude_a", task: "turnOff" } }),
      "claude_a",
      null,
    );
    assert.isFalse(turningOff.showTurnOff);
    assert.strictEqual(turningOff.training, "Turning off…");
    assert.strictEqual(turningOff.running, "turnOff");
    const off = [entry({ training: "off", checkedAt: today })];
    assert.isFalse(claudePrivacyView(privacyWith({ claude: off }), "claude_a", null).showTurnOff);
  });

  it("holds every account's actions while any task runs or one is starting here", () => {
    const busy = privacyWith({ busy: { instanceId: "claude_b", task: "check" } });
    const other = claudePrivacyView(busy, "claude_a", null);
    assert.isTrue(other.blocked);
    assert.isNull(other.running);
    assert.strictEqual(other.training, "Not checked yet");
    assert.strictEqual(claudePrivacyView(busy, "claude_b", null).training, "Checking…");
    assert.isTrue(claudePrivacyView(privacyWith(), "claude_a", "claude_b").blocked);
    assert.isFalse(claudePrivacyView(privacyWith(), "claude_a", null).blocked);
  });
});

describe("codexMarkedOffAt", () => {
  it("finds the user's word by the signed-in email, whatever its case", () => {
    const privacy = privacyWith({ codexMarkedOff: { "work@example.com": today } });
    assert.strictEqual(codexMarkedOffAt(privacy, " Work@Example.com "), today);
    assert.isUndefined(codexMarkedOffAt(privacy, "home@example.com"));
    assert.isUndefined(codexMarkedOffAt(privacy, undefined));
    assert.isUndefined(codexMarkedOffAt(privacy, "  "));
  });
});

describe("followPrivacyTask", () => {
  const before: ClaudeAccountPrivacy = {
    instanceId: "claude_a",
    training: "on",
    checkedAt: yesterday,
  };
  const after: ClaudeAccountPrivacy = { ...before, training: "off", checkedAt: today };

  it("keeps the entry from when the task was first seen until a read shows it gone", () => {
    const busy = { instanceId: "claude_a", task: "turnOff" } as const;
    const first = followPrivacyTask(null, privacyWith({ claude: [before], busy }));
    assert.isNull(first.ended);
    assert.deepEqual(first.seen, { busy, before });
    const still = followPrivacyTask(
      first.seen,
      privacyWith({ claude: [before], busy: { ...busy } }),
    );
    assert.strictEqual(still.seen, first.seen);
    assert.isNull(still.ended);
    const done = followPrivacyTask(still.seen, privacyWith({ claude: [after] }));
    assert.isNull(done.seen);
    assert.deepEqual(done.ended, { busy, before, after });
  });

  it("ends a task another one replaced between two reads", () => {
    const seen = { busy: { instanceId: "claude_a", task: "check" } as const, before };
    const next = followPrivacyTask(
      seen,
      privacyWith({ claude: [after], busy: { instanceId: "claude_b", task: "check" } }),
    );
    assert.strictEqual(next.ended?.busy.instanceId, "claude_a");
    assert.strictEqual(next.ended?.after, after);
    assert.strictEqual(next.seen?.busy.instanceId, "claude_b");
    assert.isUndefined(next.seen?.before);
  });

  it("has nothing to say when no task ran", () => {
    assert.deepEqual(followPrivacyTask(null, privacyWith()), { seen: null, ended: null });
  });

  it("keeps a check the server turned into a turnOff as one task, from the entry before the check", () => {
    const check = followPrivacyTask(
      null,
      privacyWith({ claude: [before], busy: { instanceId: "claude_a", task: "check" } }),
    );
    const readOn = { ...before, checkedAt: today };
    const turning = followPrivacyTask(
      check.seen,
      privacyWith({ claude: [readOn], busy: { instanceId: "claude_a", task: "turnOff" } }),
    );
    assert.isNull(turning.ended);
    assert.deepEqual(turning.seen, {
      busy: { instanceId: "claude_a", task: "turnOff" },
      before,
    });
    const done = followPrivacyTask(turning.seen, privacyWith({ claude: [after] }));
    assert.strictEqual(done.ended?.busy.task, "turnOff");
    assert.strictEqual(done.ended?.before, before);
    // A turnOff on another account still ends the check.
    const other = followPrivacyTask(
      check.seen,
      privacyWith({ claude: [readOn], busy: { instanceId: "claude_b", task: "turnOff" } }),
    );
    assert.strictEqual(other.ended?.busy.task, "check");
  });
});

describe("privacyOutcome", () => {
  const ended = (
    task: "check" | "turnOff" | "reset",
    before: Partial<ClaudeAccountPrivacy> | undefined,
    after: Partial<ClaudeAccountPrivacy> | undefined,
  ): EndedPrivacyTask => ({
    busy: { instanceId: "claude_a", task },
    before: before && { instanceId: "claude_a", training: "unknown", ...before },
    after: after && { instanceId: "claude_a", training: "unknown", ...after },
  });

  it("reports the setting a check or change read again", () => {
    assert.deepEqual(
      privacyOutcome(
        ended(
          "turnOff",
          { training: "on", checkedAt: yesterday },
          { training: "off", checkedAt: today },
        ),
        "a@example.com",
      ),
      { type: "success", title: "Model training is now off for a@example.com" },
    );
    assert.deepEqual(
      privacyOutcome(
        ended("check", undefined, { training: "on", checkedAt: today }),
        "a@example.com",
      ),
      { type: "warning", title: "Model training is on for a@example.com" },
    );
    assert.strictEqual(
      privacyOutcome(
        ended(
          "turnOff",
          { training: "on", checkedAt: yesterday },
          { training: "on", checkedAt: today },
        ),
        "a@example.com",
      ).title,
      "Model training is still on for a@example.com",
    );
  });

  it("never reports yesterday's reading for a check that didn't read the setting", () => {
    const stale = { training: "off", checkedAt: yesterday } as const;
    assert.deepEqual(
      privacyOutcome(
        ended("check", stale, {
          ...stale,
          message: "Claude asks you to review its updated terms for this account first",
        }),
        "a@example.com",
      ),
      {
        type: "error",
        title: "Could not check model training for a@example.com",
        description: "Claude asks you to review its updated terms for this account first",
      },
    );
    assert.strictEqual(
      privacyOutcome(ended("check", stale, stale), "a@example.com").description,
      "Claude Code didn't show the setting.",
    );
  });

  it("reports a reset only from a new result, by what Claude Code said", () => {
    const old = { at: yesterday, outcome: "used", message: "Session limit reset." } as const;
    const fresh = (outcome: "used" | "notUsed" | "unknown", message: string) =>
      privacyOutcome(
        ended("reset", { reset: old }, { reset: { at: today, outcome, message } }),
        "a@example.com",
      );
    assert.deepEqual(fresh("used", "Session limit reset."), {
      type: "success",
      title: "a@example.com's session limit was reset",
    });
    assert.deepEqual(fresh("notUsed", "A session-limit reset isn't available right now."), {
      type: "info",
      title: "a@example.com's session limit reset wasn't used",
      description: "A session-limit reset isn't available right now.",
    });
    assert.deepEqual(fresh("unknown", "Claude Code stopped answering."), {
      type: "warning",
      title: "T3 couldn't tell whether a@example.com's reset was used",
      description: "Claude Code stopped answering.",
    });
    assert.deepEqual(
      privacyOutcome(
        ended("reset", { reset: old }, { reset: old, message: "Claude Code isn't signed in." }),
        "a@example.com",
      ),
      {
        type: "error",
        title: "Could not use a@example.com's session limit reset",
        description: "Claude Code isn't signed in.",
      },
    );
    assert.strictEqual(
      resetLine({ at: today, outcome: "unknown", message: "Claude Code stopped answering." }),
      "T3 couldn't tell whether it was used. Claude Code stopped answering.",
    );
  });

  it("says an account removed while Claude Code ran was removed, and that its reset may be gone", () => {
    assert.deepEqual(
      privacyOutcome(
        ended("check", { training: "on", checkedAt: yesterday }, undefined),
        "a@x.com",
      ),
      { type: "info", title: "a@x.com was removed before Claude Code finished" },
    );
    assert.deepEqual(privacyOutcome(ended("reset", {}, undefined), "a@x.com"), {
      type: "warning",
      title: "a@x.com was removed before Claude Code finished",
      description: "Its reset may have been used.",
    });
  });
});

describe("announcesPrivacyTask", () => {
  const task = (
    busyTask: "check" | "turnOff" | "reset",
    before: Partial<ClaudeAccountPrivacy>,
    after: Partial<ClaudeAccountPrivacy> | undefined,
  ): EndedPrivacyTask => ({
    busy: { instanceId: "claude_a", task: busyTask },
    before: { instanceId: "claude_a", training: "unknown", ...before },
    after: after && { instanceId: "claude_a", training: "unknown", ...after },
  });
  const announces = (ended: EndedPrivacyTask, startedHere = false) =>
    announcesPrivacyTask(ended, privacyOutcome(ended, "a@example.com"), startedHere);

  it("stays quiet when the daily sweep finds training still off", () => {
    const staleOff = { training: "off", checkedAt: yesterday } as const;
    assert.isFalse(announces(task("check", staleOff, { training: "off", checkedAt: today })));
    // The same check asked for on this page says so.
    assert.isTrue(announces(task("check", staleOff, { training: "off", checkedAt: today }), true));
  });

  it("speaks when the sweep turned training off, even from a stale off reading", () => {
    // Merged check → turnOff: the entry before the check said off, Claude Code then showed on.
    assert.isTrue(
      announces(
        task(
          "turnOff",
          { training: "off", checkedAt: yesterday },
          { training: "off", checkedAt: today },
        ),
      ),
    );
    assert.isTrue(
      announces(task("check", { training: "unknown" }, { training: "on", checkedAt: today })),
    );
  });

  it("speaks when a task it didn't start failed, but not for a removed account", () => {
    assert.isTrue(
      announces(
        task(
          "check",
          { training: "off", checkedAt: yesterday },
          {
            training: "off",
            checkedAt: yesterday,
            message: "Claude Code isn't signed in.",
          },
        ),
      ),
    );
    assert.isFalse(announces(task("check", { training: "off", checkedAt: yesterday }, undefined)));
    assert.isTrue(announces(task("reset", {}, undefined), true));
  });
});
