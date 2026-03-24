import { describe, expect, it, vi } from "vitest";
import { BrainforkMcpClient } from "../mcp-client.js";
import type { BrainforkPluginConfig } from "../config.js";

function makeConfig(overrides?: Partial<BrainforkPluginConfig>): BrainforkPluginConfig {
  return {
    baseUrl: "https://api.brainfork.test",
    endpoint: "memory-server",
    apiKey: "bfk_test123",
    autoRecall: false,
    autoIndex: false,
    captureDecisions: false,
    maxResults: 5,
    similarityThreshold: 0.2,
    maxTokens: 600,
    deleteMode: "archive",
    searchMode: "query",
    requestTimeoutMs: 5000,
    ...overrides,
  };
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeMcpJsonResponse(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeToolResult(text: string) {
  return { content: [{ type: "text", text }] };
}

describe("BrainforkMcpClient.cleanupDocument", () => {
  it("calls archive_document when mode is archive", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

    const mockFetch = vi.fn()
      // First call: initialize
      .mockResolvedValueOnce(makeMcpJsonResponse({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test" } }))
      // Second call: initialized notification (no response needed, but fetch is called)
      .mockResolvedValueOnce(makeMcpJsonResponse(undefined))
      // Third call: tools/call
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (body.method === "tools/call") {
          calls.push({ name: body.params.name, args: body.params.arguments });
        }
        return makeMcpJsonResponse(makeToolResult("archived"));
      });

    const client = new BrainforkMcpClient(makeConfig(), noopLogger, mockFetch as unknown as typeof fetch);
    const result = await client.cleanupDocument({
      externalId: "test-doc",
      mode: "archive",
    });

    expect(result.toolName).toBe("archive_document");
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("archive_document");
    expect(calls[0].args).toEqual({ externalId: "test-doc", mode: "archive" });
  });

  it("calls delete_document when mode is delete", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeMcpJsonResponse({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test" } }))
      .mockResolvedValueOnce(makeMcpJsonResponse(undefined))
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (body.method === "tools/call") {
          calls.push({ name: body.params.name, args: body.params.arguments });
        }
        return makeMcpJsonResponse(makeToolResult("deleted"));
      });

    const client = new BrainforkMcpClient(makeConfig(), noopLogger, mockFetch as unknown as typeof fetch);
    const result = await client.cleanupDocument({
      externalId: "test-doc",
      mode: "delete",
    });

    expect(result.toolName).toBe("delete_document");
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("delete_document");
    // Should NOT include mode param for delete
    expect(calls[0].args).toEqual({ externalId: "test-doc" });
  });
});
