/**
 * Chunking logic ported from edgeorgie/repoask (lib/chunk.ts).
 * Splits a file into overlapping line windows so citations can point at exact
 * file+line ranges. Markdown files break on headings first so sections stay together.
 */

export interface Chunk {
  path: string;
  start: number;
  end: number;
  text: string;
}

export function chunkFile(path: string, content: string, maxLines = 40, overlap = 6): Chunk[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const chunks: Chunk[] = [];
  const isMd = /\.mdx?$/i.test(path);
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + maxLines);
    if (isMd && end < lines.length) {
      for (let i = end - 1; i > start + maxLines / 2; i--) {
        if (/^#{1,4}\s/.test(lines[i])) {
          end = i;
          break;
        }
      }
    }
    const text = lines.slice(start, end).join("\n").trim();
    if (text.length > 20) chunks.push({ path, start: start + 1, end, text });
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

/** The text that gets embedded: the path gives useful context about what the chunk is. */
export function embedText(c: Chunk): string {
  return `${c.path}\n${c.text}`.slice(0, 1500);
}
