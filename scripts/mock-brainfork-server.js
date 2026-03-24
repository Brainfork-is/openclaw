#!/usr/bin/env node
// scripts/mock-brainfork-server.js
// Minimal Brainfork API mock server for the test harness.
// Usage: node mock-brainfork-server.js <port-file>
// Writes "PORT=XXXX" to <port-file> once the server is listening.

import http from "node:http";
import fs from "node:fs";

const portFile = process.argv[2];
if (!portFile) {
  console.error("Usage: node mock-brainfork-server.js <port-file>");
  process.exit(1);
}

let sessionCounter = 0;

function jsonRpcSuccess(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Health check endpoint
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "mock-brainfork" }));
    return;
  }

  // MCP endpoint — accept any POST path
  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON" }));
        return;
      }

      const incomingSession = req.headers["mcp-session-id"];
      const sessionId = incomingSession || `mock-session-${++sessionCounter}`;

      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", sessionId);

      const { method, id, params } = parsed;

      // MCP initialize
      if (method === "initialize") {
        res.writeHead(200);
        res.end(
          jsonRpcSuccess(id, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "mock-brainfork", version: "1.0.0" },
          }),
        );
        return;
      }

      // Notifications — no response body needed, just 200
      if (typeof method === "string" && method.startsWith("notifications/")) {
        res.writeHead(200);
        res.end("");
        return;
      }

      // tools/list
      if (method === "tools/list") {
        res.writeHead(200);
        res.end(
          jsonRpcSuccess(id, {
            tools: [
              { name: "push_document", description: "Push a document into Brainfork" },
              { name: "query", description: "Hybrid BM25 + vector search" },
              { name: "vsearch", description: "Vector semantic search" },
              { name: "search", description: "Keyword search" },
              { name: "fetch", description: "Fetch document by ID" },
              { name: "log_decision", description: "Log a durable decision" },
              { name: "get_decisions", description: "Query decision records" },
              { name: "archive_document", description: "Archive a document" },
              { name: "delete_document", description: "Delete a document" },
            ],
          }),
        );
        return;
      }

      // tools/call
      if (method === "tools/call") {
        const toolName = params?.name;
        const args = params?.arguments ?? {};

        if (toolName === "push_document") {
          const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          res.writeHead(200);
          res.end(
            jsonRpcSuccess(id, {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    id: docId,
                    externalId: args.externalId,
                    title: args.title ?? args.externalId,
                    status: "indexed",
                  }),
                },
              ],
            }),
          );
          return;
        }

        if (toolName === "archive_document" || toolName === "delete_document") {
          res.writeHead(200);
          res.end(
            jsonRpcSuccess(id, {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ status: "ok", externalId: args.externalId }),
                },
              ],
            }),
          );
          return;
        }

        if (toolName === "query" || toolName === "vsearch" || toolName === "search") {
          res.writeHead(200);
          res.end(
            jsonRpcSuccess(id, {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ results: [] }),
                },
              ],
            }),
          );
          return;
        }

        if (toolName === "log_decision") {
          res.writeHead(200);
          res.end(
            jsonRpcSuccess(id, {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ id: `decision-${Date.now()}`, status: "logged" }),
                },
              ],
            }),
          );
          return;
        }

        if (toolName === "get_decisions") {
          res.writeHead(200);
          res.end(
            jsonRpcSuccess(id, {
              content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
            }),
          );
          return;
        }

        // Unknown tool — return a generic success
        res.writeHead(200);
        res.end(
          jsonRpcSuccess(id, {
            content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }],
          }),
        );
        return;
      }

      // Unknown JSON-RPC method
      res.writeHead(200);
      res.end(jsonRpcError(id, -32601, `Method not found: ${method}`));
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  // Write port to the port file so the calling script can read it
  fs.writeFileSync(portFile, `${port}`);
  process.stderr.write(`[mock-brainfork-server] listening on http://127.0.0.1:${port}\n`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
