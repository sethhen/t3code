import type { PoolAccount, PoolCheck, PoolRoute, PoolStatus } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  accountLabel,
  accountNotice,
  isPoolUnsupported,
  localSourceLabel,
  normalizeExternalUrl,
  orderAccounts,
  parityFailures,
  poolHeaderStatus,
  routeWaitingReason,
  statusPollDelay,
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
  it("names each local runtime state", () => {
    const labels = (["idle", "downloading", "starting", "error"] as const).map(
      (state) => poolHeaderStatus(status({ runtime: { state, version: "6.0.0" } })).label,
    );
    assert.deepEqual(labels, ["Not started", "Downloading…", "Starting…", "Pool stopped"]);
  });

  it("counts accounts while running, with the singular for one", () => {
    assert.deepEqual(poolHeaderStatus(status({ accounts: [account()] })), {
      label: "Running · 1 account",
      tone: "ready",
    });
    assert.equal(
      poolHeaderStatus(status({ accounts: [account(), account({ id: "b" })] })).label,
      "Running · 2 accounts",
    );
  });

  it("shows the runtime's own error message in the error tone", () => {
    assert.deepEqual(
      poolHeaderStatus(
        status({ runtime: { state: "error", version: "6.0.0", message: "Port 8317 is in use" } }),
      ),
      { label: "Port 8317 is in use", tone: "error" },
    );
  });

  it("reports an external pool by reachability, not by the local runtime", () => {
    const external = (reachable: boolean | undefined, url = "http://pool:8317") =>
      poolHeaderStatus(
        status({
          source: "external",
          runtime: { state: "error", version: "6.0.0", message: "ignored" },
          external: { url, hasKey: true, ...(reachable === undefined ? {} : { reachable }) },
        }),
      );
    assert.deepEqual(external(true), { label: "Connected", tone: "ready" });
    assert.deepEqual(external(false), { label: "Unreachable", tone: "error" });
    assert.equal(external(undefined).label, "Connecting…");
    assert.equal(external(true, "").label, "Not connected");
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

describe("parityFailures", () => {
  it("lists only failing checks, with their detail when there is one", () => {
    const checks: PoolCheck[] = [
      { id: "tools", label: "Tool search", state: "ok" },
      { id: "cache", label: "1h cache", state: "fail", detail: "Prompts are cached for 5 minutes" },
      { id: "advisor", label: "Advisor", state: "warn", detail: "Not measured yet" },
      { id: "sticky", label: "Sticky sessions", state: "fail" },
    ];
    assert.deepEqual(parityFailures(checks), [
      "1h cache: Prompts are cached for 5 minutes",
      "Sticky sessions is off in pooled sessions.",
    ]);
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

  it("names the local option after the machine's OS", () => {
    assert.equal(localSourceLabel("darwin"), "This Mac");
    assert.equal(localSourceLabel("windows"), "This PC");
    assert.equal(localSourceLabel("linux"), "This machine");
    assert.equal(localSourceLabel(undefined), "This machine");
  });

  it("polls faster only while a sign-in is pending", () => {
    assert.isBelow(statusPollDelay(true), statusPollDelay(false));
  });
});
