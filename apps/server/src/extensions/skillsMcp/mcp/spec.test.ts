import { assert, describe, it } from "@effect/vitest";

import {
  claudeEntryFor,
  claudeExtras,
  codexEntryFor,
  codexExtras,
  specFromClaude,
  specFromCodex,
  specToClaude,
  specToCodex,
  stringMap,
} from "./spec.ts";

describe("specFromClaude", () => {
  it("reads stdio entries, with or without an explicit type", () => {
    assert.deepStrictEqual(
      specFromClaude({
        type: "stdio",
        command: "npx",
        args: ["-y", "pkg"],
        env: { KEY: "v", NUM: 1 },
        cwd: "/w",
      }),
      { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { KEY: "v" }, cwd: "/w" },
    );
    // `claude mcp add-json` stores `args: []` and `env: {}` for bare commands.
    assert.deepStrictEqual(specFromClaude({ command: "node", args: [], env: {} }), {
      type: "stdio",
      command: "node",
    });
  });

  it("reads http and sse entries; a bare url is http", () => {
    assert.deepStrictEqual(
      specFromClaude({ type: "http", url: "https://x/mcp", headers: { A: "b" } }),
      { type: "http", url: "https://x/mcp", headers: { A: "b" } },
    );
    assert.deepStrictEqual(specFromClaude({ type: "sse", url: "https://x/sse" }), {
      type: "sse",
      url: "https://x/sse",
    });
    assert.deepStrictEqual(specFromClaude({ url: "https://x/mcp" }), {
      type: "http",
      url: "https://x/mcp",
    });
  });

  it("returns undefined for transports the contract does not model", () => {
    assert.strictEqual(specFromClaude({ type: "sdk", name: "in-process" }), undefined);
    assert.strictEqual(specFromClaude({ type: "ws", url: "wss://x" }), undefined);
    assert.strictEqual(specFromClaude({ type: "stdio" }), undefined);
    assert.strictEqual(specFromClaude("nope"), undefined);
  });
});

describe("specToClaude", () => {
  it("always writes args for stdio, as add-json expects", () => {
    assert.deepStrictEqual(specToClaude({ type: "stdio", command: "node" }), {
      type: "stdio",
      command: "node",
      args: [],
    });
  });

  it("round trips every transport", () => {
    const specs = [
      { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { K: "v" }, cwd: "/w" },
      { type: "http", url: "https://x/mcp", headers: { A: "b" } },
      { type: "sse", url: "https://x/sse" },
    ] as const;
    for (const spec of specs) assert.deepStrictEqual(specFromClaude(specToClaude(spec)), spec);
  });

  it("drops the Codex-only bearer env var", () => {
    assert.deepStrictEqual(
      specToClaude({ type: "http", url: "https://x/mcp", bearerTokenEnvVar: "TOKEN" }),
      { type: "http", url: "https://x/mcp" },
    );
  });
});

describe("specFromCodex", () => {
  // `config/read` tables from codex-cli 0.157.0 against a throwaway CODEX_HOME;
  // the TOML had `type = "stdio"` on `echo`, which Codex ignores and strips.
  it("reads the tables config/read returns", () => {
    assert.deepStrictEqual(
      specFromCodex({
        command: "node",
        args: ["/tmp/echo-server.mjs"],
        environment_id: "local",
        enabled: true,
        startup_timeout_sec: 20,
        tool_timeout_sec: null,
      }),
      { type: "stdio", command: "node", args: ["/tmp/echo-server.mjs"] },
    );
    assert.deepStrictEqual(
      specFromCodex({
        url: "https://example.invalid/mcp",
        bearer_token_env_var: "EXAMPLE_TOKEN",
        http_headers: { "X-Team": "t3" },
        environment_id: "local",
        enabled: true,
        tool_timeout_sec: null,
      }),
      {
        type: "http",
        url: "https://example.invalid/mcp",
        headers: { "X-Team": "t3" },
        bearerTokenEnvVar: "EXAMPLE_TOKEN",
      },
    );
  });

  it("ignores a CC Switch `type` key and infers the transport", () => {
    assert.deepStrictEqual(specFromCodex({ type: "sse", command: "node" }), {
      type: "stdio",
      command: "node",
    });
    assert.deepStrictEqual(specFromCodex({ type: "stdio", url: "https://x/mcp" }), {
      type: "http",
      url: "https://x/mcp",
    });
    assert.strictEqual(specFromCodex({ enabled: true }), undefined);
  });
});

