/**
 * Human-facing REST route: POST /api/ask-repo { owner, repo, question, topK? }
 * Calls doAskRepo from src/engine.ts — the EXACT same function the MCP tool
 * `ask_repo` calls (src/create-server.ts). No reimplementation.
 *
 * COST/ABUSE POSTURE: this route is unauthenticated and, with an
 * ANTHROPIC_API_KEY configured on the deployment, every call bills the repo
 * owner's Anthropic account — and `owner`/`repo` are caller-chosen, so a
 * caller also controls how much repository content gets stuffed into the
 * prompt. It is therefore rate limited (src/rate-limit.ts) and question
 * length is capped, both checked before any indexing or LLM work happens.
 * See src/rate-limit.ts for the full rationale and known limitations.
 */

import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";
import { doAskRepo } from "../src/engine.js";
import { checkRateLimit, checkQuestionLength, getClientId } from "../src/rate-limit.js";

/**
 * CORS: narrowed from the previous `Access-Control-Allow-Origin: *`.
 *
 * The only browser that needs this route is the first-party web UI served
 * from this same deployment (public/index.html -> public/app.js), which uses
 * a same-origin relative fetch. A wildcard instead let any third-party page
 * silently drive this billable endpoint from its visitors' browsers —
 * spending the owner's Anthropic credit while spreading the per-caller
 * rate-limit buckets across every visitor's distinct IP, which defeats
 * per-caller limiting specifically.
 *
 * Non-browser callers (curl, agents, MCP clients — the documented primary
 * audience) are entirely unaffected, because CORS is enforced by browsers,
 * not servers: restricting it costs the documented use case nothing. So we
 * allow only this deployment's own origin plus localhost for development.
 */
const ALLOWED_ORIGINS = new Set(["https://repoask-mcp.vercel.app", "http://localhost:3000"]);

function applyCors(req: VercelRequest, res: VercelResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  // Rate limit before doing any work: indexing fetches a whole repo from
  // GitHub, and the answer path can make a real, billed LLM call.
  const callerId = getClientId(req as unknown as { headers: Record<string, unknown>; socket?: { remoteAddress?: string } });
  const limit = checkRateLimit(callerId);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSeconds ?? 60));
    res.status(429).json({
      error: `Rate limit exceeded (${limit.reason === "global" ? "global" : "per-caller"} limit). Retry after ${limit.retryAfterSeconds}s.`,
    });
    return;
  }

  try {
    const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) ?? {};
    const { owner, repo, question, topK } = body as {
      owner?: string;
      repo?: string;
      question?: string;
      topK?: number;
    };
    if (!owner || !repo || !question) {
      res.status(400).json({ error: "owner, repo, and question are required." });
      return;
    }
    const lengthCheck = checkQuestionLength(question);
    if (!lengthCheck.ok) {
      res.status(400).json({ error: lengthCheck.error });
      return;
    }
    const result = await doAskRepo(owner.trim(), repo.trim(), question.trim(), topK);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
