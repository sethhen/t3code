#!/usr/bin/env bash
# Store the fork's desktop code-signing credentials as secrets of the GitHub Actions environment
# "release", which only runs on `main`, so other workflows (e.g. upstream ones) never see them.
# Run it yourself in a terminal. Values come from local files or hidden prompts and are piped
# straight into `gh secret set`, so they never pass through chat, argv or shell history.
#
# Usage:
#   scripts/fork/set-signing-secrets.sh             macOS: Developer ID .p12 + App Store Connect .p8
#   scripts/fork/set-signing-secrets.sh --windows   Windows: Azure Artifact Signing values
# Options:
#   --repo OWNER/REPO      target repository (default: sethhen/t3code)
#   --dry-run              validate everything, set nothing
#   --skip-online-checks   skip the notarytool / Entra ID credential checks
# See scripts/fork/SIGNING.md.
set -euo pipefail

REPO="sethhen/t3code"
ENVIRONMENT=release
MODE=mac
DRY_RUN=0
ONLINE_CHECKS=1
SET_LIST=""

step() { printf '\n==> %s\n' "$*" >&2; }
info() { printf '    %s\n' "$*" >&2; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}
usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --windows) MODE=windows ;;
    --mac | --macos) MODE=mac ;;
    --repo)
      [[ $# -ge 2 ]] || die "--repo needs OWNER/REPO"
      REPO="$2"
      shift
      ;;
    --repo=*) REPO="${1#--repo=}" ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-online-checks) ONLINE_CHECKS=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo must look like OWNER/REPO"
[[ -t 0 ]] || die "run this in an interactive terminal (it prompts for hidden input)"

# Anything a child process or bash itself writes to TMPDIR lands here and is removed on exit.
umask 077
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/t3code-signing.XXXXXX")"
cleanup() {
  stty echo 2>/dev/null || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
export TMPDIR="$WORK_DIR"

# ---------------------------------------------------------------------------------------------
# Prompt helpers (bash 3.2 compatible: macOS /bin/bash)

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ask VAR "Prompt" [default]
ask() {
  local __var="$1" __prompt="$2" __default="${3-}" __reply=""
  if [[ -n "$__default" ]]; then __prompt="$__prompt [$__default]"; fi
  IFS= read -r -p "$__prompt: " __reply || die "no input"
  __reply="$(trim "$__reply")"
  if [[ -z "$__reply" ]]; then __reply="$__default"; fi
  printf -v "$__var" '%s' "$__reply"
}

# ask_path VAR "Prompt": accepts drag-and-drop paths ('\ ' escapes, quotes, trailing space, ~).
ask_path() {
  local __var="$1" __reply=""
  # No -r on purpose: Terminal escapes spaces in dropped paths as '\ ', which read unescapes.
  # shellcheck disable=SC2162
  IFS= read -p "$2: " __reply || die "no input"
  __reply="$(trim "$__reply")"
  __reply="${__reply#\'}"
  __reply="${__reply%\'}"
  __reply="${__reply#\"}"
  __reply="${__reply%\"}"
  # shellcheck disable=SC2088 # matching a literal typed "~", not expanding it
  case "$__reply" in
    "~") __reply="$HOME" ;;
    "~/"*) __reply="$HOME/${__reply#\~/}" ;;
  esac
  printf -v "$__var" '%s' "$__reply"
}

# ask_secret VAR "Prompt": hidden input, never echoed.
ask_secret() {
  local __var="$1" __reply=""
  IFS= read -r -s -p "$2: " __reply || die "no input"
  printf '\n' >&2
  printf -v "$__var" '%s' "$__reply"
}

check_file() {
  [[ -n "$1" ]] || die "no $2 path given"
  [[ -f "$1" ]] || die "$2 not found: $1"
  [[ -r "$1" ]] || die "$2 is not readable: $1"
  [[ -s "$1" ]] || die "$2 is empty: $1"
}

GUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# ---------------------------------------------------------------------------------------------
# GitHub

preflight_gh() {
  command -v gh >/dev/null 2>&1 || die "GitHub CLI 'gh' not found (brew install gh)"
  gh auth status --hostname github.com >/dev/null 2>&1 || die "gh is not logged in (run: gh auth login)"
  local admin
  admin="$(gh api "repos/$REPO" --jq '.permissions.admin' 2>/dev/null)" || die "gh cannot read $REPO"
  [[ "$admin" == "true" ]] || die "your gh account needs admin access to $REPO to set Actions secrets"
}

