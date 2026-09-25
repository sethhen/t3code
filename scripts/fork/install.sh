#!/usr/bin/env bash
# Install a fork build over "/Applications/T3 Code (Alpha).app", with backups for rollback.
# Run it after quitting T3 Code; it refuses while the app runs and never kills anything.
#
# Usage: scripts/fork/install.sh [path/to/T3-Code-X.Y.Z-arm64.dmg | path/to/T3 Code (Alpha).app]
#   default: the newest release/T3-Code-*-arm64.dmg built by scripts/fork/update.sh
#
# Backups go to ~/Applications/T3 Code backups/ (zipped so macOS never registers them as apps):
#   T3 Code (Alpha) official-<ver>.zip   official bundle, kept forever
#   T3 Code (Alpha) fork-<ver>-<ts>.zip  the fork build being replaced, only the latest kept
#   userdata-<ts>-<official|fork>-<ver>/  ~/.t3/userdata (SQLite via VACUUM INTO, no -wal/-shm,
#                                         no logs/) + the Chromium profile; the ones taken over an
#                                         official app are kept forever, otherwise the last 3
# See FORK.md.
set -euo pipefail

APP_NAME="T3 Code (Alpha)"
BUNDLE_ID=com.t3tools.t3code
APP="/Applications/$APP_NAME.app"
BACKUP_ROOT="$HOME/Applications/T3 Code backups"
T3_HOME="${T3CODE_HOME:-$HOME/.t3}"
USERDATA="$T3_HOME/userdata"
KEEP_USERDATA_BACKUPS=3
TS="$(date +%Y%m%d-%H%M%S)"

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
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
plist_get() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null; }
kib() { du -sk "$1" 2>/dev/null | awk '{ print $1 }'; }

# Running if a process has the bundle's executable name, lives inside a "T3 Code (Alpha).app"
# (Electron helpers and the node backend do), or LaunchServices reports the bundle id running.
app_running() {
  local exe="$APP_NAME" pattern procs
  if [ -f "$APP/Contents/Info.plist" ]; then
    exe="$(plist_get "$APP" CFBundleExecutable || echo "$APP_NAME")"
  fi
  pattern="$(printf '%s' "$exe" | sed 's/[][\.*^$()+?{}|]/\\&/g')"
  if pgrep -x "$pattern" >/dev/null 2>&1; then return 0; fi
  procs="$(ps -axo comm= 2>/dev/null || true)"
  case "$procs" in *"/$APP_NAME.app/"*) return 0 ;; esac
  if [ "$(osascript -e "application id \"$BUNDLE_ID\" is running" 2>/dev/null || true)" = true ]; then
    return 0
  fi
  return 1
}
# official = signed by a team or carrying an update feed; fork builds have neither.
bundle_kind() {
  local team
  team="$(codesign -dv "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p' || true)"
  if [ -f "$1/Contents/Resources/app-update.yml" ] || { [ -n "$team" ] && [ "$team" != "not set" ]; }; then
    echo official
  else
    echo fork
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *)
      [ -z "${SOURCE:-}" ] || die "only one DMG/app argument is allowed"
      SOURCE="$1"
      ;;
  esac
  shift
