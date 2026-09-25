/**
 * One-click MCP server presets for the add-server form.
 *
 * Ported from CC Switch `src/config/mcpPresets.ts`
 * (https://github.com/farion1231/cc-switch), MIT License,
 * Copyright (c) 2025 Jason Young. Descriptions are CC Switch's English copy.
 */
import type { McpPreset, McpServerSpec } from "@t3tools/contracts";

const REFERENCE_SERVERS = "https://github.com/modelcontextprotocol/servers";

/** `npx -y <pkg>`; Windows needs `cmd /c` because npx is a batch shim there. */
const npx = (pkg: string, platform: NodeJS.Platform): McpServerSpec =>
  platform === "win32"
    ? { type: "stdio", command: "cmd", args: ["/c", "npx", "-y", pkg] }
    : { type: "stdio", command: "npx", args: ["-y", pkg] };

/** The presets for a host platform (read it from `HostProcessPlatform`). */
export const makeMcpPresets = (platform: NodeJS.Platform): ReadonlyArray<McpPreset> => [
  {
    id: "fetch",
    name: "fetch",
    description:
      "Universal HTTP request tool, supports GET/POST and other HTTP methods, suitable for quick API requests and web data scraping",
    homepage: REFERENCE_SERVERS,
    tags: ["stdio", "http", "web"],
    spec: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
  },
  {
    id: "time",
    name: "time",
    description:
      "Time query tool providing current time, timezone conversion, and date calculation features",
    homepage: REFERENCE_SERVERS,
    tags: ["stdio", "time", "utility"],
    spec: npx("@modelcontextprotocol/server-time", platform),
  },
  {
    id: "memory",
    name: "memory",
    description:
      "Knowledge graph memory system supporting entities, relations, and observations to help AI remember important information from conversations",
    homepage: REFERENCE_SERVERS,
    tags: ["stdio", "memory", "graph"],
    spec: npx("@modelcontextprotocol/server-memory", platform),
  },
  {
    id: "sequential-thinking",
    name: "sequential-thinking",
    description:
      "Sequential thinking tool helping AI break down complex problems into multiple steps for deeper thinking",
    homepage: REFERENCE_SERVERS,
    tags: ["stdio", "thinking", "reasoning"],
    spec: npx("@modelcontextprotocol/server-sequential-thinking", platform),
  },
  {
    id: "context7",
    name: "context7",
    description:
      "Context7 documentation search tool providing latest library docs and code examples, with higher limits when configured with a key",
    homepage: "https://context7.com",
    tags: ["stdio", "docs", "search"],
    spec: npx("@upstash/context7-mcp", platform),
  },
];
