#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Rebuild all Swift sources; compile to a temporary path so a failed build never
# replaces the last working binary. BUILD_ONLY=1 is used for verification.
if [ ! -f "$DIR/zalo-recorder" ] || [ "$DIR/main.swift" -nt "$DIR/zalo-recorder" ] || [ "$DIR/AudioCapture.swift" -nt "$DIR/zalo-recorder" ] || [ "$DIR/RecordingSupport.swift" -nt "$DIR/zalo-recorder" ] || [ "$DIR/UploadSupport.swift" -nt "$DIR/zalo-recorder" ] || [ "$DIR/Info.plist" -nt "$DIR/zalo-recorder" ]; then
    echo "Compiling Native Zalo Recorder..."
    BUILD_PATH="$(mktemp -d "${TMPDIR:-/tmp}/zalo-build.XXXXXX")"
    trap 'rm -rf "$BUILD_PATH"' EXIT
    swiftc -O -target arm64-apple-macos13.0 -module-cache-path "$DIR/.build/modules" \
        "$DIR/AudioCapture.swift" "$DIR/RecordingSupport.swift" "$DIR/UploadSupport.swift" "$DIR/main.swift" \
        -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$DIR/Info.plist" \
        -o "$BUILD_PATH/zalo-recorder"
    codesign --force --sign - --identifier com.local.zalo-recorder "$BUILD_PATH/zalo-recorder"
    mv "$BUILD_PATH/zalo-recorder" "$DIR/zalo-recorder"
fi

if [ "${BUILD_ONLY:-0}" = "1" ]; then exit 0; fi
exec "$DIR/zalo-recorder" "$@"
