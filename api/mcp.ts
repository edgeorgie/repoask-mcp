/**
 * Vercel serverless function entrypoint: wraps the same Streamable HTTP MCP
 * handler used by src/http-server.ts (createApp/handleMcpRequest) so the
 * identical tool set (index_repo, ask_repo, list_indexed_repos, built from
 * src/create-server.ts) is reachable at https://<deployment>.vercel.app/api/mcp
 * over the internet, not just locally.
 *
 * Deliberately stateless (StreamableHTTPServerTransport with
 * sessionIdGenerator: undefined via handleMcpRequest) since Vercel serverless
 * functions are not guaranteed to reuse the same warm instance across
 * requests — see src/http-server.ts for the full rationale.
 *
 * vercel.json rewrites /mcp -> /api/mcp so the public URL path matches the
 * MCP convention (POST /mcp) documented in the README and used by
 * examples/run-http-session.ts.
 *
 * COST/ABUSE POSTURE: a tools/call for `ask_repo` through this endpoint
 * reaches the exact same doAskRepo (and therefore the same billed LLM path)
 * as POST /api/ask-repo, so it is rate limited on the same shared buckets.
 * See src/rate-limit.ts.
 */

import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";
import { handleMcpRequest } from "../src/http-server.js";
import { checkRateLimit, getClientId } from "../src/rate-limit.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === "GET") {
    res.status(200).json({
      name: "repoask-mcp",
      transport: "streamable-http",
      mcpEndpoint: "/mcp",
      status: "ok",
    });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed: use POST for MCP JSON-RPC calls." },
      id: null,
    });
    return;
  }

  // Rate limit before doing any real work. A tools/call for ask_repo here
  // triggers the same indexing + billed LLM synthesis as the REST route.
  const callerId = getClientId(req as unknown as { headers: Record<string, unknown>; socket?: { remoteAddress?: string } });
  const limit = checkRateLimit(callerId);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSeconds ?? 60));
    res.status(429).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: `Rate limit exceeded (${limit.reason === "global" ? "global" : "per-caller"} limit). Retry after ${limit.retryAfterSeconds}s.`,
      },
      id: null,
    });
    return;
  }

  try {
    // Vercel's VercelRequest/VercelResponse are structurally compatible with
    // Node's IncomingMessage/ServerResponse (what handleMcpRequest expects).
    await handleMcpRequest(req as unknown as any, res as unknown as any);
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
}
