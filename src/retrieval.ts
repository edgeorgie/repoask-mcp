/**
 * Core retrieval: given an already-built RepoIndex and a question, embeds the question
 * with the SAME fitted TF-IDF model, scores every chunk, diversifies across files, and
 * returns the top chunks with their citations. Scoring (embedTfidf/topK/diversify) comes
 * from @edgeorgie/retrieval-core, shared verbatim with ask-edgeorgie-mcp.
 */

import type { RepoIndex } from "./indexer.js";
import { embedTfidf, topK, diversify, type Scored, type Chunk } from "@edgeorgie/retrieval-core";

export interface Citation {
  rank: number;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  excerpt: string;
}

export function retrieve(index: RepoIndex, question: string, k = 6): Citation[] {
  const q = embedTfidf(question, index.model);
  const scored: Scored[] = topK(q, index.vectors, Math.max(k * 3, 12));
  const diversified = diversify(scored, (i) => index.chunks[i].path, 3).slice(0, k);
  return diversified.map((s, rank) => {
    const c: Chunk = index.chunks[s.index];
    return {
      rank: rank + 1,
      path: c.path,
      startLine: c.start,
      endLine: c.end,
      score: Math.round(s.score * 1000) / 1000,
      excerpt: c.text,
    };
  });
}
