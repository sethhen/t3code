// @effect-diagnostics nodeBuiltinImport:off - drives a real proxy in a temp state directory.
// @effect-diagnostics globalTimers:off - waits for the proxy's file watcher between steps.
/**
 * The pool end to end against the real pinned CLIProxyAPI and the local
 * `claude`: download + checksum, start, sign-in link, account listing,
 * pause/remove, routing overlay, the native-parity probe, external mode and
 * shutdown. Needs the network and Claude Code, so it only runs when asked:
 *
 *   POOL_INTEGRATION=1 pnpm exec vp test run src/extensions/pool/controller.integration.test.ts
 *
 * Run it after bumping CLIPROXY_VERSION or when an upstream merge touches the
 * seams. No real account is used: a fake auth file stands in for a sign-in.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_SERVER_SETTINGS, type ProviderInstanceConfig } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { launchArgSettings } from "../claudeSettings.ts";
import { PoolController, type PoolDeps } from "./controller.ts";
import { poolPaths } from "./state.ts";
import {
  buildClaudeCapabilitiesProbeQueryOptions,
  deriveProviderInstanceConfigMap,
  mergeProviderInstanceEnvironment,
  resolveClaudeSdkExecutablePath,
} from "./t3.ts";

const enabled = process.env.POOL_INTEGRATION === "1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The env a nested Claude must not inherit from a Claude Code session running this test. */
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_AGENT_SDK|AI_AGENT|ANTHROPIC_)/.test(key))
      delete env[key];
  }
  return env;
};