# The environment exists, restricted to the main branch (idempotent). The fork-release jobs that
# sign declare `environment: release`.
ensure_environment() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  gh api --silent -X PUT "repos/$REPO/environments/$ENVIRONMENT" \
    -F 'deployment_branch_policy[protected_branches]=false' \
    -F 'deployment_branch_policy[custom_branch_policies]=true' ||
    die "could not create the '$ENVIRONMENT' environment on $REPO"
  if ! gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
    --jq '.branch_policies[].name' 2>/dev/null | grep -qx main; then
    gh api --silent -X POST "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
      -f name=main -f type=branch || die "could not restrict '$ENVIRONMENT' to the main branch"
  fi
}

# confirm NAME...: show which secrets will be set (and which already exist), then ask.
confirm() {
  local existing name overwrite=""
  existing="$(gh secret list --repo "$REPO" --env "$ENVIRONMENT" --json name --jq '.[].name' 2>/dev/null || true)"
  for name in "$@"; do
    if printf '%s\n' "$existing" | grep -qx "$name"; then overwrite="$overwrite $name"; fi
  done
  step "Ready to set $# secrets in the '$ENVIRONMENT' environment of $REPO"
  info "$*"
  if [[ -n "$overwrite" ]]; then info "already set, will be overwritten:$overwrite"; fi
  local reply=""
  IFS= read -r -p "Proceed? [y/N] " reply || die "no input"
  case "$reply" in
    y | Y | yes | YES) ;;
    *) die "aborted; nothing was set" ;;
  esac
}

# set_secret NAME < value   (gh reads the value from stdin; it never appears in argv)
set_secret() {
  gh secret set "$1" --repo "$REPO" --env "$ENVIRONMENT" >/dev/null || die "gh secret set $1 failed (secrets set so far:${SET_LIST:- none})"
  SET_LIST="$SET_LIST $1"
  info "set $1"
}

# ---------------------------------------------------------------------------------------------
# OpenSSL: macOS /usr/bin/openssl is LibreSSL; OpenSSL 3 needs -legacy for RC2-encrypted .p12s.

OSSL=""
P12_LEGACY=0
P12_PATH=""
P12_PASS=""

openssl_candidates() {
  {
    command -v openssl 2>/dev/null || true
    printf '%s\n' /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl /usr/bin/openssl
  } | awk 'NF && !seen[$0]++'
}

# p12 ARGS...: run `openssl pkcs12` on the .p12 with the password passed via the environment.
p12() {
  if [[ "$P12_LEGACY" == 1 ]]; then
    T3_P12_PASS="$P12_PASS" "$OSSL" pkcs12 -legacy -in "$P12_PATH" -passin env:T3_P12_PASS "$@"
  else
    T3_P12_PASS="$P12_PASS" "$OSSL" pkcs12 -in "$P12_PATH" -passin env:T3_P12_PASS "$@"
  fi
}

find_p12_reader() {
  local bin legacy
  while IFS= read -r bin; do
    [[ -x "$bin" ]] || continue
    for legacy in 0 1; do
      OSSL="$bin"
      P12_LEGACY="$legacy"
      if p12 -nokeys >/dev/null 2>&1; then return 0; fi
    done
  done < <(openssl_candidates)
  OSSL=""
  return 1
}

# ---------------------------------------------------------------------------------------------
# macOS: CSC_LINK, CSC_KEY_PASSWORD, APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER

CSC_LINK_B64=""
P8_PATH=""
KEY_ID=""
ISSUER=""

