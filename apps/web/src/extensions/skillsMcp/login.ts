/**
 * MCP OAuth sign-in in a real terminal. `claude mcp login` refuses to finish
 * without a TTY (it may ask the user to paste the redirect URL), so the panel
 * opens a right-panel terminal on the environment, runs the app's own login
 * command there, and re-probes when the panel is shown again. This mirrors the
 * onboarding wizard's provider login terminal.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  AgentApp,
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { randomUUID } from "~/lib/utils";
import { resolveOnboardingProviderLoginCommand } from "~/onboarding/providerReadiness.logic";
import { useRightPanelStore } from "~/rightPanelStore";
import { useServerConfigs } from "~/state/entities";
import { terminalEnvironment } from "~/state/terminal";
import { useAtomCommand } from "~/state/use-atom-command";

const DRIVER: Readonly<Record<AgentApp, "claudeAgent" | "codex">> = {
  claude: "claudeAgent",
  codex: "codex",
};

/** The provider login command's own suffix, replaced by `mcp login <name>`. */
const LOGIN_SUFFIX: Readonly<Record<AgentApp, string>> = {
  claude: " auth login",
  codex: " login",
};

const quoteArg = (value: string, platform: ExecutionEnvironmentPlatformOs) =>
  platform === "windows"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * `<binary> mcp login '<name>'`, reusing the quoted binary from T3's provider
 * login command so a custom binary path is honoured.
 */
export function mcpLoginCommand(
  providerLoginCommand: string,
  app: AgentApp,
  name: string,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  const suffix = LOGIN_SUFFIX[app];
  const binary = providerLoginCommand.endsWith(suffix)
    ? providerLoginCommand.slice(0, -suffix.length)
    : app;
  return `${binary} mcp login ${quoteArg(name, platform)}`;
}

let refreshPending = false;

/** True once after a login terminal was opened, so the next list re-probes. */
export function consumeLoginRefresh(): boolean {
  const pending = refreshPending;
  refreshPending = false;
  return pending;
}

export function useMcpLogin(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly cwd: string | null;
}): (name: string, app: AgentApp) => Promise<string | null> {
  const { environmentId, threadId, cwd } = input;
  const serverConfigs = useServerConfigs();
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });

  /** Resolves to an error message, or null once the terminal is running the command. */
  return useCallback(
    async (name, app) => {
      if (environmentId === null || threadId === null || cwd === null) {
        return "Open a project thread to sign in.";
      }
      const config = serverConfigs.get(environmentId);
      const providers = config?.providers.filter((provider) => provider.driver === DRIVER[app]);
      const provider =
        providers?.find((candidate) => candidate.instanceId === DRIVER[app]) ?? providers?.[0];
      if (!config || !provider) return `${app === "claude" ? "Claude" : "Codex"} is not set up.`;
      const platform = config.environment.platform.os;
      const command = mcpLoginCommand(
        resolveOnboardingProviderLoginCommand(provider, config.settings, platform),
        app,
        name,
        platform,
      );
      // The tab shows the terminal id while idle, so name it after the server.
      const slug = name.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40);
      const terminalId = `login-${slug}-${randomUUID().slice(0, 4)}`;
      const opened = await openTerminal({
        environmentId,
        input: { threadId, terminalId, cwd, providerInstanceId: provider.instanceId },
      });
      if (opened._tag !== "Success") return "Could not open a terminal.";
      const wrote = await writeTerminal({
        environmentId,
        input: { threadId, terminalId, data: `${command}\r` },
      });
      if (wrote._tag !== "Success") return "Could not start the sign-in command.";
      refreshPending = true;
      useRightPanelStore
        .getState()
        .openTerminal(scopeThreadRef(environmentId, threadId), terminalId);
      return null;
    },
    [cwd, environmentId, openTerminal, serverConfigs, threadId, writeTerminal],
  );
}
