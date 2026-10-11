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
import { tokenize, type TfidfModel } from "@edgeorgie/retrieval-core";

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

/** Same once-per-process discipline for the stale-index notice. */
let staleWarned = false;

export function keyOf(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function cacheFile(key: string): string {
  return path.join(CACHE_DIR, `${key.replace("/", "__")}.json`);
}

/**
 * Fingerprint of the tokenizer that built a persisted index.
 *
 * A persisted index embeds `vocab` and `idf` — both derived entirely from
 * `tokenize()` in `@edgeorgie/retrieval-core`. When that dependency's
 * tokenizer changes, a cached index keeps the OLD vocabulary forever: the
 * loader has no way to notice, every repo-level check stays green, and live
 * retrieval silently runs on a vocabulary the current code would never
 * produce. That is exactly what happened across two consecutive dependency
 * bumps (camelCase splitting, then sub-token stopword filtering), where the
 * only recovery was an operator remembering to re-POST every indexed repo.
 *
 * Rather than a hand-maintained version constant — which drifts the first time
 * someone bumps the dependency and forgets to bump the number — this derives
 * the fingerprint BEHAVIOURALLY, by running the real tokenizer over a probe
 * string chosen to exercise every branch that has changed historically:
 * camelCase splitting, consecutive capitals, snake_case, and stopword
 * filtering on both the whole-token and sub-token paths. Any change to
 * tokenization observable on those paths changes this string, and every
 * persisted index built by the old behaviour is discarded and rebuilt
 * automatically on next access.
 *
 * Cost is one `tokenize()` call per process, at module load.
 */
const TOKENIZER_PROBE = "getUserName HTTPServer of_the_thing toString isValid";
const TOKENIZER_FINGERPRINT = tokenize(TOKENIZER_PROBE).join(",");

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
  /**
   * Optional because indexes persisted before this field existed have no value
   * for it. A missing fingerprint cannot match the current one, so those are
   * treated as stale and rebuilt — which is the correct outcome: they were
   * written by the tokenizer this field exists to detect changes in.
   */
  tokenizerFingerprint?: string;
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
    tokenizerFingerprint: TOKENIZER_FINGERPRINT,
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
    if (s.tokenizerFingerprint !== TOKENIZER_FINGERPRINT) {
      // The persisted vocab/idf were built by a different tokenizer, so every
      // query vector this process produces would be scored against a
      // vocabulary that no longer matches how text is tokenized. Returning
      // null makes the caller re-index from GitHub, which is the only correct
      // recovery — serving the stale index would silently degrade retrieval
      // with nothing anywhere reporting a problem. Deleting the file would be
      // equivalent but loses forensic information for no benefit; it is
      // overwritten by the rebuild anyway.
      if (!staleWarned) {
        staleWarned = true;
        console.warn(
          `[store] discarding cached indexes built by a different tokenizer ` +
            `(cached ${JSON.stringify(s.tokenizerFingerprint ?? null)}, current ` +
            `${JSON.stringify(TOKENIZER_FINGERPRINT)}); affected repos re-index on next access.`,
        );
      }
      return null;
    }
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
