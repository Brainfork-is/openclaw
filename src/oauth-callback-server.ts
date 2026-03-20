import http from "node:http";

const DEFAULT_TIMEOUT_MS = 120_000;

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Authentication Complete</title>
  <style>
    body { font-family: sans-serif; max-width: 500px; margin: 80px auto; text-align: center; color: #333; }
    h1 { color: #2d6a4f; }
  </style>
</head>
<body>
  <h1>Authentication Complete</h1>
  <p>You can close this window and return to your terminal.</p>
</body>
</html>`;

export type OAuthCallbackServer = {
  server: http.Server;
  port: number;
  codePromise: Promise<string>;
};

export function startOAuthCallbackServer(
  expectedState: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<OAuthCallbackServer> {
  return new Promise((resolveServer, rejectServer) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let resolveCode: ((code: string) => void) | undefined;
    let rejectCode: ((error: Error) => void) | undefined;

    const settleCode = (kind: "resolve" | "reject", value: string | Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (kind === "resolve") {
        resolveCode?.(value as string);
      } else {
        rejectCode?.(value as Error);
      }
    };

    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    void codePromise.catch(() => undefined);

    const server = http.createServer((req, res) => {
      const rawUrl = req.url ?? "/";
      let parsed: URL;
      try {
        parsed = new URL(rawUrl, "http://localhost");
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad request");
        return;
      }

      if (parsed.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const code = parsed.searchParams.get("code");
      const state = parsed.searchParams.get("state");

      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Error: state mismatch — possible CSRF</h1></body></html>");
        settleCode("reject", new Error("OAuth state mismatch — possible CSRF attack"));
        void new Promise<void>((resolve) => server.close(() => resolve()));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Error: missing authorization code</h1></body></html>");
        settleCode("reject", new Error("Missing authorization code in callback"));
        void new Promise<void>((resolve) => server.close(() => resolve()));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(SUCCESS_HTML);
      settleCode("resolve", code);
    });

    server.once("error", (error) => {
      if (!settled) {
        rejectServer(error);
      } else {
        settleCode("reject", error as Error);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectServer(new Error("Failed to bind OAuth callback server"));
        return;
      }

      timeout = setTimeout(() => {
        settleCode("reject", new Error("Authentication timed out. Try manual setup instead."));
        void new Promise<void>((resolve) => server.close(() => resolve()));
      }, timeoutMs);
      timeout.unref?.();

      resolveServer({
        server,
        port: address.port,
        codePromise,
      });
    });
  });
}
