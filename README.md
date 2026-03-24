# @brainfork/brainfork-openclaw

**Give your OpenClaw agents memory that lasts.**

Every time your agent restarts, it forgets — your decisions, your architecture choices, your project context. You end up repeating yourself, correcting the same mistakes, re-explaining the same conventions.

Brainfork fixes that. This plugin connects OpenClaw to [Brainfork](https://brainfork.is), a sovereign memory layer that stores your agent's knowledge externally and recalls the right context before each session starts.

## What You Get

🧠 **Automatic context recall** — relevant memories are injected before every agent run, so your agent picks up where it left off.

🔄 **Workspace sync** — your `MEMORY.md` and `memory/**/*.md` files are automatically pushed to Brainfork, keeping your knowledge base fresh without manual effort.

📋 **Decision logging** — every significant decision your agent makes is captured, tagged, and retrievable. No more "why did we choose Postgres over SQLite?" moments.

🔍 **Hybrid search** — keyword + vector similarity search across your entire knowledge base. Find anything, fast.

📦 **Document management** — push, archive, and organize documents through a clean API.

🔐 **Sovereign by design** — your data lives in a Brainfork server you control. Not locked into any model vendor. Portable, inspectable, yours.

## Quick Start

```bash
# Install the plugin
openclaw plugins install @brainfork/brainfork-openclaw

# Run interactive setup
openclaw brainfork setup
```

The setup wizard offers two paths:

- **Browser login** (recommended) — opens your browser to authenticate with Brainfork. Best for desktops.
- **Manual setup** — prompts for your API URL, endpoint, and key. Best for headless servers and CI.

Then restart OpenClaw:

```bash
openclaw gateway restart
```

That's it. Your agents now have persistent memory.

## How It Works

1. **Before each session**, the plugin queries Brainfork for context relevant to the current task and injects it into the agent's prompt.
2. **During sessions**, agents can search, fetch, and push documents — and log decisions with full context.
3. **After sessions**, workspace memory files are synced to Brainfork automatically.

Your agent stops starting from zero. It remembers what matters.

## CLI Commands

```bash
openclaw brainfork setup     # Interactive setup (browser OAuth or manual)
openclaw brainfork index     # Sync workspace memory to Brainfork
openclaw brainfork status    # Check connectivity and sync state
```

## Agent Tools

Once installed, your agents get access to these tools:

| Tool | What it does |
|------|-------------|
| `brainfork_search` | Keyword search across your knowledge base |
| `brainfork_vsearch` | Semantic vector search for conceptual matches |
| `brainfork_query` | Hybrid search (BM25 + vector) for best-quality results |
| `brainfork_fetch` | Retrieve a full document by ID |
| `brainfork_push_document` | Store new documents in Brainfork |
| `brainfork_get_decisions` | Search logged decisions |
| `brainfork_log_decision` | Record a decision with context and reasoning |

## Configuration

The setup wizard handles configuration automatically. For manual configuration, add this to your `openclaw.json` under `plugins.entries.brainfork-openclaw.config`:

```json5
{
  baseUrl: "https://api.brainfork.ai",
  endpoint: "mcp/my-team",
  apiKey: "${BRAINFORK_API_KEY}",
  autoRecall: true,        // inject context before sessions
  autoIndex: true,         // sync workspace memory automatically
  captureDecisions: true,  // log agent decisions
  maxResults: 5,
  similarityThreshold: 0.2,
  maxTokens: 600,
  deleteMode: "archive",   // archive | delete | ignore
  requestTimeoutMs: 20000
}
```

**Notes:**
- `endpoint` — a full MCP URL or a path relative to `baseUrl`
- `apiKey` — a raw Brainfork key or a full `Bearer ...` / `ApiKey ...` header value
- `deleteMode` — what happens to remotely synced files when you delete them locally
- Sync state is stored under `~/.openclaw/memory/brainfork/`

## Local Development

From an OpenClaw source checkout:

```bash
cd extensions/brainfork-openclaw
npm install
npm run build
openclaw plugins install --link ./extensions/brainfork-openclaw
```

Rebuild after changes, then restart OpenClaw.

Before publishing, run the full local install harness:

```bash
npm run test:install
```

For the full test suite (unit tests + install/setup/runtime harness), run:

```bash
npm test
```

## Troubleshooting

**Browser OAuth doesn't open on a headless server** — choose Manual setup instead, or pass credentials directly in config.

**Firewall blocking localhost callback** — the OAuth flow uses a temporary local server. Allow localhost on high ports, or use manual setup.

**"Plugin installed but not configured"** — run `openclaw brainfork setup` to configure authentication.

**Token refresh failures** — re-run `openclaw brainfork setup` to re-authenticate with fresh tokens.

**Connection timeouts** — increase `requestTimeoutMs` in config (default: 20,000ms, max: 120,000ms).

## Pricing

Brainfork starts at **€5/month** with a 14-day free trial. Includes 25k requests and 1k indexed documents. [Sign up at brainfork.is](https://brainfork.is).

## License

MIT
