# @brainfork/brainfork-openclaw

Brainfork memory plugin for **OpenClaw**.

It gives OpenClaw agents a Brainfork-backed knowledge base with:

- bounded recall before agent runs via Brainfork `rag_query`
- workspace sync for `MEMORY.md` and `memory/**/*.md`
- decision search and decision logging helpers
- document cleanup via hidden Brainfork `archive_document`

## Install

Published package:

```bash
openclaw plugins install @brainfork/brainfork-openclaw
```

Restart OpenClaw after installation.

## Local Development

From an OpenClaw source checkout:

```bash
cd extensions/brainfork-openclaw
npm install
npm run build
openclaw plugins install --link ./extensions/brainfork-openclaw
```

If you change the plugin code, rebuild before restarting OpenClaw.

## Config

Put this under `plugins.entries.brainfork-openclaw.config`:

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
openclaw brainfork index
openclaw brainfork status
```

## Agent Tools

- `brainfork_search`
- `brainfork_fetch`
- `brainfork_get_decisions`
- `brainfork_log_decision`
- `brainfork_push_document`
