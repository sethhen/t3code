/**
 * Add/edit dialog for a managed MCP server: a transport-aware form, a
 * "Paste JSON" mode that fills the form, and a presets picker (add only).
 */
import type { AgentAppInfo, McpPreset, McpServerRow } from "@t3tools/contracts";
import { BracesIcon, ChevronDownIcon, SparklesIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "~/components/ui/button";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

import { appUnavailableReason } from "./lists.logic";
import {
  codexTransportBlock,
  emptyMcpServerForm,
  formToUpsert,
  type McpServerForm,
  type McpTransport,
  parsePastedServerJson,
  serverNameError,
  specToFormFields,
  toServerName,
} from "./mcpForm.logic";
import { AppCheckboxes, reportMutation, type SkillsMcpClient } from "./shared";

type PresetState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly presets: readonly McpPreset[] };

function initialForm(row: McpServerRow | null, apps: readonly AgentAppInfo[]): McpServerForm {
  const empty = emptyMcpServerForm({
    claude: appUnavailableReason(apps, "claude") === null,
    codex: appUnavailableReason(apps, "codex") === null,
  });
  if (!row) return empty;
  return {
    ...empty,
    ...(row.spec ? specToFormFields(row.spec) : {}),
    name: row.name,
    description: row.description ?? "",
    homepage: row.homepage ?? "",
    tags: row.tags,
    apps: { claude: row.apps.claude?.enabled ?? false, codex: row.apps.codex?.enabled ?? false },
  };
}

function validName(candidate: string): string {
  return serverNameError(candidate) === null ? candidate : toServerName(candidate);
}

const TRANSPORT_LABEL: Readonly<Record<McpTransport, string>> = {
  stdio: "stdio",
  http: "HTTP",
  sse: "SSE",
};

/**
 * Mount with a fresh `key` per open so the form starts from `row`
 * (null = add a new server).
 */
