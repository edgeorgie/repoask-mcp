/**
 * Human-facing REST route: POST /api/ask-repo { owner, repo, question, topK? }
 * Calls doAskRepo from src/engine.ts — the EXACT same function the MCP tool
 * `ask_repo` calls (src/create-server.ts). No reimplementation.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { doAskRepo } from "../src/engine.js";

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
    const result = await doAskRepo(owner.trim(), repo.trim(), question.trim(), topK);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
