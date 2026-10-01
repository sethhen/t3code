/**
 * Pure helpers for "Sign your accounts in again" in Settings → Providers: the
 * accounts the retired pool held, each signed in again with its provider's own
 * sign-in. Row order, what each sign-in lands on, the waiting copy, the pasted
 * code check, and when a server has no such list at all.
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

const COMMAND: Readonly<Record<MoveProvider, string>> = { claude: "claude", codex: "codex" };

/** Claude before Codex, then by email: targets change as accounts sign in, so rows ignore them. */
export function orderMoveAccounts(accounts: readonly MoveAccount[]): MoveAccount[] {
  return accounts.toSorted(
    (a, b) =>
      PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider) ||
      a.email.localeCompare(b.email),
  );
}

/** The line under an account: where its sign-in lands. */
export function moveTargetHint(account: MoveAccount): string {
  return account.target === "default"
    ? `The first ${MOVE_PROVIDER_LABEL[account.provider]} account you sign in becomes your main one: existing threads and the ${COMMAND[account.provider]} command use it`
    : "Separate account";
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
 * True when the server cannot list the accounts at all: a fork build without
 * the pool extension ("Unknown extension method"), an official T3 server with
 * no extension RPC ("Unknown request tag"), or an older fork build whose pool
 * answers with its old shape ("Unexpected response"). The section steps aside.
 */
export function isMoveUnsupported(message: string): boolean {
  return /^Unexpected response|Unknown extension method pool\.|Unknown request tag/i.test(message);
}
