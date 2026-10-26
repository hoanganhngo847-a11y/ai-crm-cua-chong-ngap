#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_PATH="$(mktemp -d "${TMPDIR:-/tmp}/zalo-tests-build.XXXXXX")"
TMP_PKG="$(mktemp -d "${TMPDIR:-/tmp}/zalo-pkg-test.XXXXXX")"
trap 'rm -rf "$BUILD_PATH" "$TMP_PKG"' EXIT

echo "=== 1. Compiling Unit and Regression Tests ==="
swiftc -O -target arm64-apple-macos13.0 -module-cache-path "$DIR/.build/modules" \
    "$DIR/AudioCapture.swift" "$DIR/RecordingSupport.swift" "$DIR/UploadSupport.swift" \
    "$DIR/PermissionManager.swift" \
    "$DIR/HeartbeatManager.swift" "$DIR/ZaloAutomation.swift" "$DIR/LoopbackServer.swift" \
    "$DIR/OutboundCallManager.swift" "$DIR/LiveVoiceBridge.swift" \
    "$DIR/tests/main.swift" \
    -o "$BUILD_PATH/regressions"

echo "=== 2. Running Unit and Regression Tests ==="
"$BUILD_PATH/regressions" "$DIR"

echo "=== 3. Running Packaging & Local Signing Tests ==="

# 3.1. Local Signing Setup Discovery check
set +e
SETUP_OUT="$(bash "$DIR/run.sh" --setup-local-signing 2>&1)"
SETUP_STATUS=$?
set -e
if [[ "$SETUP_OUT" != *"Zalo Recorder Local Signing"* ]]; then
    echo "ERROR: --setup-local-signing did not mention expected identity 'Zalo Recorder Local Signing'!" >&2
    exit 1
fi
echo "PASS: local signing identity discovery and guidance verified"

# 3.2. Local Release packaging fails closed if local identity missing
set +e
LOCAL_REL_OUT="$(LOCAL_SIGNING_IDENTITY="MissingLocalSigningIdentity" PACKAGE_OUTPUT_DIR="$TMP_PKG/local-release" bash "$DIR/run.sh" --package --local-release 2>&1)"
LOCAL_REL_STATUS=$?
set -e
if [ $LOCAL_REL_STATUS -eq 0 ]; then
    echo "ERROR: Local release packaging should have failed without 'Zalo Recorder Local Signing' identity in Keychain!" >&2
    exit 1
fi
if [[ "$LOCAL_REL_OUT" != *"LOCAL_SIGNING_IDENTITY_MISSING"* ]]; then
    echo "ERROR: Local release packaging did not output expected error LOCAL_SIGNING_IDENTITY_MISSING: $LOCAL_REL_OUT" >&2
    exit 1
fi
if [[ "$LOCAL_REL_OUT" != *"NEVER falls back to ad-hoc"* ]]; then
    echo "ERROR: Local release packaging did not state it never falls back to ad-hoc: $LOCAL_REL_OUT" >&2
    exit 1
fi
if [ -d "$TMP_PKG/local-release/Zalo Recorder.app" ]; then
    echo "ERROR: Staging bundle was created despite missing local signing identity!" >&2
    exit 1
fi
echo "PASS: local release fails closed if local identity missing and never falls back to ad-hoc"

# 3.3. Dev mode remains explicitly ad-hoc with prominent warning
DEV_OUT="$(PACKAGE_OUTPUT_DIR="$TMP_PKG/dev" bash "$DIR/run.sh" --package --dev 2>&1)"
if [[ "$DEV_OUT" != *"DEV AD-HOC BUILDS DO NOT PROVIDE TCC PERSISTENCE"* ]]; then
    echo "ERROR: Dev packaging missing expected non-persistence warning: $DEV_OUT" >&2
    exit 1
fi
DEV_APP="$TMP_PKG/dev/Zalo Recorder.app"
if [ ! -d "$DEV_APP" ]; then
    echo "ERROR: Dev app bundle was not created at $DEV_APP" >&2
    exit 1
fi
if [ ! -f "$DEV_APP/Contents/Info.plist" ]; then
    echo "ERROR: Dev app bundle missing Contents/Info.plist" >&2
    exit 1
fi
if [ ! -f "$DEV_APP/Contents/MacOS/zalo-recorder" ]; then
    echo "ERROR: Dev app bundle missing Contents/MacOS/zalo-recorder" >&2
    exit 1
fi
if [ ! -x "$DEV_APP/Contents/MacOS/zalo-recorder" ]; then
    echo "ERROR: Dev app binary is not executable" >&2
    exit 1
fi
codesign --verify --deep --strict "$DEV_APP"
echo "PASS: dev mode remains explicitly ad-hoc with valid app bundle structure"

# 3.4. Designated requirement extraction & comparison tests
# Extract requirement from dev app (should be cdhash)
DEV_REQ="$(codesign -d -r- "$DEV_APP" 2>&1 | grep -E '^#? ?designated =>' | sed -E 's/^#? ?designated => //')"
if [[ "$DEV_REQ" != *"cdhash"* ]]; then
    echo "ERROR: Expected cdhash in ad-hoc dev bundle requirement: $DEV_REQ" >&2
    exit 1
fi
echo "PASS: designated requirement extraction verified"

# Test verify-update fails when comparing ad-hoc/cdhash app bundles (LOCAL_SIGNING_IDENTITY_MISMATCH)
set +e
VERIFY_OUT="$(bash "$DIR/run.sh" --verify-update "$DEV_APP" "$DEV_APP" 2>&1)"
VERIFY_STATUS=$?
set -e
if [ $VERIFY_STATUS -eq 0 ]; then
    echo "ERROR: --verify-update should have failed for ad-hoc cdhash app!" >&2
    exit 1
fi
if [[ "$VERIFY_OUT" != *"LOCAL_SIGNING_IDENTITY_MISMATCH"* ]]; then
    echo "ERROR: Expected LOCAL_SIGNING_IDENTITY_MISMATCH on ad-hoc update check, got: $VERIFY_OUT" >&2
    exit 1
fi
echo "PASS: incompatible designated requirement blocks update with LOCAL_SIGNING_IDENTITY_MISMATCH"

# 3.5. First-time install designated requirement allows installation when no installed app exists
FIRST_INSTALL_OUT="$(bash "$DIR/run.sh" --verify-update "$DEV_APP" "$TMP_PKG/non-existent-app" 2>&1)"
if [[ "$FIRST_INSTALL_OUT" != *"No installed app found"* ]]; then
    echo "ERROR: Expected first-time install notification, got: $FIRST_INSTALL_OUT" >&2
    exit 1
fi
echo "PASS: first-time install check permits initial installation"

# 3.6. Verify LaunchAgent target configuration in run.sh
if ! grep -q 'APP_DIR="\$HOME/Applications/\$APP_NAME"' "$DIR/run.sh"; then
    echo "ERROR: run.sh does not configure APP_DIR in ~/Applications" >&2
    exit 1
fi
if ! grep -q '\${APP_DIR}/Contents/MacOS/zalo-recorder' "$DIR/run.sh"; then
    echo "ERROR: run.sh LaunchAgent plist does not target \${APP_DIR}/Contents/MacOS/zalo-recorder" >&2
    exit 1
fi
echo "PASS: correct LaunchAgent target to ~/Applications/Zalo Recorder.app/Contents/MacOS/zalo-recorder"

echo "=== ALL LOCAL AGENT, PACKAGING & LOCAL SIGNING TESTS PASSED ==="
