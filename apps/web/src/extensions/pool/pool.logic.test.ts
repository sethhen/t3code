import {
  DEFAULT_SERVER_SETTINGS,
  type PoolAccount,
  type PoolCheck,
  type PoolModelIssue,
  type PoolRoute,
  type PoolStatus,
  type PoolUsageBucket,
} from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  accountLabel,
  accountNotice,
  accountUsageLine,
  accountUsageSummaries,
  isCooldownResetOffered,
  isParityVisible,
  isPoolUnsupported,
  isRoutingVisible,
  joinNames,
  modelIssueHint,
  orderRoutes,
  poolStartFailure,
  withLiveStartFailure,
  normalizeExternalUrl,
  orderAccounts,
  parityHeadline,
  parityProblems,
  parityProblemText,
  poolHeaderStatus,
  providerNote,
  routeWaitingReason,
  statusPollDelay,
  withoutCustomModel,
} from "./pool.logic";

function account(overrides: Partial<PoolAccount> = {}): PoolAccount {
  return { id: "claude-a.json", provider: "claude", status: "ready", windows: [], ...overrides };
}

function status(overrides: Partial<PoolStatus> = {}): PoolStatus {
  return {
    source: "local",
    runtime: { state: "running", version: "6.0.0" },
    external: { url: "", hasKey: false },
    accounts: [],
    routes: [],
    checks: [],
    ...overrides,
  };
}

function route(overrides: Partial<PoolRoute> = {}): PoolRoute {
  return {
    instanceId: "claudeAgent",
    provider: "claude",
    displayName: "Claude",
    mode: "pool",
    active: true,
    ...overrides,
  };
}

describe("poolHeaderStatus", () => {
  it("says nothing while the local pool is idle or running", () => {
    assert.isNull(poolHeaderStatus(status()));
    assert.isNull(poolHeaderStatus(status({ runtime: { state: "idle", version: "6.0.0" } })));
  });

  it("names the states that are on their way", () => {
    const labels = (["downloading", "starting"] as const).map(
      (state) => poolHeaderStatus(status({ runtime: { state, version: "6.0.0" } }))?.label,
    );
    assert.deepEqual(labels, ["Setting up…", "Starting…"]);
  });

  it("says it can't start, with the runtime's own reason for the tooltip", () => {
    assert.deepEqual(
      poolHeaderStatus(
        status({ runtime: { state: "error", version: "6.0.0", message: "Port 18417 is in use" } }),
      ),
      { label: "Can't start", tone: "error", detail: "Port 18417 is in use" },
    );
  });

  it("reports a team server by reachability, not by the local runtime", () => {
    const external = (reachable: boolean | undefined, url = "http://pool:8317") =>
      poolHeaderStatus(
        status({
          source: "external",
          runtime: { state: "error", version: "6.0.0", message: "ignored" },
          external: { url, hasKey: true, ...(reachable === undefined ? {} : { reachable }) },
        }),
      );
    assert.isNull(external(true));
    assert.deepEqual(external(false), { label: "Can't reach the server", tone: "error" });
    assert.equal(external(undefined)?.label, "Connecting…");
    assert.isNull(external(true, ""));
  });
});

describe("accounts", () => {
  it("maps statuses to notices, with fallbacks when the server sends no message", () => {
    assert.equal(accountNotice(account()), null);
    assert.deepEqual(accountNotice(account({ status: "disabled" })), { kind: "paused" });
    assert.deepEqual(
      accountNotice(account({ status: "cooling", message: "Cooling down · resets in 3h" })),
      { kind: "cooling", text: "Cooling down · resets in 3h" },
    );
    assert.deepEqual(accountNotice(account({ status: "cooling", message: "  " })), {
      kind: "cooling",
      text: "Cooling down",
    });
    assert.deepEqual(accountNotice(account({ status: "error" })), {
      kind: "error",
      text: "Needs attention",
    });
  });

  it("calls out a stale cooldown instead of the plain cooling badge, unless paused", () => {
    const stale = { kind: "stale", text: "Has usage again but is still held back" } as const;
    assert.deepEqual(
      accountNotice(account({ status: "cooling", message: "Cooling down", staleCooldown: true })),
      stale,
    );
    assert.deepEqual(accountNotice(account({ status: "error", staleCooldown: true })), stale);
    assert.deepEqual(accountNotice(account({ status: "disabled", staleCooldown: true })), {
      kind: "paused",
    });
    assert.isNull(accountNotice(account({ staleCooldown: true })));
  });

  it("labels an account by email, else by what was signed in", () => {
    assert.equal(accountLabel(account({ email: "a@example.com" })), "a@example.com");
    assert.equal(accountLabel(account({ provider: "codex" })), "ChatGPT account");
  });

  it("orders Claude before Codex and keeps server order within each", () => {
    const ordered = orderAccounts([
      account({ id: "x1", provider: "codex" }),
      account({ id: "c1" }),
      account({ id: "x2", provider: "codex" }),
      account({ id: "c2" }),
    ]);
    assert.deepEqual(
      ordered.map((entry) => entry.id),
      ["c1", "c2", "x1", "x2"],
    );
  });
});

