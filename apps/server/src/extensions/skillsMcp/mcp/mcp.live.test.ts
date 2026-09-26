/**
 * End-to-end MCP flows against the real `claude` and `codex` CLIs, each
 * pointed at a throwaway config dir (CLAUDE_CONFIG_DIR / CODEX_HOME), with a
 * tiny stdio MCP server run by `node`. Opt in with `SKILLS_MCP_LIVE_TESTS=1`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { McpMutation, McpServerRow } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type AgentCli, resolveAgentClis } from "../shared/agents.ts";
import { deniedServerNames, readClaudeUserSettings } from "../shared/claudeUserSettings.ts";
import { claudeSetProjectEnabled } from "./claude.ts";
import { listMcp, mutateMcp } from "./index.ts";
import { probeClaude, probeCodex } from "./probes.ts";
import { mcpStore } from "./store.ts";
import { serverConfigLayerTest, serverSettingsLayerTest } from "./t3.ts";

const LIVE = process.env.SKILLS_MCP_LIVE_TESTS === "1";
const TIMEOUT = 5 * 60_000;

/** A minimal MCP server over stdio (newline-delimited JSON-RPC) with one `echo` tool. */
const ECHO_SERVER = `import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const tools = [{
  name: "echo",
  description: "Echo the input",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  annotations: { readOnlyHint: true, openWorldHint: false },
}];
const handlers = {
  initialize: (params) => ({
    protocolVersion: params.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "echo", version: "1.2.3" },
  }),
  ping: () => ({}),
  "tools/list": () => ({ tools }),
  "tools/call": (params) => ({ content: [{ type: "text", text: String(params.arguments?.text ?? "") }] }),
  "resources/list": () => ({ resources: [] }),
  "resources/templates/list": () => ({ resourceTemplates: [] }),
  "prompts/list": () => ({ prompts: [] }),
};
createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined || request.id === null) return;
  const handler = handlers[request.method];
  if (handler) send({ id: request.id, result: handler(request.params ?? {}) });
  else send({ id: request.id, error: { code: -32601, message: "Method not found" } });
});
`;

/**
 * What each app reports for the echo tool. Claude 2.1.282 sends no tool
 * descriptions in `mcpServerStatus` and only the annotations that are true.
 */
const ECHO_TOOLS = {
  claude: [{ name: "echo", readOnly: true }],
  codex: [{ name: "echo", description: "Echo the input", readOnly: true, openWorld: false }],
};

/** `.claude.json` with one user server; Claude's own `add-json` shape. */
const seededClaudeJson = (echoServer: string) =>
  JSON.stringify({
    mcpServers: { seeded: { type: "stdio", command: "node", args: [echoServer], env: {} } },
  });

/** A Codex `[mcp_servers.<name>]` table running the echo server. */
const codexTable = (name: string, echoServer: string, extra: ReadonlyArray<string> = []) =>
  [
    `[mcp_servers.${name}]`,
    'command = "node"',
    `args = [${JSON.stringify(echoServer)}]`,
    ...extra,
    "",
  ].join("\n");

interface Sandbox {
  readonly claude: AgentCli;
  readonly codex: AgentCli;
  readonly echoServer: string;
  readonly project: string;
  readonly claudeJson: string;
  readonly codexToml: string;
}

