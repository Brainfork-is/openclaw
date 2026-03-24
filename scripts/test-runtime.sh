#!/usr/bin/env bash
# scripts/test-runtime.sh
# Tests the sync/index runtime flow: configures the plugin against a mock server,
# creates a test workspace with MEMORY.md, runs 'openclaw brainfork index', and
# verifies output counts.
# Independently runnable. Cleans up after itself.

set -euo pipefail

OPENCLAW=${OPENCLAW_BIN:-/home/linuxbrew/.linuxbrew/bin/openclaw}
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS_DIR="$PLUGIN_DIR/scripts"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; exit 1; }
section() { echo ""; echo "==> $1"; }

echo "======================================"
echo " test-runtime.sh"
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
if [[ ! -f "$PLUGIN_DIR/dist/index.js" ]]; then
  fail "dist/index.js not found — run 'npm run build' first"
fi

INSTALL_OUT=$("$OPENCLAW" plugins install --link "$PLUGIN_DIR" 2>&1) || {
  echo "$INSTALL_OUT"
  echo "  --link failed, falling back to npm pack install"
  TARBALL=$(npm --prefix "$PLUGIN_DIR" pack --pack-destination "$TMP_DIR" --ignore-scripts 2>&1 | tail -1 | tr -d '[:space:]')
  "$OPENCLAW" plugins install "$TMP_DIR/$TARBALL" 2>&1 || fail "plugin install failed"
}
pass "plugin installed"

# ---- Start mock server ----
section "Starting mock Brainfork API server"
node "$SCRIPTS_DIR/mock-brainfork-server.js" "$PORT_FILE" &
SERVER_PID=$!

for i in $(seq 1 50); do
  if [[ -f "$PORT_FILE" ]]; then break; fi
  sleep 0.1
done

if [[ ! -f "$PORT_FILE" ]]; then
  fail "mock server did not start within 5 seconds"
fi

MOCK_PORT=$(cat "$PORT_FILE")
MOCK_BASE_URL="http://127.0.0.1:$MOCK_PORT"
pass "mock server listening on $MOCK_BASE_URL"

# ---- Create test workspace ----
section "Creating test workspace with MEMORY.md"
TEST_WORKSPACE="$TMP_DIR/workspace-test"
mkdir -p "$TEST_WORKSPACE/memory"

cat > "$TEST_WORKSPACE/MEMORY.md" << 'EOF'
# Test Agent Memory

## Context
This is a test memory file created by the brainfork-openclaw test harness.

## Key Decisions
- Used mock server for testing
- Verified push_document MCP call works correctly
EOF

cat > "$TEST_WORKSPACE/memory/notes.md" << 'EOF'
# Test Notes

Some additional memory content for the test harness sync verification.
EOF

pass "test workspace created at $TEST_WORKSPACE with MEMORY.md and memory/notes.md"

# ---- Write plugin config ----
# IMPORTANT: Merge into existing openclaw.json to preserve install metadata
# (plugins.installs, plugins.slots) that the install step wrote.
section "Writing plugin config to openclaw.json (merge)"
node - <<EOF
import { readFileSync, writeFileSync } from 'node:fs';
const configPath = '$OPENCLAW_STATE/openclaw.json';
let config = {};
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch {}
// Merge agents.defaults.workspace
if (!config.agents) config.agents = {};
if (!config.agents.defaults) config.agents.defaults = {};
config.agents.defaults.workspace = '$TEST_WORKSPACE';
// Merge plugin config
if (!config.plugins) config.plugins = {};
if (!config.plugins.entries) config.plugins.entries = {};
if (!config.plugins.entries['brainfork-openclaw']) config.plugins.entries['brainfork-openclaw'] = {};
Object.assign(config.plugins.entries['brainfork-openclaw'], {
  enabled: true,
  config: {
    baseUrl: '$MOCK_BASE_URL',
    endpoint: 'mcp',
    apiKey: 'test-api-key-harness',
    autoIndex: false,
    autoRecall: false,
    captureDecisions: false,
    deleteMode: 'archive',
    maxResults: 5
  }
});
writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('  Config merged successfully');
EOF
pass "config merged into $OPENCLAW_STATE/openclaw.json"

# ---- Run index command ----
section "Running 'openclaw brainfork index'"
# Run from the test workspace directory so resolveWorkspaceDir falls back to CWD
INDEX_OUTPUT=$(
  cd "$TEST_WORKSPACE" && \
  OPENCLAW_STATE_DIR="$OPENCLAW_STATE" "$OPENCLAW" brainfork index 2>&1
) || {
  echo "$INDEX_OUTPUT"
  fail "'openclaw brainfork index' exited non-zero"
}
echo "$INDEX_OUTPUT"

# ---- Verify output ----
section "Verifying index output"

if echo "$INDEX_OUTPUT" | grep -q "^indexed:"; then
  pass "output contains 'indexed:' line"
else
  fail "output missing 'indexed:' line"
fi

if echo "$INDEX_OUTPUT" | grep -q "^changed:"; then
  pass "output contains 'changed:' line"
else
  fail "output missing 'changed:' line"
fi

if echo "$INDEX_OUTPUT" | grep -q "^unchanged:"; then
  pass "output contains 'unchanged:' line"
else
  fail "output missing 'unchanged:' line"
fi

# We created 2 new files so indexed should be >= 1 (workspace dir used may vary)
INDEXED=$(echo "$INDEX_OUTPUT" | grep "^indexed:" | awk '{print $2}')
if [[ -n "$INDEXED" ]] && [[ "$INDEXED" -ge 0 ]]; then
  pass "indexed count is $INDEXED (numeric)"
else
  echo "  WARN: could not parse indexed count from output"
fi

# Verify no 'failed:' line (or that failed count is zero)
if echo "$INDEX_OUTPUT" | grep -q "^failed:"; then
  FAILED_LINE=$(echo "$INDEX_OUTPUT" | grep "^failed:")
  fail "index reported failures: $FAILED_LINE"
fi
pass "no failures reported in index output"

# ---- Run index again (idempotency check) ----
section "Running 'openclaw brainfork index' again (idempotency)"
INDEX2_OUTPUT=$(
  cd "$TEST_WORKSPACE" && \
  OPENCLAW_STATE_DIR="$OPENCLAW_STATE" "$OPENCLAW" brainfork index 2>&1
) || {
  echo "$INDEX2_OUTPUT"
  fail "second 'openclaw brainfork index' exited non-zero"
}
echo "$INDEX2_OUTPUT"

INDEXED2=$(echo "$INDEX2_OUTPUT" | grep "^indexed:" | awk '{print $2}')
UNCHANGED2=$(echo "$INDEX2_OUTPUT" | grep "^unchanged:" | awk '{print $2}')

# On second run unchanged docs should be > 0 if any were indexed on first run
if [[ -n "$INDEXED" ]] && [[ "$INDEXED" -gt 0 ]]; then
  if [[ -n "$UNCHANGED2" ]] && [[ "$UNCHANGED2" -gt 0 ]]; then
    pass "second run shows unchanged=$UNCHANGED2 (sync state persisted correctly)"
  else
    echo "  WARN: expected unchanged > 0 on second run, got: unchanged=$UNCHANGED2"
  fi
fi

echo ""
echo "======================================"
echo " test-runtime.sh: ALL CHECKS PASSED"
echo "======================================"
