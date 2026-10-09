/**
 * RAG prompt construction, ported from edgeorgie/repoask (lib/rag.ts).
 * Builds numbered source excerpts with inline [n] citation markers.
 */

import type { Chunk } from "./chunk.js";

export const SYSTEM_PROMPT = `You answer questions about a GitHub repository using only the numbered source excerpts provided.
Rules:
- Ground every claim in the sources and cite them inline like [1] or [2][3].
- If the sources do not contain the answer, say so plainly and suggest which files to look at. Do not invent code or APIs.
- Be concise. Use short paragraphs and code blocks when useful.`;

export function buildPrompt(question: string, repo: string, chunks: Chunk[]): string {
  const sources = chunks
    .map((c, i) => `[${i + 1}] ${c.path} (lines ${c.start}-${c.end})\n${c.text}`)
    .join("\n\n---\n\n");
  return `Repository: ${repo}\n\nSources:\n${sources}\n\nQuestion: ${question}`;
}

export function citedIndexes(answer: string, max: number): number[] {
  const found = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= max) found.add(n - 1);
  }
  return [...found].sort((a, b) => a - b);
}
