// @effect-diagnostics nodeBuiltinImport:off - builds a fake release archive on disk for the download path.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import { assert, describe, it } from "@effect/vitest";

import { RELEASE_ASSETS, binaryName, ensureBinary } from "./binary.ts";
import { renderProxyConfig } from "./config.ts";
import { accountStatusOf, claudePlanLabel, decodeAuthFiles, joinUrl } from "./management.ts";
import { findEnvConflicts } from "./parity.ts";
import { decodePoolState, defaultRouteMode } from "./state.ts";

describe("proxy config", () => {
  const yaml = renderProxyConfig({
    port: 18417,
    authDir: "/Users/me/Library/Application Support/t3/pool/auth",
    clientKey: "client",
    managementKey: "secret",
  });

  it("pins sessions to accounts and spreads subagents", () => {
    assert.include(yaml, "  session-affinity: true\n");
    assert.include(yaml, "  session-affinity-subagents: false\n");
    assert.include(yaml, "host: 127.0.0.1\n");
    assert.include(yaml, "  allow-remote: false\n");
  });

  it("quotes paths with spaces", () => {
    assert.include(yaml, 'auth-dir: "/Users/me/Library/Application Support/t3/pool/auth"\n');
  });
});

describe("claude plan", () => {
  // Shape of https://api.anthropic.com/api/oauth/profile (Claude Code 2.1.285), trimmed.
  const profile = (organizationType: string, rateLimitTier: string | null) => ({
    account: { uuid: "a", email: "a@example.com", has_claude_max: true, has_claude_pro: false },
    organization: {
      uuid: "o",
      organization_type: organizationType,
      rate_limit_tier: rateLimitTier,
      billing_type: "stripe_subscription",
      seat_tier: null,
    },
  });

  it("names the Max tier from the rate limit tier", () => {
    assert.strictEqual(
      claudePlanLabel(profile("claude_max", "default_claude_max_20x")),
      "Claude Max 20x Subscription",
    );
    assert.strictEqual(
      claudePlanLabel(profile("claude_max", "default_claude_max_5x")),
      "Claude Max 5x Subscription",
    );
    assert.strictEqual(claudePlanLabel(profile("claude_max", null)), "Claude Max Subscription");
  });

  it("names the other subscriptions", () => {
    assert.strictEqual(claudePlanLabel(profile("claude_pro", null)), "Claude Pro Subscription");
    assert.strictEqual(claudePlanLabel(profile("claude_team", null)), "Claude Team Subscription");
    assert.strictEqual(
      claudePlanLabel(profile("claude_enterprise", null)),
      "Claude Enterprise Subscription",
    );
  });

  it("leaves unknown organizations to the usage source's label", () => {
    assert.isUndefined(claudePlanLabel(profile("api_individual", null)));
    assert.isUndefined(claudePlanLabel({}));
    assert.isUndefined(claudePlanLabel(null));
  });
});

describe("auth files", () => {
  // Shape captured from CLIProxyAPI 7.3.17's /v0/management/auth-files.
  const sample = {
    files: [
      {
        name: "claude-a@example.com.json",
        provider: "claude",
        email: "a@example.com",
        disabled: false,
        unavailable: false,
        status: "active",
        status_message: "",
        cooldowns: [],
      },
      {
        name: "codex-b@example.com-pro.json",
        provider: "codex",
        email: "b@example.com",
        disabled: true,
        status: "disabled",
        cooldowns: [],
      },
      {
        name: "claude-c@example.com.json",
        provider: "claude",
        status: "active",
        cooldowns: [{ model: "claude-opus-5-5", until: "2030-01-01T03:00:00Z" }],
      },
      { name: "gemini-x.json", provider: "gemini" },
    ],
  };
  const files = decodeAuthFiles(sample);
  const now = Date.parse("2030-01-01T00:00:00Z");

  it("decodes the proxy's listing", () => {
    assert.strictEqual(files.length, 4);
    assert.strictEqual(files[2]!.cooldownUntil, "2030-01-01T03:00:00Z");
  });

  it("maps proxy state to account status", () => {
    assert.deepStrictEqual(accountStatusOf(files[0]!, now), { status: "ready" });
    assert.strictEqual(accountStatusOf(files[1]!, now).status, "disabled");
    const cooling = accountStatusOf(files[2]!, now);
    assert.strictEqual(cooling.status, "cooling");
    assert.include(cooling.message ?? "", "in 3h");
    assert.strictEqual(
      accountStatusOf({ ...files[0]!, status: "error", statusMessage: "token revoked" }, now)
        .message,
      "token revoked",
    );
  });

  it("keeps a URL path prefix", () => {
    assert.strictEqual(
      joinUrl("https://pool.example.com/team/", "/v1/models"),
      "https://pool.example.com/team/v1/models",
    );
  });
});

describe("pool state", () => {
  it("fills defaults and regenerates missing secrets", () => {
    const state = decodePoolState({ source: "nope", routes: { a: "pool", b: "bogus" } }, 18_420);
    assert.strictEqual(state.source, "local");
    assert.strictEqual(state.port, 18_420);
    assert.lengthOf(state.clientKey, 48);
    assert.notStrictEqual(state.clientKey, state.managementKey);
    assert.deepStrictEqual(state.routes, { a: "pool" });
  });

  it("routes the default instances through the pool, extra ones direct", () => {
    assert.strictEqual(defaultRouteMode("claudeAgent"), "pool");
    assert.strictEqual(defaultRouteMode("codex"), "pool");
    assert.strictEqual(defaultRouteMode("claudeAgent_work"), "direct");
  });
});

describe("parity: conflicting Claude settings", () => {
  it("flags settings that undo a parity fix", () => {
    const conflicts = findEnvConflicts(
      { FORCE_PROMPT_CACHING_5M: "1", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5[1m]" },
      { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" },
    );
    assert.lengthOf(conflicts, 3);
    assert.deepStrictEqual(findEnvConflicts({ FORCE_PROMPT_CACHING_5M: "0" }, {}), []);
    assert.deepStrictEqual(
      findEnvConflicts({ ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5" }, {}),
      [],
    );
  });
});

describe("binary", () => {
  it("pins a digest for every platform T3 runs on", () => {
    for (const key of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]) {
      assert.match(RELEASE_ASSETS[key]?.sha256 ?? "", /^[0-9a-f]{64}$/, key);
    }
    assert.strictEqual(binaryName("win32"), "cli-proxy-api.exe");
  });

  it("refuses an archive whose digest doesn't match, installing nothing", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pool-bin-"));
    try {
      const staging = NodePath.join(dir, "src");
      NodeFS.mkdirSync(staging);
      NodeFS.writeFileSync(NodePath.join(staging, "cli-proxy-api"), "#!/bin/sh\necho fake\n");
      const archive = NodePath.join(dir, "fake.tar.gz");
      NodeChildProcess.execFileSync("tar", ["-czf", archive, "-C", staging, "cli-proxy-api"]);
      const bytes = NodeFS.readFileSync(archive);
      assert.notStrictEqual(
        NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        RELEASE_ASSETS["darwin-arm64"]!.sha256,
      );
      const binDir = NodePath.join(dir, "bin");
      const fakeFetch = (async () => new Response(bytes)) as unknown as typeof fetch;
      let failure: unknown;
      await ensureBinary(binDir, { platform: "darwin", arch: "arm64", fetch: fakeFetch }).catch(
        (error) => {
          failure = error;
        },
      );
      assert.match(String(failure), /checksum/);
      assert.deepStrictEqual(NodeFS.readdirSync(binDir), []);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
