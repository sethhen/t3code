import type {
  DiscoverableSkill,
  McpAppEntry,
  McpOverview,
  McpServerRow,
  PluginRow,
  SkillRow,
} from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  ALL_FACET,
  appUnavailableReason,
  bytesToBase64,
  contributionChips,
  countAttention,
  countImportable,
  filterDiscoverable,
  filterMcpServers,
  filterPlugins,
  filterSkills,
  formatInstalls,
  formatRelativeTime,
  groupDiscoverable,
  groupTools,
  matchesQuery,
  mcpCheckedAt,
  mcpFacetMatches,
  mcpFacets,
  mcpIssues,
  mcpPrimaryAction,
  mcpRowTone,
  mcpStatusLabel,
  mcpToggleBlock,
  mcpToolCount,
  parseRepoInput,
  resolveFacet,
  sectionMcpServers,
  sectionSkills,
  skillAdoptPath,
  skillFacetMatches,
  skillFacets,
  skillOrigin,
  skillSourceLabel,
  skillToggleBlock,
  sortMcpServers,
  sortPlugins,
  sortSkills,
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

function skill(name: string, patch: Partial<SkillRow> = {}): SkillRow {
  return {
    key: name,
    name,
    managed: false,
    apps: { claude: { present: true, enabled: true, scope: "user", editable: false } },
    ...patch,
  };
}

function plugin(name: string, patch: Partial<PluginRow> = {}): PluginRow {
  return {
    app: "claude",
    id: `${name}@market`,
    name,
    installed: true,
    enabled: true,
    contributes: { skills: [], mcpServers: [], commands: [], agents: [] },
    ...patch,
  };
}

describe("query matching", () => {
  it("ANDs whitespace-separated terms, case-insensitively", () => {
    assert.isTrue(matchesQuery(["GitHub server", "npx"], "  git   NPX "));
    assert.isFalse(matchesQuery(["GitHub server"], "git npx"));
    assert.isTrue(matchesQuery([undefined], ""));
  });
});

