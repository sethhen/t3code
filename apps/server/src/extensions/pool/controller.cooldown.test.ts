// @effect-diagnostics nodeBuiltinImport:off - drives a fake proxy process and temp state directories.
// @effect-diagnostics globalDate:off - cooldown observations carry wall-clock timestamps.
/**
 * Cooldown reset and startup quota checks against a fake proxy: a forwarding
 * process the sidecar spawns in front of an in-test management API, so each
 * test controls the auth file listing and sees every request.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { PoolController, type PoolDeps } from "./controller.ts";
import { poolPaths, type PoolPaths } from "./state.ts";
import { deriveProviderInstanceConfigMap } from "./t3.ts";

const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pool-cooldown-"));

/** The management API behind the fake proxy: what it lists and what it was asked. */
interface FakeApi {
  readonly port: number;
  files: Array<Record<string, unknown>>;
  readonly resets: string[];
  readonly failResets: Set<string>;
  readonly requests: string[];
  readonly close: () => Promise<void>;
}

const startFakeApi = async (): Promise<FakeApi> => {
  const api = {
    files: [] as Array<Record<string, unknown>>,
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
  usageAccounts: async () => [],
  refreshUsage: async () => undefined,
  claudeProbe: async () => {
    throw new Error("no probe in unit tests");
  },
  claudeConfigDir: async () => undefined,
  codexVersion: async () => undefined,
  installBinary: async () => binary,
  log: () => undefined,
  ...over,
});

/** Starts the pool and waits until its proxy answers (`setSource` awaits the start). */
const startPool = async (pool: PoolController) => {
  await pool.init();
  await pool.setSource({ source: "local" });
};

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

describe("pool cooldown reset and startup quotas", () => {
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
        usageAccounts: async () => [reading(ACCOUNTS[0].name, 12), reading(ACCOUNTS[1].name, 100)],
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
});
