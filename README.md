# repoask-mcp

An **MCP (Model Context Protocol) server** that lets an AI agent ask a public
GitHub repository questions and get answers with exact file + line-range
citations — no browser, no human in the loop, no paid API key required for
retrieval.

Built by extracting and re-implementing the indexing/chunking/retrieval logic
proven in [edgeorgie/repoask](https://github.com/edgeorgie/repoask) (a
browser-based "ask this repo" tool using in-browser embeddings) as a real,
agent-callable MCP server, following the current MCP spec.

> This exists as direct evidence for PostHog's Product Engineer posting, which
> explicitly asks: *"Have you built anything agents use? ...an API an agent
> can drive, an MCP server, evals, docs written for a machine."* This repo is
> that MCP server — see [`docs/example-session.md`](docs/example-session.md)
> for a real, captured transcript of an MCP client calling it and getting
> real, non-fabricated citations back.

## What it does

1. **`index_repo(owner, repo, ref?)`** — fetches a public GitHub repo's text
   files via the GitHub REST API, splits them into overlapping line-range
   chunks (same windowing strategy as repoask: 40-line windows, 6-line
   overlap, markdown breaks on headings), and builds a **TF-IDF embedding
   index** entirely in-process. No external embedding API call, no GPU, no
   paid key — just term-frequency/inverse-document-frequency vectors computed
   from the repo's own text, L2-normalized so cosine similarity is a dot
   product (same contract as repoask's `lib/vector.ts`).
2. **`ask_repo(owner, repo, question, topK?)`** — embeds the question with the
   *same* fitted TF-IDF model, scores every chunk, diversifies across files
   (max 3 chunks/file so one file can't dominate), and returns the top
   matches as **citations with exact `path`, `startLine`, `endLine`, `score`,
   and `excerpt`**. If `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set in the
   server's environment, the chunks are also sent to a cheap model
   (`claude-haiku-4-5` / `gpt-4o-mini`) to synthesize a prose answer with
   inline `[n]` citation markers. **If no key is set, `ask_repo` still works**
   — it deterministically returns the top-matching chunks with citations and
   no generation step, exactly the "zero-key" fallback pattern already used in
   [repoask](https://github.com/edgeorgie/repoask) and
   [triage-desk](https://github.com/edgeorgie/triage-desk).
3. **`list_indexed_repos()`** — debugging helper; lists which repos this
   server process currently holds indexed in memory.

Everything is capped at 80 files / 80KB per file per repo to keep indexing
fast, free, and within GitHub's unauthenticated rate limits (set
`GITHUB_TOKEN` in the environment to raise the limit for heavy use — this is
optional, not required).

## Why this is a genuine MCP server, not a demo

- Uses the **official `@modelcontextprotocol/sdk`** (TypeScript), wired with
  `McpServer` + `StdioServerTransport`, the standard transport local MCP
  clients (Claude Desktop, Claude Code, etc.) use.
- Tools are registered with **real Zod input/output schemas** — the same
  schemas an agent's tool-calling layer reads to decide how to call this
  server, and which get validated on every call.
- [`tests/server.test.ts`](tests/server.test.ts) spins up the **compiled
  server binary as a subprocess** and drives it with a real
  `@modelcontextprotocol/sdk` `Client` over stdio — `list_tools`, `index_repo`,
  and `ask_repo` are called for real against real public GitHub repos
  (`octocat/Spoon-Knife`, `octocat/git-consortium`), asserting the actual
  response shapes. Run it: `npm test`.
- [`examples/run-session.ts`](examples/run-session.ts) is a standalone MCP
  client harness that connects to the server and captures the **full raw
  request/response JSON** for a real session into
  [`examples/transcript.json`](examples/transcript.json) and a readable
  [`docs/example-session.md`](docs/example-session.md) — proof an actual MCP
  client invoked these tools and got real, verifiable answers with citations.
  Nothing in those files is hand-written; regenerate it yourself with:

  ```bash
  npm run build
  node --import tsx examples/run-session.ts
  ```

## Tool schemas (machine-readable contract)

### `index_repo`

**Input:**
```json
{
  "owner": "string, required — GitHub org or user, e.g. 'octocat'",
  "repo": "string, required — repository name, e.g. 'Hello-World'",
  "ref": "string, optional — branch/tag/SHA; defaults to the default branch"
}
```

**Output (`structuredContent`):**
```json
{
  "owner": "string",
  "repo": "string",
  "branch": "string",
  "fileCount": "integer",
  "chunkCount": "integer",
  "truncated": "boolean — true if GitHub's tree API truncated the file listing",
  "indexedAt": "string — ISO-8601 timestamp"
}
```

### `ask_repo`

**Input:**
```json
{
  "owner": "string, required",
  "repo": "string, required",
  "question": "string, required, min length 3",
  "topK": "integer, optional, 1-20, default 6"
}
```

**Output (`structuredContent`):**
```json
{
  "owner": "string",
  "repo": "string",
  "question": "string",
  "answer": "string — prose if an LLM key is set, else a citation dump",
  "answerMode": "\"llm\" | \"deterministic\"",
  "model": "string, optional — e.g. 'claude-haiku-4-5', present only when answerMode is \"llm\"",
  "citations": [
    {
      "rank": "integer",
      "path": "string — exact file path in the repo",
      "startLine": "integer — 1-indexed",
      "endLine": "integer",
      "score": "number — TF-IDF cosine similarity, 0-1",
      "excerpt": "string — the exact cited source text"
    }
  ]
}
```

### `list_indexed_repos`

**Input:** `{}` (no arguments)

**Output (`structuredContent`):**
```json
{ "repos": ["owner/repo", "..."] }
```

## Running it

```bash
npm install
npm run build
npm start          # starts the stdio MCP server, waits for a client
```

For local development without a build step:

```bash
npm run dev         # tsx src/server.ts
```

### Adding it to an MCP client (Claude Desktop example)

Add this to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`; Windows:
`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "repoask": {
      "command": "node",
      "args": ["/absolute/path/to/repoask-mcp/dist/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "optional — omit to use the deterministic citation fallback",
        "GITHUB_TOKEN": "optional — raises GitHub's unauthenticated rate limit"
      }
    }
  }
}
```

The same `command`/`args` shape works for any MCP client that speaks the
stdio transport (Claude Code's `mcp add`, Cursor, Windsurf, etc.).

## Tests

```bash
npm test
```

`tests/server.test.ts` makes real network calls to GitHub (no mocking) and
real stdio MCP calls to the compiled server. It asserts:
- `list_tools` returns exactly `index_repo`, `ask_repo`, `list_indexed_repos`
  with non-empty descriptions and declared input schemas.
- `index_repo` against `octocat/Spoon-Knife` returns `fileCount >= 1`,
  `chunkCount >= 1`, and a real branch name.
- `ask_repo` against the same repo returns a non-empty answer, a valid
  `answerMode`, and at least one well-formed citation (non-empty path,
  `endLine >= startLine`, numeric score).
- `ask_repo` against a repo that was **never explicitly indexed**
  (`octocat/git-consortium`) still returns real citations — proving the
  auto-index-on-first-ask path works.

## Design notes / what's reused from repoask vs. what's new

| Concern | repoask (browser) | repoask-mcp (this repo) |
|---|---|---|
| Chunking | `lib/chunk.ts` — 40-line windows, 6-line overlap, markdown-aware | **Ported line-for-line** into `src/chunk.ts` |
| File selection/fetching | `lib/repo.ts` — GitHub REST + raw.githubusercontent.com, text-extension allowlist, skip vendored/lockfiles | **Ported** into `src/repo.ts`, using Node's global `fetch` instead of browser `fetch` |
| Embedding | `lib/embedder.ts` + `lib/embed.worker.ts` — in-browser transformer model via a Web Worker (`@xenova/transformers`) | **Replaced** with a local TF-IDF embedder (`src/embedder.ts`) — a Web Worker + browser-only transformer model has no equivalent in a headless Node MCP server, and TF-IDF keeps the "no paid key for retrieval" guarantee with zero model download |
| Vector scoring | `lib/vector.ts` — dot product + diversify-by-file | **Ported line-for-line** into `src/vector.ts` |
| Prompt building / citations | `lib/rag.ts` — numbered sources, `[n]` citation parsing | **Ported** into `src/rag.ts` |
| Answer synthesis | `lib/llm.ts` — BYO browser key, Anthropic/OpenAI | **Re-implemented** server-side (`src/llm.ts`) reading the key from the server process's environment instead of a browser-stored key, with the same optional/fallback contract |
| Transport | Next.js app, human clicks a button | **New**: `@modelcontextprotocol/sdk` `McpServer` over stdio — an agent calls the tools directly |

## Deployment note (not done, intentionally)

This ships as a local stdio server because that's what MCP clients expect by
default and it costs nothing to run. The same tool logic could be exposed as
a remote **Streamable HTTP MCP endpoint** (the SDK's
`StreamableHTTPServerTransport`) and deployed to Vercel's free tier as a
serverless function, swapping only the transport in `src/server.ts` — no
retrieval/indexing code would need to change. Not deployed here to avoid any
spend; local + committed test transcripts are the evidence of real usage.

## License

MIT — see [LICENSE](LICENSE).
