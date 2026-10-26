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
LOCAL_SIGNING_IDENTITY="${LOCAL_SIGNING_IDENTITY:-Zalo Recorder Local Signing}"

find_local_signing_identity() {
    security find-identity -p codesigning -v 2>/dev/null | grep "\"$LOCAL_SIGNING_IDENTITY\"" | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/' || true
}

find_developer_id_identity() {
    security find-identity -p codesigning -v 2>/dev/null | grep "Developer ID Application:" | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/' || true
}

get_designated_requirement() {
    local target="$1"
    if [ ! -e "$target" ]; then
        echo ""
        return 0
    fi
    codesign -d -r- "$target" 2>&1 | grep -E '^#? ?designated =>' | sed -E 's/^#? ?designated => //' | tr -d '\n'
}

compare_designated_requirements() {
    local installed_app="$1"
    local candidate_app="$2"

    if [ ! -d "$installed_app" ]; then
        echo "[Designated Requirement] No installed app found at '$installed_app'. First-time install."
        return 0
    fi

    echo "Checking cryptographic designated requirement compatibility..."
    local installed_req candidate_req
    installed_req="$(get_designated_requirement "$installed_app")"
    candidate_req="$(get_designated_requirement "$candidate_app")"

    if [ -z "$installed_req" ]; then
        echo "ERROR: Unable to extract designated requirement from installed app: $installed_app" >&2
        return 1
    fi
    if [ -z "$candidate_req" ]; then
        echo "ERROR: Unable to extract designated requirement from candidate app: $candidate_app" >&2
        return 1
    fi

    # Fail closed if either requirement relies on ad-hoc cdhash
    if [[ "$installed_req" == *"cdhash"* ]] || [[ "$candidate_req" == *"cdhash"* ]]; then
        echo "ERROR: LOCAL_SIGNING_IDENTITY_MISMATCH" >&2
        echo "Ad-hoc signed application detected (cdhash-dependent)." >&2
        echo "Installed: $installed_req" >&2
        echo "Candidate: $candidate_req" >&2
        echo "Ad-hoc signatures do not preserve TCC permissions across builds." >&2
        return 1
    fi

    # Cryptographic requirement verification via codesign -v -R
    if ! codesign -v -R="$installed_req" "$candidate_app" 2>/dev/null; then
        echo "ERROR: LOCAL_SIGNING_IDENTITY_MISMATCH" >&2
        echo "Candidate app does NOT satisfy installed app's designated requirement!" >&2
        echo "Installed requirement: $installed_req" >&2
        echo "Candidate requirement: $candidate_req" >&2
        echo "Update aborted to prevent TCC permission loss." >&2
        return 1
    fi

    if [ "$installed_req" != "$candidate_req" ]; then
        echo "ERROR: LOCAL_SIGNING_IDENTITY_MISMATCH" >&2
        echo "Designated requirement string mismatch:" >&2
        echo "Installed: $installed_req" >&2
        echo "Candidate: $candidate_req" >&2
        return 1
    fi

    echo "[OK] Designated requirements match. Update is cryptographically compatible."
    return 0
}

