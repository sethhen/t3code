// @effect-diagnostics nodeBuiltinImport:off - drives fake proxy processes and temp state directories.
// @effect-diagnostics globalTimers:off - waits on real child processes.
/**
 * Process and state lifecycle of the pool against a fake proxy (a tiny HTTP
 * server behind a shell script), so these run everywhere without the network.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { PoolController, type PoolDeps } from "./controller.ts";
import { Sidecar, isOwnProxy, killStaleProxy } from "./sidecar.ts";
import { poolPaths, savePoolState, decodePoolState, type PoolPaths } from "./state.ts";
import { deriveProviderInstanceConfigMap } from "./t3.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pool-lc-"));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A killed child of this process stays a zombie until reaped; it no longer runs. */
const isZombie = (pid: number) => {
  try {
    return /Z/.test(
      NodeChildProcess.execFileSync("ps", ["-o", "stat=", "-p", String(pid)]).toString(),
    );
  } catch {
    return true;
  }
};

/** A stand-in proxy: answers every request with `{}` on the config's port. */
const writeFakeProxy = (paths: PoolPaths, executable = true) => {
  const dir = NodePath.join(paths.binDir, "test");
  NodeFS.mkdirSync(dir, { recursive: true });
  const script = NodePath.join(dir, "cli-proxy-api");
  NodeFS.writeFileSync(
    script,
    [
      "#!/bin/sh",
      `PORT=$(sed -n 's/^port: //p' "$2")`,
      `exec "${process.execPath}" -e "require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({files:[]}))}).listen($PORT,'127.0.0.1')"`,
      "",
    ].join("\n"),
    { mode: executable ? 0o755 : 0o644 },
  );
  return script;
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(port));
    });
  });

/**
 * The fake proxy is a shell script, so these run on POSIX hosts, where the pool
 * behaves the same on every platform (it only branches on win32). Every test
 * fakes the binary install, so the architecture is never read.
 */
const PLATFORM = "linux";
const ARCH = "x64";

const fakeDeps = (paths: PoolPaths, over: Partial<PoolDeps> = {}) => {
  const calls = { reconcile: 0, install: 0 };
  const deps: PoolDeps = {
    paths,
    platform: PLATFORM,
    arch: ARCH,
    instanceMap: async () => deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS),
    reconcile: async () => {
      calls.reconcile++;
    },
    usageSource: async () => undefined,
    setUsageSource: async () => undefined,
    usageAccounts: async () => [],
    refreshUsage: async () => undefined,
    claudeProbe: async () => {
      throw new Error("no probe in unit tests");
    },
    claudeConfigDir: async () => undefined,
    codexVersion: async () => undefined,
    log: () => undefined,
    ...over,
  };
  return { deps, calls };
};

const writeFakeAccount = (paths: PoolPaths, name = "claude-a@example.com.json") => {
  NodeFS.mkdirSync(paths.authDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(paths.authDir, name),
    JSON.stringify({ type: "claude", email: "a@example.com" }),
  );
};

describe("stale proxy cleanup", () => {
  it("recognises only this pool's own proxy", () => {
    const paths = { binDir: "/state/pool/bin", configPath: "/state/pool/config.yaml" };
    const own = "/state/pool/bin/7.3.17/cli-proxy-api -config /state/pool/config.yaml";
    assert.isTrue(isOwnProxy({ executable: own, commandLine: own }, paths, "darwin"));
    const gui =
      "/Users/me/Library/Application Support/com.cpa.gui/cpa-core/cli-proxy-api -config /Users/me/Library/Application Support/com.cpa.gui/cpa-core/config.yaml";
    assert.isFalse(isOwnProxy({ executable: gui, commandLine: gui }, paths, "darwin"));
    const otherConfig = "/state/pool/bin/7.3.17/cli-proxy-api -config /elsewhere/config.yaml";
    assert.isFalse(
      isOwnProxy({ executable: otherConfig, commandLine: otherConfig }, paths, "darwin"),
    );
    assert.isTrue(
      isOwnProxy(
        {
          executable: String.raw`C:\Users\Me\AppData\t3\pool\bin\7.3.17\cli-proxy-api.exe`,
          commandLine: String.raw`"C:\Users\Me\AppData\t3\pool\bin\7.3.17\cli-proxy-api.exe" -config C:\Users\Me\AppData\t3\pool\config.yaml`,
        },
        {
          binDir: String.raw`c:\users\me\appdata\t3\pool\bin`,
          configPath: String.raw`c:\users\me\appdata\t3\pool\config.yaml`,
        },
        "win32",
      ),
    );
  });

  it("leaves a foreign process named in the pid file alone", async () => {
    const paths = poolPaths(tempDir());
    NodeFS.mkdirSync(paths.root, { recursive: true });
    const foreign = NodeChildProcess.spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      NodeFS.writeFileSync(paths.pidPath, String(foreign.pid));
      await killStaleProxy(paths, PLATFORM);
      assert.isTrue(alive(foreign.pid!), "a process outside the pool's bin dir must survive");
      assert.isFalse(NodeFS.existsSync(paths.pidPath));
    } finally {
      foreign.kill("SIGKILL");
    }
  });
});

