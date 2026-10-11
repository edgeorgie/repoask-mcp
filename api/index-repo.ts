/**
 * Human-facing REST route: POST /api/index-repo { owner, repo, ref? }
 * Calls doIndexRepo from src/engine.ts — the EXACT same function the MCP
 * tool `index_repo` calls (src/create-server.ts). No reimplementation.
 *
 * COST/ABUSE POSTURE: no LLM call happens here, but indexing is the
 * expensive half of the work — it fetches up to MAX_FILES blobs of a
 * caller-chosen repository from GitHub (src/repo.ts) and builds a TF-IDF
 * index, and it is what populates the cache a later /api/ask-repo call feeds
 * into a billed prompt. So it is rate limited on the same buckets as the ask
 * route. See src/rate-limit.ts.
 *
 * ANALYTICS: same contract as api/ask-repo.ts: awaited before the response
 * is written, never the cause of a failed request, a no-op without
 * POSTHOG_KEY. Reports the public repo and the size of the index it built.
 */

import type { VercelRequest, VercelResponse } from "../src/vercel-types.js";
import { doIndexRepo } from "../src/engine.js";
import { checkRateLimit, getClientId } from "../src/rate-limit.js";
import { capture, indexBuiltProperties } from "../src/analytics.js";

/** Same narrowed CORS policy as api/ask-repo.ts — see the full rationale there. */
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

  const callerId = getClientId(req as unknown as { headers: Record<string, unknown>; socket?: { remoteAddress?: string } });
  const limit = checkRateLimit(callerId);
  if (!limit.allowed) {
    await capture("rate_limited", { surface: "web", reason: limit.reason === "global" ? "global" : "per-caller" });
    res.setHeader("Retry-After", String(limit.retryAfterSeconds ?? 60));
    res.status(429).json({
      error: `Rate limit exceeded (${limit.reason === "global" ? "global" : "per-caller"} limit). Retry after ${limit.retryAfterSeconds}s.`,
    });
    return;
  }

  try {
    const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) ?? {};
    const { owner, repo, ref } = body as { owner?: string; repo?: string; ref?: string };
    if (!owner || !repo) {
      res.status(400).json({ error: "owner and repo are required." });
      return;
    }
    const startedAt = Date.now();
    const result = await doIndexRepo(owner.trim(), repo.trim(), ref?.trim() || undefined);
    await capture(
      "index_built",
      indexBuiltProperties("web", result.owner, result.repo, result.chunkCount, Date.now() - startedAt),
    );
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
