---
ISSUE: OAuth setup discards refresh tokens and guarantees future auth expiry
SEVERITY: critical
CATEGORY: functional
FILE: src/cli-setup.ts:358
DESCRIPTION: The browser setup flow receives `refresh_token` and `expires_in` from `/oauth/token`, but only persists `access_token` as `apiKey`. There is no persisted refresh state and `BrainforkMcpClient` has no refresh path, so any short-lived OAuth access token will eventually expire and brick the plugin until the user re-runs setup.
FIX: Persist refresh token and expiry metadata in plugin config or a secret store, then teach `BrainforkMcpClient` to refresh before/after 401s and atomically update stored credentials.
---

---
ISSUE: Delete mode never performs a real delete
SEVERITY: high
CATEGORY: correctness
FILE: src/mcp-client.ts:178
DESCRIPTION: `cleanupDocument()` always calls `archive_document` and only changes the `mode` argument. When plugin config is set to `delete`, the code still invokes the archive tool, so removed documents are not actually deleted remotely. Sync state is then updated as if deletion succeeded, which creates local/remote drift.
FIX: Dispatch to the correct remote tool for each mode, and only mark local state as deleted after the remote delete/archive call actually succeeds.
---

---
ISSUE: searchMode=search is advertised but auto-recall never uses the search tool
SEVERITY: high
CATEGORY: functional
FILE: index.ts:155
DESCRIPTION: Config and manifest expose `searchMode: "search"`, but `recallBrainfork()` maps any non-`query`/`vsearch` mode to `rag_query`. Users selecting BM25 search are silently routed to a different retrieval path than requested.
FIX: Implement a real `search` branch in `recallBrainfork()` or remove `search` from config/manifest until it is supported.
---

---
ISSUE: Auto-recall fallback sends the wrong parameter names
SEVERITY: high
CATEGORY: functional
FILE: index.ts:173
DESCRIPTION: The primary recall path uses snake_case MCP arguments (`max_results`, `similarity_threshold`), but the fallback `rag_query` call switches to camelCase (`maxResults`, `similarityThreshold`). If the server expects the same schema as the other MCP tools, fallback recall will fail or ignore limits/thresholds.
FIX: Use the same MCP argument names in both the primary and fallback code paths, and add tests that exercise the fallback branch.
---

---
ISSUE: Failed recall rethrows the client object instead of the real error
SEVERITY: high
CATEGORY: reliability
FILE: index.ts:170
DESCRIPTION: The catch block uses `throw arguments[0]`. Inside `recallBrainfork()`, `arguments[0]` is the `client`, not the exception. If both the main tool and fallback fail, the code throws a `BrainforkMcpClient` instance, destroying the original stack/message and making diagnostics misleading.
FIX: Capture the error in `catch (error)` and rethrow that error after fallback failure.
---

---
ISSUE: OAuth redirect URI host does not match the bound callback listener
SEVERITY: high
CATEGORY: functional
FILE: src/cli-setup.ts:346
DESCRIPTION: The callback server listens on `127.0.0.1`, but the redirect URI uses `http://localhost:${port}/callback`. On systems where `localhost` resolves to `::1` first, the browser will call IPv6 localhost while the server is only listening on IPv4, causing the browser login flow to fail intermittently.
FIX: Use the same host for both bind and redirect URI, or bind dual-stack where supported.
---

---
ISSUE: Manual setup validates only the API host, not the selected endpoint
SEVERITY: high
CATEGORY: functional
FILE: src/cli-setup.ts:330
DESCRIPTION: Manual setup checks `/health` before asking for the Brainfork endpoint/server name. A valid API key against the base host is enough to pass setup even if the user enters a nonexistent or unauthorized endpoint afterwards, so the plugin can be "successfully" configured into an unusable state.
FIX: Validate the final base URL plus endpoint together, ideally by performing a lightweight MCP initialize/list-tools call against the resolved endpoint before writing config.
---

---
ISSUE: OAuth and API credentials are persisted in plaintext config
SEVERITY: high
CATEGORY: security
FILE: src/cli-setup.ts:205
DESCRIPTION: `writeBrainforkPluginConfig()` writes `apiKey` directly into `openclaw.json`. In the OAuth path this is an access token; in the manual path it is a long-lived API key. Storing secrets unencrypted in a normal config file increases exposure through backups, logs, shell history, repo accidents, and local file reads.
FIX: Store secrets in an OS keychain/secret store or an OpenClaw-provided secure credential facility, and keep only non-sensitive references in JSON config.
---

---
ISSUE: OAuth token exchange and manual credential validation can hang indefinitely
SEVERITY: medium
CATEGORY: reliability
FILE: src/cli-setup.ts:89
DESCRIPTION: `exchangeOAuthCode()` and `validateManualCredentials()` call `fetch()` without any timeout or abort signal. A slow or half-open network path can leave interactive setup hanging forever even though the rest of the plugin uses request timeouts.
FIX: Thread a timeout/AbortController through setup network requests and surface explicit timeout errors.
---

---
ISSUE: Workspace resolution falls back to process.cwd and can sync the wrong directory
SEVERITY: high
CATEGORY: functional
FILE: src/workspace-memory.ts:82
DESCRIPTION: `resolveWorkspaceDir()` returns `process.cwd()` when OpenClaw does not provide `workspaceDir`. That means CLI `brainfork index/status` and the `agent_end` hook can target the extension install directory or some unrelated shell cwd instead of an actual agent workspace, leading to missing data, false deletes, or indexing the wrong files.
FIX: Return `null` when no explicit workspace directory is provided, and make callers fail fast instead of guessing from the current process directory.
---

