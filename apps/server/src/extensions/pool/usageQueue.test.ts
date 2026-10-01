import { assert, describe, it } from "@effect/vitest";

import { parseUsageQueueRecord } from "./usageQueue.ts";

// A usage-queue record as CLIProxyAPI 7.3.17 publishes it, with synthetic values.
const claudeRecord = {
  timestamp: "2026-10-01T12:28:38.641694+10:00",
  latency_ms: 11046,
  ttft_ms: 1446,
  source: "ada@example.com",
  auth_index: "aaaa1111bbbb2222",
  access_token_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
  client_ip: "127.0.0.1",
  resolved_client_ip: "127.0.0.1",
  x_forwarded_for: "",
  user_agent: "claude-cli/2.1.284 (external, sdk-ts, agent-sdk/0.3.276)",
  tokens: {
    input_tokens: 2,
    output_tokens: 988,
    reasoning_tokens: 833,
    cached_tokens: 71024,
    cache_read_tokens: 71024,
    cache_read_tokens_present: true,
    cache_creation_tokens: 7198,
    total_tokens: 79212,
  },
  failed: false,
  generate: true,
  stream: true,
  fail: { status_code: 200, body: "" },
  response_headers: { "X-Example": ["synthetic"] },
  accounting_version: 2,
  token_breakdown: {
    schema_version: 2,
    quality: "complete",
    total_tokens: 79212,
    input: {
      total_tokens: 78224,
      uncached_tokens: 2,
      cache_read_tokens: 71024,
      cache_write_tokens: 7198,
    },
    output: { total_tokens: 988, non_reasoning_tokens: 155, reasoning_tokens: 833 },
    unclassified_tokens: 0,
  },
  provider: "claude",
  executor_type: "ClaudeExecutor",
  model: "claude-opus-5-5",
  alias: "claude-opus-5-5",
  endpoint: "POST /v1/messages",
  auth_type: "oauth",
  api_key: "synthetic-client-key",
  request_id: "000006b3",
  execution_id: "00000000-0000-4000-8000-000000000001",
  trace_id: "000006b3",
  session_id: "00000000-0000-4000-8000-0000000000aa",
  reasoning_effort: "high",
  service_tier: "auto",
  response_model: "claude-opus-5-5",
};

const rateLimitBody = JSON.stringify({
  type: "error",
  error: {
    type: "rate_limit_error",
    message: "This request would exceed your account's rate limit. Please try again later.",
  },
});

describe("usage queue record", () => {
  it("keeps the usage and nothing that identifies the client", () => {
    assert.deepStrictEqual(parseUsageQueueRecord(claudeRecord), {
      at: Date.parse("2026-10-01T02:28:38.641Z"),
      executionId: "00000000-0000-4000-8000-000000000001",
      authIndex: "aaaa1111bbbb2222",
      email: "ada@example.com",
      provider: "claude",
      model: "claude-opus-5-5",
      failed: false,
      tokens: {
        uncachedInputTokens: 2,
        cachedInputTokens: 71024,
        cacheCreationTokens: 7198,
        outputTokens: 988,
        reasoningTokens: 833,
      },
      latencyMs: 11046,
      ttftMs: 1446,
    });
  });

  it("reads a failed attempt's status and the upstream error message", () => {
    const sample = parseUsageQueueRecord({
      ...claudeRecord,
      failed: true,
      fail: { status_code: 429, body: rateLimitBody },
      ttft_ms: 0,
      tokens: { input_tokens: 0, output_tokens: 0 },
      token_breakdown: { schema_version: 2, quality: "complete", input: {}, output: {} },
    });
    assert.strictEqual(sample?.failed, true);
    assert.strictEqual(sample?.statusCode, 429);
    assert.strictEqual(
      sample?.message,
      "This request would exceed your account's rate limit. Please try again later.",
    );
    assert.strictEqual(sample?.ttftMs, undefined);
    assert.deepStrictEqual(sample?.tokens, {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it("collapses and caps a body that isn't a JSON error", () => {
    const sample = parseUsageQueueRecord({
      ...claudeRecord,
      failed: true,
      fail: { status_code: 502, body: `<html>\n  <body>${"bad gateway ".repeat(50)}</body>` },
    });
    assert.strictEqual(sample?.statusCode, 502);
    assert.isTrue(sample?.message?.startsWith("<html> <body>bad gateway bad gateway"));
    assert.strictEqual(sample?.message?.length, 300);
  });

  it("skips calls that generate nothing and providers outside the pool", () => {
    assert.isUndefined(parseUsageQueueRecord({ ...claudeRecord, generate: false }));
    assert.isUndefined(parseUsageQueueRecord({ ...claudeRecord, provider: "gemini" }));
    assert.isUndefined(parseUsageQueueRecord({ ...claudeRecord, timestamp: "soon" }));
    assert.isUndefined(parseUsageQueueRecord([claudeRecord]));
  });

  it("subtracts cached tokens from Codex's legacy input count", () => {
    const { token_breakdown: _breakdown, ...legacy } = claudeRecord;
    const sample = parseUsageQueueRecord({
      ...legacy,
      provider: "codex",
      source: "codex-key-1",
      model: "gpt-6",
      alias: "gpt-6",
      response_model: "",
      // OpenAI semantics: cached is inside input, reasoning inside output.
      tokens: { input_tokens: 1000, cached_tokens: 600, output_tokens: 200, reasoning_tokens: 150 },
    });
    assert.strictEqual(sample?.model, "gpt-6");
    assert.strictEqual(sample?.email, undefined);
    assert.deepStrictEqual(sample?.tokens, {
      uncachedInputTokens: 400,
      cachedInputTokens: 600,
      cacheCreationTokens: 0,
      outputTokens: 200,
      reasoningTokens: 150,
    });
  });

  it("falls back to the raw counts when the breakdown couldn't classify them", () => {
    const sample = parseUsageQueueRecord({
      ...claudeRecord,
      token_breakdown: {
        schema_version: 2,
        quality: "unclassified",
        total_tokens: 79212,
        unclassified_tokens: 79212,
        input: {},
        output: {},
      },
    });
    assert.deepStrictEqual(sample?.tokens, {
      uncachedInputTokens: 2,
      cachedInputTokens: 71024,
      cacheCreationTokens: 7198,
      outputTokens: 988,
      reasoningTokens: 833,
    });
  });
});
