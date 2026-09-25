#!/usr/bin/env bash
# Move the `wingman` fork branch onto an upstream stable T3 Code release, verify it,
# build an unsigned macOS arm64 DMG without an update feed and push the branch.
#
# Usage: scripts/fork/update.sh [--check] [--no-push] [vX.Y.Z]
#   vX.Y.Z     upstream stable tag to move to (default: latest GitHub release)
#   --check    read-only: report base tag, target tag and blockers, change nothing
#   --no-push  do everything except pushing to origin
#
# Re-running with the same tag after a finished rebase skips the rebase and continues
# with install/typecheck/tests/build/push. Never use main, -nightly or -preview tags.
# See FORK.md.
set -euo pipefail

BRANCH=wingman
UPSTREAM_REMOTE=upstream
UPSTREAM_REPO=pingdotgg/t3code
ORIGIN_REMOTE=origin
HOST_COMMIT_SUBJECT="feat(fork): extension host"
INSTALLED_APP="/Applications/T3 Code (Alpha).app"
RUST_TARGET=aarch64-apple-darwin
STABLE_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'

CHECK=0
PUSH=1
TAG_ARG=""
BLOCKERS=""

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}
# Fatal outside --check; in --check it is collected and reported at the end.
block() {
  if [ "$CHECK" = 1 ]; then
    BLOCKERS="${BLOCKERS}  - $*"$'\n'
    printf 'BLOCKER: %s\n' "$*" >&2
  else
    die "$*"
  fi
}
run() {
  printf '    $ %s\n' "$*"
  "$@"
}
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
# version_lt A B: A < B (plain X.Y.Z versions).
version_lt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | sed -n 1p)" = "$1" ]
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --no-push) PUSH=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *)
      [ -z "$TAG_ARG" ] || die "only one tag argument is allowed"
      TAG_ARG="$1"
      ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

step "Environment"
# shellcheck source=scripts/fork/env.sh
source "$REPO_ROOT/scripts/fork/env.sh" || die "scripts/fork/env.sh failed (Node 24 missing?)"
info "repo:  $REPO_ROOT"
info "node:  $(node --version)   pnpm: $(pnpm --version)"
[ "$CHECK" = 1 ] && info "mode:  --check (read-only)"

step "Working tree"
for state in rebase-merge rebase-apply; do
  if [ -e "$(git rev-parse --git-path "$state")" ]; then
    block "a rebase is in progress: resolve the conflicts, 'git add' them, 'fork_git rebase --continue' (or 'git rebase --abort'), then re-run $0 with the same tag"
  fi
done
CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD || echo '(detached HEAD)')"
info "branch: $CURRENT_BRANCH"
[ "$CURRENT_BRANCH" = "$BRANCH" ] || block "check out '$BRANCH' first (currently on $CURRENT_BRANCH)"
if git diff --quiet && git diff --cached --quiet; then
  info "no uncommitted changes to tracked files"
else
  block "tracked files have uncommitted changes; commit them (fork_git commit) so the build matches the pushed branch:"$'\n'"$(git status --short --untracked-files=no | sed 's/^/      /')"
fi
UNTRACKED_COUNT="$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')"
[ "$UNTRACKED_COUNT" = 0 ] || warn "$UNTRACKED_COUNT untracked file(s) present; they are not part of the branch (git status --short)"

step "Current base of $BRANCH"
OLD_BASE="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-*' "$BRANCH" 2>/dev/null)" ||
  die "no stable vX.Y.Z tag is reachable from $BRANCH"
[[ "$OLD_BASE" =~ $STABLE_TAG_RE ]] || die "unexpected base tag '$OLD_BASE'"
FORK_COUNT="$(git rev-list --count "$OLD_BASE..$BRANCH")"
# Commits of the branch that no upstream ref or release tag contains: must be exactly the
# fork commits, otherwise the branch carries upstream commits newer than its base tag.
OWN_COUNT="$(git rev-list --count "$BRANCH" --not --remotes="$UPSTREAM_REMOTE" --tags='v*')"
info "base tag: $OLD_BASE   fork commits: $FORK_COUNT"
[ "$FORK_COUNT" = "$OWN_COUNT" ] ||
  block "$BRANCH has $FORK_COUNT commits after $OLD_BASE but only $OWN_COUNT are fork-only; it contains upstream commits beyond $OLD_BASE (merged main/nightly?), so '$OLD_BASE' is not a safe rebase base"
