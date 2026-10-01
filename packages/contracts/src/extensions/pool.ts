/**
 * Pool extension - Claude and Codex through a CLIProxyAPI account pool, set up
 * the way native Claude Code and Codex behave.
 *
 * The pool is either `local` (this server downloads, configures and runs a
 * pinned CLIProxyAPI with its own sign-ins) or `external` (a CLIProxyAPI the
 * user reaches by URL and client key, e.g. a team server). Either way the
 * routing is applied here, at spawn time, as a runtime overlay on the
 * provider instances: nothing is written to `~/.claude/settings.json` or
 * `~/.codex/config.toml`, and every setting that keeps a proxied session at
 * native parity (tool search, 1h prompt cache, advisor, sticky routing) comes
 * with the fork, so an update fixes every install.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "../baseSchemas.ts";
import { ServerProviderUsageWindow } from "../providerUsageLimits.ts";
import { UsagePricing, UsageTokenTotals } from "../usage.ts";
import { defineExtension } from "./host.ts";

export const POOL_EXTENSION_ID = "pool";

/** Where the pool runs: this server (`local`) or a CLIProxyAPI reached by URL (`external`). */
export const PoolSource = Schema.Literals(["local", "external"]);
export type PoolSource = typeof PoolSource.Type;

/** The agents a pool serves; matches the proxy's own provider names. */
export const PoolProvider = Schema.Literals(["claude", "codex"]);
export type PoolProvider = typeof PoolProvider.Type;

export const PoolRouteMode = Schema.Literals(["pool", "direct"]);
export type PoolRouteMode = typeof PoolRouteMode.Type;

/** One Claude or Codex provider instance and whether its sessions go through the pool. */
export const PoolRoute = Schema.Struct({
  instanceId: Schema.String,
  provider: PoolProvider,
  displayName: Schema.String,
  mode: PoolRouteMode,
  /** True when `mode` is `pool` and the pool can serve this provider now. */
  active: Schema.Boolean,
  /** Why a `pool` route is not active, e.g. no Claude account signed in yet. */
  reason: Schema.optional(Schema.String),
});
export type PoolRoute = typeof PoolRoute.Type;

export const PoolRuntimeState = Schema.Literals([
  /** Local pool with no accounts yet: nothing downloaded, nothing running. */
  "idle",
  "downloading",
  "starting",
  "running",
  "error",
]);
export type PoolRuntimeState = typeof PoolRuntimeState.Type;

export const PoolRuntime = Schema.Struct({
  state: PoolRuntimeState,
  /** The pinned CLIProxyAPI version this build runs. */
  version: Schema.String,
  /** `127.0.0.1:<port>` once the local proxy listens. */
  endpoint: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  /** The local proxy's log file, when it failed (for "Show log"). */
  logPath: Schema.optional(Schema.String),
});
export type PoolRuntime = typeof PoolRuntime.Type;

export const PoolExternal = Schema.Struct({
  url: Schema.String,
  hasKey: Schema.Boolean,
  /** Last reachability probe: undefined before the first one. */
  reachable: Schema.optional(Schema.Boolean),
  message: Schema.optional(Schema.String),
});
export type PoolExternal = typeof PoolExternal.Type;

export const PoolAccountStatus = Schema.Literals(["ready", "cooling", "error", "disabled"]);
export type PoolAccountStatus = typeof PoolAccountStatus.Type;

export const PoolAccount = Schema.Struct({
  /** The proxy's auth file name; stable for the account's lifetime. */
  id: Schema.String,
  provider: PoolProvider,
  email: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
  status: PoolAccountStatus,
  message: Schema.optional(Schema.String),
  /** Quota windows (5-hour, weekly, ...) from the last usage read; empty until one lands. */
  windows: Schema.Array(ServerProviderUsageWindow),
  /** When this account's quota was last checked, including unsuccessful checks. */
  quotaCheckedAt: Schema.optional(Schema.String),
  quotaError: Schema.optional(Schema.String),
  /**
   * The proxy is holding this account back (cooling or error), but a quota read
   * taken after it was benched shows every window below 100%, e.g. after a usage
   * reset. The proxy never re-checks a cooldown on its own; `reset` clears it.
   */
  staleCooldown: Schema.optional(Schema.Boolean),
});
export type PoolAccount = typeof PoolAccount.Type;

export const PoolCheckState = Schema.Literals(["ok", "warn", "fail", "unknown"]);
export type PoolCheckState = typeof PoolCheckState.Type;

