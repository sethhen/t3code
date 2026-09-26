import type {
  McpAppEntry,
  McpServerRow,
  PluginRow,
  SkillAppEntry,
  SkillRow,
} from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  appUnavailableReason,
  capToolGroups,
  contributionSummary,
  groupTools,
  mcpAppSwitch,
  mcpIssues,
  mcpOrigin,
  mcpPrimaryAction,
  mcpRowTone,
  mcpStatusLabel,
  sectionMcpServers,
  sectionPlugins,
  sectionSkills,
  skillAppSwitch,
  skillOrigin,
} from "./lists.logic";

function entry(patch: Partial<McpAppEntry> = {}): McpAppEntry {
  return {
    present: true,
    enabled: true,
    scope: "user",
    status: "connected",
    editable: true,
    ...patch,
  };
}

function server(name: string, patch: Partial<McpServerRow> = {}): McpServerRow {
  return {
    key: name,
    name,
    managed: false,
    builtin: false,
    tags: [],
    apps: { claude: entry() },
    ...patch,
  };
}

function skillEntry(patch: Partial<SkillAppEntry> = {}): SkillAppEntry {
  return { present: true, enabled: true, scope: "user", editable: false, ...patch };
}

function skill(name: string, patch: Partial<SkillRow> = {}): SkillRow {
  return { key: name, name, managed: false, apps: { claude: skillEntry() }, ...patch };
}

function plugin(name: string, patch: Partial<PluginRow> = {}): PluginRow {
  return {
    app: "claude",
    id: `${name}@market`,
    name,
    marketplace: "market",
    installed: true,
    enabled: true,
    contributes: { skills: [], mcpServers: [], commands: [], agents: [] },
    ...patch,
  };
}

const names = (rows: readonly { readonly name: string }[]) => rows.map((row) => row.name);

describe("MCP sections", () => {
  const gmail = server("claude.ai Gmail", {
    apps: { claude: entry({ scope: "connector", source: "claude.ai", status: "needs-auth" }) },
  });
  const vercel = server("plugin:vercel:vercel", {
    apps: { claude: entry({ scope: "plugin", source: "vercel" }) },
  });
  const broken = server("broken", {
    managed: true,
    id: "broken",
    apps: { claude: entry({ status: "failed" }), codex: entry() },
  });
  const t3 = server("t3-code", { builtin: true, apps: { claude: entry({ scope: "builtin" }) } });

  // What the ChatGPT desktop app registers in both configs (claude 2.1.283, codex 0.157.1).
  const nodeRepl = server("node_repl", {
    managed: true,
    id: "n1",
    spec: {
      type: "stdio",
      command: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
    },
    apps: { claude: entry(), codex: entry() },
  });

  it("keeps the user's servers apart from the project's and what came with an app", () => {
    const sections = sectionMcpServers([
      gmail,
      server("mixpanel"),
      vercel,
      broken,
      nodeRepl,
      t3,
      server("xcodebuildmcp", { apps: { claude: entry({ scope: "project" }) } }),
    ]);
    assert.deepEqual(names(sections.attention), ["broken"]);
    assert.deepEqual(names(sections.yours), ["mixpanel"]);
    assert.deepEqual(names(sections.project), ["xcodebuildmcp"]);
    // A built-in server that needs sign-in stays folded away with the rest.
    assert.deepEqual(names(sections.builtIn), [
      "t3-code",
      "claude.ai Gmail",
      "node_repl",
      "plugin:vercel:vercel",
    ]);
  });

  it("labels where a server comes from", () => {
    assert.equal(mcpOrigin(t3), "T3");
    assert.equal(mcpOrigin(gmail), "claude.ai");
    assert.equal(mcpOrigin(vercel), "vercel");
    assert.equal(mcpOrigin(nodeRepl), "ChatGPT app");
    assert.isNull(mcpOrigin(server("mixpanel")));
  });
});

