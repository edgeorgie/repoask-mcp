/**
 * Shared engine: the exact index_repo / ask_repo implementations used by both
 * the MCP tool handlers (src/create-server.ts) and the human-facing REST API
 * routes (api/index-repo.ts, api/ask-repo.ts). Neither caller re-implements
 * any retrieval/indexing logic — both call these two functions, so the MCP
 * server and the web UI are provably the same engine, not a parallel copy.
 */

import { indexRepo } from "./indexer.js";
import { retrieve } from "./retrieval.js";
import { saveIndex, loadIndex, keyOf, listIndexed } from "./store.js";
import { synthesize, deterministicAnswer } from "./llm.js";

export interface IndexRepoResult {
  owner: string;
  repo: string;
  branch: string;
  fileCount: number;
  chunkCount: number;
  truncated: boolean;
  indexedAt: string;
}

export async function doIndexRepo(owner: string, repo: string, ref?: string): Promise<IndexRepoResult> {
  const index = await indexRepo({ owner, repo, ref });
  const key = keyOf(owner, repo);
  await saveIndex(key, index);
  return {
    owner,
    repo,
    branch: index.branch,
    fileCount: index.fileCount,
    chunkCount: index.chunkCount,
    truncated: index.truncated,
    indexedAt: index.indexedAt,
  };
}

export interface Citation {
  rank: number;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  excerpt: string;
}

export interface AskRepoResult {
  owner: string;
  repo: string;
  question: string;
  answer: string;
  answerMode: "llm" | "deterministic";
  model?: string;
  citations: Citation[];
}

export async function doAskRepo(
  owner: string,
  repo: string,
  question: string,
  topK?: number,
): Promise<AskRepoResult> {
  const key = keyOf(owner, repo);
  let index = await loadIndex(key);
  if (!index) {
    index = await indexRepo({ owner, repo });
    await saveIndex(key, index);
  }
  const citations = retrieve(index, question, topK ?? 6);
  const repoLabel = `${owner}/${repo}`;
  const chunksForPrompt = citations.map((c) => ({ path: c.path, start: c.startLine, end: c.endLine, text: c.excerpt }));

  let answer: string;
  let answerMode: "llm" | "deterministic";
  let model: string | undefined;
  try {
    const synth = await synthesize(question, repoLabel, chunksForPrompt);
    if (synth) {
      answer = synth.answer;
      answerMode = "llm";
      model = synth.model;
    } else {
      answer = deterministicAnswer(chunksForPrompt);
      answerMode = "deterministic";
    }
  } catch (err) {
    answer = `LLM synthesis failed (${(err as Error).message}); falling back to citations.\n\n${deterministicAnswer(chunksForPrompt)}`;
    answerMode = "deterministic";
  }

  return { owner, repo, question, answer, answerMode, model, citations };
}

export function doListIndexedRepos(): string[] {
  return listIndexed();
}
