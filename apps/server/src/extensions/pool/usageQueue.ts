/**
 * Reads one record of the proxy's usage queue (`GET /v0/management/usage-queue`,
 * CLIProxyAPI 7.3.17) into a `UsageSample`, keeping only what the pool reports
 * on. Client keys, token hashes, IPs, user agents and response headers are
 * dropped here and never reach the store.
 */
import type { UsageTokenTotals } from "@t3tools/contracts";

import { poolProviderOf } from "./management.ts";
import type { UsageSample } from "./usageTypes.ts";

const MESSAGE_MAX_CHARS = 300;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** A token count: a non-negative integer, 0 for anything else. */
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const positiveMs = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;

/**
 * Token totals with upstream's semantics: input split into uncached, cache read
 * and cache write; reasoning a subset of output.
 *
 * The v2 `token_breakdown` already normalises both providers. Only a "complete"
 * one is used: an unclassified or inconsistent breakdown has empty buckets, so
 * those fall back to the raw `tokens` block, where Claude counts input buckets
 * independently and Codex (OpenAI) includes cached tokens in `input_tokens`.
 */
const tokensOf = (record: Record<string, unknown>, provider: string): UsageTokenTotals => {
  const breakdown = record.token_breakdown;
  if (isRecord(breakdown) && breakdown.schema_version === 2 && breakdown.quality === "complete") {
    const input = isRecord(breakdown.input) ? breakdown.input : {};
    const output = isRecord(breakdown.output) ? breakdown.output : {};
    const outputTokens = count(output.total_tokens);
    return {
      uncachedInputTokens: count(input.uncached_tokens),
      cachedInputTokens: count(input.cache_read_tokens),
      cacheCreationTokens: count(input.cache_write_tokens),
      outputTokens,
      reasoningTokens: Math.min(count(output.reasoning_tokens), outputTokens),
    };
  }
  const tokens = isRecord(record.tokens) ? record.tokens : {};
  const input = count(tokens.input_tokens);
  const cached = count(tokens.cache_read_tokens) || count(tokens.cached_tokens);
  const creation = count(tokens.cache_creation_tokens);
  const outputTokens = count(tokens.output_tokens);
  return {
    uncachedInputTokens: provider === "codex" ? Math.max(0, input - cached - creation) : input,
    cachedInputTokens: cached,
    cacheCreationTokens: creation,
    outputTokens,
    reasoningTokens: Math.min(count(tokens.reasoning_tokens), outputTokens),
  };
};

/** The upstream error's own message when the body is a JSON error, else the body, on one short line. */
const errorMessage = (body: unknown): string | undefined => {
  const raw = text(body);
  if (!raw) return undefined;
  let message = raw;
  try {
    const json: unknown = JSON.parse(raw);
    if (isRecord(json)) {
      const inner = isRecord(json.error) ? text(json.error.message) : text(json.error);
      message = inner || text(json.message) || raw;
    }
  } catch {
    // Not JSON (an HTML error page, plain text): keep the body.
  }
  const line = message.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > MESSAGE_MAX_CHARS ? `${line.slice(0, MESSAGE_MAX_CHARS - 1)}…` : line;
};

/**
 * One usage-queue record as a sample, or `undefined` when the pool does not
 * count it: not an object, a non-generating call (`count_tokens`), a provider
 * other than Claude or Codex, or no usable timestamp or model.
 */
export const parseUsageQueueRecord = (raw: unknown): UsageSample | undefined => {
  if (!isRecord(raw) || raw.generate === false) return undefined;
  const provider = poolProviderOf(text(raw.provider));
  if (!provider) return undefined;
  const at = Date.parse(text(raw.timestamp));
  if (!Number.isFinite(at)) return undefined;
  const model = text(raw.response_model) || text(raw.model) || text(raw.alias);
  if (!model) return undefined;

  const failed = raw.failed === true;
  const fail = isRecord(raw.fail) ? raw.fail : {};
  const statusCode =
    failed && typeof fail.status_code === "number" && Number.isInteger(fail.status_code)
      ? fail.status_code
      : undefined;
  const message = failed ? errorMessage(fail.body) : undefined;
  const executionId = text(raw.execution_id);
  const authIndex = text(raw.auth_index);
  const email = text(raw.source);
  const latencyMs = positiveMs(raw.latency_ms);
  const ttftMs = positiveMs(raw.ttft_ms);

  return {
    at,
    ...(executionId ? { executionId } : {}),
    ...(authIndex ? { authIndex } : {}),
    ...(EMAIL.test(email) ? { email } : {}),
    provider,
    model,
    failed,
    ...(statusCode !== undefined && statusCode > 0 ? { statusCode } : {}),
    ...(message ? { message } : {}),
    tokens: tokensOf(raw, provider),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(ttftMs !== undefined ? { ttftMs } : {}),
  };
};
