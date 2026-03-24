import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import type { Writable } from "node:stream";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { generatePkceVerifierChallenge, toFormUrlEncoded } from "openclaw/plugin-sdk";
import { startOAuthCallbackServer } from "./oauth-callback-server.js";
import { openBrowser } from "./browser-open.js";

const DEFAULT_BASE_URL = "https://api.brainfork.is";
const OAUTH_CLIENT_ID = "openclaw-brainfork-plugin";
const OAUTH_SCOPE = "mcp:tools:read mcp:tools:execute mcp:resources:read mcp:prompts:read";
const DEFAULT_TIMEOUT_MS = 120_000;

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

type PromptApi = {
  ask(message: string, defaultValue?: string): Promise<string>;
  askSecret(message: string): Promise<string>;
  close(): Promise<void>;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  [key: string]: unknown;
};

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim() || DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

function buildAuthorizeUrl(baseUrl: string, redirectUri: string, state: string, challenge: string): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", OAUTH_SCOPE);
  return url.toString();
}

export async function exchangeOAuthCode(params: {
  baseUrl: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<TokenResponse> {
  const response = await fetch(`${normalizeBaseUrl(params.baseUrl)}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: toFormUrlEncoded({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: OAUTH_CLIENT_ID,
      code_verifier: params.verifier,
    }),
  });

  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Token exchange failed with non-JSON response (${response.status})`);
  }

  if (!response.ok) {
    const detail = typeof payload.error_description === "string"
      ? payload.error_description
      : typeof payload.error === "string"
        ? payload.error
        : response.statusText;
    throw new Error(`Token exchange failed (${response.status}): ${detail}`);
  }

  if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
    throw new Error("Token exchange succeeded but access_token was missing");
  }

  return payload as unknown as TokenResponse;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

export function detectEndpointFromAccessToken(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(parts[1] ?? "")) as Record<string, unknown>;
    const candidates = [
      payload.endpoint,
      payload.server,
      payload.server_name,
      payload.workspace,
      payload.workspace_slug,
      payload.endpoint_slug,
      payload.mcp_endpoint,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }

    if (typeof payload.aud === "string" && payload.aud.trim() && /^https?:\/\//i.test(payload.aud)) {
      const url = new URL(payload.aud);
      return url.pathname.replace(/^\/+/, "") || undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export async function validateManualCredentials(baseUrl: string, apiKey: string): Promise<void> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/health`, {
    method: "GET",
    headers: {
      Authorization: apiKey.startsWith("Bearer ") || apiKey.startsWith("ApiKey ")
        ? apiKey
        : `ApiKey ${apiKey}`,
      Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Validation failed (${response.status}): ${body || response.statusText}`);
  }
}

export async function writeBrainforkPluginConfig(
  configPath: string,
  pluginConfig: BrainforkSetupConfig,
): Promise<void> {
  let rawConfig: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(configPath, "utf8");
    rawConfig = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  const plugins = asRecord(rawConfig.plugins) ?? {};
  const entries = asRecord(plugins.entries) ?? {};
  const existingEntry = asRecord(entries["brainfork-openclaw"]) ?? {};

  const nextConfig = {
    ...rawConfig,
    plugins: {
      ...plugins,
      entries: {
        ...entries,
        "brainfork-openclaw": {
          ...existingEntry,
          enabled: true,
          config: {
            ...(asRecord(existingEntry.config) ?? {}),
            baseUrl: pluginConfig.baseUrl,
            endpoint: pluginConfig.endpoint,
            apiKey: pluginConfig.apiKey,
            ...(pluginConfig.refreshToken !== undefined ? { refreshToken: pluginConfig.refreshToken } : {}),
            ...(pluginConfig.tokenExpiresAt !== undefined ? { tokenExpiresAt: pluginConfig.tokenExpiresAt } : {}),
          },
        },
      },
    },
  };

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, configPath);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function createPromptApi(): PromptApi {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  async function ask(message: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    const answer = await rl.question(`${message}${suffix}: `);
    const trimmed = answer.trim();
    return trimmed || defaultValue || "";
  }

  async function askSecret(message: string): Promise<string> {
    const mutableOutput = process.stdout as Writable & { muted?: boolean };
    const originalWrite = mutableOutput.write.bind(mutableOutput);
    mutableOutput.muted = false;
    mutableOutput.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (error?: Error | null) => void) => {
      const safeEncoding = encoding ?? "utf8";
      if (mutableOutput.muted) {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(safeEncoding);
        const masked = text.replace(/./g, "*");
        return originalWrite(masked, safeEncoding, cb);
      }
      return originalWrite(chunk as never, safeEncoding, cb);
    }) as typeof mutableOutput.write;

    try {
      mutableOutput.muted = true;
      const answer = await rl.question(`${message}: `);
      originalWrite("\n");
      return answer.trim();
    } finally {
      mutableOutput.muted = false;
      mutableOutput.write = originalWrite;
    }
  }

  return {
    ask,
    askSecret,
    async close() {
      rl.close();
    },
  };
}

