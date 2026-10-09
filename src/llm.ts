/**
 * Optional LLM answer synthesis. If ANTHROPIC_API_KEY or OPENAI_API_KEY is set in the
 * environment, the retrieved chunks are sent to a cheap model to write a prose answer
 * with inline [n] citations. If neither key is present, `synthesize` returns null and
 * the caller falls back to a deterministic, citation-only answer built straight from
 * the top-matching chunks (same "no key required" contract as repoask and triage-desk).
 */

import { SYSTEM_PROMPT, buildPrompt } from "./rag.js";
import type { Chunk } from "./chunk.js";

export interface SynthesisResult {
  answer: string;
  provider: "anthropic" | "openai";
  model: string;
}

export async function synthesize(question: string, repoLabel: string, chunks: Chunk[]): Promise<SynthesisResult | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const prompt = buildPrompt(question, repoLabel, chunks);

  if (anthropicKey) {
    const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    const answer = data.content.find((b) => b.type === "text")?.text ?? "";
    return { answer, provider: "anthropic", model };
  }

  if (openaiKey) {
    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 700,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const answer = data.choices[0]?.message?.content ?? "";
    return { answer, provider: "openai", model };
  }

  return null;
}

/** Deterministic fallback used when no LLM key is configured: just the cited chunks, no generation. */
export function deterministicAnswer(chunks: Chunk[]): string {
  if (chunks.length === 0) {
    return "No sufficiently similar chunks were found in the index for this question.";
  }
  const lines = chunks.map(
    (c, i) => `[${i + 1}] ${c.path} (lines ${c.start}-${c.end}):\n${c.text.split("\n").slice(0, 8).join("\n")}`,
  );
  return (
    "No LLM key configured (ANTHROPIC_API_KEY / OPENAI_API_KEY) — returning the top-matching source excerpts " +
    "directly with their citations. Read the cited file+line ranges to answer the question yourself, " +
    "or set an LLM key for prose synthesis.\n\n" +
    lines.join("\n\n---\n\n")
  );
}
