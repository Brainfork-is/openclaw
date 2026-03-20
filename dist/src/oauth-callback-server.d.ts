import http from "node:http";
export type OAuthCallbackServer = {
    server: http.Server;
    port: number;
    codePromise: Promise<string>;
};
export declare function startOAuthCallbackServer(expectedState: string, timeoutMs?: number): Promise<OAuthCallbackServer>;
