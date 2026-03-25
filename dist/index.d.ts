import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { type BrainforkPluginConfig } from "./src/config.js";
/**
 * Extract the agent name from a workspace directory path.
 * e.g. "/home/agent/.openclaw/workspace-osborn" → "osborn"
 *      "/home/agent/.openclaw/workspace-gertrude" → "gertrude"
 * Returns undefined if the directory doesn't follow the workspace-{name} pattern.
 */
export declare function extractAgentName(workspaceDir: string): string | undefined;
declare const brainforkPlugin: {
    id: string;
    name: string;
    description: string;
    kind: "memory";
    configSchema: {
        parse(value: unknown): BrainforkPluginConfig;
        uiHints: {
            baseUrl: {
                label: string;
                placeholder: string;
                help: string;
            };
            endpoint: {
                label: string;
                placeholder: string;
                help: string;
            };
            apiKey: {
                label: string;
                sensitive: boolean;
                placeholder: string;
                help: string;
            };
            autoRecall: {
                label: string;
                help: string;
            };
            autoIndex: {
                label: string;
                help: string;
            };
            captureDecisions: {
                label: string;
                help: string;
            };
            maxResults: {
                label: string;
                advanced: boolean;
                help: string;
            };
            similarityThreshold: {
                label: string;
                advanced: boolean;
                help: string;
            };
            maxTokens: {
                label: string;
                advanced: boolean;
                help: string;
            };
            deleteMode: {
                label: string;
                help: string;
            };
            searchMode: {
                label: string;
                advanced: boolean;
                help: string;
            };
            requestTimeoutMs: {
                label: string;
                advanced: boolean;
                help: string;
            };
        };
        jsonSchema: {
            type: string;
            additionalProperties: boolean;
            properties: {
                baseUrl: {
                    type: string;
                };
                endpoint: {
                    type: string;
                };
                apiKey: {
                    type: string;
                };
                refreshToken: {
                    type: string;
                };
                tokenExpiresAt: {
                    type: string;
                };
                autoRecall: {
                    type: string;
                };
                autoIndex: {
                    type: string;
                };
                captureDecisions: {
                    type: string;
                };
                maxResults: {
                    type: string;
                    minimum: number;
                    maximum: number;
                };
                similarityThreshold: {
                    type: string;
                    minimum: number;
                    maximum: number;
                };
                maxTokens: {
                    type: string;
                    minimum: number;
                    maximum: number;
                };
                deleteMode: {
                    type: string;
                    enum: ("ignore" | "archive" | "delete")[];
                };
                searchMode: {
                    type: string;
                    enum: ("search" | "vsearch" | "query")[];
                };
                requestTimeoutMs: {
                    type: string;
                    minimum: number;
                    maximum: number;
                };
            };
            required: string[];
        };
    };
    register(api: OpenClawPluginApi): void;
};
export default brainforkPlugin;