done
SOURCE="${SOURCE:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOUNT_DIR=""
MOUNTED=""
STAGE_DIR=""
PREVIOUS_MOVED=""
INCOMPLETE=""
cleanup() {
  local status=$?
  if [ -n "$PREVIOUS_MOVED" ] && [ ! -e "$APP" ] && [ -d "$STAGE_DIR/previous/$APP_NAME.app" ]; then
    mv "$STAGE_DIR/previous/$APP_NAME.app" "$APP" && warn "install failed; restored the previous $APP"
  fi
  if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then rm -rf "$STAGE_DIR"; fi
  if [ -n "$INCOMPLETE" ] && [ -e "$INCOMPLETE" ]; then rm -rf "$INCOMPLETE"; fi
  if [ -n "$MOUNTED" ]; then
    hdiutil detach -quiet "$MOUNT_DIR" 2>/dev/null || hdiutil detach -quiet -force "$MOUNT_DIR" 2>/dev/null ||
      warn "could not detach $MOUNT_DIR"
  fi
  if [ -n "$MOUNT_DIR" ]; then rmdir "$MOUNT_DIR" 2>/dev/null || true; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

step "Preconditions"
[ "$(uname -s)" = Darwin ] || die "macOS only"
[ -w /Applications ] || die "/Applications is not writable by $(id -un)"
if app_running; then
  die "$APP_NAME is running. Quit it (Cmd+Q) and re-run; this script never kills it."
fi
info "$APP_NAME is not running"
if [ -f "$USERDATA/state.sqlite" ]; then
  HOLDERS="$(lsof -t -- "$USERDATA/state.sqlite" 2>/dev/null | tr '\n' ' ' || true)"
  [ -z "$HOLDERS" ] || warn "state.sqlite is open by pid(s) $HOLDERS (a standalone t3 server?); the backup is still a consistent snapshot"
fi

step "New build"
if [ -z "$SOURCE" ]; then
  SOURCE="$(ls -t "$REPO_ROOT"/release/T3-Code-*-arm64.dmg 2>/dev/null | sed -n 1p || true)"
  [ -n "$SOURCE" ] || die "no release/T3-Code-*-arm64.dmg; build one with scripts/fork/update.sh or pass a path"
fi
[ -e "$SOURCE" ] || die "$SOURCE does not exist"
SOURCE="$(cd "$(dirname "$SOURCE")" && pwd)/$(basename "$SOURCE")"
info "source: $SOURCE"
case "$SOURCE" in
  *.dmg)
    MOUNT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/t3code-install.XXXXXX")"
    run hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$MOUNT_DIR" "$SOURCE"
    MOUNTED=1
    NEW_APP="$MOUNT_DIR/$APP_NAME.app"
    [ -d "$NEW_APP" ] || die "the DMG has no '$APP_NAME.app' (found: $(ls "$MOUNT_DIR" | tr '\n' ' '))"
    ;;
  *.app | *.app/)
    NEW_APP="${SOURCE%/}"
    ;;
  *) die "expected a .dmg or .app, got $SOURCE" ;;
esac
NEW_NAME="$(plist_get "$NEW_APP" CFBundleName || true)"
NEW_EXE="$(plist_get "$NEW_APP" CFBundleExecutable || true)"
NEW_ID="$(plist_get "$NEW_APP" CFBundleIdentifier || true)"
NEW_VERSION="$(plist_get "$NEW_APP" CFBundleShortVersionString || true)"
info "bundle: name='$NEW_NAME' executable='$NEW_EXE' id=$NEW_ID version=$NEW_VERSION"
[ "$NEW_NAME" = "$APP_NAME" ] && [ "$NEW_EXE" = "$APP_NAME" ] ||
  die "the build's productName is '$NEW_NAME' (executable '$NEW_EXE'), expected '$APP_NAME'; a -nightly version renames the app, build a stable tag"
[ "$NEW_ID" = "$BUNDLE_ID" ] || die "bundle id is $NEW_ID, expected $BUNDLE_ID"
[ -n "$NEW_VERSION" ] || die "the build has no CFBundleShortVersionString"
if [ -f "$NEW_APP/Contents/Resources/app-update.yml" ]; then
  die "the build contains an update feed (app-update.yml): it would auto-update to the official release. Build it with scripts/fork/update.sh (to roll back to an official bundle, follow FORK.md instead)"
fi
if [ "$(uname -m)" = arm64 ]; then
  ARCHS="$(lipo -archs "$NEW_APP/Contents/MacOS/$NEW_EXE" 2>/dev/null || true)"
  case " $ARCHS " in *" arm64 "*) ;; *) die "the build is not arm64 (archs: ${ARCHS:-unknown})" ;; esac
fi

step "Installed app"
OLD_VERSION=""
OLD_KIND=""
if [ -d "$APP" ]; then
  OLD_VERSION="$(plist_get "$APP" CFBundleShortVersionString || true)"
  OLD_KIND="$(bundle_kind "$APP")"
  info "$APP: $OLD_KIND ${OLD_VERSION:-(no version)}"
  if [ -n "$OLD_VERSION" ] && version_lt "$NEW_VERSION" "$OLD_VERSION"; then
    die "the build ($NEW_VERSION) is older than the installed app ($OLD_VERSION); its database may already be migrated past $NEW_VERSION"
  fi
else
  warn "$APP is not installed; nothing to back up"
fi