---
ISSUE: Every agent end scans and syncs all discovered workspaces sequentially
SEVERITY: high
CATEGORY: performance
FILE: index.ts:804
DESCRIPTION: On every successful or failed agent completion with `autoIndex` enabled, the plugin enumerates all `~/.openclaw/workspace-*` directories and then syncs each one serially. In a multi-agent install this creates unnecessary disk scans and network churn on every run, and latency grows linearly with workspace count.
FIX: Sync only the active workspace by default, add an opt-in global sweep mode, and parallelize or debounce background sync if broad discovery is truly required.
---

---
ISSUE: Sync-state writes are non-atomic and race-prone across concurrent sessions
SEVERITY: high
CATEGORY: correctness
FILE: src/sync-state.ts:121
DESCRIPTION: `saveServerState()` performs an unlocked read-modify-write of a shared JSON file. Two concurrent agent runs can load the same old state, each update different entries, and the later write will silently discard the earlier changes. This is especially likely because the plugin intentionally syncs multiple workspaces and multiple sessions may end around the same time.
FIX: Use file locking or atomic compare-and-swap semantics, and write through a temporary file + rename to avoid partial updates.
---

---
ISSUE: Corrupt or unreadable sync state is silently treated as empty state
SEVERITY: medium
CATEGORY: reliability
FILE: src/sync-state.ts:91
DESCRIPTION: `readStateFile()` catches every failure, including JSON corruption and permission errors, and returns an empty state file. A single bad write or permissions problem therefore looks like "no prior state", which can trigger mass re-uploads or cleanup decisions with no warning.
FIX: Distinguish `ENOENT` from parse/permission errors, log corruption explicitly, and refuse destructive sync actions until state is repaired.
---

---
ISSUE: Sync failure reporting drops the actual exception details
SEVERITY: medium
CATEGORY: reliability
FILE: index.ts:406
DESCRIPTION: Per-document sync failures only append `type:path` to `summary.failed` and discard the error object. Operators cannot tell whether a failure was auth-related, schema-related, transient network trouble, or a server-side rejection.
FIX: Include a sanitized error message in `summary.failed` and emit structured logs for failed actions.
---

---
ISSUE: Document collection has no size guardrails and aborts the whole sync on one bad file
SEVERITY: medium
CATEGORY: reliability
FILE: src/workspace-memory.ts:68
DESCRIPTION: `collectWorkspaceDocuments()` reads every markdown file fully into memory and any read error rejects the entire workspace sync. A single oversized note, transient file access error, or malformed filesystem entry can therefore block all memory updates for that workspace.
FIX: Enforce per-file size limits, stream or chunk large files, and treat unreadable files as per-file failures rather than aborting the whole sync.
---

---
ISSUE: Decision capture ignores durable decisions made by the user
SEVERITY: medium
CATEGORY: functional
FILE: src/decision-capture.ts:153
DESCRIPTION: The detector records user turns only as context and never evaluates them for durable decisions. If the user explicitly states a policy or architectural choice and the assistant merely acknowledges it, no decision is captured even though the durable choice came from the user.
FIX: Evaluate both user and assistant turns, or at minimum allow explicit user decisions to seed captured records.
---

---
ISSUE: Decision de-duplication is weak and only survives within one process
SEVERITY: medium
CATEGORY: correctness
FILE: index.ts:268
DESCRIPTION: Duplicate prevention uses the first 128 characters of `decisionMade::reasoning` in an in-memory `Map`. Restarts wipe the dedupe window, long similar decisions can collide, and minor reasoning text changes bypass dedupe even when the decision itself is identical.
FIX: Use a stable hash over normalized durable fields, persist recent fingerprints in sync state or Brainfork metadata, and dedupe on decision semantics rather than full reasoning text.
---

---
ISSUE: The tests claim OAuth refresh coverage but never exercise plugin refresh logic
SEVERITY: high
CATEGORY: testing
FILE: src/__tests__/e2e-oauth-setup.test.ts:10
DESCRIPTION: The file header says the suite tests "Plugin's real MCP client with token refresh", but the actual tests only call the mock `/oauth/token` endpoint directly. No production code path refreshes a token, which means the test narrative materially overstates coverage and hides the missing feature.
FIX: Add a real client-level refresh implementation first, then test it through `BrainforkMcpClient` using expired credentials and mocked 401/refresh responses.
---

---
ISSUE: PKCE generation test does not test this plugin's PKCE implementation
SEVERITY: medium
CATEGORY: testing
FILE: src/__tests__/cli-setup.test.ts:5
DESCRIPTION: The PKCE test imports `generatePkceVerifierChallenge` from `openclaw/plugin-sdk`, not from `src/cli-setup.ts`. Even if the plugin's local PKCE implementation regresses or is removed, this test can still pass, so it does not protect the actual code being shipped.
FIX: Export the local helper for testability or test through `buildAuthorizeUrl()`/setup flow using the plugin's own implementation.
---

---
ISSUE: Critical sync and recall branches are untested
SEVERITY: medium
CATEGORY: testing
FILE: index.test.ts:166
DESCRIPTION: The test suite does not cover `deleteMode=delete` behavior, `searchMode=search`, the `rag_query` fallback branch, the bad `throw arguments[0]` path, missing `workspaceDir`, sync-state corruption handling, or concurrent sync-state writes. Several of the most failure-prone code paths are therefore unguarded.
FIX: Add targeted tests for each branch and failure mode, including concurrency tests around sync-state persistence and integration tests for recall mode selection.
---
