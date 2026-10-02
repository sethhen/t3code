/**
 * Pure helpers for the sign-ins of the Accounts section in Settings →
 * Providers: a new account, or one the retired pool held, signed in with its
 * provider's own sign-in. Pending row order, the waiting copy, the pasted code
 * check, and when a server can't run sign-ins at all.
 */
import { type MoveAccount, type MoveProvider, ProviderDriverKind } from "@t3tools/contracts";

const PROVIDERS: readonly MoveProvider[] = ["claude", "codex"];

/** The T3 driver an account becomes an instance of, for its icon. */
export const MOVE_DRIVER: Readonly<Record<MoveProvider, ProviderDriverKind>> = {
  claude: ProviderDriverKind.make("claudeAgent"),
  codex: ProviderDriverKind.make("codex"),
};

/** The provider as the Providers list names it. */
export const MOVE_PROVIDER_LABEL: Readonly<Record<MoveProvider, string>> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * The line while a sign-in waits on the browser. Codex's CLI takes the sign-in
 * on a localhost port of the machine running T3, so only a browser there can
 * finish it.
 */
export const MOVE_WAITING_TEXT: Readonly<Record<MoveProvider, string>> = {
  claude: "Finish signing in to Claude in your browser.",
  codex: "Finish signing in to ChatGPT in the browser on the computer running T3.",
};

/** What the code box says when a pasted code fails `isWholeSignInCode`. */
export const PARTIAL_CODE_MESSAGE = "Paste the whole code, including the part after #.";

/** The line under an account the retired pool held. */
export const PENDING_HINT: Readonly<Record<MoveProvider, string>> = {
  claude: "Sign in again with Claude's own sign-in",
  codex: "Sign in again with Codex's own sign-in",
};

/** Claude before Codex, then by email. */
export function orderMoveAccounts(accounts: readonly MoveAccount[]): MoveAccount[] {
  return accounts.toSorted(
    (a, b) =>
      PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider) ||
      a.email.localeCompare(b.email),
  );
}

/**
 * Claude's CLI takes a pasted code only as `code#state` with both parts set
 * (anything after a second `#` is ignored); otherwise it keeps waiting.
 */
export function isWholeSignInCode(text: string): boolean {
  const [code, state] = text.trim().split("#");
  return Boolean(code && state);
}

/**
 * True when the server cannot run sign-ins at all: a fork build without the
 * pool extension ("Unknown extension method"), an official T3 server with no
 * extension RPC ("Unknown request tag"), or an older fork build whose pool
 * answers with its old shape ("Unexpected response"). The section then lists
 * the accounts from the provider snapshots only, and folds nothing away.
 */
export function isMoveUnsupported(message: string): boolean {
  return /^Unexpected response|Unknown extension method pool\.|Unknown request tag/i.test(message);
}
