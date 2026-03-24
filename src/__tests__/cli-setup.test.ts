import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePkceVerifierChallenge } from "openclaw/plugin-sdk";
import {
  detectEndpointFromAccessToken,
  exchangeOAuthCode,
  validateEndpoint,
  validateManualCredentials,
  writeBrainforkPluginConfig,
} from "../cli-setup.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brainfork-openclaw-cli-setup-"));
  tempDirs.push(dir);
  return dir;
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("cli setup helpers", () => {
  it("generates PKCE verifier and challenge strings", () => {
    const { verifier, challenge } = generatePkceVerifierChallenge();

    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge.length).toBeGreaterThanOrEqual(43);
  });

  it("detects endpoint candidates from token claims", () => {
    const token = makeJwt({ endpoint: "my-workspace" });
    expect(detectEndpointFromAccessToken(token)).toBe("my-workspace");
  });

  it("writes plugin config to plugins.entries.brainfork-openclaw.config", async () => {
    const dir = await makeTempDir();
    const configPath = path.join(dir, "openclaw.json");

    await writeBrainforkPluginConfig(configPath, {
      baseUrl: "https://api.brainfork.is",
      endpoint: "workspace-a",
      apiKey: "bfk_123",
    });

    const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, any>;
    expect(saved.plugins.entries["brainfork-openclaw"]).toMatchObject({
      enabled: true,
      config: {
        baseUrl: "https://api.brainfork.is",
        endpoint: "workspace-a",
        apiKey: "bfk_123",
      },
    });
  });

  it("validates manual credentials with a health request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    await expect(validateManualCredentials("https://api.brainfork.is", "bfk_123")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.brainfork.is/health",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "ApiKey bfk_123",
        }),
      }),
    );
  });

  it("validateEndpoint throws when the server returns a non-OK status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    await expect(
      validateEndpoint("https://api.brainfork.is", "my-workspace", "bfk_123"),
    ).rejects.toThrow("Endpoint 'my-workspace' is not accessible (404)");
  });

  it("validateEndpoint throws when the server returns invalid JSON-RPC", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: "something unexpected" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      validateEndpoint("https://api.brainfork.is", "my-workspace", "bfk_123"),
    ).rejects.toThrow("did not return a valid JSON-RPC response");
  });

  it("exchanges an OAuth code for tokens", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        access_token: "token-abc",
        refresh_token: "refresh-abc",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await exchangeOAuthCode({
      baseUrl: "https://api.brainfork.is",
      code: "auth-code",
      redirectUri: "http://localhost:43123/callback",
      verifier: "verifier-123",
    });

    expect(response.access_token).toBe("token-abc");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.brainfork.is/oauth/token",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("grant_type=authorization_code"),
      }),
    );
  });
});
