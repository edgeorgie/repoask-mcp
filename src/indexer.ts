/**
 * Builds a RepoIndex: fetches a public GitHub repo's text files, chunks them into
 * overlapping line windows, and embeds every chunk with a TF-IDF model fitted on the
 * whole corpus. Chunking/embedding come from @edgeorgie/retrieval-core (shared with
 * ask-edgeorgie-mcp); this file owns the GitHub-fetch-specific indexing orchestration.
 */

import { chunkFile, embedText, fitTfidf, embedBatchTfidf, type Chunk, type TfidfModel, type Vector } from "@edgeorgie/retrieval-core";
import { fetchFileText, fetchRepoFiles, type RepoRef } from "./repo.js";

export interface RepoIndex {
  ref: RepoRef;
  branch: string;
  chunks: Chunk[];
  vectors: Vector[];
  model: TfidfModel;
  fileCount: number;
  chunkCount: number;
  truncated: boolean;
  indexedAt: string;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function indexRepo(ref: RepoRef): Promise<RepoIndex> {
  const { branch, files, truncated } = await fetchRepoFiles(ref);
  if (files.length === 0) throw new Error("No indexable text files were found in this repository.");

  const texts = await mapLimit(files, 8, async (f) => {
    try {
      return await fetchFileText(ref, branch, f.path);
    } catch {
      return "";
    }
  });

  const chunks: Chunk[] = files.flatMap((f, i) => chunkFile(f.path, texts[i]));
  if (chunks.length === 0) throw new Error("The files were empty or could not be downloaded.");

  const docs = chunks.map(embedText);
  const model = fitTfidf(docs);
  const vectors = embedBatchTfidf(docs, model);

  return {
    ref,
    branch,
    chunks,
    vectors,
    model,
    fileCount: files.length,
    chunkCount: chunks.length,
    truncated,
    indexedAt: new Date().toISOString(),
  };
}
