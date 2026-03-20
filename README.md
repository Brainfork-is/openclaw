# @brainfork/brainfork-openclaw

Brainfork memory plugin for **OpenClaw**.

It gives OpenClaw agents a Brainfork-backed knowledge base with:

- bounded recall before agent runs via Brainfork `rag_query`
- workspace sync for `MEMORY.md` and `memory/**/*.md`
- decision search and decision logging helpers
- document cleanup via hidden Brainfork `archive_document`

## Quick Start

Install the plugin and run the interactive setup:

```bash
openclaw plugins install @brainfork/brainfork-openclaw
openclaw brainfork setup
```

The setup command offers two authentication paths:

### 1. Browser Login (recommended)

Opens your browser to Brainfork where you log in, select a server, and the plugin receives tokens automatically. Best for desktops and machines with a browser.

### 2. Manual Setup

Prompts you for your Brainfork API URL, endpoint, and API key. Best for headless servers and CI environments.

After setup, restart OpenClaw:

```bash
openclaw gateway restart
```

## Local Development

From an OpenClaw source checkout:

```bash
cd extensions/brainfork-openclaw
npm install
npm run build
openclaw plugins install --link ./extensions/brainfork-openclaw
```

If you change the plugin code, rebuild before restarting OpenClaw.

## Advanced Configuration

You can also configure the plugin manually by editing your `openclaw.json` config directly. Put this under `plugins.entries.brainfork-openclaw.config`:

```json5
{
  baseUrl: "https://api.brainfork.ai",
  endpoint: "mcp/my-team",
  apiKey: "${BRAINFORK_API_KEY}",
  autoRecall: true,
  autoIndex: true,
  captureDecisions: true,
  maxResults: 5,
  similarityThreshold: 0.2,
  maxTokens: 600,
  deleteMode: "archive",
  requestTimeoutMs: 20000
}
```

Notes:

- `endpoint` can be a full MCP URL or a path relative to `baseUrl`.
- `apiKey` accepts either a raw Brainfork key or a full `Bearer ...` / `ApiKey ...` header value.
- Sync state is stored under `~/.openclaw/memory/brainfork/`.
- Removed local files can be ignored, archived remotely, or deleted remotely with `deleteMode`.

## Brainfork Setup

1. Create or open a Brainfork endpoint that exposes the `search`, `fetch`, `rag_query`, `get_decisions`, `log_decision`, `push_document`, and hidden `archive_document` tools.
2. Create a Brainfork API key for that endpoint.
3. Add the key to your OpenClaw config or environment.

## Commands

```bash
openclaw brainfork setup     # Interactive setup (browser OAuth or manual)
openclaw brainfork index     # Sync workspace memory to Brainfork
openclaw brainfork status    # Show connectivity and sync state
```

## Agent Tools

- `brainfork_search`
- `brainfork_fetch`
- `brainfork_get_decisions`
- `brainfork_log_decision`
- `brainfork_push_document`
- `brainfork_vsearch`
- `brainfork_query`

## Troubleshooting

### Browser OAuth doesn't open on a headless server

The browser OAuth flow requires a desktop environment. On headless servers (VPS, CI, Docker containers), choose the **Manual setup** path when prompted, or pass your credentials directly in the config.

### Firewall blocking localhost callback

The browser OAuth flow starts a temporary local server to receive the authentication callback. If your firewall blocks incoming connections on random ports, either:
- Temporarily allow localhost connections on high ports
- Use the manual setup path instead

### "Brainfork plugin installed but not configured"

This message appears when the plugin loads without valid auth config. Run `openclaw brainfork setup` to configure it.

### Token refresh failures

If your OAuth tokens expire and auto-refresh fails, run `openclaw brainfork setup` again to re-authenticate. The setup flow will overwrite the existing config with fresh tokens.

### Connection timeouts

Increase `requestTimeoutMs` in your config (default: 20000ms, max: 120000ms) if you're on a slow connection or the Brainfork server is distant.