describe("MCP rows", () => {
  const rows = [
    server("t3-code", { builtin: true, apps: { claude: entry({ scope: "builtin" }) } }),
    server("zeta", { managed: true, id: "z" }),
    server("alpha-plugin", {
      apps: { claude: entry({ scope: "plugin", source: "vercel@vercel" }) },
    }),
    server("proj", { apps: { claude: entry({ scope: "project" }) } }),
    server("Beta", { managed: true, id: "b" }),
    server("loose", { apps: { codex: entry({ scope: "user" }) } }),
    server("policy", { apps: { claude: entry({ scope: "managed" }) } }),
  ];

  it("sorts managed, user, project, plugin, policy, builtin; names within", () => {
    assert.deepEqual(
      sortMcpServers(rows).map((row) => row.name),
      ["Beta", "zeta", "loose", "proj", "alpha-plugin", "policy", "t3-code"],
    );
  });

  it("filters across names, specs, sources, tools and flags", () => {
    const withSpec = server("gh", {
      spec: { type: "stdio", command: "npx", args: ["-y", "gh"] },
      apps: { codex: entry({ tools: [{ name: "create_issue" }] }) },
    });
    const all = [...rows, withSpec];
    assert.deepEqual(
      filterMcpServers(all, "npx").map((row) => row.name),
      ["gh"],
    );
    assert.deepEqual(
      filterMcpServers(all, "create_issue").map((row) => row.name),
      ["gh"],
    );
    assert.deepEqual(
      filterMcpServers(all, "vercel").map((row) => row.name),
      ["alpha-plugin"],
    );
    assert.deepEqual(
      filterMcpServers(all, "builtin").map((row) => row.name),
      ["t3-code"],
    );
    assert.strictEqual(filterMcpServers(all, " "), all);
  });

  it("labels live status", () => {
    assert.deepEqual(mcpStatusLabel(entry()), { label: "Connected", tone: "success" });
    assert.deepEqual(mcpStatusLabel(entry({ enabled: false })), { label: "Off", tone: "muted" });
    assert.deepEqual(mcpStatusLabel(entry({ status: "needs-auth" })), {
      label: "Needs auth",
      tone: "warning",
    });
    assert.deepEqual(mcpStatusLabel(entry({ status: "failed" })), {
      label: "Failed",
      tone: "destructive",
    });
  });

  it("explains locked switches", () => {
    const byName = (name: string) => rows.find((row) => row.name === name)!;
    assert.match(mcpToggleBlock(byName("t3-code"), "claude")!, /T3 attaches/);
    assert.match(mcpToggleBlock(byName("loose"), "codex")!, /Import/);
    assert.equal(
      mcpToggleBlock(byName("alpha-plugin"), "claude"),
      "Defined by a plugin (vercel@vercel); edit it there.",
    );
    assert.isNull(mcpToggleBlock(byName("zeta"), "codex"));
    const sse = server("s", {
      managed: true,
      id: "s",
      spec: { type: "sse", url: "https://s.dev" },
    });
    assert.equal(mcpToggleBlock(sse, "codex"), "Codex has no SSE transport.");
    assert.isNull(mcpToggleBlock(sse, "claude"));
  });

  it("counts importable user servers", () => {
    assert.equal(countImportable(rows), 1);
  });

  it("groups tools per app unless both apps expose the same set", () => {
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
    const differ = server("y", {
      apps: { claude: entry({ tools: [{ name: "a" }] }), codex: entry({ tools: [] }) },
    });
    assert.deepEqual(
      groupTools(differ).map((group) => group.apps),
      [["claude"], ["codex"]],
    );
    assert.deepEqual(groupTools(server("z")), []);
  });

  it("reports the oldest live-probe time", () => {
    const overview: McpOverview = {
      apps: [],
      servers: [],
      liveProbe: {
        claude: { ok: true, checkedAt: "2026-09-26T10:00:05Z" },
        codex: { ok: true, checkedAt: "2026-09-26T10:00:01Z" },
      },
      checkedAt: "2026-09-26T10:00:09Z",
    };
    assert.equal(mcpCheckedAt(overview), "2026-09-26T10:00:01Z");
    const noProbe = { ...overview, liveProbe: { claude: { ok: false }, codex: { ok: false } } };
    assert.equal(mcpCheckedAt(noProbe), "2026-09-26T10:00:09Z");
  });
});