/** Temp config dirs, with T3 settings pointing both providers at them. */
const withSandbox = <A, E, R>(use: (sandbox: Sandbox) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-live-" }));
    const claudeHome = path.join(root, "claude-config");
    const codexHome = path.join(root, "codex-home");
    const project = path.join(root, "project");
    const echoServer = path.join(root, "echo-server.mjs");
    const claudeJson = path.join(claudeHome, ".claude.json");
    const codexToml = path.join(codexHome, "config.toml");
    yield* fs.makeDirectory(claudeHome, { recursive: true });
    yield* fs.makeDirectory(codexHome, { recursive: true });
    yield* fs.makeDirectory(project, { recursive: true });
    yield* fs.writeFileString(echoServer, ECHO_SERVER);
    // The same server in both apps; the Codex table carries CC Switch's `type` key.
    yield* fs.writeFileString(claudeJson, seededClaudeJson(echoServer));
    yield* fs.writeFileString(
      codexToml,
      codexTable("seeded", echoServer, [
        'type = "stdio"',
        "startup_timeout_sec = 20",
        'enabled_tools = ["echo"]',
      ]),
    );

    const layer = Layer.mergeAll(
      serverSettingsLayerTest({
        providers: { claudeAgent: { homePath: claudeHome }, codex: { homePath: codexHome } },
      }),
      serverConfigLayerTest(root, path.join(root, "t3")),
    );
    return yield* Effect.gen(function* () {
      // Never touch the real configs: refuse to run unless both CLIs are sandboxed.
      const { claude, codex } = yield* resolveAgentClis;
      assert.strictEqual(claude.env.CLAUDE_CONFIG_DIR, claudeHome);
      assert.strictEqual(claude.configDir, claudeHome);
      assert.strictEqual(claude.claudeJsonPath, claudeJson);
      assert.strictEqual(codex.configDir, codexHome);
      assert.strictEqual(codex.codexHomeSetting, codexHome);
      return yield* use({ claude, codex, echoServer, project, claudeJson, codexToml });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

const mutate = (mutation: McpMutation) =>
  mutateMcp(mutation).pipe(Effect.tap((result) => Effect.log(`[live] ${mutation.action}`, result)));

const expectOk = (mutation: McpMutation) =>
  mutate(mutation).pipe(
    Effect.tap((result) =>
      Effect.sync(() => assert.deepStrictEqual(result.failures, [], result.failures[0]?.message)),
    ),
  );

const overview = (cwd: string) =>
  listMcp({ cwd }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        for (const info of result.apps) {
          assert.isTrue(info.available, `${info.app} unavailable: ${info.error}`);
        }
        assert.isTrue(result.liveProbe.claude.ok, result.liveProbe.claude.error);
        assert.isTrue(result.liveProbe.codex.ok, result.liveProbe.codex.error);
      }),
    ),
  );

const rowNamed = (cwd: string, name: string) =>
  overview(cwd).pipe(
    Effect.map((result) => result.servers.find((row) => row.name === name && !row.builtin)),
  );

const connected = (row: McpServerRow | undefined, app: "claude" | "codex") => {
  assert.isDefined(row);
  assert.include(row?.apps[app], { present: true, enabled: true, status: "connected" });
  assert.strictEqual(row?.apps[app]?.serverVersion, "1.2.3");
  assert.deepStrictEqual(row?.apps[app]?.tools, ECHO_TOOLS[app]);
};

interface ClaudeJson {
  readonly mcpServers?: Record<string, unknown>;
  readonly projects?: Record<string, { readonly disabledMcpServers?: ReadonlyArray<string> }>;
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const readClaudeServers = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* decodeJson(yield* fs.readFileString(file))) as ClaudeJson;
  });

const readText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file);
  });

/** Edits `.claude.json` the way another tool would, keeping everything else. */
const editClaudeServer = (file: string, name: string, entry: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const json = (yield* decodeJson(yield* fs.readFileString(file))) as Record<string, unknown>;
    const mcpServers = { ...(json.mcpServers as Record<string, unknown>) };
    if (entry === undefined) delete mcpServers[name];
    else mcpServers[name] = entry;
    yield* fs.writeFileString(file, yield* encodeJson({ ...json, mcpServers }));
  });

const storedNamed = (name: string) =>
  Effect.map(mcpStore.read, (store) => store.servers.find((server) => server.name === name));

const codexHas = (toml: string, name: string) =>
  new RegExp(`^\\[mcp_servers\\.${name}[\\].]`, "m").test(toml);

interface AgentProcess {
  readonly pid: number;
  readonly command: string;
}

/**
 * The `claude` / `codex` processes this test process started (its
 * descendants) that run at `cwd`, i.e. the probes' sessions.
 */
