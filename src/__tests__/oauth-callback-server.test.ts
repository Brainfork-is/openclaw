import { afterEach, describe, expect, it } from "vitest";
import { startOAuthCallbackServer } from "../oauth-callback-server.js";

const servers: Array<{ close: () => void }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) {
      continue;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("startOAuthCallbackServer", () => {
  it("returns the authorization code for a valid callback", async () => {
    const { server, port, codePromise } = await startOAuthCallbackServer("expected-state", 5_000);
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=expected-state`);
    const body = await response.text();

    await expect(codePromise).resolves.toBe("test-code");
    expect(response.status).toBe(200);
    expect(body).toContain("Authentication Complete");
  });

  it("rejects invalid state values", async () => {
    const { server, port, codePromise } = await startOAuthCallbackServer("expected-state", 5_000);
    servers.push(server);
    const rejection = expect(codePromise).rejects.toThrow(/state mismatch/i);

    const response = await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=wrong-state`);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("state mismatch");
    await rejection;
  });

  it("times out when no callback arrives", async () => {
    const { server, codePromise } = await startOAuthCallbackServer("expected-state", 100);
    servers.push(server);

    await expect(codePromise).rejects.toThrow(/manual setup instead/i);
  });
});