/** One native-parity check: a proxied session should behave exactly like a direct one. */
export const PoolCheck = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  state: PoolCheckState,
  detail: Schema.optional(Schema.String),
});
export type PoolCheck = typeof PoolCheck.Type;

/**
 * A model of the other family configured on a pooled instance (e.g. a GPT slug
 * in Claude's custom models). T3 never offers one through the pool; these are
 * hand-configured, so the section flags them rather than blocking.
 */
export const PoolModelIssue = Schema.Struct({
  instanceId: Schema.String,
  displayName: Schema.String,
  provider: PoolProvider,
  slug: Schema.String,
  /** `customModels`: T3's own setting (removable from the section). Otherwise where to edit it. */
  where: Schema.Literals(["customModels", "instanceEnv", "claudeSettings"]),
  /** The env variable, for `instanceEnv` / `claudeSettings`. */
  setting: Schema.optional(Schema.String),
  message: Schema.String,
});
export type PoolModelIssue = typeof PoolModelIssue.Type;

export const PoolStatus = Schema.Struct({
  source: PoolSource,
  runtime: PoolRuntime,
  external: PoolExternal,
  accounts: Schema.Array(PoolAccount),
  accountsError: Schema.optional(Schema.String),
  /** A source-wide quota read failure, separate from the proxy's account listing. */
  quotaError: Schema.optional(Schema.String),
  routes: Schema.Array(PoolRoute),
  checks: Schema.Array(PoolCheck),
  checkedAt: Schema.optional(Schema.String),
  modelIssues: Schema.optional(Schema.Array(PoolModelIssue)),
});
export type PoolStatus = typeof PoolStatus.Type;

export const PoolSetSourceInput = Schema.Struct({
  source: PoolSource,
  /** Required when switching to `external` the first time. */
  externalUrl: Schema.optional(Schema.String),
  /** Omit to keep the saved key. */
  externalKey: Schema.optional(Schema.String),
});
export type PoolSetSourceInput = typeof PoolSetSourceInput.Type;

export const PoolLoginStart = Schema.Struct({
  loginId: Schema.String,
  /** Open in the user's browser; the local proxy receives the callback. */
  url: Schema.String,
});
export type PoolLoginStart = typeof PoolLoginStart.Type;

export const PoolLoginState = Schema.Struct({
  state: Schema.Literals(["pending", "done", "error"]),
  message: Schema.optional(Schema.String),
});
export type PoolLoginState = typeof PoolLoginState.Type;

// ---------------------------------------------------------------------------
// Usage: what each pool account served, recorded by the local pool from the
// proxy's usage queue. Costs are API-equivalent (list price for the tokens),
// priced like the Usage page, not what a subscription bills.

/** The time windows the usage view offers; `today` and `24h` use hourly buckets. */
export const PoolUsageRange = Schema.Literals(["24h", "today", "7d", "30d", "90d"]);
export type PoolUsageRange = typeof PoolUsageRange.Type;

export const PoolUsageInput = Schema.Struct({
  range: PoolUsageRange,
  /** IANA zone: where `today` and day buckets start. */
  timeZone: Schema.String,
});
export type PoolUsageInput = typeof PoolUsageInput.Type;

export const PoolUsageTotals = Schema.Struct({
  /** Generation attempts on an account, failed ones included (token counts are not attempts). */
  requests: NonNegativeInt,
  failed: NonNegativeInt,
  /** Failed with HTTP 429: the account was out of usage or rate limited. */
  rateLimited: NonNegativeInt,
  /** Upstream's token semantics: reasoning is a subset of output, never added on top. */
  tokens: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  /** Requests whose model has no price (counted in tokens, not in cost). */
  unpricedRequests: NonNegativeInt,
  /** Mean over requests that reported one. */
  avgLatencyMs: Schema.optional(NonNegativeInt),
  avgTtftMs: Schema.optional(NonNegativeInt),
});
export type PoolUsageTotals = typeof PoolUsageTotals.Type;

export const PoolUsageModel = Schema.Struct({
  model: Schema.String,
  provider: PoolProvider,
  totals: PoolUsageTotals,
});
export type PoolUsageModel = typeof PoolUsageModel.Type;

export const PoolUsageAccount = Schema.Struct({
  /** `PoolAccount.id` while the account is signed in; a stable stand-in after it was removed. */
  id: Schema.String,
  provider: PoolProvider,
  email: Schema.optional(Schema.String),
  /** False once the account has been removed from the pool (its history stays). */
  current: Schema.Boolean,
  totals: PoolUsageTotals,
  /** Highest cost first. */
  models: Schema.Array(PoolUsageModel),
  lastUsedAt: Schema.optional(Schema.String),
});
export type PoolUsageAccount = typeof PoolUsageAccount.Type;

