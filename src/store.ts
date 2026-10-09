/**
 * In-memory + on-disk index store, keyed by "owner/repo".
 * Persists to a JSON file (one per key) under .repoask-cache/ so a server restart
 * doesn't force a full re-index of previously-asked repos.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoIndex } from "./indexer.js";
import type { TfidfModel } from "./embedder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.REPOASK_CACHE_DIR ?? path.join(__dirname, "..", ".repoask-cache");

const memory = new Map<string, RepoIndex>();

export function keyOf(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function cacheFile(key: string): string {
  return path.join(CACHE_DIR, `${key.replace("/", "__")}.json`);
}

interface SerializedIndex {
  ref: RepoIndex["ref"];
  branch: string;
  chunks: RepoIndex["chunks"];
  vectors: number[][];
  vocab: [string, number][];
  idf: number[];
  fileCount: number;
  chunkCount: number;
  truncated: boolean;
  indexedAt: string;
}

export async function saveIndex(key: string, index: RepoIndex): Promise<void> {
  memory.set(key, index);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const serialized: SerializedIndex = {
    ref: index.ref,
    branch: index.branch,
    chunks: index.chunks,
    vectors: index.vectors.map((v) => Array.from(v)),
    vocab: Array.from(index.model.vocab.entries()),
    idf: Array.from(index.model.idf),
    fileCount: index.fileCount,
    chunkCount: index.chunkCount,
    truncated: index.truncated,
    indexedAt: index.indexedAt,
  };
  await fs.writeFile(cacheFile(key), JSON.stringify(serialized), "utf8");
}

export async function loadIndex(key: string): Promise<RepoIndex | null> {
  const hit = memory.get(key);
  if (hit) return hit;
  try {
    const raw = await fs.readFile(cacheFile(key), "utf8");
    const s = JSON.parse(raw) as SerializedIndex;
    const model: TfidfModel = { vocab: new Map(s.vocab), idf: Float32Array.from(s.idf) };
    const index: RepoIndex = {
      ref: s.ref,
      branch: s.branch,
      chunks: s.chunks,
      vectors: s.vectors.map((v) => Float32Array.from(v)),
      model,
      fileCount: s.fileCount,
      chunkCount: s.chunkCount,
      truncated: s.truncated,
      indexedAt: s.indexedAt,
    };
    memory.set(key, index);
    return index;
  } catch {
    return null;
  }
}

export function listIndexed(): string[] {
  return [...memory.keys()];
}