describe("specToCodex", () => {
  it("omits empty args and maps http fields to Codex keys", () => {
    assert.deepStrictEqual(specToCodex({ type: "stdio", command: "node", args: [] }), {
      command: "node",
    });
    assert.deepStrictEqual(
      specToCodex({
        type: "http",
        url: "https://x/mcp",
        headers: { A: "b" },
        bearerTokenEnvVar: "TOKEN",
      }),
      { url: "https://x/mcp", http_headers: { A: "b" }, bearer_token_env_var: "TOKEN" },
    );
  });

  it("has no SSE transport and never writes `type`", () => {
    assert.strictEqual(specToCodex({ type: "sse", url: "https://x/sse" }), undefined);
    const stdio = specToCodex({ type: "stdio", command: "node", env: { K: "v" }, cwd: "/w" });
    assert.deepStrictEqual(stdio, { command: "node", env: { K: "v" }, cwd: "/w" });
    assert.isFalse(stdio !== undefined && "type" in stdio);
  });

  it("round trips stdio and http", () => {
    const specs = [
      { type: "stdio", command: "npx", args: ["-y", "pkg"], env: { K: "v" }, cwd: "/w" },
      { type: "http", url: "https://x/mcp", headers: { A: "b" }, bearerTokenEnvVar: "T" },
    ] as const;
    for (const spec of specs) assert.deepStrictEqual(specFromCodex(specToCodex(spec)), spec);
  });
});

describe("extras", () => {
  it("keeps the Claude fields the spec does not model", () => {
    assert.deepStrictEqual(
      claudeExtras({ type: "stdio", command: "node", args: [], timeout: 5000, oauth: { a: 1 } }),
      { timeout: 5000, oauth: { a: 1 } },
    );
    assert.strictEqual(claudeExtras({ type: "http", url: "https://x", headers: {} }), undefined);
  });

  it("drops `type`, nulls and the local environment default from Codex tables", () => {
    assert.deepStrictEqual(
      codexExtras({
        type: "stdio",
        command: "node",
        enabled: false,
        environment_id: "local",
        tool_timeout_sec: null,
        startup_timeout_sec: 20,
      }),
      { startup_timeout_sec: 20 },
    );
    assert.deepStrictEqual(codexExtras({ url: "https://x", environment_id: "remote" }), {
      environment_id: "remote",
    });
    assert.strictEqual(codexExtras({ command: "node", enabled: true }), undefined);
  });

  it("stringMap keeps only string values", () => {
    assert.deepStrictEqual(stringMap({ a: "1", b: 2, c: null }), { a: "1" });
    assert.strictEqual(stringMap({ b: 2 }), undefined);
    assert.strictEqual(stringMap(["a"]), undefined);
  });
});

describe("entry builders", () => {
  const stdio = { type: "stdio", command: "node", args: ["server.js"] } as const;
  const http = { type: "http", url: "https://x/mcp" } as const;

  it("claudeEntryFor keeps extras only on the same transport, spec fields winning", () => {
    assert.deepStrictEqual(
      claudeEntryFor(stdio, { spec: stdio, fields: { timeout: 5000, command: "stale" } }),
      { timeout: 5000, type: "stdio", command: "node", args: ["server.js"] },
    );
    assert.deepStrictEqual(claudeEntryFor(http, { spec: stdio, fields: { timeout: 5000 } }), {
      type: "http",
      url: "https://x/mcp",
    });
  });

  it("codexEntryFor adds enabled, filters extras, and refuses SSE", () => {
    assert.deepStrictEqual(
      codexEntryFor(stdio, false, {
        spec: stdio,
        fields: { startup_timeout_sec: 20, type: "stdio", environment_id: "local" },
      }),
      { startup_timeout_sec: 20, command: "node", args: ["server.js"], enabled: false },
    );
    assert.deepStrictEqual(
      codexEntryFor(http, true, { spec: stdio, fields: { startup_timeout_sec: 20 } }),
      { url: "https://x/mcp", enabled: true },
    );
    assert.strictEqual(codexEntryFor({ type: "sse", url: "https://x" }, true, {}), undefined);
  });
});
