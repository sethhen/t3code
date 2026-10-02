/**
 * Pure helpers for the Accounts section of Settings → Providers: the rows it
 * lists (every Claude and Codex instance, then the accounts the retired pool
 * left that still need a sign-in), their order and status tone, and when the
 * upstream sections folded under "More provider settings" open by themselves.
 */
import {
  defaultInstanceIdForDriver,
  type MoveAccount,
  type MoveProvider,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import { MOVE_DRIVER, MOVE_PROVIDER_LABEL, orderMoveAccounts } from "./move.logic";

/** Claude's group first, then Codex's. */
export const ACCOUNT_PROVIDERS: readonly MoveProvider[] = ["claude", "codex"];

/** What the user signs in with, per provider (Codex runs on a ChatGPT account). */
export const ACCOUNT_KIND: Readonly<Record<MoveProvider, string>> = {
  claude: "Claude account",
  codex: "ChatGPT account",
};

/** The hover on a default row's "Main" badge. */
export const MAIN_ACCOUNT_HINT: Readonly<Record<MoveProvider, string>> = {
  claude: "Existing threads and the claude command use it",
  codex: "Existing threads and the codex command use it",
};

type AccountSettings = Pick<ServerSettings, "providers" | "providerInstances">;
type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

/** Dot tones, keyed like `PROVIDER_STATUS_STYLES`. */
export type AccountTone = "ready" | "warning" | "error" | "disabled";

export interface AccountRow {
  readonly instanceId: ProviderInstanceId;
  readonly provider: MoveProvider;
  readonly driver: ProviderDriverKind;
  /** The envelope Pause/Resume writes back; a default slot's may be synthesized. */
  readonly instance: ProviderInstanceConfig;
  readonly isDefault: boolean;
  /** From settings, like the provider cards: a snapshot can lag a pause. */
  readonly enabled: boolean;
  readonly snapshot: ServerProvider | undefined;
  /** The signed-in email, else the instance's name. */
  readonly label: string;
}

/**
 * A default slot's envelope: its explicit instance, else one synthesized from
 * the legacy provider settings exactly as the Providers page builds it (the
 * legacy `enabled` moves to the envelope). Undefined when a server's settings
 * predate the driver.
 */
export function defaultInstanceEnvelope(
  settings: AccountSettings,
  driver: ProviderDriverKind,
): ProviderInstanceConfig | undefined {
  const explicit = settings.providerInstances[defaultInstanceIdForDriver(driver)];
  if (explicit !== undefined) return explicit;
  const legacy = (settings.providers as Record<string, LegacyProviderSettings | undefined>)[driver];
  if (legacy === undefined) return undefined;
  const { enabled, ...config } = legacy;
  return { driver, ...(typeof enabled === "boolean" ? { enabled } : {}), config };
}

/**
 * Every Claude and Codex instance joined to its live snapshot: Claude's
 * first, each provider's default instance first, then by label.
 */
export function buildAccountRows(
  settings: AccountSettings,
  providers: readonly ServerProvider[],
): AccountRow[] {
  const snapshots = new Map(providers.map((provider) => [provider.instanceId, provider]));
  return ACCOUNT_PROVIDERS.flatMap((provider) => {
    const driver = MOVE_DRIVER[provider];
    const defaultId = defaultInstanceIdForDriver(driver);
    const entries: Array<readonly [ProviderInstanceId, ProviderInstanceConfig]> = [];
    const envelope = defaultInstanceEnvelope(settings, driver);
    if (envelope !== undefined) entries.push([defaultId, envelope]);
    for (const [id, instance] of Object.entries(settings.providerInstances)) {
      if (instance.driver === driver && id !== defaultId) {
        entries.push([ProviderInstanceId.make(id), instance]);
      }
    }
    const rows = entries.map(([instanceId, instance]): AccountRow => {
      const snapshot = snapshots.get(instanceId);
      return {
        instanceId,
        provider,
        driver,
        instance,
        isDefault: instanceId === defaultId,
        enabled: resolveProviderInstanceEnabled(instance),
        snapshot,
        label:
          snapshot?.auth.email?.trim() ||
          instance.displayName?.trim() ||
          snapshot?.displayName ||
          MOVE_PROVIDER_LABEL[provider],
      };
    });
    return rows.toSorted(
      (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label),
    );
  });
}

/**
 * The row's status dot, as the provider cards pick it: a paused instance is
 * `disabled` whatever its last snapshot says, an unprobed one `warning`.
 * Unknown states from a newer server read as `warning` rather than missing a style.
 */
export function accountTone(row: Pick<AccountRow, "enabled" | "snapshot">): AccountTone {
  if (!row.enabled) return "disabled";
  const status = row.snapshot?.status;
  return status === "ready" || status === "error" || status === "disabled" ? status : "warning";
}

/**
 * The time quota bars and countdowns are drawn at: the newest usage read among
 * the rows, or when the page opened if that is later. It moves when snapshots
 * arrive, never on a timer, and matches the server clock the reads came from.
 */
export function limitsClock(rows: readonly AccountRow[], openedAt: number): number {
  return rows.reduce((latest, row) => {
    const checkedAt = Date.parse(row.snapshot?.usageLimits?.checkedAt ?? "");
    return Number.isFinite(checkedAt) ? Math.max(latest, checkedAt) : latest;
  }, openedAt);
}

/** A trimmed string field of an instance's driver config (typed `unknown`), else "". */
function configText(config: unknown, key: string): string {
  if (config === null || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

/** A Codex instance set up as managed: T3 holds its sign-in (upstream's `readCodexSetupMode`). */
export function isManagedCodex(row: Pick<AccountRow, "provider" | "instance">): boolean {
  return row.provider === "codex" && configText(row.instance.config, "setupMode") === "managed";
}

/**
 * Whether the server can sign this account in or out on its own: `own` when
 * it has a sign-in of its own (a Claude config dir, from `homePath` or
 * `CLAUDE_CONFIG_DIR` in its environment; a Codex home or shadow home),
 * `managed` for a managed Codex instance (T3 holds its sign-in, so it is only
 * removed), null for a default instance or one sharing the default's sign-in.
 */
export function accountSignIn(
  row: Pick<AccountRow, "provider" | "instance" | "isDefault">,
): "own" | "managed" | null {
  if (row.isDefault) return null;
  const { config, environment } = row.instance;
  if (row.provider === "claude") {
    const configDir = environment?.some(
      (variable) =>
        variable.name === "CLAUDE_CONFIG_DIR" &&
        (variable.valueRedacted === true || variable.value.trim() !== ""),
    );
    return configText(config, "homePath") !== "" || configDir ? "own" : null;
  }
  if (isManagedCodex(row)) return "managed";
  return configText(config, "homePath") !== "" || configText(config, "shadowHomePath") !== ""
    ? "own"
    : null;
}

/** The confirmation Remove asks, for a row `accountSignIn` allows it on. */
export function removeQuestion(row: Pick<AccountRow, "label">, signIn: "own" | "managed"): string {
  const what = signIn === "managed" ? "T3 stops using it." : "T3 signs it out and stops using it.";
  return `Remove ${row.label}? ${what} Its threads stay in your history.`;
}

function sameEmail(a: string | undefined, b: string): boolean {
  return a !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The listed accounts still worth a Sign in row, in order: not an instance
 * already (a listed account's id is the id of the instance it becomes) and
 * not an account a row of its provider already is (signed in, or named after it).
 */
export function visiblePendingAccounts(
  accounts: readonly MoveAccount[],
  settings: Pick<ServerSettings, "providerInstances">,
  rows: readonly AccountRow[],
): MoveAccount[] {
  return orderMoveAccounts(accounts).filter((account) => {
    if (Object.hasOwn(settings.providerInstances, account.id)) return false;
    return !rows.some(
      (row) =>
        row.provider === account.provider &&
        (sameEmail(row.snapshot?.auth.email, account.email) ||
          sameEmail(row.instance.displayName, account.email)),
    );
  });
}

/**
 * Why the upstream sections should be open right now: the page was opened on
 * an instance, a settings search jumps into them, or a provider has an update
 * to run. Each reason is a stable string, so it opens the fold once. Updates
 * count per driver, so pausing, resuming or adding another instance of a
 * driver that has one doesn't reopen a fold the user closed.
 */
export function foldReasons(input: {
  readonly targetInstanceId: string | undefined;
  readonly searchTargetId: string | null;
  /** Settings search ids that live in the upstream sections. */
  readonly upstreamSearchIds: ReadonlySet<string>;
  /** Drivers with an update the provider list offers to run (one per instance is fine). */
  readonly updateDrivers: readonly string[];
}): string[] {
  const reasons: string[] = [];
  if (input.targetInstanceId !== undefined) reasons.push(`instance:${input.targetInstanceId}`);
  if (input.searchTargetId !== null && input.upstreamSearchIds.has(input.searchTargetId)) {
    reasons.push(`search:${input.searchTargetId}`);
  }
  for (const driver of [...new Set(input.updateDrivers)].toSorted()) {
    reasons.push(`update:${driver}`);
  }
  return reasons;
}

export interface FoldState {
  readonly open: boolean;
  /** The reasons seen last time; only a new one opens the fold again. */
  readonly reasons: readonly string[];
}

/**
 * The fold after this render's reasons: open when one is new, otherwise as the
 * user left it. A reason that went away is forgotten, so the same search later
 * opens it again. Returns `state` itself when nothing changed.
 */
export function foldFor(state: FoldState, reasons: readonly string[]): FoldState {
  const fresh = reasons.some((reason) => !state.reasons.includes(reason));
  if (!fresh && reasons.length === state.reasons.length) return state;
  return { open: state.open || fresh, reasons };
}
