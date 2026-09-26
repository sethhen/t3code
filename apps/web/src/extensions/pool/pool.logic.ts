/**
 * Pure helpers for the Pool section: header status, labels, account and route
 * presentation, parity checks, the external URL draft and failure triage.
 */
import {
  defaultInstanceIdForDriver,
  type PoolAccount,
  type PoolModelIssue,
  type PoolCheck,
  type PoolProvider,
  type PoolRoute,
  type PoolStatus,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";

/** Dot tones, keyed like the provider cards' `PROVIDER_STATUS_STYLES`. */
export type PoolTone = "ready" | "warning" | "error" | "disabled";

export const POOL_PROVIDERS: readonly PoolProvider[] = ["claude", "codex"];

export const POOL_PROVIDER_LABEL: Readonly<Record<PoolProvider, string>> = {
  claude: "Claude",
  codex: "Codex",
};

/** What the user signs in with, per provider (Codex runs on a ChatGPT account). */
export const POOL_ACCOUNT_KIND: Readonly<Record<PoolProvider, string>> = {
  claude: "Claude account",
  codex: "ChatGPT account",
};

const DRIVER: Readonly<Record<PoolProvider, ProviderDriverKind>> = {
  claude: ProviderDriverKind.make("claudeAgent"),
  codex: ProviderDriverKind.make("codex"),
};

/** The T3 driver a pool provider maps to, for its icon and quota bar colour. */
export function poolProviderDriver(provider: PoolProvider): ProviderDriverKind {
  return DRIVER[provider];
}

export function accountCountLabel(count: number): string {
  return `${count} ${count === 1 ? "account" : "accounts"}`;
}

export interface HeaderStatus {
  readonly label: string;
  readonly tone: PoolTone;
  /** Longer text for the tooltip (e.g. why the pool can't start). */
  readonly detail?: string;
}

/** The section header's one-line state: the local runtime, or the external server's reachability. */
export function poolHeaderStatus(status: PoolStatus): HeaderStatus {
  if (status.source === "external") {
    const { external } = status;
    if (external.url.trim() === "") return { label: "Not connected", tone: "disabled" };
    if (external.reachable === undefined) return { label: "Connecting…", tone: "disabled" };
    return external.reachable
      ? { label: "Connected", tone: "ready" }
      : { label: "Unreachable", tone: "error" };
  }
  const { runtime } = status;
  switch (runtime.state) {
    case "idle":
      return { label: "Not set up", tone: "disabled" };
    case "downloading":
      return { label: "Downloading…", tone: "disabled" };
    case "starting":
      return { label: "Starting…", tone: "disabled" };
    case "running":
      return { label: `Running · ${accountCountLabel(status.accounts.length)}`, tone: "ready" };
    case "error": {
      const detail = runtime.message?.trim();
      return { label: "Can't start the pool", tone: "error", ...(detail ? { detail } : {}) };
    }
  }
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Routing is only worth showing once the pool can serve something: an account, or a connected server. */
export function isRoutingVisible(status: PoolStatus): boolean {
  return status.source === "external"
    ? status.external.url.trim() !== ""
    : status.accounts.length > 0;
}

/** Claude before Codex, whatever order the instances come in (stable within a provider). */
export function orderRoutes(routes: readonly PoolRoute[]): PoolRoute[] {
  return POOL_PROVIDERS.flatMap((provider) =>
    routes.filter((route) => route.provider === provider),
  );
}

/**
 * Routing in one line, e.g. "Claude and Codex use the pool",
 * "Codex uses the pool · Claude is direct", "Claude is waiting for a Claude account".
 */
export function routingSummary(routes: readonly PoolRoute[]): string {
  if (routes.length === 0) return "No Claude or Codex provider is set up";
  routes = orderRoutes(routes);
  const using = routes.filter((route) => route.mode === "pool" && route.active);
  const waiting = routes.filter((route) => route.mode === "pool" && !route.active);
  const direct = routes.filter((route) => route.mode === "direct");
  const names = (list: readonly PoolRoute[]) => joinNames(list.map((route) => route.displayName));
  const parts: string[] = [];
  if (using.length > 0)
    parts.push(`${names(using)} ${using.length === 1 ? "uses" : "use"} the pool`);
  for (const route of waiting) {
    const reason = routeWaitingReason(route) ?? "";
    parts.push(`${route.displayName} is ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`);
  }
  if (direct.length > 0)
    parts.push(`${names(direct)} ${direct.length === 1 ? "is" : "are"} direct`);
  return parts.join(" · ");
}

/** Parity is only meaningful once some provider actually goes through the pool. */
export function isParityVisible(status: PoolStatus): boolean {
  return status.routes.some((route) => route.active);
}

/** Checks that need attention (failing or warning), failures first. */
export function parityProblems(checks: readonly PoolCheck[]): PoolCheck[] {
  return [
    ...checks.filter((check) => check.state === "fail"),
    ...checks.filter((check) => check.state === "warn"),
  ];
}

/** The collapsed parity line when nothing needs attention. */
export function parityHeadline(checks: readonly PoolCheck[]): "passed" | "unchecked" {
  return checks.some((check) => check.state === "ok") ? "passed" : "unchecked";
}

/** One problem as a sentence: "Tool search: Claude is loading every tool schema…". */
export function parityProblemText(check: PoolCheck): string {
  const detail = check.detail?.trim();
  if (detail) return `${check.label}: ${detail}`;
  return check.state === "fail"
    ? `${check.label} is off in pooled sessions.`
    : `${check.label} needs attention.`;
}

/** The label a row, menu or dialog uses for an account: its email, else its kind. */
export function accountLabel(account: PoolAccount): string {
  return account.email?.trim() || POOL_ACCOUNT_KIND[account.provider];
}

export type AccountNotice =
  | { readonly kind: "paused" }
  | { readonly kind: "cooling"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

/** The badge or warning an account row carries; null when it is simply ready. */
export function accountNotice(account: PoolAccount): AccountNotice | null {
  const message = account.message?.trim();
  switch (account.status) {
    case "ready":
      return null;
    case "disabled":
      return { kind: "paused" };
    case "cooling":
      return { kind: "cooling", text: message || "Cooling down" };
    case "error":
      return { kind: "error", text: message || "Needs attention" };
  }
}

/** Claude first, then Codex; server order within a provider, so rows never jump between polls. */
export function orderAccounts(accounts: readonly PoolAccount[]): PoolAccount[] {
  return POOL_PROVIDERS.flatMap((provider) =>
    accounts.filter((account) => account.provider === provider),
  );
}

/** Why a route set to Pool is not serving yet; null when it is active or set to Direct. */
export function routeWaitingReason(route: PoolRoute): string | null {
  if (route.mode !== "pool" || route.active) return null;
  return route.reason?.trim() || `Waiting for a ${POOL_ACCOUNT_KIND[route.provider]}`;
}

/**
 * The external server URL as typed, made absolute. A bare host gets `http://`
 * (pool servers usually sit on a LAN or tailnet); anything but http(s) is refused.
 */
export function normalizeExternalUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "") return null;
  return withScheme.replace(/\/+$/, "");
}

/**
 * True when the environment cannot serve the pool at all: a fork build without
 * it ("Unknown extension method") or an official T3 server with no extension
 * RPC ("Unknown request tag"). The section hides instead of showing an error.
 */
export function isPoolUnsupported(message: string): boolean {
  return /Unknown extension method pool\.|Unknown request tag/i.test(message);
}

/** Status poll cadence: quicker while a sign-in is waiting on the browser. */
export function statusPollDelay(loginPending: boolean): number {
  return loginPending ? 1_500 : 5_000;
}

/** The slug of a `customModels` entry (a bare string or `{ slug }`). */
function customModelSlug(model: unknown): string {
  if (typeof model === "string") return model;
  if (typeof model === "object" && model !== null && "slug" in model) {
    return String((model as { slug: unknown }).slug);
  }
  return "";
}

export interface InstanceEdit {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
}

/**
 * The pooled instance with one foreign custom model removed, in the shape the
 * Providers page writes (`buildProviderInstanceUpdatePatch`). The envelope is the
 * explicit instance, or for a default slot the one synthesized from its legacy
 * settings, exactly as the page builds its rows. Null when there is nothing to remove.
 */
export function withoutCustomModel(
  settings: Pick<ServerSettings, "providers" | "providerInstances">,
  issue: PoolModelIssue,
): InstanceEdit | null {
  if (issue.where !== "customModels") return null;
  const instanceId = ProviderInstanceId.make(issue.instanceId);
  const driver = poolProviderDriver(issue.provider);
  const isDefault = instanceId === defaultInstanceIdForDriver(driver);
  let instance: ProviderInstanceConfig | undefined = settings.providerInstances[instanceId];
  if (instance === undefined && isDefault) {
    const legacy = (settings.providers as Record<string, Record<string, unknown> | undefined>)[
      driver
    ];
    if (legacy !== undefined) {
      const { enabled, ...config } = legacy;
      instance = { driver, ...(typeof enabled === "boolean" ? { enabled } : {}), config };
    }
  }
  if (instance === undefined) return null;
  const config = (instance.config ?? {}) as Record<string, unknown>;
  const models = Array.isArray(config.customModels) ? config.customModels : [];
  const kept = models.filter((model: unknown) => customModelSlug(model) !== issue.slug);
  if (kept.length === models.length) return null;
  return {
    instanceId,
    instance: { ...instance, config: { ...config, customModels: kept } },
    driver,
    isDefault,
  };
}

/** Where to fix an alias the pool can't edit (it never writes the user's own files). */
export function modelIssueHint(issue: PoolModelIssue): string | null {
  if (issue.where === "claudeSettings") return "Edit ~/.claude/settings.json";
  if (issue.where === "instanceEnv") return `Edit ${issue.displayName}'s environment below`;
  return null;
}

export interface PoolStartFailure {
  /** One calm sentence for the checks line. */
  readonly text: string;
  /** The proxy's own words, for the hover and Details. */
  readonly technical: string;
  /** The proxy's log file, as the server reports it (never parsed from the message). */
  readonly logPath?: string;
}

/**
 * The local proxy failing to start, in words a teammate can act on:
 * "The pool couldn't start. Retrying in 30s." instead of a spawn error and paths.
 */
export function poolStartFailure(status: PoolStatus): PoolStartFailure | null {
  if (status.source !== "local" || status.runtime.state !== "error") return null;
  const technical = status.runtime.message?.trim() || "The pool stopped.";
  const retry = /Retrying in (\d+)s/.exec(technical)?.[1];
  const logPath = status.runtime.logPath;
  return {
    text: retry ? `The pool couldn't start. Retrying in ${retry}s.` : "The pool couldn't start.",
    technical,
    ...(logPath ? { logPath } : {}),
  };
}

/**
 * The last check run with the pool's live state on top. Checks can be minutes
 * old; a pool that has stopped since then fails here too, so the section never
 * reads "All checks passed" under "Can't start the pool".
 */
export function withLiveStartFailure(
  checks: readonly PoolCheck[],
  failure: PoolStartFailure | null,
): PoolCheck[] {
  if (!failure) return [...checks];
  const proxy: PoolCheck = { id: "proxy", label: "Pool", state: "fail", detail: failure.technical };
  return checks.some((check) => check.id === "proxy")
    ? checks.map((check) => (check.id === "proxy" ? proxy : check))
    : [proxy, ...checks];
}