describe("cooldown reset", () => {
  it("is offered while an account that isn't paused is being skipped", () => {
    assert.isFalse(isCooldownResetOffered(status({ accounts: [account()] })));
    assert.isFalse(
      isCooldownResetOffered(status({ accounts: [account(), account({ status: "disabled" })] })),
    );
    for (const held of [
      account({ status: "cooling" }),
      account({ status: "error", message: "Rate limited" }),
      account({ status: "cooling", staleCooldown: true }),
    ]) {
      assert.isTrue(isCooldownResetOffered(status({ accounts: [account(), held] })));
    }
  });

  it("is not offered for a team server, whose cooldowns live there", () => {
    assert.isFalse(
      isCooldownResetOffered(
        status({
          source: "external",
          external: { url: "http://pool:8317", hasKey: true, reachable: true },
          accounts: [account({ status: "cooling" })],
        }),
      ),
    );
  });
});

describe("account usage", () => {
  const day = (key: string, accounts: PoolUsageBucket["accounts"] = []): PoolUsageBucket => ({
    key,
    accounts,
  });
  const week = (buckets: PoolUsageBucket[]) =>
    ({ range: "7d", resolution: "day", buckets }) as const;

  it("takes today from the last bucket and the week from all of them, per account", () => {
    const summaries = accountUsageSummaries(
      week([
        day("2026-09-25", [{ id: "claude-a.json", costUsd: 10, tokens: 2_000_000, requests: 20 }]),
        day("2026-09-26"),
        day("2026-09-30", [
          { id: "claude-a.json", costUsd: 3.5, tokens: 500_000, requests: 4 },
          { id: "codex-b.json", costUsd: 1, tokens: 100_000, requests: 2 },
        ]),
        day("2026-10-01", [{ id: "claude-a.json", costUsd: 4.2, tokens: 1_200_000, requests: 6 }]),
      ]),
    );
    assert.deepEqual(summaries.get("claude-a.json"), {
      todayCostUsd: 4.2,
      todayTokens: 1_200_000,
      weekCostUsd: 17.7,
      weekTokens: 3_700_000,
      weekRequests: 30,
    });
    assert.deepEqual(summaries.get("codex-b.json"), {
      todayCostUsd: 0,
      todayTokens: 0,
      weekCostUsd: 1,
      weekTokens: 100_000,
      weekRequests: 2,
    });
  });

  it("leaves out accounts that only failed, and reports other than 7 days by day", () => {
    const failedOnly = day("2026-10-01", [
      { id: "claude-a.json", costUsd: 0, tokens: 0, requests: 3 },
    ]);
    assert.equal(accountUsageSummaries(week([failedOnly])).size, 0);
    const served = day("2026-10-01", [
      { id: "claude-a.json", costUsd: 1, tokens: 10, requests: 1 },
    ]);
    assert.equal(accountUsageSummaries({ ...week([served]), resolution: "hour" }).size, 0);
    assert.equal(accountUsageSummaries({ ...week([served]), range: "30d" }).size, 0);
    assert.equal(accountUsageSummaries(week([])).size, 0);
  });

  it("writes the row line, leading with the week on a quiet day", () => {
    const summary = {
      todayCostUsd: 4.2,
      todayTokens: 1_200_000,
      weekCostUsd: 38.1,
      weekTokens: 9_100_000,
      weekRequests: 80,
    };
    assert.equal(accountUsageLine(summary), "Today $4.20 · 1.20M tokens · 7 days $38.10");
    assert.equal(
      accountUsageLine({ ...summary, todayCostUsd: 0, todayTokens: 0 }),
      "7 days $38.10 · 9.10M tokens",
    );
  });
});

describe("routeWaitingReason", () => {
  it("only explains pool routes that are not serving", () => {
    assert.equal(routeWaitingReason(route()), null);
    assert.equal(routeWaitingReason(route({ mode: "direct", active: false })), null);
    assert.equal(
      routeWaitingReason(route({ active: false, reason: "Pool is starting" })),
      "Pool is starting",
    );
    assert.equal(
      routeWaitingReason(route({ provider: "codex", active: false })),
      "Waiting for a ChatGPT account",
    );
  });
});

