/**
 * GitHub repo fetching logic, ported and adapted from edgeorgie/repoask (lib/repo.ts).
 * Uses Node's global fetch against the public GitHub REST API + raw.githubusercontent.com,
 * so it works for any public repo with no auth token required (subject to GitHub's
 * unauthenticated rate limits).
 */

export interface RepoRef {
  owner: string;
  repo: string;
  ref?: string;
}

export interface RepoFile {
  path: string;
  size: number;
}

const TEXT_EXT = new Set([
  "md", "mdx", "txt", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "rb", "php", "c", "h", "cpp", "cs",
  "swift", "sh", "json", "yml", "yaml", "toml", "css", "scss", "html", "sql",
]);
const SKIP = /(^|\/)(node_modules|dist|build|\.next|vendor|coverage|\.git|__snapshots__)\//;
const SKIP_FILE = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.min\.(js|css)|\.map|\.d\.ts)$/;

export const MAX_FILES = 80;
export const MAX_FILE_BYTES = 80_000;

export function parseRepoUrl(input: string): RepoRef | null {
  const s = input.trim().replace(/\.git$/, "");
  const short = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) return { owner: short[1], repo: short[2] };
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const ref = parts[2] === "tree" && parts[3] ? parts.slice(3).join("/") : undefined;
  return { owner: parts[0], repo: parts[1], ref };
}

/** Picks the files worth indexing: text sources, no vendored/generated files, README and docs first. */
export function selectFiles(tree: { path: string; type: string; size?: number }[]): RepoFile[] {
  const files = tree
    .filter((n) => n.type === "blob" && (n.size ?? 0) > 0 && (n.size ?? 0) <= MAX_FILE_BYTES)
    .filter((n) => !SKIP.test(n.path) && !SKIP_FILE.test(n.path))
    .filter((n) => TEXT_EXT.has(n.path.split(".").pop()?.toLowerCase() ?? ""))
    .map((n) => ({ path: n.path, size: n.size ?? 0 }));
  const rank = (p: string) => {
    const lower = p.toLowerCase();
    if (/^readme/.test(lower)) return 0;
    if (/^docs?\//.test(lower) || lower.endsWith(".md")) return 1;
    if (/(^|\/)(src|app|lib|packages)\//.test(lower)) return 2;
    return 3;
  };
  return files
    .sort((a, b) => rank(a.path) - rank(b.path) || a.path.split("/").length - b.path.split("/").length)
    .slice(0, MAX_FILES);
}

function ghHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": "repoask-mcp" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

export async function fetchRepoFiles(
  ref: RepoRef,
): Promise<{ branch: string; files: RepoFile[]; truncated: boolean }> {
  let branch = ref.ref;
  if (!branch) {
    const meta = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, { headers: ghHeaders() });
    if (meta.status === 403 || meta.status === 429) throw new Error("GitHub rate limit reached. Try again in a few minutes, or set GITHUB_TOKEN.");
    if (!meta.ok) throw new Error(`Repository not found or private (${meta.status}).`);
    branch = ((await meta.json()) as { default_branch: string }).default_branch;
  }
  const res = await fetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers: ghHeaders() },
  );
  if (res.status === 403 || res.status === 429) throw new Error("GitHub rate limit reached. Try again in a few minutes, or set GITHUB_TOKEN.");
  if (!res.ok) throw new Error(`Could not read the repository tree (${res.status}).`);
  const data = (await res.json()) as { tree: { path: string; type: string; size?: number }[]; truncated?: boolean };
  return { branch, files: selectFiles(data.tree), truncated: Boolean(data.truncated) };
}

export async function fetchFileText(ref: RepoRef, branch: string, path: string): Promise<string> {
  const res = await fetch(
    `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${encodeURIComponent(branch)}/${path}`,
  );
  if (!res.ok) throw new Error(`Could not download ${path} (${res.status}).`);
  return res.text();
}
