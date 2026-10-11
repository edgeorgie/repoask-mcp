/**
 * Two properties this repo had no sensor for, both found by a cold-read critic
 * pass over the `@edgeorgie/retrieval-core` stopword bump (PR #12):
 *
 *   1. A persisted index built by a DIFFERENT tokenizer must not be served.
 *      `vocab` and `idf` are derived entirely from the dependency's
 *      `tokenize()`. Before the fingerprint gate, two consecutive tokenizer
 *      bumps (camelCase splitting, then sub-token stopword filtering) left
 *      every already-indexed repo scoring queries against a vocabulary the
 *      running code would never produce — invisible to CI, to the repo, and to
 *      any live-site check, recoverable only by an operator remembering to
 *      re-POST each repo to /api/index-repo.
 *
 *   2. The tokenizer behaviour this service depends on must be asserted HERE,
 *      not only upstream. The mutation that proves the gap: restoring the
 *      pre-fix unfiltered sub-token push inside
 *      node_modules/@edgeorgie/retrieval-core left this repo's entire suite
 *      green at 27/27, because not one test touched tokenizer output. A
 *      dependency bump that destroyed retrieval quality would have passed CI.
 *      These assertions are deliberately behavioural (what the tokenizer must
 *      and must not emit) rather than a restatement of its implementation, so
 *      they survive refactors and fail on regressions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { tokenize } from "@edgeorgie/retrieval-core";
import type { RepoIndex } from "../src/indexer.js";

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

// ---------------------------------------------------------------------------
// 1. The stale-index gate
// ---------------------------------------------------------------------------

test("an index persisted by a different tokenizer is discarded, not served", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repoask-fingerprint-"));
  const prev = process.env.REPOASK_CACHE_DIR;
  process.env.REPOASK_CACHE_DIR = dir;
  try {
    // Fresh module instance so CACHE_DIR picks up the temp dir.
    const mod = await import(`../src/store.js?stale=${Date.now()}`);
    const key = mod.keyOf("edgeorgie", "repoask-mcp");

    await mod.saveIndex(key, fixtureIndex());

    // Rewrite the persisted file with a foreign fingerprint, simulating a file
    // written before a dependency bump. The in-memory copy is authoritative, so
    // it must be bypassed to exercise the disk path at all — this is what a
    // cold start does naturally.
    const file = path.join(dir, "edgeorgie__repoask-mcp.json");
    const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(
      typeof onDisk.tokenizerFingerprint,
      "string",
      "saveIndex must stamp the fingerprint, otherwise the gate can never fire",
    );
    onDisk.tokenizerFingerprint = "tokenizer-from-a-previous-dependency-version";
    await fs.writeFile(file, JSON.stringify(onDisk), "utf8");

    // A genuinely cold process: no memory entry for this key.
    const cold = await import(`../src/store.js?cold=${Date.now()}`);
    const loaded = await cold.loadIndex(key);
    assert.equal(
      loaded,
      null,
      "a cached index built by a different tokenizer must be discarded so the caller re-indexes",
    );
  } finally {
    if (prev === undefined) delete process.env.REPOASK_CACHE_DIR;
    else process.env.REPOASK_CACHE_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an index persisted before the fingerprint field existed is treated as stale", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repoask-nofingerprint-"));
  const prev = process.env.REPOASK_CACHE_DIR;
  process.env.REPOASK_CACHE_DIR = dir;
  try {
    const mod = await import(`../src/store.js?legacy=${Date.now()}`);
    const key = mod.keyOf("edgeorgie", "repoask-mcp");
    await mod.saveIndex(key, fixtureIndex());

    const file = path.join(dir, "edgeorgie__repoask-mcp.json");
    const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
    delete onDisk.tokenizerFingerprint; // exactly what an older build wrote
    await fs.writeFile(file, JSON.stringify(onDisk), "utf8");

    const cold = await import(`../src/store.js?legacycold=${Date.now()}`);
    assert.equal(
      await cold.loadIndex(key),
      null,
      "a pre-fingerprint index was written by the tokenizer this gate exists to detect, so it must rebuild",
    );
  } finally {
    if (prev === undefined) delete process.env.REPOASK_CACHE_DIR;
    else process.env.REPOASK_CACHE_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a matching fingerprint still round-trips, so the gate is not rejecting everything", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repoask-fresh-"));
  const prev = process.env.REPOASK_CACHE_DIR;
  process.env.REPOASK_CACHE_DIR = dir;
  try {
    const mod = await import(`../src/store.js?fresh=${Date.now()}`);
    const key = mod.keyOf("edgeorgie", "repoask-mcp");
    await mod.saveIndex(key, fixtureIndex());

    // Cold instance, untouched file: same tokenizer, so it must load.
    const cold = await import(`../src/store.js?freshcold=${Date.now()}`);
    const loaded = await cold.loadIndex(key);
    assert.ok(
      loaded,
      "an index written by the CURRENT tokenizer must still load — otherwise the cache is dead weight",
    );
    assert.equal(loaded.branch, "main");
    assert.equal(loaded.chunks.length, 1);
  } finally {
    if (prev === undefined) delete process.env.REPOASK_CACHE_DIR;
    else process.env.REPOASK_CACHE_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. The dependency contract this service relies on
// ---------------------------------------------------------------------------

test("tokenize splits identifiers, so prose questions share vocabulary with code", () => {
  // Without this, a camelCase identifier is one opaque token and a prose
  // question like "how is the user name parsed" shares NO vocabulary with the
  // chunk defining `getUserName` — the chunk is unretrievable, not merely
  // mis-ranked. Source code is overwhelmingly camelCase, so this is the
  // property the whole retrieval path rests on.
  const camel = tokenize("getUserName");
  assert.ok(camel.includes("user"), `expected a "user" sub-token: ${JSON.stringify(camel)}`);
  assert.ok(camel.includes("name"), `expected a "name" sub-token: ${JSON.stringify(camel)}`);

  // Consecutive capitals are a separate code path and were broken independently.
  const acronym = tokenize("HTTPServer");
  assert.ok(acronym.includes("http"), `expected an "http" sub-token: ${JSON.stringify(acronym)}`);
  assert.ok(acronym.includes("server"), `expected a "server" sub-token: ${JSON.stringify(acronym)}`);

  // The whole token must survive too, or exact-symbol search breaks.
  assert.ok(
    camel.includes("getusername"),
    `the whole identifier must remain searchable: ${JSON.stringify(camel)}`,
  );
});

test("tokenize does not leak stopwords in through the sub-token path", () => {
  // Case splitting opened a back door around the stopword filter, which was
  // applied only to whole tokens: `toString` emitted "to", `isValid` emitted
  // "is", `canRetry` emitted "can". Those terms appear in nearly every
  // identifier in a TypeScript codebase, so they consumed vocabulary slots at a
  // near-zero IDF and added noise to every vector — for every repository this
  // service indexes, not just one corpus.
  for (const [identifier, leaked, kept] of [
    ["toString", "to", "string"],
    ["isValid", "is", "valid"],
    ["canRetry", "can", "retry"],
    ["of_the_thing", "the", "thing"],
  ] as const) {
    const tokens = tokenize(identifier);
    assert.ok(
      !tokens.includes(leaked),
      `"${identifier}" leaked stopword "${leaked}": ${JSON.stringify(tokens)}`,
    );
    // Paired positive assertion: this must not be satisfiable by a tokenizer
    // that simply drops short sub-tokens, which would undo the split above.
    assert.ok(
      tokens.includes(kept),
      `"${identifier}" lost the meaningful sub-token "${kept}": ${JSON.stringify(tokens)}`,
    );
  }
});