describe("providerNote", () => {
  const claude = route();
  const work = route({
    instanceId: "claudeAgent_work",
    displayName: "Claude (Work)",
    mode: "direct",
    active: false,
  });

  it("invites a first sign-in, and more than one", () => {
    assert.equal(
      providerNote("codex", 0, []),
      "Sign in with one or more ChatGPT accounts. Usage is shared between them automatically.",
    );
  });

  it("nudges towards a second account, then says usage is shared", () => {
    assert.equal(
      providerNote("claude", 1, [claude]),
      "Add another Claude account and usage is shared between them automatically.",
    );
    assert.equal(
      providerNote("claude", 2, [claude]),
      "Usage is shared between accounts automatically.",
    );
  });

  it("names the instances that don't use the accounts", () => {
    assert.equal(
      providerNote("claude", 2, [claude, work]),
      "Usage is shared between accounts automatically. Claude (Work) uses its own sign-in.",
    );
    assert.equal(
      providerNote("claude", 2, [{ ...claude, mode: "direct", active: false }, work]),
      "Claude and Claude (Work) use their own sign-in, not these accounts.",
    );
    // Every account paused: the route waits, so the provider signs in on its own.
    assert.equal(
      providerNote("claude", 1, [{ ...claude, active: false }]),
      "Claude uses its own sign-in, not these accounts.",
    );
  });

  it("only looks at its own provider's instances", () => {
    const codex = route({ instanceId: "codex", provider: "codex", displayName: "Codex" });
    assert.equal(
      providerNote("claude", 2, [claude, { ...codex, mode: "direct", active: false }]),
      "Usage is shared between accounts automatically.",
    );
    assert.equal(
      providerNote("claude", 1, [codex]),
      "Claude is turned off, so these accounts aren't used.",
    );
  });

  it("joins names the way a sentence would", () => {
    assert.equal(joinNames(["A"]), "A");
    assert.equal(joinNames(["A", "B"]), "A and B");
    assert.equal(joinNames(["A", "B", "C"]), "A, B and C");
  });

  it("offers routing once there is something to route to", () => {
    assert.isFalse(isRoutingVisible(status()));
    assert.isTrue(isRoutingVisible(status({ accounts: [account()] })));
    assert.isTrue(
      isRoutingVisible(
        status({ source: "external", external: { url: "http://pool:8317", hasKey: true } }),
      ),
    );
  });
});

describe("native parity", () => {
  const ok: PoolCheck = { id: "tools", label: "Tool search", state: "ok" };
  const unknown: PoolCheck = { id: "codex", label: "Codex", state: "unknown" };
  const warn: PoolCheck = {
    id: "codex",
    label: "Codex",
    state: "warn",
    detail: "Built-in catalog",
  };
  const fail: PoolCheck = { id: "proxy", label: "Pool", state: "fail", detail: "Not running" };

  it("shows problems first (failures, then warnings) and nothing else", () => {
    assert.deepEqual(parityProblems([ok, warn, unknown, fail]), [fail, warn]);
    assert.deepEqual(parityProblems([ok, unknown]), []);
  });

  it("says all passed when something passed and nothing needs attention", () => {
    assert.equal(parityHeadline([ok, unknown]), "passed");
    assert.equal(parityHeadline([unknown]), "unchecked");
  });

  it("writes each problem as a sentence", () => {
    assert.equal(parityProblemText(fail), "Pool: Not running");
    assert.equal(
      parityProblemText({ id: "sticky", label: "Sticky sessions", state: "fail" }),
      "Sticky sessions is off.",
    );
    assert.equal(
      parityProblemText({ id: "x", label: "Codex", state: "warn" }),
      "Codex needs attention.",
    );
  });

  it("appears only once a provider goes through the pool", () => {
    assert.isFalse(isParityVisible(status({ routes: [route({ active: false })] })));
    assert.isTrue(isParityVisible(status({ routes: [route()] })));
  });
});

describe("normalizeExternalUrl", () => {
  it("keeps http(s) URLs and drops a trailing slash", () => {
    assert.equal(
      normalizeExternalUrl(" https://pool.example.com:8317/ "),
      "https://pool.example.com:8317",
    );
    assert.equal(normalizeExternalUrl("http://10.0.0.5:8317"), "http://10.0.0.5:8317");
  });

  it("adds http:// to a bare host", () => {
    assert.equal(
      normalizeExternalUrl("hub.tail1234.ts.net:8317"),
      "http://hub.tail1234.ts.net:8317",
    );
  });

  it("refuses empty input and other schemes", () => {
    assert.equal(normalizeExternalUrl("   "), null);
    assert.equal(normalizeExternalUrl("ftp://pool.example.com"), null);
    assert.equal(normalizeExternalUrl("http://"), null);
  });
});

describe("environment triage", () => {
  it("treats a missing pool or a missing extension RPC as unsupported", () => {
    assert.isTrue(isPoolUnsupported("Unknown extension method pool.status"));
    assert.isTrue(isPoolUnsupported("Unknown request tag: extension.call"));
    assert.isFalse(isPoolUnsupported("Pool config could not be read"));
    assert.isFalse(isPoolUnsupported("Unknown extension method skillsMcp.context.get"));
  });

  it("polls faster only while a sign-in is pending", () => {
    assert.isBelow(statusPollDelay(true), statusPollDelay(false));
  });
});

