#!/usr/bin/env bash
# Keep only the fork's release pipeline enabled in GitHub Actions.
#
# Disables every workflow in the fork except fork-release.yml (the fork's
# build + publish pipeline) and release-desktop.yml (upstream's reusable
# workflow_call build, left enabled for reference), enables those two if they
# were disabled, then prints every workflow's state. Idempotent; rerun it after
# merging an upstream release, since upstream workflow files that are new to
# the fork start out enabled.
#
# Usage: scripts/fork/workflows.sh [owner/repo]   (default: sethhen/t3code)
# Needs `gh` authenticated with admin access to the repository.
set -euo pipefail

REPO="${1:-sethhen/t3code}"
KEEP=(.github/workflows/fork-release.yml .github/workflows/release-desktop.yml)

command -v gh >/dev/null 2>&1 || {
  echo "gh (GitHub CLI) is required" >&2
  exit 1
}

is_kept() {
  local path="$1" keep
  for keep in "${KEEP[@]}"; do
    [[ "$path" == "$keep" ]] && return 0
  done
  return 1
}

list_workflows() {
  gh api --paginate "repos/$REPO/actions/workflows" \
    --jq '.workflows[] | [.id, .state, .path] | @tsv'
}

changed=0
while IFS=$'\t' read -r id state path; do
  [[ -n "$id" ]] || continue
  # Only workflow files; GitHub-managed dynamic workflows (Dependabot, Pages) are left alone.
  [[ "$path" == .github/workflows/* ]] || continue
  if is_kept "$path"; then
    if [[ "$state" != active ]]; then
      echo "enable  $path"
      gh api --silent -X PUT "repos/$REPO/actions/workflows/$id/enable"
      changed=$((changed + 1))
    fi
  elif [[ "$state" == active ]]; then
    echo "disable $path"
    gh api --silent -X PUT "repos/$REPO/actions/workflows/$id/disable"
    changed=$((changed + 1))
  fi
done < <(list_workflows)

echo "$changed change(s) in $REPO"
echo
list_workflows | while IFS=$'\t' read -r _ state path; do
  printf '%-20s %s\n' "$state" "$path"
done
if ! list_workflows | cut -f3 | grep -qx .github/workflows/fork-release.yml; then
  echo
  echo "note: fork-release.yml is not on $REPO's default branch yet; it starts enabled once pushed."
fi
