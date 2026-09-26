#!/usr/bin/env bash
# Merge an upstream stable T3 Code release into the fork's `main`, verify it and push.
# The push to `main` runs .github/workflows/fork-release.yml, which builds, signs and
# publishes X.Y.Z-wingman.<run> (FORK.md).
#
# Usage: scripts/fork/update.sh [--check] [--build] [--no-push] [vX.Y.Z]
#   vX.Y.Z     upstream stable tag to merge (default: latest pingdotgg/t3code release)
#   --check    read-only: report base, target and blockers, change nothing
#   --build    also build a local unsigned test DMG (X.Y.Z-wingman.0, no update feed) for
#              scripts/fork/install.sh
#   --no-push  do everything except pushing
#
# On a conflict the merge is left in progress: fix the files, `git add` them, commit with
# `fork_git commit --no-verify -m "chore(fork): merge upstream vX.Y.Z"` (--no-verify: the
# formatter hook would run over every file the merge brings in), then re-run with the same tag.
# Never main, -nightly or -preview.
set -euo pipefail

BRANCH=main
UPSTREAM_REMOTE=upstream
UPSTREAM_REPO=pingdotgg/t3code
ORIGIN_REMOTE=origin
HOST_COMMIT_SUBJECT="feat(fork): extension host"
FORK_PATHS_RE='^(packages/contracts/src/extensions/|apps/server/src/extensions/|apps/web/src/extensions/|scripts/fork/|FORK\.md$|\.github/workflows/fork-release\.yml$)'
STABLE_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'
RUST_TARGET=aarch64-apple-darwin

CHECK=0
BUILD=0
PUSH=1
TAG=""
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
  [ "$CHECK" = 1 ] || die "$*"
  BLOCKERS="${BLOCKERS}  - $*"$'\n'
  printf 'BLOCKER: %s\n' "$*" >&2
}
run() {
  printf '    $ %s\n' "$*"
  "$@"
}
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
version_lt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | sed -n 1p)" = "$1" ]; }
# Highest stable vX.Y.Z tag contained in HEAD.
base_tag() { git tag --merged HEAD --list 'v*' | grep -E "$STABLE_TAG_RE" | sort -V | tail -n 1 || true; }
upstream_paths() { grep -Ev "$FORK_PATHS_RE" | grep -v '^$' | sort -u || true; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --build) BUILD=1 ;;
    --no-push) PUSH=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *)
      [ -z "$TAG" ] || die "only one tag argument is allowed"
      TAG="$1"
      ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

step "Environment"
# shellcheck source=scripts/fork/env.sh
source "$REPO_ROOT/scripts/fork/env.sh" || die "scripts/fork/env.sh failed (Node 24 missing?)"
info "node $(node --version), pnpm $(pnpm --version)$([ "$CHECK" = 1 ] && echo ', --check (read-only)')"

step "Working tree"
[ ! -e "$(git rev-parse --git-path MERGE_HEAD)" ] ||
  block "a merge is in progress: fix the conflicts, 'git add' them, 'fork_git commit --no-verify -m \"chore(fork): merge upstream <tag>\"' (or 'git merge --abort'), then re-run $0 with the same tag"
for state in rebase-merge rebase-apply; do
  [ ! -e "$(git rev-parse --git-path "$state")" ] || block "a rebase is in progress; finish or abort it first"
done
CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD || echo '(detached HEAD)')"
[ "$CURRENT_BRANCH" = "$BRANCH" ] || block "check out '$BRANCH' first (currently on $CURRENT_BRANCH)"
if git diff --quiet && git diff --cached --quiet; then
  info "on $BRANCH, no uncommitted changes to tracked files"
else
  block "tracked files have uncommitted changes; commit them (fork_git commit) first:"$'\n'"$(git status --short --untracked-files=no | sed 's/^/      /')"
fi

