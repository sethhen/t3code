import { describe, expect, it } from "vite-plus/test";

import { mcpLoginCommand } from "./login";

describe("mcpLoginCommand", () => {
  it("swaps the provider login suffix for mcp login, keeping the quoted binary", () => {
    expect(mcpLoginCommand("claude auth login", "claude", "plugin:vercel:vercel", "darwin")).toBe(
      "claude mcp login 'plugin:vercel:vercel'",
    );
    expect(mcpLoginCommand("'/opt/my tools/codex' login", "codex", "sentry", "linux")).toBe(
      "'/opt/my tools/codex' mcp login 'sentry'",
    );
  });

  it("quotes names safely for each shell", () => {
    expect(mcpLoginCommand("claude auth login", "claude", "it's", "darwin")).toBe(
      `claude mcp login 'it'"'"'s'`,
    );
    expect(mcpLoginCommand("claude auth login", "claude", "it's", "windows")).toBe(
      "claude mcp login 'it''s'",
    );
  });

  it("falls back to the bare CLI when the provider command has an unexpected shape", () => {
    expect(mcpLoginCommand("something else", "codex", "x", "darwin")).toBe("codex mcp login 'x'");
  });
});
