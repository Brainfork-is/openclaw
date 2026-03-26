import { persistRefreshedCredentials as persistCredentials, } from "./config-io.js";
const OAUTH_CLIENT_ID = "openclaw-brainfork-plugin";
/** Minimum seconds remaining before we proactively refresh. */
const REFRESH_BUFFER_SECONDS = 300; // 5 minutes
/**
 * Returns true if the access token is expired or will expire within the buffer window.
 * Returns false if no expiry is known (e.g. long-lived API keys).
 */
export function isTokenExpiredOrExpiring(tokenExpiresAt) {
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
export async function refreshAccessToken(baseUrl, refreshToken, fetchImpl = globalThis.fetch) {
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
    let payload;
    try {
        payload = text ? JSON.parse(text) : {};
    }
    catch {
        throw new Error(`Token refresh failed with non-JSON response (${response.status})`);
    }
    if (!response.ok) {
        const detail = typeof payload.error_description === "string"
            ? payload.error_description
            : typeof payload.error === "string"
                ? payload.error
                : response.statusText;
        throw new Error(`Token refresh failed (${response.status}): ${detail}`);
    }
    if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
        throw new Error("Token refresh succeeded but access_token was missing");
    }
    return payload;
}
/**
 * Atomically update the stored credentials in the OpenClaw config file.
 * Re-exported from config-io.ts which handles all filesystem I/O.
 */
export async function persistRefreshedCredentials(credentials, configPath) {
    return persistCredentials(credentials, configPath);
}
//# sourceMappingURL=token-refresh.js.map