step "$ORIGIN_REMOTE/$BRANCH"
[ "$CHECK" = 1 ] || run fork_git fetch "$ORIGIN_REMOTE" "$BRANCH"
if ORIGIN_SHA="$(git rev-parse --verify --quiet "refs/remotes/$ORIGIN_REMOTE/$BRANCH")"; then
  if git merge-base --is-ancestor "$ORIGIN_SHA" HEAD; then
    info "${ORIGIN_SHA:0:9} is contained in HEAD; $(git rev-list --count "$ORIGIN_SHA..HEAD") local commit(s) not pushed yet"
  else
    block "$ORIGIN_REMOTE/$BRANCH has commits the local $BRANCH lacks; 'git pull --ff-only' first (never force-push)"
  fi
else
  info "not known locally (first push)"
fi

# FORK.md's one rule, as a diff: against its base tag, the branch may only change fork-owned
# paths plus the upstream files of the extension host commit(s).
HOST_SHAS="$(git log --format=%H --grep="^$HOST_COMMIT_SUBJECT" HEAD)"
[ -n "$HOST_SHAS" ] || die "no '$HOST_COMMIT_SUBJECT' commit in HEAD's history"
HOST_FILES="$(for sha in $HOST_SHAS; do git show --no-renames --name-only --format= "$sha"; done | upstream_paths)"
check_rule() {
  local edits extra lost file
  edits="$(git diff --no-renames --name-only "$1" HEAD | upstream_paths)"
  extra="$(comm -23 <(printf '%s\n' "$edits") <(printf '%s\n' "$HOST_FILES") | grep -v '^$' || true)"
  lost="$(comm -13 <(printf '%s\n' "$edits") <(printf '%s\n' "$HOST_FILES") | grep -v '^$' || true)"
  [ -z "$lost" ] || block "extension host files no longer differ from $1 (host edits lost in a merge?):"$'\n'"$(sed 's/^/      /' <<<"$lost")"
  if [ -n "$extra" ]; then
    block "$(wc -l <<<"$extra" | tr -d ' ') upstream file(s) differ from $1 but are not extension host files; only the '$HOST_COMMIT_SUBJECT' commit may edit upstream files (FORK.md):"$'\n'"$(sed -n '1,30s/^/      /p' <<<"$extra")"
    return 0
  fi
  while IFS= read -r file; do
    [ -z "$file" ] || git grep -q -e t3-ext HEAD -- "$file" || warn "$file has no t3-ext marker"
  done <<<"$edits"
  [ -n "$lost" ] || info "upstream files edited vs $1: exactly the $(wc -l <<<"$HOST_FILES" | tr -d ' ') host files"
}

step "Base"
BASE="$(base_tag)"
[ -n "$BASE" ] || die "no stable vX.Y.Z tag is contained in HEAD"
info "base tag: $BASE   fork commits: $(git rev-list --count --no-merges "$BASE..HEAD")"
check_rule "$BASE"

step "Target release"
if [ -z "$TAG" ]; then
  command -v gh >/dev/null 2>&1 || die "gh is not installed; pass the tag (update.sh vX.Y.Z)"
  TAG="$(gh api "repos/$UPSTREAM_REPO/releases/latest" --jq .tag_name)" ||
    die "could not read the latest $UPSTREAM_REPO release; pass the tag"
  info "latest $UPSTREAM_REPO release: $TAG"
fi
case "$TAG" in v*) ;; *) TAG="v$TAG" ;; esac
[[ "$TAG" =~ $STABLE_TAG_RE ]] || die "'$TAG' is not a stable vX.Y.Z tag; main, -nightly and -preview are not allowed (FORK.md)"
if command -v gh >/dev/null 2>&1 &&
  flags="$(gh api "repos/$UPSTREAM_REPO/releases/tags/$TAG" --jq '"\(.prerelease) \(.draft)"' 2>/dev/null)"; then
  [ "$flags" = "false false" ] || block "GitHub release $TAG is a prerelease or draft"
else
  warn "could not confirm that $TAG is a published stable GitHub release"