step "Disk space"
NEED_KIB=$(($(kib "$NEW_APP") + 1048576))
if [ -d "$APP" ]; then NEED_KIB=$((NEED_KIB + $(kib "$APP"))); fi
if [ -d "$USERDATA" ]; then NEED_KIB=$((NEED_KIB + $(kib "$USERDATA"))); fi
mkdir -p "$HOME/Applications"
FREE_KIB="$(df -k "$HOME/Applications" | awk 'NR == 2 { print $4 }')"
info "free: $((FREE_KIB / 1024)) MiB   needed (upper bound): $((NEED_KIB / 1024)) MiB"
[ "$FREE_KIB" -gt "$NEED_KIB" ] || die "not enough free disk space for the backups and the new bundle"

(umask 077 && mkdir -p "$BACKUP_ROOT")
OFFICIAL_BACKUP=""
if [ -d "$APP" ]; then
  step "Backing up the installed app"
  if [ "$OLD_KIND" = official ]; then
    DEST="$BACKUP_ROOT/$APP_NAME official-${OLD_VERSION:-unknown}.zip"
  else
    DEST="$BACKUP_ROOT/$APP_NAME fork-${OLD_VERSION:-unknown}-$TS.zip"
  fi
  if [ -f "$DEST" ]; then
    info "already backed up: $DEST"
  else
    INCOMPLETE="$BACKUP_ROOT/.incomplete-app-$TS.zip"
    run ditto -c -k --sequesterRsrc --keepParent "$APP" "$INCOMPLETE"
    run mv "$INCOMPLETE" "$DEST"
    INCOMPLETE=""
    info "saved: $DEST"
  fi
  if [ "$OLD_KIND" = fork ]; then
    for old in "$BACKUP_ROOT/$APP_NAME fork-"*.zip; do
      if [ -f "$old" ] && [ "$old" != "$DEST" ]; then run rm -f "$old"; fi
    done
  fi
fi
for zip in "$BACKUP_ROOT/$APP_NAME official-"*.zip; do
  if [ -f "$zip" ]; then OFFICIAL_BACKUP="$zip"; fi
done
[ -n "$OFFICIAL_BACKUP" ] ||
  warn "no official bundle backup exists; to leave the fork, reinstall the official DMG from https://github.com/pingdotgg/t3code/releases"