describe("MCP switches", () => {
  it("gives every Claude server a switch, the store's for user servers", () => {
    const stored = server("trigger", {
      managed: true,
      id: "t1",
      apps: { claude: entry(), codex: entry() },
    });
    assert.deepEqual(mcpAppSwitch(stored, "claude"), { kind: "store", id: "t1" });
    assert.deepEqual(mcpAppSwitch(stored, "codex"), { kind: "store", id: "t1" });
    const connector = server("claude.ai Gmail", {
      apps: { claude: entry({ scope: "connector", enabled: false, status: "disabled" }) },
    });
    assert.deepEqual(mcpAppSwitch(connector, "claude"), { kind: "claude" });
    assert.isNull(mcpAppSwitch(connector, "codex"));
  });

  it("locks what T3 cannot switch, and says where to switch it instead", () => {
    const t3 = server("t3-code", { builtin: true, apps: { claude: entry(), codex: entry() } });
    assert.equal(mcpAppSwitch(t3, "codex")?.kind, "locked");
    const codexPlugin = server("cua_repl", {
      apps: { codex: entry({ scope: "plugin", source: "unified-computer-use@openai-bundled" }) },
    });
    assert.deepEqual(mcpAppSwitch(codexPlugin, "codex"), {
      kind: "locked",
      reason: "Comes with the unified-computer-use plugin. Switch the plugin off in Plugins.",
    });
    const sse = server("s", {
      managed: true,
      id: "s",
      spec: { type: "sse", url: "https://s.dev" },
      apps: { claude: entry(), codex: entry() },
    });
    assert.equal(mcpAppSwitch(sse, "codex")?.kind, "locked");
    assert.equal(mcpAppSwitch(sse, "claude")?.kind, "store");
  });
});

describe("MCP status and fixes", () => {
  const failed = server("broken", {
    apps: { claude: entry({ status: "failed", error: "spawn ENOENT" }), codex: entry() },
  });
  const auth = server("linear", { apps: { claude: entry({ status: "needs-auth" }) } });
  const missing = server("missing", {
    managed: true,
    apps: {
      codex: entry({ present: false, status: "unknown", error: "Missing from Codex config" }),
    },
  });

  it("labels live status", () => {
    assert.deepEqual(mcpStatusLabel(entry()), { label: "Connected", tone: "success" });
    assert.deepEqual(mcpStatusLabel(entry({ enabled: false })), { label: "Off", tone: "muted" });
    assert.deepEqual(mcpStatusLabel(entry({ status: "needs-auth" })), {
      label: "Needs sign-in",
      tone: "warning",
    });
  });

  it("reports failures, sign-in and errors on enabled entries only", () => {
    assert.deepEqual(mcpIssues(failed), [
      { app: "claude", tone: "destructive", label: "Failed", message: "spawn ENOENT" },
    ]);
    assert.deepEqual(mcpIssues(auth), [{ app: "claude", tone: "warning", label: "Needs sign-in" }]);
    assert.deepEqual(mcpIssues(missing), [
      { app: "codex", tone: "destructive", label: "Error", message: "Missing from Codex config" },
    ]);
    assert.deepEqual(
      mcpIssues(server("off", { apps: { claude: entry({ enabled: false, status: "failed" }) } })),
      [],
    );
  });

  it("offers sign-in, reconnect or restore, nothing for builtins", () => {
    assert.deepEqual(mcpPrimaryAction(failed), {
      kind: "reconnect",
      label: "Reconnect",
      apps: ["claude"],
    });
    assert.deepEqual(mcpPrimaryAction(auth), { kind: "login", label: "Sign in", apps: ["claude"] });
    assert.equal(mcpPrimaryAction(missing), null);
    const drifted = server("drift", {
      managed: true,
      id: "drift",
      apps: {
        claude: entry({ status: "failed" }),
        codex: entry({ present: false, status: "unknown", error: "Missing from Codex config" }),
      },
    });
    assert.deepEqual(mcpPrimaryAction(drifted), {
      kind: "restore",
      label: "Restore",
      apps: ["codex"],
    });
    assert.equal(
      mcpPrimaryAction(
        server("t3", { builtin: true, apps: { claude: entry({ status: "failed" }) } }),
      ),
      null,
    );
  });

  it("colors the row by its worst problem, else its best live state", () => {
    assert.equal(mcpRowTone(failed), "destructive");
    assert.equal(mcpRowTone(auth), "warning");
    assert.equal(
      mcpRowTone(server("off", { apps: { claude: entry({ enabled: false }) } })),
      "muted",
    );
  });

  it("groups tools per app unless both apps expose the same set, and caps them", () => {
    const same = server("x", {
      apps: {
        claude: entry({ tools: [{ name: "a" }, { name: "b" }] }),
        codex: entry({ tools: [{ name: "b" }, { name: "a" }] }),
      },
    });
    assert.deepEqual(
      groupTools(same).map((group) => group.apps),
      [["claude", "codex"]],
    );
    const tools = (...toolNames: string[]) => toolNames.map((name) => ({ name }));
    const groups = [
      { apps: ["claude"] as const, tools: tools("a", "b", "c") },
      { apps: ["codex"] as const, tools: tools("d", "e") },
    ];
    assert.deepEqual(
      capToolGroups(groups, 4).map((group) => [group.tools.length, group.total]),
      [
        [3, 3],
        [1, 2],
      ],
    );
  });
});