export function McpServerDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: McpServerRow | null;
  apps: readonly AgentAppInfo[];
  client: SkillsMcpClient;
  onSaved: () => void;
}) {
  const { row, client } = props;
  const id = useId();
  const [form, setForm] = useState<McpServerForm>(() => initialForm(row, props.apps));
  const [mode, setMode] = useState<"form" | "json">("form");
  const [pasteText, setPasteText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [presets, setPresets] = useState<PresetState>({ status: "idle" });

  const update = (patch: Partial<McpServerForm>) => {
    setForm((previous) => ({ ...previous, ...patch }));
    setError(null);
  };

  const loadPresets = async () => {
    setPresets({ status: "loading" });
    const outcome = await client.call("mcp.presets", {});
    setPresets(
      outcome.ok
        ? { status: "ready", presets: outcome.value }
        : { status: "error", message: outcome.message },
    );
  };

  const applyPreset = (preset: McpPreset) => {
    setForm((previous) => ({
      ...previous,
      ...specToFormFields(preset.spec),
      name: validName(preset.id),
      description: preset.description,
      homepage: preset.homepage ?? "",
      tags: preset.tags,
    }));
    setMode("form");
    setError(null);
  };

  const usePasted = () => {
    const parsed = parsePastedServerJson(pasteText);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const pasted = parsed.value;
    setForm((previous) => ({
      ...previous,
      ...specToFormFields(pasted.spec),
      ...(pasted.name ? { name: validName(pasted.name) } : {}),
      ...(pasted.description ? { description: pasted.description } : {}),
      ...(pasted.homepage ? { homepage: pasted.homepage } : {}),
    }));
    setMode("form");
    setError(null);
  };

  const save = async () => {
    const parsed = formToUpsert(form, row?.id);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const name = parsed.value.name;
    setSaving(true);
    setError(null);
    const outcome = await client.call("mcp.mutate", parsed.value);
    setSaving(false);
    reportMutation(outcome, {
      failure: row ? `Could not save ${name}` : `Could not add ${name}`,
      success: row ? `Saved ${name}` : `Added ${name}`,
    });
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    props.onSaved();
    // A failure without an app means nothing was written; keep the form for another try.
    const general = outcome.value.failures.filter((failure) => !failure.app);
    if (general.length > 0) {
      setError(general.map((failure) => failure.message).join("\n"));
      return;
    }
    props.onOpenChange(false);
  };

  const nameHint = form.name.trim() === "" ? null : serverNameError(form.name.trim());
  const codexBlock = codexTransportBlock(form.transport);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (mode === "json") usePasted();
            else if (!saving) void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{row ? `Edit ${row.name}` : "Add MCP server"}</DialogTitle>
            <DialogDescription>
              Saved in T3's store and written to each selected app's config.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="xs"
                variant={mode === "json" ? "secondary" : "outline"}
                onClick={() => {
                  setMode(mode === "json" ? "form" : "json");
                  setError(null);
                }}
              >
                <BracesIcon />
                {mode === "json" ? "Back to form" : "Paste JSON"}
              </Button>
              {row ? null : (
                <Menu
                  onOpenChange={(open) => {
                    if (open && (presets.status === "idle" || presets.status === "error")) {
                      void loadPresets();
                    }
                  }}
                >
                  <MenuTrigger render={<Button type="button" size="xs" variant="outline" />}>
                    <SparklesIcon />
                    Presets
                    <ChevronDownIcon />
                  </MenuTrigger>
                  <MenuPopup align="start" className="w-72">
                    <PresetItems state={presets} onPick={applyPreset} />
                  </MenuPopup>
                </Menu>
              )}
            </div>

            {mode === "json" ? (
              <label className="grid gap-1.5">
                <span className="font-medium text-foreground text-xs">Server JSON</span>
                <Textarea
                  className="font-mono text-xs"
                  placeholder={
                    '{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "…"] } } }'
                  }
                  value={pasteText}
                  onChange={(event) => {
                    setPasteText(event.target.value);
                    setError(null);
                  }}
                />
                <span className="text-muted-foreground text-xs">
                  A Claude <code>mcpServers</code> map, one <code>"name": {"{…}"}</code> entry, or a
                  bare server object. Secrets stay on this machine.
                </span>
              </label>
            ) : (
              <>
                <label className="grid gap-1.5">
                  <span className="font-medium text-foreground text-xs">Name</span>
                  <Input
                    size="sm"
                    autoFocus={!row}
                    placeholder="github"
                    value={form.name}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                  {nameHint ? <span className="text-destructive text-xs">{nameHint}</span> : null}
                </label>

                <div className="grid gap-1.5">
                  <span className="font-medium text-foreground text-xs">Transport</span>
                  <ToggleGroup
                    aria-label="Transport"
                    className="w-fit"
                    value={[form.transport]}
                    onValueChange={(value) => {
                      const next = value[0];
                      if (next === "stdio" || next === "http" || next === "sse") {
                        update({ transport: next });
                      }
                    }}
                  >
                    {(["stdio", "http", "sse"] as const).map((transport) => (
                      <Toggle
                        key={transport}
                        aria-label={TRANSPORT_LABEL[transport]}
                        value={transport}
                      >
                        {TRANSPORT_LABEL[transport]}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                </div>

                {form.transport === "stdio" ? (
                  <>
                    <label className="grid gap-1.5">
                      <span className="font-medium text-foreground text-xs">Command</span>
                      <Input
                        size="sm"
                        className="font-mono"
                        placeholder="npx"
                        value={form.command}
                        onChange={(event) => update({ command: event.target.value })}
                      />
                    </label>
                    <label className="grid gap-1.5">
                      <span className="font-medium text-foreground text-xs">Arguments</span>
                      <Input
                        size="sm"
                        className="font-mono"
                        placeholder="-y @modelcontextprotocol/server-github"
                        value={form.args}
                        onChange={(event) => update({ args: event.target.value })}
                      />
                      <span className="text-muted-foreground text-xs">
                        Space-separated; quote arguments that contain spaces.
                      </span>
                    </label>
                    <label className="grid gap-1.5">
                      <span className="font-medium text-foreground text-xs">Environment</span>
                      <Textarea
                        size="sm"
                        className="font-mono text-xs"
                        placeholder={"GITHUB_TOKEN=…\nLOG_LEVEL=info"}
                        value={form.env}
                        onChange={(event) => update({ env: event.target.value })}
                      />
                      <span className="text-muted-foreground text-xs">One KEY=VALUE per line.</span>
                    </label>
                    <label className="grid gap-1.5">
                      <span className="font-medium text-foreground text-xs">Working directory</span>
                      <Input
                        size="sm"
                        className="font-mono"
                        placeholder="Optional"
                        value={form.cwd}
                        onChange={(event) => update({ cwd: event.target.value })}
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="grid gap-1.5">
                      <span className="font-medium text-foreground text-xs">URL</span>
                      <Input
                        size="sm"
                        className="font-mono"
                        type="url"
                        placeholder={
                          form.transport === "sse"
                            ? "https://example.com/sse"
                            : "https://example.com/mcp"
                        }
                        value={form.url}
                        onChange={(event) => update({ url: event.target.value })}
                      />
                    </label>
                    <label className="grid gap-1.5">
                      <span className="font-medium text-foreground text-xs">Headers</span>
                      <Textarea
                        size="sm"
                        className="font-mono text-xs"
                        placeholder="Authorization: Bearer …"
                        value={form.headers}
                        onChange={(event) => update({ headers: event.target.value })}
                      />
                      <span className="text-muted-foreground text-xs">
                        One Name: value per line.
                      </span>
                    </label>
                    {form.transport === "http" ? (
                      <label className="grid gap-1.5">
                        <span className="font-medium text-foreground text-xs">
                          Bearer token env var (Codex)
                        </span>
                        <Input
                          size="sm"
                          className="font-mono"
                          placeholder="EXAMPLE_API_TOKEN"
                          value={form.bearerTokenEnvVar}
                          onChange={(event) => update({ bearerTokenEnvVar: event.target.value })}
                        />
                      </label>
                    ) : null}
                  </>
                )}

                <div className="grid gap-1.5">
                  <span className="font-medium text-foreground text-xs">Apps</span>
                  <AppCheckboxes
                    value={form.apps}
                    onChange={(apps) => update({ apps })}
                    blocked={{ codex: codexBlock }}
                    {...(row ? {} : { apps: props.apps })}
                  />
                  {codexBlock ? (
                    <span className="text-muted-foreground text-xs">{codexBlock}</span>
                  ) : null}
                </div>

                <label className="grid gap-1.5">
                  <span className="font-medium text-foreground text-xs">Description</span>
                  <Input
                    size="sm"
                    placeholder="Optional"
                    value={form.description}
                    onChange={(event) => update({ description: event.target.value })}
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="font-medium text-foreground text-xs">Homepage</span>
                  <Input
                    size="sm"
                    type="url"
                    placeholder="https://"
                    value={form.homepage}
                    onChange={(event) => update({ homepage: event.target.value })}
                  />
                </label>
              </>
            )}

            {error ? (
              <p
                id={`${id}-error`}
                role="alert"
                className="whitespace-pre-wrap text-destructive text-xs"
              >
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            {mode === "json" ? (
              <Button type="submit" size="sm" disabled={pasteText.trim() === ""}>
                Use this
              </Button>
            ) : (
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? <Spinner className="size-3.5" /> : null}
                {row ? "Save" : "Add server"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function PresetItems(props: { state: PresetState; onPick: (preset: McpPreset) => void }) {
  const { state } = props;
  if (state.status === "idle" || state.status === "loading") {
    return (
      <MenuItem disabled>
        <Spinner className="size-3.5" />
        Loading presets…
      </MenuItem>
    );
  }
  if (state.status === "error") {
    return (
      <MenuItem disabled className="text-destructive text-xs">
        {state.message}
      </MenuItem>
    );
  }
  if (state.presets.length === 0) return <MenuItem disabled>No presets</MenuItem>;
  return (
    <>
      {state.presets.map((preset) => (
        <MenuItem key={preset.id} className="items-start" onClick={() => props.onPick(preset)}>
          <span className="grid min-w-0 gap-0.5 py-0.5">
            <span className="truncate font-medium">{preset.name}</span>
            <span className="line-clamp-2 text-muted-foreground text-xs">{preset.description}</span>
          </span>
        </MenuItem>
      ))}
    </>
  );
}
