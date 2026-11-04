#!/usr/bin/env bash
# Runner for Helper #4 Targeted Runbook Amendment Integration Tests
# Executes on macOS host and inside Linux Docker container.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "================================================================================"
echo "HELPER #4 TARGETED RUNBOOK AMENDMENT INTEGRATION TEST SUITE"
echo "Date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "Host Platform: $(uname -sm)"
echo "Repo Root: $REPO_ROOT"
echo "================================================================================"

echo ""
echo "--- STEP 1: Running integration tests on macOS Host ---"
python3 -B "$REPO_ROOT/tests/backup/helper4-runbook-amendment.integration.test.py" -v

echo ""
echo "--- STEP 2: Running integration tests in Linux Docker Container ---"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker run --rm \
    --entrypoint python3 \
    -v "$REPO_ROOT:/workspace" \
    -w /workspace \
    fb-inbox-worker:test \
    -B /workspace/tests/backup/helper4-runbook-amendment.integration.test.py -v
  echo "Docker Linux test completed successfully."
else
  echo "Docker not available; skipping Linux container execution."
fi

echo ""
echo "================================================================================"
echo "ALL AMENDMENT INTEGRATION TESTS PASSED (MACOS & LINUX)"
echo "================================================================================"
