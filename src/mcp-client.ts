import fs from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "openclaw/plugin-sdk";
import type { BrainforkPluginConfig, DeleteMode } from "./config.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "openclaw-brainfork-plugin";
const CLIENT_VERSION = "1.0.0";
const OAUTH_CLIENT_ID = "openclaw-brainfork-plugin";
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

type JsonRpcEnvelope =
  | { jsonrpc: "2.0"; id?: number | string | null; result?: unknown }
  | { jsonrpc: "2.0"; id?: number | string | null; error?: { code?: number; message?: string } };

type ToolTextContent = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export type ParsedToolCallResponse = {
  raw: unknown;
  text?: string;
  parsedText?: unknown;
};

function normalizeEndpointUrl(baseUrl: string, endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) {
    return endpoint;
  }
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  return new URL(endpoint.replace(/^\/+/, ""), base).toString();
}

function normalizeAuthorizationHeader(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.startsWith("Bearer ") || trimmed.startsWith("ApiKey ")) {
    return trimmed;
  }
  return `ApiKey ${trimmed}`;
}

function tryParseJson(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function parseMcpResponseBody(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed) {
    return {};
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as unknown;
  }

  const dataLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (dataLines.length > 0) {
    return JSON.parse(dataLines.at(-1) ?? "{}") as unknown;
  }

  throw new Error(`Unexpected MCP response body: ${trimmed.slice(0, 200)}`);
}

function isJsonRpcError(value: unknown): value is { error: { code?: number; message?: string } } {
  return Boolean(value && typeof value === "object" && "error" in value);
}

function hasJsonRpcResult(value: unknown): value is { result: unknown } {
  return Boolean(value && typeof value === "object" && "result" in value);
}

function extractPrimaryText(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const content = (raw as { content?: ToolTextContent[] }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textBlock = content.find(
    (entry) => entry && typeof entry === "object" && entry.type === "text" && entry.text,
  );
  return typeof textBlock?.text === "string" ? textBlock.text : undefined;
}

function toErrorMessage(status: number, body: string, parsed: unknown): string {
  if (isJsonRpcError(parsed) && parsed.error.message) {
    return parsed.error.message;
  }
  return `Brainfork MCP request failed with HTTP ${status}: ${body.slice(0, 200)}`;
}

function sessionResetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    (lower.includes("session") &&
      (lower.includes("not found") || lower.includes("expired") || lower.includes("invalid"))) ||
    lower.includes("server not initialized") ||
    lower.includes("not initialized")
  );
}

export class BrainforkMcpClient {
  private readonly endpointUrl: string;
  private authorizationHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private sessionId: string | null = null;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private requestCounter = 1;
  private refreshToken: string | null;
  private tokenExpiresAt: number | null;
  private readonly tokenBaseUrl: string;
  private readonly configPath: string | null;

  constructor(
    config: BrainforkPluginConfig,
    private readonly logger: PluginLogger,
    fetchImpl: typeof fetch = globalThis.fetch,
    configPath?: string,
  ) {
    this.endpointUrl = normalizeEndpointUrl(config.baseUrl, config.endpoint);
    this.authorizationHeader = normalizeAuthorizationHeader(config.apiKey);
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.refreshToken = config.refreshToken ?? null;
    this.tokenExpiresAt = config.tokenExpiresAt ?? null;
    this.tokenBaseUrl = config.baseUrl;
    this.configPath = configPath ?? null;
  }

  get serverKey(): string {
    return this.endpointUrl;
  }

  async listTools(): Promise<Array<{ name?: string; title?: string; description?: string }>> {
    await this.ensureInitialized();
    const result = await this.request("tools/list", {}, true);
    if (!result || typeof result !== "object" || !Array.isArray((result as { tools?: unknown[] }).tools)) {
      return [];
    }
    return (result as { tools: Array<{ name?: string; title?: string; description?: string }> }).tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    try {
      return await this.request("tools/call", { name, arguments: args }, true);
    } catch (error) {
      if (!sessionResetError(error)) {
        throw error;
      }
      this.resetSession();
      await this.ensureInitialized();
      return await this.request("tools/call", { name, arguments: args }, true);
    }
  }

