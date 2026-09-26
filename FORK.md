# Wingman fork of T3 Code

Private fork (`sethhen/t3code`, remote `origin`) of `pingdotgg/t3code` (remote `upstream`).
Branch `wingman` = one upstream **stable tag** + a short stack of fork commits
(`git log --oneline <tag>..wingman`). The fork adds right-panel "extensions" (Skills & MCP, ...)
and is installed over the official desktop app as an unsigned, non-updating build.

## The one rule: upstream files are touched by one commit only

Only the `feat(fork): extension host ...` commit edits upstream files (`update.sh` refuses to
run while another commit does). Every edit in it is marked with a `t3-ext` comment so a rebase
conflict is easy to recognise. Touch points:

| File                                         | What the fork adds                                                   |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `packages/contracts/src/rpc.ts`              | `WS_METHODS.extensionCall` (`extension.call`) + `WsExtensionCallRpc` |
| `packages/contracts/src/index.ts`            | `export * from "./extensions/index.ts"`                              |
| `apps/server/src/ws.ts`                      | builds the extension registry, handles `extension.call`              |
| `apps/server/src/auth/RpcAuthorization.ts`   | scope for `extension.call`                                           |
| `apps/web/src/rightPanelStore.ts`            | `extension` surface kind + `openExtension`                           |
| `apps/web/src/components/RightPanelTabs.tsx` | extension entries in the add-tab menu, label/icon                    |
| `apps/web/src/components/ChatView.tsx`       | renders `ExtensionSurface`                                           |

Find them with `git grep -n t3-ext -- apps/server apps/web/src packages/contracts`
(`apps/mobile` has unrelated `font-t3-extrabold` matches). Everything else lives in fork-only
directories, so new extensions never touch upstream files:

- `packages/contracts/src/extensions/` - schemas (`host.ts` + one file per extension, `index.ts` barrel)
- `apps/server/src/extensions/` - server handlers (`registry.ts`, `index.ts` registers extensions)
- `apps/web/src/extensions/` - panels (`registry.ts`, `ExtensionSurface.tsx`)

If an extension needs an upstream internal, re-export it from a `t3.ts` inside the extension
rather than editing the upstream file.

## Prerequisites

- `source scripts/fork/env.sh` before any `pnpm`/`git` write (Node 24 + pnpm 11, defines `fork_git`).
- Xcode Command Line Tools (`clang`, `make`, `iconutil`) and Rust:
  `brew install rustup && rustup-init -y && rustup target add aarch64-apple-darwin`
  (the desktop build compiles `native/resource-monitor` with cargo).

## Update to a new upstream release

```bash
scripts/fork/update.sh --check          # read-only: base tag, target tag, blockers
scripts/fork/update.sh                  # latest stable release, or: update.sh v0.0.43
```

It fetches upstream tags, rebases `wingman` with `git rebase --onto <new> <old> wingman`,
runs `pnpm install`, typechecks contracts/server/web, runs the extension tests, builds an
unsigned arm64 DMG without an update feed (`release/T3-Code-<version>-arm64.dmg`) and pushes
`wingman` with `--force-with-lease` on the `origin/wingman` commit it checked before the rebase
(`--no-push` to skip). On a conflict it stops and lists the files: fix them, `git add`,
`fork_git rebase --continue`, then re-run `update.sh <tag>` (the base is then already the new
tag, so it continues with install/build). Undo a finished rebase with the
`git reset --hard <old tip>` it prints.

## Install and roll back

Quit T3 Code, then `scripts/fork/install.sh [path/to/dmg-or-app]` (defaults to the newest DMG
in `release/`). It refuses while the app runs (it never kills anything) and checks the build is
`T3 Code (Alpha)` / `com.t3tools.t3code`, arm64, has no `app-update.yml` and is not older than
the installed version. Backups go to `~/Applications/T3 Code backups/`:

- `T3 Code (Alpha) official-<ver>.zip` - the official bundle, kept forever;
  `T3 Code (Alpha) fork-<ver>-<ts>.zip` - the fork build being replaced, only the latest kept.
  Bundles are zipped (`ditto -c -k`) on purpose: an unzipped copy is a second
  `com.t3tools.t3code` that LaunchServices could open for `t3code://` links.
- `userdata-<ts>-<official|fork>-<ver>/` - `~/.t3/userdata` (every top-level `*.sqlite` via
  `sqlite3 -readonly ... "VACUUM INTO ..."`, or an `immutable=1` open when the database has no
  pending log, + `quick_check`; the rest copied without `-wal`/`-shm` and without `logs/`) and
  the Chromium profile
  (`~/Library/Application Support/t3code`, caches excluded). Backups taken over an official
  app are kept forever, otherwise the newest 3.

It then stages the new bundle in `/Applications`, clears quarantine, ad-hoc signs it if the
unsigned build's signature does not verify, swaps it in as `/Applications/T3 Code (Alpha).app`
(restoring the old bundle if the swap fails, or printing where it is kept), opens it and prints
the rollback commands.

Rollback: close any Skills & MCP tab first (the official app shows it as a blank tab, which you
can close), quit T3 Code, then:

```bash
rm -rf "/Applications/T3 Code (Alpha).app"   # ditto merges into an existing bundle: remove first
ditto -x -k "$HOME/Applications/T3 Code backups/T3 Code (Alpha) official-<ver>.zip" /Applications
```

If the fork ran on a newer tag than that official bundle, its DB migrations may be ahead:
either install the official DMG of the fork's tag from https://github.com/pingdotgg/t3code/releases
(keeps your data), or also move `~/.t3/userdata` aside and `ditto` the `userdata/` folder of the
matching `userdata-*-official-<ver>` backup back (loses changes made since).

## Traps

- **Stable tags only, at or above the installed version.** Never rebase onto `main`, a
  `-nightly` or a `-preview` tag: the fork shares `~/.t3/userdata` with the official app, and
  newer DB migrations stop the official app from opening it again.
- **Commit, rebase and push with `fork_git`**, not `git`: the global husky init puts an old Node
  on PATH and the `vp staged` pre-commit hook fails under it.
- **GitHub Actions stay disabled on the fork** (upstream workflows would publish releases).
- Fork builds are unsigned: macOS asks for the "t3code Safe Storage" Keychain item on first
  launch (Always Allow; it asks again after each rebuild) and privacy permissions must be
  granted again. Denying the Keychain prompt makes saved connections unreadable.
- Fork builds contain no `app-update.yml`, so they never auto-update to the official release;
  reinstalling the official DMG (or the backup zip) is how you leave the fork.
- Never keep an unzipped copy of the app outside `/Applications` (e.g. an extracted backup):
  `t3code://` links (sign-in callback) may open that copy instead.
- The desktop build needs a stable version: a `-nightly` version renames the app to
  `T3 Code (Nightly)`, which `install.sh` refuses.
