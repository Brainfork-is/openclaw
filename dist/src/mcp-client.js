import { isTokenExpiredOrExpiring, refreshAccessToken, persistRefreshedCredentials, } from "./token-refresh.js";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "openclaw-brainfork-plugin";
const CLIENT_VERSION = "1.0.0";
function normalizeEndpointUrl(baseUrl, endpoint) {
    if (/^https?:\/\//i.test(endpoint)) {
        return endpoint;
    }
    const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    return new URL(endpoint.replace(/^\/+/, ""), base).toString();
}
function normalizeAuthorizationHeader(apiKey) {
    const trimmed = apiKey.trim();
    if (trimmed.startsWith("Bearer ") || trimmed.startsWith("ApiKey ")) {
        return trimmed;
    }
    return `ApiKey ${trimmed}`;
}
function tryParseJson(value) {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return undefined;
    }
}
function parseMcpResponseBody(body) {
    const trimmed = body.trim();
    if (!trimmed) {
        return {};
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return JSON.parse(trimmed);
    }
    const dataLines = trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
    if (dataLines.length > 0) {
        return JSON.parse(dataLines.at(-1) ?? "{}");
    }
    throw new Error(`Unexpected MCP response body: ${trimmed.slice(0, 200)}`);
}
function isJsonRpcError(value) {
    return Boolean(value && typeof value === "object" && "error" in value);
}
function hasJsonRpcResult(value) {
    return Boolean(value && typeof value === "object" && "result" in value);
}
function extractPrimaryText(raw) {
    if (!raw || typeof raw !== "object") {
        return undefined;
    }
    const content = raw.content;
    if (!Array.isArray(content)) {
        return undefined;
    }
    const textBlock = content.find((entry) => entry && typeof entry === "object" && entry.type === "text" && entry.text);
    return typeof textBlock?.text === "string" ? textBlock.text : undefined;
}
function toErrorMessage(status, body, parsed) {
    if (isJsonRpcError(parsed) && parsed.error.message) {
        return parsed.error.message;
    }
    return `Brainfork MCP request failed with HTTP ${status}: ${body.slice(0, 200)}`;
}
function sessionResetError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    return ((lower.includes("session") &&
        (lower.includes("not found") || lower.includes("expired") || lower.includes("invalid"))) ||
        lower.includes("server not initialized") ||
        lower.includes("not initialized"));
}
export class BrainforkMcpClient {
    logger;
    endpointUrl;
    authorizationHeader;
    fetchImpl;
    requestTimeoutMs;
    baseUrl;
    refreshToken;
    tokenExpiresAt;
    refreshInProgress = null;
    configPath;
    sessionId = null;
    initialized = false;
    initializePromise = null;
    requestCounter = 1;
    constructor(config, logger, fetchImpl = globalThis.fetch, configPath) {
        this.logger = logger;
        this.endpointUrl = normalizeEndpointUrl(config.baseUrl, config.endpoint);
        this.authorizationHeader = normalizeAuthorizationHeader(config.apiKey);
        this.requestTimeoutMs = config.requestTimeoutMs;
        this.fetchImpl = fetchImpl;
        this.baseUrl = config.baseUrl;
        this.refreshToken = config.refreshToken;
        this.tokenExpiresAt = config.tokenExpiresAt;
        this.configPath = configPath;
    }
    get serverKey() {
        return this.endpointUrl;
    }
    async listTools() {
        await this.ensureInitialized();
        const result = await this.request("tools/list", {}, true);
        if (!result || typeof result !== "object" || !Array.isArray(result.tools)) {
            return [];
        }
        return result.tools;
    }
    async callTool(name, args) {
        await this.ensureInitialized();
        try {
            return await this.request("tools/call", { name, arguments: args }, true);
        }
        catch (error) {
            if (!sessionResetError(error)) {
                throw error;
            }
            this.resetSession();
            await this.ensureInitialized();
            return await this.request("tools/call", { name, arguments: args }, true);
        }
    }
    async callToolParsed(name, args) {
        const raw = await this.callTool(name, args);
        const text = extractPrimaryText(raw);
        return {
            raw,
            text,
            parsedText: tryParseJson(text),
        };
    }
    // TASK-108: Dispatch to correct tool based on mode
    async cleanupDocument(params) {
        const toolName = params.mode === "delete" ? "delete_document" : "archive_document";
        return {
            toolName,
            response: await this.callToolParsed(toolName, {
                externalId: params.externalId,
                ...(params.mode === "archive" ? { mode: params.mode } : {}),
            }),
        };
    }
    /**
     * Proactively refresh the token if it's expired or about to expire.
     * Deduplicates concurrent refresh attempts.
     */
    async ensureTokenFresh() {
        if (!this.refreshToken || !isTokenExpiredOrExpiring(this.tokenExpiresAt)) {
            return;
        }
        if (this.refreshInProgress) {
            return await this.refreshInProgress;
        }
        this.refreshInProgress = this.performTokenRefresh();
        try {
            await this.refreshInProgress;
        }
        finally {
            this.refreshInProgress = null;
        }
    }
    /**
     * Attempt token refresh after a 401 response. Returns true if refresh succeeded.
     */
    async tryRefreshOnUnauthorized() {
        if (!this.refreshToken) {
            return false;
        }
        try {
            await this.performTokenRefresh();
            return true;
        }
        catch (error) {
            this.logger.warn?.(`[brainfork-openclaw] Token refresh after 401 failed: ${String(error)}`);
            return false;
        }
    }
    async performTokenRefresh() {
        if (!this.refreshToken) {
            return;
        }
        this.logger.debug?.("[brainfork-openclaw] Refreshing access token...");
        try {
            const tokens = await refreshAccessToken(this.baseUrl, this.refreshToken, this.fetchImpl);
            // Update in-memory credentials
            this.authorizationHeader = normalizeAuthorizationHeader(tokens.access_token);
            if (tokens.refresh_token) {
                this.refreshToken = tokens.refresh_token;
            }
            if (tokens.expires_in) {
                this.tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
            }
            // Persist to config atomically
            try {
                await persistRefreshedCredentials({
                    apiKey: tokens.access_token,
                    refreshToken: this.refreshToken,
                    tokenExpiresAt: this.tokenExpiresAt,
                }, this.configPath);
                this.logger.debug?.("[brainfork-openclaw] Refreshed credentials persisted to config");
            }
            catch (persistError) {
                // Log but don't fail — in-memory credentials are already updated
                this.logger.warn?.(`[brainfork-openclaw] Failed to persist refreshed credentials: ${String(persistError)}`);
            }
        }
        catch (error) {
            this.logger.error?.(`[brainfork-openclaw] Token refresh failed: ${String(error)}`);
            throw error;
        }
    }
    async ensureInitialized() {
        if (this.initialized) {
            return;
        }
        if (this.initializePromise) {
            return await this.initializePromise;
        }
        this.initializePromise = this.initialize();
        try {
            await this.initializePromise;
        }
        finally {
            this.initializePromise = null;
        }
    }
    async initialize() {
        await this.request("initialize", {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
                elicitation: {},
            },
            clientInfo: {
                name: CLIENT_NAME,
                version: CLIENT_VERSION,
            },
        }, true);
        this.initialized = true;
        try {
            await this.request("notifications/initialized", {}, false);
        }
        catch (error) {
            this.logger.debug?.(`[brainfork-openclaw] notifications/initialized failed: ${String(error)}`);
        }
    }
    resetSession() {
        this.sessionId = null;
        this.initialized = false;
    }
    async request(method, params, expectResponse) {
        // Proactively refresh token before making the request
        await this.ensureTokenFresh();
        return this.executeRequest(method, params, expectResponse, true);
    }
    async executeRequest(method, params, expectResponse, allowRetryOn401) {
        const isNotification = method.startsWith("notifications/");
        const id = isNotification ? undefined : this.requestCounter++;
        const requestBody = {
            jsonrpc: "2.0",
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
        // Handle 401 by attempting token refresh and retrying once
        if (response.status === 401 && allowRetryOn401) {
            const refreshed = await this.tryRefreshOnUnauthorized();
            if (refreshed) {
                this.resetSession();
                await this.initialize();
                return this.executeRequest(method, params, expectResponse, false);
            }
        }
        if (!response.ok) {
            throw new Error(toErrorMessage(response.status, body, parsed));
        }
        if (!expectResponse) {
            return undefined;
        }
        if (!parsed || typeof parsed !== "object") {
            return parsed;
        }
        const envelope = parsed;
        if (isJsonRpcError(envelope) && envelope.error) {
            throw new Error(envelope.error.message ?? "Brainfork MCP JSON-RPC error");
        }
        return hasJsonRpcResult(envelope) ? envelope.result : undefined;
    }
}
//# sourceMappingURL=mcp-client.js.map