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
    private sessionId;
    private initialized;
    private initializePromise;
    private requestCounter;
    private refreshToken;
    private tokenExpiresAt;
    private readonly tokenBaseUrl;
    private readonly configPath;
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
    private isTokenExpired;
    private refreshAccessToken;
    private persistTokens;
    private ensureInitialized;
    private initialize;
    private resetSession;
    private request;
}
