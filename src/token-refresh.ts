import type { PluginLogger } from "openclaw/plugin-sdk";
import {
  persistRefreshedCredentials as persistCredentials,
  type RefreshableCredentialsPatch,
} from "./config-io.js";

const OAUTH_CLIENT_ID = "openclaw-brainfork-plugin";

/** Minimum seconds remaining before we proactively refresh. */
const REFRESH_BUFFER_SECONDS = 300; // 5 minutes

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
export function isTokenExpiredOrExpiring(tokenExpiresAt: string | undefined): boolean {
  if (!tokenExpiresAt) {
    return false;
  }
  const expiresAtMs = new Date(tokenExpiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) {
    return false;
  }
  return Date.now() >= expiresAtMs - REFRESH_BUFFER_SECONDS * 1000;
}

/**
 * Exchange a refresh token for a new access token.
 */
export async function refreshAccessToken(
  baseUrl: string,
  refreshToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });

  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Token refresh failed with non-JSON response (${response.status})`);
  }

  if (!response.ok) {
    const detail =
      typeof payload.error_description === "string"
        ? payload.error_description
        : typeof payload.error === "string"
          ? payload.error
          : response.statusText;
    throw new Error(`Token refresh failed (${response.status}): ${detail}`);
  }

  if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
    throw new Error("Token refresh succeeded but access_token was missing");
  }

  return payload as unknown as TokenResponse;
}

/**
 * Atomically update the stored credentials in the OpenClaw config file.
 * Re-exported from config-io.ts which handles all filesystem I/O.
 */
export async function persistRefreshedCredentials(
  credentials: RefreshableCredentials,
  configPath?: string,
): Promise<void> {
  return persistCredentials(credentials, configPath);
}
