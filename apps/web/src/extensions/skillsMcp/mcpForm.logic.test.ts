import { assert, describe, it } from "vite-plus/test";

import {
  codexTransportBlock,
  describeSpec,
  emptyMcpServerForm,
  formatArgs,
  formatEnvLines,
  formatHeaderLines,
  formToSpec,
  formToUpsert,
  maskSecret,
  maskUrl,
  parseEnvLines,
  parseHeaderLines,
  parsePastedServerJson,
  serverNameError,
  specToFormFields,
  splitArgs,
  toServerName,
  type McpServerForm,
} from "./mcpForm.logic";
import type { McpServerSpec } from "@t3tools/contracts";

const BOTH = { claude: true, codex: true };

function form(patch: Partial<McpServerForm>): McpServerForm {
  return { ...emptyMcpServerForm(BOTH), name: "demo", ...patch };
}

describe("server names", () => {
  it("validates and slugifies", () => {
    assert.equal(serverNameError(""), "Name is required.");
    assert.equal(serverNameError("my server"), "Use letters, digits, - and _ only.");
    assert.equal(serverNameError("my_server-2"), null);
    assert.equal(toServerName("  GitHub Copilot! "), "github-copilot");
  });

  it("blocks Codex for SSE only", () => {
    assert.isString(codexTransportBlock("sse"));
    assert.isNull(codexTransportBlock("http"));
    assert.isNull(codexTransportBlock("stdio"));
  });
});

describe("env lines", () => {
  it("parses KEY=VALUE, export prefixes, comments and quotes", () => {
    const parsed = parseEnvLines('# comment\nFOO=bar\n\nexport TOKEN="a=b c"\nEMPTY=\n');
    assert.deepEqual(parsed, { ok: true, value: { FOO: "bar", TOKEN: "a=b c", EMPTY: "" } });
  });

  it("reports the offending line", () => {
    assert.deepEqual(parseEnvLines("A=1\nnope"), {
      ok: false,
      error: "Env line 2: expected KEY=VALUE.",
    });
    assert.deepEqual(parseEnvLines("1BAD=x"), {
      ok: false,
      error: 'Env line 1: "1BAD" is not a valid name.',
    });
  });

  it("round-trips values that need quoting", () => {
    const env = { A: "plain", B: " padded ", C: '"quoted"' };
    const parsed = parseEnvLines(formatEnvLines(env));
    assert.deepEqual(parsed, { ok: true, value: env });
    assert.equal(formatEnvLines(undefined), "");
  });
});

describe("header lines", () => {
  it("parses and formats Name: value", () => {
    const parsed = parseHeaderLines("Authorization: Bearer x:y\nX-Api-Key:abc");
    assert.deepEqual(parsed, {
      ok: true,
      value: { Authorization: "Bearer x:y", "X-Api-Key": "abc" },
    });
    assert.equal(formatHeaderLines({ A: "1", B: "2" }), "A: 1\nB: 2");
  });

  it("rejects malformed lines", () => {
    assert.deepEqual(parseHeaderLines("no colon"), {
      ok: false,
      error: "Header line 1: expected Name: value.",
    });
    assert.deepEqual(parseHeaderLines("Bad Name: x"), {
      ok: false,
      error: 'Header line 1: "Bad Name" is not a valid header name.',
    });
  });
});

describe("arguments", () => {
  it("splits with shell-style quoting", () => {
    assert.deepEqual(splitArgs(`-y  @scope/pkg 'a b' "c \\"d\\"" e\\ f C:\\tools`), {
      ok: true,
      value: ["-y", "@scope/pkg", "a b", 'c "d"', "e f", "C:\\tools"],
    });
    assert.deepEqual(splitArgs(`''`), { ok: true, value: [""] });
    assert.deepEqual(splitArgs(""), { ok: true, value: [] });
    assert.deepEqual(splitArgs(`"open`), { ok: false, error: "Unclosed quote." });
  });

  it("formatArgs output splits back to the same list", () => {
    const args = ["plain", "has space", "it's", 'say "hi"', "back\\slash", ""];
    assert.deepEqual(splitArgs(formatArgs(args)), { ok: true, value: args });
  });
});

