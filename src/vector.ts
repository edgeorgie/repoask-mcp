/**
 * Vector scoring, ported unchanged in logic from edgeorgie/repoask (lib/vector.ts).
 */

export interface Scored {
  index: number;
  score: number;
}

/** Cosine similarity for vectors that are already L2-normalized (a plain dot product). */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function topK(query: Float32Array, vectors: Float32Array[], k = 6, minScore = 0.05): Scored[] {
  return vectors
    .map((v, index) => ({ index, score: dot(query, v) }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Keeps at most `perFile` chunks from the same file so one file cannot crowd out the rest. */
export function diversify(scored: Scored[], pathOf: (index: number) => string, perFile = 3): Scored[] {
  const counts = new Map<string, number>();
  return scored.filter((s) => {
    const p = pathOf(s.index);
    const n = counts.get(p) ?? 0;
    if (n >= perFile) return false;
    counts.set(p, n + 1);
    return true;
  });
}
