import {
  DEFAULT_UNIFIED_SETTINGS,
  type MoveAccount,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  accountSignIn,
  accountTone,
  buildAccountRows,
  defaultInstanceEnvelope,
  foldFor,
  foldReasons,
  type FoldState,
  limitsClock,
  removeQuestion,
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