/** One chart column: every account's share of a day or an hour. */
export const PoolUsageBucket = Schema.Struct({
  /** `YYYY-MM-DD` in the requested zone (day resolution), or the UTC ISO start of an hour. */
  key: Schema.String,
  accounts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      costUsd: Schema.Number,
      /** All tokens: uncached + cached + cache creation + output. */
      tokens: NonNegativeInt,
      requests: NonNegativeInt,
    }),
  ),
});
export type PoolUsageBucket = typeof PoolUsageBucket.Type;

export const PoolUsageEvent = Schema.Struct({
  at: Schema.String,
  /** Matches a `PoolUsageAccount.id`; absent when the proxy answered without an account. */
  accountId: Schema.optional(Schema.String),
  provider: PoolProvider,
  model: Schema.String,
  failed: Schema.Boolean,
  /** Upstream HTTP status for a failed request. */
  statusCode: Schema.optional(NonNegativeInt),
  /** The upstream error, trimmed (failed requests only). */
  message: Schema.optional(Schema.String),
  tokens: NonNegativeInt,
  costUsd: Schema.Number,
  latencyMs: Schema.optional(NonNegativeInt),
});
export type PoolUsageEvent = typeof PoolUsageEvent.Type;

export const PoolUsage = Schema.Struct({
  range: PoolUsageRange,
  timeZone: Schema.String,
  /** The window covered: ISO instants, `until` exclusive. */
  since: Schema.String,
  until: Schema.String,
  resolution: Schema.Literals(["hour", "day"]),
  totals: PoolUsageTotals,
  /** Highest cost first; signed-in accounts without usage are listed too. */
  accounts: Schema.Array(PoolUsageAccount),
  /** Requests the proxy answered without trying an account (e.g. all of them cooling down). */
  unattributed: Schema.optional(PoolUsageTotals),
  /** Pool-wide, highest cost first. */
  models: Schema.Array(PoolUsageModel),
  /** Every bucket in the window, oldest first, empty ones included. */
  buckets: Schema.Array(PoolUsageBucket),
  /** Newest first, bounded. */
  recentEvents: Schema.Array(PoolUsageEvent),
  /** Newest first, bounded; failures only, so they outlive a busy stretch of successes. */
  recentErrors: Schema.Array(PoolUsageEvent),
  pricing: UsagePricing,
  /** Whether this server is recording usage now (local pool with the proxy running). */
  recording: Schema.Boolean,
  /** Why it isn't, e.g. a team server records usage itself. */
  recordingNote: Schema.optional(Schema.String),
  /** The oldest usage still kept, so the view can say how far back history goes. */
  recordedSince: Schema.optional(Schema.String),
});
export type PoolUsage = typeof PoolUsage.Type;

export const PoolExtension = defineExtension(POOL_EXTENSION_ID, {
  status: { input: Schema.Struct({}), output: PoolStatus },
  /** Reads subscription quota now without starting a turn or clearing a cooldown. */
  "quota.refresh": { input: Schema.Struct({}), output: PoolStatus },
  setSource: { input: PoolSetSourceInput, output: PoolStatus },
  setRoute: {
    input: Schema.Struct({ instanceId: Schema.String, mode: PoolRouteMode }),
    output: PoolStatus,
  },
  "login.start": { input: Schema.Struct({ provider: PoolProvider }), output: PoolLoginStart },
  "login.status": { input: Schema.Struct({ loginId: Schema.String }), output: PoolLoginState },
  "account.setEnabled": {
    input: Schema.Struct({ id: Schema.String, enabled: Schema.Boolean }),
    output: PoolStatus,
  },
  "account.remove": { input: Schema.Struct({ id: Schema.String }), output: PoolStatus },
  /** Re-runs the native-parity checks (spawns a probe session; no API call). */
  check: { input: Schema.Struct({}), output: PoolStatus },
  restart: { input: Schema.Struct({}), output: PoolStatus },
  /**
   * Clears the proxy's cooldown for one account (`id`) or every enabled one, so it
   * is tried again now. The proxy never re-checks a cooldown against fresh quota;
   * an account that really is out goes back to cooling after one attempt.
   */
  reset: { input: Schema.Struct({ id: Schema.optional(Schema.String) }), output: PoolStatus },
  usage: { input: PoolUsageInput, output: PoolUsage },
});
