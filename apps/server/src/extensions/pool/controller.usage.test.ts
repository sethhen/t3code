// @effect-diagnostics nodeBuiltinImport:off - drives a fake proxy process and temp state directories.
// @effect-diagnostics globalDate:off - usage records carry wall-clock timestamps.
/**
 * Usage recording and Reset against a fake proxy: a forwarding process the
 * sidecar spawns, in front of an in-test management API, so each test controls
 * the auth file listing and the usage queue, and sees every request.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";

import { PoolController, type PoolDeps, attributeSample } from "./controller.ts";
import type { AuthFileEntry } from "./management.ts";
import { decodePoolState, poolPaths, savePoolState, type PoolPaths } from "./state.ts";
import { deriveProviderInstanceConfigMap } from "./t3.ts";
import type { UsageSample } from "./usageTypes.ts";

const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pool-usage-"));

/** The management API behind the fake proxy: what it lists, what it queues, what it was asked. */
interface FakeApi {
  readonly port: number;
  files: Array<Record<string, unknown>>;
  queue: unknown[];
  readonly resets: string[];
  readonly failResets: Set<string>;
  readonly requests: string[];
  readonly close: () => Promise<void>;
}

const startFakeApi = async (): Promise<FakeApi> => {
  const api = {
    files: [] as Array<Record<string, unknown>>,
    queue: [] as unknown[],
    resets: [] as string[],
    failResets: new Set<string>(),
    requests: [] as string[],
  };
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://fake");
      api.requests.push(`${request.method} ${url.pathname}`);
      const send = (status: number, json: unknown) => {
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(json));
      };
      switch (url.pathname) {
        case "/v0/management/auth-files":
          return send(200, { files: api.files });
        case "/v0/management/usage-queue": {
          const count = Number(url.searchParams.get("count"));
          return send(200, api.queue.splice(0, count));
        }
        case "/v0/management/reset-quota": {
          const authIndex = (JSON.parse(body) as { auth_index: string }).auth_index;
          api.resets.push(authIndex);
          return api.failResets.has(authIndex)
            ? send(500, { error: "boom" })
            : send(200, { status: "ok" });
        }
        case "/v0/management/api-call":
          return send(200, { status_code: 503, body: "" });
        default:
          return send(200, {});
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;
  return Object.assign(api, {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
};

/** A stand-in proxy binary: listens on the config's port and forwards everything to `api`. */
const writeForwardingProxy = (paths: PoolPaths, api: FakeApi) => {
  const dir = NodePath.join(paths.binDir, "test");
  NodeFS.mkdirSync(dir, { recursive: true });
  const forward = NodePath.join(dir, "forward.cjs");
  NodeFS.writeFileSync(
    forward,
    [
      "const http = require('http');",
      "const [port, target] = process.argv.slice(2).map(Number);",
      "http.createServer((req, res) => {",
      "  const up = http.request({ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers }, (answer) => {",
      "    res.writeHead(answer.statusCode, answer.headers);",
      "    answer.pipe(res);",
      "  });",
      "  up.on('error', () => { res.statusCode = 502; res.end(); });",
      "  req.pipe(up);",
      "}).listen(port, '127.0.0.1');",
      "",
    ].join("\n"),
  );
  const script = NodePath.join(dir, "cli-proxy-api");
  NodeFS.writeFileSync(
    script,
    [
      "#!/bin/sh",
      `PORT=$(sed -n 's/^port: //p' "$2")`,
      `exec "${process.execPath}" "${forward}" "$PORT" ${api.port}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return script;
};

/** Writes the auth files on disk (so the pool starts) and has the fake proxy list them. */
const signIn = (
  paths: PoolPaths,
  api: FakeApi,
  accounts: ReadonlyArray<{
    readonly name: string;
    readonly provider: "claude" | "codex";
    readonly email: string;
    readonly authIndex: string;
    readonly disabled?: boolean;
    readonly listing?: Record<string, unknown>;
  }>,
) => {
  NodeFS.mkdirSync(paths.authDir, { recursive: true });
  for (const account of accounts) {
    NodeFS.writeFileSync(
      NodePath.join(paths.authDir, account.name),
      JSON.stringify({
        type: account.provider,
        email: account.email,
        disabled: account.disabled === true,
      }),
    );
  }
  api.files = accounts.map((account) => ({
    name: account.name,
    provider: account.provider,
    email: account.email,
    auth_index: account.authIndex,
    disabled: account.disabled === true,
    unavailable: false,
    status: account.disabled ? "disabled" : "active",
    status_message: "",
    cooldowns: [],
    ...account.listing,
  }));
};

const deps = (paths: PoolPaths, binary: string, over: Partial<PoolDeps> = {}): PoolDeps => ({
  paths,
  platform: "linux",
  arch: "x64",
  instanceMap: async () => deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS),
  reconcile: async () => undefined,
  usageSource: async () => undefined,
  setUsageSource: async () => undefined,
  usageSnapshot: async () => undefined,
  refreshUsage: async () => undefined,
  claudeProbe: async () => {
    throw new Error("no probe in unit tests");
  },
  claudeConfigDir: async () => undefined,
  codexVersion: async () => undefined,
  installBinary: async () => binary,
  ratesCachePath: NodePath.join(paths.root, "usage-model-rates.json"),
  usagePriceOverrides: async () => ({}),
  log: () => undefined,
  ...over,
});

/** Starts the pool and waits until its proxy answers (`setSource` awaits the start). */
const startPool = async (pool: PoolController) => {
  await pool.init();
  await pool.setSource({ source: "local" });
};

/** One usage-queue record, shaped like CLIProxyAPI 7.3.17's. */
const record = (
  over: { auth_index?: string; source?: string; provider?: string; model?: string } = {},
) => ({
  timestamp: new Date().toISOString(),
  provider: "claude",
  model: "claude-opus-5-5",
  failed: false,
  tokens: { input_tokens: 10, output_tokens: 5 },
  latency_ms: 800,
  ...over,
});

const ACCOUNTS = [
  {
    name: "claude-ada@example.com.json",
    provider: "claude",
    email: "ada@example.com",
    authIndex: "idx-ada",
  },
  {
    name: "codex-bob@example.com-pro.json",
    provider: "codex",
    email: "bob@example.com",
    authIndex: "idx-bob",
  },
  {
    name: "claude-cy@example.com.json",
    provider: "claude",
    email: "cy@example.com",
    authIndex: "idx-cy",
    disabled: true,
  },
] as const;

const requestsOf = (usage: Awaited<ReturnType<PoolController["usage"]>>) =>
  Object.fromEntries(usage.accounts.map((account) => [account.id, account.totals.requests]));

describe("attribution", () => {
  const entry = (name: string, provider: string, email: string, authIndex?: string) =>
    ({
      name,
      provider,
      email,
      ...(authIndex ? { authIndex } : {}),
      disabled: false,
      unavailable: false,
      status: "active",
      statusMessage: "",
    }) satisfies AuthFileEntry;
  const accounts = [
    entry("claude-ada.json", "claude", "ada@example.com", "1"),
    entry("codex-ada.json", "codex", "ada@example.com", "2"),
    entry("codex-bob-team.json", "codex", "bob@example.com", "3"),
    entry("codex-bob-pro.json", "codex", "bob@example.com", "4"),
  ];
  const sample = (over: Partial<UsageSample>): UsageSample => ({
    at: 0,
    provider: "codex",
    model: "gpt-6",
    failed: false,
    tokens: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    ...over,
  });
  const accountOf = (over: Partial<UsageSample>) => attributeSample(sample(over), accounts).account;

  it("prefers the proxy's handle over the address", () => {
    assert.strictEqual(
      accountOf({ authIndex: "4", email: "ada@example.com" }),
      "codex-bob-pro.json",
    );
  });

  it("falls back to the one account of that provider with the address", () => {
    assert.strictEqual(accountOf({ authIndex: "9", email: "ADA@example.com" }), "codex-ada.json");
    assert.strictEqual(
      accountOf({ provider: "claude", email: "ada@example.com" }),
      "claude-ada.json",
    );
  });

  it("keeps an ambiguous or unknown address as the address, and no account as none", () => {
    assert.strictEqual(accountOf({ email: "bob@example.com" }), "email:bob@example.com");
    assert.strictEqual(accountOf({ email: "eve@example.com" }), "email:eve@example.com");
    assert.strictEqual(accountOf({}), "");
  });
});

describe("pool usage and reset", () => {
  it("checks quota after startup even when the saved source is unchanged", async () => {
    const api = await startFakeApi();
    const paths = poolPaths(tempDir());
    signIn(paths, api, [ACCOUNTS[0]]);
    const refreshed = Promise.withResolvers<void>();
    let sourceWrites = 0;
    const pool = new PoolController(
      deps(paths, writeForwardingProxy(paths, api), {
        usageSource: async () => {
          const state = JSON.parse(NodeFS.readFileSync(paths.statePath, "utf8")) as {
            port: number;
            managementKey: string;
          };
          return {
            kind: "cliproxy",
            label: "Shared accounts",
            url: `http://127.0.0.1:${state.port}`,
            managementKey: state.managementKey,
            enabled: true,
          };
        },
        setUsageSource: async () => {
          sourceWrites++;
        },
        refreshUsage: async () => {
          assert.include(api.requests, "GET /v0/management/auth-files");
          refreshed.resolve();
        },
      }),
    );
    try {
      await startPool(pool);
      await refreshed.promise;
      assert.strictEqual(sourceWrites, 0, "an unchanged source still needs a post-start read");
      assert.deepStrictEqual(api.resets, []);
    } finally {
      await pool.shutdown();
      await api.close();
    }
  });

  it("awaits and shares manual quota refreshes without usage, resets, or restarts", async () => {
    const api = await startFakeApi();
    const paths = poolPaths(tempDir());
    signIn(paths, api, [ACCOUNTS[0]]);
    const started = Promise.withResolvers<void>();
    const probing = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const checkedAt = "2026-10-01T03:00:00.000Z";
    let reads = 0;
    let manual = false;
    let snapshot: Awaited<ReturnType<PoolDeps["usageSnapshot"]>>;
    const pool = new PoolController(
      deps(paths, writeForwardingProxy(paths, api), {
        usageSnapshot: async () => snapshot,
        refreshUsage: async () => {
          reads++;
          if (!manual) {
            started.resolve();
            return;
          }
          probing.resolve();
          await finish.promise;
          snapshot = {
            checkedAt,
            accounts: [
              {
                id: ACCOUNTS[0].name,
                driver: ProviderDriverKind.make("claudeAgent"),
                usageLimits: {
                  checkedAt,
                  windows: [
                    { id: "five_hour", kind: "session", label: "Session", usedPercent: 25 },
                  ],
                },
              },
            ],
          };
        },
      }),
    );
    try {
      await startPool(pool);
      await started.promise;
      await pool.refreshQuota();
      const before = reads;
      const pid = NodeFS.readFileSync(paths.pidPath, "utf8");
      manual = true;
      let completed = false;
      const first = pool.refreshQuota().then((status) => {
        completed = true;
        return status;
      });
      await probing.promise;
      const second = pool.refreshQuota();
      assert.isFalse(completed);
      finish.resolve();
      const [one, two] = await Promise.all([first, second]);
      assert.strictEqual(reads, before + 1);
      assert.deepStrictEqual(one, two);
      assert.strictEqual(one.accounts[0]?.windows[0]?.usedPercent, 25);
      assert.strictEqual(one.accounts[0]?.quotaCheckedAt, checkedAt);
      assert.isUndefined(one.accounts[0]?.quotaError);
      assert.strictEqual(NodeFS.readFileSync(paths.pidPath, "utf8"), pid);
      assert.deepStrictEqual(api.resets, []);
      assert.isFalse(api.requests.some((request) => request.includes("/v1/messages")));
      assert.strictEqual((await pool.usage({ range: "24h", timeZone: "UTC" })).totals.requests, 0);
    } finally {
      finish.resolve();
      await pool.shutdown();
      await api.close();
    }
  });

  it("preserves source and account quota failures instead of presenting them as empty quotas", async () => {
    const api = await startFakeApi();
    const paths = poolPaths(tempDir());
    signIn(paths, api, [ACCOUNTS[0]]);
    const checkedAt = "2026-10-01T03:00:00.000Z";
    let snapshot: Awaited<ReturnType<PoolDeps["usageSnapshot"]>> = {
      checkedAt,
      accounts: [],
      error: "The hub could not list accounts.",
    };
    let unavailable = false;
    const pool = new PoolController(
      deps(paths, writeForwardingProxy(paths, api), {
        usageSnapshot: async () => {
          if (unavailable) throw new Error("internal failure details");
          return snapshot;
        },
        refreshUsage: async () => {
          if (unavailable) throw new Error("Account quota checks are unavailable.");
        },
      }),
    );
    try {
      await startPool(pool);
      const sourceFailure = await pool.refreshQuota();
      assert.strictEqual(sourceFailure.quotaError, snapshot.error);
      assert.strictEqual(sourceFailure.accounts[0]?.quotaCheckedAt, checkedAt);
      snapshot = {
        checkedAt,
        accounts: [
          {
            id: ACCOUNTS[0].name,
            driver: ProviderDriverKind.make("claudeAgent"),
            usageLimits: {
              checkedAt,
              windows: [],
              unavailable: {
                reason: "probeFailed",
                message: "The hub could not read this account's usage.",
              },
            },
          },
        ],
      };
      const accountFailure = await pool.refreshQuota();
      assert.isUndefined(accountFailure.quotaError);
      assert.strictEqual(
        accountFailure.accounts[0]?.quotaError,
        "The hub could not read this account's usage.",
      );
      assert.strictEqual(accountFailure.accounts[0]?.quotaCheckedAt, checkedAt);
      unavailable = true;
      const serviceFailure = await pool.status();
      assert.strictEqual(
        serviceFailure.quotaError,
        "Couldn't read account quotas. Try refreshing.",
      );
      await expect(pool.refreshQuota()).rejects.toThrow(/Account quota checks are unavailable/);
      assert.deepStrictEqual(api.resets, []);
    } finally {
      await pool.shutdown();
      await api.close();
    }
  });

  it("rejects quota refresh for external and stopped pools without starting anything", async () => {
    const paths = poolPaths(tempDir());
    let reads = 0;
    let installs = 0;
    const options = deps(paths, "unused", {
      installBinary: async () => {
        installs++;
        throw new Error("must not start");
      },
      refreshUsage: async () => {
        reads++;
      },
    });
    const pool = new PoolController(options);
    try {
      await pool.init();
      await expect(pool.refreshQuota()).rejects.toThrow(/isn't running/);
    } finally {
      await pool.shutdown();
    }
    await savePoolState(paths, { ...decodePoolState({}, 8317), source: "external" });
    const external = new PoolController(options);
    try {
      await external.init();
      await expect(external.refreshQuota()).rejects.toThrow(/Disconnect from the team server/);
      assert.strictEqual(reads, 0);
      assert.strictEqual(installs, 0);
    } finally {
      await external.shutdown();
    }
  });

  it("resets every enabled account, or only the one named", { timeout: 30_000 }, async () => {
    const api = await startFakeApi();
    const paths = poolPaths(tempDir());
    signIn(paths, api, ACCOUNTS);
    const pool = new PoolController(deps(paths, writeForwardingProxy(paths, api)));
    try {
      await startPool(pool);
      await pool.reset();
      assert.deepStrictEqual(api.resets.toSorted(), ["idx-ada", "idx-bob"]);

      api.resets.length = 0;
      await pool.reset("claude-cy@example.com.json");
      assert.deepStrictEqual(api.resets, ["idx-cy"]);

      // One refusal doesn't stop the others; only refusing all of them fails.
      api.resets.length = 0;
      api.failResets.add("idx-ada");
      await pool.reset();
      assert.deepStrictEqual(api.resets.toSorted(), ["idx-ada", "idx-bob"]);
      api.failResets.add("idx-bob");
      let failure: unknown;
      await pool.reset().catch((error) => {
        failure = error;
      });
      assert.match(String(failure), /reset-quota/);
    } finally {
      await pool.shutdown();
      await api.close();
    }
  });

  it("flags a cooldown that a later quota read shows to be over", { timeout: 30_000 }, async () => {
    const api = await startFakeApi();
    const paths = poolPaths(tempDir());
    const benched = {
      status: "error",
      status_message: '{"type":"error","error":{"type":"rate_limit_error"}}',
      unavailable: true,
      next_retry_after: new Date(Date.now() + 3_600_000).toISOString(),
      quota: { observed_at: new Date(Date.now() - 600_000).toISOString(), signals: {} },
    };
    signIn(paths, api, [
      { ...ACCOUNTS[0], listing: benched },
      { ...ACCOUNTS[1], listing: benched },
    ]);
    const checkedAt = new Date(Date.now() - 60_000).toISOString();
    const reading = (id: string, usedPercent: number) => ({
      id,
      driver: ProviderDriverKind.make("codex"),
      usageLimits: {
        checkedAt,
        windows: [{ id: "five_hour", kind: "session" as const, label: "5h", usedPercent }],
      },
    });
    const pool = new PoolController(
      deps(paths, writeForwardingProxy(paths, api), {
        usageSnapshot: async () => ({
          checkedAt,
          accounts: [reading(ACCOUNTS[0].name, 12), reading(ACCOUNTS[1].name, 100)],
        }),
      }),
    );
    try {
      await startPool(pool);
      const accounts = Object.fromEntries(
        (await pool.status()).accounts.map((account) => [account.id, account]),
      );
      assert.strictEqual(accounts[ACCOUNTS[0].name]?.status, "cooling");
      assert.isTrue(accounts[ACCOUNTS[0].name]?.staleCooldown);
      assert.isUndefined(accounts[ACCOUNTS[1].name]?.staleCooldown, "a full window is real");
    } finally {
      await pool.shutdown();
      await api.close();
    }
  });

  it(
    "records drained usage per account, and drains the rest before stopping",
    { timeout: 30_000 },
    async () => {
      const api = await startFakeApi();
      const paths = poolPaths(tempDir());
      signIn(paths, api, ACCOUNTS);
      const binary = writeForwardingProxy(paths, api);
      const pool = new PoolController(deps(paths, binary));
      try {
        await startPool(pool);
        api.queue.push(
          record({ auth_index: "idx-ada" }),
          record({ auth_index: "idx-ada" }),
          // No handle: attributed by address.
          record({ provider: "codex", model: "gpt-6", source: "bob@example.com" }),
          // Answered without trying an account.
          record({}),
        );
        const usage = await pool.usage({ range: "24h", timeZone: "UTC" });
        assert.isTrue(usage.recording);
        assert.strictEqual(requestsOf(usage)[ACCOUNTS[0].name], 2);
        assert.strictEqual(requestsOf(usage)[ACCOUNTS[1].name], 1);
        assert.strictEqual(usage.unattributed?.requests, 1);

        // Left in the proxy's memory at shutdown: drained before the proxy stops.
        api.queue.push(record({ auth_index: "idx-bob", provider: "codex", model: "gpt-6" }));
      } finally {
        await pool.shutdown();
      }
      assert.deepStrictEqual(api.queue, []);
      await api.close();

      const reopened = new PoolController(
        deps(paths, binary, {
          installBinary: async () => {
            throw new Error("offline");
          },
        }),
      );
      try {
        await reopened.init();
        const usage = await reopened.usage({ range: "24h", timeZone: "UTC" });
        assert.isFalse(usage.recording);
        assert.strictEqual(
          usage.recordingNote,
          "Account sharing isn't running, so nothing is being recorded.",
        );
        assert.strictEqual(requestsOf(usage)[ACCOUNTS[0].name], 2);
        assert.strictEqual(requestsOf(usage)[ACCOUNTS[1].name], 2);
      } finally {
        await reopened.shutdown();
      }
    },
  );

  it(
    "drains its own proxy when switching to a team server, never the team server",
    { timeout: 30_000 },
    async () => {
      const api = await startFakeApi();
      const team = await startFakeApi();
      team.queue.push(record({ auth_index: "idx-team" }));
      const paths = poolPaths(tempDir());
      signIn(paths, api, ACCOUNTS);
      const pool = new PoolController(deps(paths, writeForwardingProxy(paths, api)));
      try {
        await startPool(pool);
        api.queue.push(record({ auth_index: "idx-ada" }));
        await pool.setSource({
          source: "external",
          externalUrl: `http://127.0.0.1:${team.port}`,
          externalKey: "team-key",
        });
        const usage = await pool.usage({ range: "24h", timeZone: "UTC" });
        assert.isFalse(usage.recording);
        assert.strictEqual(usage.recordingNote, "A team server records its own usage.");
        assert.strictEqual(requestsOf(usage)[ACCOUNTS[0].name], 1, "history stays readable");
        assert.deepStrictEqual(api.queue, []);
        assert.lengthOf(team.queue, 1);
        assert.notInclude(team.requests, "GET /v0/management/usage-queue");
      } finally {
        await pool.shutdown();
        await api.close();
        await team.close();
      }
    },
  );
});