describe("skills", () => {
  const synced = skill("pdf", { apps: { claude: skillEntry({ scope: "synced" }) } });
  const system = skill("imagegen", {
    apps: { codex: skillEntry({ scope: "system", path: "/codex/skills/.system/imagegen" }) },
  });
  const fromPlugin = skill("vercel-cli", {
    pluginId: "vercel-plugin@vercel",
    apps: { claude: skillEntry({ scope: "plugin" }) },
  });
  const project = skill("test-t3-app", {
    apps: {
      claude: skillEntry({ scope: "project" }),
      codex: skillEntry({ scope: "project", path: "/repo/.claude/skills/test-t3-app" }),
    },
  });

  it("groups the project's skills and folds away what came with an app, claude.ai or a plugin", () => {
    const sections = sectionSkills([synced, skill("emil"), system, fromPlugin, project]);
    assert.deepEqual(names(sections.yours), ["emil"]);
    assert.deepEqual(names(sections.project), ["test-t3-app"]);
    assert.deepEqual(names(sections.builtIn), ["imagegen", "pdf", "vercel-cli"]);
    assert.equal(skillOrigin(synced), "claude.ai");
    assert.equal(skillOrigin(fromPlugin), "vercel-plugin");
  });

  it("switches any skill with the app's own setting, except plugin skills", () => {
    assert.deepEqual(skillAppSwitch(project, "claude"), { kind: "native" });
    assert.deepEqual(skillAppSwitch(project, "codex"), {
      kind: "native",
      path: "/repo/.claude/skills/test-t3-app",
    });
    assert.deepEqual(skillAppSwitch(system, "codex"), {
      kind: "native",
      path: "/codex/skills/.system/imagegen",
    });
    assert.isNull(skillAppSwitch(system, "claude"));
    assert.equal(skillAppSwitch(fromPlugin, "claude")?.kind, "locked");
    const managed = skill("mine", {
      managed: true,
      id: "m1",
      apps: { claude: skillEntry(), codex: skillEntry({ present: false, enabled: false }) },
    });
    assert.deepEqual(skillAppSwitch(managed, "codex"), { kind: "store", id: "m1" });
  });
});

describe("plugins", () => {
  it("folds away Codex's own plugins and summarizes what each brings", () => {
    const sections = sectionPlugins([
      plugin("pdf", { app: "codex", marketplace: "openai-primary-runtime" }),
      plugin("vercel"),
      plugin("mine", { app: "codex", marketplace: "openai-curated" }),
    ]);
    assert.deepEqual(names(sections.yours), ["vercel", "mine"]);
    assert.deepEqual(names(sections.builtIn), ["pdf"]);
    const rich = plugin("vercel", {
      contributes: { skills: ["a", "b"], mcpServers: ["vercel"], commands: [], agents: [] },
    });
    assert.equal(contributionSummary(rich), "2 skills · 1 MCP server");
  });
});

describe("apps", () => {
  it("reports unavailable apps only", () => {
    const apps = [
      { app: "claude" as const, available: true },
      { app: "codex" as const, available: false, error: "not found" },
    ];
    assert.isNull(appUnavailableReason(apps, "claude"));
    assert.equal(appUnavailableReason(apps, "codex"), "Codex is unavailable: not found");
  });
});