setup_local_signing() {
    echo "=== Zalo Recorder: Local Signing Identity Setup ==="
    local existing
    existing="$(find_local_signing_identity)"
    if [ -n "$existing" ]; then
        echo "[OK] Local signing identity already exists in Keychain:"
        echo "     $existing"
        security find-identity -p codesigning -v 2>/dev/null | grep "\"$LOCAL_SIGNING_IDENTITY\""
        echo ""
        echo "No action needed. You can now package using: ./local-agent/run.sh --package --local-release"
        return 0
    fi

    echo "Identity '$LOCAL_SIGNING_IDENTITY' not found in Keychain."
    echo ""
    echo "To create this internal certificate on this Mac (one-time setup, no Apple Developer Program required):"
    echo "------------------------------------------------------------------------------------------------------"
    echo "1. Open 'Keychain Access' app (Applications > Utilities > Keychain Access)."
    echo "2. From the menu bar, choose: Keychain Access > Certificate Assistant > Create a Certificate..."
    echo "3. Fill in the following settings:"
    echo "     - Name: $LOCAL_SIGNING_IDENTITY"
    echo "     - Identity Type: Self Signed Root"
    echo "     - Certificate Type: Code Signing"
    echo "     - Keychain: login"
    echo "4. Click 'Create' (and then 'Done')."
    echo "------------------------------------------------------------------------------------------------------"
    echo "Once created, verify by running:"
    echo "     ./local-agent/run.sh --setup-local-signing"
    echo ""
    echo "For full details, lifecycle, and troubleshooting, see local-agent/LOCAL_SIGNING.md."
    return 1
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
       [ "$DIR/LiveVoiceBridge.swift" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/entitlements.plist" -nt "$DIR/zalo-recorder" ] || \
       [ "$DIR/Info.plist" -nt "$DIR/zalo-recorder" ]; then
        echo "Compiling Native Zalo Recorder v1.2.0..."
        BUILD_PATH="$(mktemp -d "${TMPDIR:-/tmp}/zalo-build.XXXXXX")"
        trap 'rm -rf "$BUILD_PATH"' EXIT
        swiftc -O -target arm64-apple-macos13.0 -module-cache-path "$DIR/.build/modules" \
            "$DIR/AudioCapture.swift" "$DIR/RecordingSupport.swift" "$DIR/UploadSupport.swift" \
            "$DIR/PermissionManager.swift" "$DIR/HeartbeatManager.swift" "$DIR/ZaloAutomation.swift" \
            "$DIR/LoopbackServer.swift" "$DIR/OutboundCallManager.swift" "$DIR/LiveVoiceBridge.swift" "$DIR/main.swift" \
            -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$DIR/Info.plist" \
            -o "$BUILD_PATH/zalo-recorder"
        codesign --force --sign - --identifier com.local.zalo-recorder --entitlements "$DIR/entitlements.plist" "$BUILD_PATH/zalo-recorder"
        mv "$BUILD_PATH/zalo-recorder" "$DIR/zalo-recorder"
    fi
}

build_app_bundle() {
    local mode="${1:-local-release}"
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

    if [ "$mode" = "local-release" ]; then
        local identity
        identity="$(find_local_signing_identity)"
        if [ -z "$identity" ]; then
            echo "ERROR: LOCAL_SIGNING_IDENTITY_MISSING" >&2
            echo "Local signing identity '$LOCAL_SIGNING_IDENTITY' was not found in Keychain." >&2
            echo "Local release mode fails closed and NEVER falls back to ad-hoc signing." >&2
            echo "Run './local-agent/run.sh --setup-local-signing' or see local-agent/LOCAL_SIGNING.md for setup instructions." >&2
            rm -rf "$app_bundle"
            return 1
        fi
        echo "Signing with local identity: $identity..."
        codesign --force --deep --options runtime --timestamp \
            --entitlements "$DIR/entitlements.plist" \
            --sign "$identity" \
            "$app_bundle"
        codesign --verify --deep --strict --verbose=2 "$app_bundle"

        local bundle_id
        bundle_id="$(defaults read "$app_bundle/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || true)"
        if [ "$bundle_id" != "com.local.zalo-recorder" ]; then
            echo "ERROR: Unexpected bundle identifier: '$bundle_id' (expected com.local.zalo-recorder)" >&2
            rm -rf "$app_bundle"
            return 1
        fi

        local req
        req="$(get_designated_requirement "$app_bundle")"
        echo "[Designated Requirement] $req"
        echo "Successfully packaged and signed local release bundle: $app_bundle"

    elif [ "$mode" = "dev" ] || [ "$mode" = "adhoc" ]; then
        echo "================================================================================"
        echo "WARNING: Building app bundle with AD-HOC signing (--dev)."
        echo "WARNING: Ad-hoc signing ties TCC identity to CDHash."
        echo "WARNING: DEV AD-HOC BUILDS DO NOT PROVIDE TCC PERSISTENCE."
        echo "================================================================================"
        codesign --force --deep \
            --entitlements "$DIR/entitlements.plist" \
            --sign - \
            "$app_bundle"
        codesign --verify --deep --strict --verbose=2 "$app_bundle"
        echo "Successfully packaged ad-hoc development bundle: $app_bundle"

    elif [ "$mode" = "release" ]; then
        # Optional public distribution with Developer ID
        local identity
        identity="$(find_developer_id_identity)"
        if [ -z "$identity" ]; then
            echo "ERROR: Developer ID Application signing identity is required for public release packaging." >&2
            echo "For company-internal Macs without Apple Developer Program, use: --package --local-release" >&2
            echo "See local-agent/LOCAL_SIGNING.md and local-agent/NOTARIZATION.md." >&2
            rm -rf "$app_bundle"
            return 1
        fi
        echo "Signing with Developer ID: $identity..."
        codesign --force --deep --options runtime --timestamp \
            --entitlements "$DIR/entitlements.plist" \
            --sign "$identity" \
            "$app_bundle"
        codesign --verify --deep --strict --verbose=2 "$app_bundle"
        echo "Successfully packaged Developer ID release bundle: $app_bundle"
    else
        echo "ERROR: Unknown package mode '$mode'. Use --local-release or --dev." >&2
        return 1
    fi
}

