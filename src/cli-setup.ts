import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline/promises";
import type { Writable } from "node:stream";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { startOAuthCallbackServer } from "./oauth-callback-server.js";
import { hasGraphicalSession, resolveOpenClawStateDir } from "./env-detect.js";
import { writeBrainforkPluginConfig } from "./config-io.js";
export { writeBrainforkPluginConfig } from "./config-io.js";

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = "https://api.brainfork.is";

/** Generate a PKCE code verifier and S256 challenge locally using Node.js crypto. */
export function generatePkceVerifierChallenge(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** URL-encode an object into application/x-www-form-urlencoded format. */
function toFormUrlEncoded(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}
const OAUTH_CLIENT_ID = "openclaw-brainfork-plugin";
const OAUTH_SCOPE = "mcp:tools:read mcp:tools:execute mcp:resources:read mcp:prompts:read";
const DEFAULT_TIMEOUT_MS = 120_000;

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

function resolveStateConfigPath(): string {
  return path.join(resolveOpenClawStateDir(), "openclaw.json");
}

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
  // Always force consent so the user can select/change their server
  url.searchParams.set("prompt", "consent");
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
    signal: AbortSignal.timeout(30_000),
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
    
    // Check direct endpoint claims first
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
  } catch {
    return undefined;
  }

  return undefined;
}

/** Extract server_ids from the JWT so we can look up the endpoint name via API */
function extractServerIdsFromToken(accessToken: string): string[] {
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) return [];
    const payload = JSON.parse(decodeBase64Url(parts[1] ?? "")) as Record<string, unknown>;
    if (Array.isArray(payload.server_ids)) {
      return payload.server_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    }
    return [];
  } catch {
    return [];
  }
}

/** Look up the endpoint slug for a server ID via the Brainfork API */
async function resolveEndpointFromServerId(baseUrl: string, accessToken: string, serverId: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/oauth/user-servers`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return undefined;
    const data = await response.json() as { servers?: Array<{ id: string; endpoint: string; name: string }> };
    const server = data.servers?.find((s) => s.id === serverId);
    return server?.endpoint;
  } catch {
    return undefined;
  }
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
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Validation failed (${response.status}): ${body || response.statusText}`);
  }
}

export async function validateEndpoint(baseUrl: string, endpoint: string, apiKey: string): Promise<void> {
  const url = `${normalizeBaseUrl(baseUrl)}/${endpoint}/mcp`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey.startsWith("Bearer ") || apiKey.startsWith("ApiKey ")
        ? apiKey
        : `ApiKey ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Endpoint '${endpoint}' is not accessible (${response.status}): ${response.statusText}`);
  }

  let payload: Record<string, unknown>;
  try {
    const text = await response.text();
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Endpoint '${endpoint}' returned an invalid JSON-RPC response`);
  }

  if (typeof payload.jsonrpc !== "string" || (!payload.result && !payload.error)) {
    throw new Error(`Endpoint '${endpoint}' did not return a valid JSON-RPC response`);
  }
}

async function openBrowser(url: string): Promise<void> {
  // Try the 'open' npm package if available (optional peer dependency).
  // Use createRequire to avoid static analysis flagging dynamic code execution.
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const openMod = require("open") as { default?: (target: string) => Promise<void> };
    const openFn = typeof openMod === "function"
      ? (openMod as unknown as (target: string) => Promise<void>)
      : typeof openMod?.default === "function"
        ? openMod.default
        : undefined;
    if (openFn) {
      await openFn(url);
      return;
    }
  } catch {
    // fall through to platform-specific openers
  }

  if (process.platform === "linux") {
    if (!hasGraphicalSession()) {
      throw new Error("No graphical session detected. Try manual setup instead.");
    }
    await execFileAsync("xdg-open", [url]);
    return;
  }

  if (process.platform === "darwin") {
    await execFileAsync("open", [url]);
    return;
  }

  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
    return;
  }

  throw new Error("Unable to open a browser on this platform. Try manual setup instead.");
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

  await validateEndpoint(baseUrl, endpoint, apiKey);
  const nextConfig = { baseUrl, endpoint, apiKey };
  await writeBrainforkPluginConfig(configPath, nextConfig);
  return nextConfig;
}

async function runBrowserOAuthSetup(prompts: PromptApi, configPath: string): Promise<BrainforkSetupConfig> {
  // Browser flow uses the default API URL — no need to ask
  const baseUrl = DEFAULT_BASE_URL;
  const { verifier, challenge } = generatePkceVerifierChallenge();
  const state = crypto.randomUUID();
  const { server, port, codePromise } = await startOAuthCallbackServer(state, DEFAULT_TIMEOUT_MS);
  // TASK-110: Use 127.0.0.1 to match callback server bind address (avoids IPv6 mismatch)
  const redirectUri = `http://127.0.0.1:${port}/callback`;
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

  // Try to auto-detect the endpoint: first from JWT claims, then by resolving server_ids via API
  let endpoint = detectEndpointFromAccessToken(tokens.access_token);
  if (!endpoint) {
    const serverIds = extractServerIdsFromToken(tokens.access_token);
    if (serverIds.length > 0) {
      endpoint = await resolveEndpointFromServerId(baseUrl, tokens.access_token, serverIds[0]) ?? undefined;
    }
  }
  // Only ask the user if we couldn't auto-detect
  if (!endpoint) {
    console.log("\nAuthenticated successfully! Now we need your MCP server endpoint slug.");
    console.log("You can find this in your Brainfork dashboard under Servers → your server name.");
    endpoint = (await prompts.ask("Endpoint slug (e.g. 'test' or 'my-server')")).trim();
  } else {
    console.log(`\n✅ Using endpoint: ${endpoint}`);
  }
  if (!endpoint) {
    throw new Error("Endpoint/server name is required");
  }

  await validateEndpoint(baseUrl, endpoint, tokens.access_token);
  const nextConfig: BrainforkSetupConfig = {
    baseUrl,
    endpoint,
    apiKey: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    ...(tokens.expires_in
      ? { tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString() }
      : {}),
  };
  await writeBrainforkPluginConfig(configPath, nextConfig);
  return nextConfig;
}

export function registerBrainforkSetupCommand(options: BrainforkSetupCommandOptions): void {
  options.brainfork
    .command("setup")
    .description("Interactively connect this OpenClaw install to Brainfork")
    .action(async () => {
      const prompts = createPromptApi();
      // Use explicit configPath if provided, otherwise resolve the state-dir config path.
      // NOTE: options.resolvePath resolves against the workspace directory, which is WRONG
      // for plugin config — we need the OpenClaw state config at ~/.openclaw/openclaw.json
      // (or $OPENCLAW_STATE_DIR/openclaw.json).
      const configPath = options.configPath ?? resolveStateConfigPath();

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
