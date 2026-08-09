#!/usr/bin/env bash
# Runs the full Postman regression suite against the local test server.
# Usage:
#   ./scripts/regression.sh                  # schema + error tests only
#   ANTHROPIC_API_KEY=sk-... ./scripts/regression.sh   # all tests incl. LLM
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${TEST_SERVER_PORT:-3737}"
RESULTS_DIR="$ROOT/results"
mkdir -p "$RESULTS_DIR"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
REPORT="$RESULTS_DIR/newman-$TIMESTAMP.json"

echo "=== Multiagent Framework — Regression Suite ==="
echo "Server: http://localhost:$PORT"
echo "API key: ${ANTHROPIC_API_KEY:+present (LLM tests enabled)}${ANTHROPIC_API_KEY:-NOT SET (LLM tests will be skipped)}"
echo ""

# ── Start test server ─────────────────────────────────────────────────────────
echo "[1/3] Starting test server..."
TEST_SERVER_PORT="$PORT" node "$ROOT/dist/server.js" &
SERVER_PID=$!

# Wait for server to become ready (max 10s)
for i in $(seq 1 20); do
  if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
    echo "      Server ready (pid $SERVER_PID)"
    break
  fi
  sleep 0.5
  if [ "$i" -eq 20 ]; then
    echo "ERROR: Server did not start within 10 seconds"
    kill "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi
done

# ── Run Newman ────────────────────────────────────────────────────────────────
echo ""
echo "[2/3] Running Postman collection..."
set +e
npx newman run "$ROOT/postman/multiagent-framework.postman_collection.json" \
  --environment "$ROOT/postman/local.postman_environment.json" \
  --env-var "base_url=http://localhost:$PORT" \
  --reporters cli,json \
  --reporter-json-export "$REPORT" \
  --bail
NEWMAN_EXIT=$?
set -e

# ── Teardown ──────────────────────────────────────────────────────────────────
echo ""
echo "[3/3] Stopping test server (pid $SERVER_PID)..."
kill "$SERVER_PID" 2>/dev/null || true

echo ""
echo "=== Results ==="
echo "JSON report: $REPORT"

if [ "$NEWMAN_EXIT" -eq 0 ]; then
  echo "STATUS: ALL TESTS PASSED ✓"
else
  echo "STATUS: SOME TESTS FAILED ✗ (exit code $NEWMAN_EXIT)"
fi

exit "$NEWMAN_EXIT"
