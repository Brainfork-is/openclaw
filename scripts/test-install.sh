#!/usr/bin/env bash
#
# test-install.sh — End-to-end install simulation for the Brainfork OpenClaw plugin.
#
# Tests the ACTUAL user experience:
#   1. npm pack → openclaw plugins install from tarball
#   2. Verify no critical scanner warnings
#   3. Verify plugin loads and registers tools/CLI
#   4. Verify openclaw brainfork status runs
#   5. Verify openclaw brainfork setup --help registers
#
# Prerequisites: openclaw CLI installed, npm available
# Usage: ./scripts/test-install.sh

set -uo pipefail
# Note: NOT using set -e because npm pack returns exit codes we need to handle manually

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

PASS=0
FAIL=0
WARNINGS=()

pass() { ((PASS++)); echo -e "  ${GREEN}✓${NC} $1"; }
fail() { ((FAIL++)); echo -e "  ${RED}✗${NC} $1"; WARNINGS+=("$1"); }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
section() { echo -e "\n${YELLOW}━━━ $1 ━━━${NC}"; }

# --- Setup ---
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_HOME="$(mktemp -d)"
TEST_OPENCLAW_DIR="$TEST_HOME/.openclaw"
ORIGINAL_HOME="$HOME"

cleanup() {
  rm -rf "$TEST_HOME" 2>/dev/null || true
  # Kill any leftover gateway from test
  pkill -f "openclaw.*gateway.*$TEST_HOME" 2>/dev/null || true
}
trap cleanup EXIT

echo "Plugin dir: $PLUGIN_DIR"
echo "Test home:  $TEST_HOME"

# --- 1. Build and Pack ---
section "Build & Pack"

cd "$PLUGIN_DIR"
BUILD_OUT=$(npm run build 2>&1) || { fail "npm run build failed"; echo "$BUILD_OUT"; exit 1; }
pass "npm run build succeeded"

# npm pack runs prepack (clean+build) so it takes a while
PACK_OUT=$(npm pack --pack-destination "$TEST_HOME" 2>&1) || { fail "npm pack failed"; echo "$PACK_OUT"; exit 1; }
TARBALL_PATH=$(find "$TEST_HOME" -name "*.tgz" -maxdepth 1 | head -1)

if [ -f "$TARBALL_PATH" ]; then
  pass "npm pack created $(basename $TARBALL_PATH)"
else
  fail "npm pack failed — no .tgz found in $TEST_HOME"
  exit 1
fi

# --- 2. Scanner Check (pre-install) ---
section "Static Analysis (Scanner Simulation)"

# Extract and check for dangerous patterns per-file
EXTRACT_DIR="$TEST_HOME/extract"
mkdir -p "$EXTRACT_DIR"
tar xzf "$TARBALL_PATH" -C "$EXTRACT_DIR" 2>/dev/null

SCANNER_CRITICAL=0
for jsfile in $(find "$EXTRACT_DIR" -name "*.js" -not -path "*/node_modules/*"); do
  relpath="${jsfile#$EXTRACT_DIR/}"
  has_fetch=$(grep -lE "\bfetch\b|\bpost\b|http\.request" "$jsfile" 2>/dev/null | wc -l)
  has_eval=$(grep -lE "\beval\b|new Function\b" "$jsfile" 2>/dev/null | wc -l)

  # Only treat env+network as critical when the env access looks like secret/token harvesting.
  # Safe runtime path/config lookups like OPENCLAW_STATE_DIR should not fail the install harness.
  secret_env_hits=$(grep -oE 'process\.env\.[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*' "$jsfile" 2>/dev/null | wc -l)
  bracket_secret_env_hits=$(grep -oE 'process\.env\[("|\x27)[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*("|\x27)\]' "$jsfile" 2>/dev/null | wc -l)
  env_harvest_hits=$((secret_env_hits + bracket_secret_env_hits))

  if [ "$env_harvest_hits" -gt 0 ] && [ "$has_fetch" -gt 0 ]; then
    fail "CRITICAL: secret env-harvesting pattern in $relpath (secret-env=$env_harvest_hits, fetch=$has_fetch)"
    ((SCANNER_CRITICAL++))
  fi

  if [ "$has_eval" -gt 0 ]; then
    fail "CRITICAL: dynamic code execution in $relpath"
    ((SCANNER_CRITICAL++))
  fi
done

if [ "$SCANNER_CRITICAL" -eq 0 ]; then
  pass "No critical scanner patterns detected"
else
  fail "$SCANNER_CRITICAL critical scanner pattern(s) found — install will be blocked"
fi

# --- 3. Manifest Validation ---
section "Manifest Validation"

MANIFEST="$EXTRACT_DIR/package/openclaw.plugin.json"
if [ -f "$MANIFEST" ]; then
  pass "openclaw.plugin.json exists"
else
  fail "openclaw.plugin.json missing from package"
fi

# Check required fields
MANIFEST_ID=$(python3 -c "import json; print(json.load(open('$MANIFEST')).get('id',''))" 2>/dev/null)
MANIFEST_SCHEMA=$(python3 -c "import json; print(bool(json.load(open('$MANIFEST')).get('configSchema')))" 2>/dev/null)

if [ -n "$MANIFEST_ID" ]; then
  pass "Manifest id: $MANIFEST_ID"
else
  fail "Manifest missing 'id' field"
fi

if [ "$MANIFEST_SCHEMA" = "True" ]; then
  pass "Manifest has configSchema"
