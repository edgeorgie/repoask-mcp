/**
 * Human-facing REST route: POST /api/index-repo { owner, repo, ref? }
 * Calls doIndexRepo from src/engine.ts — the EXACT same function the MCP
 * tool `index_repo` calls (src/create-server.ts). No reimplementation.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { doIndexRepo } from "../src/engine.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }
  try {
    const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) ?? {};
    const { owner, repo, ref } = body as { owner?: string; repo?: string; ref?: string };
    if (!owner || !repo) {
      res.status(400).json({ error: "owner and repo are required." });
      return;
    }
    const result = await doIndexRepo(owner.trim(), repo.trim(), ref?.trim() || undefined);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
