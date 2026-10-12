#!/bin/bash
set -e

echo "=========================================================="
echo "  META BUSINESS SUITE INBOX WORKER - RENDER DOCKER RUNTIME"
echo "=========================================================="
echo "Node Version: $(node -v)"
echo "Target User Data Directory: ${FB_PROFILE_DIR:-/var/data/fb-user-data}"
echo "ENABLE_SETUP_UI: ${ENABLE_SETUP_UI:-false}"
echo "PORT (Gateway): ${PORT:-3099}"

# 1. Ensure persistent profile directory exists
PROFILE_DIR="${FB_PROFILE_DIR:-/var/data/fb-user-data}"
mkdir -p "$PROFILE_DIR"

# 2. Clean up any stale X11 sockets or locks from previous runs
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true

# 3. Handle Setup Mode vs Headless Mode
XVFB_PID=""
FLUXBOX_PID=""
X11VNC_PID=""
WEBSOCKIFY_PID=""

if [ "${ENABLE_SETUP_UI}" = "true" ]; then
  echo "----------------------------------------------------------"
  echo "[ENTRYPOINT] ENABLE_SETUP_UI=true"
  echo "  Starting Xvfb virtual display (:99)..."
  echo "  Starting x11vnc on internal localhost (127.0.0.1:5900)..."
  echo "  Starting websockify on internal localhost (127.0.0.1:6080)..."
  echo "  (Only Node Gateway will listen on public 0.0.0.0:${PORT:-3099})"
  echo "----------------------------------------------------------"

  # Virtual frame buffer on display :99
  Xvfb :99 -screen 0 1440x900x24 -ac +extension GLX +render -noreset &
  XVFB_PID=$!
  sleep 1

  # Minimal window manager for clean window resizing and focus handling
  if command -v fluxbox >/dev/null 2>&1; then
    DISPLAY=:99 fluxbox &
    FLUXBOX_PID=$!
  fi

  # x11vnc bound STRICTLY to 127.0.0.1 (never 0.0.0.0)
  x11vnc -display :99 -listen 127.0.0.1 -rfbport 5900 -forever -nopw -shared -quiet &
  X11VNC_PID=$!

  # websockify serving noVNC assets bound STRICTLY to 127.0.0.1 (never 0.0.0.0)
  websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/dev/null 2>&1 &
  WEBSOCKIFY_PID=$!

  export DISPLAY=:99
  export HEADLESS=false
  echo "[ENTRYPOINT] Virtual display environment ready on DISPLAY=:99 (Chromium HEADED mode forced)"
else
  echo "----------------------------------------------------------"
  echo "[ENTRYPOINT] ENABLE_SETUP_UI=false (Pure Headless Production)"
  echo "  Xvfb, x11vnc, websockify are NOT started."
  echo "  Chromium will run headless with minimum memory footprint."
  echo "----------------------------------------------------------"
  export HEADLESS=true
fi

# Cleanup handler on container shutdown
cleanup() {
  echo "[ENTRYPOINT] Shutting down helper processes..."
  if [ -n "$WEBSOCKIFY_PID" ]; then kill -TERM "$WEBSOCKIFY_PID" 2>/dev/null || true; fi
  if [ -n "$X11VNC_PID" ]; then kill -TERM "$X11VNC_PID" 2>/dev/null || true; fi
  if [ -n "$FLUXBOX_PID" ]; then kill -TERM "$FLUXBOX_PID" 2>/dev/null || true; fi
  if [ -n "$XVFB_PID" ]; then kill -TERM "$XVFB_PID" 2>/dev/null || true; fi
  exit 0
}

trap cleanup SIGINT SIGTERM

if [ $# -gt 0 ]; then
  echo "[ENTRYPOINT] Executing custom command: $@"
  exec "$@"
fi

echo "[ENTRYPOINT] Starting Node.js Worker & Gateway on 0.0.0.0:${PORT:-3099}..."
exec node src/index.js