USERDATA_BACKUP="$BACKUP_ROOT/userdata-$TS-${OLD_KIND:-none}-${OLD_VERSION:-none}"
if [ -d "$USERDATA" ]; then
  step "Backing up $USERDATA"
  INCOMPLETE="$BACKUP_ROOT/.incomplete-userdata-$TS"
  (umask 077 && mkdir -p "$INCOMPLETE/userdata")
  Q="'"
  for db in "$USERDATA"/*.sqlite; do
    [ -f "$db" ] || continue
    out="$INCOMPLETE/userdata/$(basename "$db")"
    # VACUUM INTO writes a consistent, WAL-free copy without writing to the live database.
    if ! run sqlite3 -readonly "$db" "VACUUM INTO '${out//$Q/$Q$Q}'"; then
      warn "read-only open failed (unclean shutdown?); retrying with a normal open"
      rm -f "$out"
      run sqlite3 "$db" "VACUUM INTO '${out//$Q/$Q$Q}'"
    fi
    CHECK="$(sqlite3 -readonly "$out" 'PRAGMA quick_check' 2>&1 || true)"
    [ "$CHECK" = ok ] || die "backup of $(basename "$db") failed quick_check: $CHECK"
    info "$(basename "$db"): $(($(kib "$out") / 1024)) MiB, quick_check ok"
  done
  # Everything else; the databases above are already copied, logs are not needed to restore.
  run /usr/bin/rsync -a --exclude='*-wal' --exclude='*-shm' --exclude='/*.sqlite' --exclude='/logs/' \
    "$USERDATA/" "$INCOMPLETE/userdata/"
  for profile in "$HOME/Library/Application Support/t3code" "$HOME/Library/Application Support/$APP_NAME"; do
    [ -d "$profile" ] || continue
    # The app is not running, so the Chromium profile is at rest; skip only caches.
    run /usr/bin/rsync -a --exclude='/Cache/' --exclude='/Code Cache/' --exclude='/GPUCache/' \
      --exclude='/DawnGraphiteCache/' --exclude='/DawnWebGPUCache/' --exclude='/Crashpad/' \
      "$profile/" "$INCOMPLETE/chromium-profile-$(basename "$profile")/"
  done
  run mv "$INCOMPLETE" "$USERDATA_BACKUP"
  INCOMPLETE=""
  info "saved: $USERDATA_BACKUP"

  # Backups taken over an official app (the data the official app can open) are kept forever;
  # of the others keep the newest few. Names sort chronologically.
  TOTAL=0
  for d in "$BACKUP_ROOT"/userdata-*; do
    case "$d" in *-official-*) continue ;; esac
    if [ -d "$d" ]; then TOTAL=$((TOTAL + 1)); fi
  done
  INDEX=0
  for d in "$BACKUP_ROOT"/userdata-*; do
    case "$d" in *-official-*) continue ;; esac
    [ -d "$d" ] || continue
    INDEX=$((INDEX + 1))
    if [ "$INDEX" -le $((TOTAL - KEEP_USERDATA_BACKUPS)) ]; then run rm -rf "$d"; fi
  done
else
  warn "$USERDATA does not exist; nothing to back up"
fi

step "Installing $NEW_VERSION to $APP"
if app_running; then
  die "$APP_NAME was started during the backup; quit it and re-run (backups are kept, nothing was installed)"
fi
STAGE_DIR="$(mktemp -d "/Applications/.t3code-install.XXXXXX")"
STAGED_APP="$STAGE_DIR/new/$APP_NAME.app"
mkdir -p "$STAGE_DIR/new" "$STAGE_DIR/previous"
run ditto "$NEW_APP" "$STAGED_APP"
run xattr -dr com.apple.quarantine "$STAGED_APP" 2>/dev/null || true
if codesign --verify --deep --strict "$STAGED_APP" 2>/dev/null; then
  info "code signature: valid"
else
  warn "unsigned or broken signature; applying an ad-hoc signature (Apple silicon will not run it otherwise)"
  run codesign --force --deep --sign - "$STAGED_APP"
  codesign --verify --deep --strict "$STAGED_APP" || die "the ad-hoc signed bundle still fails verification"
fi
if [ -n "$MOUNTED" ]; then
  run hdiutil detach -quiet "$MOUNT_DIR"
  MOUNTED=""
fi
if [ -d "$APP" ]; then
  run mv "$APP" "$STAGE_DIR/previous/$APP_NAME.app"
  PREVIOUS_MOVED=1
fi
run mv "$STAGED_APP" "$APP"
PREVIOUS_MOVED=""
run rm -rf "$STAGE_DIR"
STAGE_DIR=""
INSTALLED_VERSION="$(plist_get "$APP" CFBundleShortVersionString || true)"
info "installed: $APP ($INSTALLED_VERSION, fork build)"

step "Opening $APP_NAME"
run open "$APP"

ROLLBACK_ZIP="${OFFICIAL_BACKUP:-<official zip in $BACKUP_ROOT>}"
OFFICIAL_VERSION=""
if [ -n "$OFFICIAL_BACKUP" ]; then
  OFFICIAL_VERSION="${OFFICIAL_BACKUP##* official-}"
  OFFICIAL_VERSION="${OFFICIAL_VERSION%.zip}"
fi
cat <<EOF

==> Done
    First launch of this unsigned build: macOS asks for the "t3code Safe Storage" Keychain item
    (choose Always Allow; it asks again after each rebuild), and privacy permissions (screen
    recording, files, ...) must be granted again.

Roll back to the official app (quit T3 Code first):
    rm -rf "$APP"
    ditto -x -k "$ROLLBACK_ZIP" /Applications
EOF
if [ -n "$OFFICIAL_VERSION" ] && [ "$OFFICIAL_VERSION" != "$NEW_VERSION" ]; then
  OFFICIAL_USERDATA="$BACKUP_ROOT/userdata-<timestamp>-official-$OFFICIAL_VERSION"
  for d in "$BACKUP_ROOT"/userdata-*-official-"$OFFICIAL_VERSION"; do
    if [ -d "$d" ]; then
      OFFICIAL_USERDATA="$d"
      break
    fi
  done
  cat <<EOF
  This fork ($NEW_VERSION) is newer than that official bundle ($OFFICIAL_VERSION) and may have
  migrated the database past it. Either install the official $NEW_VERSION DMG instead
  (https://github.com/pingdotgg/t3code/releases/tag/v$NEW_VERSION, keeps your data), or also
  restore the userdata backup taken before the upgrade (loses changes made since):
    mv "$USERDATA" "$USERDATA.fork-\$(date +%Y%m%d-%H%M%S)"
    ditto "$OFFICIAL_USERDATA/userdata" "$USERDATA"
EOF
fi
cat <<EOF
Backups: $BACKUP_ROOT
EOF