describe("spec <-> form", () => {
  const specs: McpServerSpec[] = [
    { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    {
      type: "stdio",
      command: "/Applications/My Tool.app/bin/mcp",
      args: ["--flag", "two words"],
      env: { TOKEN: "abc", EMPTY: "" },
      cwd: "/tmp",
    },
    { type: "stdio", command: "C:\\tools\\mcp.exe" },
    {
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Key": "k" },
      bearerTokenEnvVar: "EXAMPLE_TOKEN",
    },
    { type: "sse", url: "http://localhost:3000/sse" },
  ];

  for (const spec of specs) {
    it(`round-trips ${spec.type} ${"command" in spec ? spec.command : spec.url}`, () => {
      assert.deepEqual(formToSpec(specToFormFields(spec)), { ok: true, value: spec });
    });
  }

  it("splits a whole command line typed into Command", () => {
    const fields = form({ command: "npx -y pkg", args: "--port 3" });
    assert.deepEqual(formToSpec(fields), {
      ok: true,
      value: { type: "stdio", command: "npx", args: ["-y", "pkg", "--port", "3"] },
    });
  });

  it("validates required fields", () => {
    assert.deepEqual(formToSpec(form({})), { ok: false, error: "Command is required." });
    assert.deepEqual(formToSpec(form({ transport: "http" })), {
      ok: false,
      error: "URL is required.",
    });
    assert.deepEqual(formToSpec(form({ transport: "http", url: "ftp://x" })), {
      ok: false,
      error: "URL must start with http:// or https://.",
    });
    assert.deepEqual(formToSpec(form({ command: "run", args: "'x" })), {
      ok: false,
      error: "Arguments: Unclosed quote.",
    });
  });
});

describe("formToUpsert", () => {
  it("drops Codex for SSE and keeps optional fields only when set", () => {
    const result = formToUpsert(
      form({ transport: "sse", url: "https://x.dev/sse", description: " Docs ", tags: ["a"] }),
      "id-1",
    );
    assert.deepEqual(result, {
      ok: true,
      value: {
        action: "upsert",
        id: "id-1",
        name: "demo",
        spec: { type: "sse", url: "https://x.dev/sse" },
        apps: { claude: true, codex: false },
        description: "Docs",
        tags: ["a"],
      },
    });
  });

  it("requires an app", () => {
    const result = formToUpsert(
      form({ command: "run", apps: { claude: false, codex: false } }),
      undefined,
    );
    assert.deepEqual(result, { ok: false, error: "Pick at least one app." });
    const sseOnlyCodex = formToUpsert(
      form({ transport: "sse", url: "https://x.dev", apps: { claude: false, codex: true } }),
      undefined,
    );
    assert.deepEqual(sseOnlyCodex, { ok: false, error: "Pick at least one app." });
  });

  it("validates name and homepage", () => {
    assert.deepEqual(formToUpsert(form({ name: "", command: "x" }), undefined), {
      ok: false,
      error: "Name is required.",
    });
    assert.deepEqual(formToUpsert(form({ command: "x", homepage: "nope" }), undefined), {
      ok: false,
      error: "Homepage must be a full URL.",
    });
  });
});

describe("parsePastedServerJson", () => {
  it("reads a Claude mcpServers map", () => {
    const text = JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "gh"], env: { TOKEN: "x", PORT: 3 } },
      },
    });
    assert.deepEqual(parsePastedServerJson(text), {
      ok: true,
      value: {
        name: "github",
        spec: { type: "stdio", command: "npx", args: ["-y", "gh"], env: { TOKEN: "x", PORT: "3" } },
      },
    });
  });

  it("reads a bare fragment with a trailing comma", () => {
    const text = `"docs": { "type": "streamable-http", "url": "https://d.dev/mcp", "headers": { "A": "b" } },`;
    assert.deepEqual(parsePastedServerJson(text), {
      ok: true,
      value: {
        name: "docs",
        spec: { type: "http", url: "https://d.dev/mcp", headers: { A: "b" } },
      },
    });
  });

  it("reads one bare server object carrying its own name", () => {
    const text = JSON.stringify({
      name: "remote",
      type: "sse",
      url: "https://r.dev/sse",
      description: "Remote",
      homepage: "https://r.dev",
    });
    assert.deepEqual(parsePastedServerJson(text), {
      ok: true,
      value: {
        name: "remote",
        spec: { type: "sse", url: "https://r.dev/sse" },
        description: "Remote",
        homepage: "https://r.dev",
      },
    });
  });

  it("reads a nameless server and Codex-style keys", () => {
    const text = JSON.stringify({
      url: "https://c.dev/mcp",
      http_headers: { X: "1" },
      bearer_token_env_var: "C_TOKEN",
    });
    assert.deepEqual(parsePastedServerJson(text), {
      ok: true,
      value: {
        spec: {
          type: "http",
          url: "https://c.dev/mcp",
          headers: { X: "1" },
          bearerTokenEnvVar: "C_TOKEN",
        },
      },
    });
  });

  it("reports problems", () => {
    assert.deepEqual(parsePastedServerJson("  "), {
      ok: false,
      error: "Paste a server definition first.",
    });
    const invalid = parsePastedServerJson("{nope");
    assert.isFalse(invalid.ok);
    if (!invalid.ok) assert.match(invalid.error, /^Not valid JSON: /);
    assert.deepEqual(parsePastedServerJson("[1]"), { ok: false, error: "Expected a JSON object." });
    assert.deepEqual(
      parsePastedServerJson(
        JSON.stringify({ mcpServers: { a: { command: "a" }, b: { command: "b" } } }),
      ),
      { ok: false, error: "Found 2 servers; paste one at a time." },
    );
    assert.deepEqual(parsePastedServerJson(JSON.stringify({ mcpServers: {} })), {
      ok: false,
      error: "No server definition found.",
    });
    assert.deepEqual(parsePastedServerJson(JSON.stringify({ x: { type: "ws", url: "wss://x" } })), {
      ok: false,
      error: 'Unsupported transport "ws".',
    });
  });
});

