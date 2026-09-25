/**
 * Install a skill three ways: search skills.sh, browse saved GitHub repos, or
 * upload a zip. Every install goes to the selected apps.
 */
import type {
  AgentAppInfo,
  DiscoverableSkill,
  SkillRepo,
  SkillSearchResult,
  SkillsMutation,
} from "@t3tools/contracts";
import { ChevronRightIcon, DownloadIcon, UploadIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

import { SearchField } from "./listControls";
import {
  appUnavailableReason,
  bytesToBase64,
  filterDiscoverable,
  formatInstalls,
  groupDiscoverable,
  parseRepoInput,
  type RepoGroup,
} from "./lists.logic";
import {
  AppCheckboxes,
  EmptyState,
  RowSpinner,
  type SkillsMcpClient,
  WithReason,
  reportMutation,
  safeCall,
  useBusyKeys,
} from "./shared";

type InstallTab = "search" | "repos" | "upload";
type Flags = { claude: boolean; codex: boolean };

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 30;
const MAX_ZIP_BYTES = 25 * 1024 * 1024;

export interface SkillInstallDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly client: SkillsMcpClient;
  readonly apps: readonly AgentAppInfo[];
  readonly repos: readonly SkillRepo[];
  /** Lower-cased names of skills already on disk (search results carry no installed flag). */
  readonly installedNames: ReadonlySet<string>;
  /** A skill landed: reload the list and the context cost. */
  readonly onInstalled: () => void;
  /** Saved repos changed: reload the list only. */
  readonly onReposChanged: () => void;
}

