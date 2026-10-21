#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_LABEL="com.local.zalo-recorder.agent"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_DIR="$HOME/Library/Application Support/ZaloRecordingAgent"
LOG_FILE="$LOG_DIR/agent.log"
APP_NAME="Zalo Recorder.app"
APP_DIR="$HOME/Applications/$APP_NAME"
PACKAGE_OUTPUT_DIR="${PACKAGE_OUTPUT_DIR:-$DIR/build}"

find_developer_id_identity() {
    security find-identity -p codesigning -v 2>/dev/null | grep "Developer ID Application:" | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/' || true
}

compile_agent() {
    if [ ! -f "$DIR/zalo-recorder" ] || \
       [ "$DIR/main.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/AudioCapture.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/RecordingSupport.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/UploadSupport.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/PermissionManager.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/HeartbeatManager.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/ZaloAutomation.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/LoopbackServer.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/OutboundCallManager.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/entitlements.plist" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/Info.plist" -nt "$DIR/zalo-recorder" ]; then
        echo "Compiling Native Zalo Recorder v1.2.0..."
        BUILD_PATH="$(mktemp -d "${TMPDIR:-/tmp}/zalo-build.XXXXXX")"
        trap 'rm -rf "$BUILD_PATH"' EXIT
        swiftc -O -target arm64-apple-macos13.0 -module-cache-path "$DIR/.build/modules" \
            "$DIR/AudioCapture.swift" "$DIR/RecordingSupport.swift" "$DIR/UploadSupport.swift" \
            "$DIR/PermissionManager.swift" "$DIR/HeartbeatManager.swift" "$DIR/ZaloAutomation.swift" \
            "$DIR/LoopbackServer.swift" "$DIR/OutboundCallManager.swift" "$DIR/main.swift" \
            -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$DIR/Info.plist" \
            -o "$BUILD_PATH/zalo-recorder"
        codesign --force --sign - --identifier com.local.zalo-recorder --entitlements "$DIR/entitlements.plist" "$BUILD_PATH/zalo-recorder"
        mv "$BUILD_PATH/zalo-recorder" "$DIR/zalo-recorder"
    fi
}

build_app_bundle() {
    local mode="${1:-release}"
    local dest_dir="$PACKAGE_OUTPUT_DIR"
    local app_bundle="$dest_dir/$APP_NAME"

    compile_agent

    echo "Packaging $APP_NAME ($mode mode)..."
    mkdir -p "$dest_dir"
    rm -rf "$app_bundle"

    mkdir -p "$app_bundle/Contents/MacOS"
    mkdir -p "$app_bundle/Contents/Resources"

    cp "$DIR/Info.plist" "$app_bundle/Contents/Info.plist"
    cp "$DIR/zalo-recorder" "$app_bundle/Contents/MacOS/zalo-recorder"
    chmod 755 "$app_bundle/Contents/MacOS/zalo-recorder"

    if [ "$mode" = "release" ]; then
        local identity
        identity="$(find_developer_id_identity)"
        if [ -z "$identity" ]; then
            echo "ERROR: Developer ID Application signing identity is required for production packaging to ensure persistent TCC permissions. No valid Developer ID Application certificate found in Keychain." >&2
            echo "See local-agent/NOTARIZATION.md for instructions on installing your Developer ID certificate." >&2
            rm -rf "$app_bundle"
            return 1
        fi
        echo "Signing with Developer ID: $identity..."
        codesign --force --deep --options runtime --timestamp \
            --entitlements "$DIR/entitlements.plist" \
            --sign "$identity" \
            "$app_bundle"
        codesign --verify --deep --strict --verbose=2 "$app_bundle"
        echo "Successfully packaged and signed release bundle: $app_bundle"
    elif [ "$mode" = "dev" ] || [ "$mode" = "adhoc" ]; then
        echo "================================================================================"
        echo "WARNING: Building app bundle with AD-HOC signing (--dev)."
        echo "WARNING: Ad-hoc signing ties TCC identity to CDHash."
        echo "WARNING: Permissions will NOT persist across builds!"
        echo "================================================================================"
        codesign --force --deep \
            --entitlements "$DIR/entitlements.plist" \
            --sign - \
            "$app_bundle"
        codesign --verify --deep --strict --verbose=2 "$app_bundle"
        echo "Successfully packaged ad-hoc development bundle: $app_bundle"
    else
        echo "ERROR: Unknown package mode '$mode'. Use --release or --dev." >&2
        return 1
    fi
}

install_agent() {
    local mode="release"
    if [ -z "$(find_developer_id_identity)" ]; then
        echo "Note: No Developer ID found, falling back to --dev for install packaging."
        mode="dev"
    fi
    build_app_bundle "$mode"

    mkdir -p "$HOME/Applications" "$HOME/Library/LaunchAgents" "$LOG_DIR"
    chmod 700 "$LOG_DIR"

    rm -rf "$APP_DIR"
    cp -R "$PACKAGE_OUTPUT_DIR/$APP_NAME" "$APP_DIR"

    # Stop any existing process so LaunchAgent can bind the port and take lock
    launchctl bootout "gui/$UID/$PLIST_LABEL" 2>/dev/null || launchctl unload "$PLIST_PATH" 2>/dev/null || true
    pkill -x zalo-recorder 2>/dev/null || true
    sleep 0.5

    cat <<EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${APP_DIR}/Contents/MacOS/zalo-recorder</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${LOG_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>
</dict>
</plist>
EOF
    chmod 644 "$PLIST_PATH"

    echo "Bootstrapping LaunchAgent ${PLIST_LABEL}..."
    launchctl bootstrap "gui/$UID" "$PLIST_PATH" 2>/dev/null || launchctl load -w "$PLIST_PATH"

    echo "Verifying agent health..."
    local attempts=0
    local healthy=0
    while [ $attempts -lt 10 ]; do
        sleep 0.5
        if curl -s -f http://127.0.0.1:48123/health >/dev/null 2>&1; then
            healthy=1
            break
        fi
        attempts=$((attempts + 1))
    done

    if [ "$healthy" = "1" ]; then
        echo "LaunchAgent installed and running successfully!"
        "$APP_DIR/Contents/MacOS/zalo-recorder" --status
    else
        echo "LaunchAgent loaded, but loopback health check failed to respond in time."
        echo "Check log at: $LOG_FILE"
        exit 1
    fi
}

uninstall_agent() {
    echo "Stopping and uninstalling LaunchAgent ${PLIST_LABEL}..."
    launchctl bootout "gui/$UID/$PLIST_LABEL" 2>/dev/null || launchctl unload "$PLIST_PATH" 2>/dev/null || true
    pkill -x zalo-recorder 2>/dev/null || true
    if [ -f "$PLIST_PATH" ]; then
        rm -f "$PLIST_PATH"
        echo "Removed plist: $PLIST_PATH"
    fi
    if [ -d "$APP_DIR" ]; then
        rm -rf "$APP_DIR"
        echo "Removed app: $APP_DIR"
    fi
    echo "LaunchAgent uninstalled."
    echo "Note: Local recordings and Keychain device secret are preserved."
}

restart_agent() {
    echo "Restarting Zalo Recording Agent..."
    if [ -f "$PLIST_PATH" ]; then
        launchctl kickstart -k "gui/$UID/$PLIST_LABEL" 2>/dev/null || {
            launchctl bootout "gui/$UID/$PLIST_LABEL" 2>/dev/null || launchctl unload "$PLIST_PATH" 2>/dev/null || true
            sleep 0.5
            launchctl bootstrap "gui/$UID" "$PLIST_PATH" 2>/dev/null || launchctl load -w "$PLIST_PATH"
        }
    else
        pkill -x zalo-recorder 2>/dev/null || true
        sleep 0.5
        install_agent
        return
    fi

    local attempts=0
    local healthy=0
    while [ $attempts -lt 10 ]; do
        sleep 0.5
        if curl -s -f http://127.0.0.1:48123/health >/dev/null 2>&1; then
            healthy=1
            break
        fi
        attempts=$((attempts + 1))
    done

    if [ "$healthy" = "1" ]; then
        echo "Agent restarted successfully."
        if [ -f "$APP_DIR/Contents/MacOS/zalo-recorder" ]; then
            "$APP_DIR/Contents/MacOS/zalo-recorder" --status
        else
            "$DIR/zalo-recorder" --status
        fi
    else
        echo "Agent restarted, waiting for loopback health..."
    fi
}

show_status() {
    compile_agent
    if [ -f "$PLIST_PATH" ]; then
        echo "LaunchAgent Plist: Installed ($PLIST_PATH)"
        local running_line
        running_line="$(launchctl list | grep "${PLIST_LABEL}" || true)"
        if [ -n "$running_line" ]; then
            echo "LaunchAgent Status: Active in launchd (${running_line})"
        else
            echo "LaunchAgent Status: Not loaded in launchd"
        fi
    else
        echo "LaunchAgent Plist: Not installed (run --install to enable auto-start)"
    fi
    echo ""
    if [ -f "$APP_DIR/Contents/MacOS/zalo-recorder" ]; then
        "$APP_DIR/Contents/MacOS/zalo-recorder" --status
    else
        "$DIR/zalo-recorder" --status
    fi
}

# Main command dispatcher
case "${1:-}" in
    --package)
        shift
        pkg_mode="release"
        while [ $# -gt 0 ]; do
            case "$1" in
                --dev|--adhoc)
                    pkg_mode="dev"
                    shift
                    ;;
                --release)
                    pkg_mode="release"
                    shift
                    ;;
                *)
                    break
                    ;;
            esac
        done
        build_app_bundle "$pkg_mode"
        exit $?
        ;;
    --install)
        install_agent
        exit 0
        ;;
    --uninstall)
        uninstall_agent
        exit 0
        ;;
    --restart)
        restart_agent
        exit 0
        ;;
    --status)
        show_status
        exit 0
        ;;
esac

compile_agent

if [ "${BUILD_ONLY:-0}" = "1" ]; then exit 0; fi
exec "$DIR/zalo-recorder" "$@"
