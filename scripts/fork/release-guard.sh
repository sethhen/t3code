#!/usr/bin/env bash
# Refuses a release that installed copies would reject, or that would move Latest backwards.
# Run by .github/workflows/fork-release.yml: early in the plan job, and again right before
# publishing (with the macOS signer). Fails closed: only "no published release yet" (HTTP 404)
# passes without reading the Latest release.
#
# Usage: release-guard.sh <version> <windows-signed: true|false> [<macOS signer SHA-1>]
# Env: GITHUB_REPOSITORY, GH_TOKEN, ALLOW_MAC_SIGNER_CHANGE=true to accept a new certificate.
set -euo pipefail

VERSION="$1"
WIN_SIGNED="$2"
MAC_SIGNER="${3:-}"
REPO="${GITHUB_REPOSITORY:?}"

fail() {
  echo "::error title=Release guard::$*"
  exit 1
}

if ! latest="$(gh api "repos/$REPO/releases/latest" --jq '[.tag_name, .body] | @json' 2>&1)"; then
  grep -q 'HTTP 404' <<<"$latest" || fail "Could not read the Latest release, so continuity can't be checked: $latest"
  echo "No published release yet; $VERSION is the first."
  exit 0
fi
tag="$(jq -r '.[0]' <<<"$latest")"
body="$(jq -r '.[1] // ""' <<<"$latest")"
latest_version="${tag#v}"

# Fork versions are X.Y.Z-wingman.N, which sort -V orders the same way semver does.
if [[ "$VERSION" != "$latest_version" ]] &&
  [[ "$(printf '%s\n%s\n' "$latest_version" "$VERSION" | sort -V | tail -n 1)" != "$VERSION" ]]; then
  fail "$VERSION is older than the Latest release $latest_version (a re-run of an old workflow run?). Push a new commit instead."
fi

latest_win="$(grep -o 'windows-signed: [a-z]*' <<<"$body" | head -n 1 | cut -d' ' -f2 || true)"
latest_mac="$(grep -o 'mac-signer: [0-9A-F]\{40\}' <<<"$body" | head -n 1 | cut -d' ' -f2 || true)"
[[ -n "$latest_win" && -n "$latest_mac" ]] ||
  fail "The Latest release $tag has no windows-signed / mac-signer markers, so signing continuity can't be checked. Add them to its notes or publish from this workflow."

# A signed Windows install refuses an update that isn't signed by the same publisher.
if [[ "$latest_win" == true && "$WIN_SIGNED" != true ]]; then
  fail "The Latest release has a signed Windows build, so installed Windows copies would refuse an unsigned update. Restore the Azure secrets and re-run."
fi

# Installed Macs only accept updates signed by the certificate they were installed with.
if [[ -n "$MAC_SIGNER" && "$MAC_SIGNER" != "$latest_mac" ]]; then
  if [[ "${ALLOW_MAC_SIGNER_CHANGE:-false}" != true ]]; then
    fail "The Latest release was signed by $latest_mac, this run by $MAC_SIGNER. Installed Macs would refuse the update. Restore the old certificate, or run Fork release manually with allow_mac_signer_change and have every Mac reinstall from the DMG once."
  fi
  echo "::warning title=macOS certificate changed::Allowed by allow_mac_signer_change; installed Macs must reinstall from the DMG."
fi
echo "Release guard: $VERSION after $latest_version ok (windows-signed $latest_win -> $WIN_SIGNED${MAC_SIGNER:+, mac-signer $latest_mac -> $MAC_SIGNER})."
