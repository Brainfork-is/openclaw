import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

function makeTokenRefreshResponse(accessToken: string, refreshToken?: string, expiresIn?: number) {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("BrainforkMcpClient token refresh", () => {
  it("refreshes token before request when token is expired", async () => {
    const expiredAt = Date.now() - 1000;
    const refreshRequests: string[] = [];

    const mockFetch = vi.fn()
      // First call: token refresh POST
      .mockImplementationOnce(async (url: string, init: RequestInit) => {
        refreshRequests.push(String(url));
        expect(String(init.body)).toContain("grant_type=refresh_token");
        return makeTokenRefreshResponse("new_access_token", "rt_new", 3600);
      })
      // Second call: initialize
      .mockResolvedValueOnce(
        makeMcpJsonResponse({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test" } }),
      )
      // Third call: initialized notification
      .mockResolvedValueOnce(makeMcpJsonResponse(undefined))
      // Fourth call: tools/call
      .mockResolvedValueOnce(makeMcpJsonResponse(makeToolResult("archived")));

    const client = new BrainforkMcpClient(
      makeConfig({ refreshToken: "rt_old", tokenExpiresAt: expiredAt }),
      noopLogger,
      mockFetch as unknown as typeof fetch,
    );

    await client.cleanupDocument({ externalId: "doc1", mode: "archive" });

    expect(refreshRequests).toHaveLength(1);
    expect(refreshRequests[0]).toContain("/oauth/token");
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("refreshes token and retries on 401 response", async () => {
    const mockFetch = vi.fn()
      // First call: initialize returns 401
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      // Second call: token refresh POST
      .mockResolvedValueOnce(makeTokenRefreshResponse("new_access_token"))
      // Third call: initialize retry
      .mockResolvedValueOnce(
        makeMcpJsonResponse({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test" } }),
      )
      // Fourth call: initialized notification
      .mockResolvedValueOnce(makeMcpJsonResponse(undefined))
      // Fifth call: tools/call
      .mockResolvedValueOnce(makeMcpJsonResponse(makeToolResult("archived")));

    const client = new BrainforkMcpClient(
      makeConfig({ refreshToken: "rt_valid", tokenExpiresAt: Date.now() + 3_600_000 }),
      noopLogger,
      mockFetch as unknown as typeof fetch,
    );

    await client.cleanupDocument({ externalId: "doc1", mode: "archive" });

    expect(mockFetch).toHaveBeenCalledTimes(5);
    // Second call should be the token refresh
    const refreshCall = mockFetch.mock.calls[1];
    expect(String(refreshCall[0])).toContain("/oauth/token");
  });

  it("propagates error when token refresh fails", async () => {
    const expiredAt = Date.now() - 1000;

    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new BrainforkMcpClient(
      makeConfig({ refreshToken: "rt_expired", tokenExpiresAt: expiredAt }),
      noopLogger,
      mockFetch as unknown as typeof fetch,
    );

    await expect(client.cleanupDocument({ externalId: "doc1", mode: "archive" })).rejects.toThrow(
      "Token refresh failed (400): Refresh token expired",
    );
  });

  it("updates config file after token refresh", async () => {
    const tmpFile = path.join(os.tmpdir(), `brainfork-test-${Date.now()}.json`);
    const initialConfig = {
      plugins: {
        entries: {
          "brainfork-openclaw": {
            enabled: true,
            config: {
              baseUrl: "https://api.brainfork.test",
              endpoint: "memory-server",
              apiKey: "old_token",
              refreshToken: "rt_old",
            },
          },
        },
      },
    };
    await fs.writeFile(tmpFile, JSON.stringify(initialConfig, null, 2), "utf8");

    const expiredAt = Date.now() - 1000;
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeTokenRefreshResponse("new_access_token", "rt_new", 3600))
      .mockResolvedValueOnce(
        makeMcpJsonResponse({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test" } }),
      )
      .mockResolvedValueOnce(makeMcpJsonResponse(undefined))
      .mockResolvedValueOnce(makeMcpJsonResponse(makeToolResult("archived")));

    const client = new BrainforkMcpClient(
      makeConfig({ refreshToken: "rt_old", tokenExpiresAt: expiredAt }),
      noopLogger,
      mockFetch as unknown as typeof fetch,
      tmpFile,
    );

    await client.cleanupDocument({ externalId: "doc1", mode: "archive" });

    const written = JSON.parse(await fs.readFile(tmpFile, "utf8")) as {
      plugins: { entries: { "brainfork-openclaw": { config: Record<string, unknown> } } };
    };
    const pluginConfig = written.plugins.entries["brainfork-openclaw"].config;
    expect(pluginConfig.apiKey).toBe("new_access_token");
    expect(pluginConfig.refreshToken).toBe("rt_new");
    expect(typeof pluginConfig.tokenExpiresAt).toBe("number");
    expect(pluginConfig.tokenExpiresAt as number).toBeGreaterThan(Date.now());

    await fs.unlink(tmpFile);
  });
});
