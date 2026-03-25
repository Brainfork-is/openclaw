type TokenResponse = {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    [key: string]: unknown;
};
export type RefreshableCredentials = {
    apiKey: string;
    refreshToken?: string;
    tokenExpiresAt?: string;
};
/**
 * Returns true if the access token is expired or will expire within the buffer window.
 * Returns false if no expiry is known (e.g. long-lived API keys).
 */
export declare function isTokenExpiredOrExpiring(tokenExpiresAt: string | undefined): boolean;
/**
 * Exchange a refresh token for a new access token.
 */
export declare function refreshAccessToken(baseUrl: string, refreshToken: string, fetchImpl?: typeof fetch): Promise<TokenResponse>;
/**
 * Atomically update the stored credentials in the OpenClaw config file.
 * Uses write-to-temp-then-rename for crash safety.
 */
export declare function persistRefreshedCredentials(credentials: RefreshableCredentials, configPath?: string): Promise<void>;
export {};
