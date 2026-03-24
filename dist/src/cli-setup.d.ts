import type { PluginLogger } from "openclaw/plugin-sdk";
type OptionChain = {
    option(flags: string, description: string): OptionChain;
    description(text: string): OptionChain;
    action(fn: (opts: Record<string, string | undefined>) => Promise<void> | void): unknown;
};
type CommandLike = {
    command(name: string): OptionChain;
};
export type BrainforkSetupConfig = {
    baseUrl: string;
    endpoint: string;
    apiKey: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
};
export type BrainforkSetupCommandOptions = {
    brainfork: CommandLike;
    logger: PluginLogger;
    configPath: string;
    /** @deprecated Use configPath instead */
    resolvePath?: (input: string) => string;
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
export declare function writeBrainforkPluginConfig(configPath: string, pluginConfig: BrainforkSetupConfig): Promise<void>;
export declare function registerBrainforkSetupCommand(options: BrainforkSetupCommandOptions): void;
export {};
