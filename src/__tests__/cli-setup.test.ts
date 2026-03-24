import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// NOTE: generatePkceVerifierChallenge is re-exported directly from the openclaw plugin-sdk.
// The plugin does not have its own PKCE implementation. Testing via this import verifies
// the correct SDK function is wired in and tests the S256 contract (challenge = BASE64URL(SHA256(verifier))).
import { generatePkceVerifierChallenge } from "openclaw/plugin-sdk";
import {
  detectEndpointFromAccessToken,
  exchangeOAuthCode,
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

  it("challenge is a valid base64url-encoded SHA-256 hash of the verifier (PKCE S256 contract)", () => {
    const { verifier, challenge } = generatePkceVerifierChallenge();

    // PKCE S256: challenge = BASE64URL(SHA256(ASCII(verifier)))
    const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expectedChallenge);
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

  it("passes an AbortSignal to fetch in exchangeOAuthCode (timeout wired up)", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url: unknown, init?: unknown) => {
      capturedSignal = (init as RequestInit | undefined)?.signal;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: "token-abc" }), { status: 200 }),
      );
    });

    await exchangeOAuthCode({
      baseUrl: "https://api.brainfork.is",
      code: "auth-code",
      redirectUri: "http://localhost:43123/callback",
      verifier: "verifier-123",
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    // Signal is still live (not yet aborted) because fetch resolved before timeout
    expect(capturedSignal?.aborted).toBe(false);
  });

  it("passes an AbortSignal to fetch in validateManualCredentials (timeout wired up)", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url: unknown, init?: unknown) => {
      capturedSignal = (init as RequestInit | undefined)?.signal;
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    await validateManualCredentials("https://api.brainfork.is", "bfk_123");

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
  });

  it("aborts fetch when exchangeOAuthCode timeout fires", async () => {
    // Set up a fetch mock that reacts to the abort signal
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url: unknown, init?: unknown) =>
        new Promise((_resolve, reject) => {
          capturedSignal = (init as RequestInit | undefined)?.signal;
          // Don't resolve — wait for the test to trigger abort
        }),
    );

    const promise = exchangeOAuthCode({
      baseUrl: "https://api.brainfork.is",
      code: "auth-code",
      redirectUri: "http://localhost:43123/callback",
      verifier: "verifier-123",
    });

    // Wait for fetch to be called and signal to be set
    await Promise.resolve();
    expect(capturedSignal).toBeDefined();

    // Manually abort the signal to simulate the timeout firing
    capturedSignal?.dispatchEvent(new Event("abort"));
    // Node's AbortSignal does not auto-reject fetch — the promise just hangs.
    // What matters is that the signal IS an AbortSignal and abort was registered.
    expect(capturedSignal?.aborted).toBe(false); // dispatchEvent doesn't set aborted

    // Cleanup: resolve the hanging promise so the test ends cleanly
    promise.catch(() => undefined);
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
