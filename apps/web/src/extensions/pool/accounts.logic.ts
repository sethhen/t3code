/**
 * Pure helpers for the Accounts section of Settings → Providers: the rows it
 * lists (every Claude and Codex instance, then the accounts the retired pool
 * left that still need a sign-in), their order and status tone, when the
 * upstream sections folded under "More provider settings" open by themselves,
 * and each account's model training line and session limit reset.
 */
import {
  type ClaudeAccountPrivacy,
  defaultInstanceIdForDriver,
  type MoveAccount,
  type MoveProvider,
  type PrivacyStatus,
  type PrivacyTask,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";

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

/** Names a row's account for screen readers (the email on screen may be blurred). */
export function accountWho(row: Pick<AccountRow, "provider" | "label">): string {
  return `${MOVE_PROVIDER_LABEL[row.provider]} account ${row.label}`;
}

/** The confirmation Remove asks, for a row `accountSignIn` allows it on. */
export function removeQuestion(row: Pick<AccountRow, "label">, signIn: "own" | "managed"): string {
  const what = signIn === "managed" ? "T3 stops using it." : "T3 signs it out and stops using it.";
  return `Remove ${row.label}? ${what} Its threads stay in your history.`;
}

/** Where each provider keeps its model training setting. T3 changes Claude's only through Claude Code. */
export const PRIVACY_LINKS = {
  claude: "https://claude.ai/settings/data-privacy-controls",
  chatgptDataControls: "https://chatgpt.com/#settings/DataControls",
  openaiPrivacyPortal: "https://privacy.openai.com/",
} as const;

/** The line under "Keep model training off". */
export const KEEP_TRAINING_OFF_HINT =
  "T3 checks your Claude accounts daily with Claude Code's own privacy setting and turns training off, and turns off Codex /feedback and Claude's /bug and feedback survey. ChatGPT doesn't let apps change its setting: use the links on each Codex account. Changing this restarts running Claude and Codex sessions.";

/** The confirmation flipping "Keep model training off" asks, for the value it flips to. */
export function keepOffQuestion(enabled: boolean): string {
  return enabled
    ? "Turn on Keep model training off? Running Claude and Codex agents stop now (send again to continue). T3 then checks your Claude accounts daily and turns training off, and turns off Codex /feedback and Claude's /bug and feedback survey."
    : "Turn off Keep model training off? Running Claude and Codex agents stop now (send again to continue).";
}

/** The confirmation "Use session reset" asks, with the session quota left when the row knows it. */
export function resetQuestion(row: Pick<AccountRow, "label" | "snapshot">): string {
  const session = row.snapshot?.usageLimits?.windows.find((window) => window.kind === "session");
  const left = session ? ` Session: ${remainingPercent(session)}% left.` : "";
  return `Use ${row.label}'s session limit reset now? Claude Code uses it right away, even if this account isn't at a limit yet, and it can't be undone. Usage still counts toward the weekly limit.${left}`;
}

export type PrivacyBusy = NonNullable<PrivacyStatus["busy"]>;

export interface ClaudePrivacyView {
  readonly entry: ClaudeAccountPrivacy | undefined;
  /** "Off", "On", "Not checked yet", "Unknown" (a check that couldn't read it), or the change running. */
  readonly training: string;
  /** This account's task, while it runs. */
  readonly running: PrivacyTask | null;
  /** Turn off is offered only while Claude Code last showed training on. */
  readonly showTurnOff: boolean;
  /**
   * Check, Turn off and Use session reset wait: Claude Code runs one task at a
   * time per server, and one this page asked for may not show as busy yet.
   */
  readonly blocked: boolean;
}

/** A Claude account's model training line and which of its actions can run now. */
export function claudePrivacyView(
  privacy: PrivacyStatus,
  instanceId: string,
  /** The account whose task start is waiting for the server's answer, if any. */
  starting: string | null,
): ClaudePrivacyView {
  const entry = privacy.claude.find((candidate) => candidate.instanceId === instanceId);
  const running = privacy.busy?.instanceId === instanceId ? privacy.busy.task : null;
  const training =
    running === "check"
      ? "Checking…"
      : running === "turnOff"
        ? "Turning off…"
        : entry?.training === "off"
          ? "Off"
          : entry?.training === "on"
            ? "On"
            : entry?.message
              ? "Unknown"
              : "Not checked yet";
  return {
    entry,
    training,
    running,
    showTurnOff: entry?.training === "on" && running === null,
    blocked: privacy.busy !== undefined || starting !== null,
  };
}

/**
 * When the user said they turned a Codex account's training off in ChatGPT,
 * by its signed-in email; undefined when they didn't (or the email is unknown).
 */
export function codexMarkedOffAt(
  privacy: PrivacyStatus,
  email: string | undefined,
): string | undefined {
  const key = email?.trim().toLowerCase();
  return key ? privacy.codexMarkedOff[key] : undefined;
}

/** The running task as first seen, with its account's entry from then. */
export interface SeenPrivacyTask {
  readonly busy: PrivacyBusy;
  readonly before: ClaudeAccountPrivacy | undefined;
}

export interface EndedPrivacyTask extends SeenPrivacyTask {
  readonly after: ClaudeAccountPrivacy | undefined;
}

/**
 * Follows the server's one task across status reads. `seen` is the task
 * running now; `ended` is the one seen before once it is gone (cleared, or
 * another task took its place between two reads), with its entry now. A check
 * the server turns into a turnOff on the same account (it read "on" while
 * training is kept off) stays one task, from the entry before the check.
 */
export function followPrivacyTask(
  seen: SeenPrivacyTask | null,
  privacy: PrivacyStatus,
): { readonly seen: SeenPrivacyTask | null; readonly ended: EndedPrivacyTask | null } {
  const entryOf = (instanceId: string) =>
    privacy.claude.find((candidate) => candidate.instanceId === instanceId);
  const { busy } = privacy;
  if (seen !== null && busy !== undefined && busy.instanceId === seen.busy.instanceId) {
    if (busy.task === seen.busy.task) return { seen, ended: null };
    if (seen.busy.task === "check" && busy.task === "turnOff") {
      return { seen: { busy, before: seen.before }, ended: null };
    }
  }
  return {
    seen: busy === undefined ? null : { busy, before: entryOf(busy.instanceId) },
    ended: seen === null ? null : { ...seen, after: entryOf(seen.busy.instanceId) },
  };
}

export interface PrivacyOutcome {
  readonly type: "success" | "info" | "warning" | "error";
  readonly title: string;
  readonly description?: string;
}

type ResetResult = NonNullable<ClaudeAccountPrivacy["reset"]>;

/** A session limit reset's result on its account's row, after "Session reset 5m ago: ". */
export function resetLine(reset: ResetResult): string {
  switch (reset.outcome) {
    case "used":
      return "the session limit was reset.";
    case "notUsed":
      return reset.message;
    case "unknown":
      return `T3 couldn't tell whether it was used. ${reset.message}`;
  }
}

/**
 * What a finished task did, from its account's entry before and after: a
 * check or change counts only if it read the setting again (`checkedAt`
 * moved), a reset only if it left a new result (`reset.at` moved). Otherwise
 * the entry's message says why it didn't finish. No entry after means the
 * account was removed while Claude Code ran.
 */
export function privacyOutcome(task: EndedPrivacyTask, label: string): PrivacyOutcome {
  const { before, after } = task;
  if (after === undefined) {
    const reset = task.busy.task === "reset";
    return {
      type: reset ? "warning" : "info",
      title: `${label} was removed before Claude Code finished`,
      ...(reset ? { description: "Its reset may have been used." } : {}),
    };
  }
  const message = after.message;
  if (task.busy.task === "reset") {
    const reset = after.reset;
    if (reset !== undefined && reset.at !== before?.reset?.at) {
      switch (reset.outcome) {
        case "used":
          return { type: "success", title: `${label}'s session limit was reset` };
        case "notUsed":
          return {
            type: "info",
            title: `${label}'s session limit reset wasn't used`,
            description: reset.message,
          };
        case "unknown":
          return {
            type: "warning",
            title: `T3 couldn't tell whether ${label}'s reset was used`,
            description: reset.message,
          };
      }
    }
    return {
      type: "error",
      title: `Could not use ${label}'s session limit reset`,
      description: message ?? "Claude Code didn't finish.",
    };
  }
  const turningOff = task.busy.task === "turnOff";
  const read = after.checkedAt !== undefined && after.checkedAt !== before?.checkedAt;
  if (read && after.training === "off") {
    return {
      type: "success",
      title: `Model training is ${turningOff ? "now " : ""}off for ${label}`,
      ...(message ? { description: message } : {}),
    };
  }
  if (read && after.training === "on") {
    return turningOff
      ? {
          type: "error",
          title: `Model training is still on for ${label}`,
          description: message ?? "Claude Code still shows it on.",
        }
      : {
          type: "warning",
          title: `Model training is on for ${label}`,
          ...(message ? { description: message } : {}),
        };
  }
  return {
    type: "error",
    title: turningOff
      ? `Could not turn off model training for ${label}`
      : `Could not check model training for ${label}`,
    description: message ?? "Claude Code didn't show the setting.",
  };
}

/**
 * Whether a finished task gets a toast. One this page started always does.
 * One it didn't (the daily sweep, another device) only when it turned
 * training off, read a different setting than before, or failed: a sweep
 * that finds training still off stays quiet, and so does a removed account.
 */
export function announcesPrivacyTask(
  task: EndedPrivacyTask,
  outcome: PrivacyOutcome,
  startedHere: boolean,
): boolean {
  if (startedHere) return true;
  const { before, after } = task;
  if (after === undefined) return false;
  if (outcome.type === "error" || task.busy.task === "turnOff") return true;
  if (task.busy.task === "reset") return false;
  const read = after.checkedAt !== undefined && after.checkedAt !== before?.checkedAt;
  return read && after.training !== (before?.training ?? "unknown");
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
