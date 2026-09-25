import { SKILLS_MCP_EXTENSION_ID } from "@t3tools/contracts";
import { Blocks } from "lucide-react";
import { lazy } from "react";

import type { RightPanelExtension } from "../registry";

export const skillsMcpExtension: RightPanelExtension = {
  id: SKILLS_MCP_EXTENSION_ID,
  label: "Skills & MCP",
  icon: Blocks,
  shortcut: "S",
  Panel: lazy(() => import("./SkillsMcpPanel")),
};
