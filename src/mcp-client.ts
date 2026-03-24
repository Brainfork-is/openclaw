import type { PluginLogger } from "openclaw/plugin-sdk";
import type { BrainforkPluginConfig, DeleteMode } from "./config.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "openclaw-brainfork-plugin";
const CLIENT_VERSION = "1.0.0";

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
  private readonly authorizationHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private sessionId: string | null = null;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private requestCounter = 1;

  constructor(
    config: BrainforkPluginConfig,
    private readonly logger: PluginLogger,
    fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.endpointUrl = normalizeEndpointUrl(config.baseUrl, config.endpoint);
    this.authorizationHeader = normalizeAuthorizationHeader(config.apiKey);
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.fetchImpl = fetchImpl;
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

  // TASK-108: Dispatch to correct tool based on mode
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
  ): Promise<unknown> {
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