MERGES="$(git rev-list --merges "$OLD_BASE..$BRANCH")"
[ -z "$MERGES" ] || block "fork commits include merge commits; rebase would flatten them: $MERGES"
git log --reverse --no-decorate --format='      %h %s' "$OLD_BASE..$BRANCH"

step "Upstream files edited by fork commits"
HOST_SEEN=0
while IFS= read -r line; do
  sha="${line%% *}"
  subject="${line#* }"
  touched="$(git diff-tree --no-commit-id -r --name-only "$sha" | while IFS= read -r file; do
    if git cat-file -e "$OLD_BASE:$file" 2>/dev/null; then printf '%s\n' "$file"; fi
  done)"
  [ -n "$touched" ] || continue
  case "$subject" in
    "$HOST_COMMIT_SUBJECT"*) HOST_SEEN=1 ;;
    *) warn "'$subject' edits upstream files; only the '$HOST_COMMIT_SUBJECT' commit should (FORK.md)" ;;
  esac
  info "${sha:0:9} $subject"
  while IFS= read -r file; do
    if git grep -q -e t3-ext "$BRANCH" -- "$file"; then
      info "  $file"
    else
      warn "$file is edited by ${sha:0:9} but has no t3-ext marker"
    fi
  done <<<"$touched"
done < <(git log --reverse --format='%H %s' "$OLD_BASE..$BRANCH")
[ "$HOST_SEEN" = 1 ] || warn "no '$HOST_COMMIT_SUBJECT' commit edits upstream files"

ORIGIN_SHA="$(git rev-parse --verify --quiet "refs/remotes/$ORIGIN_REMOTE/$BRANCH" || true)"
if [ -z "$ORIGIN_SHA" ]; then
  info "$ORIGIN_REMOTE/$BRANCH: not known locally (first push)"
elif git merge-base --is-ancestor "$ORIGIN_SHA" "$BRANCH"; then
  info "$ORIGIN_REMOTE/$BRANCH (${ORIGIN_SHA:0:9}) is contained in $BRANCH"
elif git reflog show --format=%H "$BRANCH" 2>/dev/null | grep -x "$ORIGIN_SHA" >/dev/null; then
  info "$ORIGIN_REMOTE/$BRANCH (${ORIGIN_SHA:0:9}) is an earlier local tip; the force-push replaces it"
else
  block "$ORIGIN_REMOTE/$BRANCH (${ORIGIN_SHA:0:9}) has commits the local $BRANCH never had; reconcile before force-pushing"
fi

step "Target release"
if [ -n "$TAG_ARG" ]; then
  TAG="$TAG_ARG"
  info "from argument: $TAG"
else
  command -v gh >/dev/null 2>&1 || die "gh is not installed; pass the tag explicitly (update.sh vX.Y.Z)"
  TAG="$(gh api "repos/$UPSTREAM_REPO/releases/latest" --jq .tag_name)" ||
    die "could not read the latest release of $UPSTREAM_REPO; pass the tag explicitly"
  info "latest $UPSTREAM_REPO release: $TAG"
fi
case "$TAG" in v*) ;; *) TAG="v$TAG" ;; esac
[[ "$TAG" =~ $STABLE_TAG_RE ]] ||
  die "'$TAG' is not a stable release tag (vX.Y.Z); main, -nightly and -preview are not allowed (FORK.md)"
if command -v gh >/dev/null 2>&1 &&
  release_flags="$(gh api "repos/$UPSTREAM_REPO/releases/tags/$TAG" --jq '"\(.prerelease) \(.draft)"' 2>/dev/null)"; then
  [ "$release_flags" = "false false" ] || block "GitHub release $TAG is a prerelease or draft ($release_flags)"
  info "GitHub release $TAG: stable"
else
  warn "could not confirm that $TAG is a published stable GitHub release"
fi

