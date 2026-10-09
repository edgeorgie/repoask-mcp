#!/usr/bin/env node
/**
 * repoask-mcp — Streamable HTTP transport (MCP spec 2025-03-26+).
 *
 * This is the REMOTE entrypoint: it exposes the exact same tools as the stdio
 * server (server.ts) — index_repo, ask_repo, list_indexed_repos, built via the
 * single shared factory in create-server.ts — over HTTP so any MCP client on
 * the network (not just a local subprocess) can connect.
 *
 * Runs in STATELESS mode (sessionIdGenerator: undefined): each HTTP POST gets
 * a fresh McpServer + transport pair, request-scoped. This is deliberate, not
 * a shortcut — serverless platforms (Vercel functions) don't guarantee two
 * requests from the same "session" land on the same warm instance/process, so
 * stateful in-memory session tracking (the SDK's default stateful mode) would
 * silently break across cold starts/instances. Stateless mode is the documented
 * pattern for exactly this deployment shape. The index cache itself still
 * persists across requests within one running instance (see store.ts), so
 * index_repo -> ask_repo works normally within a warm instance/session.
 *
 * Usage:
 *   node dist/http-server.js            # listens on PORT (default 3000), path /mcp
 *
 * Used directly by:
 *   - api/mcp.ts (Vercel serverless function wrapper, same handler)
 *   - any standalone Node host (Railway/Render/Fly/local) via `npm run start:http`
 */

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRepoaskServer } from "./create-server.js";

export async function handleMcpRequest(req: express.Request, res: express.Response): Promise<void> {
  // Stateless: a new server + transport per request, per SDK's documented
  // stateless pattern (sessionIdGenerator: undefined -> no session ID is
  // issued or required, so it plays correctly with serverless cold starts).
  const server = createRepoaskServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  // Health check for uptime monitors / quick curl verification.
  app.get("/", (_req, res) => {
    res.json({
      name: "repoask-mcp",
      transport: "streamable-http",
      mcpEndpoint: "/mcp",
      status: "ok",
    });
  });

  // MCP Streamable HTTP spec: POST for client->server JSON-RPC calls.
  app.post("/mcp", async (req, res) => {
    try {
      await handleMcpRequest(req, res);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode serves no server-initiated GET/DELETE session semantics —
  // respond 405 per the spec's guidance for servers that don't support them.
  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed: this server is stateless (no GET/SSE stream)." },
      id: null,
    });
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed: this server is stateless (no sessions to delete)." },
      id: null,
    });
  });

  return app;
}

// Only start a listener when run directly (not when imported by api/mcp.ts
// for Vercel's serverless function wrapper).
const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`repoask-mcp Streamable HTTP server listening on :${port} (POST /mcp)`);
  });
}
