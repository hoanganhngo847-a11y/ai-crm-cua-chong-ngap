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
    "$DIR/OutboundCallManager.swift" \
    "$DIR/tests/main.swift" \
    -o "$BUILD_PATH/regressions"

echo "=== 2. Running Unit and Regression Tests ==="
"$BUILD_PATH/regressions" "$DIR"

echo "=== 3. Running Packaging Tests ==="
# Test release packaging fail-closed behavior (no Developer ID in this test environment)
set +e
RELEASE_OUT="$(PACKAGE_OUTPUT_DIR="$TMP_PKG/release" bash "$DIR/run.sh" --package --release 2>&1)"
RELEASE_STATUS=$?
set -e
if [ $RELEASE_STATUS -eq 0 ]; then
    echo "ERROR: Release packaging should have failed without Developer ID Application certificate!" >&2
    exit 1
fi
if [[ "$RELEASE_OUT" != *"Developer ID Application signing identity is required"* ]]; then
    echo "ERROR: Release packaging did not output expected fail-closed message: $RELEASE_OUT" >&2
    exit 1
fi
echo "PASS: Release packaging fails closed when Developer ID Application identity is missing"

# Test dev / ad-hoc packaging
PACKAGE_OUTPUT_DIR="$TMP_PKG/dev" bash "$DIR/run.sh" --package --dev
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
# Verify codesign on dev bundle
codesign --verify --deep --strict "$DEV_APP"
echo "PASS: Dev app packaging created valid, verifiable ad-hoc bundle structure"
echo "=== ALL LOCAL AGENT & PACKAGING TESTS PASSED ==="
