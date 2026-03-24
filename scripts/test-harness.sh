#!/usr/bin/env bash
# scripts/test-harness.sh
# Master test runner: executes all three test scripts in sequence.
# Each sub-script is independently runnable and manages its own cleanup.

set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"

echo ""
echo "############################################"
echo "  brainfork-openclaw install test harness"
echo "############################################"
echo ""

# Ensure the plugin is built before running setup/runtime tests
if [[ ! -f "$PLUGIN_DIR/dist/index.js" ]]; then
  echo "==> Building plugin (dist/index.js not found)"
  npm --prefix "$PLUGIN_DIR" run build
  echo ""
fi

FAILED=()
PASSED=()

run_test() {
  local name="$1"
  local script="$SCRIPTS_DIR/$name"
  echo ""
  echo "--------------------------------------------"
  echo " Running: $name"
  echo "--------------------------------------------"
  if bash "$script"; then
    PASSED+=("$name")
  else
    FAILED+=("$name")
    echo ""
    echo "  *** $name FAILED ***"
  fi
}

run_test "test-install.sh"
run_test "test-setup.sh"
run_test "test-runtime.sh"

echo ""
echo "############################################"
echo "  Results"
echo "############################################"

for t in "${PASSED[@]}"; do
  echo "  PASS  $t"
done
for t in "${FAILED[@]}"; do
  echo "  FAIL  $t"
done

echo ""

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "  ${#FAILED[@]} test(s) failed."
  exit 1
else
  echo "  All ${#PASSED[@]} tests passed."
fi
