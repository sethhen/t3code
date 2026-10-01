/**
 * Pool extension, retired. The fork used to route Claude and Codex through a
 * local CLIProxyAPI that held several subscription sign-ins. That is gone:
 * the server stops and deletes the proxy at startup and keeps only the list
 * of accounts it held (provider + email). Settings → Providers then signs
 * each one in directly, with Claude Code's and Codex's own `login` commands,
 * as a normal provider instance. The list shrinks as accounts are signed in
 * or skipped, and the section disappears once it is empty.
 */
import * as Schema from "effect/Schema";

import { defineExtension } from "./host.ts";

export const POOL_EXTENSION_ID = "pool";

export const MoveProvider = Schema.Literals(["claude", "codex"]);
export type MoveProvider = typeof MoveProvider.Type;

/**
 * Where a sign-in lands. `default` is the provider's default instance
 * (`~/.claude` / `~/.codex`), which existing threads and the bare CLI use;
 * it is the target while that home has no subscription sign-in. Every other
 * account becomes its own instance.
 */
export const MoveTarget = Schema.Literals(["default", "instance"]);
export type MoveTarget = typeof MoveTarget.Type;

/** One account the pool held that is not signed in directly yet. */
export const MoveAccount = Schema.Struct({
  /** Stable per provider + email. */
  id: Schema.String,
  provider: MoveProvider,
  email: Schema.String,
  /** Plan label when the pool knew it, e.g. "ChatGPT Pro". */
  plan: Schema.optional(Schema.String),
  target: MoveTarget,
});
export type MoveAccount = typeof MoveAccount.Type;

export const MoveStatus = Schema.Struct({
  accounts: Schema.Array(MoveAccount),
  /** The sign-in running on this server, if any (one at a time). */
  signIn: Schema.optional(
    Schema.Struct({
      signInId: Schema.String,
      accountId: Schema.String,
    }),
  ),
});
export type MoveStatus = typeof MoveStatus.Type;

export const MoveSignInStart = Schema.Struct({
  signInId: Schema.String,
  /**
   * The provider's sign-in page, for when its CLI could not open the browser.
   * Only Claude's works from another device (its page shows a code to paste
   * back); Codex's sign-in finishes only in a browser on the server's machine
   * (its callback is that machine's localhost). Absent if the CLI printed none
   * yet.
   */
  url: Schema.optional(Schema.String),
  /** The CLI accepts a pasted code (Claude's manual flow). */
  acceptsCode: Schema.Boolean,
});
export type MoveSignInStart = typeof MoveSignInStart.Type;

export const MoveSignInState = Schema.Struct({
  state: Schema.Literals(["waiting", "done", "error"]),
  /** Set once the CLI printed its sign-in page. */
  url: Schema.optional(Schema.String),
  acceptsCode: Schema.Boolean,
  /** The account that actually signed in (`done`, or an `error` for the wrong account). */
  email: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
export type MoveSignInState = typeof MoveSignInState.Type;

export const PoolExtension = defineExtension(POOL_EXTENSION_ID, {
  status: { input: Schema.Struct({}), output: MoveStatus },
  /**
   * Runs the provider's own sign-in for one account. Starting another
   * cancels the one already running.
   */
  "signIn.start": { input: Schema.Struct({ accountId: Schema.String }), output: MoveSignInStart },
  "signIn.status": { input: Schema.Struct({ signInId: Schema.String }), output: MoveSignInState },
  /** Claude's manual flow: the `code#state` text its sign-in page shows. */
  "signIn.code": {
    input: Schema.Struct({ signInId: Schema.String, code: Schema.String }),
    output: MoveSignInState,
  },
  "signIn.cancel": { input: Schema.Struct({ signInId: Schema.String }), output: MoveStatus },
  /** Drops an account from the list without signing it in. */
  skip: { input: Schema.Struct({ accountId: Schema.String }), output: MoveStatus },
});