const agentProcessesAt = (cwd: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const table = (yield* spawner.lines(
      ChildProcess.make("ps", ["-A", "-o", "pid=,ppid=,command="]),
    )).flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match
        ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }]
        : [];
    });
    const descendants = new Set([process.pid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of table) {
        if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
          descendants.add(row.pid);
          grew = true;
        }
      }
    }
    const agents = table.filter(
      (row) =>
        row.pid !== process.pid &&
        descendants.has(row.pid) &&
        /\b(claude|codex)\b/.test(row.command),
    );
    if (agents.length === 0) return [];
    // `lsof -F n`: a `p<pid>` line, then `f<fd>` and `n<path>` for its cwd.
    const lines = yield* spawner
      .lines(
        ChildProcess.make("lsof", [
          "-a",
          "-d",
          "cwd",
          "-Fn",
          "-p",
          agents.map((row) => row.pid).join(","),
        ]),
      )
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    const atCwd = new Set<number>();
    let pid = 0;
    for (const line of lines) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line === `n${cwd}`) atCwd.add(pid);
    }
    return agents
      .filter((row) => atCwd.has(row.pid))
      .map(({ pid, command }): AgentProcess => ({ pid, command }));
  });

/** Waits (up to 30 s) until a Claude and a Codex session run at `cwd`. */
const awaitAgentSessions = (cwd: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      const found = yield* agentProcessesAt(cwd);
      const claude = found.filter((proc) => /\bclaude\b/.test(proc.command));
      const codex = found.filter((proc) => /\bcodex\b/.test(proc.command));
      if (claude.length > 0 && codex.length > 0) return { claude, codex };
      yield* Effect.sleep("100 millis");
    }
    return assert.fail(`no Claude and Codex probe sessions ran at ${cwd}`);
  });

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!LIVE)("mcp (live CLIs, sandboxed)", () => {
  // Real clock: CLI timeouts and the pending-server wait must not run on the TestClock.
  it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect(
      "import, upsert, enable/disable, rename, reconnect, project toggle, probes, delete",
      () =>
        withSandbox((sandbox) =>
          Effect.gen(function* () {
            const { project } = sandbox;
            const fs = yield* FileSystem.FileSystem;

            // First list auto-imports the user server both apps define.
            const first = yield* overview(project);
            assert.strictEqual(first.servers[0]?.name, "t3-code");
            assert.isTrue(first.servers[0]?.builtin);
            const seeded = first.servers.find((row) => row.name === "seeded");
            assert.isTrue(seeded?.managed, "seeded was not auto-imported");
            assert.strictEqual(seeded?.key, seeded?.id);
            assert.deepStrictEqual(seeded?.spec, {
              type: "stdio",
              command: "node",
              args: [sandbox.echoServer],
            });
            connected(seeded, "claude");
            connected(seeded, "codex");
            assert.strictEqual((yield* mutate({ action: "import" })).message, "Imported 0 servers");

            // A Codex toggle writes only `enabled`: the table, edited outside T3
            // since the import, keeps every other key.
            const seededId = seeded?.id ?? "";
            const importedToml = yield* readText(sandbox.codexToml);
            yield* fs.writeFileString(
              sandbox.codexToml,
              importedToml.replace("startup_timeout_sec = 20", "startup_timeout_sec = 25"),
            );
            const keptLines = [
              'type = "stdio"',
              "startup_timeout_sec = 25",
              'enabled_tools = ["echo"]',
            ];
            yield* expectOk({ action: "setEnabled", id: seededId, app: "codex", enabled: false });
            const disabledToml = yield* readText(sandbox.codexToml);
            for (const line of ["enabled = false", ...keptLines])
              assert.include(disabledToml, line);
            assert.include((yield* rowNamed(project, "seeded"))?.apps.codex, {
              enabled: false,
              status: "disabled",
            });
            yield* expectOk({ action: "setEnabled", id: seededId, app: "codex", enabled: true });
            const enabledToml = yield* readText(sandbox.codexToml);
            for (const line of ["enabled = true", ...keptLines]) assert.include(enabledToml, line);
            connected(yield* rowNamed(project, "seeded"), "codex");

            // Claude keeps nothing for a removed server, so disabling stashes its
            // live entry (edited outside T3, with fields the spec does not model)
            // and enabling re-adds it verbatim.
            const editedClaude = {
              type: "stdio",
              command: "node",
              args: [sandbox.echoServer],
              env: {},
              timeout: 45000,
              alwaysLoad: true,
            };
            yield* editClaudeServer(sandbox.claudeJson, "seeded", editedClaude);
            yield* expectOk({ action: "setEnabled", id: seededId, app: "claude", enabled: false });
            assert.isUndefined((yield* readClaudeServers(sandbox.claudeJson)).mcpServers?.seeded);
            assert.deepStrictEqual((yield* storedNamed("seeded"))?.raw?.claude, editedClaude);
            yield* expectOk({ action: "setEnabled", id: seededId, app: "claude", enabled: true });
            assert.deepStrictEqual(
              (yield* readClaudeServers(sandbox.claudeJson)).mcpServers?.seeded,
              editedClaude,
            );
            assert.isUndefined((yield* storedNamed("seeded"))?.raw);
            connected(yield* rowNamed(project, "seeded"), "claude");

            // Restore: enabling re-creates an entry deleted outside T3 in one app
            // (deleted from every app it is on in, the store drops it instead).
            const drifted = (app: "claude" | "codex") =>
              Effect.map(listMcp({ cwd: project, refresh: true }), (overview) => {
                const row = overview.servers.find((server) => server.name === "seeded");
                assert.include(row?.apps[app], { enabled: true, present: false });
              });
            yield* editClaudeServer(sandbox.claudeJson, "seeded", undefined);
            yield* drifted("claude");
            yield* expectOk({ action: "setEnabled", id: seededId, app: "claude", enabled: true });
            assert.deepInclude((yield* readClaudeServers(sandbox.claudeJson)).mcpServers?.seeded, {
              command: "node",
              args: [sandbox.echoServer],
            });
            yield* fs.writeFileString(sandbox.codexToml, "");
            yield* drifted("codex");
            yield* expectOk({ action: "setEnabled", id: seededId, app: "codex", enabled: true });
            const restoredToml = yield* readText(sandbox.codexToml);
            assert.isTrue(codexHas(restoredToml, "seeded"));
            assert.include(restoredToml, "startup_timeout_sec = 20");
            const restored = yield* rowNamed(project, "seeded");
            connected(restored, "claude");
            connected(restored, "codex");

            // Upsert a new server into both apps.
            const saved = yield* expectOk({
              action: "upsert",
              name: "echo2",
              spec: {
                type: "stdio",
                command: "node",
                args: [sandbox.echoServer],
                env: { ECHO_MODE: "test" },
              },
              apps: { claude: true, codex: true },
              description: "Echo two",
              tags: ["test"],
            });
            assert.strictEqual(saved.message, "Saved echo2");
            const claudeFile = yield* readClaudeServers(sandbox.claudeJson);
            assert.deepStrictEqual(claudeFile.mcpServers?.echo2, {
              type: "stdio",
              command: "node",
              args: [sandbox.echoServer],
              env: { ECHO_MODE: "test" },
            });
            assert.isTrue(codexHas(yield* readText(sandbox.codexToml), "echo2"));
            const echo2 = yield* rowNamed(project, "echo2");
            assert.include(echo2, { managed: true, description: "Echo two" });
            assert.deepStrictEqual(echo2?.tags, ["test"]);
            connected(echo2, "claude");
            connected(echo2, "codex");
            const echoId = echo2?.id ?? "";

            const duplicate = yield* Effect.flip(
              mutateMcp({
                action: "upsert",
                name: "echo2",
                spec: { type: "stdio", command: "node" },
                apps: { claude: true, codex: true },
              }),
            );
            assert.include(duplicate.message, "already exists");

            // Disable and re-enable in Claude (removes / re-adds the user entry).
            yield* expectOk({ action: "setEnabled", id: echoId, app: "claude", enabled: false });
            assert.isUndefined((yield* readClaudeServers(sandbox.claudeJson)).mcpServers?.echo2);
            assert.include((yield* rowNamed(project, "echo2"))?.apps.claude, {
              enabled: false,
              status: "disabled",
            });
            yield* expectOk({ action: "setEnabled", id: echoId, app: "claude", enabled: true });
            connected(yield* rowNamed(project, "echo2"), "claude");

            // Rename moves the server in both apps.
            yield* expectOk({
              action: "upsert",
              id: echoId,
              name: "echo3",
              spec: {
                type: "stdio",
                command: "node",
                args: [sandbox.echoServer],
                env: { ECHO_MODE: "test" },
              },
              apps: { claude: true, codex: true },
            });
            const renamedClaude = (yield* readClaudeServers(sandbox.claudeJson)).mcpServers ?? {};
            assert.isFalse("echo2" in renamedClaude);
            assert.isTrue("echo3" in renamedClaude);
            const renamedToml = yield* readText(sandbox.codexToml);
            assert.isFalse(codexHas(renamedToml, "echo2"));
            assert.isTrue(codexHas(renamedToml, "echo3"));
            const afterRename = yield* overview(project);
            assert.isUndefined(afterRename.servers.find((row) => row.name === "echo2"));
            const echo3 = afterRename.servers.find((row) => row.name === "echo3");
            assert.strictEqual(echo3?.id, echoId);
            assert.strictEqual(echo3?.description, "Echo two");
            connected(echo3, "claude");
            connected(echo3, "codex");

            // SSE cannot go to Codex.
            const sse = yield* mutate({
              action: "upsert",
              name: "sse_only",
              spec: { type: "sse", url: "http://127.0.0.1:9/sse" },
              apps: { claude: false, codex: true },
            });
            assert.deepStrictEqual(
              sse.failures.map((failure) => failure.app),
              ["codex"],
            );
            const sseRow = yield* rowNamed(project, "sse_only");
            assert.include(sseRow?.apps.codex, { enabled: false, editable: false });
            yield* expectOk({ action: "delete", id: sseRow?.id ?? "" });

            // Reconnect re-probes each app.
            for (const app of ["claude", "codex"] as const) {
              const result = yield* expectOk({
                action: "reconnect",
                name: "echo3",
                app,
                cwd: project,
              });
              assert.strictEqual(result.message, "Reconnected echo3");
              const missing = yield* mutate({
                action: "reconnect",
                name: "nope",
                app,
                cwd: project,
              });
              assert.strictEqual(missing.failures[0]?.app, app);
            }

            // Claude's switch for servers the store does not hold: off denies the
            // name in settings.json; on lifts that and Claude's per-project toggle.
            yield* claudeSetProjectEnabled(sandbox.claude, project, "echo3", false);
            // Outside a git checkout Claude keys the project by its resolved path
            // (/private/var on macOS).
            const projects = (yield* readClaudeServers(sandbox.claudeJson)).projects ?? {};
            const projectKey = yield* (yield* FileSystem.FileSystem).realPath(project);
            assert.include(projects[projectKey]?.disabledMcpServers ?? [], "echo3");
            yield* expectOk({ action: "setClaudeEnabled", name: "echo3", enabled: false });
            assert.isTrue(
              deniedServerNames(yield* readClaudeUserSettings(sandbox.claude)).has("echo3"),
            );
            assert.include((yield* rowNamed(project, "echo3"))?.apps.claude, {
              enabled: false,
              status: "disabled",
            });
            yield* expectOk({
              action: "setClaudeEnabled",
              name: "echo3",
              enabled: true,
              cwd: project,
            });
            assert.isFalse(
              deniedServerNames(yield* readClaudeUserSettings(sandbox.claude)).has("echo3"),
            );
            connected(yield* rowNamed(project, "echo3"), "claude");

            // The raw probes other modules build on.
            const claudeProbe = yield* probeClaude(sandbox.claude, project, { refresh: true });
            assert.isUndefined(claudeProbe.error);
            assert.strictEqual(
              claudeProbe.statuses.find((server) => server.name === "echo3")?.status,
              "connected",
            );
            yield* Effect.log("[live] claude context", {
              error: claudeProbe.contextError,
              totalTokens: claudeProbe.contextUsage?.totalTokens,
            });
            assert.isDefined(claudeProbe.contextUsage, claudeProbe.contextError);
            const codexProbe = yield* probeCodex(sandbox.codex, project, { refresh: true });
            assert.isUndefined(codexProbe.error);
            const codexEcho = codexProbe.statuses.find((server) => server.name === "echo3");
            assert.deepStrictEqual(codexEcho?.tools.echo?.inputSchema, {
              type: "object",
              properties: { text: { type: "string" } },
            });

            // Delete removes it from both apps and the store.
            yield* expectOk({ action: "delete", id: echoId });
            assert.isFalse(
              "echo3" in ((yield* readClaudeServers(sandbox.claudeJson)).mcpServers ?? {}),
            );
            assert.isFalse(codexHas(yield* readText(sandbox.codexToml), "echo3"));
            assert.isUndefined(yield* rowNamed(project, "echo3"));

            // A server added outside T3 is adopted by the next list, and dropped
            // once it is removed outside T3 again.
            const toml = yield* fs.readFileString(sandbox.codexToml);
            yield* fs.writeFileString(
              sandbox.codexToml,
              `${toml}\n${codexTable("late", sandbox.echoServer)}`,
            );
            // A refreshed list: the cached Codex probe predates the edit.
            const lateRow = Effect.map(listMcp({ cwd: project, refresh: true }), (overview) =>
              overview.servers.find((row) => row.name === "late"),
            );
            const late = yield* lateRow;
            assert.isTrue(late?.managed);
            assert.include(late?.apps.claude, { present: false, enabled: false });
            connected(late, "codex");
            yield* fs.writeFileString(sandbox.codexToml, toml);
            assert.isUndefined(yield* lateRow);
            assert.isFalse((yield* mcpStore.read).servers.some((server) => server.name === "late"));

            // Let the last list's background context probe finish before the sandbox goes.
            yield* probeClaude(sandbox.claude, project);
          }),
        ),
      TIMEOUT,
    );

    it.effect(
      "a write stops the probes in flight, then lands in both apps and the probes rerun",
      () =>
        withSandbox((sandbox) =>
          Effect.gen(function* () {
            const { project } = sandbox;
            // A Codex server that never answers keeps the (otherwise quick)
            // Codex probe running for a few seconds, like a Claude one.
            yield* expectOk({
              action: "upsert",
              name: "slowpoke",
              spec: {
                type: "stdio",
                command: "node",
                args: ["-e", "setTimeout(() => process.exit(1), 4000)"],
              },
              apps: { claude: false, codex: true },
            });
            // Both CLIs rewrite their config when they start (Claude again on
            // exit), so a probe overlapping the write could drop it.
            const claudeProbe = yield* Effect.forkChild(
              probeClaude(sandbox.claude, project, { refresh: true }),
            );
            const codexProbe = yield* Effect.forkChild(
              probeCodex(sandbox.codex, project, { refresh: true }),
            );
            const sessions = yield* awaitAgentSessions(project);
            yield* Effect.log("[live] probe sessions before the write", sessions);

            yield* expectOk({
              action: "upsert",
              name: "racer",
              spec: { type: "stdio", command: "node", args: [sandbox.echoServer] },
              apps: { claude: true, codex: true },
            });
            // The write interrupted both probes and waited for their processes.
            for (const proc of [...sessions.claude, ...sessions.codex]) {
              assert.isFalse(isAlive(proc.pid), `${proc.command} (${proc.pid}) outlived the write`);
            }
            const inBothApps = Effect.gen(function* () {
              assert.deepInclude((yield* readClaudeServers(sandbox.claudeJson)).mcpServers?.racer, {
                command: "node",
                args: [sandbox.echoServer],
              });
              assert.isTrue(codexHas(yield* readText(sandbox.codexToml), "racer"));
            });
            yield* inBothApps;

            // The probes reran after the write, so they see the new server...
            const claude = yield* Fiber.join(claudeProbe);
            assert.isUndefined(claude.error);
            assert.isDefined(claude.statuses.find((server) => server.name === "racer"));
            const codex = yield* Fiber.join(codexProbe);
            assert.isUndefined(codex.error);
            assert.isDefined(codex.statuses.find((server) => server.name === "racer"));
            // ...their own config rewrites kept it, and nothing is left running.
            yield* inBothApps;
            assert.deepStrictEqual(yield* agentProcessesAt(project), []);
          }),
        ),
      TIMEOUT,
    );
  });
});
