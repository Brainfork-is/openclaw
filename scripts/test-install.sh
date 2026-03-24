#!/usr/bin/env bash
# scripts/test-install.sh
# Tests that the plugin packs, installs, loads, and registers CLI commands correctly.
# Independently runnable. Cleans up after itself.

set -euo pipefail

OPENCLAW=${OPENCLAW_BIN:-/home/linuxbrew/.linuxbrew/bin/openclaw}
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; exit 1; }
section() { echo ""; echo "==> $1"; }

echo "======================================"
echo " test-install.sh"
echo "======================================"

# ---- Temp dir setup ----
TMP_DIR=$(mktemp -d)
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

OPENCLAW_STATE="$TMP_DIR/openclaw-state"
mkdir -p "$OPENCLAW_STATE"

# Fully isolate this test from the real ~/.openclaw installation.
# OPENCLAW_STATE_DIR sets the extensions/plugins directory.
# OPENCLAW_CONFIG_PATH pins the config file so installs don't touch the real openclaw.json.
export OPENCLAW_STATE_DIR="$OPENCLAW_STATE"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE/openclaw.json"

# ---- Pack ----
section "Packing plugin with npm pack"
cd "$PLUGIN_DIR"

# Use --ignore-scripts if dist/index.js already exists (skip costly rebuild).
# In CI, the build step runs before this script.
if [[ -f "$PLUGIN_DIR/dist/index.js" ]]; then
  PACK_OUTPUT=$(npm pack --pack-destination "$TMP_DIR" --ignore-scripts 2>&1)
else
  echo "  dist/index.js not found — running full build via npm pack"
  PACK_OUTPUT=$(npm pack --pack-destination "$TMP_DIR" 2>&1)
fi

# npm pack prints the filename as the last line of stdout
TARBALL_NAME=$(echo "$PACK_OUTPUT" | tail -1 | tr -d '[:space:]')
TARBALL_PATH="$TMP_DIR/$TARBALL_NAME"

if [[ ! -f "$TARBALL_PATH" ]]; then
  echo "  npm pack output: $PACK_OUTPUT"
  fail "npm pack did not produce a tarball at $TARBALL_PATH"
fi
pass "npm pack produced $TARBALL_NAME"

# ---- Install ----
section "Installing plugin into isolated OPENCLAW_STATE_DIR"
INSTALL_OUTPUT=$("$OPENCLAW" plugins install "$TARBALL_PATH" 2>&1) || {
  echo "$INSTALL_OUTPUT"
  fail "openclaw plugins install exited non-zero"
}
echo "$INSTALL_OUTPUT"

# Check for critical severity scanner warnings
if echo "$INSTALL_OUTPUT" | grep -qi "\bcritical\b"; then
  fail "scanner reported a CRITICAL severity warning during install"
fi
pass "no critical scanner warnings"

# Check for config validation errors (distinct from 'not configured' info messages)
if echo "$INSTALL_OUTPUT" | grep -qi "config.*error\|invalid.*config\|validation.*fail"; then
  fail "config validation error detected during install"
fi
pass "no config validation errors"

# ---- Plugin info ----
section "Verifying plugin shows up in 'plugins info'"
INFO_OUTPUT=$("$OPENCLAW" plugins info brainfork-openclaw 2>&1) || {
  echo "$INFO_OUTPUT"
  fail "openclaw plugins info exited non-zero"
}
echo "$INFO_OUTPUT"

if echo "$INFO_OUTPUT" | grep -q "brainfork-openclaw"; then
  pass "plugins info shows brainfork-openclaw"
else
  fail "plugins info does not mention brainfork-openclaw"
fi

if echo "$INFO_OUTPUT" | grep -qi "version.*2026\|2026.*version"; then
  pass "plugins info shows expected version (2026.x)"
else
  # Non-fatal: version format might differ
  echo "  WARN: could not confirm version string in plugins info output"
fi

# ---- CLI command registration ----
section "Verifying CLI command 'brainfork' is registered"
HELP_OUTPUT=$("$OPENCLAW" brainfork --help 2>&1) || {
  echo "$HELP_OUTPUT"
  fail "openclaw brainfork --help exited non-zero"
}
echo "$HELP_OUTPUT"

if echo "$HELP_OUTPUT" | grep -qi "brainfork\|setup\|index\|status"; then
  pass "'openclaw brainfork --help' shows brainfork commands"
else
  fail "'openclaw brainfork --help' output did not show expected subcommands"
fi

# In unconfigured state the plugin should at minimum register 'setup'
if echo "$HELP_OUTPUT" | grep -q "setup"; then
  pass "'setup' subcommand is registered"
else
  fail "'setup' subcommand not found in brainfork --help output"
fi

echo ""
echo "======================================"
echo " test-install.sh: ALL CHECKS PASSED"
echo "======================================"
