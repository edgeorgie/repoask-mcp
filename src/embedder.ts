/**
 * Lightweight local embedding: TF-IDF over a token vocabulary built from the
 * corpus being indexed, L2-normalized so cosine similarity is a plain dot product
 * (same contract as repoask's `vector.ts`: `dot(normalized_a, normalized_b)`).
 *
 * This replaces repoask's in-browser transformer-model worker (lib/embed.worker.ts),
 * which depends on a browser Worker + @xenova/transformers and isn't meaningful in a
 * headless MCP server. TF-IDF needs no model download and no API key, so the
 * retrieval path works with zero paid dependencies, matching the task's requirement.
 */

export type Vector = Float32Array;

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "to", "of", "in", "on", "for",
  "and", "or", "it", "this", "that", "with", "as", "at", "by", "from", "but", "not", "if",
  "then", "else", "do", "does", "did", "can", "could", "will", "would", "should", "you", "i",
  "we", "they", "he", "she", "its", "their", "our", "your", "my",
]);

/** Splits camelCase/snake_case/kebab-case identifiers into sub-tokens too, so code matches prose questions. */
export function tokenize(text: string): string[] {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const t of base) {
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    out.push(t);
    const sub = t.split(/_+/).filter((s) => s.length > 1);
    if (sub.length > 1) out.push(...sub);
  }
  return out;
}

export interface TfidfModel {
  vocab: Map<string, number>;
  idf: Float32Array;
}

/** Builds a vocabulary + IDF weights from an entire corpus (call once per index_repo). */
export function fitTfidf(documents: string[]): TfidfModel {
  const df = new Map<string, number>();
  const docTokenSets = documents.map((d) => new Set(tokenize(d)));
  for (const set of docTokenSets) {
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const vocab = new Map<string, number>();
  let i = 0;
  for (const term of df.keys()) vocab.set(term, i++);
  const idf = new Float32Array(vocab.size);
  const n = documents.length;
  for (const [term, count] of df) {
    idf[vocab.get(term)!] = Math.log((n + 1) / (count + 1)) + 1;
  }
  return { vocab, idf };
}

/** Embeds one document against a fitted model, L2-normalized. */
export function embedTfidf(text: string, model: TfidfModel): Vector {
  const tokens = tokenize(text);
  const vec = new Float32Array(model.vocab.size);
  for (const t of tokens) {
    const idx = model.vocab.get(t);
    if (idx === undefined) continue;
    vec[idx] += 1;
  }
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    if (vec[i] === 0) continue;
    vec[i] *= model.idf[i];
    normSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(normSq) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

export function embedBatchTfidf(texts: string[], model: TfidfModel): Vector[] {
  return texts.map((t) => embedTfidf(t, model));
}