describe("model families", () => {
  const issue: PoolModelIssue = {
    instanceId: "claudeAgent",
    displayName: "Claude",
    provider: "claude",
    slug: "gpt-6-astra",
    where: "customModels",
    message: "Claude has a GPT model (gpt-6-astra) in its custom models; …",
  };

  it("removes T3's own foreign custom model from the default slot's legacy settings", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        claudeAgent: {
          ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
          customModels: ["gpt-6-astra", { slug: "claude-x" }],
        },
      },
    } as typeof DEFAULT_SERVER_SETTINGS;
    const edit = withoutCustomModel(settings, issue);
    assert.isNotNull(edit);
    assert.isTrue(edit?.isDefault);
    assert.deepEqual((edit!.instance.config as { customModels: unknown }).customModels, [
      { slug: "claude-x" },
    ]);
  });

  it("edits an explicit instance, and offers nothing for aliases or absent models", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        claudeAgent_work: {
          driver: "claudeAgent",
          config: { customModels: [{ slug: "gpt-6-astra" }] },
        },
      },
    } as unknown as typeof DEFAULT_SERVER_SETTINGS;
    const edit = withoutCustomModel(settings, { ...issue, instanceId: "claudeAgent_work" });
    assert.isFalse(edit?.isDefault);
    assert.deepEqual((edit!.instance.config as { customModels: unknown }).customModels, []);
    assert.isNull(
      withoutCustomModel(settings, {
        ...issue,
        where: "claudeSettings",
        setting: "ANTHROPIC_MODEL",
      }),
    );
    assert.isNull(withoutCustomModel(DEFAULT_SERVER_SETTINGS, issue));
  });

  it("says where to edit an alias the pool never writes", () => {
    assert.equal(
      modelIssueHint({ ...issue, where: "claudeSettings", setting: "ANTHROPIC_MODEL" }),
      "Edit ~/.claude/settings.json",
    );
    assert.equal(
      modelIssueHint({ ...issue, where: "instanceEnv" }),
      "Edit Claude's environment under More provider settings",
    );
    assert.isNull(modelIssueHint(issue));
  });
});

describe("friendlier failures and ordering", () => {
  it("lists Claude before Codex, keeping each provider's own order", () => {
    const codex = route({ instanceId: "codex", provider: "codex", displayName: "Codex" });
    const work = route({ instanceId: "claudeAgent_work", displayName: "Claude (Work)" });
    assert.deepEqual(
      orderRoutes([codex, route(), work]).map((entry) => entry.instanceId),
      ["claudeAgent", "claudeAgent_work", "codex"],
    );
  });

  it("turns a spawn error into one calm sentence, keeping the proxy's words and the log", () => {
    // The path in the message is a decoy: Show log uses only the server's logPath.
    const technical =
      "The pool could not start: spawn /state/proxy.log-parent/pool/bin/7.3.17/cli-proxy-api EACCES. Log: /state/proxy.log-parent/pool/proxy.log. Retrying in 30s.";
    const failure = poolStartFailure(
      status({
        runtime: {
          state: "error",
          version: "7.3.17",
          message: technical,
          logPath: "/state/pool/proxy.log",
        },
      }),
    );
    assert.deepEqual(failure, {
      text: "Account sharing couldn't start. Retrying in 30s.",
      technical,
      logPath: "/state/pool/proxy.log",
    });
    assert.deepEqual(
      poolStartFailure(status({ runtime: { state: "error", version: "7.3.17", message: "boom" } })),
      { text: "Account sharing couldn't start.", technical: "boom" },
    );
    assert.isNull(poolStartFailure(status()));
    assert.isNull(
      poolStartFailure(
        status({
          source: "external",
          runtime: { state: "error", version: "7.3.17", message: technical },
        }),
      ),
    );
  });

  it("fails the pool check from live state, even when the last check run passed", () => {
    const failure = { text: "Account sharing couldn't start.", technical: "spawn EACCES" };
    const passed = [
      { id: "proxy", label: "Pool", state: "ok" as const, detail: "Running on 127.0.0.1:18417" },
      { id: "cache", label: "1-hour cache", state: "ok" as const },
    ];
    assert.deepEqual(withLiveStartFailure(passed, failure), [
      { id: "proxy", label: "Account sharing", state: "fail", detail: "spawn EACCES" },
      passed[1]!,
    ]);
    assert.deepEqual(withLiveStartFailure([], failure), [
      { id: "proxy", label: "Account sharing", state: "fail", detail: "spawn EACCES" },
    ]);
    assert.deepEqual(withLiveStartFailure(passed, null), passed);
  });
});
