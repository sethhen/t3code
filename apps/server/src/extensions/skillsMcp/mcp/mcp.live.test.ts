/**
 * End-to-end MCP flows against the real `claude` and `codex` CLIs, each
 * pointed at a throwaway config dir (CLAUDE_CONFIG_DIR / CODEX_HOME), with a
 * tiny stdio MCP server run by `node`. Opt in with `SKILLS_MCP_LIVE_TESTS=1`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { McpMutation, McpServerRow } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { type AgentCli, resolveAgentClis } from "../shared/agents.ts";
import { listMcp, mutateMcp } from "./index.ts";
import { probeClaude, probeCodex } from "./probes.ts";
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
      codexTable("seeded", echoServer, ['type = "stdio"', "startup_timeout_sec = 20"]),
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

const codexHas = (toml: string, name: string) =>
  new RegExp(`^\\[mcp_servers\\.${name}[\\].]`, "m").test(toml);

describe.skipIf(!LIVE)("mcp (live CLIs, sandboxed)", () => {
  // Real clock: CLI timeouts and the pending-server wait must not run on the TestClock.
  it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect(
      "import, upsert, enable/disable, rename, reconnect, project toggle, probes, delete",
      () =>
        withSandbox((sandbox) =>
          Effect.gen(function* () {
            const { project } = sandbox;

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

            // Disabling in Codex rewrites the table: `enabled = false`, extras kept, no `type`.
            const seededId = seeded?.id ?? "";
            yield* expectOk({ action: "setEnabled", id: seededId, app: "codex", enabled: false });
            const disabledToml = yield* readText(sandbox.codexToml);
            assert.match(disabledToml, /enabled = false/);
            assert.match(disabledToml, /startup_timeout_sec = 20/);
            assert.notMatch(disabledToml, /^type\s*=/m);
            assert.include((yield* rowNamed(project, "seeded"))?.apps.codex, {
              enabled: false,
              status: "disabled",
            });
            yield* expectOk({ action: "setEnabled", id: seededId, app: "codex", enabled: true });
            connected(yield* rowNamed(project, "seeded"), "codex");

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

            // Claude's per-project toggle.
            yield* expectOk({
              action: "setProjectEnabled",
              name: "echo3",
              cwd: project,
              enabled: false,
            });
            // Outside a git checkout Claude keys the project by its resolved path
            // (/private/var on macOS).
            const projects = (yield* readClaudeServers(sandbox.claudeJson)).projects ?? {};
            const projectKey = yield* (yield* FileSystem.FileSystem).realPath(project);
            assert.include(projects[projectKey]?.disabledMcpServers ?? [], "echo3");
            assert.include((yield* rowNamed(project, "echo3"))?.apps.claude, {
              status: "disabled",
            });
            yield* expectOk({
              action: "setProjectEnabled",
              name: "echo3",
              cwd: project,
              enabled: true,
            });
            connected(yield* rowNamed(project, "echo3"), "claude");

            // The raw probes other modules build on.
            const claudeProbe = yield* probeClaude(sandbox.claude, project, { refresh: true });
            assert.isUndefined(claudeProbe.error);
            assert.strictEqual(
              claudeProbe.statuses.find((server) => server.name === "echo3")?.status,
              "connected",
            );
            yield* Effect.log("[live] claude context", {
              detail: claudeProbe.contextDetail,
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

            // A server added outside T3 is adopted by an explicit import.
            const fs = yield* FileSystem.FileSystem;
            const toml = yield* fs.readFileString(sandbox.codexToml);
            yield* fs.writeFileString(
              sandbox.codexToml,
              `${toml}\n${codexTable("late", sandbox.echoServer)}`,
            );
            assert.strictEqual(
              (yield* expectOk({ action: "import" })).message,
              "Imported 1 server",
            );
            const late = yield* rowNamed(project, "late");
            assert.isTrue(late?.managed);
            assert.include(late?.apps.claude, { present: false, enabled: false });
            connected(late, "codex");

            // Let the last list's background context probe finish before the sandbox goes.
            yield* probeClaude(sandbox.claude, project);
          }),
        ),
      TIMEOUT,
    );
  });
});
