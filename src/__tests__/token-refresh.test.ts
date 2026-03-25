import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isTokenExpiredOrExpiring,
  refreshAccessToken,
  persistRefreshedCredentials,
} from "../token-refresh.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brainfork-token-refresh-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("isTokenExpiredOrExpiring", () => {
  it("returns false when no expiry is set", () => {
    expect(isTokenExpiredOrExpiring(undefined)).toBe(false);
  });

  it("returns false for an invalid date string", () => {
    expect(isTokenExpiredOrExpiring("not-a-date")).toBe(false);
  });

  it("returns true when token is already expired", () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    expect(isTokenExpiredOrExpiring(pastDate)).toBe(true);
  });

  it("returns true when token expires within the 5-minute buffer", () => {
    const soonDate = new Date(Date.now() + 120_000).toISOString(); // 2 min from now
    expect(isTokenExpiredOrExpiring(soonDate)).toBe(true);
  });

  it("returns false when token has plenty of time left", () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour
    expect(isTokenExpiredOrExpiring(futureDate)).toBe(false);
  });
});

describe("refreshAccessToken", () => {
  it("exchanges a refresh token for new credentials", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await refreshAccessToken(
      "https://api.brainfork.is",
      "old-refresh-token",
      mockFetch as typeof fetch,
    );

    expect(result.access_token).toBe("new-access-token");
    expect(result.refresh_token).toBe("new-refresh-token");
    expect(result.expires_in).toBe(3600);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.brainfork.is/oauth/token",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("grant_type=refresh_token"),
      }),
    );
  });

  it("throws on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      refreshAccessToken("https://api.brainfork.is", "bad-token", mockFetch as typeof fetch),
    ).rejects.toThrow("Token refresh failed (400): Refresh token expired");
  });

  it("throws when access_token is missing from response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token_type: "bearer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      refreshAccessToken("https://api.brainfork.is", "token", mockFetch as typeof fetch),
    ).rejects.toThrow("access_token was missing");
  });

  it("throws on non-JSON response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    await expect(
      refreshAccessToken("https://api.brainfork.is", "token", mockFetch as typeof fetch),
    ).rejects.toThrow("non-JSON response");
  });
});

describe("persistRefreshedCredentials", () => {
  it("writes new credentials to a fresh config file", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "openclaw.json");

    await persistRefreshedCredentials(
      {
        apiKey: "new-access-token",
        refreshToken: "new-refresh-token",
        tokenExpiresAt: "2026-01-01T00:00:00.000Z",
      },
      configPath,
    );

    const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, any>;
    const pluginConfig = saved.plugins.entries["brainfork-openclaw"].config;
    expect(pluginConfig.apiKey).toBe("new-access-token");
    expect(pluginConfig.refreshToken).toBe("new-refresh-token");
    expect(pluginConfig.tokenExpiresAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("preserves existing config fields when updating credentials", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "openclaw.json");

    // Write initial config with extra fields
    await fs.writeFile(
      configPath,
      JSON.stringify({
        someOtherSetting: true,
        plugins: {
          entries: {
            "brainfork-openclaw": {
              enabled: true,
              config: {
                baseUrl: "https://api.brainfork.is",
                endpoint: "my-workspace",
                apiKey: "old-token",
                autoRecall: true,
              },
            },
          },
        },
      }),
    );

    await persistRefreshedCredentials(
      {
        apiKey: "refreshed-token",
        refreshToken: "new-rt",
        tokenExpiresAt: "2026-06-01T00:00:00.000Z",
      },
      configPath,
    );

    const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, any>;
    expect(saved.someOtherSetting).toBe(true);
    const pluginConfig = saved.plugins.entries["brainfork-openclaw"].config;
    expect(pluginConfig.baseUrl).toBe("https://api.brainfork.is");
    expect(pluginConfig.endpoint).toBe("my-workspace");
    expect(pluginConfig.autoRecall).toBe(true);
    expect(pluginConfig.apiKey).toBe("refreshed-token");
    expect(pluginConfig.refreshToken).toBe("new-rt");
  });

  it("uses atomic write (file permissions are 0o600 on unix)", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "openclaw.json");

    await persistRefreshedCredentials({ apiKey: "tok" }, configPath);

    if (process.platform !== "win32") {
      const stat = await fs.stat(configPath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});
