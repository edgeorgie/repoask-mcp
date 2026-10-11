/**
 * In-memory + on-disk index store, keyed by "owner/repo".
 * Persists to a JSON file (one per key) under .repoask-cache/ so a server restart
 * doesn't force a full re-index of previously-asked repos.
 *
 * The on-disk half is a CACHE, not the source of truth: the in-memory map is
 * authoritative for the life of the process, and a repo can always be re-indexed
 * from GitHub. Two consequences are deliberate and load-bearing here:
 *
 * 1. The default directory must be writable on a read-only serverless filesystem.
 *    A bundled lambda's code lives under a read-only root (`/var/task` on
 *    Vercel/AWS), so the previous `__dirname/../.repoask-cache` default made
 *    `fs.mkdir` throw ENOENT on EVERY deployment that did not set
 *    REPOASK_CACHE_DIR explicitly. `/tmp` is the only writable path in that
 *    sandbox, so it is the default when a serverless runtime is detected.
 * 2. A cache write failing must not fail the caller's request. Indexing succeeded;
 *    only the optional persistence step did not. Previously the rejection
 *    propagated out of `doIndexRepo`/`doAskRepo` and surfaced as a 500 on
 *    /api/index-repo and /api/ask-repo, i.e. a cache-layer problem presented to
 *    the user as the whole service being broken.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoIndex } from "./indexer.js";
import type { TfidfModel } from "@edgeorgie/retrieval-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the cache directory. Exported for tests so the serverless-default
 * behaviour is assertable without deploying.
 *
 * `VERCEL` is set by Vercel's runtime; `AWS_LAMBDA_FUNCTION_NAME` is set by Lambda
 * (which Vercel's Node runtime is built on) and by other FaaS providers. Either
 * means the code directory is read-only and `/tmp` is the only writable path.
 */
export function resolveCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.REPOASK_CACHE_DIR) return env.REPOASK_CACHE_DIR;
  if (env.VERCEL ?? env.AWS_LAMBDA_FUNCTION_NAME) return path.join("/tmp", ".repoask-cache");
  return path.join(__dirname, "..", ".repoask-cache");
}

const CACHE_DIR = resolveCacheDir();

const memory = new Map<string, RepoIndex>();

/** Warn once per process rather than on every write, so logs stay readable. */
let persistWarned = false;

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
  // In-memory first and unconditionally: this is the authoritative copy, and it must
  // be set even if the disk cache is unavailable.
  memory.set(key, index);
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
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(cacheFile(key), JSON.stringify(serialized), "utf8");
  } catch (err) {
    // Persistence is best-effort. A read-only or full filesystem costs a re-index on
    // the next cold start; it does not make the index that was just built unusable,
    // so it must not turn the caller's successful request into an error.
    if (!persistWarned) {
      persistWarned = true;
      console.warn(
        `[store] index cache disabled: cannot write ${CACHE_DIR} (${(err as Error).message}). ` +
          `Serving from memory; set REPOASK_CACHE_DIR to a writable path to re-enable persistence.`,
      );
    }
  }
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
