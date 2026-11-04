#!/bin/zsh
# Renews HealthBridge on the iPhone. With a free Apple developer account the signature
# lasts 7 days: this script deletes the old provisioning profiles, rebuilds with a fresh
# one and reinstalls the app over Wi-Fi. App data and settings stay on the phone.
#
# Usage: DEVICE_ID=<your iPhone id> scripts/renew.sh [--force]
#   DEVICE_ID   from "xcrun devicectl list devices" (required)
#   BUNDLE_ID   defaults to com.example.healthbridge (change it if you changed the project)
#   QUIET=1     no macOS notification on failure (when another script notifies for you)
# Without --force it renews only if the last successful renewal is at least 5 days old,
# so it can run often from a LaunchAgent (see README).
set -u

REPO="${0:A:h:h}"
DEVICE_ID="${DEVICE_ID:?set DEVICE_ID to your iPhone id (xcrun devicectl list devices)}"
BUNDLE_ID="${BUNDLE_ID:-com.example.healthbridge}"
STATE_DIR="$HOME/Library/Application Support/HealthBridge"
STATE="$STATE_DIR/last-renewal"
DERIVED="$HOME/Library/Caches/HealthBridge/DerivedData"
PROFILES="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
RENEW_AFTER_DAYS=5
WARN_AFTER_DAYS=6

log() { print -r -- "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
notify() { [[ -n "${QUIET:-}" ]] && return; osascript -e "display notification \"$1\" with title \"HealthBridge\"" >/dev/null 2>&1 || true; }

mkdir -p "$STATE_DIR"
now=$(date +%s)
last=$(cat "$STATE" 2>/dev/null || print 0)
age_days=$(( (now - last) / 86400 ))

if [[ "${1:-}" != "--force" ]] && (( age_days < RENEW_AFTER_DAYS )); then
  log "last renewal $age_days days ago: nothing to do"
  exit 0
fi

# $1 is the cause, $2 what to do: the notification states the real cause, not always "network".
fail() {
  log "ERROR: $1"
  if (( age_days >= WARN_AFTER_DAYS )); then
    notify "Renewal failed: $1. ${2:-The app expires soon.}"
  fi
  exit 1
}

# With the screen locked macOS closes the keychain after a few minutes: xcodebuild cannot
# find the credentials and Xcode can lose the Apple account. Try again later, unlocked.
ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers xml1 -o - - 2>/dev/null \
  | grep -A1 CGSSessionScreenIsLocked | grep -q "<true/>" \
  && fail "Mac locked" "It retries on its own once the Mac stays unlocked."

# "unavailable" means the iPhone is off or on another network: retry on the next run.
xcrun devicectl list devices 2>/dev/null | grep -E "$DEVICE_ID.* (connected|available \(paired\))" >/dev/null \
  || fail "iPhone not reachable" "Keep the iPhone on and on the same network as the Mac."

# Xcode reuses a profile while it is valid: without deleting it the expiry does not move.
# There are two: the app and the widget ($BUNDLE_ID.widget).
for profile in "$PROFILES"/*.mobileprovision(N); do
  name=$(security cms -D -i "$profile" 2>/dev/null | plutil -extract Name raw - 2>/dev/null)
  [[ "$name" == *"$BUNDLE_ID"* ]] && rm -f "$profile"
done

# The output stays in last-build.log: it tells why a renewal failed.
BUILD_LOG="$STATE_DIR/last-build.log"
if ! xcodebuild -project "$REPO/HealthBridge.xcodeproj" -scheme HealthBridge \
  -destination "id=$DEVICE_ID" -derivedDataPath "$DERIVED" -allowProvisioningUpdates -quiet build \
  >"$BUILD_LOG" 2>&1; then
  # Happens after an Xcode update: the Apple ID has to be added again.
  grep -q "No Accounts" "$BUILD_LOG" \
    && fail "Xcode has no Apple account" "Open Xcode, Settings, Accounts, and add your Apple ID again."
  fail "build or signing failed" "Details in $BUILD_LOG."
fi

APP="$DERIVED/Build/Products/Debug-iphoneos/HealthBridge.app"
expiry=$(security cms -D -i "$APP/embedded.mobileprovision" 2>/dev/null | plutil -extract ExpirationDate raw - 2>/dev/null)

xcrun devicectl device install app --device "$DEVICE_ID" "$APP" >/dev/null 2>&1 \
  || fail "install on the iPhone failed" "Keep the iPhone unlocked and on the same network as the Mac."

print -r -- "$now" > "$STATE"
log "renewed, new expiry $expiry (UTC)"
