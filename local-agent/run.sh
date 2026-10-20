#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_LABEL="com.local.zalo-recorder.agent"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_DIR="$HOME/Library/Application Support/ZaloRecordingAgent"
LOG_FILE="$LOG_DIR/agent.log"

compile_agent() {
    if [ ! -f "$DIR/zalo-recorder" ] || \
       [ "$DIR/main.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/AudioCapture.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/RecordingSupport.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/UploadSupport.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/HeartbeatManager.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/ZaloAutomation.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/LoopbackServer.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/OutboundCallManager.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/Info.plist" -nt "$DIR/zalo-recorder" ]; then
        echo "Compiling Native Zalo Recorder v1.2.0..."
        BUILD_PATH="$(mktemp -d "${TMPDIR:-/tmp}/zalo-build.XXXXXX")"
        trap 'rm -rf "$BUILD_PATH"' EXIT
        swiftc -O -target arm64-apple-macos13.0 -module-cache-path "$DIR/.build/modules" \
            "$DIR/AudioCapture.swift" "$DIR/RecordingSupport.swift" "$DIR/UploadSupport.swift" \
            "$DIR/HeartbeatManager.swift" "$DIR/ZaloAutomation.swift" "$DIR/LoopbackServer.swift" \
            "$DIR/OutboundCallManager.swift" "$DIR/main.swift" \
            -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$DIR/Info.plist" \
            -o "$BUILD_PATH/zalo-recorder"
        codesign --force --sign - --identifier com.local.zalo-recorder "$BUILD_PATH/zalo-recorder"
        mv "$BUILD_PATH/zalo-recorder" "$DIR/zalo-recorder"
    fi
}

install_agent() {
    compile_agent
    mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
    chmod 700 "$LOG_DIR"

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
        <string>${DIR}/zalo-recorder</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${DIR}</string>
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
        "$DIR/zalo-recorder" --status
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
        "$DIR/zalo-recorder" --status
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
    "$DIR/zalo-recorder" --status
}

# Main command dispatcher
case "${1:-}" in
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
