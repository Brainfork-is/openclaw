#!/usr/bin/env bash
#
# test-harness.sh — Orchestrate all install/setup/runtime tests.
#
# Runs:
#   1. test-install.sh  — Build, pack, scanner, install simulation
#   2. test-setup.sh    — Setup config write + status check
#   3. test-runtime.sh  — Index sync + idempotency
#
# Usage: ./scripts/test-harness.sh
#        npm run test:install

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERALL_PASS=0
OVERALL_FAIL=0

run_test() {
  local name="$1"
  local script="$2"

  echo -e "\n${YELLOW}╔══════════════════════════════════════════╗${NC}"
  echo -e "${YELLOW}║  $name${NC}"
  echo -e "${YELLOW}╚══════════════════════════════════════════╝${NC}"

  if bash "$script"; then
    ((OVERALL_PASS++))
    echo -e "\n  ${GREEN}▶ $name: PASSED${NC}"
  else
    ((OVERALL_FAIL++))
    echo -e "\n  ${RED}▶ $name: FAILED${NC}"
  fi
}

echo -e "${YELLOW}Brainfork OpenClaw Plugin — Full Test Harness${NC}"
echo "================================================"

run_test "Install Simulation" "$SCRIPT_DIR/test-install.sh"
run_test "Setup Flow"         "$SCRIPT_DIR/test-setup.sh"
run_test "Runtime Smoke Test" "$SCRIPT_DIR/test-runtime.sh"

echo -e "\n${YELLOW}════════════════════════════════════════════${NC}"
echo -e "  ${GREEN}$OVERALL_PASS passed${NC}, ${RED}$OVERALL_FAIL failed${NC} out of $((OVERALL_PASS + OVERALL_FAIL)) test suites"

if [ "$OVERALL_FAIL" -gt 0 ]; then
  echo -e "\n  ${RED}Some test suites failed!${NC}\n"
  exit 1
fi

echo -e "\n  ${GREEN}All test suites passed!${NC}\n"
exit 0