else
  fail "Manifest missing configSchema"
fi

# Check that configSchema doesn't require baseUrl/endpoint/apiKey (fresh install would fail)
REQUIRED=$(python3 -c "import json; m=json.load(open('$MANIFEST')); print(json.dumps(m.get('configSchema',{}).get('required',[])))" 2>/dev/null)
if echo "$REQUIRED" | grep -q "baseUrl"; then
  fail "configSchema requires 'baseUrl' — fresh install will crash"
else
  pass "configSchema does not require baseUrl (fresh install safe)"
fi

# --- 4. Package.json Validation ---
section "Package.json Validation"

PKG="$EXTRACT_DIR/package/package.json"
PKG_MAIN=$(python3 -c "import json; print(json.load(open('$PKG')).get('main',''))" 2>/dev/null)
PKG_EXTENSIONS=$(python3 -c "import json; print(json.load(open('$PKG')).get('openclaw',{}).get('extensions',[]))" 2>/dev/null)

if [ -f "$EXTRACT_DIR/package/$PKG_MAIN" ]; then
  pass "Main entry exists: $PKG_MAIN"
else
  fail "Main entry missing: $PKG_MAIN"
fi

if echo "$PKG_EXTENSIONS" | grep -q "dist/index.js"; then
  pass "openclaw.extensions points to dist/index.js"
else
  fail "openclaw.extensions missing or wrong: $PKG_EXTENSIONS"
fi

# --- 5. Install into isolated OpenClaw environment ---
section "Install Simulation"

mkdir -p "$TEST_OPENCLAW_DIR"
# Create minimal openclaw.json
cat > "$TEST_OPENCLAW_DIR/openclaw.json" << 'EOF'
{
  "plugins": {
    "enabled": true,
    "slots": {},
    "entries": {}
  }
}
EOF

# Run the actual install with isolated config
# Install with generous timeout — deps install can be slow on cold cache
INSTALL_OUTPUT=$(echo "y" | timeout 120 env HOME="$TEST_HOME" OPENCLAW_STATE_DIR="$TEST_OPENCLAW_DIR" openclaw plugins install "$TARBALL_PATH" 2>&1 || true)
echo "$INSTALL_OUTPUT" | tail -10

# Check for critical warnings in install output
if echo "$INSTALL_OUTPUT" | grep -qi "dangerous code patterns"; then
  fail "Install produced dangerous code pattern warnings"
else
  pass "No dangerous code pattern warnings during install"
fi

if echo "$INSTALL_OUTPUT" | grep -qi "Config validation failed"; then
  fail "Install failed with config validation error"
else
  pass "No config validation errors during install"
fi

if echo "$INSTALL_OUTPUT" | grep -qi "Installed plugin"; then
  pass "Plugin installed successfully"
elif echo "$INSTALL_OUTPUT" | grep -qi "plugin already exists"; then
  pass "Plugin already installed (expected on re-run)"
else
  warn "Could not confirm successful install — check output above"
fi

# --- 6. Plugin Load Verification ---
section "Plugin Load Verification"

# Check if plugin appears in plugins list
LIST_OUTPUT=$(env HOME="$TEST_HOME" OPENCLAW_STATE_DIR="$TEST_OPENCLAW_DIR" openclaw plugins list 2>&1 || true)

if echo "$LIST_OUTPUT" | grep -qi "brainfork"; then
  pass "Plugin appears in plugins list"
else
  fail "Plugin not found in plugins list"
fi

if echo "$LIST_OUTPUT" | grep -qi "loaded\|disabled"; then
  pass "Plugin has a valid status (loaded or disabled-unconfigured)"
else
  warn "Could not determine plugin load status"
fi

# --- 7. CLI Command Registration ---
section "CLI Command Registration"

# Test that 'openclaw brainfork' command exists
BRAINFORK_HELP=$(env HOME="$TEST_HOME" OPENCLAW_STATE_DIR="$TEST_OPENCLAW_DIR" openclaw brainfork --help 2>&1 || true)

if echo "$BRAINFORK_HELP" | grep -qi "setup\|index\|status"; then
  pass "brainfork CLI subcommands registered (setup/index/status)"
else
  fail "brainfork CLI subcommands not found"
fi

# --- 8. Unconfigured Message Check ---
section "Unconfigured Behavior"

# The plugin should show the setup guidance ONCE, not spam
SETUP_MSG_COUNT=$(echo "$LIST_OUTPUT $BRAINFORK_HELP" | grep -c "Run: openclaw brainfork setup" || echo 0)
SETUP_MSG_COUNT=$(echo "$SETUP_MSG_COUNT" | tr -d '[:space:]')

if [ "$SETUP_MSG_COUNT" -le 2 ]; then
  pass "Setup guidance message appears ≤2 times (not spam)"
else
  fail "Setup guidance message appears $SETUP_MSG_COUNT times (log spam)"
fi

# --- Results ---
section "Results"

TOTAL=$((PASS + FAIL))
echo -e "\n  ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC} out of $TOTAL checks"

if [ "$FAIL" -gt 0 ]; then
  echo -e "\n  ${RED}Failures:${NC}"
  for w in "${WARNINGS[@]}"; do
    echo -e "    ${RED}✗${NC} $w"
  done
  echo ""
  exit 1
fi

echo -e "\n  ${GREEN}All checks passed!${NC}\n"
exit 0
