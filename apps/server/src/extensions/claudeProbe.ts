/**
 * The fork's limits on the Claude provider's status probe and reset path,
 * used by `t3-ext` host edits in ClaudeProvider.ts and ClaudeDriver.ts.
 */

/**
 * Deadline for Claude Code's usage read in the capabilities probe. Upstream
 * gives it 4s, but the read takes ~3s per account and several accounts are
 * probed together, so it often missed and the account showed "Could not read
 * limits".
 */
export const CLAUDE_USAGE_TIMEOUT_MS = 20_000;

/**
 * Upstream reads and redeems Claude's banked resets by sending the account's
 * OAuth token to api.anthropic.com. T3 never reads or sends that token, so
 * ClaudeDriver doesn't wire that path; the Accounts section runs Claude Code's
 * own `/limit-reset` instead.
 */
export const CLAUDE_RESET_IN_ACCOUNTS = "Use the reset from Settings → Providers → Accounts.";
