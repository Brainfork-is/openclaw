#!/usr/bin/env bash
# scripts/test-setup.sh
# Tests the manual setup flow: pipes input to 'openclaw brainfork setup',
# verifies config is written correctly, then runs 'brainfork status' against
# a mock Brainfork API server.
# Independently runnable. Cleans up after itself.

set -euo pipefail

OPENCLAW=${OPENCLAW_BIN:-/home/linuxbrew/.linuxbrew/bin/openclaw}
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS_DIR="$PLUGIN_DIR/scripts"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; exit 1; }
section() { echo ""; echo "==> $1"; }

echo "======================================"
echo " test-setup.sh"
echo "======================================"

# ---- Temp dir setup ----
TMP_DIR=$(mktemp -d)
PORT_FILE="$TMP_DIR/mock-server.port"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

OPENCLAW_STATE="$TMP_DIR/openclaw-state"
mkdir -p "$OPENCLAW_STATE"

export OPENCLAW_STATE_DIR="$OPENCLAW_STATE"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE/openclaw.json"

# ---- Install plugin ----
section "Installing plugin into isolated OPENCLAW_STATE_DIR"
# Reuse existing dist to avoid a slow rebuild; dist must exist
if [[ ! -f "$PLUGIN_DIR/dist/index.js" ]]; then
  fail "dist/index.js not found — run 'npm run build' first, or run test-install.sh which builds"
fi

INSTALL_OUT=$("$OPENCLAW" plugins install --link "$PLUGIN_DIR" 2>&1) || {
  echo "$INSTALL_OUT"
  # --link may not be supported; fall back to tarball install
  echo "  --link failed, falling back to npm pack install"
  TARBALL=$(npm --prefix "$PLUGIN_DIR" pack --pack-destination "$TMP_DIR" --ignore-scripts 2>&1 | tail -1 | tr -d '[:space:]')
  "$OPENCLAW" plugins install "$TMP_DIR/$TARBALL" 2>&1 || fail "plugin install failed"
}
pass "plugin installed"

# ---- Start mock server ----
section "Starting mock Brainfork API server"
node "$SCRIPTS_DIR/mock-brainfork-server.js" "$PORT_FILE" &
SERVER_PID=$!

# Wait up to 5 seconds for the server to write its port
for i in $(seq 1 50); do
  if [[ -f "$PORT_FILE" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -f "$PORT_FILE" ]]; then
  fail "mock server did not start within 5 seconds"
fi

MOCK_PORT=$(cat "$PORT_FILE")
MOCK_BASE_URL="http://127.0.0.1:$MOCK_PORT"
pass "mock server listening on $MOCK_BASE_URL"

# Sanity-check /health endpoint
HEALTH=$(curl -sf "$MOCK_BASE_URL/health") || fail "mock server /health did not respond"
if echo "$HEALTH" | grep -q '"ok"'; then
  pass "mock server /health returns {\"status\":\"ok\"}"
else
  fail "mock server /health unexpected response: $HEALTH"
fi

# ---- Run non-interactive manual setup via CLI flags ----
# Uses --base-url, --api-key, --endpoint flags for scriptable/CI setup.
# Validates against the mock server and writes config to openclaw.json.
section "Running 'openclaw brainfork setup' with CLI flags (non-interactive)"
CONFIG_PATH="$OPENCLAW_STATE/openclaw.json"

SETUP_OUTPUT=$(
  "$OPENCLAW" brainfork setup \
    --base-url "$MOCK_BASE_URL" \
    --api-key "test-api-key-harness" \
    --endpoint "mcp" \
  2>&1
) || {
  echo "$SETUP_OUTPUT"
  fail "'openclaw brainfork setup' exited non-zero"
}
echo "$SETUP_OUTPUT"

# Verify setup reported success
if echo "$SETUP_OUTPUT" | grep -q "Connected to Brainfork"; then
  pass "setup reported successful connection"
else
  fail "setup did not report 'Connected to Brainfork'"
fi

# Verify config was written with expected values using OpenClaw's resolved config
# path rather than assuming the plugin writes to $OPENCLAW_STATE/openclaw.json.
RESOLVED_CONFIG_PATH=$("$OPENCLAW" config file 2>/dev/null | tail -1 | tr -d '[:space:]')
if [[ -z "$RESOLVED_CONFIG_PATH" || ! -f "$RESOLVED_CONFIG_PATH" ]]; then
  fail "could not resolve active openclaw config file after setup"
fi
pass "active config file resolved to $RESOLVED_CONFIG_PATH"

# openclaw config get doesn't support deeply nested plugin config paths,
# so we read the values directly from the JSON config file.
BASE_URL_VALUE=$(node -e "const c=JSON.parse(require('fs').readFileSync('$RESOLVED_CONFIG_PATH','utf8')); console.log(c.plugins?.entries?.['brainfork-openclaw']?.config?.baseUrl ?? '')")
ENDPOINT_VALUE=$(node -e "const c=JSON.parse(require('fs').readFileSync('$RESOLVED_CONFIG_PATH','utf8')); console.log(c.plugins?.entries?.['brainfork-openclaw']?.config?.endpoint ?? '')")
API_KEY_VALUE=$(node -e "const c=JSON.parse(require('fs').readFileSync('$RESOLVED_CONFIG_PATH','utf8')); console.log(c.plugins?.entries?.['brainfork-openclaw']?.config?.apiKey ?? '')")

if [[ "$BASE_URL_VALUE" == "$MOCK_BASE_URL" ]]; then
  pass "config contains mock server baseUrl"
else
  echo "  expected baseUrl: $MOCK_BASE_URL"
  echo "  actual baseUrl:   $BASE_URL_VALUE"
  fail "config missing expected baseUrl"
fi

if [[ "$ENDPOINT_VALUE" == "mcp" ]]; then
  pass "config contains endpoint field"
else
  echo "  actual endpoint: $ENDPOINT_VALUE"
  fail "config missing expected endpoint"
fi

if [[ "$API_KEY_VALUE" == "test-api-key-harness" ]]; then
  pass "config contains apiKey field"
else
  echo "  actual apiKey: $API_KEY_VALUE"
  fail "config missing expected apiKey"
fi

pass "non-interactive setup completed and config validated"

# ---- Run status command ----
section "Running 'openclaw brainfork status'"
STATUS_OUTPUT=$(
  "$OPENCLAW" brainfork status 2>&1
) || {
  echo "$STATUS_OUTPUT"
  fail "'openclaw brainfork status' exited non-zero"
}
echo "$STATUS_OUTPUT"

if echo "$STATUS_OUTPUT" | grep -q "endpoint:"; then
  pass "status output contains 'endpoint:' line"
else
  fail "status output missing 'endpoint:' line"
fi

if echo "$STATUS_OUTPUT" | grep -q "tools:"; then
  pass "status output contains 'tools:' line"
else
  fail "status output missing 'tools:' line"
fi

# Verify tools are not 'unavailable' (which would mean MCP connect failed)
if echo "$STATUS_OUTPUT" | grep -q "tools:.*unavailable"; then
  fail "status shows tools as 'unavailable' — MCP connection to mock server failed"
fi
pass "status shows tools available (MCP connection succeeded)"

echo ""
echo "======================================"
echo " test-setup.sh: ALL CHECKS PASSED"
echo "======================================"
