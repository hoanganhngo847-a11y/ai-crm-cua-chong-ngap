#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_PATH="$(mktemp -d "${TMPDIR:-/tmp}/zalo-tests-build.XXXXXX")"
trap 'rm -rf "$BUILD_PATH"' EXIT
swiftc -O -target arm64-apple-macos13.0 -module-cache-path "$DIR/.build/modules" \
    "$DIR/AudioCapture.swift" "$DIR/RecordingSupport.swift" "$DIR/UploadSupport.swift" "$DIR/tests/main.swift" \
    -o "$BUILD_PATH/regressions"
"$BUILD_PATH/regressions"
