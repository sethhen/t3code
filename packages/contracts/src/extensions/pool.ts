/**
 * Accounts extension (id `pool`, kept from the account pool it replaced).
 * Every Claude and Codex account is a normal provider instance, signed in
 * with the provider's own CLI login (`claude auth login`, `codex login`); the
 * accounts themselves, their plans and quotas come from the provider
 * snapshots like any other instance. This extension only does what a client
 * can't: run those logins on the server and save the instance they produce,
 * sign an account in again or out when it is removed, and list the accounts
 * the retired pool held that are not signed in directly yet (the list shrinks
 * as they are signed in or skipped).
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
  /**
   * Stable per provider + email; also the id of the instance its sign-in
   * creates when it gets one of its own (not when it signs in a default home).
   */
  id: Schema.String,
  provider: MoveProvider,
  email: Schema.String,
  /** Plan label when the pool knew it, e.g. "ChatGPT Pro". */
  plan: Schema.optional(Schema.String),
});
export type MoveAccount = typeof MoveAccount.Type;

export const MoveStatus = Schema.Struct({
  accounts: Schema.Array(MoveAccount),
  /** Where a new account of each provider would land now. */
  addTarget: Schema.Struct({ claude: MoveTarget, codex: MoveTarget }),
  /** The sign-in running on this server, if any (one at a time). */
  signIn: Schema.optional(
    Schema.Struct({
      signInId: Schema.String,
      provider: MoveProvider,
      /** The listed account it signs in; absent when adding or re-signing an account. */
      accountId: Schema.optional(Schema.String),
      /** The instance it signs in again (`account.signIn`). */
      instanceId: Schema.optional(Schema.String),
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
   * yet, or when the account was signed in there already (the sign-in is then
   * `done` at once).
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
  /** `done`: the instance the account now is (`claudeAgent` / `codex` for a default home). */
  instanceId: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
export type MoveSignInState = typeof MoveSignInState.Type;

export const PoolExtension = defineExtension(POOL_EXTENSION_ID, {
  status: { input: Schema.Struct({}), output: MoveStatus },
  /**
   * Runs the provider's own sign-in for one listed account. Starting a
   * sign-in (this or `account.add`) cancels the one already running.
   */
  "signIn.start": { input: Schema.Struct({ accountId: Schema.String }), output: MoveSignInStart },
  /**
   * Runs the provider's own sign-in for a new account, whichever one the
   * browser signs in, and saves it as an instance (or the default home's
   * sign-in, while that has none). An account T3 has already is refused.
   */
  "account.add": { input: Schema.Struct({ provider: MoveProvider }), output: MoveSignInStart },
  /**
   * Signs a signed-out account instance in again, in its own config dir /
   * Codex home. Only the account it already is counts; another one is signed
   * out again. Not for default instances or managed Codex (T3's own sign-in).
   */
  "account.signIn": {
    input: Schema.Struct({ instanceId: Schema.String }),
    output: MoveSignInStart,
  },
  "signIn.status": { input: Schema.Struct({ signInId: Schema.String }), output: MoveSignInState },
  /** Claude's manual flow: the `code#state` text its sign-in page shows. */
  "signIn.code": {
    input: Schema.Struct({ signInId: Schema.String, code: Schema.String }),
    output: MoveSignInState,
  },
  "signIn.cancel": { input: Schema.Struct({ signInId: Schema.String }), output: MoveStatus },
  /**
   * Signs an account instance out (its CLI's own logout) and removes it from
   * T3. Default instances can't be removed; managed Codex instances are only
   * removed (T3 holds their sign-in).
   */
  "account.remove": { input: Schema.Struct({ instanceId: Schema.String }), output: MoveStatus },
  /** Drops a listed account without signing it in. */
  skip: { input: Schema.Struct({ accountId: Schema.String }), output: MoveStatus },
});
