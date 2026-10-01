/**
 * The local proxy's `config.yaml`, rewritten from pool state on every start.
 * CLIProxyAPI replaces the management secret with its bcrypt hash in place,
 * so the plaintext lives only in pool state and is written again each time.
 *
 * The routing block is what keeps a pooled session native (verified against
 * direct Claude Code, see FORK.md "Pool"):
 * - `session-affinity`: a conversation stays on one account, so its prompt
 *   cache is reused instead of re-written on every turn.
 * - `session-affinity-subagents: false`: Claude Code subagents send their
 *   parent's session id; without this a whole thread and all its subagents
 *   pile onto one account. With it each subagent binds to its own account.
 * - Failover is built in: a bound account that becomes unavailable is
 *   re-selected on the next request.
 */
export interface PoolProxyConfigInput {
  readonly port: number;
  readonly authDir: string;
  readonly clientKey: string;
  readonly managementKey: string;
}

/** JSON strings are valid YAML scalars, which covers paths with spaces and backslashes. */
const yamlString = (value: string) => JSON.stringify(value);

export const renderProxyConfig = (input: PoolProxyConfigInput): string =>
  [
    "# Written by T3 Code's pool on every start; edits here are overwritten.",
    "host: 127.0.0.1",
    `port: ${input.port}`,
    `auth-dir: ${yamlString(input.authDir)}`,
    "api-keys:",
    `  - ${yamlString(input.clientKey)}`,
    "remote-management:",
    "  allow-remote: false",
    `  secret-key: ${yamlString(input.managementKey)}`,
    "  disable-control-panel: true",
    "routing:",
    "  strategy: round-robin",
    "  session-affinity: true",
    "  session-affinity-subagents: false",
    "request-retry: 3",
    "usage-statistics-enabled: true",
    "logging-to-file: false",
    "debug: false",
    "",
  ].join("\n");
