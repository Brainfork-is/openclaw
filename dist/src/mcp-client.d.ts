import type { PluginLogger } from "openclaw/plugin-sdk";
import type { BrainforkPluginConfig, DeleteMode } from "./config.js";
export type ParsedToolCallResponse = {
    raw: unknown;
    text?: string;
    parsedText?: unknown;
};
export declare class BrainforkMcpClient {
    private readonly logger;
    private readonly endpointUrl;
    private authorizationHeader;
    private readonly fetchImpl;
    private readonly requestTimeoutMs;
    private readonly baseUrl;
    private refreshToken;
    private tokenExpiresAt;
    private refreshInProgress;
    private readonly configPath;
    private sessionId;
    private initialized;
    private initializePromise;
    private requestCounter;
    constructor(config: BrainforkPluginConfig, logger: PluginLogger, fetchImpl?: typeof fetch, configPath?: string);
    get serverKey(): string;
    listTools(): Promise<Array<{
        name?: string;
        title?: string;
        description?: string;
    }>>;
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
    callToolParsed(name: string, args: Record<string, unknown>): Promise<ParsedToolCallResponse>;
    cleanupDocument(params: {
        externalId: string;
        sha256?: string;
        remoteId?: string;
        mode: Exclude<DeleteMode, "ignore">;
    }): Promise<{
        toolName: string;
        response: ParsedToolCallResponse;
    }>;
    /**
     * Proactively refresh the token if it's expired or about to expire.
     * Deduplicates concurrent refresh attempts.
     */
    private ensureTokenFresh;
    /**
     * Attempt token refresh after a 401 response. Returns true if refresh succeeded.
     */
    private tryRefreshOnUnauthorized;
    private performTokenRefresh;
    private ensureInitialized;
    private initialize;
    private resetSession;
    private request;
    private executeRequest;
}