describe("sidecar", () => {
  it("recovers from a spawn failure instead of sticking", { timeout: 30_000 }, async () => {
    const paths = poolPaths(tempDir());
    const binary = writeFakeProxy(paths, false);
    const port = await freePort();
    const sidecar = new Sidecar({
      paths,
      binaryPath: binary,
      clientKey: "k",
      managementKey: "m",
      ensurePort: async () => port,
      onChange: () => undefined,
    });
    try {
      await sidecar.start();
      assert.strictEqual(sidecar.state.phase, "error");
      NodeFS.chmodSync(binary, 0o755);
      // The failure scheduled a retry; start() must not be stuck on the dead child either.
      for (let i = 0; i < 50 && sidecar.state.phase !== "running"; i++) await sleep(200);
      assert.strictEqual(sidecar.state.phase, "running");
      assert.strictEqual(NodeFS.readFileSync(paths.pidPath, "utf8").length > 0, true);
    } finally {
      await sidecar.stop();
    }
    assert.isFalse(NodeFS.existsSync(paths.pidPath));
  });
});

describe("sidecar serialisation", () => {
  it(
    "never rejects from a failed attempt (it may run from a timer)",
    { timeout: 15_000 },
    async () => {
      const paths = poolPaths(tempDir());
      const binary = writeFakeProxy(paths);
      // The log path is a directory: opening it fails inside the attempt.
      NodeFS.mkdirSync(paths.logPath, { recursive: true });
      const sidecar = new Sidecar({
        paths,
        binaryPath: binary,
        clientKey: "k",
        managementKey: "m",
        ensurePort: freePort,
        onChange: () => undefined,
      });
      let unhandled: unknown;
      const onUnhandled = (reason: unknown) => {
        unhandled = reason;
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        await sidecar.start();
        assert.strictEqual(sidecar.state.phase, "error");
        await sleep(1_500); // the scheduled retry runs (and fails) too
        assert.isUndefined(unhandled);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        await sidecar.stop();
      }
    },
  );

  it(
    "shares one attempt between concurrent starts and drains it on stop",
    { timeout: 30_000 },
    async () => {
      const paths = poolPaths(tempDir());
      const binary = writeFakeProxy(paths);
      let portCalls = 0;
      const sidecar = new Sidecar({
        paths,
        binaryPath: binary,
        clientKey: "k",
        managementKey: "m",
        ensurePort: async () => {
          portCalls++;
          await sleep(200);
          return freePort();
        },
        onChange: () => undefined,
      });
      await Promise.all([sidecar.start(), sidecar.start(), sidecar.start()]);
      assert.strictEqual(portCalls, 1);
      assert.strictEqual(sidecar.state.phase, "running");
      const pid = Number(NodeFS.readFileSync(paths.pidPath, "utf8"));
      await sidecar.stop();
      assert.isFalse(alive(pid) && !isZombie(pid));

      // A stop issued mid-start returns only after that start settled; nothing spawns later.
      const late = new Sidecar({
        paths,
        binaryPath: binary,
        clientKey: "k",
        managementKey: "m",
        ensurePort: async () => {
          await sleep(300);
          return freePort();
        },
        onChange: () => undefined,
      });
      const starting = late.start();
      await sleep(50);
      await late.stop();
      await starting;
      await sleep(500);
      assert.isFalse(NodeFS.existsSync(paths.pidPath));
      assert.notStrictEqual(late.state.phase, "running");
    },
  );
});

