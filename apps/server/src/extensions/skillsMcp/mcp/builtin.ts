/**
 * The read-only row for T3's own `t3-code` MCP server. T3 attaches it to each
 * provider session itself (it is in neither app's config), with the pull
 * request tools always and the preview/device tools when the matching agent
 * access setting is on.
 */
import type { McpAppEntry, McpServerRow, McpToolInfo } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Tool from "effect/unstable/ai/Tool";
import type * as Toolkit from "effect/unstable/ai/Toolkit";

import { DeviceToolkit, PreviewToolkit, PullRequestsToolkit } from "./t3.ts";

export const BUILTIN_SERVER_NAME = "t3-code";

const toolInfos = (toolkit: Toolkit.Any): ReadonlyArray<McpToolInfo> =>
  Object.values(toolkit.tools).map((tool) => {
    const description = Tool.getDescription(tool);
    return {
      name: tool.name,
      ...(description ? { description } : {}),
      readOnly: Context.get(tool.annotations, Tool.Readonly),
      destructive: Context.get(tool.annotations, Tool.Destructive),
      openWorld: Context.get(tool.annotations, Tool.OpenWorld),
    };
  });

export interface BuiltinAccess {
  /** `settings.enableAgentBrowserAccess`: adds the preview (browser) tools. */
  readonly browser: boolean;
  /** `settings.enableAgentDeviceAccess`: adds the simulator/emulator tools. */
  readonly device: boolean;
}

/** The `t3-code` row for the global agent-access settings (project overrides may differ). */
export const builtinRow = (access: BuiltinAccess): McpServerRow => {
  const tools = [
    ...toolInfos(PullRequestsToolkit),
    ...(access.browser ? toolInfos(PreviewToolkit) : []),
    ...(access.device ? toolInfos(DeviceToolkit) : []),
  ];
  const entry: McpAppEntry = {
    present: true,
    enabled: true,
    scope: "builtin",
    source: "T3 Code",
    status: "connected",
    tools,
    editable: false,
  };
  return {
    key: `builtin:${BUILTIN_SERVER_NAME}`,
    name: BUILTIN_SERVER_NAME,
    managed: false,
    builtin: true,
    description:
      "T3 Code's own tools, attached to every thread session. Browser and device tools follow the Agent access settings; a project override can change them for that project.",
    tags: [],
    apps: { claude: entry, codex: entry },
  };
};