if [ "$CHECK" = 1 ]; then
  REMOTE_REFS="$(git ls-remote --tags "$UPSTREAM_REMOTE" "refs/tags/$TAG" "refs/tags/$TAG^{}")" ||
    block "could not list tags of $UPSTREAM_REMOTE"
  # Annotated tags have a peeled `^{}` line pointing at the commit; lightweight ones do not.
  REMOTE_SHA="$(printf '%s\n' "${REMOTE_REFS:-}" |
    awk -v t="refs/tags/$TAG" '$2 == t "^{}" { p = $1 } $2 == t { s = $1 } END { print (p != "" ? p : s) }')"
  [ -n "$REMOTE_SHA" ] || block "$UPSTREAM_REMOTE has no tag $TAG"
  LOCAL_SHA="$(git rev-parse --verify --quiet "refs/tags/$TAG^{commit}" || true)"
  if [ -z "$LOCAL_SHA" ]; then
    info "$TAG not fetched yet (upstream: ${REMOTE_SHA:0:9}); a real run fetches it"
  elif [ -n "$REMOTE_SHA" ] && [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
    block "local tag $TAG (${LOCAL_SHA:0:9}) differs from $UPSTREAM_REMOTE (${REMOTE_SHA:0:9})"
  else
    info "$TAG: ${LOCAL_SHA:0:9} (matches $UPSTREAM_REMOTE)"
  fi
else
  run fork_git fetch --tags "$UPSTREAM_REMOTE"
  LOCAL_SHA="$(git rev-parse --verify --quiet "refs/tags/$TAG^{commit}")" || die "$UPSTREAM_REMOTE has no tag $TAG"
  info "$TAG: ${LOCAL_SHA:0:9}"
fi
if [ -n "$LOCAL_SHA" ] && ! git merge-base --is-ancestor "$OLD_BASE" "$LOCAL_SHA"; then
  warn "$OLD_BASE is not an ancestor of $TAG; expect a larger rebase"
fi

VERSION="${TAG#v}"
OLD_VERSION="${OLD_BASE#v}"
INSTALLED_VERSION=""
if [ -f "$INSTALLED_APP/Contents/Info.plist" ]; then
  INSTALLED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INSTALLED_APP/Contents/Info.plist" 2>/dev/null || true)"
fi
info "installed app: ${INSTALLED_VERSION:-none}   fork base: $OLD_VERSION   target: $VERSION"
if [ -n "$INSTALLED_VERSION" ] && version_lt "$VERSION" "$INSTALLED_VERSION"; then
  block "$TAG is older than the installed app ($INSTALLED_VERSION): its DB would already be migrated past $TAG"
fi
version_lt "$VERSION" "$OLD_VERSION" && block "$TAG is older than the current base $OLD_BASE"
REBASE=1
if [ "$VERSION" = "$OLD_VERSION" ]; then
  REBASE=0
  info "$BRANCH is already based on $TAG: no rebase, rebuild only"
fi

step "Desktop build prerequisites"
MISSING=""
command -v cargo >/dev/null 2>&1 || MISSING="$MISSING cargo"
RUST_LIBDIR="$(rustc --print target-libdir --target "$RUST_TARGET" 2>/dev/null || true)"
if [ -z "$RUST_LIBDIR" ] || ! compgen -G "$RUST_LIBDIR/libstd-*.rlib" >/dev/null; then
  MISSING="$MISSING rust-target:$RUST_TARGET"
fi
for tool in clang make sips hdiutil; do
  command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"
done
xcrun --find iconutil >/dev/null 2>&1 || MISSING="$MISSING iconutil"
if [ -n "$MISSING" ]; then
  block "missing build tools:$MISSING. Install Xcode CLT (xcode-select --install) and Rust (brew install rustup && rustup-init -y && rustup target add $RUST_TARGET)"
else
  info "cargo, $RUST_TARGET std, clang, make, sips, iconutil, hdiutil: ok"
fi

if [ "$CHECK" = 1 ]; then
  step "Check summary"
  info "base $OLD_BASE -> target $TAG ($([ "$REBASE" = 1 ] && echo "rebase $FORK_COUNT fork commits" || echo "no rebase"))"
  info "artifact would be: $REPO_ROOT/release/T3-Code-$VERSION-arm64.dmg"
  if [ -n "$BLOCKERS" ]; then
    printf '\nBlockers:\n%s' "$BLOCKERS"
    exit 1
  fi
  info "no blockers"
  exit 0
fi

if [ "$REBASE" = 1 ]; then
  OLD_TIP="$(git rev-parse "$BRANCH")"
  step "Rebasing $FORK_COUNT fork commits from $OLD_BASE onto $TAG"
  info "undo afterwards with: git reset --hard $OLD_TIP   (on $BRANCH)"
  if ! run fork_git rebase --onto "$TAG" "$OLD_BASE" "$BRANCH"; then
    CONFLICTS="$(git diff --name-only --diff-filter=U || true)"
    printf '\nREBASE STOPPED on conflicts in:\n%s\n' "$(printf '%s\n' "${CONFLICTS:-  (none listed; see git status)}" | sed 's/^/  /')" >&2
    cat >&2 <<EOF

Upstream edits touching fork code are marked 't3-ext' (FORK.md). Then:
  1. fix the files above and 'git add' them
  2. source scripts/fork/env.sh && fork_git rebase --continue
  3. scripts/fork/update.sh $TAG      (continues with install, checks, build and push)
Give up instead:  git rebase --abort    (back to $OLD_TIP)
EOF
    exit 1
  fi
  NEW_BASE="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-*' "$BRANCH")"
  [ "$NEW_BASE" = "$TAG" ] || die "after the rebase the base is $NEW_BASE, expected $TAG"
  NEW_COUNT="$(git rev-list --count "$TAG..$BRANCH")"
  [ "$NEW_COUNT" = "$FORK_COUNT" ] || warn "$FORK_COUNT fork commits became $NEW_COUNT (emptied commits were dropped)"
  git log --reverse --no-decorate --format='      %h %s' "$TAG..$BRANCH"
fi

step "pnpm install"
run pnpm install --frozen-lockfile ||
  die "pnpm install failed; if pnpm-lock.yaml is stale after the rebase run 'pnpm install', commit the lockfile with fork_git and re-run"

typecheck() {
  local dir="$1" out status=0 errors
  step "Typecheck $dir"
  info "$ (cd $dir && pnpm exec tsc --noEmit) | grep 'error TS'"
  out="$(cd "$REPO_ROOT/$dir" && pnpm exec tsc --noEmit 2>&1)" || status=$?
  errors="$(printf '%s\n' "$out" | grep 'error TS' || true)"
  if [ -n "$errors" ]; then
    printf '%s\n' "$errors" | sed -n '1,60p' >&2
    die "typecheck failed in $dir ($(printf '%s\n' "$errors" | wc -l | tr -d ' ') errors)"
  fi
  if [ "$status" != 0 ]; then
    printf '%s\n' "$out" | tail -n 20 >&2
    die "tsc exited with $status in $dir"
  fi
  info "ok"
}
typecheck packages/contracts
typecheck apps/server
typecheck apps/web

step "Extension tests"
(cd packages/contracts && run pnpm exec vp test run --passWithNoTests src/extensions) || die "contracts extension tests failed"
(cd apps/server && run pnpm exec vp test run --passWithNoTests src/extensions) || die "server extension tests failed"
(cd apps/web && run pnpm exec vp test run --passWithNoTests --project unit src/extensions) || die "web extension tests failed"

step "Building unsigned macOS arm64 DMG $VERSION (no update feed)"
DMG="$REPO_ROOT/release/T3-Code-$VERSION-arm64.dmg"
[ ! -e "$DMG" ] || info "replacing existing $DMG"
(
  # No update feed (no app-update.yml, auto-update off) and no signing/notarization.
  unset T3CODE_DESKTOP_UPDATE_REPOSITORY GITHUB_REPOSITORY T3CODE_DESKTOP_SIGNED \
    T3CODE_DESKTOP_MOCK_UPDATES T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT T3CODE_DESKTOP_OUTPUT_DIR \
    T3CODE_DESKTOP_VERSION T3CODE_DESKTOP_PLATFORM T3CODE_DESKTOP_TARGET T3CODE_DESKTOP_ARCH \
    T3CODE_DESKTOP_SKIP_BUILD T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR T3CODE_DESKTOP_KEEP_STAGE
  run node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --build-version "$VERSION"
) || die "desktop build failed (re-run with T3CODE_DESKTOP_VERBOSE=true for details)"
[ -f "$DMG" ] || die "build finished but $DMG is missing (see release/)"
info "artifact: $DMG"

if [ "$PUSH" = 1 ]; then
  step "Pushing $BRANCH to $ORIGIN_REMOTE"
  run fork_git push --force-with-lease "$ORIGIN_REMOTE" "$BRANCH"
else
  step "Skipping push (--no-push)"
fi

step "Done"
info "DMG: $DMG"
info "Next: quit T3 Code, then run: scripts/fork/install.sh \"$DMG\""