describe.skipIf(!enabled)("pool controller (integration)", () => {
  it("runs the full lifecycle against the real proxy", { timeout: 240_000 }, async () => {
    const stateDir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "pool-it-"));
    const paths = poolPaths(stateDir);
    let reconciles = 0;
    const instanceMap = async () => deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
    const deps: PoolDeps = {
      paths,
      instanceMap,
      reconcile: async () => {
        reconciles++;
      },
      usageSource: async () => undefined,
      setUsageSource: async () => undefined,
      usageAccounts: async () => [],
      refreshUsage: async () => undefined,
      claudeProbe: async (instanceId) => {
        const instance = (await instanceMap())[
          instanceId as keyof Awaited<ReturnType<typeof instanceMap>>
        ] as ProviderInstanceConfig | undefined;
        const env = mergeProviderInstanceEnvironment(instance?.environment, cleanEnv());
        const executablePath = await Effect.runPromise(
          resolveClaudeSdkExecutablePath("claude", env),
        );
        const baseOptions = buildClaudeCapabilitiesProbeQueryOptions({
          executablePath,
          abortController: new AbortController(),
          environment: env,
          cwd: stateDir,
        });
        const launchArgs = (instance?.config as { launchArgs?: string } | undefined)?.launchArgs;
        return {
          executablePath,
          env: baseOptions.env ?? env,
          flagSettings: launchArgSettings(launchArgs),
          baseOptions,
        };
      },
      claudeConfigDir: async () => stateDir,
      codexVersion: async () => undefined,
      log: () => undefined,
    };
    const pool = new PoolController(deps);
    try {
      await pool.init();
      let status = await pool.status();
      assert.strictEqual(status.runtime.state, "idle");
      assert.deepStrictEqual(
        status.routes.map((route) => [route.instanceId, route.mode, route.active]),
        [
          ["codex", "pool", false],
          ["claudeAgent", "pool", false],
        ].filter(([id]) => status.routes.some((route) => route.instanceId === id)),
      );

      // Sign-in starts the proxy (download + checksum on first use).
      const login = await pool.startLogin("claude");
      assert.match(login.url, /^https:\/\/claude\.ai\/oauth\/authorize\?/);
      assert.strictEqual((await pool.loginStatus(login.loginId)).state, "pending");
      status = await pool.status();
      assert.strictEqual(status.runtime.state, "running");
      assert.include(NodeFs.readFileSync(paths.configPath, "utf8"), "session-affinity: true");

      // A fake account stands in for a completed sign-in.
      NodeFs.writeFileSync(
        NodePath.join(paths.authDir, "claude-it@example.com.json"),
        JSON.stringify({
          type: "claude",
          email: "it@example.com",
          access_token: "x",
          refresh_token: "y",
        }),
      );
      await sleep(2_500);
      const before = reconciles;
      status = await pool.status();
      assert.deepStrictEqual(
        status.accounts.map((account) => [account.id, account.provider]),
        [["claude-it@example.com.json", "claude"]],
      );
      assert.isAbove(reconciles, before, "a Claude account must re-route the Claude instance");
      assert.isTrue(status.routes.find((route) => route.instanceId === "claudeAgent")?.active);
      const routed = (await instanceMap())["claudeAgent" as never] as ProviderInstanceConfig;
      assert.isTrue(
        (routed.environment ?? []).some(
          (entry) =>
            entry.name === "ANTHROPIC_BASE_URL" && entry.value.startsWith("http://127.0.0.1:"),
        ),
      );

      // Native parity, with a real Claude probe session routed through the pool.
      status = await pool.check();
      const checks = Object.fromEntries(status.checks.map((check) => [check.id, check.state]));
      assert.strictEqual(checks.proxy, "ok");
      assert.strictEqual(checks.sticky, "ok");
      assert.strictEqual(checks.toolSearch, "ok", JSON.stringify(status.checks));

      // Pause, then remove.
      status = await pool.setAccountEnabled("claude-it@example.com.json", false);
      assert.strictEqual(status.accounts[0]?.status, "disabled");
      assert.isFalse(status.routes.find((route) => route.instanceId === "claudeAgent")?.active);
      status = await pool.removeAccount("claude-it@example.com.json");
      assert.lengthOf(status.accounts, 0);

      // External mode against the same proxy (it stands in for a team server).
      const port = JSON.parse(NodeFs.readFileSync(paths.statePath, "utf8")).port as number;
      const clientKey = JSON.parse(NodeFs.readFileSync(paths.statePath, "utf8"))
        .clientKey as string;
      status = await pool.setSource({ source: "local" });
      const external = new PoolController({
        ...deps,
        paths: poolPaths(NodePath.join(stateDir, "ext")),
      });
      await external.init();
      await external.shutdown();
      await pool.restart();
      status = await pool.setSource({
        source: "external",
        externalUrl: `http://127.0.0.1:${port}`,
        externalKey: clientKey,
      });
      // Switching to external stops the local proxy, so this one is unreachable by design.
      assert.strictEqual(status.source, "external");
      assert.isTrue(status.routes.every((route) => route.mode === "direct" || route.active));
      status = await pool.setSource({ source: "local" });
      assert.strictEqual(status.source, "local");
      // A proxy left behind by a hard-killed server (this pool's binary + config + pid file)
      // is killed by the next start; a foreign CLIProxyAPI never is (lifecycle.test.ts).
      await pool.shutdown();
      const binDir = NodePath.join(
        paths.binDir,
        NodeFs.readdirSync(paths.binDir).find((d) => !d.startsWith("."))!,
      );
      const leftover = NodeChildProcess.spawn(
        NodePath.join(binDir, "cli-proxy-api"),
        ["-config", paths.configPath],
        {
          stdio: "ignore",
        },
      );
      NodeFs.writeFileSync(paths.pidPath, String(leftover.pid));
      await sleep(1_500);
      const next = new PoolController(deps);
      await next.init();
      await next.startLogin("claude");
      await sleep(500);
      const leftoverExited =
        leftover.exitCode !== null ||
        leftover.signalCode !== null ||
        (await Promise.race([
          new Promise<boolean>((resolve) => leftover.once("exit", () => resolve(true))),
          sleep(3_000).then(() => false),
        ]));
      assert.isTrue(leftoverExited, "the next start must kill a proxy this pool left behind");
      await next.shutdown();
    } finally {
      await pool.shutdown();
      assert.isFalse(NodeFs.existsSync(paths.pidPath));
      NodeFs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
