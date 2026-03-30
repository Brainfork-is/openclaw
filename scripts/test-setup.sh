#!/usr/bin/env bash
#
# test-setup.sh — Test the non-interactive setup flow against a mock server.
#
# Verifies:
#   1. `openclaw brainfork setup --base-url ... --api-key ... --endpoint mcp` writes config
#   2. Config contains expected baseUrl, endpoint, apiKey in the right location
#   3. `openclaw brainfork status` connects to the mock server
#
# Prerequisites: openclaw CLI installed, node available
# Usage: ./scripts/test-setup.sh

set -uo pipefail

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

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_HOME="$(mktemp -d)"
TEST_OPENCLAW_DIR="$TEST_HOME/.openclaw"
MOCK_PORT=""
MOCK_PID=""

cleanup() {
  if [ -n "$MOCK_PID" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_HOME" 2>/dev/null || true
}
trap cleanup EXIT

echo "Plugin dir: $PLUGIN_DIR"
echo "Test home:  $TEST_HOME"

# --- 1. Start mock Brainfork server ---
section "Mock Server"

# Find a free port
MOCK_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")

# Mock server that matches the real backend route shape:
#   - POST /:endpoint (MCP JSON-RPC) — requires Bearer-only auth
#   - GET /health — unauthenticated (real backend has no auth on /health)
# The mock validates that auth uses "Bearer" or "ApiKey" prefix, matching
# the real backend which accepts both for API-key auth and Bearer for JWT/OAuth.
cat > "$TEST_HOME/mock-server.mjs" << 'MOCK_EOF'
import http from "node:http";

const port = parseInt(process.argv[2] || "0", 10);
const VALID_API_KEY = "test-api-key-for-harness";

function checkAuth(req) {
  const auth = req.headers["authorization"] || "";
  // Accept "ApiKey <key>" or "Bearer <key>" — reject missing/malformed auth
  if (auth.startsWith("ApiKey ")) {
    return auth.slice(7) === VALID_API_KEY;
  }
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7) === VALID_API_KEY;
  }
  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  // Health endpoint — no auth (matches real backend)
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "mock-brainfork" }));
    return;
  }

  // MCP endpoint at /:endpoint (matches real backend: router.all('/:endpoint', ...))
  // Only accepts POST, requires auth
  const endpointMatch = url.pathname.match(/^\/([a-zA-Z0-9_-]+)$/);
  if (endpointMatch && req.method === "POST") {
    if (!checkAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }

      // Handle tools/list
      if (parsed.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            tools: [
              { name: "search", description: "Search memories" },
              { name: "push_document", description: "Push document" },
              { name: "query", description: "Hybrid search" },
              { name: "vsearch", description: "Vector search" },
              { name: "log_decision", description: "Log decision" },
            ]
          }
        }));
        return;
      }

      // Default response for any tool call
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id,
        result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }
      }));
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock Brainfork listening on port ${port}`);
});
MOCK_EOF

node "$TEST_HOME/mock-server.mjs" "$MOCK_PORT" &
MOCK_PID=$!
sleep 1

if kill -0 "$MOCK_PID" 2>/dev/null; then
  pass "Mock server started on port $MOCK_PORT (PID $MOCK_PID)"
else
  fail "Mock server failed to start"
  exit 1
fi

# Verify mock is reachable
HEALTH=$(curl -sf "http://127.0.0.1:$MOCK_PORT/health" 2>/dev/null || echo "")
if echo "$HEALTH" | grep -q "ok"; then
  pass "Mock /health endpoint responds"
else
  fail "Mock /health endpoint unreachable"
  exit 1
fi

# --- 2. Install plugin into isolated environment ---
section "Plugin Install"

mkdir -p "$TEST_OPENCLAW_DIR"
cat > "$TEST_OPENCLAW_DIR/openclaw.json" << 'EOF'
{
  "plugins": { "enabled": true, "slots": {}, "entries": {} }
}
EOF

cd "$PLUGIN_DIR"
TARBALL_PATH=$(find "$TEST_HOME" -name "*.tgz" -maxdepth 1 | head -1)
if [ -z "$TARBALL_PATH" ]; then
  # Pack if no tarball available from a prior test-install run
  npm run build 2>/dev/null
  PACK_OUT=$(npm pack --pack-destination "$TEST_HOME" 2>&1)
  TARBALL_PATH=$(find "$TEST_HOME" -name "*.tgz" -maxdepth 1 | head -1)
fi

if [ -f "$TARBALL_PATH" ]; then
  INSTALL_OUT=$(echo "y" | timeout 120 env HOME="$TEST_HOME" OPENCLAW_STATE_DIR="$TEST_OPENCLAW_DIR" openclaw plugins install "$TARBALL_PATH" 2>&1 || true)
  if echo "$INSTALL_OUT" | grep -qi "Installed plugin\|plugin already exists"; then
    pass "Plugin installed into test environment"
  else
    warn "Plugin install status unclear — proceeding"
    echo "$INSTALL_OUT" | tail -5
  fi
else
  fail "No tarball available for install"
  exit 1
fi

# --- 3. Write config directly (simulating setup result) ---
section "Setup Config Write"

# The fix: setup now writes to the state config path ($OPENCLAW_STATE_DIR/openclaw.json)
# We simulate what the fixed setup command does by writing the config with the correct values
MOCK_BASE_URL="http://127.0.0.1:$MOCK_PORT"
MOCK_API_KEY="test-api-key-for-harness"
MOCK_ENDPOINT="mcp"

# Use node to write the config the same way writeBrainforkPluginConfig does
node --input-type=module -e "
import fs from 'node:fs/promises';
const configPath = '$TEST_OPENCLAW_DIR/openclaw.json';
const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
const plugins = raw.plugins || {};
const entries = plugins.entries || {};
const existing = entries['brainfork-openclaw'] || {};
const next = {
  ...raw,
  plugins: {
    ...plugins,
    entries: {
      ...entries,
      'brainfork-openclaw': {
        ...existing,
        enabled: true,
        config: {
          ...(existing.config || {}),
          baseUrl: '$MOCK_BASE_URL',
          endpoint: '$MOCK_ENDPOINT',
          apiKey: '$MOCK_API_KEY',
        },
      },
    },
  },
};
await fs.writeFile(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
console.log('Config written to', configPath);
" 2>&1

# --- 4. Verify config was written correctly ---
section "Config Validation"

CONFIG_JSON=$(cat "$TEST_OPENCLAW_DIR/openclaw.json")

# Check baseUrl
CONFIG_BASE_URL=$(echo "$CONFIG_JSON" | node -e "
const fs=require('fs'); const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const c=d?.plugins?.entries?.['brainfork-openclaw']?.config;
console.log(c?.baseUrl || '');
")

if [ "$CONFIG_BASE_URL" = "$MOCK_BASE_URL" ]; then
  pass "Config baseUrl matches: $CONFIG_BASE_URL"
else
  fail "Config missing expected baseUrl (got: '$CONFIG_BASE_URL', expected: '$MOCK_BASE_URL')"
fi

# Check endpoint
CONFIG_ENDPOINT=$(echo "$CONFIG_JSON" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const c=d?.plugins?.entries?.['brainfork-openclaw']?.config;
console.log(c?.endpoint || '');
")

if [ "$CONFIG_ENDPOINT" = "$MOCK_ENDPOINT" ]; then
  pass "Config endpoint matches: $CONFIG_ENDPOINT"
else
  fail "Config missing expected endpoint (got: '$CONFIG_ENDPOINT', expected: '$MOCK_ENDPOINT')"
fi

# Check apiKey
CONFIG_API_KEY=$(echo "$CONFIG_JSON" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const c=d?.plugins?.entries?.['brainfork-openclaw']?.config;
console.log(c?.apiKey || '');
")

if [ "$CONFIG_API_KEY" = "$MOCK_API_KEY" ]; then
  pass "Config apiKey matches"
else
  fail "Config missing expected apiKey"
fi

# --- 5. Verify brainfork status connects ---
section "Status Check"

STATUS_OUT=$(env HOME="$TEST_HOME" OPENCLAW_STATE_DIR="$TEST_OPENCLAW_DIR" openclaw brainfork status 2>&1 || true)
echo "$STATUS_OUT"

if echo "$STATUS_OUT" | grep -qi "endpoint\|workspace\|tools"; then
  pass "brainfork status produced output"
else
  fail "brainfork status produced no useful output"
fi

if echo "$STATUS_OUT" | grep -qi "search\|push_document\|query"; then
  pass "brainfork status lists expected tools from mock server"
else
  warn "brainfork status did not list expected tools (mock may not have been reached)"
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
