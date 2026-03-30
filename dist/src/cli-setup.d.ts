import type { PluginLogger } from "openclaw/plugin-sdk";
export { writeBrainforkPluginConfig } from "./config-io.js";
/** Generate a PKCE code verifier and S256 challenge locally using Node.js crypto. */
export declare function generatePkceVerifierChallenge(): {
    verifier: string;
    challenge: string;
};
type CommandLike = {
    command(name: string): {
        description(text: string): {
            action(fn: () => Promise<void> | void): unknown;
        };
    };
};
export type BrainforkSetupConfig = {
    baseUrl: string;
    endpoint: string;
    apiKey: string;
    refreshToken?: string;
    tokenExpiresAt?: string;
};
export type BrainforkSetupCommandOptions = {
    brainfork: CommandLike;
    logger: PluginLogger;
    resolvePath: (input: string) => string;
    /** Explicit state-dir config path. When provided, setup writes here instead of using resolvePath. */
    configPath?: string;
};
type TokenResponse = {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    [key: string]: unknown;
};
export declare function exchangeOAuthCode(params: {
    baseUrl: string;
    code: string;
    redirectUri: string;
    verifier: string;
}): Promise<TokenResponse>;
export declare function detectEndpointFromAccessToken(accessToken: string): string | undefined;
/**
 * @deprecated Use validateEndpoint instead — /health requires no auth so this
 * check always passes on a reachable server regardless of credential validity.
 * Kept temporarily for backward compatibility but marked for removal.
 */
export declare function validateManualCredentials(baseUrl: string, apiKey: string): Promise<void>;
export declare function validateEndpoint(baseUrl: string, endpoint: string, apiKey: string): Promise<void>;
export declare function registerBrainforkSetupCommand(options: BrainforkSetupCommandOptions): void;