  async callToolParsed(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ParsedToolCallResponse> {
    const raw = await this.callTool(name, args);
    const text = extractPrimaryText(raw);
    return {
      raw,
      text,
      parsedText: tryParseJson(text),
    };
  }

  async cleanupDocument(params: {
    externalId: string;
    sha256?: string;
    remoteId?: string;
    mode: Exclude<DeleteMode, "ignore">;
  }): Promise<{ toolName: string; response: ParsedToolCallResponse }> {
    const toolName = params.mode === "delete" ? "delete_document" : "archive_document";
    return {
      toolName,
      response: await this.callToolParsed(toolName, {
        externalId: params.externalId,
        ...(params.mode === "archive" ? { mode: params.mode } : {}),
      }),
    };
  }

  private isTokenExpired(): boolean {
    if (this.tokenExpiresAt === null) return false;
    return Date.now() >= this.tokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS;
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error("No refresh token available");
    }

    const response = await this.fetchImpl(
      `${this.tokenBaseUrl.replace(/\/+$/, "")}/oauth/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: this.refreshToken,
          client_id: OAUTH_CLIENT_ID,
        }).toString(),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      },
    );

    const text = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`Token refresh failed with non-JSON response (${response.status})`);
    }

    if (!response.ok) {
      const detail =
        typeof payload.error_description === "string"
          ? payload.error_description
          : typeof payload.error === "string"
            ? payload.error
            : response.statusText;
      throw new Error(`Token refresh failed (${response.status}): ${detail}`);
    }

    const accessToken = payload.access_token;
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      throw new Error("Token refresh succeeded but access_token was missing");
    }

    this.authorizationHeader = normalizeAuthorizationHeader(accessToken);
    if (typeof payload.refresh_token === "string") {
      this.refreshToken = payload.refresh_token;
    }
    if (typeof payload.expires_in === "number") {
      this.tokenExpiresAt = Date.now() + payload.expires_in * 1000;
    }

    if (this.configPath) {
      await this.persistTokens(accessToken);
    }
  }

  private async persistTokens(accessToken: string): Promise<void> {
    if (!this.configPath) return;

    const asRec = (v: unknown): Record<string, unknown> | null =>
      v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

    let rawConfig: Record<string, unknown> = {};
    try {
      const text = await fs.readFile(this.configPath, "utf8");
      rawConfig = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") throw error;
    }

    const plugins = asRec(rawConfig.plugins) ?? {};
    const entries = asRec(plugins.entries) ?? {};
    const existingEntry = asRec(entries["brainfork-openclaw"]) ?? {};
    const existingConfig = asRec(existingEntry.config) ?? {};

    const updatedConfig = {
      ...existingConfig,
      apiKey: accessToken,
      ...(this.refreshToken !== null ? { refreshToken: this.refreshToken } : {}),
      ...(this.tokenExpiresAt !== null ? { tokenExpiresAt: this.tokenExpiresAt } : {}),
    };

    const nextConfig = {
      ...rawConfig,
      plugins: {
        ...plugins,
        entries: {
          ...entries,
          "brainfork-openclaw": {
            ...existingEntry,
            config: updatedConfig,
          },
        },
      },
    };

    const tmpPath = `${this.configPath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, this.configPath);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initializePromise) {
      return await this.initializePromise;
    }
    this.initializePromise = this.initialize();
    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }

  private async initialize(): Promise<void> {
    await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          elicitation: {},
        },
        clientInfo: {
          name: CLIENT_NAME,
          version: CLIENT_VERSION,
        },
      },
      true,
    );

    this.initialized = true;

    try {
      await this.request("notifications/initialized", {}, false);
    } catch (error) {
      this.logger.debug?.(
        `[brainfork-openclaw] notifications/initialized failed: ${String(error)}`,
      );
    }
  }

  private resetSession() {
    this.sessionId = null;
    this.initialized = false;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    expectResponse: boolean,
    retried = false,
  ): Promise<unknown> {
    if (this.refreshToken && this.isTokenExpired()) {
      await this.refreshAccessToken();
    }

    const isNotification = method.startsWith("notifications/");
    const id = isNotification ? undefined : this.requestCounter++;
    const requestBody = {
      jsonrpc: "2.0" as const,
      ...(id !== undefined ? { id } : {}),
      method,
      params,
    };

    const headers = new Headers({
      authorization: this.authorizationHeader,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    });
    if (this.sessionId && method !== "initialize") {
      headers.set("mcp-session-id", this.sessionId);
    }

    const response = await this.fetchImpl(this.endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    const nextSessionId = response.headers.get("mcp-session-id");
    if (nextSessionId) {
      this.sessionId = nextSessionId;
    }

    if (response.status === 401 && this.refreshToken && !retried) {
      await this.refreshAccessToken();
      return this.request(method, params, expectResponse, true);
    }

    const body = await response.text();
    const parsed = body ? parseMcpResponseBody(body) : undefined;

    if (!response.ok) {
      throw new Error(toErrorMessage(response.status, body, parsed));
    }

    if (!expectResponse) {
      return undefined;
    }

    if (!parsed || typeof parsed !== "object") {
      return parsed;
    }

    const envelope = parsed as JsonRpcEnvelope;
    if (isJsonRpcError(envelope) && envelope.error) {
      throw new Error(envelope.error.message ?? "Brainfork MCP JSON-RPC error");
    }
    return hasJsonRpcResult(envelope) ? envelope.result : undefined;
  }
}
