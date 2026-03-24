import type { PluginLogger } from "openclaw/plugin-sdk";
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
export declare function validateManualCredentials(baseUrl: string, apiKey: string): Promise<void>;
export declare function validateEndpoint(baseUrl: string, endpoint: string, apiKey: string): Promise<void>;
export declare function writeBrainforkPluginConfig(configPath: string, pluginConfig: BrainforkSetupConfig): Promise<void>;
export declare function registerBrainforkSetupCommand(options: BrainforkSetupCommandOptions): void;
export {};
