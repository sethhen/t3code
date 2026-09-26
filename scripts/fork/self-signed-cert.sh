#!/usr/bin/env bash
# Create the fork's self-signed macOS code-signing certificate (once) and store it as the
# CSC_LINK / CSC_KEY_PASSWORD secrets of the GitHub Actions environment "release".
#
# Why self-signed: no Apple Developer account needed. electron-updater (Squirrel.Mac) installs an
# update only if it satisfies the running app's designated requirement. With this certificate
# that is `identifier "com.t3tools.t3code" and certificate root = H"<sha1>"`, the same for every
# build signed with it. Ad-hoc builds get a per-build cdhash requirement and can never update.
# Gatekeeper still treats the app as unidentified, so the first install needs "Open Anyway"
# (FORK.md).
#
# LOSING THE KEY strands every installed Mac: it would refuse updates signed with a new key, and
# everyone would have to reinstall by hand. Keep the .p12 and its password in 1Password.
#
# Usage: scripts/fork/self-signed-cert.sh [--set-secrets] [--repo OWNER/REPO]
#   default        create the certificate if it doesn't exist yet, print its SHA-1
#   --set-secrets  also set the two secrets from the stored files (values go straight to gh)
set -euo pipefail

REPO=sethhen/t3code
ENVIRONMENT=release
DIR="${T3CODE_FORK_SIGNING_DIR:-$HOME/.config/wingman/signing}"
P12="$DIR/t3code-fork-macos.p12"
PASS_FILE="$DIR/t3code-fork-macos.password"
CN="Wingman AI T3 Code (self-signed)"
# LibreSSL: the .p12 it writes imports into macOS keychains without OpenSSL 3's -legacy.
OSSL=/usr/bin/openssl
SET_SECRETS=0

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --set-secrets) SET_SECRETS=1 ;;
    --repo)
      [[ $# -ge 2 ]] || die "--repo needs OWNER/REPO"
      REPO="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

umask 077
mkdir -p "$DIR"
if [[ -f "$P12" ]]; then
  [[ -f "$PASS_FILE" ]] || die "$P12 exists but $PASS_FILE is missing"
  echo "Using the existing certificate in $P12"
else
  [[ ! -e "$PASS_FILE" ]] || die "$PASS_FILE exists without $P12; move it away first"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  cat >"$WORK/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $CN
O = Wingman AI Pty Ltd
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF
  "$OSSL" rand -hex 24 >"$PASS_FILE"
  # 20 years: macOS doesn't re-check expiry for timestamped signatures, but a long life avoids
  # ever having to rotate (rotation = every Mac reinstalls once).
  "$OSSL" req -x509 -newkey rsa:3072 -sha256 -nodes -days 7300 -config "$WORK/cert.cnf" \
    -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
  "$OSSL" pkcs12 -export -name "$CN" -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -out "$P12" -passout "file:$PASS_FILE"
  echo "Created $P12 (password in $PASS_FILE). Back both up in 1Password."
fi

SHA1="$("$OSSL" pkcs12 -in "$P12" -nokeys -passin "file:$PASS_FILE" 2>/dev/null |
  "$OSSL" x509 -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')"
[[ -n "$SHA1" ]] || die "could not read the certificate from $P12"
echo "Certificate SHA-1: $SHA1"

if [[ "$SET_SECRETS" == 1 ]]; then
  command -v gh >/dev/null 2>&1 || die "gh is required"
  base64 <"$P12" | tr -d '\n' | gh secret set CSC_LINK --repo "$REPO" --env "$ENVIRONMENT"
  tr -d '\n' <"$PASS_FILE" | gh secret set CSC_KEY_PASSWORD --repo "$REPO" --env "$ENVIRONMENT"
  echo "Set CSC_LINK and CSC_KEY_PASSWORD in the '$ENVIRONMENT' environment of $REPO"
fi
