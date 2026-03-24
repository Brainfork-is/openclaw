import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { brainforkConfigSchema, type BrainforkPluginConfig } from "./src/config.js";
import { detectDurableDecisions } from "./src/decision-capture.js";
import { registerBrainforkSetupCommand } from "./src/cli-setup.js";
import { BrainforkMcpClient } from "./src/mcp-client.js";
import {
  applyRemovedResult,
  applyUpsertResult,
  buildSyncPlan,
  loadServerState,
  saveServerState,
  summarizeSyncState,
} from "./src/sync-state.js";
import {
  collectWorkspaceDocuments,
  hashContent,
  resolveWorkspaceDir,
  type WorkspaceDocument,
} from "./src/workspace-memory.js";

type SearchResultItem = {
  id?: string;
  title?: string;
  text?: string;
  url?: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

type SyncSummary = {
  indexed: number;
  changed: number;
  unchanged: number;
  archived: number;
  deleted: number;
  skippedDeletes: number;
  failed: string[];
};

function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function approximateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function clipToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = Math.max(1, maxTokens * 4);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeSearchResults(payload: unknown): SearchResultItem[] {
  if (Array.isArray(payload)) {
    return payload.filter((entry) => entry && typeof entry === "object") as SearchResultItem[];
  }
  const record = asRecord(payload);
  if (!record) {
    return [];
  }
  if (Array.isArray(record.results)) {
    return record.results.filter((entry) => entry && typeof entry === "object") as SearchResultItem[];
  }
  if (Array.isArray(record.items)) {
    return record.items.filter((entry) => entry && typeof entry === "object") as SearchResultItem[];
  }
  if (Array.isArray(record.documents)) {
    return record.documents.filter((entry) => entry && typeof entry === "object") as SearchResultItem[];
  }
  if (Array.isArray(record.matches)) {
    return record.matches.filter((entry) => entry && typeof entry === "object") as SearchResultItem[];
  }
  return [];
}

function firstString(value: unknown, ...keys: string[]): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function summarizeSearchResult(item: SearchResultItem): string {
  const title = item.title?.trim() || item.id?.trim() || "Memory";
  const text = item.text?.trim() || "";
  const snippet = text ? clipToTokenBudget(text.replace(/\s+/g, " "), 80) : "";
  const url = item.url?.trim();
  const score = typeof item.score === "number" ? `[${item.score.toFixed(2)}]` : "";
  return [score, title, snippet, url ? `(${url})` : ""].filter(Boolean).join(" - ");
}

async function searchBrainfork(
  client: BrainforkMcpClient,
  query: string,
  limit: number,
): Promise<SearchResultItem[]> {
  const response = await client.callToolParsed("search", { query });
  const parsed = response.parsedText ?? response.raw;
  return normalizeSearchResults(parsed).slice(0, limit);
}

function toSimilarityScore(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function normalizeRagResults(payload: unknown): SearchResultItem[] {
  const results = normalizeSearchResults(payload);
  return results.map((item) => ({
    ...item,
    score:
      toSimilarityScore(item.score) ??
      toSimilarityScore(item.metadata?.score) ??
      toSimilarityScore((item.metadata as Record<string, unknown> | undefined)?.similarity) ??
      toSimilarityScore((item as Record<string, unknown>).similarity),
  }));
}

async function recallBrainfork(
  client: BrainforkMcpClient,
  query: string,
  config: BrainforkPluginConfig,
): Promise<SearchResultItem[]> {
  // Use 'query' mode (hybrid BM25 + vector + reranking) for best recall quality.
  // Falls back to 'rag_query' if 'query' tool is not available on the server.
  const searchMode = config.searchMode ?? "query";
  // TASK-109: Map all three search modes correctly
  const toolName = searchMode === "query" ? "query"
    : searchMode === "vsearch" ? "vsearch"
    : searchMode === "search" ? "search"
    : "rag_query";

  try {
    const response = await client.callToolParsed(toolName, {
      query,
      max_results: config.maxResults,
      ...(toolName === "rag_query" || toolName === "vsearch"
        ? { similarity_threshold: config.similarityThreshold }
        : {}),
    });
    const parsed = response.parsedText ?? response.raw;
    return normalizeRagResults(parsed)
      .filter((item) => item.score === undefined || item.score >= config.similarityThreshold)
      .slice(0, config.maxResults);
  } catch (error) {
    // Fallback: server may not have the new tools yet
    if (toolName !== "rag_query") {
      const response = await client.callToolParsed("rag_query", {
        query,
        // TASK-109: Use consistent snake_case params in fallback
        max_results: config.maxResults,
        similarity_threshold: config.similarityThreshold,
      });
      const parsed = response.parsedText ?? response.raw;
      return normalizeRagResults(parsed)
        .filter((item) => item.score === undefined || item.score >= config.similarityThreshold)
        .slice(0, config.maxResults);
    }
    // TASK-107: Rethrow the actual error, not arguments[0]
    throw error;
  }
}

function buildRecallBlock(results: SearchResultItem[], config: BrainforkPluginConfig): string | null {
  if (results.length === 0) {
    return null;
  }

  const lines = ["<brainfork_memories>"];
  let consumedTokens = approximateTokens(lines[0]);

  for (const result of results.slice(0, config.maxResults)) {
    const line = `- ${summarizeSearchResult(result)}`;
    const nextTokens = approximateTokens(line);
    if (consumedTokens + nextTokens > config.maxTokens) {
      break;
    }
    lines.push(line);
    consumedTokens += nextTokens;
  }

  lines.push("</brainfork_memories>");
  return lines.length > 2 ? lines.join("\n") : null;
}

/**
 * Extract the agent name from a workspace directory path.
 * e.g. "/home/agent/.openclaw/workspace-osborn" → "osborn"
 *      "/home/agent/.openclaw/workspace-gertrude" → "gertrude"
 * Returns undefined if the directory doesn't follow the workspace-{name} pattern.
 */
export function extractAgentName(workspaceDir: string): string | undefined {
  const dirName = path.basename(workspaceDir);
  const match = dirName.match(/^workspace-(.+)$/);
  return match?.[1] || undefined;
}

function extractRemoteDocumentMetadata(
  doc: WorkspaceDocument,
  payload: unknown,
): { remoteId?: string; remoteUrl?: string; title?: string } {
  const record = asRecord(payload);
  const nestedDocument = record ? asRecord(record.document) : null;
  return {
    remoteId:
      firstString(payload, "id", "documentId", "resourceId") ??
      firstString(nestedDocument, "id", "documentId", "resourceId"),
    remoteUrl:
      firstString(payload, "url", "documentUrl") ?? firstString(nestedDocument, "url", "documentUrl"),
    title:
      firstString(payload, "title", "name") ??
      firstString(nestedDocument, "title", "name") ??
      path.basename(doc.relativePath),
  };
}

async function pushDocumentToBrainfork(
  client: BrainforkMcpClient,
  doc: WorkspaceDocument,
  agentName?: string,
): Promise<{ remoteId?: string; remoteUrl?: string; title?: string }> {
  const tags = ["openclaw", "memory"];
  if (agentName) {
    tags.push(`agent:${agentName}`);
  }

  const response = await client.callToolParsed("push_document", {
    externalId: doc.relativePath,
    title: path.basename(doc.relativePath),
    content: doc.content,
    sourcePath: doc.relativePath,
    tags,
    metadata: {
      source: "openclaw/brainfork-openclaw",
      path: doc.relativePath,
      sha256: doc.sha256,
      ...(agentName ? { agentName } : {}),
    },
  });

  const payload = response.parsedText ?? response.raw;
  return extractRemoteDocumentMetadata(doc, payload);
}

/** Generate a fingerprint for a decision to detect duplicates */
function decisionFingerprint(decision: { decisionMade: string; reasoning: string }): string {
  const key = `${decision.decisionMade}::${decision.reasoning}`.toLowerCase().replace(/\s+/g, " ").trim();
  // Simple hash: take first 64 chars of the normalized key
  return key.slice(0, 128);
}

/** Recent decision fingerprints to prevent duplicate logging across concurrent sessions */
const recentDecisionFingerprints = new Map<string, number>();
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

function isDuplicateDecision(decision: { decisionMade: string; reasoning: string }): boolean {
  const fingerprint = decisionFingerprint(decision);
  const now = Date.now();

  // Prune old entries
  for (const [key, timestamp] of recentDecisionFingerprints) {
    if (now - timestamp > DEDUP_WINDOW_MS) {
      recentDecisionFingerprints.delete(key);
    }
  }

  if (recentDecisionFingerprints.has(fingerprint)) {
    return true;
  }
  recentDecisionFingerprints.set(fingerprint, now);
  return false;
}

async function logDecisionWithAutoConfirm(
  client: BrainforkMcpClient,
  decision: {
    title: string;
    context: string;
    decisionNeeded: string;
    decisionMade: string;
    reasoning: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  },
) {
  // Skip duplicates within the dedup window
  if (isDuplicateDecision(decision)) {
    return { skipped: true, reason: "duplicate" };
  }

  const baseArgs = {
    title: decision.title,
    context: decision.context,
    decisionNeeded: decision.decisionNeeded,
    decisionMade: decision.decisionMade,
    reasoning: decision.reasoning,
    tags: decision.tags ?? [],
    metadata: {
      source: "openclaw/brainfork-openclaw",
      ...(decision.metadata ?? {}),
    },
  };

  const response = await client.callToolParsed("log_decision", baseArgs);
  return response.parsedText ?? response.raw;
}

async function syncWorkspaceMemory(
  client: BrainforkMcpClient,
  workspaceDir: string,
  config: BrainforkPluginConfig,
): Promise<SyncSummary> {
  const agentName = extractAgentName(workspaceDir);
  const rawDocs = await collectWorkspaceDocuments(workspaceDir);

  // Prefix relativePath with workspace directory name to prevent collisions.
  // Without this, all workspaces would share externalId "MEMORY.md" and overwrite each other.
  const wsPrefix = path.basename(workspaceDir);
  const docs = rawDocs.map((doc) => ({
    ...doc,
    relativePath: `${wsPrefix}/${doc.relativePath}`,
  }));

  let state = await loadServerState(workspaceDir, client.serverKey);
  const plan = buildSyncPlan(docs, state, config.deleteMode);

  const summary: SyncSummary = {
    indexed: 0,
    changed: 0,
    unchanged: 0,
    archived: 0,
    deleted: 0,
    skippedDeletes: 0,
    failed: [],
  };

  for (const action of plan) {
    try {
      if (action.type === "unchanged") {
        summary.unchanged += 1;
        continue;
      }

      if (action.type === "upsert") {
        const metadata = await pushDocumentToBrainfork(client, action.doc, agentName);
        state = applyUpsertResult(state, action.doc, metadata);
        summary.indexed += 1;
        if (action.reason === "changed" || action.reason === "restored") {
          summary.changed += 1;
        }
        continue;
      }

      if (action.type === "mark_deleted") {
        state = applyRemovedResult(state, action.entry, "skipped");
        summary.skippedDeletes += 1;
        continue;
      }

      if (action.type === "cleanup") {
        await client.cleanupDocument({
          externalId: action.entry.path,
          sha256: action.entry.sha256,
          remoteId: action.entry.remoteId,
          mode: action.mode,
        });
        state = applyRemovedResult(
          state,
          action.entry,
          action.mode === "archive" ? "archived" : "deleted",
        );
        if (action.mode === "archive") {
          summary.archived += 1;
        } else {
          summary.deleted += 1;
        }
        continue;
      }

      if (action.type === "noop_deleted") {
        summary.skippedDeletes += 1;
      }
    } catch (error) {
      summary.failed.push(`${action.type}:${"entry" in action ? action.entry.path : action.doc.relativePath}`);
    }
  }

  await saveServerState(workspaceDir, client.serverKey, state);
  return summary;
}

function printStatusLine(label: string, value: string | number) {
  console.log(`${label}: ${value}`);
}

/** Guard to prevent the unconfigured message from being logged multiple times. */
let unconfiguredMessageLogged = false;

/**
 * Discover all agent workspace directories that contain memory files.
 * Scans ~/.openclaw/workspace-* for MEMORY.md or memory/ subdirs.
 * Always includes the provided workspaceDir if valid, plus any additional
 * agent workspaces found.
 */
async function discoverAgentWorkspaces(providedWorkspaceDir: string | null): Promise<string[]> {
  const workspaceDirs = new Set<string>();

  // Add the provided workspace dir if it exists
  if (providedWorkspaceDir) {
    workspaceDirs.add(providedWorkspaceDir);
  }

  // Scan for agent workspaces under ~/.openclaw/workspace-*/
  const openclawDir = path.join(os.homedir(), ".openclaw");
  try {
    const entries = await fs.readdir(openclawDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("workspace-")) {
        const wsPath = path.join(openclawDir, entry.name);
        // Check if this workspace has memory files worth syncing
        const hasMemoryFile = await fs.access(path.join(wsPath, "MEMORY.md")).then(() => true).catch(() => false);
        const hasMemoryDir = await fs.access(path.join(wsPath, "memory")).then(() => true).catch(() => false);
        if (hasMemoryFile || hasMemoryDir) {
          workspaceDirs.add(wsPath);
        }
      }
    }
  } catch {
    // ~/.openclaw doesn't exist or isn't readable; fall back to provided dir only
  }

  return Array.from(workspaceDirs);
}

const brainforkPlugin = {
  id: "brainfork-openclaw",
  name: "Brainfork Memory",
  description: "Brainfork-backed recall, decision capture, and workspace memory sync",
  kind: "memory" as const,
  configSchema: brainforkConfigSchema,

  register(api: OpenClawPluginApi) {
    // Check if the plugin has valid auth config; if not, log setup guidance and register only the setup CLI
    const rawConfig = asRecord(api.pluginConfig);
    const hasApiKey = rawConfig && typeof rawConfig.apiKey === "string" && rawConfig.apiKey.trim().length > 0;
    const hasEndpoint = rawConfig && typeof rawConfig.endpoint === "string" && rawConfig.endpoint.trim().length > 0;
    const hasBaseUrl = rawConfig && typeof rawConfig.baseUrl === "string" && rawConfig.baseUrl.trim().length > 0;

    if (!hasApiKey || !hasEndpoint || !hasBaseUrl) {
      if (!unconfiguredMessageLogged) {
        unconfiguredMessageLogged = true;
        api.logger.info(
          "[brainfork-openclaw] ℹ️  Brainfork plugin installed but not configured.\n" +
          "   Run: openclaw brainfork setup",
        );
      }
      // Register only the setup CLI command so users can configure
      api.registerCli(
        ({ program }) => {
          const brainfork = program.command("brainfork").description("Brainfork memory plugin commands");
          registerBrainforkSetupCommand({ brainfork, logger: api.logger, resolvePath: (p) => api.resolvePath(p) });
        },
        { commands: ["brainfork"] },
      );
      return;
    }

    const config = brainforkConfigSchema.parse(api.pluginConfig);
    const client = new BrainforkMcpClient(config, api.logger);

    api.registerTool(
      {
        name: "brainfork_search",
        label: "Brainfork Search",
        description: "Search Brainfork for relevant memory and knowledge snippets.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "Search query" },
            limit: { type: "integer", minimum: 1, maximum: 20 },
          },
          required: ["query"],
        },
        async execute(_toolCallId, params) {
          const raw = params as { query: string; limit?: number };
          const results = await searchBrainfork(client, raw.query, raw.limit ?? config.maxResults);
          return jsonResult({
            query: raw.query,
            count: results.length,
            results,
          });
        },
      },
      { name: "brainfork_search" },
    );

    api.registerTool(
      {
        name: "brainfork_fetch",
        label: "Brainfork Fetch",
        description: "Fetch a full Brainfork resource by id.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "Brainfork resource id" },
          },
          required: ["id"],
        },
        async execute(_toolCallId, params) {
          const raw = params as { id: string };
          const response = await client.callToolParsed("fetch", { id: raw.id });
          return jsonResult(response.parsedText ?? response.raw);
        },
      },
      { name: "brainfork_fetch" },
    );

    api.registerTool(
      {
        name: "brainfork_get_decisions",
        label: "Brainfork Get Decisions",
        description: "Search Brainfork decision records.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string" },
            status: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
        },
        async execute(_toolCallId, params) {
          const response = await client.callToolParsed(
            "get_decisions",
            params as Record<string, unknown>,
          );
          return jsonResult(response.parsedText ?? response.raw);
        },
      },
      { name: "brainfork_get_decisions" },
    );

    api.registerTool(
      {
        name: "brainfork_log_decision",
        label: "Brainfork Log Decision",
        description: "Log a durable decision to Brainfork.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            context: { type: "string" },
            decisionNeeded: { type: "string" },
            decisionMade: { type: "string" },
            reasoning: { type: "string" },
            tags: {
              type: "array",
              items: { type: "string" },
            },
            metadata: {
              type: "object",
              additionalProperties: true,
            },
          },
          required: ["title", "context", "decisionNeeded", "decisionMade", "reasoning"],
        },
        async execute(_toolCallId, params) {
          const payload = params as {
            title: string;
            context: string;
            decisionNeeded: string;
            decisionMade: string;
            reasoning: string;
            tags?: string[];
            metadata?: Record<string, unknown>;
          };
          const result = await logDecisionWithAutoConfirm(client, payload);
          return jsonResult(result);
        },
      },
      { name: "brainfork_log_decision" },
    );

    api.registerTool(
      {
        name: "brainfork_push_document",
        label: "Brainfork Push Document",
        description: "Push markdown content into Brainfork for later recall.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            externalId: { type: "string", description: "Stable Brainfork document identifier" },
            title: { type: "string" },
            content: { type: "string", description: "Markdown content to index" },
            tags: {
              type: "array",
              items: { type: "string" },
            },
            sourcePath: { type: "string", description: "Original local path for the document" },
            metadata: {
              type: "object",
              additionalProperties: true,
            },
          },
          required: ["externalId", "content"],
        },
        async execute(_toolCallId, params) {
          const payload = params as {
            externalId: string;
            title?: string;
            content: string;
            tags?: string[];
            sourcePath?: string;
            metadata?: Record<string, unknown>;
          };
          const doc: WorkspaceDocument = {
            absolutePath: payload.sourcePath ?? payload.externalId,
            relativePath: payload.externalId,
            content: payload.content,
            sha256: hashContent(payload.content),
          };
          const response = await client.callToolParsed("push_document", {
            externalId: payload.externalId,
            title: payload.title ?? path.basename(payload.externalId),
            content: payload.content,
            tags: payload.tags ?? [],
            sourcePath: payload.sourcePath,
            metadata: {
              sha256: doc.sha256,
              ...(payload.metadata ?? {}),
            },
          });
          return jsonResult(response.parsedText ?? response.raw ?? doc);
        },
      },
      { name: "brainfork_push_document" },
    );

    api.registerTool(
      {
        name: "brainfork_vsearch",
        label: "Brainfork Vector Search",
        description: "Semantic vector search across Brainfork knowledge base.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "Semantic search query" },
            similarity_threshold: { type: "number", minimum: 0, maximum: 1 },
            max_results: { type: "integer", minimum: 1, maximum: 20 },
          },
          required: ["query"],
        },
        async execute(_toolCallId, params) {
          const raw = params as { query: string; similarity_threshold?: number; max_results?: number };
          const response = await client.callToolParsed("vsearch", {
            query: raw.query,
            similarity_threshold: raw.similarity_threshold ?? config.similarityThreshold,
            max_results: raw.max_results ?? config.maxResults,
          });
          return jsonResult(response.parsedText ?? response.raw);
        },
      },
      { name: "brainfork_vsearch" },
    );

    api.registerTool(
      {
        name: "brainfork_query",
        label: "Brainfork Query",
        description: "Best-quality hybrid search: BM25 keyword + vector similarity via Reciprocal Rank Fusion.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "Search query" },
            max_results: { type: "integer", minimum: 1, maximum: 20 },
          },
          required: ["query"],
        },
        async execute(_toolCallId, params) {
          const raw = params as { query: string; max_results?: number };
          const response = await client.callToolParsed("query", {
            query: raw.query,
            max_results: raw.max_results ?? config.maxResults,
          });
          return jsonResult(response.parsedText ?? response.raw);
        },
      },
      { name: "brainfork_query" },
    );

    api.registerCli(
      ({ program, workspaceDir }) => {
        const rootDir = resolveWorkspaceDir(workspaceDir);
        const brainfork = program.command("brainfork").description("Brainfork memory plugin commands");

        registerBrainforkSetupCommand({ brainfork, logger: api.logger, resolvePath: (p) => api.resolvePath(p) });

        brainfork
          .command("index")
          .description("Sync MEMORY.md and memory/**/*.md to Brainfork")
          .action(async () => {
            if (!rootDir) {
              throw new Error("workspace directory unavailable");
            }
            const summary = await syncWorkspaceMemory(client, rootDir, config);
            printStatusLine("workspace", rootDir);
            printStatusLine("indexed", summary.indexed);
            printStatusLine("changed", summary.changed);
            printStatusLine("unchanged", summary.unchanged);
            printStatusLine("archived", summary.archived);
            printStatusLine("deleted", summary.deleted);
            printStatusLine("skippedDeletes", summary.skippedDeletes);
            if (summary.failed.length > 0) {
              printStatusLine("failed", summary.failed.join(", "));
            }
          });

        brainfork
          .command("status")
          .description("Show Brainfork connectivity and local sync-state summary")
          .action(async () => {
            printStatusLine("endpoint", client.serverKey);
            if (!rootDir) {
              printStatusLine("workspace", "unavailable");
              return;
            }

            const [tools, state] = await Promise.all([
              client.listTools().catch(() => []),
              loadServerState(rootDir, client.serverKey),
            ]);
            const counts = summarizeSyncState(state);
            printStatusLine("workspace", rootDir);
            printStatusLine("activeDocs", counts.active);
            printStatusLine("deletedDocs", counts.deleted);
            printStatusLine("archivedDocs", counts.archived);
            printStatusLine("skippedDeletes", counts.skipped);
            printStatusLine(
              "tools",
              tools.length > 0
                ? tools
                    .map((tool) => tool.name)
                    .filter(Boolean)
                    .join(", ")
                : "unavailable",
            );
          });
      },
      { commands: ["brainfork"] },
    );

    if (config.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt?.trim()) {
          return;
        }

        try {
          const results = await recallBrainfork(client, event.prompt, config);
          const prependContext = buildRecallBlock(results, config);
          if (!prependContext) {
            return;
          }
          return { prependContext };
        } catch (error) {
          api.logger.warn(`[brainfork-openclaw] autoRecall failed: ${String(error)}`);
          return;
        }
      });
    }

    api.on("agent_end", async (event, ctx) => {
      const workspaceDir = resolveWorkspaceDir(ctx.workspaceDir);

      if (config.autoIndex && workspaceDir) {
        try {
          const summary = await syncWorkspaceMemory(client, workspaceDir, config);
          const total = summary.indexed + summary.changed;
          if (total > 0 || summary.archived > 0 || summary.deleted > 0) {
            api.logger.info(
              `[brainfork-openclaw] sync ${path.basename(workspaceDir)} indexed=${summary.indexed} changed=${summary.changed} unchanged=${summary.unchanged} archived=${summary.archived} deleted=${summary.deleted}`,
            );
          }
        } catch (error) {
          api.logger.warn(`[brainfork-openclaw] autoIndex failed for ${workspaceDir}: ${String(error)}`);
        }
      }

      if (!config.captureDecisions || !event.success) {
        return;
      }

      try {
        const agentName = workspaceDir ? extractAgentName(workspaceDir) : undefined;
        const decisions = detectDurableDecisions(event.messages, 3);
        for (const decision of decisions) {
          if (agentName) {
            decision.metadata = { ...decision.metadata, agentName };
            decision.tags = [...(decision.tags ?? []), `agent:${agentName}`];
          }
          await logDecisionWithAutoConfirm(client, decision);
        }
        if (decisions.length > 0) {
          api.logger.info(`[brainfork-openclaw] captured ${decisions.length} decisions`);
        }
      } catch (error) {
        api.logger.warn(`[brainfork-openclaw] captureDecisions failed: ${String(error)}`);
      }
    });

    api.registerService({
      id: "brainfork-openclaw",
      start: () => {
        api.logger.info(`[brainfork-openclaw] ready (${client.serverKey})`);
      },
      stop: () => {
        api.logger.info("[brainfork-openclaw] stopped");
      },
    });
  },
};

export default brainforkPlugin;
