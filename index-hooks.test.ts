/**
 * Tests for critical plugin hook branches that require a mocked BrainforkMcpClient.
 * Kept in a separate file to avoid vi.mock bleeding into the main index.test.ts.
 *
 * Coverage targets (Finding 9):
 *  - searchMode=search routes recall to the "search" tool
 *  - rag_query fallback when primary tool throws
 *  - per-document error in syncWorkspaceMemory doesn't abort the whole sync
 *  - concurrent agent_end hook invocations don't lose sync state
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

// Use vi.hoisted so these refs are available inside the vi.mock factory
const { mockCallToolParsed, mockCleanupDocument } = vi.hoisted(() => ({
  mockCallToolParsed: vi.fn(),
  mockCleanupDocument: vi.fn(),
}));

vi.mock("./src/mcp-client.js", () => {
  function MockBrainforkMcpClient(this: Record<string, unknown>) {
    this.serverKey = "https://api.brainfork.is/memory-server";
    this.callToolParsed = mockCallToolParsed;
    this.cleanupDocument = mockCleanupDocument;
    this.listTools = vi.fn().mockResolvedValue([]);
    this.refreshAccessToken = vi.fn();
  }
  return { BrainforkMcpClient: MockBrainforkMcpClient };
});

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

type HookName = "before_agent_start" | "agent_end";
type HookHandler = (...args: unknown[]) => Promise<unknown>;

interface MockApi {
  pluginConfig: Record<string, unknown>;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  handlers: Partial<Record<HookName, HookHandler>>;
}

function buildMockApi(overrides: Partial<{ pluginConfig: Record<string, unknown> }> = {}): MockApi {
  const handlers: Partial<Record<HookName, HookHandler>> = {};
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const api: MockApi = {
    pluginConfig: {
      baseUrl: "https://api.brainfork.is",
      endpoint: "memory-server",
      apiKey: "bfk_123",
      autoRecall: true,
      autoIndex: true,
      captureDecisions: false,
      syncAllWorkspaces: false,
      searchMode: "query",
      maxResults: 5,
      similarityThreshold: 0.2,
      maxTokens: 600,
      deleteMode: "archive",
      requestTimeoutMs: 20_000,
      ...overrides.pluginConfig,
    },
    logger,
    handlers,
  };

  plugin.register({
    id: "brainfork-openclaw",
    name: "Brainfork Memory",
    source: "test",
    config: {},
    pluginConfig: api.pluginConfig,
    runtime: {} as never,
    logger: api.logger,
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: (input: string) => input,
    on(name: string, handler: HookHandler) {
      handlers[name as HookName] = handler;
    },
  } as never);

  return api;
}

const tempDirs: string[] = [];

beforeEach(() => {
  mockCallToolParsed.mockReset();
  mockCleanupDocument.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeTempWorkspace(name = "workspace"): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `brainfork-hooks-${name}-`));
  tempDirs.push(base);
  process.env.OPENCLAW_STATE_DIR = base;
  return base;
}

// ──────────────────────────────────────────────────────────────────────────────
// searchMode = "search"
// ──────────────────────────────────────────────────────────────────────────────

describe("recallBrainfork with searchMode=search", () => {
  it("calls the 'search' tool when searchMode is 'search'", async () => {
    const mockApi = buildMockApi({ pluginConfig: { searchMode: "search" } });

    mockCallToolParsed.mockResolvedValue({
      parsedText: [{ id: "1", title: "Mem", text: "content", score: 0.9 }],
      raw: null,
    });

    const handler = mockApi.handlers["before_agent_start"]!;
    const result = await handler({ prompt: "what is our DB choice?" });

    expect(mockCallToolParsed).toHaveBeenCalledWith(
      "search",
      expect.objectContaining({ query: "what is our DB choice?" }),
    );
    expect(result).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// rag_query fallback
// ──────────────────────────────────────────────────────────────────────────────

describe("recallBrainfork rag_query fallback", () => {
  it("falls back to rag_query when the primary tool (query) throws", async () => {
    const mockApi = buildMockApi({ pluginConfig: { searchMode: "query" } });

    mockCallToolParsed
      .mockRejectedValueOnce(new Error("Tool not available on this server"))
      .mockResolvedValueOnce({
        parsedText: [{ id: "2", title: "Fallback", text: "fallback content", score: 0.8 }],
        raw: null,
      });

    const handler = mockApi.handlers["before_agent_start"]!;
    const result = await handler({ prompt: "architecture decisions" });

    expect(mockCallToolParsed).toHaveBeenCalledTimes(2);
    expect(mockCallToolParsed).toHaveBeenNthCalledWith(2, "rag_query", expect.any(Object));
    expect(result).toBeDefined();
  });

  it("does not rethrow when all recall tools fail (logs warning, returns undefined)", async () => {
    const mockApi = buildMockApi({ pluginConfig: { searchMode: "query" } });

    mockCallToolParsed.mockRejectedValue(new Error("All tools unavailable"));

    const handler = mockApi.handlers["before_agent_start"]!;
    const result = await handler({ prompt: "some query" });

    expect(mockApi.logger.warn).toHaveBeenCalledWith(expect.stringContaining("autoRecall failed"));
    expect(result).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Per-document errors in syncWorkspaceMemory
// ──────────────────────────────────────────────────────────────────────────────

describe("syncWorkspaceMemory per-document error handling", () => {
  it("does not abort the whole sync when push_document fails for one file", async () => {
    const wsDir = await makeTempWorkspace();
    await fs.writeFile(path.join(wsDir, "MEMORY.md"), "# Memory\n\nSome content.", "utf-8");

    mockCallToolParsed.mockRejectedValue(new Error("Upload failed: server error"));

    const mockApi = buildMockApi();
    const handler = mockApi.handlers["agent_end"]!;

    // Should resolve without throwing — per-document errors are caught inside syncWorkspaceMemory
    await expect(handler({ success: true, messages: [] }, { workspaceDir: wsDir })).resolves.toBeUndefined();
  });

  it("records per-document failures without crashing the outer sync loop", async () => {
    const wsDir = await makeTempWorkspace();
    await fs.writeFile(path.join(wsDir, "MEMORY.md"), "# Memory", "utf-8");

    mockCallToolParsed.mockRejectedValue(new Error("Upload failed: timeout"));

    const mockApi = buildMockApi();
    const handler = mockApi.handlers["agent_end"]!;
    await handler({ success: true, messages: [] }, { workspaceDir: wsDir });

    // The hook should not emit a per-workspace warn (the error is swallowed at the
    // per-document level, not the per-workspace level)
    expect(mockApi.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("autoIndex failed for"),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Concurrent sync writes
// ──────────────────────────────────────────────────────────────────────────────

describe("concurrent agent_end sync writes", () => {
  it("concurrent hook invocations for different workspaces don't lose state", async () => {
    const tmpBase = await makeTempWorkspace();
    const N = 4;
    const workspaceDirs: string[] = [];

    for (let i = 0; i < N; i++) {
      const wsDir = path.join(tmpBase, `workspace-agent${i}`);
      await fs.mkdir(wsDir, { recursive: true });
      await fs.writeFile(path.join(wsDir, "MEMORY.md"), `# Memory ${i}`, "utf-8");
      workspaceDirs.push(wsDir);
    }

    // push_document returns a remote id based on the externalId param
    mockCallToolParsed.mockImplementation((_tool: string, params: unknown) =>
      Promise.resolve({
        parsedText: { id: `remote-${(params as Record<string, unknown>).externalId}`, title: "doc" },
        raw: null,
      }),
    );

    const mockApi = buildMockApi();
    const handler = mockApi.handlers["agent_end"]!;

    // Fire N concurrent syncs for different workspace dirs
    await Promise.all(
      workspaceDirs.map((wsDir) =>
        handler({ success: true, messages: [] }, { workspaceDir: wsDir }),
      ),
    );

    // Each workspace should have its sync state persisted correctly
    const { loadServerState: loadState } = await import("./src/sync-state.js");
    for (const wsDir of workspaceDirs) {
      const state = await loadState(wsDir, "https://api.brainfork.is/memory-server");
      expect(Object.keys(state.entries)).toHaveLength(1);
      expect(state.entries["MEMORY.md"]?.status).toBe("active");
    }
  });
});
