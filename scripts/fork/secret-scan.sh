#!/usr/bin/env bash
# Fail if the fork's own commits (or, with --worktree, uncommitted files) contain a secret.
# The repo is public: a pushed secret is leaked even if the commit is reverted.
#
# Usage: scripts/fork/secret-scan.sh [--worktree] [<since-ref>]
#   <since-ref>  scan commits after this ref (default: the highest stable vX.Y.Z tag in HEAD,
#                i.e. every fork commit)
#   --worktree   also scan tracked and untracked files that aren't committed yet
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="$REPO_ROOT/scripts/fork/gitleaks.toml"
WORKTREE=0
SINCE=""
for arg in "$@"; do
  case "$arg" in
    --worktree) WORKTREE=1 ;;
    -h | --help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) SINCE="$arg" ;;
  esac
done

command -v gitleaks >/dev/null 2>&1 || {
  echo "gitleaks is not installed (brew install gitleaks)" >&2
  exit 1
}
cd "$REPO_ROOT"
if [ -z "$SINCE" ]; then
  SINCE="$(git tag --merged HEAD --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)"
  [ -n "$SINCE" ] || {
    echo "no stable vX.Y.Z tag in HEAD; pass a ref" >&2
    exit 1
  }
fi

echo "Secret scan: commits $SINCE..HEAD"
# --diff-merges=remerge: also scan what a merge commit's conflict resolution added (a plain
# `git log -p` shows no diff for merges), without re-scanning the merged-in upstream code.
gitleaks git --config "$CONFIG" --redact --no-banner --log-opts="--diff-merges=remerge $SINCE..HEAD" .
if [ "$WORKTREE" = 1 ]; then
  echo "Secret scan: uncommitted files"
  changed="$(
    git diff --name-only HEAD
    git ls-files --others --exclude-standard
  )"
  if [ -n "$changed" ]; then
    stage="$(mktemp -d)"
    trap 'rm -rf "$stage"' EXIT
    while IFS= read -r file; do
      [ -f "$file" ] || continue
      mkdir -p "$stage/$(dirname "$file")"
      cp "$file" "$stage/$file"
    done <<<"$changed"
    gitleaks dir --config "$CONFIG" --redact --no-banner "$stage"
  fi
fi
echo "Secret scan: clean"
