import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawStateDir } from "./env-detect.js";
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
 * Uses write-to-temp-then-rename for crash safety.
 */
export async function persistRefreshedCredentials(credentials, configPath) {
    const resolvedPath = configPath ?? path.join(resolveOpenClawStateDir(), "openclaw.json");
    let rawConfig = {};
    try {
        const text = await fs.readFile(resolvedPath, "utf8");
        rawConfig = text.trim() ? JSON.parse(text) : {};
    }
    catch (error) {
        const nodeError = error;
        if (nodeError.code !== "ENOENT") {
            throw error;
        }
    }
    // Navigate to plugins.entries.brainfork-openclaw.config
    const plugins = asRecord(rawConfig.plugins) ?? {};
    const entries = asRecord(plugins.entries) ?? {};
    const pluginEntry = asRecord(entries["brainfork-openclaw"]) ?? {};
    const existingConfig = asRecord(pluginEntry.config) ?? {};
    const updatedConfig = {
        ...existingConfig,
        apiKey: credentials.apiKey,
        ...(credentials.refreshToken ? { refreshToken: credentials.refreshToken } : {}),
        ...(credentials.tokenExpiresAt ? { tokenExpiresAt: credentials.tokenExpiresAt } : {}),
    };
    const nextFullConfig = {
        ...rawConfig,
        plugins: {
            ...plugins,
            entries: {
                ...entries,
                "brainfork-openclaw": {
                    ...pluginEntry,
                    config: updatedConfig,
                },
            },
        },
    };
    // Atomic write: write to temp file in same directory, then rename
    const dir = path.dirname(resolvedPath);
    await fs.mkdir(dir, { recursive: true });
    const tempPath = path.join(dir, `.openclaw.json.${process.pid}.${Date.now()}.tmp`);
    try {
        await fs.writeFile(tempPath, `${JSON.stringify(nextFullConfig, null, 2)}\n`, "utf8");
        if (process.platform !== "win32") {
            await fs.chmod(tempPath, 0o600);
        }
        await fs.rename(tempPath, resolvedPath);
    }
    catch (error) {
        // Clean up temp file on failure
        await fs.unlink(tempPath).catch(() => undefined);
        throw error;
    }
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
//# sourceMappingURL=token-refresh.js.map