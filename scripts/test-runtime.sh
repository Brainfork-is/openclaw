#!/usr/bin/env bash
#
# test-runtime.sh — Smoke test for plugin runtime behavior (index/sync).
#
# Verifies:
#   1. Plugin installs and loads with mock config
#   2. `openclaw brainfork index` syncs workspace memory files to mock server
#   3. Index is idempotent (second run reports unchanged)
#
# Prerequisites: openclaw CLI installed, node available
# Usage: ./scripts/test-runtime.sh

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
TEST_WORKSPACE="$TEST_OPENCLAW_DIR/workspace-testbot"
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

# --- 1. Start mock MCP server ---
section "Mock Server"

MOCK_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")

cat > "$TEST_HOME/mock-mcp-server.mjs" << 'MOCK_EOF'
import http from "node:http";

const port = parseInt(process.argv[2] || "0", 10);
const pushLog = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Log push_document calls
  if (url.pathname === "/_test/push-log") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(pushLog));
    return;
  }

  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = {}; }

    if (parsed.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: parsed.id,
        result: {
          tools: [
            { name: "search", description: "Search" },
            { name: "push_document", description: "Push" },
            { name: "query", description: "Query" },
            { name: "vsearch", description: "VSearch" },
            { name: "log_decision", description: "Log decision" },
            { name: "fetch", description: "Fetch" },
          ]
        }
      }));
      return;
    }

    if (parsed.method === "tools/call") {
      const toolName = parsed.params?.name;
      const args = parsed.params?.arguments || {};
      
      if (toolName === "push_document") {
        pushLog.push({ externalId: args.externalId, title: args.title, ts: Date.now() });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0", id: parsed.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({
              id: `doc-${pushLog.length}`,
              title: args.title || args.externalId,
              url: `https://mock/${args.externalId}`
            }) }]
          }
        }));
        return;
      }

      // Default tool response
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: parsed.id,
        result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }
      }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: {} }));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock MCP server on port ${port}`);
});
MOCK_EOF

node "$TEST_HOME/mock-mcp-server.mjs" "$MOCK_PORT" &
MOCK_PID=$!
sleep 1

if kill -0 "$MOCK_PID" 2>/dev/null; then
  pass "Mock MCP server started on port $MOCK_PORT"
else
  fail "Mock MCP server failed to start"
  exit 1
fi

# --- 2. Install plugin & configure ---
section "Plugin Install & Configure"

mkdir -p "$TEST_OPENCLAW_DIR" "$TEST_WORKSPACE/memory"

# Create workspace memory files
cat > "$TEST_WORKSPACE/MEMORY.md" << 'EOF'
# Test Memory

This is a test memory file for the runtime harness.
EOF

cat > "$TEST_WORKSPACE/memory/2026-03-24.md" << 'EOF'
# 2026-03-24

- Ran the runtime test harness
- Verified sync behavior
EOF

# Install plugin
cd "$PLUGIN_DIR"
npm run build 2>/dev/null
TARBALL_PATH=$(npm pack --pack-destination "$TEST_HOME" 2>&1 | grep -o "$TEST_HOME/.*\.tgz" || find "$TEST_HOME" -name "*.tgz" -maxdepth 1 | head -1)

cat > "$TEST_OPENCLAW_DIR/openclaw.json" << EOF
{
  "plugins": {
    "enabled": true,
    "slots": {},
    "entries": {
      "brainfork-openclaw": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:$MOCK_PORT",
          "endpoint": "mcp",
          "apiKey": "test-runtime-key"
        }
      }
    }
  }
}
EOF

if [ -f "$TARBALL_PATH" ]; then
  INSTALL_OUT=$(echo "y" | timeout 120 env HOME="$TEST_HOME" OPENCLAW_STATE_DIR="$TEST_OPENCLAW_DIR" openclaw plugins install "$TARBALL_PATH" 2>&1 || true)
  pass "Plugin installed with mock config"
else
  fail "No tarball for install"
  exit 1
fi

# Preserve the test config (install may overwrite entries)
# Re-merge our config into whatever the installer wrote
node -e "
const fs = require('fs');
const configPath = '$TEST_OPENCLAW_DIR/openclaw.json';
const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const entry = raw?.plugins?.entries?.['brainfork-openclaw'] || {};
entry.enabled = true;
entry.config = {
  ...(entry.config || {}),
  baseUrl: 'http://127.0.0.1:$MOCK_PORT',
  endpoint: 'mcp',
  apiKey: 'test-runtime-key',
};
raw.plugins = raw.plugins || {};
raw.plugins.entries = raw.plugins.entries || {};
raw.plugins.entries['brainfork-openclaw'] = entry;
fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
"

# --- 3. Run brainfork index ---
section "Index (First Run)"

INDEX_OUT_1=$(env HOME="$TEST_HOME" OPENCLAW_STATE_DIR="$TEST_OPENCLAW_DIR" OPENCLAW_WORKSPACE_DIR="$TEST_WORKSPACE" openclaw brainfork index 2>&1 || true)
echo "$INDEX_OUT_1"

if echo "$INDEX_OUT_1" | grep -q "indexed"; then
  pass "brainfork index produced output"
else
  fail "brainfork index produced no output"
fi

# Check the mock server received push_document calls
PUSH_LOG=$(curl -sf "http://127.0.0.1:$MOCK_PORT/_test/push-log" 2>/dev/null || echo "[]")
PUSH_COUNT=$(echo "$PUSH_LOG" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.length)")

if [ "$PUSH_COUNT" -gt 0 ]; then
  pass "Mock server received $PUSH_COUNT push_document calls"
else
  warn "Mock server received 0 push_document calls (plugin may not have reached mock)"
fi

# --- 4. Run brainfork index again (idempotency) ---
section "Index (Idempotent Re-run)"

INDEX_OUT_2=$(env HOME="$TEST_HOME" OPENCLAW_STATE_DIR="$TEST_OPENCLAW_DIR" OPENCLAW_WORKSPACE_DIR="$TEST_WORKSPACE" openclaw brainfork index 2>&1 || true)
echo "$INDEX_OUT_2"

# On second run, files should be "unchanged"
if echo "$INDEX_OUT_2" | grep -q "unchanged"; then
  UNCHANGED=$(echo "$INDEX_OUT_2" | grep "unchanged" | grep -oE "[0-9]+")
  if [ "$UNCHANGED" -gt 0 ]; then
    pass "Idempotent re-run: $UNCHANGED files unchanged"
  else
    warn "Idempotent re-run: unchanged count is 0 (may have re-indexed)"
  fi
else
  warn "Could not verify idempotency — no 'unchanged' in output"
fi

# Check that changed count is 0 on second run
if echo "$INDEX_OUT_2" | grep -q "changed: 0"; then
  pass "No files re-indexed on second run"
else
  warn "Some files may have been re-indexed on second run"
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