describe("apps", () => {
  it("reports unavailable apps only", () => {
    const apps = [
      { app: "claude" as const, available: true },
      { app: "codex" as const, available: false, error: "codex not found on PATH" },
    ];
    assert.isNull(appUnavailableReason(apps, "claude"));
    assert.equal(
      appUnavailableReason(apps, "codex"),
      "Codex is unavailable: codex not found on PATH",
    );
    assert.isNull(appUnavailableReason([], "codex"));
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  it("formats seconds, minutes, hours and days", () => {
    assert.equal(formatRelativeTime("2026-09-26T11:59:58Z", now), "just now");
    assert.equal(formatRelativeTime("2026-09-26T12:00:30Z", now), "just now");
    assert.equal(formatRelativeTime("2026-09-26T11:59:18Z", now), "42 s ago");
    assert.equal(formatRelativeTime("2026-09-26T11:55:00Z", now), "5 min ago");
    assert.equal(formatRelativeTime("2026-09-26T09:00:00Z", now), "3 h ago");
    assert.equal(formatRelativeTime("2026-09-24T12:00:00Z", now), "2 d ago");
    assert.isNull(formatRelativeTime("nope", now));
  });
});

describe("skills", () => {
  it("sorts managed first and filters by source and scope", () => {
    const rows = [
      skill("zed", { managed: true, id: "z" }),
      skill("alpha"),
      skill("Mid", {
        managed: true,
        id: "m",
        source: { type: "github", owner: "acme", repo: "kit" },
      }),
    ];
    assert.deepEqual(
      sortSkills(rows).map((row) => row.name),
      ["Mid", "zed", "alpha"],
    );
    assert.deepEqual(
      filterSkills(rows, "acme/kit").map((row) => row.name),
      ["Mid"],
    );
    assert.deepEqual(
      filterSkills(rows, "user alp").map((row) => row.name),
      ["alpha"],
    );
  });

  it("labels sources with GitHub links", () => {
    const github = (patch: object) =>
      skillSourceLabel(skill("s", { source: { type: "github", owner: "o", repo: "r", ...patch } }));
    assert.deepEqual(github({}), { kind: "github", label: "o/r", href: "https://github.com/o/r" });
    assert.deepEqual(github({ path: "/skills/pdf/" }), {
      kind: "github",
      label: "o/r",
      href: "https://github.com/o/r/tree/HEAD/skills/pdf",
    });
    assert.equal(github({ branch: "dev" })?.href, "https://github.com/o/r/tree/dev");
    assert.deepEqual(skillSourceLabel(skill("z", { source: { type: "zip", fileName: "a.zip" } })), {
      kind: "zip",
      label: "a.zip",
    });
    assert.deepEqual(skillSourceLabel(skill("p", { pluginId: "vercel@vercel" })), {
      kind: "plugin",
      label: "vercel@vercel",
    });
    assert.isNull(skillSourceLabel(skill("n")));
  });

  it("explains locked switches and finds the adopt path", () => {
    assert.match(skillToggleBlock(skill("p", { pluginId: "x@y" }), "claude")!, /plugin x@y/);
    const system = skill("s", {
      apps: { codex: { present: true, enabled: true, scope: "system", editable: false } },
    });
    assert.equal(skillToggleBlock(system, "codex"), "Built into Codex.");
    assert.match(skillToggleBlock(skill("u"), "claude")!, /Adopt/);
    assert.isNull(skillToggleBlock(skill("m", { managed: true, id: "m" }), "claude"));

    const adoptable = skill("a", {
      apps: {
        claude: {
          present: true,
          enabled: true,
          scope: "user",
          path: "/h/.claude/skills/a",
          editable: false,
        },
      },
    });
    assert.equal(skillAdoptPath(adoptable), "/h/.claude/skills/a");
    assert.isUndefined(skillAdoptPath({ ...adoptable, managed: true }));
    assert.isUndefined(skillAdoptPath(skill("nopath")));
  });

  it("parses repositories", () => {
    assert.deepEqual(parseRepoInput("anthropics/skills"), {
      ok: true,
      value: { owner: "anthropics", repo: "skills" },
    });
    assert.deepEqual(parseRepoInput(" o/r@feature/x "), {
      ok: true,
      value: { owner: "o", repo: "r", branch: "feature/x" },
    });
    assert.deepEqual(parseRepoInput("https://github.com/o/r.git"), {
      ok: true,
      value: { owner: "o", repo: "r" },
    });
    assert.deepEqual(parseRepoInput("github.com/o/r/tree/main/"), {
      ok: true,
      value: { owner: "o", repo: "r", branch: "main" },
    });
    assert.isFalse(parseRepoInput("").ok);
    assert.isFalse(parseRepoInput("just-owner").ok);
    assert.isFalse(parseRepoInput("o/r/extra").ok);
    assert.isFalse(parseRepoInput("o/r@").ok);
    assert.isFalse(parseRepoInput("o w/r").ok);
  });

  it("groups discoverable skills by repo, keeping empty saved repos", () => {
    const found = (repo: string, name: string): DiscoverableSkill => ({
      owner: "o",
      repo,
      branch: "main",
      path: `skills/${name}`,
      name,
      installed: false,
    });
    const groups = groupDiscoverable(
      [found("b", "zz"), found("b", "aa"), found("a", "pdf")],
      [
        { owner: "o", repo: "b" },
        { owner: "o", repo: "empty" },
      ],
    );
    assert.deepEqual(
      groups.map((group) => [group.key, group.saved, group.skills.map((entry) => entry.name)]),
      [
        ["o/a", false, ["pdf"]],
        ["o/b", true, ["aa", "zz"]],
        ["o/empty", true, []],
      ],
    );
    assert.deepEqual(
      filterDiscoverable(groups, "pdf").map((group) => group.key),
      ["o/a"],
    );
    assert.deepEqual(
      filterDiscoverable(groups, "empty").map((group) => group.key),
      ["o/empty"],
    );
  });

  it("formats install counts and base64", () => {
    assert.equal(formatInstalls(999), "999");
    assert.equal(formatInstalls(1000), "1k");
    assert.equal(formatInstalls(1234), "1.2k");
    assert.equal(formatInstalls(999_960), "1M");
    assert.equal(formatInstalls(3_400_000), "3.4M");
    assert.equal(bytesToBase64(new TextEncoder().encode("hello")), "aGVsbG8=");
    const big = new Uint8Array(0x8000 * 2 + 3).fill(65);
    assert.equal(atob(bytesToBase64(big)).length, big.length);
  });
});

describe("plugins", () => {
  it("sorts, filters by contributions and summarizes them", () => {
    const rows = [
      plugin("vercel", {
        contributes: { skills: ["a", "b"], mcpServers: ["v"], commands: [], agents: [] },
      }),
      plugin("Atlas", { marketplace: "official" }),
    ];
    assert.deepEqual(
      sortPlugins(rows).map((row) => row.name),
      ["Atlas", "vercel"],
    );
    assert.deepEqual(
      filterPlugins(rows, "official").map((row) => row.name),
      ["Atlas"],
    );
    assert.deepEqual(
      filterPlugins(rows, "v").map((row) => row.name),
      ["vercel"],
    );
    assert.deepEqual(
      contributionChips(rows[0]!).map((chip) => chip.label),
      ["2 skills", "1 MCP server"],
    );
  });
});

describe("attention", () => {
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
  const sseOff = server("sse", {
    managed: true,
    apps: {
      claude: entry(),
      codex: entry({
        present: false,
        enabled: false,
        status: "disabled",
        error: "Codex has no SSE transport",
      }),
    },
  });

  it("reports failures, auth and errors on enabled entries only", () => {
    assert.deepEqual(mcpIssues(failed), [
      { app: "claude", tone: "destructive", label: "Failed", message: "spawn ENOENT" },
    ]);
    assert.deepEqual(mcpIssues(auth), [{ app: "claude", tone: "warning", label: "Needs auth" }]);
    assert.deepEqual(mcpIssues(missing), [
      { app: "codex", tone: "destructive", label: "Error", message: "Missing from Codex config" },
    ]);
    assert.deepEqual(mcpIssues(sseOff), []);
    assert.equal(countAttention([failed, auth, missing, sseOff, server("ok")]), 3);
  });

  it("offers reconnect for present failures and auth, not for config errors or builtins", () => {
    assert.deepEqual(mcpPrimaryAction(failed), {
      kind: "reconnect",
      label: "Reconnect",
      apps: ["claude"],
    });
    assert.deepEqual(mcpPrimaryAction(auth)?.apps, ["claude"]);
    assert.equal(mcpPrimaryAction(missing), null);
    assert.equal(mcpPrimaryAction(server("ok")), null);
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
    assert.equal(mcpRowTone(sseOff), "success");
    assert.equal(
      mcpRowTone(server("off", { apps: { claude: entry({ enabled: false }) } })),
      "muted",
    );
    assert.equal(
      mcpRowTone(server("wait", { apps: { claude: entry({ status: "pending" }) } })),
      "info",
    );
  });

  it("counts distinct tools across apps", () => {
    const row = server("gh", {
      apps: {
        claude: entry({ tools: [{ name: "a" }, { name: "b" }] }),
        codex: entry({ tools: [{ name: "b" }, { name: "c" }] }),
      },
    });
    assert.equal(mcpToolCount(row), 3);
    assert.equal(mcpToolCount(server("none")), 0);
  });

  it("sections problems first, failures before auth", () => {
    const managed = server("zeta", { managed: true });
    const sections = sectionMcpServers([server("plain"), auth, managed, failed, missing]);
    assert.deepEqual(
      sections.map((section) => [section.id, section.rows.map((row) => row.name)]),
      [
        ["attention", ["missing", "broken", "linear"]],
        ["managed", ["zeta"]],
        ["other", ["plain"]],
      ],
    );
    assert.deepEqual(
      sectionMcpServers([server("plain")]).map((section) => section.id),
      ["other"],
    );
  });
});

describe("MCP facets", () => {
  const rows = [
    server("gh", { managed: true, tags: ["code", "work"] }),
    server("db", { managed: true, tags: ["work"] }),
    server("broken", { apps: { claude: entry({ status: "failed" }) } }),
    server("proj", { apps: { claude: entry({ scope: "project" }) } }),
  ];

  it("counts status, tags and origins", () => {
    assert.deepEqual(
      mcpFacets(rows).map((facet) => [facet.group, facet.id, facet.count]),
      [
        ["Show", "attention", 1],
        ["Show", "managed", 2],
        ["Show", "unmanaged", 2],
        ["Tags", "tag:code", 1],
        ["Tags", "tag:work", 2],
        ["Origin", "scope:project", 1],
        ["Origin", "scope:user", 1],
      ],
    );
    assert.equal(
      mcpFacets([server("a")]).some((facet) => facet.group === "Origin"),
      false,
    );
  });

  it("matches rows", () => {
    const names = (facet: string) =>
      rows.filter((row) => mcpFacetMatches(row, facet)).map((row) => row.name);
    assert.deepEqual(names(ALL_FACET), ["gh", "db", "broken", "proj"]);
    assert.deepEqual(names("attention"), ["broken"]);
    assert.deepEqual(names("tag:work"), ["gh", "db"]);
    assert.deepEqual(names("scope:project"), ["proj"]);
    assert.deepEqual(names("unmanaged"), ["broken", "proj"]);
  });

  it("falls back to all when the facet disappears", () => {
    const facets = mcpFacets(rows);
    assert.equal(resolveFacet(facets, "tag:work"), "tag:work");
    assert.equal(resolveFacet(facets, "tag:gone"), ALL_FACET);
    assert.equal(resolveFacet([], ALL_FACET), ALL_FACET);
  });
});

describe("skill origins, facets and sections", () => {
  const rows = [
    skill("gh-skill", {
      managed: true,
      source: { type: "github", owner: "Acme", repo: "Skills" },
      updateAvailable: true,
    }),
    skill("zipped", { managed: true, source: { type: "zip", fileName: "x.zip" } }),
    skill("from-plugin", {
      pluginId: "toolkit@market",
      apps: { claude: { present: true, enabled: true, scope: "plugin", editable: false } },
    }),
    skill("builtin", {
      apps: { codex: { present: true, enabled: true, scope: "system", editable: false } },
    }),
  ];

  it("derives an origin per skill", () => {
    assert.deepEqual(
      rows.map((row) => skillOrigin(row)),
      [
        { id: "source:github:acme/skills", label: "Acme/Skills" },
        { id: "source:zip", label: "Uploaded .zip" },
        { id: "source:plugin:toolkit@market", label: "toolkit@market" },
        { id: "source:system", label: "Built in" },
      ],
    );
  });

  it("counts and matches facets", () => {
    assert.deepEqual(
      skillFacets(rows)
        .filter((facet) => facet.group === "Show")
        .map((facet) => [facet.id, facet.count]),
      [
        ["updates", 1],
        ["managed", 2],
        ["unmanaged", 2],
      ],
    );
    assert.equal(skillFacets(rows).filter((facet) => facet.group === "Source").length, 4);
    assert.deepEqual(
      rows.filter((row) => skillFacetMatches(row, "source:zip")).map((row) => row.name),
      ["zipped"],
    );
    assert.deepEqual(
      rows.filter((row) => skillFacetMatches(row, "updates")).map((row) => row.name),
      ["gh-skill"],
    );
  });

  it("sections updates first", () => {
    assert.deepEqual(
      sectionSkills(rows).map((section) => [section.id, section.rows.map((row) => row.name)]),
      [
        ["updates", ["gh-skill"]],
        ["managed", ["zipped"]],
        ["other", ["builtin", "from-plugin"]],
      ],
    );
  });
});