collect_mac() {
  step "Developer ID Application certificate (.p12 exported from Keychain Access)"
  ask_path P12_PATH "Path to the .p12"
  check_file "$P12_PATH" ".p12"
  ask_secret P12_PASS "Export password of the .p12 (hidden)"
  [[ -n "$P12_PASS" ]] || die "the .p12 needs an export password (CSC_KEY_PASSWORD cannot be empty); re-export it with one"

  find_p12_reader || die "could not open the .p12 with that password (wrong password, or not a PKCS#12 file; macOS LibreSSL mishandles non-ASCII passwords, so 'brew install openssl@3' if yours has any). Tried: $(openssl_candidates | tr '\n' ' ')"
  if [[ "$P12_LEGACY" == 1 ]]; then info "opened with $OSSL -legacy"; else info "opened with $OSSL"; fi

  # Certificates are public, so they may sit in variables. Keychain exports also carry CA certs.
  local subjects dev_count key_count pem identity team issuer enddate
  subjects="$(p12 -nokeys 2>/dev/null | sed -n 's/^subject= *//p')"
  dev_count="$(printf '%s\n' "$subjects" | grep -c 'Developer ID Application:' || true)"
  if [[ "$dev_count" == 0 ]]; then
    printf '%s\n' "$subjects" | grep . | sed 's/^/    found: /' >&2 || true
    die "no 'Developer ID Application' certificate in the .p12 (see scripts/fork/SIGNING.md, 1.2)"
  fi
  [[ "$dev_count" == 1 ]] || die "the .p12 holds $dev_count Developer ID Application certificates; export only one"
  pem="$(p12 -nokeys 2>/dev/null | awk '
    /^subject=/ { keep = ($0 ~ /Developer ID Application:/) }
    keep && !done && /-----BEGIN CERTIFICATE-----/ { inpem = 1 }
    inpem { print }
    /-----END CERTIFICATE-----/ { if (inpem) done = 1; inpem = 0 }')"
  [[ -n "$pem" ]] || die "could not extract the Developer ID certificate from the .p12"

  identity="$(printf '%s\n' "$subjects" | grep -o 'Developer ID Application: [^/]*([A-Z0-9]\{10\})' | head -n 1)"
  team="$(printf '%s' "$identity" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')"
  issuer="$(printf '%s\n' "$pem" | "$OSSL" x509 -noout -issuer 2>/dev/null || true)"
  [[ "$issuer" == *"Developer ID Certification Authority"* ]] || die "the certificate was not issued by Apple's Developer ID Certification Authority (${issuer:-no issuer})"
  enddate="$(printf '%s\n' "$pem" | "$OSSL" x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
  printf '%s\n' "$pem" | "$OSSL" x509 -noout -checkend 0 >/dev/null 2>&1 || die "the certificate expired on $enddate"
  if ! printf '%s\n' "$pem" | "$OSSL" x509 -noout -checkend 2592000 >/dev/null 2>&1; then
    warn "the certificate expires within 30 days ($enddate)"
  fi

  # Exactly one private key, matching the certificate. Keys only flow through pipes between
  # openssl/grep processes; only a count and public-key hashes are kept.
  local cert_pub key_pub
  key_count="$(p12 -nocerts -nodes 2>/dev/null | grep -c -e '-----BEGIN .*PRIVATE KEY-----' || true)"
  [[ "$key_count" != 0 ]] || die "the .p12 has no private key: in Keychain Access > My Certificates, expand the certificate and export it together with its key"
  [[ "$key_count" == 1 ]] || die "the .p12 holds $key_count private keys; export only the Developer ID Application identity"
  cert_pub="$(printf '%s\n' "$pem" | "$OSSL" x509 -noout -pubkey 2>/dev/null | "$OSSL" sha256 2>/dev/null)" || cert_pub=""
  key_pub="$(p12 -nocerts -nodes 2>/dev/null | "$OSSL" pkey -pubout 2>/dev/null | "$OSSL" sha256 2>/dev/null)" || key_pub=""
  [[ -n "$cert_pub" && -n "$key_pub" ]] || die "could not compare the certificate with its private key"
  [[ "$cert_pub" == "$key_pub" ]] || die "the private key in the .p12 does not belong to the Developer ID certificate"

  CSC_LINK_B64="$(base64 <"$P12_PATH" | tr -d '\r\n')"
  [[ -n "$CSC_LINK_B64" ]] || die "base64 encoding of the .p12 failed"
  [[ "${#CSC_LINK_B64}" -le 48000 ]] || die "the base64 .p12 is ${#CSC_LINK_B64} bytes; GitHub secrets are limited to 48 KB (export only the one identity)"
  cmp -s <(printf '%s' "$CSC_LINK_B64" | base64 --decode 2>/dev/null) "$P12_PATH" || die "base64 round-trip of the .p12 did not match"
  info "OK: $identity (team $team), expires $enddate"

  step "App Store Connect API key (Team key, AuthKey_XXXXXXXXXX.p8, used for notarization)"
  ask_path P8_PATH "Path to the .p8"
  check_file "$P8_PATH" ".p8"
  [[ "$(head -n 1 "$P8_PATH" | tr -d '\r')" == "-----BEGIN PRIVATE KEY-----" ]] || die "the .p8 must start with '-----BEGIN PRIVATE KEY-----' (use the file downloaded from App Store Connect)"
  "$OSSL" pkey -in "$P8_PATH" -noout >/dev/null 2>&1 || die "the .p8 is not a readable private key"
  "$OSSL" pkey -in "$P8_PATH" -noout -text_pub 2>/dev/null | grep -q 'prime256v1\|P-256' || die "the .p8 is not an EC P-256 key; App Store Connect keys are"

  local file_kid=""
  if [[ "$(basename "$P8_PATH")" =~ ^AuthKey_([A-Za-z0-9]{10})\.p8$ ]]; then file_kid="$(upper "${BASH_REMATCH[1]}")"; fi
  ask KEY_ID "Key ID" "$file_kid"
  KEY_ID="$(upper "$KEY_ID")"
  [[ "$KEY_ID" =~ ^[A-Z0-9]{10}$ ]] || die "the Key ID is 10 letters/digits (shown next to the key in App Store Connect)"
  if [[ -n "$file_kid" && "$KEY_ID" != "$file_kid" ]]; then
    die "Key ID $KEY_ID does not match the file name ($(basename "$P8_PATH"))"
  fi
  ask ISSUER "Issuer ID (UUID above the keys table)"
  ISSUER="$(lower "$ISSUER")"
  [[ "$ISSUER" =~ $GUID_RE ]] || die "the Issuer ID must be a UUID like 69a6de7e-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

  if [[ "$ONLINE_CHECKS" == 1 ]]; then
    if xcrun --find notarytool >/dev/null 2>&1; then
      local out="" rc=0
      out="$(xcrun notarytool history --key "$P8_PATH" --key-id "$KEY_ID" --issuer "$ISSUER" 2>&1)" || rc=$?
      if [[ "$rc" == 0 ]]; then
        info "OK: notarytool authenticated with the key"
      elif [[ "$rc" -gt 128 ]]; then
        warn "notarytool crashed (exit $rc), so the key was not checked online; the first signed release will show whether notarization works"
      else
        printf '%s\n' "$out" | grep . | head -n 5 | sed 's/^/    notarytool: /' >&2 || true
        die "the notary service rejected the key (wrong Key ID / Issuer ID, revoked key, or an Individual key). Use --skip-online-checks to bypass"
      fi
    else
      info "notarytool not found (it ships with Xcode); skipped the online key check"
    fi
  fi
}