export function SkillInstallDialog(props: SkillInstallDialogProps) {
  const { client, apps } = props;
  const [tab, setTab] = useState<InstallTab>("search");
  const [flags, setFlags] = useState<Flags>(() => ({
    claude: appUnavailableReason(apps, "claude") === null,
    codex: appUnavailableReason(apps, "codex") === null,
  }));
  const busy = useBusyKeys();
  const target: Flags = {
    claude: flags.claude && appUnavailableReason(apps, "claude") === null,
    codex: flags.codex && appUnavailableReason(apps, "codex") === null,
  };
  const noTarget = !target.claude && !target.codex;

  const install = (busyKey: string, input: SkillsMutation, name: string, after?: () => void) => {
    busy.run(busyKey, async () => {
      const outcome = await safeCall(client, "skills.mutate", input);
      const ok = reportMutation(outcome, {
        failure: `Could not install ${name}`,
        success: `Installed ${name}`,
      });
      if (outcome.ok) props.onInstalled();
      if (ok) after?.();
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install skill</DialogTitle>
          <DialogDescription>
            Skills are stored once by T3 and linked into each selected app.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex min-h-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleGroup
              aria-label="Install from"
              value={[tab]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "search" || value === "repos" || value === "upload") setTab(value);
              }}
            >
              <Toggle value="search" size="xs">
                skills.sh
              </Toggle>
              <Toggle value="repos" size="xs">
                Repositories
              </Toggle>
              <Toggle value="upload" size="xs">
                Upload
              </Toggle>
            </ToggleGroup>
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <span>Install for</span>
              <AppCheckboxes value={flags} onChange={setFlags} apps={apps} />
            </div>
          </div>
          {tab === "search" ? (
            <SearchPane
              client={client}
              installedNames={props.installedNames}
              disabled={noTarget}
              isBusy={busy.isBusy}
              onInstall={(result) => {
                const [owner, repo] = result.source.split("/");
                if (!owner || !repo) return;
                install(
                  `search:${result.id}`,
                  {
                    action: "install",
                    source: { owner, repo },
                    skillName: result.name,
                    apps: target,
                  },
                  result.name,
                );
              }}
            />
          ) : null}
          {tab === "repos" ? (
            <ReposPane
              client={client}
              repos={props.repos}
              disabled={noTarget}
              isBusy={busy.isBusy}
              run={busy.run}
              onReposChanged={props.onReposChanged}
              onInstall={(skill, after) =>
                install(
                  `repo:${skill.owner}/${skill.repo}/${skill.path}`,
                  {
                    action: "install",
                    source: {
                      owner: skill.owner,
                      repo: skill.repo,
                      branch: skill.branch,
                      path: skill.path,
                    },
                    apps: target,
                  },
                  skill.name,
                  after,
                )
              }
            />
          ) : null}
          {tab === "upload" ? (
            <UploadPane
              disabled={noTarget}
              busy={busy.isBusy("upload")}
              onUpload={(file) =>
                busy.run("upload", async () => {
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  const outcome = await safeCall(client, "skills.mutate", {
                    action: "installZip",
                    fileName: file.name,
                    dataBase64: bytesToBase64(bytes),
                    apps: target,
                  });
                  reportMutation(outcome, {
                    failure: `Could not install ${file.name}`,
                    success: `Installed ${file.name}`,
                  });
                  if (outcome.ok) props.onInstalled();
                })
              }
            />
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => props.onOpenChange(false)}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// skills.sh search

function SearchPane(props: {
  client: SkillsMcpClient;
  installedNames: ReadonlySet<string>;
  disabled: boolean;
  isBusy: (key: string) => boolean;
  onInstall: (result: SkillSearchResult) => void;
}) {
  const { client } = props;
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{
    query: string;
    results: readonly SkillSearchResult[];
    error: string | null;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < 2) {
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void safeCall(client, "skills.search", { query: trimmed, limit: SEARCH_LIMIT }).then(
        (outcome) => {
          if (cancelled) return;
          setSearching(false);
          setState(
            outcome.ok
              ? { query: trimmed, results: outcome.value, error: null }
              : { query: trimmed, results: [], error: outcome.message },
          );
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, trimmed]);

  let body: ReactNode;
  if (trimmed.length < 2) {
    body = <EmptyState title="Search skills.sh" description="Type at least two characters." />;
  } else if (!state || (searching && state.query !== trimmed && state.results.length === 0)) {
    body = <PaneLoading label="Searching…" />;
  } else if (state.error) {
    body = <EmptyState title="Search failed" description={state.error} />;
  } else if (state.results.length === 0) {
    body = (
      <EmptyState
        title="No skills found"
        description={`Nothing on skills.sh matches “${state.query}”.`}
      />
    );
  } else {
    body = (
      <ul>
        {state.results.map((result) => {
          const installed = props.installedNames.has(result.name.toLowerCase());
          const busy = props.isBusy(`search:${result.id}`);
          return (
            <li
              key={result.id}
              className="flex min-h-8 items-center gap-2 border-border/50 border-b px-1 py-1 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-xs">{result.name}</div>
                <div className="truncate text-[.65rem] text-muted-foreground">{result.source}</div>
              </div>
              <WithReason reason={`${result.installs.toLocaleString()} installs`}>
                <span className="shrink-0 text-[.65rem] text-muted-foreground tabular-nums">
                  {formatInstalls(result.installs)}
                </span>
              </WithReason>
              <InstallButton
                installed={installed}
                busy={busy}
                disabled={props.disabled}
                name={result.name}
                onClick={() => props.onInstall(result)}
              />
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1">
        <SearchField value={query} onChange={setQuery} placeholder="Search skills.sh" />
        {searching ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
      </div>
      <ScrollArea className="h-72">{body}</ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saved repositories

function ReposPane(props: {
  client: SkillsMcpClient;
  repos: readonly SkillRepo[];
  disabled: boolean;
  isBusy: (key: string) => boolean;
  run: (key: string, task: () => Promise<unknown>) => void;
  onReposChanged: () => void;
  onInstall: (skill: DiscoverableSkill, after: () => void) => void;
}) {
  const { client, run } = props;
  const [skills, setSkills] = useState<readonly DiscoverableSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [repoText, setRepoText] = useState("");
  const [repoError, setRepoError] = useState<string | null>(null);
  const generation = useRef(0);

  const discover = () => {
    const current = ++generation.current;
    setLoading(true);
    void safeCall(client, "skills.discover", {}).then((outcome) => {
      if (current !== generation.current) return;
      setLoading(false);
      if (outcome.ok) {
        setSkills(outcome.value);
        setError(null);
      } else {
        setError(outcome.message);
      }
    });
  };
  const discoverRef = useRef(discover);
  useLayoutEffect(() => {
    discoverRef.current = discover;
  });
  useEffect(() => {
    discoverRef.current();
    return () => {
      generation.current += 1;
    };
  }, []);

  const groups = useMemo(() => groupDiscoverable(skills ?? [], props.repos), [skills, props.repos]);
  const shown = useMemo(() => filterDiscoverable(groups, query), [groups, query]);

  const mutateRepos = (key: string, input: SkillsMutation, failure: string, after?: () => void) =>
    run(key, async () => {
      const outcome = await safeCall(client, "skills.mutate", input);
      const ok = reportMutation(outcome, { failure });
      if (outcome.ok) {
        props.onReposChanged();
        discover();
      }
      if (ok) after?.();
    });

  const addRepo = () => {
    const parsed = parseRepoInput(repoText);
    if (!parsed.ok) {
      setRepoError(parsed.error);
      return;
    }
    setRepoError(null);
    mutateRepos(
      "add-repo",
      { action: "addRepo", ...parsed.value },
      `Could not add ${parsed.value.owner}/${parsed.value.repo}`,
      () => setRepoText(""),
    );
  };

  let body: ReactNode;
  if (skills === null) {
    body = error ? (
      <EmptyState title="Could not list repository skills" description={error}>
        <Button size="xs" variant="outline" onClick={discover}>
          Retry
        </Button>
      </EmptyState>
    ) : (
      <PaneLoading label="Reading repositories…" />
    );
  } else if (groups.length === 0) {
    body = (
      <EmptyState
        title="No repositories"
        description="Add a GitHub repository (owner/repo) that contains skills."
      />
    );
  } else if (shown.length === 0) {
    body = <EmptyState title="No matches" />;
  } else {
    body = shown.map((group) => (
      <RepoSection
        key={group.key}
        group={group}
        disabled={props.disabled}
        isBusy={props.isBusy}
        onInstall={(skill) => props.onInstall(skill, discover)}
        onRemove={() =>
          mutateRepos(
            `remove:${group.key}`,
            { action: "removeRepo", owner: group.repo.owner, repo: group.repo.repo },
            `Could not remove ${group.key}`,
          )
        }
      />
    ));
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <form
        className="flex items-start gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          addRepo();
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            size="sm"
            value={repoText}
            placeholder="owner/repo, owner/repo@branch or a GitHub URL"
            aria-label="Repository to add"
            aria-invalid={repoError !== null}
            onChange={(event) => {
              setRepoText(event.currentTarget.value);
              setRepoError(null);
            }}
          />
          {repoError ? (
            <div className="pt-0.5 text-[.7rem] text-destructive-foreground">{repoError}</div>
          ) : null}
        </div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!repoText.trim() || props.isBusy("add-repo")}
        >
          Add repo
        </Button>
      </form>
      <div className="flex items-center gap-1">
        <SearchField value={query} onChange={setQuery} placeholder="Filter repository skills" />
        {loading && skills !== null ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
      </div>
      {error && skills !== null ? (
        <div className="truncate text-[.7rem] text-destructive-foreground">
          Last refresh failed: {error}
        </div>
      ) : null}
      <ScrollArea className="h-64">{body}</ScrollArea>
    </div>
  );
}

function RepoSection(props: {
  group: RepoGroup;
  disabled: boolean;
  isBusy: (key: string) => boolean;
  onInstall: (skill: DiscoverableSkill) => void;
  onRemove: () => void;
}) {
  const { group } = props;
  const removing = props.isBusy(`remove:${group.key}`);
  return (
    <Collapsible defaultOpen className="border-border/50 border-b last:border-b-0">
      <div className="flex min-h-7 items-center gap-1 px-1">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left">
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none" />
          <span className="truncate font-medium text-xs">{group.key}</span>
          {group.repo.branch ? (
            <span className="shrink-0 text-[.65rem] text-muted-foreground">
              @{group.repo.branch}
            </span>
          ) : null}
          <span className="shrink-0 text-[.65rem] text-muted-foreground tabular-nums">
            {group.skills.length}
          </span>
        </CollapsibleTrigger>
        {removing ? <RowSpinner /> : null}
        {group.saved ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove ${group.key}`}
            disabled={removing}
            onClick={props.onRemove}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      <CollapsiblePanel>
        {group.skills.length === 0 ? (
          <div className="px-1 pb-1.5 pl-5.5 text-[.7rem] text-muted-foreground">
            No skills found in this repository.
          </div>
        ) : (
          <ul className="pb-1">
            {group.skills.map((skill) => {
              const key = `repo:${skill.owner}/${skill.repo}/${skill.path}`;
              return (
                <li key={key} className="flex min-h-7 items-center gap-2 px-1 pl-5.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs">{skill.name}</div>
                    {skill.description ? (
                      <div className="truncate text-[.65rem] text-muted-foreground">
                        {skill.description}
                      </div>
                    ) : null}
                  </div>
                  <InstallButton
                    installed={skill.installed}
                    busy={props.isBusy(key)}
                    disabled={props.disabled}
                    name={skill.name}
                    onClick={() => props.onInstall(skill)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Zip upload

function UploadPane(props: { disabled: boolean; busy: boolean; onUpload: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const tooBig = file !== null && file.size > MAX_ZIP_BYTES;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        A .zip holding one skill folder (with its SKILL.md). Up to 25 MB.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
      />
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
          <UploadIcon />
          Choose .zip
        </Button>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : "No file chosen"}
        </span>
      </div>
      {tooBig ? (
        <div className="text-[.7rem] text-destructive-foreground">That file is over 25 MB.</div>
      ) : null}
      <div>
        <Button
          type="button"
          size="sm"
          disabled={file === null || tooBig || props.disabled || props.busy}
          onClick={() => {
            if (file) props.onUpload(file);
          }}
        >
          {props.busy ? <Spinner className="size-3.5" /> : <DownloadIcon />}
          Install from zip
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function InstallButton(props: {
  installed: boolean;
  busy: boolean;
  disabled: boolean;
  name: string;
  onClick: () => void;
}) {
  if (props.installed) {
    return <span className="shrink-0 px-1.5 text-[.65rem] text-success-foreground">Installed</span>;
  }
  return (
    <WithReason reason={props.disabled ? "Pick at least one app to install for" : null}>
      <Button
        size="micro"
        variant="outline"
        aria-label={`Install ${props.name}`}
        disabled={props.disabled || props.busy}
        onClick={props.onClick}
      >
        {props.busy ? <RowSpinner /> : null}
        Install
      </Button>
    </WithReason>
  );
}

function PaneLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-1.5 py-10 text-muted-foreground text-xs">
      <Spinner className="size-3.5" />
      {label}
    </div>
  );
}
