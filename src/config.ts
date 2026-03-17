export const DELETE_MODES = ["ignore", "archive", "delete"] as const;
export const SEARCH_MODES = ["search", "vsearch", "query"] as const;

export type DeleteMode = (typeof DELETE_MODES)[number];
export type SearchMode = (typeof SEARCH_MODES)[number];

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
  searchMode: SearchMode;
  requestTimeoutMs: number;
};

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_SIMILARITY_THRESHOLD = 0.2;
const DEFAULT_MAX_TOKENS = 600;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, envName: string) => {
    const resolved = process.env[envName];
    if (!resolved) {
      throw new Error(`Environment variable ${envName} is not set`);
    }
    return resolved;
  });
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
) {
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknownKeys.join(", ")}`);
  }
}

function readRequiredString(
  value: Record<string, unknown>,
  key: keyof BrainforkPluginConfig,
  label: string,
): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return resolveEnvVars(raw.trim());
}

function readBoolean(
  value: Record<string, unknown>,
  key: keyof BrainforkPluginConfig,
  fallback: boolean,
): boolean {
  const raw = value[key];
  return typeof raw === "boolean" ? raw : fallback;
}

function readInteger(
  value: Record<string, unknown>,
  key: keyof BrainforkPluginConfig,
  options: { fallback: number; min: number; max: number },
): number {
  const raw = value[key];
  const candidate = typeof raw === "number" ? raw : options.fallback;
  if (!Number.isInteger(candidate)) {
    throw new Error(`${String(key)} must be an integer`);
  }
  if (candidate < options.min || candidate > options.max) {
    throw new Error(`${String(key)} must be between ${options.min} and ${options.max}`);
  }
  return candidate;
}

function readNumber(
  value: Record<string, unknown>,
  key: keyof BrainforkPluginConfig,
  options: { fallback: number; min: number; max: number },
): number {
  const raw = value[key];
  const candidate = typeof raw === "number" ? raw : options.fallback;
  if (!Number.isFinite(candidate)) {
    throw new Error(`${String(key)} must be a number`);
  }
  if (candidate < options.min || candidate > options.max) {
    throw new Error(`${String(key)} must be between ${options.min} and ${options.max}`);
  }
  return candidate;
}

function readDeleteMode(value: Record<string, unknown>): DeleteMode {
  const raw = value.deleteMode;
  if (raw === undefined) {
    return "archive";
  }
  if (typeof raw !== "string" || !DELETE_MODES.includes(raw as DeleteMode)) {
    throw new Error(`deleteMode must be one of: ${DELETE_MODES.join(", ")}`);
  }
  return raw as DeleteMode;
}

function readSearchMode(value: Record<string, unknown>): SearchMode {
  const raw = value.searchMode;
  if (raw === undefined) {
    return "query";
  }
  if (typeof raw !== "string" || !SEARCH_MODES.includes(raw as SearchMode)) {
    throw new Error(`searchMode must be one of: ${SEARCH_MODES.join(", ")}`);
  }
  return raw as SearchMode;
}

export const brainforkConfigSchema = {
  parse(value: unknown): BrainforkPluginConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("brainfork-openclaw config required");
    }

    const raw = value as Record<string, unknown>;
    assertAllowedKeys(
      raw,
      [
        "baseUrl",
        "endpoint",
        "apiKey",
        "autoRecall",
        "autoIndex",
        "captureDecisions",
        "maxResults",
        "similarityThreshold",
        "maxTokens",
        "deleteMode",
        "searchMode",
        "requestTimeoutMs",
      ],
      "brainfork-openclaw config",
    );

    return {
      baseUrl: readRequiredString(raw, "baseUrl", "baseUrl"),
      endpoint: readRequiredString(raw, "endpoint", "endpoint"),
      apiKey: readRequiredString(raw, "apiKey", "apiKey"),
      autoRecall: readBoolean(raw, "autoRecall", true),
      autoIndex: readBoolean(raw, "autoIndex", true),
      captureDecisions: readBoolean(raw, "captureDecisions", true),
      maxResults: readInteger(raw, "maxResults", {
        fallback: DEFAULT_MAX_RESULTS,
        min: 1,
        max: 20,
      }),
      similarityThreshold: readNumber(raw, "similarityThreshold", {
        fallback: DEFAULT_SIMILARITY_THRESHOLD,
        min: 0,
        max: 1,
      }),
      maxTokens: readInteger(raw, "maxTokens", {
        fallback: DEFAULT_MAX_TOKENS,
        min: 64,
        max: 4096,
      }),
      deleteMode: readDeleteMode(raw),
      searchMode: readSearchMode(raw),
      requestTimeoutMs: readInteger(raw, "requestTimeoutMs", {
        fallback: DEFAULT_REQUEST_TIMEOUT_MS,
        min: 1000,
        max: 120_000,
      }),
    };
  },
  uiHints: {
    baseUrl: {
      label: "Brainfork Base URL",
      placeholder: "https://api.brainfork.is",
      help: "Base Brainfork API host for the MCP endpoint",
    },
    endpoint: {
      label: "Brainfork Endpoint",
      placeholder: "my-server",
      help: "Server endpoint slug or full MCP URL",
    },
    apiKey: {
      label: "Brainfork API Key",
      sensitive: true,
      placeholder: "bfk_...",
      help: 'Sent as Authorization. Prefix with "Bearer " if needed.',
    },
    autoRecall: {
      label: "Auto Recall",
      help: "Search Brainfork before agent start and prepend a memory block",
    },
    autoIndex: {
      label: "Auto Index",
      help: "Sync MEMORY.md and memory/**/*.md after each agent run",
    },
    captureDecisions: {
      label: "Capture Decisions",
      help: "Log durable conversation decisions into Brainfork",
    },
    maxResults: {
      label: "Max Results",
      advanced: true,
      help: "Maximum Brainfork results to keep per recall or tool query",
    },
    similarityThreshold: {
      label: "Similarity Threshold",
      advanced: true,
      help: "Minimum similarity score accepted for Brainfork auto-recall results",
    },
    maxTokens: {
      label: "Max Tokens",
      advanced: true,
      help: "Approximate token budget for injected memory context",
    },
    deleteMode: {
      label: "Delete Mode",
      help: "Use ignore, archive, or delete for removed local documents",
    },
    searchMode: {
      label: "Search Mode",
      advanced: true,
      help: "Default search mode for auto-recall: search (BM25), vsearch (vector), or query (hybrid+rerank)",
    },
    requestTimeoutMs: {
      label: "Request Timeout",
      advanced: true,
      help: "Abort Brainfork requests that exceed this duration in milliseconds",
    },
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      baseUrl: { type: "string" },
      endpoint: { type: "string" },
      apiKey: { type: "string" },
      autoRecall: { type: "boolean" },
      autoIndex: { type: "boolean" },
      captureDecisions: { type: "boolean" },
      maxResults: { type: "integer", minimum: 1, maximum: 20 },
      similarityThreshold: { type: "number", minimum: 0, maximum: 1 },
      maxTokens: { type: "integer", minimum: 64, maximum: 4096 },
      deleteMode: { type: "string", enum: [...DELETE_MODES] },
      searchMode: { type: "string", enum: [...SEARCH_MODES] },
      requestTimeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
    },
    required: ["baseUrl", "endpoint", "apiKey"],
  },
};