fi
version_lt "${TAG#v}" "${BASE#v}" && block "$TAG is older than the base $BASE; versions only go up"
MERGE=1
[ "$TAG" != "$BASE" ] || MERGE=0
if [ "$CHECK" = 1 ]; then
  REMOTE_SHA="$(git ls-remote --tags "$UPSTREAM_REMOTE" "refs/tags/$TAG" "refs/tags/$TAG^{}" | awk '{ s = $1 } END { print s }')" || true
  [ -n "$REMOTE_SHA" ] || block "$UPSTREAM_REMOTE has no tag $TAG"
  LOCAL_SHA="$(git rev-parse --verify --quiet "refs/tags/$TAG^{commit}" || true)"
  if [ -n "$LOCAL_SHA" ] && [ -n "$REMOTE_SHA" ] && [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
    block "local tag $TAG (${LOCAL_SHA:0:9}) differs from $UPSTREAM_REMOTE (${REMOTE_SHA:0:9})"
  fi
  info "$TAG: ${REMOTE_SHA:0:9} on $UPSTREAM_REMOTE$([ -n "$LOCAL_SHA" ] || echo ', not fetched yet')"
else
  run fork_git fetch --no-tags "$UPSTREAM_REMOTE" tag "$TAG"
  LOCAL_SHA="$(git rev-parse --verify "refs/tags/$TAG^{commit}")"
  info "$TAG: ${LOCAL_SHA:0:9}"
fi
if [ "$MERGE" = 1 ] && [ -n "$LOCAL_SHA" ] && ! git merge-base --is-ancestor "$BASE" "$LOCAL_SHA"; then
  warn "$BASE is not an ancestor of $TAG; the merge brings in both histories"
fi

if [ "$BUILD" = 1 ]; then
  step "Desktop build prerequisites"
  MISSING=""
  for tool in cargo clang make sips hdiutil; do command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"; done
  xcrun --find iconutil >/dev/null 2>&1 || MISSING="$MISSING iconutil"
  RUST_LIBDIR="$(rustc --print target-libdir --target "$RUST_TARGET" 2>/dev/null || true)"
  { [ -n "$RUST_LIBDIR" ] && compgen -G "$RUST_LIBDIR/libstd-*.rlib" >/dev/null; } || MISSING="$MISSING rust-target:$RUST_TARGET"
  [ -z "$MISSING" ] ||
    block "missing build tools:$MISSING (xcode-select --install; brew install rustup && rustup-init -y && rustup target add $RUST_TARGET)"
  [ -n "$MISSING" ] || info "ok"
fi

DMG="$REPO_ROOT/release/T3-Code-${TAG#v}-wingman.0-arm64.dmg"
if [ "$CHECK" = 1 ]; then
  step "Check summary"
  info "$BASE -> $TAG: $([ "$MERGE" = 1 ] && echo "merge $TAG into $BRANCH" || echo "already merged, verify and push only")"
  [ "$BUILD" = 0 ] || info "local test DMG: $DMG"
  if [ -n "$BLOCKERS" ]; then
    printf '\nBlockers:\n%s' "$BLOCKERS"
    exit 1
  fi
  info "no blockers"
  exit 0
fi

if [ "$MERGE" = 1 ]; then
  PRE_MERGE="$(git rev-parse HEAD)"
  step "Merging $TAG into $BRANCH"
  info "undo before pushing with: git reset --hard ${PRE_MERGE:0:12}"
  if ! run fork_git merge --no-ff -m "chore(fork): merge upstream $TAG" "$TAG"; then
    printf '\nMERGE STOPPED on conflicts in:\n%s\n' "$(git diff --name-only --diff-filter=U | sed 's/^/  /')" >&2
    cat >&2 <<EOF

The merge is still in progress. Fork edits in upstream files are marked 't3-ext' (FORK.md).
  1. fix the files above and 'git add' them
  2. source scripts/fork/env.sh && fork_git commit --no-verify -m "chore(fork): merge upstream $TAG"
  3. scripts/fork/update.sh $TAG      (verifies, then pushes)
Give up instead:  git merge --abort
EOF
    exit 1
  fi
  [ "$(base_tag)" = "$TAG" ] || die "after the merge the base is $(base_tag), expected $TAG"
  check_rule "$TAG"
fi

step "pnpm install"
run pnpm install --frozen-lockfile || die "pnpm install failed (stale pnpm-lock.yaml?)"

typecheck() {
  local dir="$1" out status=0 errors
  step "Typecheck $dir"
  out="$(cd "$REPO_ROOT/$dir" && pnpm exec tsc --noEmit 2>&1)" || status=$?
  errors="$(printf '%s\n' "$out" | grep 'error TS' || true)"
  if [ -n "$errors" ]; then
    printf '%s\n' "$errors" | sed -n '1,60p' >&2
    die "typecheck failed in $dir ($(wc -l <<<"$errors" | tr -d ' ') errors)"
  fi
  [ "$status" = 0 ] || die "tsc exited with $status in $dir:"$'\n'"$(printf '%s\n' "$out" | tail -n 20)"
  info "ok"
}
typecheck packages/contracts
typecheck apps/server
typecheck apps/web

step "Extension tests"
(cd packages/contracts && run pnpm exec vp test run --passWithNoTests src/extensions) || die "contracts extension tests failed"
(cd apps/server && run pnpm exec vp test run --passWithNoTests src/extensions) || die "server extension tests failed"
(cd apps/web && run pnpm exec vp test run --passWithNoTests --project unit src/extensions) || die "web extension tests failed"

if [ "$BUILD" = 1 ]; then
  VERSION="${TAG#v}-wingman.0"
  step "Building local unsigned test DMG $VERSION (no update feed)"
  (
    # Public T3 Connect build config, so local builds keep T3 Connect.
    if [ -f scripts/fork/connect.env ]; then
      set -a
      # shellcheck source=/dev/null
      source scripts/fork/connect.env
      set +a
    fi
    # No update feed (no app-update.yml) and no signing/notarization.
    unset T3CODE_DESKTOP_UPDATE_REPOSITORY GITHUB_REPOSITORY T3CODE_DESKTOP_SIGNED \
      T3CODE_DESKTOP_MOCK_UPDATES T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT T3CODE_DESKTOP_OUTPUT_DIR \
      T3CODE_DESKTOP_VERSION T3CODE_DESKTOP_PLATFORM T3CODE_DESKTOP_TARGET T3CODE_DESKTOP_ARCH \
      T3CODE_DESKTOP_SKIP_BUILD T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR T3CODE_DESKTOP_KEEP_STAGE
    run node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --build-version "$VERSION"
  ) || die "desktop build failed (re-run with T3CODE_DESKTOP_VERBOSE=true for details)"
  [ -f "$DMG" ] || die "build finished but $DMG is missing (see release/)"
  info "test with: scripts/fork/install.sh \"$DMG\""
fi

if [ "$PUSH" = 0 ]; then
  step "Skipping push (--no-push); pushing $BRANCH later publishes a release"
  exit 0
fi
if [ -n "${ORIGIN_SHA:-}" ]; then
  # GitHub only lets workflows.sh disable a workflow once its file is on the branch, so a new
  # upstream workflow runs once on this push (public repo: free minutes, no secrets).
  NEW_WORKFLOWS="$(git diff --no-renames --name-only --diff-filter=A "$ORIGIN_SHA" HEAD -- .github/workflows)"
  [ -z "$NEW_WORKFLOWS" ] ||
    warn "new workflow file(s) will run once on this push, then workflows.sh disables them:"$'\n'"$(sed 's/^/      /' <<<"$NEW_WORKFLOWS")"
fi
step "Pushing $BRANCH and $TAG to $ORIGIN_REMOTE (publishes a release)"
run fork_git push "$ORIGIN_REMOTE" "$BRANCH" "refs/tags/$TAG"
if [ -f scripts/fork/workflows.sh ]; then
  # Upstream workflows that arrived with the merge start out enabled.
  run bash scripts/fork/workflows.sh || warn "scripts/fork/workflows.sh failed; run it again"
fi
step "Done"
info "watch the release: https://github.com/sethhen/t3code/actions"
