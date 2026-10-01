// @effect-diagnostics globalFetch:off - the pool's process manager is plain async Node by design; Effect wraps it at the layer and handler boundary.
/**
 * The local proxy's management API (`/v0/management`, localhost only, bearer
 * management secret). Only the endpoints the pool needs, verified against
 * CLIProxyAPI 7.3.17.
 *
 * Account changes go through this API, never by editing auth files: the
 * proxy's file watcher misses atomic renames (an in-place edit is a WRITE, a
 * rename is a REMOVE the proxy never re-reads).
 */
import type {
  PoolAccountStatus,
  PoolProvider,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";

export interface ManagementTarget {
  readonly baseUrl: string;
  readonly managementKey: string;
}

export interface AuthFileEntry {
  readonly name: string;
  readonly provider: string;
  /** The proxy's handle for `api-call` requests made with this account's token. */
  readonly authIndex?: string;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly disabled: boolean;
  readonly unavailable: boolean;
  readonly status: string;
  readonly statusMessage: string;
  readonly cooldownUntil?: string;
  /** When the proxy last read this account's quota (`quota.observed_at`, ISO). */
  readonly quotaObservedAt?: string;
  /** When the proxy tries a benched account again (`next_retry_after`, ISO). */
  readonly nextRetryAfter?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Appends `path` to `base` keeping any path prefix (a team server may live under `/pool`). */
export const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}${path}`;

const request = async (
  target: ManagementTarget,
  path: string,
  init: { readonly method?: string; readonly body?: unknown; readonly timeoutMs?: number } = {},
): Promise<unknown> => {
  const response = await fetch(new URL(`/v0/management/${path}`, target.baseUrl), {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${target.managementKey}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    const message = isRecord(json) && typeof json.error === "string" ? json.error : text.trim();
    throw new Error(
      `Account sharing refused ${path} (HTTP ${response.status}): ${message.slice(0, 200)}`,
    );
  }
  return json;
};

/** The latest ISO timestamp found in a cooldown entry, whatever the field is called. */
const cooldownUntil = (cooldowns: unknown): string | undefined => {
  if (!Array.isArray(cooldowns)) return undefined;
  let latest: string | undefined;
  for (const entry of cooldowns) {
    if (!isRecord(entry)) continue;
    for (const value of Object.values(entry)) {
      if (
        typeof value === "string" &&
        !Number.isNaN(Date.parse(value)) &&
        /\d{4}-\d{2}-\d{2}T/.test(value)
      ) {
        if (!latest || Date.parse(value) > Date.parse(latest)) latest = value;
      }
    }
  }
  return latest;
};

/** An ISO timestamp, or undefined (the proxy writes Go's zero time for "never"). */
const isoTime = (value: unknown): string | undefined =>
  typeof value === "string" && Date.parse(value) > 0 ? value : undefined;

export const decodeAuthFiles = (json: unknown): AuthFileEntry[] => {
  const files = isRecord(json) && Array.isArray(json.files) ? json.files : [];
  return files.flatMap((file): AuthFileEntry[] => {
    if (!isRecord(file) || typeof file.name !== "string") return [];
    const until = cooldownUntil(file.cooldowns);
    const idToken = isRecord(file.id_token) ? file.id_token : {};
    const observedAt = isRecord(file.quota) ? isoTime(file.quota.observed_at) : undefined;
    const retryAfter = isoTime(file.next_retry_after);
    return [
      {
        name: file.name,
        provider: typeof file.provider === "string" ? file.provider : "",
        ...(typeof file.auth_index === "string" ? { authIndex: file.auth_index } : {}),
        ...(typeof idToken.chatgpt_account_id === "string"
          ? { chatgptAccountId: idToken.chatgpt_account_id }
          : {}),
        ...(typeof file.email === "string" && file.email ? { email: file.email } : {}),
        disabled: file.disabled === true,
        unavailable: file.unavailable === true,
        status: typeof file.status === "string" ? file.status : "",
        statusMessage: typeof file.status_message === "string" ? file.status_message : "",
        ...(until ? { cooldownUntil: until } : {}),
        ...(observedAt ? { quotaObservedAt: observedAt } : {}),
        ...(retryAfter ? { nextRetryAfter: retryAfter } : {}),
      },
    ];
  });
};

export const poolProviderOf = (provider: string): PoolProvider | undefined =>
  provider === "claude" ? "claude" : provider === "codex" ? "codex" : undefined;

export const accountStatusOf = (
  file: AuthFileEntry,
  now: number,
): { readonly status: PoolAccountStatus; readonly message?: string } => {
  if (file.disabled) return { status: "disabled", message: "Paused" };
  // A 429 benches the whole account: `unavailable` with a retry time (its status reads
  // "error" and its message is the raw upstream body, so this check comes first).
  const resetsAt = Math.max(
    ...[file.cooldownUntil, file.unavailable ? file.nextRetryAfter : undefined].map((at) =>
      at === undefined ? 0 : Date.parse(at),
    ),
  );
  if (resetsAt > now || file.unavailable) {
    return {
      status: "cooling",
      message:
        resetsAt > now ? `Cooling down · resets ${relativeTime(resetsAt - now)}` : "Cooling down",
    };
  }
  if (file.status === "error" || (file.statusMessage && file.status !== "active")) {
    return { status: "error", message: file.statusMessage || "The proxy reports an error" };
  }
  return { status: "ready" };
};

/** Read this soon after a cooldown with no proxy observation time, a quota read still counts. */
const STALE_COOLDOWN_READ_MS = 15 * 60_000;

/**
 * True when the proxy is holding `file` back on old information: a quota read
 * taken after the proxy last saw the account's quota (or, without that time,
 * in the last 15 minutes) has every window below 100%, e.g. after a usage
 * reset. The proxy never re-checks a cooldown against fresh quota on its own.
 * The caller decides the account is cooling or failing.
 */
export const isStaleCooldown = (
  file: AuthFileEntry,
  limits: ServerProviderUsageLimits | undefined,
  now: number,
): boolean => {
  if (!limits || limits.unavailable || limits.windows.length === 0) return false;
  if (limits.windows.some((window) => window.usedPercent >= 100)) return false;
  const checkedAt = Date.parse(limits.checkedAt);
  if (Number.isNaN(checkedAt)) return false;
  return file.quotaObservedAt
    ? checkedAt > Date.parse(file.quotaObservedAt)
    : now - checkedAt <= STALE_COOLDOWN_READ_MS;
};

const relativeTime = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `in ${hours}h ${minutes % 60}m` : `in ${Math.round(hours / 24)}d`;
};

export const listAuthFiles = async (target: ManagementTarget) =>
  decodeAuthFiles(await request(target, "auth-files"));

export const setAuthFileDisabled = (target: ManagementTarget, name: string, disabled: boolean) =>
  request(target, "auth-files/status", { method: "PATCH", body: { name, disabled } });

export const deleteAuthFile = (target: ManagementTarget, name: string) =>
  request(target, `auth-files?name=${encodeURIComponent(name)}`, { method: "DELETE" });

/** Clears an account's cooldown and per-model states in the proxy's memory, so it is tried now. */
export const resetQuota = (target: ManagementTarget, authIndex: string) =>
  request(target, "reset-quota", { method: "POST", body: { auth_index: authIndex } });

/** Starts an OAuth sign-in; the proxy listens for the browser callback itself. */
export const startLogin = async (target: ManagementTarget, provider: PoolProvider) => {
  const json = await request(
    target,
    `${provider === "claude" ? "anthropic" : "codex"}-auth-url?is_webui=true`,
  );
  if (!isRecord(json) || typeof json.url !== "string" || typeof json.state !== "string") {
    throw new Error("Couldn't get a sign-in link.");
  }
  return { url: json.url, state: json.state };
};

export const loginStatus = async (
  target: ManagementTarget,
  state: string,
): Promise<{ readonly state: "pending" | "done" | "error"; readonly message?: string }> => {
  let json: unknown;
  try {
    json = await request(target, `get-auth-status?state=${encodeURIComponent(state)}`);
  } catch (error) {
    return { state: "error", message: error instanceof Error ? error.message : String(error) };
  }
  const status = isRecord(json) ? json.status : undefined;
  if (status === "wait") return { state: "pending" };
  if (status === "ok") return { state: "done" };
  const message = isRecord(json) && typeof json.error === "string" ? json.error : undefined;
  return { state: "error", ...(message ? { message } : {}) };
};

/**
 * OpenAI's current Codex model catalog, read with one of the pool's own Codex
 * accounts (the request native Codex makes with a ChatGPT login). Without it a
 * pooled Codex falls back to the catalog built into the binary, whose defaults
 * differ (e.g. gpt-6-astra at low effort instead of medium).
 */
export const fetchCodexCatalog = async (
  target: ManagementTarget,
  account: AuthFileEntry,
  codexVersion: string,
): Promise<{ readonly models: ReadonlyArray<unknown> }> => {
  if (!account.authIndex) throw new Error("The Codex account has no proxy handle yet.");
  const json = await request(target, "api-call", {
    method: "POST",
    timeoutMs: 20_000,
    body: {
      auth_index: account.authIndex,
      method: "GET",
      url: `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(codexVersion)}`,
      header: {
        Authorization: "Bearer $TOKEN$",
        "OpenAI-Beta": "codex-1",
        Originator: "codex_cli_rs",
        ...(account.chatgptAccountId ? { "Chatgpt-Account-Id": account.chatgptAccountId } : {}),
      },
    },
  });
  const status = isRecord(json) && typeof json.status_code === "number" ? json.status_code : 0;
  const body = isRecord(json) && typeof json.body === "string" ? json.body : "";
  if (status < 200 || status >= 300)
    throw new Error(`OpenAI refused the model catalog (HTTP ${status}).`);
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed) || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error("OpenAI returned an empty model catalog.");
  }
  return { models: parsed.models };
};

/**
 * The plan label for an Anthropic OAuth profile, worded like upstream's ChatGPT
 * ones (`codexPlanLabel`). Undefined for an organization type Claude Code
 * doesn't treat as a subscription either.
 */
export const claudePlanLabel = (profile: unknown): string | undefined => {
  const organization =
    isRecord(profile) && isRecord(profile.organization) ? profile.organization : {};
  switch (organization.organization_type) {
    case "claude_max":
      return organization.rate_limit_tier === "default_claude_max_20x"
        ? "Claude Max 20x Subscription"
        : organization.rate_limit_tier === "default_claude_max_5x"
          ? "Claude Max 5x Subscription"
          : "Claude Max Subscription";
    case "claude_pro":
      return "Claude Pro Subscription";
    case "claude_team":
      return "Claude Team Subscription";
    case "claude_enterprise":
      return "Claude Enterprise Subscription";
    default:
      return undefined;
  }
};

/**
 * How far up its provider's list an account sorts: the plan's usage multiple
 * where the provider publishes one (Plus and Pro = 1x, standard seats too).
 * Keyed by the labels above and upstream's `codexPlanLabel`.
 */
const PLAN_RANK: Readonly<Record<string, number>> = {
  // OpenAI publishes no multiple for Pro Max; it sits above Pro 20x.
  "ChatGPT Pro Max Subscription": 40,
  "ChatGPT Pro 20x Subscription": 20,
  "ChatGPT Pro 5x Subscription": 5,
  "ChatGPT Plus Subscription": 1,
  "ChatGPT Team Subscription": 1,
  "ChatGPT Business Subscription": 1,
  "ChatGPT Enterprise Subscription": 1,
  "ChatGPT Edu Subscription": 1,
  "ChatGPT Go Subscription": 0.5,
  "ChatGPT Free Subscription": 0,
  "Claude Max 20x Subscription": 20,
  "Claude Max 5x Subscription": 5,
  "Claude Max Subscription": 5,
  "Claude Pro Subscription": 1,
  "Claude Team Subscription": 1,
  "Claude Enterprise Subscription": 1,
};

/** Higher plans first; an unknown or missing plan sorts last. */
export const planRank = (plan: string | undefined): number =>
  plan === undefined ? -1 : (PLAN_RANK[plan] ?? -1);

/**
 * A Claude account's plan, from the OAuth profile Claude Code reads after
 * sign-in. The proxy's auth file doesn't record it, and the usage source only
 * knows "Claude Subscription".
 */
export const fetchClaudePlan = async (
  target: ManagementTarget,
  account: AuthFileEntry,
): Promise<string | undefined> => {
  if (!account.authIndex) throw new Error("The Claude account has no proxy handle yet.");
  const json = await request(target, "api-call", {
    method: "POST",
    timeoutMs: 20_000,
    body: {
      auth_index: account.authIndex,
      method: "GET",
      url: "https://api.anthropic.com/api/oauth/profile",
      header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" },
    },
  });
  const status = isRecord(json) && typeof json.status_code === "number" ? json.status_code : 0;
  const body = isRecord(json) && typeof json.body === "string" ? json.body : "";
  if (status < 200 || status >= 300) {
    throw new Error(`Anthropic refused the account profile (HTTP ${status}).`);
  }
  return claudePlanLabel(JSON.parse(body));
};

export interface ProxyRouting {
  readonly sessionAffinity: boolean;
  readonly subagentsSpread: boolean;
}

export const readRouting = async (target: ManagementTarget): Promise<ProxyRouting> => {
  const json = await request(target, "config");
  const routing = isRecord(json) && isRecord(json.routing) ? json.routing : {};
  return {
    sessionAffinity: routing["session-affinity"] === true,
    subagentsSpread: routing["session-affinity-subagents"] === false,
  };
};

/** Liveness plus client-key check against the OpenAI-style model list. */
export const probeClientKey = async (
  baseUrl: string,
  clientKey: string,
): Promise<{ readonly ok: boolean; readonly message?: string }> => {
  try {
    const response = await fetch(joinUrl(baseUrl, "/v1/models"), {
      headers: { Authorization: `Bearer ${clientKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) return { ok: true };
    return {
      ok: false,
      message:
        response.status === 401 || response.status === 403
          ? "The server rejected the key."
          : `The server answered HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Can't reach the server: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
