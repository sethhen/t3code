# Wingman fork of T3 Code

Public fork (`sethhen/t3code`, remote `origin`) of `pingdotgg/t3code` (remote `upstream`).
Branch `main` = the newest upstream **stable tag** merged in + the fork's commits. The fork adds
right-panel "extensions" (Skills & MCP, ...). Every push to `main` runs the "Fork release"
workflow (`.github/workflows/fork-release.yml`): a self-signed macOS arm64 DMG and an
unsigned Windows x64 installer (no Apple or Microsoft account needed), versioned `X.Y.Z-wingman.<run>` (X.Y.Z = the upstream release `main` is based on),
published as a GitHub Release that installed fork apps update to.

## The one rule: only the extension host commit edits upstream files

Against its base tag, `main` may change only fork-owned paths plus the upstream files of the
`feat(fork): extension host ...` commit: `git diff --name-only <base-tag>..main` minus the
fork-owned paths must equal that file list. `scripts/fork/update.sh` blocks otherwise. Every edit
is marked with a `t3-ext` comment so merge conflicts are easy to recognise
(`git grep -n t3-ext -- apps/server apps/web/src packages/contracts`).

| Host file                                                              | What the fork adds                                                                       |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/contracts/src/rpc.ts`                                        | `WS_METHODS.extensionCall` (`extension.call`) + `WsExtensionCallRpc`                     |
| `packages/contracts/src/index.ts`                                      | `export * from "./extensions/index.ts"`                                                  |
| `apps/server/src/ws.ts`                                                | builds the extension registry, handles `extension.call`                                  |
| `apps/server/src/auth/RpcAuthorization.ts`                             | scope for `extension.call`                                                               |
| `apps/web/src/rightPanelStore.ts`                                      | `extension` surface kind + `openExtension`                                               |
| `apps/web/src/components/RightPanelTabs.tsx`                           | extension entries in the add-tab menu, label/icon                                        |
| `apps/web/src/components/ChatView.tsx`                                 | renders `ExtensionSurface`; adds fork composer banners (Continue on another account)     |
| `apps/web/src/components/AgentsPanel.tsx`                              | shows live elapsed time for workflows and pending members via `agentElapsedClock`        |
| `apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts` | runtime-only instance overlays (`applyForkInstanceOverlays`) + `withOverlayReconciles`   |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`                     | merges `--settings` launch args; one row per long rate-limit wait, + its test            |
| `apps/server/src/textGeneration/ClaudeTextGeneration.ts`               | the same merge for Claude text generation                                                |
| `apps/server/src/server.ts`                                            | provides `ForkServicesLive` (server-lifetime fork services, e.g. the pool's retirement)  |
| `apps/web/src/components/settings/ProviderSettingsPanel.tsx`           | wraps the page in `ProviderSettingsExtensions` (Accounts on top, the rest folds away)    |
| `apps/server/src/provider/Layers/CodexProvider.ts`                     | skips the usage read for a Codex without a ChatGPT sign-in, + its test                   |
| `apps/server/src/provider/Layers/ProviderService.ts`                   | a thread moved to an instance with its continuation key resumes its conversation, + test |
| `apps/server/src/provider/Drivers/ClaudeDriver.ts`                     | shared-history continuation key; no Claude resets via the OAuth token, + its test        |
| `apps/server/src/provider/Layers/ClaudeProvider.ts`                    | a longer deadline for Claude Code's usage read (~3s per account), + its test             |

Fork-owned paths (new extensions only touch these):

- `packages/contracts/src/extensions/` - schemas (`host.ts` + one file per extension, `index.ts` barrel)
- `apps/server/src/extensions/` - server handlers (`registry.ts`, `index.ts` registers extensions)
- `apps/web/src/extensions/` - panels (`registry.ts`, `ExtensionSurface.tsx`)
- `scripts/fork/`, `FORK.md`, `.github/workflows/fork-release.yml`

`apps/server/src/extensions/hostSeams.test.ts` fails by name when a merge drops or moves one of
these seams; `update.sh` runs it with the other extension tests.

If an extension needs an upstream internal, re-export it from a `t3.ts` inside the extension.
If upstream moves code a host edit depends on, re-apply it in a new commit whose subject starts
with `feat(fork): extension host` (the rule accepts the files of every such commit).

## For teammates

- **Install:** download from https://github.com/sethhen/t3code/releases/latest - the `.dmg` on
  an Apple Silicon Mac, the `.exe` on Windows. It replaces official T3 Code and shares its data
  (threads, settings, connections).
- **First launch on a Mac:** macOS says it can't verify the app. Click **Done**, then open
  System Settings → Privacy & Security, scroll down to "T3 Code (Alpha) was blocked" and click
  **Open Anyway** (then enter your Mac password). Once. If macOS asks for Keychain access
  ("t3code Safe Storage"), choose **Always Allow**.
- **First launch on Windows:** if SmartScreen blocks the installer, click **More info → Run
  anyway** (once). PCs with Smart App Control turned on block unsigned apps outright.
- **Claude and Codex accounts:** Settings → Providers → **Accounts**. **Add account** next to
  Claude or Codex signs in with Claude's or OpenAI's own sign-in in your browser (sign the browser
  in to the account you want first) and adds it as its own account; the ⋯ menu pauses or removes
  one, and **Sign in again** brings back one that was signed out. The first account in an unsigned `~/.claude` / `~/.codex` becomes your main one, which the
  `claude` / `codex` commands use. Each thread uses the account you pick in the model picker. When
  an account hits its usage limit, the thread offers **Continue on…**: pick another of your accounts
  and the thread carries on there. Nothing switches on its own. The usual provider settings are
  under **More provider settings**. Open **Usage** from the sidebar for token and cost history, or
  **Usage → Limits** for subscription quotas. **Keep model training off** (top of Accounts) checks
  each Claude account daily and turns "Help improve Claude" off; each Codex account links to
  ChatGPT's Data controls (OpenAI doesn't let apps change it). Codex accounts show their banked
  resets, and **Use session reset…** in a Claude account's ⋯ menu runs Claude Code's own
  `/limit-reset`. Flipping the switch restarts running Claude and Codex agents.