install_agent() {
    local mode="${1:-local-release}"
    build_app_bundle "$mode"

    local candidate="$PACKAGE_OUTPUT_DIR/$APP_NAME"

    # Verify cryptographic compatibility before updating an existing app
    if [ -d "$APP_DIR" ]; then
        echo "Verifying update compatibility against currently installed app..."
        if ! compare_designated_requirements "$APP_DIR" "$candidate"; then
            echo "ERROR: Cannot install candidate app due to designated requirement incompatibility." >&2
            echo "Update aborted. The existing app at '$APP_DIR' was NOT modified." >&2
            return 1
        fi
    fi

    mkdir -p "$HOME/Applications" "$HOME/Library/LaunchAgents" "$LOG_DIR"
    chmod 700 "$LOG_DIR"

    rm -rf "$APP_DIR"
    cp -R "$candidate" "$APP_DIR"

    # Stop any existing process so LaunchAgent can bind the port and take lock
    launchctl bootout "gui/$UID/$PLIST_LABEL" 2>/dev/null || launchctl unload "$PLIST_PATH" 2>/dev/null || true
    pkill -x zalo-recorder 2>/dev/null || true
    sleep 0.5

    local cur_enabled cur_auto cur_uid cur_model cur_version
    if [ -f "$PLIST_PATH" ]; then
        cur_enabled="$(defaults read "$PLIST_PATH" EnvironmentVariables 2>/dev/null | awk -F'"' '/ZALO_PERSONAL_LIVE_VOICE_ENABLED/ {print $4}')"
        cur_auto="$(defaults read "$PLIST_PATH" EnvironmentVariables 2>/dev/null | awk -F'"' '/ZALO_PERSONAL_LIVE_VOICE_AUTO_ANSWER/ {print $4}')"
        cur_uid="$(defaults read "$PLIST_PATH" EnvironmentVariables 2>/dev/null | awk -F'"' '/ZALO_VOICE_OUTPUT_UID/ {print $4}')"
        cur_model="$(defaults read "$PLIST_PATH" EnvironmentVariables 2>/dev/null | awk -F'"' '/GEMINI_LIVE_MODEL/ {print $4}')"
        cur_version="$(defaults read "$PLIST_PATH" EnvironmentVariables 2>/dev/null | awk -F'"' '/GEMINI_LIVE_API_VERSION/ {print $4}')"
    fi

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
    <key>EnvironmentVariables</key>
    <dict>
        <key>ZALO_PERSONAL_LIVE_VOICE_ENABLED</key>
        <string>${ZALO_PERSONAL_LIVE_VOICE_ENABLED:-${cur_enabled:-1}}</string>
        <key>ZALO_PERSONAL_LIVE_VOICE_AUTO_ANSWER</key>
        <string>${ZALO_PERSONAL_LIVE_VOICE_AUTO_ANSWER:-${cur_auto:-1}}</string>
        <key>ZALO_VOICE_OUTPUT_UID</key>
        <string>${ZALO_VOICE_OUTPUT_UID:-${cur_uid:-BlackHole2ch_UID}}</string>
        <key>GEMINI_LIVE_MODEL</key>
        <string>${GEMINI_LIVE_MODEL:-${cur_model:-gemini-2.5-flash-native-audio-preview-12-2025}}</string>
        <key>GEMINI_LIVE_API_VERSION</key>
        <string>${GEMINI_LIVE_API_VERSION:-${cur_version:-v1alpha}}</string>
    </dict>
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
    --setup-local-signing)
        setup_local_signing
        exit $?
        ;;
    --verify-update)
        shift
        if [ $# -lt 1 ]; then
            echo "Usage: ./local-agent/run.sh --verify-update <candidate_app> [installed_app]" >&2
            exit 1
        fi
        cand="$1"
        inst="${2:-$APP_DIR}"
        compare_designated_requirements "$inst" "$cand"
        exit $?
        ;;
    --package)
        shift
        pkg_mode="local-release"
        while [ $# -gt 0 ]; do
            case "$1" in
                --dev|--adhoc)
                    pkg_mode="dev"
                    shift
                    ;;
                --local-release)
                    pkg_mode="local-release"
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
        install_agent "${2:-local-release}"
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
