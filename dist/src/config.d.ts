export declare const DELETE_MODES: readonly ["ignore", "archive", "delete"];
export type DeleteMode = (typeof DELETE_MODES)[number];
export type BrainforkPluginConfig = {
    baseUrl: string;
    endpoint: string;
    apiKey: string;
    autoRecall: boolean;
    autoIndex: boolean;
    captureDecisions: boolean;
    maxResults: number;
    similarityThreshold: number;
    maxTokens: number;
    deleteMode: DeleteMode;
    requestTimeoutMs: number;
};
export declare const brainforkConfigSchema: {
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
            requestTimeoutMs: {
                type: string;
                minimum: number;
                maximum: number;
            };
        };
        required: string[];
    };
};