async function runManualSetup(prompts: PromptApi, configPath: string): Promise<BrainforkSetupConfig> {
  const baseUrl = normalizeBaseUrl(await prompts.ask("Brainfork API URL", DEFAULT_BASE_URL));
  const apiKey = await prompts.askSecret("Brainfork API key");
  if (!apiKey) {
    throw new Error("API key is required");
  }

  await validateManualCredentials(baseUrl, apiKey);
  const endpoint = (await prompts.ask("Endpoint/server name")).trim();
  if (!endpoint) {
    throw new Error("Endpoint/server name is required");
  }

  const nextConfig = { baseUrl, endpoint, apiKey };
  await writeBrainforkPluginConfig(configPath, nextConfig);
  return nextConfig;
}

async function runBrowserOAuthSetup(prompts: PromptApi, configPath: string): Promise<BrainforkSetupConfig> {
  const baseUrl = normalizeBaseUrl(await prompts.ask("Brainfork API URL", DEFAULT_BASE_URL));
  const { verifier, challenge } = generatePkceVerifierChallenge();
  const state = crypto.randomUUID();
  const { server, port, codePromise } = await startOAuthCallbackServer(state, DEFAULT_TIMEOUT_MS);
  const redirectUri = `http://localhost:${port}/callback`;
  const authorizeUrl = buildAuthorizeUrl(baseUrl, redirectUri, state, challenge);

  try {
    await openBrowser(authorizeUrl);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`${String(error)} Try manual setup instead.`);
  }

  console.log("Waiting for browser authentication... (press Ctrl+C to cancel)");

  let tokens: TokenResponse;
  try {
    const code = await codePromise;
    tokens = await exchangeOAuthCode({
      baseUrl,
      code,
      redirectUri,
      verifier,
    });
  } catch (error) {
    throw new Error(`${String(error)} Try manual setup instead.`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const endpointFromToken = detectEndpointFromAccessToken(tokens.access_token);
  const endpoint = (endpointFromToken || await prompts.ask("Endpoint/server name")).trim();
  if (!endpoint) {
    throw new Error("Endpoint/server name is required");
  }

  const nextConfig: BrainforkSetupConfig = {
    baseUrl,
    endpoint,
    apiKey: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    ...(typeof tokens.expires_in === "number" ? { tokenExpiresAt: Date.now() + tokens.expires_in * 1000 } : {}),
  };
  await writeBrainforkPluginConfig(configPath, nextConfig);
  return nextConfig;
}

export function registerBrainforkSetupCommand(options: BrainforkSetupCommandOptions): void {
  options.brainfork
    .command("setup")
    .description("Interactively connect this OpenClaw install to Brainfork")
    .option("--base-url <url>", "Brainfork API URL (non-interactive mode)")
    .option("--api-key <key>", "Brainfork API key (non-interactive mode)")
    .option("--endpoint <name>", "Endpoint/server name (non-interactive mode)")
    .option("--skip-validation", "Skip API key validation against the server")
    .action(async (cliOpts: Record<string, string | undefined>) => {
      const configPath = options.configPath;

      // Non-interactive mode: all three required flags are provided
      if (cliOpts.baseUrl && cliOpts.apiKey && cliOpts.endpoint) {
        const baseUrl = normalizeBaseUrl(cliOpts.baseUrl);
        const apiKey = cliOpts.apiKey;
        const endpoint = cliOpts.endpoint.trim();

        if (!endpoint) {
          throw new Error("Endpoint/server name is required");
        }

        if (!cliOpts.skipValidation) {
          await validateManualCredentials(baseUrl, apiKey);
        }

        const nextConfig = { baseUrl, endpoint, apiKey };
        await writeBrainforkPluginConfig(configPath, nextConfig);
        console.log(`✅ Connected to Brainfork (server: '${nextConfig.endpoint}')`);
        return;
      }

      // If some but not all non-interactive flags are set, error out
      if (cliOpts.baseUrl || cliOpts.apiKey || cliOpts.endpoint) {
        throw new Error(
          "Non-interactive setup requires all three flags: --base-url, --api-key, and --endpoint",
        );
      }

      // Interactive mode (original flow)
      const prompts = createPromptApi();
      try {
        const choice = await prompts.ask(
          "How would you like to authenticate? [1] Browser login (recommended) [2] Manual setup",
          "1",
        );

        const result = choice.trim() === "2"
          ? await runManualSetup(prompts, configPath)
          : await runBrowserOAuthSetup(prompts, configPath);

        console.log(`✅ Connected to Brainfork (server: '${result.endpoint}')`);
      } catch (error) {
        options.logger.error(`[brainfork-openclaw] setup failed: ${String(error)}`);
        throw error;
      } finally {
        await prompts.close();
      }
    });
}