describe("controller", () => {
  it("does not touch settings at launch when nothing is routed", async () => {
    const paths = poolPaths(tempDir());
    const { deps, calls } = fakeDeps(paths, {
      installBinary: async () => {
        throw new Error("nothing should start");
      },
    });
    const pool = new PoolController(deps);
    await pool.init();
    assert.strictEqual(calls.reconcile, 0);
    await pool.shutdown();
  });

  it("cancels a start in progress on shutdown; nothing spawns afterwards", async () => {
    const paths = poolPaths(tempDir());
    writeFakeAccount(paths);
    const marker = NodePath.join(paths.root, "spawned");
    const binary = NodePath.join(paths.root, "never-run.sh");
    NodeFS.mkdirSync(paths.root, { recursive: true });
    NodeFS.writeFileSync(binary, `#!/bin/sh\ntouch "${marker}"\nsleep 30\n`, { mode: 0o755 });
    let aborted = false;
    let finishDownload: () => void = () => undefined;
    const { deps } = fakeDeps(paths, {
      installBinary: (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          // Deliberately ignores the abort: the controller must still not spawn.
          finishDownload = () => resolve(binary);
        }),
    });
    const pool = new PoolController(deps);
    await pool.init();
    await sleep(50);
    const shutdown = pool.shutdown();
    finishDownload();
    await shutdown;
    await sleep(500);
    assert.isTrue(aborted);
    assert.isFalse(NodeFS.existsSync(marker));
  });

  it("rejects account ids the pool never listed", async () => {
    const paths = poolPaths(tempDir());
    writeFakeAccount(paths);
    let installs = 0;
    const { deps } = fakeDeps(paths, {
      installBinary: async () => {
        installs++;
        throw new Error("offline");
      },
    });
    const pool = new PoolController(deps);
    await pool.init();
    await sleep(50);
    const before = installs;
    for (const attempt of [
      () => pool.setAccountEnabled("../../etc/passwd", false),
      () => pool.removeAccount("claude-b@example.com.json"),
    ]) {
      let failure: unknown;
      await attempt().catch((error) => {
        failure = error;
      });
      assert.match(String(failure), /Unknown account/);
    }
    assert.strictEqual(installs, before, "the guard runs before any start");
    await pool.shutdown();
  });

  it("serialises concurrent state changes", async () => {
    const paths = poolPaths(tempDir());
    const { deps } = fakeDeps(paths, {
      installBinary: async () => {
        throw new Error("nothing should start");
      },
    });
    const pool = new PoolController(deps);
    await pool.init();
    const ids = Array.from({ length: 12 }, (_, i) => `claudeAgent_extra${i}`);
    await Promise.all(ids.map((id) => pool.setRoute(id, "pool")));
    const saved = JSON.parse(NodeFS.readFileSync(paths.statePath, "utf8")) as {
      routes: Record<string, string>;
    };
    assert.deepStrictEqual(Object.keys(saved.routes).toSorted(), ids.toSorted());
    assert.deepStrictEqual(
      NodeFS.readdirSync(paths.root).filter((name) => name.endsWith(".tmp")),
      [],
    );
    await pool.shutdown();
  });

  it("moves to a free port when its port is taken", { timeout: 30_000 }, async () => {
    const paths = poolPaths(tempDir());
    writeFakeAccount(paths);
    const taken = await freePort();
    await savePoolState(paths, { ...decodePoolState({}, taken), port: taken });
    const blocker = NodeNet.createServer().listen(taken, "127.0.0.1");
    const binary = writeFakeProxy(paths);
    const { deps, calls } = fakeDeps(paths, { installBinary: async () => binary });
    const pool = new PoolController(deps);
    try {
      await pool.init();
      for (let i = 0; i < 50; i++) {
        const status = await pool.status();
        if (status.runtime.state === "running") break;
        await sleep(200);
      }
      const saved = JSON.parse(NodeFS.readFileSync(paths.statePath, "utf8")) as { port: number };
      assert.notStrictEqual(saved.port, taken);
      assert.notStrictEqual(saved.port, 8317);
      assert.isAbove(calls.reconcile, 0, "routing must follow the new port");
      assert.strictEqual((await pool.status()).runtime.endpoint, `127.0.0.1:${saved.port}`);
    } finally {
      await pool.shutdown();
      blocker.close();
    }
  });

  it("serialises routing: the key file ends with the latest key", async () => {
    const paths = poolPaths(tempDir());
    const { deps } = fakeDeps(paths, {
      installBinary: async () => {
        throw new Error("nothing should start");
      },
    });
    const pool = new PoolController(deps);
    await pool.init();
    const urls = Array.from({ length: 8 }, (_, i) => `http://pool-${i}.example.com`);
    await Promise.all(
      urls.map((url, i) =>
        pool.setSource({ source: "external", externalUrl: url, externalKey: `key-${i}` }),
      ),
    );
    const saved = JSON.parse(NodeFS.readFileSync(paths.statePath, "utf8")) as {
      external: { key: string };
    };
    assert.strictEqual(NodeFS.readFileSync(paths.clientKeyPath, "utf8"), saved.external.key);
    assert.strictEqual((NodeFS.statSync(paths.clientKeyPath).mode & 0o777).toString(8), "600");
    await pool.shutdown();
  });

  it("retries routing that failed instead of treating it as applied", async () => {
    const paths = poolPaths(tempDir());
    let failNext = true;
    let reconciled = 0;
    const { deps } = fakeDeps(paths, {
      installBinary: async () => {
        throw new Error("nothing should start");
      },
      reconcile: async () => {
        if (failNext) {
          failNext = false;
          throw new Error("settings write failed");
        }
        reconciled++;
      },
    });
    const pool = new PoolController(deps);
    await pool.init();
    await pool
      .setSource({ source: "external", externalUrl: "http://pool.example.com", externalKey: "k1" })
      .catch(() => undefined);
    await pool.setRoute("claudeAgent", "pool");
    assert.strictEqual(reconciled, 1, "the failed change is applied by the next one");
    await pool.shutdown();
  });

  it("resolves omitted external fields against the latest state", async () => {
    const paths = poolPaths(tempDir());
    const { deps } = fakeDeps(paths, {
      installBinary: async () => {
        throw new Error("nothing should start");
      },
    });
    const pool = new PoolController(deps);
    await pool.init();
    await pool.setSource({
      source: "external",
      externalUrl: "http://old.example.com",
      externalKey: "old",
    });
    await Promise.all([
      pool.setSource({ source: "external", externalUrl: "http://new.example.com" }),
      pool.setSource({ source: "external", externalKey: "new" }),
    ]);
    const saved = JSON.parse(NodeFS.readFileSync(paths.statePath, "utf8")) as {
      external: { url: string; key: string };
    };
    assert.deepStrictEqual(saved.external, { url: "http://new.example.com", key: "new" });
    await pool.shutdown();
  });

  it("flags cross-family models on pooled instances, from T3 and from settings.json", async () => {
    const paths = poolPaths(tempDir());
    const claudeHome = tempDir();
    NodeFS.writeFileSync(
      NodePath.join(claudeHome, "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-6-astra", ANTHROPIC_MODEL: "claude-opus-5-5" },
      }),
    );
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        claudeAgent: {
          ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
          customModels: ["gpt-6-astra", "claude-x"],
        },
      },
    } as typeof DEFAULT_SERVER_SETTINGS;
    const { deps } = fakeDeps(paths, {
      instanceMap: async () => deriveProviderInstanceConfigMap(settings),
      claudeConfigDir: async () => claudeHome,
      installBinary: async () => {
        throw new Error("offline");
      },
    });
    const pool = new PoolController(deps);
    await pool.init();
    await pool.setSource({
      source: "external",
      externalUrl: "http://pool.example.com",
      externalKey: "k",
    });
    const status = await pool.status();
    const issues = (status.modelIssues ?? []).map((issue) => [
      issue.where,
      issue.slug,
      issue.setting ?? null,
    ]);
    assert.deepStrictEqual(issues, [
      ["customModels", "gpt-6-astra", null],
      ["claudeSettings", "gpt-6-astra", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
    ]);
    const family = status.checks.find((entry) => entry.id === "modelFamilies");
    assert.strictEqual(family?.state, "fail");
    assert.include(family?.detail ?? "", "run GPT inside Claude Code");
    // The overlay itself still never offers the GPT slug to the pooled Claude instance.
    const routed = (await deps.instanceMap())["claudeAgent" as never] as {
      config: { customModels: unknown };
    };
    assert.deepStrictEqual(routed.config.customModels, ["claude-x"]);
    await pool.shutdown();
  });

  it("re-runs checks requested mid-run, so an external pool never shows a stale failure", async () => {
    const paths = poolPaths(tempDir());
    const server = await new Promise<NodeHttp.Server>((resolve) => {
      const created = NodeHttp.createServer((_request, response) => response.end("{}"));
      created.listen(0, "127.0.0.1", () => resolve(created));
    });
    const { port } = server.address() as NodeNet.AddressInfo;
    const { deps } = fakeDeps(paths, {
      installBinary: async () => {
        throw new Error("nothing should start");
      },
    });
    const pool = new PoolController(deps);
    try {
      await pool.init();
      await pool.setSource({
        source: "external",
        externalUrl: `http://127.0.0.1:${port}`,
        externalKey: "k",
      });
      let proxy: string | undefined;
      for (let i = 0; i < 40; i++) {
        proxy = (await pool.status()).checks.find((entry) => entry.id === "proxy")?.state;
        if (proxy === "ok") break;
        await sleep(100);
      }
      assert.strictEqual(proxy, "ok");
    } finally {
      await pool.shutdown();
      server.close();
    }
  });
});