set_mac_secrets() {
  set_secret CSC_LINK < <(printf '%s' "$CSC_LINK_B64")
  set_secret CSC_KEY_PASSWORD < <(printf '%s' "$P12_PASS")
  set_secret APPLE_API_KEY <"$P8_PATH"
  set_secret APPLE_API_KEY_ID < <(printf '%s' "$KEY_ID")
  set_secret APPLE_API_ISSUER < <(printf '%s' "$ISSUER")
}

MAC_NAMES="CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER"

# ---------------------------------------------------------------------------------------------
# Windows: Azure Artifact Signing (formerly Trusted Signing); names match upstream's workflow.

AZ_TENANT=""
AZ_CLIENT=""
AZ_SECRET=""
AZ_ENDPOINT=""
AZ_ACCOUNT=""
AZ_PROFILE=""
AZ_PUBLISHER=""

collect_windows() {
  step "Azure Artifact Signing (see scripts/fork/SIGNING.md, 2.2)"
  ask AZ_TENANT "Directory (tenant) ID"
  AZ_TENANT="$(lower "$AZ_TENANT")"
  [[ "$AZ_TENANT" =~ $GUID_RE ]] || die "the tenant ID must be a GUID (Entra ID > Overview)"
  ask AZ_CLIENT "Application (client) ID of the app registration"
  AZ_CLIENT="$(lower "$AZ_CLIENT")"
  [[ "$AZ_CLIENT" =~ $GUID_RE ]] || die "the client ID must be a GUID (App registrations > Overview)"
  ask_secret AZ_SECRET "Client secret Value (hidden)"
  [[ -n "$AZ_SECRET" ]] || die "the client secret is empty"
  if [[ "$(lower "$AZ_SECRET")" =~ $GUID_RE ]]; then
    die "that looks like the Secret ID; copy the 'Value' column of the client secret instead"
  fi
  ask AZ_ENDPOINT "Account URI (endpoint)" "https://eus.codesigning.azure.net"
  AZ_ENDPOINT="$(lower "$AZ_ENDPOINT")"
  [[ "$AZ_ENDPOINT" =~ ^https://[a-z0-9]+\.codesigning\.azure\.net/?$ ]] || die "the endpoint must look like https://eus.codesigning.azure.net (account Overview > Account URI)"
  ask AZ_ACCOUNT "Artifact Signing account name"
  [[ "$AZ_ACCOUNT" =~ ^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$ && "$AZ_ACCOUNT" != *--* ]] || die "account names are 3-24 letters/digits/hyphens, starting with a letter"
  ask AZ_PROFILE "Certificate profile name"
  [[ "$AZ_PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || die "the certificate profile name is letters, digits and hyphens"
  ask AZ_PUBLISHER "Publisher name: the CN of the certificate subject, e.g. Wingman AI Pty Ltd"
  [[ -n "$AZ_PUBLISHER" ]] || die "the publisher name is empty"
  if [[ "$AZ_PUBLISHER" == CN=* && "$AZ_PUBLISHER" != *,* ]]; then
    AZ_PUBLISHER="${AZ_PUBLISHER#CN=}"
    info "using the CN value without the 'CN=' prefix: $AZ_PUBLISHER"
  fi

  if [[ "$ONLINE_CHECKS" == 1 ]]; then
    command -v curl >/dev/null 2>&1 || die "curl not found (or use --skip-online-checks)"
    local resp="" err=""
    # The secret reaches curl on stdin (client_secret@-), never in argv. The token is discarded.
    resp="$(printf '%s' "$AZ_SECRET" | curl -sS --max-time 30 \
      --data-urlencode "client_secret@-" \
      --data-urlencode "client_id=$AZ_CLIENT" \
      --data-urlencode "grant_type=client_credentials" \
      --data-urlencode "scope=https://management.azure.com/.default" \
      "https://login.microsoftonline.com/$AZ_TENANT/oauth2/v2.0/token" 2>&1)" ||
      die "could not reach login.microsoftonline.com (use --skip-online-checks to bypass)"
    if [[ "$resp" == *'"access_token"'* ]]; then
      info "OK: Entra ID accepted the client ID and secret"
    else
      err="$(printf '%s' "$resp" | grep -o 'AADSTS[0-9]*: [^.\\"]*' | head -n 1 || true)"
      resp=""
      die "Entra ID rejected the credentials: ${err:-unexpected response}"
    fi
    resp=""
  fi
  info "reminder: the app registration needs the 'Artifact Signing Certificate Profile Signer' role on the account or profile"
}

set_windows_secrets() {
  set_secret AZURE_TENANT_ID < <(printf '%s' "$AZ_TENANT")
  set_secret AZURE_CLIENT_ID < <(printf '%s' "$AZ_CLIENT")
  set_secret AZURE_CLIENT_SECRET < <(printf '%s' "$AZ_SECRET")
  set_secret AZURE_TRUSTED_SIGNING_ENDPOINT < <(printf '%s' "$AZ_ENDPOINT")
  set_secret AZURE_TRUSTED_SIGNING_ACCOUNT_NAME < <(printf '%s' "$AZ_ACCOUNT")
  set_secret AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME < <(printf '%s' "$AZ_PROFILE")
  set_secret AZURE_TRUSTED_SIGNING_PUBLISHER_NAME < <(printf '%s' "$AZ_PUBLISHER")
}

WINDOWS_NAMES="AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TRUSTED_SIGNING_ENDPOINT AZURE_TRUSTED_SIGNING_ACCOUNT_NAME AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"

# ---------------------------------------------------------------------------------------------

if [[ "$DRY_RUN" == 0 ]]; then preflight_gh; fi

if [[ "$MODE" == mac ]]; then
  collect_mac
  NAMES="$MAC_NAMES"
else
  collect_windows
  NAMES="$WINDOWS_NAMES"
fi

if [[ "$DRY_RUN" == 1 ]]; then
  step "Dry run: everything validated; would set on $REPO:"
  info "$NAMES"
  exit 0
fi

# shellcheck disable=SC2086 # NAMES is a space-separated list of fixed secret names
confirm $NAMES
ensure_environment
step "Setting secrets in the '$ENVIRONMENT' environment of $REPO"
if [[ "$MODE" == mac ]]; then set_mac_secrets; else set_windows_secrets; fi
P12_PASS=""
AZ_SECRET=""
CSC_LINK_B64=""

step "Done. Set:$SET_LIST"
if [[ "$MODE" == mac ]]; then
  info "Not set on purpose: MACOS_PROVISIONING_PROFILE, APPLE_TEAM_ID (passkey entitlement only)."
  info "Back up the .p12 + password and the .p8 in 1Password, then delete the loose copies."
else
  info "Note the client secret's expiry date; renew it and re-run with --windows before then."
fi