- **Signing in** on desktop: use email, Google, GitHub, Apple or Microsoft. Passkeys are not
  available in fork builds.
- **Updates:** an update button appears in the sidebar. Click it to download, click it again to
  restart into the new version. Keep Settings → **Update track** on **Stable** (the default):
  on Nightly the app ignores fork releases.
- **Going back:** close any Skills & MCP tab first (official T3 Code shows it as a blank tab), then
  install official T3 Code from https://github.com/pingdotgg/t3code/releases, at least the
  fork's X.Y.Z.

## For the maintainer

`source scripts/fork/env.sh` before any `pnpm`/`git` write (Node 24 + pnpm 11), and commit,
merge and push with `fork_git` (see Traps).

- **Ship:** commit to `main` and `fork_git push origin main`, then watch "Fork release" in
  [Actions](https://github.com/sethhen/t3code/actions). Every push to `main` publishes a release.
- **Dry run:** run "Fork release" manually (Actions -> Fork release -> Run workflow) with publish
  off. Pushes also run as dry runs while the signing secrets are missing.
- **Signing:** macOS builds are signed with the fork's self-signed certificate
  (`scripts/fork/self-signed-cert.sh`; the key lives in `~/.config/wingman/signing/` and in
  1Password). Apple Developer ID / Azure signing are optional upgrades: `scripts/fork/SIGNING.md`.
- **Update T3 Code:**

  ```bash
  scripts/fork/update.sh --check          # read-only: base tag, target tag, blockers
  scripts/fork/update.sh                  # latest upstream stable release, or: update.sh v0.0.43
  ```

  It fetches the tag, merges it into `main` (`chore(fork): merge upstream vX.Y.Z`), enforces the
  one rule, runs `pnpm install`, typechecks contracts/server/web and the extension tests, then
  pushes `main` + the tag (this ships) and runs `scripts/fork/workflows.sh`. `--no-push` stops
  before shipping. On a conflict the merge stays in progress: fix the files, `git add` them,
  `fork_git commit --no-verify -m "chore(fork): merge upstream vX.Y.Z"`, re-run with the same tag
  (or `git merge --abort`).

- **Workflows:** `scripts/fork/workflows.sh` disables every workflow except `fork-release.yml`
  and the reusable `release-desktop.yml`. Run it after any merge of upstream.
- **Local test build:** `scripts/fork/update.sh --build` also builds
  `release/T3-Code-X.Y.Z-wingman.0-arm64.dmg` (unsigned, no update feed, T3 Connect config from
  `scripts/fork/connect.env`; needs Xcode CLT and
  `brew install rustup && rustup-init -y && rustup target add aarch64-apple-darwin`). Quit
  T3 Code, then `scripts/fork/install.sh [dmg]`: it refuses while the app runs, checks the bundle
  and that its X.Y.Z is not older than the installed app's, backs up the app and
  `~/.t3/userdata` (+ the Chromium profile) to `~/Applications/T3 Code backups/`, ad-hoc signs,
  swaps it in and prints the rollback commands. Return to the release builds by installing the
  latest release DMG.

## Accounts

`apps/server/src/extensions/pool/`, `apps/web/src/extensions/pool/` (extension id `pool`, kept from
the account pool this replaced) and `apps/web/src/extensions/continueOn/`. Every Claude and Codex
account is an ordinary provider instance; the section is a front end for T3's own instances and
their snapshots (email, plan, quota). The pool ran a local CLIProxyAPI that held several
subscription sign-ins and rotated between them; Anthropic forbids tools that collect, store or
intermediate claude.ai credentials, and OpenAI forbids rotating or pooling accounts to get around
usage limits. So the line is: the provider's own CLI holds each sign-in, the user picks the
account, and nothing switches accounts automatically.

- **Sign-ins** run on the server: `claude auth login` with the account's own `CLAUDE_CONFIG_DIR`
  (its Keychain item is named after that path, so an account dir is never renamed or moved), or
  `codex login` with `CODEX_HOME` set to a shadow home on the shared Codex home (a separate home
  where symlinks aren't allowed, e.g. Windows without Developer Mode). Only the expected account is
  kept; a wrong one is signed out again (in a default home only when it is an account T3 already
  has, so the main home stays as it was). Claude sign-ins are refused while
  `settings.json` makes Claude Code use an API key helper or token instead of a subscription.
- **Claude account dirs** (`~/.claude-<email-slug>`, `~/.claude-account-<hex>`) link
  `settings.json`, `CLAUDE.md`, `skills`, `agents`, `commands`, `plugins` and `output-styles` from
  the main config dir (`~/.claude`, or the default instance's) and get its MCP servers once. Their
  `.t3-account` marker names that main dir. When the instance is built, `claudeHistory.ts` links
  their `projects/` and `plans/` to the main dir's, and keys their continuation group on that
  shared store, so threads move between Claude accounts like Codex shadow homes do. What an
  account already had is merged in without overwriting: a differing file is kept as
  `<name>.from-<dir>`, and anything that can't move stays in `<dir>/projects.unmerged-<time>`. Dirs
  without a marker are only touched when the instance is a `claude_<hash>` one T3 made in
  `~/.claude-*`.
- **Continue on…**: a composer banner when the thread's account hits a usage limit; the user picks
  another account with the same continuation key and the thread continues there ("Continue where
  you left off."). Claude Code drops the other account's thinking and re-reads the thread once.
- **Pool leftovers**: at server start the extension kills a leftover proxy, saves the accounts the
  pool held to `<stateDir>/pool-move.json` (listed until signed in or skipped) and deletes
  `<stateDir>/pool/` and the `cliproxy-t3-pool` usage source.

- **Model training and resets**: Claude's "Help improve our AI models" and its session limit
  reset have no API a tool may call with the account's token, so `claudeTerminal.ts` runs the
  unmodified interactive `claude` in a PTY (cwd `<stateDir>/claude-privacy`, refused inside a git
  repository since Claude Code would trust the whole repo) and drives its own `/privacy-settings`
  and `/limit-reset` screens. It answers only the trust prompt for that folder and the Chrome
  offer's default, stops at anything else (first-run setup, a login step or updated terms are the
  user's to answer), verifies a change in a fresh process, and reports a reset as used, not used or
  unknown. Account dirs T3 made get `hasCompletedOnboarding` so first-run setup never shows. With
  **Keep model training off** on, every Claude account is checked daily (and when added), Codex
  instances get `-c feedback.enabled=false` and Claude ones `DISABLE_BUG_COMMAND=1` and
  `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1` through an instance overlay, applied by a reconcile
  trigger in the settings watcher (never by rewriting `settings.json`). ChatGPT's training setting
  has no API at all, so Codex rows only link to it and remember what the user says. Upstream's
  Claude reset path (`claudeResetCredits.ts`, which reads the OAuth token) is disabled in
  `ClaudeDriver.ts`, and `hostSeams.test.ts` fails if any other server file reaches for that token.
  After a Claude Code update, check the screens still match: the tests' fake TUI mirrors them.

Limits: Codex's sign-in only finishes in a browser on the machine running T3 (its callback is that
machine's localhost); Claude's also takes a pasted code. A thread whose account was removed can't
move until the account is added again (same instance id). Mobile has none of this. After a Claude
Code update, check that resume still reads `<config dir>/projects/` (search its binary for
`"projects"`), or the shared key would point at a store Claude Code no longer uses.

Of the older seams, only `instanceOverlays.ts` has nothing registered now; `claudeSettings.ts`
still keeps a `--settings` launch argument the SDK would drop, and the CodexProvider skip still
covers API-key Codex. Removing a seam is a `feat(fork): extension host` commit plus `update.sh`'s
host list.

## Traps

- **Merge upstream stable tags only** (`update.sh` refuses anything else). Never upstream
  `main`, `-nightly` or `-preview`: the fork shares `~/.t3/userdata` with official T3 Code, and
  DB migrations ahead of a stable release stop official builds from opening it, so nobody could
  go back.
- **Versions only go up.** Never merge an older tag, and do not install a fork build whose X.Y.Z
  is older than the T3 Code already installed (its database may be migrated past it). In semver
  `0.0.42-wingman.3 < 0.0.42 < 0.0.43-wingman.1`; the updater only moves to a higher version and
  reads GitHub's "latest" release, so never mark fork releases as pre-releases.
- **New upstream workflows arrive enabled** with a merge, and the push that brings them may already
  start them: run `scripts/fork/workflows.sh` (update.sh does) and cancel stray runs.
- **The bundle id `com.t3tools.t3code` belongs to T3's Apple team**, so fork builds are signed by
  another team and cannot carry the passkey entitlement (hence no desktop passkeys), and macOS asks
  for the Keychain item again after switching between official and fork builds.
- **Commit, merge and push with `fork_git`**, not `git`: the global husky init puts an old Node on
  PATH and the `vp staged` pre-commit hook fails under it.
- Never keep an unzipped copy of the app outside `/Applications` (e.g. an extracted backup):
  `t3code://` links (sign-in callback) may open that copy instead.
- **The repo is public: never commit a secret** (API keys, OAuth/refresh tokens, proxy auth files,
  `.p12`/`.p8`). A pushed secret is leaked even on a branch and even if reverted: rotate it. Three
  guards: GitHub push protection (known key formats, server-side), `scripts/fork/secret-scan.sh`
  (gitleaks + `scripts/fork/gitleaks.toml`, run by `update.sh` before pushing; run it yourself before
  pushing any branch), and the release workflow's secret scan, which blocks publishing.
- **Publishing is guarded** by `scripts/fork/release-guard.sh` (plan job and right before promotion):
  it refuses a version older than Latest (e.g. re-running an old run), a macOS certificate change, an
  unsigned Windows build after a signed one, and fails closed if the Latest release can't be read.
- **Never lose or replace the macOS certificate.** Installed Macs only accept updates signed by the
  certificate they were installed with; a new one (including a later move to Developer ID) means
  every Mac reinstalls from the DMG once. The workflow refuses a change unless run manually with
  `allow_mac_signer_change`.
- **Never rename or recreate `fork-release.yml`.** The version's `.N` is the workflow's run number,
  which restarts at 1 for a new workflow; installed copies would then never see a newer version.
- A `-nightly` version renames the app to `T3 Code (Nightly)`; fork versions must stay
  `X.Y.Z-wingman.N`.