describe("masking", () => {
  it("masks secrets without revealing short values", () => {
    assert.equal(maskSecret(""), "");
    assert.equal(maskSecret("short"), "••••••••");
    assert.equal(maskSecret("sk-1234567890abcdef"), "••••••••cdef");
  });

  it("masks URL passwords and secret query params", () => {
    assert.equal(
      maskUrl("https://user:hunter2@host.dev/mcp?api_key=abc&mode=x&token=t#frag"),
      "https://user:••••@host.dev/mcp?api_key=••••&mode=x&token=••••#frag",
    );
    assert.equal(maskUrl("https://host.dev/mcp"), "https://host.dev/mcp");
  });

  it("describes specs with masked values", () => {
    assert.deepEqual(
      describeSpec({
        type: "stdio",
        command: "npx",
        args: ["-y", "pkg"],
        env: { TOKEN: "secret-value-long-1234" },
        cwd: "/w",
      }),
      [
        { label: "Command", value: "npx -y pkg" },
        { label: "Env", value: "TOKEN=••••••••1234" },
        { label: "Cwd", value: "/w" },
      ],
    );
    assert.deepEqual(
      describeSpec({
        type: "http",
        url: "https://h.dev/?key=1",
        headers: { Authorization: "Bearer x" },
        bearerTokenEnvVar: "H_TOKEN",
      }),
      [
        { label: "HTTP", value: "https://h.dev/?key=••••" },
        { label: "Header", value: "Authorization: ••••••••" },
        { label: "Bearer", value: "$H_TOKEN" },
      ],
    );
  });
});
