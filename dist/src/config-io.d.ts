export type BrainforkPluginConfigPatch = {
    baseUrl: string;
    endpoint: string;
    apiKey: string;
    refreshToken?: string;
    tokenExpiresAt?: string;
};
/**
 * Read and parse the OpenClaw JSON config file.
 * Returns an empty object if the file doesn't exist.
 */
export declare function readJsonConfig(configPath: string): Promise<Record<string, unknown>>;
/**
 * Write the brainfork-openclaw plugin config into the OpenClaw config file.
 * Merges with existing config, preserving other settings.
 */
export declare function writeBrainforkPluginConfig(configPath: string, pluginConfig: BrainforkPluginConfigPatch): Promise<void>;
export type RefreshableCredentialsPatch = {
    apiKey: string;
    refreshToken?: string;
    tokenExpiresAt?: string;
};
/**
 * Atomically update the stored credentials in the OpenClaw config file.
 * Uses write-to-temp-then-rename for crash safety.
 */
export declare function persistRefreshedCredentials(credentials: RefreshableCredentialsPatch, configPath?: string): Promise<void>;
