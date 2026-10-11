/**
 * Tests for the index cache's two serverless-survival properties (src/store.ts).
 *
 * Both of these were REAL production defects, not hypotheticals: every preview
 * deployment of this service returned
 *   500 {"error":"ENOENT: no such file or directory, mkdir '/var/task/.repoask-cache'"}
 * on /api/index-repo and on any /api/ask-repo for a not-yet-indexed repo, because
 * the cache directory defaulted to a path inside the read-only lambda bundle. The
 * production alias only worked because a REPOASK_CACHE_DIR env var happened to be
 * set for the production target alone, which also made promoting a preview build by
 * alias (the standard zero-rebuild workaround for a deploy rate limit) unsafe.
 *
 * So the properties asserted here are:
 *   1. resolveCacheDir() picks a WRITABLE default under a serverless runtime.
 *   2. saveIndex() does not reject when the cache is unwritable — the index it just
 *      built is still served from memory, because persistence is only a cache.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { resolveCacheDir, saveIndex, loadIndex, keyOf } from "../src/store.js";
import type { RepoIndex } from "../src/indexer.js";

/** Minimal but structurally real index, so saveIndex serializes the same shape as production. */
function fixtureIndex(): RepoIndex {
  return {
    ref: { owner: "edgeorgie", repo: "repoask-mcp" },
    branch: "main",
    chunks: [{ path: "src/a.ts", start: 1, end: 2, text: "export const a = 1;" }],
    vectors: [Float32Array.from([0.5, 0.25])],
    model: { vocab: new Map([["export", 0], ["const", 1]]), idf: Float32Array.from([1.1, 2.2]) },
    fileCount: 1,
    chunkCount: 1,
    truncated: false,
    indexedAt: new Date().toISOString(),
  };
}

test("resolveCacheDir honours an explicit REPOASK_CACHE_DIR above everything else", () => {
  assert.equal(
    resolveCacheDir({ REPOASK_CACHE_DIR: "/custom/cache", VERCEL: "1" }),
    "/custom/cache",
  );
});

test("resolveCacheDir defaults to a writable /tmp path on Vercel", () => {
  // The bug: this used to resolve inside the bundle (/var/task/...), which is read-only.
  const dir = resolveCacheDir({ VERCEL: "1" });
  assert.equal(dir, path.join("/tmp", ".repoask-cache"));
  assert.ok(!dir.includes("/var/task"), "must not default into the read-only lambda bundle");
});

test("resolveCacheDir defaults to a writable /tmp path on bare AWS Lambda", () => {
  assert.equal(
    resolveCacheDir({ AWS_LAMBDA_FUNCTION_NAME: "repoask" }),
    path.join("/tmp", ".repoask-cache"),
  );
});

test("resolveCacheDir stays repo-local when not serverless, so local runs keep a durable cache", () => {
  const dir = resolveCacheDir({});
  assert.ok(dir.endsWith(".repoask-cache"));
  assert.ok(!dir.startsWith("/tmp"), `expected a repo-local path, got ${dir}`);
});

test("saveIndex persists and loadIndex round-trips through a real file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repoask-store-"));
  const prev = process.env.REPOASK_CACHE_DIR;
  process.env.REPOASK_CACHE_DIR = dir;
  try {
    // Re-import under the env var: CACHE_DIR is resolved at module load.
    const mod = await import(`../src/store.js?writable=${Date.now()}`);
    const key = mod.keyOf("edgeorgie", "repoask-mcp");
    await mod.saveIndex(key, fixtureIndex());
    const files = await fs.readdir(dir);
    assert.deepEqual(files, ["edgeorgie__repoask-mcp.json"], "expected exactly one cache file");
    const loaded = await mod.loadIndex(key);
    assert.ok(loaded, "index should load back");
    assert.equal(loaded.branch, "main");
    assert.equal(loaded.model.vocab.get("export"), 0);
    assert.ok(loaded.vectors[0] instanceof Float32Array, "vectors must rehydrate as Float32Array");
  } finally {
    if (prev === undefined) delete process.env.REPOASK_CACHE_DIR;
    else process.env.REPOASK_CACHE_DIR = prev;
  }
});

test("saveIndex does NOT reject when the cache directory is unwritable, and the index is still served from memory", async () => {
  // Point the cache at a path under a regular FILE. mkdir -p must fail with ENOTDIR/ENOENT,
  // which is the same class of failure as mkdir under a read-only /var/task.
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "repoask-unwritable-"));
  const blocker = path.join(base, "not-a-dir");
  await fs.writeFile(blocker, "regular file", "utf8");
  const unwritable = path.join(blocker, "cache");

  const prev = process.env.REPOASK_CACHE_DIR;
  process.env.REPOASK_CACHE_DIR = unwritable;
  try {
    const mod = await import(`../src/store.js?unwritable=${Date.now()}`);
    const key = mod.keyOf("edgeorgie", "retrieval-core");
    // The regression: this used to reject, which surfaced to the caller as HTTP 500.
    await assert.doesNotReject(
      () => mod.saveIndex(key, fixtureIndex()),
      "a failed cache write must not fail the request that built the index",
    );
    // And the whole point: the index is still usable.
    const loaded = await mod.loadIndex(key);
    assert.ok(loaded, "index must still be served from memory when the disk cache is unavailable");
    assert.equal(loaded.chunkCount, 1);
  } finally {
    if (prev === undefined) delete process.env.REPOASK_CACHE_DIR;
    else process.env.REPOASK_CACHE_DIR = prev;
  }
});

test("loadIndex returns null (not a throw) for a repo that was never indexed", async () => {
  const missing = await loadIndex(keyOf("nobody", "never-indexed-" + Date.now()));
  assert.equal(missing, null);
});
