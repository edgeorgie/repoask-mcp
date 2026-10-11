# repoask-mcp

An **MCP (Model Context Protocol) server** that lets an AI agent ask a public
GitHub repository questions and get answers with exact file + line-range
citations — no browser, no human in the loop, no paid API key required for
retrieval.

Built by extracting and re-implementing the indexing/chunking/retrieval logic
proven in [edgeorgie/repoask](https://github.com/edgeorgie/repoask) (a
browser-based "ask this repo" tool using in-browser embeddings) as a real,
agent-callable MCP server, following the current MCP spec.

> See [`docs/example-session.md`](docs/example-session.md) for a captured
> transcript of an MCP client calling it and the citations it got back.

## How this differs from repoask

[repoask](https://github.com/edgeorgie/repoask) is a browser-only, zero-backend tool: embeddings are computed client-side with a transformer model (MiniLM via Transformers.js) and nothing is ever sent to a server — built for a human asking one-off questions privately, with no install. repoask-mcp is a different engine built primarily for AI agents: a persistent, cloud-deployed MCP server exposing `index_repo`/`ask_repo`/`list_indexed_repos` as callable tools over stdio or Streamable HTTP, using server-side TF-IDF retrieval (lexical, no neural model, no GPU) instead of in-browser semantic embeddings. It also ships a thin human web UI as a convenience layer over that same engine, but the reason this repo exists — and the reason to pick it over repoask — is the agent-callable MCP surface, not the browser experience.

## Two usage modes, one engine

**🧑 Human web UI:** open **https://repoask-mcp.vercel.app** in a browser.
Type a public repo (`owner/repo` or a `github.com/...` URL), click **Index**,
watch real file/chunk counts come back, then ask a natural-language question
and get a real answer with exact file+line citations rendered on the page.
No install, no MCP client, no CLI — just a normal website.

**🤖 Agent MCP server:** point any MCP client (Claude Desktop, Cursor, a
custom script) at **https://repoask-mcp.vercel.app/mcp** (Streamable HTTP) or
run it locally over stdio. The agent gets the same three tools —
`index_repo`, `ask_repo`, `list_indexed_repos` — with full Zod-validated
JSON schemas.

Both front ends call the **exact same TypeScript functions**
(`doIndexRepo` / `doAskRepo` in [`src/engine.ts`](src/engine.ts)) — the MCP
tool handlers in [`src/create-server.ts`](src/create-server.ts) and the human
REST routes [`api/index-repo.ts`](api/index-repo.ts) /
[`api/ask-repo.ts`](api/ask-repo.ts) are both thin wrappers around that one
engine. Nothing is reimplemented twice; this is deliberate — it's the same
real retrieval pipeline serving a human clicking a button and an agent
calling a tool.

*Why REST routes instead of the browser speaking raw MCP JSON-RPC?* The
human UI needed simple request/response semantics a `<form>` can drive
directly (no SSE/session-management client code in the browser just to prove
a point); the MCP transport already exists and is dogfooded separately by
`examples/run-http-session.ts`. The REST routes are the honest, minimal
choice precisely because they share `src/engine.ts` rather than duplicating
`index_repo`/`ask_repo` logic — the thing that would make them dishonest.

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

## Implementation notes

- Uses the **official `@modelcontextprotocol/sdk`** (TypeScript), wired with
  `McpServer` behind **two transports**: `StdioServerTransport` (local
  clients — Claude Desktop, Claude Code, etc.) and `StreamableHTTPServerTransport`
  (the current MCP spec's network transport — any client that can reach a
  URL). Both run the identical tool set from `src/create-server.ts`.
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
  [`docs/example-session.md`](docs/example-session.md) — a record of an MCP
  client invoking these tools and the answers with citations it got back.
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

repoask-mcp ships with **two transports from the same tool definitions**
(`src/create-server.ts` is the single source of truth both import — nothing
is duplicated or forked between them):

- **stdio** (`src/server.ts`) — for local clients that spawn a subprocess
  (Claude Desktop, Claude Code, Cursor, Windsurf).
- **Streamable HTTP** (`src/http-server.ts`, the current MCP spec's
  network transport) — for any client that can reach a URL over the
  internet, not just a local subprocess. Runs **stateless**
  (`sessionIdGenerator: undefined`): a fresh server+transport pair per
  request, which is the documented pattern for serverless hosts (Vercel
  functions don't guarantee two requests land on the same warm instance, so
  stateful in-memory sessions would silently break across cold starts).

```bash
npm install
npm run build
npm start          # stdio transport — starts the MCP server, waits for a client
npm run start:http # Streamable HTTP transport — listens on :3000 (PORT env var), POST /mcp
```

For local development without a build step:

```bash
npm run dev         # tsx src/server.ts (stdio)
npm run dev:http    # tsx src/http-server.ts (HTTP, :3000)
```

### Environment variables

All optional. The server reads them from its own process environment: the
`env` block of the MCP client config below for the stdio transport, the
project's environment variables on Vercel.

| Variable | Effect when set |
| --- | --- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Enables LLM answer synthesis in `ask_repo` (`answerMode: "llm"`). Without either, answers are the deterministic citation-only fallback. `ANTHROPIC_MODEL` / `OPENAI_MODEL` override the default model; `ANTHROPIC_WORKSPACE_ID` is required by org-scoped Anthropic keys. |
| `GITHUB_TOKEN` | Sent to the GitHub API, raising its unauthenticated rate limit. |
| `REPOASK_CACHE_DIR` | Where persisted indexes are written. Defaults to `/tmp/.repoask-cache` on a serverless runtime and to `.repoask-cache/` in the repo otherwise (`src/store.ts`). |
| `PORT` | Listen port for `npm run start:http`. Default `3000`. |
| `POSTHOG_KEY` | Turns on server-side product analytics (`src/analytics.ts`). Unset, which is the default, nothing is constructed or sent. |

#### Analytics (`POSTHOG_KEY`)

Server-side product analytics, off unless `POSTHOG_KEY` is set. Unset, the
facade in [`src/analytics.ts`](src/analytics.ts) is a complete no-op: no client
is created, no request leaves the function, nothing is logged. Set it in the
Vercel project's environment variables to start recording; there is no browser
SDK, and the web UI's usage shows up through the REST routes as `surface: "web"`.

With a key, four events go to PostHog (US cloud, via
[posthog-node](https://github.com/PostHog/posthog-js/tree/main/packages/node)):

| Event | Properties | Fires |
| --- | --- | --- |
| `repo_asked` | `surface`, `repo`, `question_length_bucket`, `latency_ms`, `cited`, `citations` | After `POST /api/ask-repo` computes its answer (`web`) and after the `ask_repo` tool does (`mcp`) |
| `index_built` | `surface`, `repo`, `chunk_bucket`, `duration_ms` | After `POST /api/index-repo` (`web`) and the `index_repo` tool (`mcp`) build an index. The implicit index `ask_repo` builds on a first question is not reported separately. |
| `mcp_tool_called` | `tool` | After each `index_repo`, `ask_repo` and `list_indexed_repos` call |
| `rate_limited` | `surface`, `reason` (`per-caller` or `global`) | When the rate limiter rejects a request on a REST route (`web`) or `/mcp` (`mcp`) |

Every event also carries `app: "repoask-mcp"` and a fresh random id with no
person profile. `repo` is the lowercased public `owner/name` of a repository
GitHub has just served; lengths and chunk counts are reported as buckets
(`<40`, `40-120`, `120-300`, `300+` characters; `<50` to `1500+` chunks). Never
sent: the question, the answer, file contents or excerpts, caller IPs, or
anything else that is not a bucket, a count, a boolean, a duration or a public
repository name.

Each capture is awaited before the HTTP response is written, because a
serverless function can be frozen the moment the response ends. That wait is
bounded: one attempt with a 3 s timeout, no retries, and a failed send is
dropped silently, so a PostHog outage cannot fail a request or hold an answer
for more than a few seconds.
[`tests/analytics.test.ts`](tests/analytics.test.ts) pins all of this.

### Adding it to an MCP client — stdio (Claude Desktop example)

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

### Adding it to an MCP client — remote, over HTTP

Once deployed (see **Remote deployment** below for current status), any
MCP client that supports the Streamable HTTP transport connects with just a
URL — no local process to spawn:

```json
{
  "mcpServers": {
    "repoask": {
      "url": "https://<your-deployment-domain>/mcp"
    }
  }
}
```

Or directly with the SDK's `Client`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("https://<your-deployment-domain>/mcp"));
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
```

[`examples/run-http-session.ts`](examples/run-http-session.ts) is exactly
this — a real external client harness, runnable against any Streamable HTTP
repoask-mcp instance:

```bash
node --import tsx examples/run-http-session.ts https://<your-deployment-domain>/mcp
```

## Tests

```bash
npm test
```

`npm test` runs a `pretest` hook (`npm run build`) first, so a fresh clone +
`npm install && npm test` works out of the box — tests import the compiled
`dist/` output, which didn't exist before `pretest` was wired in.

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

[`tests/llm-prompt-injection.test.ts`](tests/llm-prompt-injection.test.ts)
covers the prompt-spotlighting defense on the LLM synthesis path (delimiter
wrapping, forged-delimiter sanitization).

[`tests/rate-limit.test.ts`](tests/rate-limit.test.ts) covers the rate
limiter and the question-length cap as pure logic (no network): requests
under the per-caller limit are allowed, the request that crosses it gets
`allowed: false` with a positive `retryAfterSeconds`, one caller's usage
doesn't consume another's bucket, the sliding window reopens after it
elapses, the global ceiling still trips across many distinct caller IDs, and
an over-length question is rejected with a message naming the cap.

[`tests/zero-key-fallback.test.ts`](tests/zero-key-fallback.test.ts) pins the
zero-key deterministic path *explicitly* rather than relying on whatever the
ambient environment happens to be: it deletes `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` for the duration of the assertion and asserts `synthesize`
returns `null`, and it spawns the real stdio server with both keys stripped
from the child process environment and asserts
`answerMode === "deterministic"` strictly (plus no `model` field, the
`No LLM key configured` preamble, and real citations).

[`tests/stdio-env-passthrough.test.ts`](tests/stdio-env-passthrough.test.ts)
guards a defect that was invisible to every other signal in this repo. The MCP
SDK's `StdioClientTransport` does **not** give the spawned server the parent
process's environment: with `env` omitted it forwards only the SDK's own
allow-list — `HOME, LOGNAME, PATH, SHELL, TERM, USER` on POSIX — which excludes
`GITHUB_TOKEN`. CI passed a token to the test step believing it raised GitHub's
limit from 60 requests/hour/IP to 1000, but the process that actually calls
`api.github.com` is the server child, which never received it. The suite stayed
pinned to the unauthenticated limit and failed with this product's own
"GitHub rate limit reached" message on a shared runner IP — a test-harness bug
wearing a product bug's clothes, and one that reads as GitHub's flakiness rather
than as this repo's defect. The guard derives the SDK's allow-list at runtime
rather than restating it, and separately asserts that *every* spawn site in the
repo passes an explicit `env`, since the realistic way this returns is a new
call site added by someone who has not read the comment.

[`tests/analytics.test.ts`](tests/analytics.test.ts) covers the analytics
facade (`src/analytics.ts`) with no network and no real key. With no
`POSTHOG_KEY`, `capture` resolves, makes no request and writes nothing to the
console (a `fetch` spy and console spies are installed for the assertion). With
a key and a `fetch` that rejects, as in a PostHog outage, it still resolves
after exactly one attempt. What goes over the wire is decoded and checked for
`app`, `$process_person_profile: false`, a fresh id per event and the absence of
the question, the excerpt and the cited path, and the two payload builders are
asserted key by key, so a new property is a deliberate, README-visible change.

[`tests/tool-list-mirrors.test.ts`](tests/tool-list-mirrors.test.ts) guards the
nine places that restate this server's tool set — three module headers and six
README passages, including the machine-readable contract above. The expected
set is derived by connecting a real MCP client to the real
`createRepoaskServer()` factory and reading `tools/list`, never from a literal,
so the test cannot itself become a tenth mirror. It is mutation-validated in
both directions: registering a fourth tool, renaming one, dropping a contract
heading, going stale in a header, advertising a tool that was never registered,
and misstating the count each turn it red, while reflowing a correct comment to
a different width does not.

[`tests/readme-test-claims.test.ts`](tests/readme-test-claims.test.ts) derives
the two numbers in the sentence below from the real suite, so this README cannot
keep claiming a test count it no longer has.

The suite is **61 tests across 11 files**.

Every push to `main` and every pull request runs
[`.github/workflows/ci.yml`](.github/workflows/ci.yml): `npm ci`,
`npx tsc --noEmit`, `npm run build`, `npm audit --audit-level=high`,
`npm test`.

CI is given **no LLM key and no `.env`** on purpose, so the suite has to pass
on a bare checkout. That alone would not *prove* the zero-key fallback works
— a test that accepts either `answerMode` passes whichever path runs, which
is what this suite used to do. The proof is
`tests/zero-key-fallback.test.ts`, which forces the no-key path itself and
asserts strict equality on `"deterministic"`, so it would fail if the
fallback broke even on a machine where a key *is* configured.

CI does receive `secrets.GITHUB_TOKEN`. That is not a configured secret —
Actions mints it automatically per run — and it is passed because the suite
makes real calls to `api.github.com`, which is 60 requests/hour/IP
unauthenticated on shared Actions egress and therefore a genuine flake
source for a required check. `src/repo.ts`'s `ghHeaders()` simply omits the
`Authorization` header when `GITHUB_TOKEN` is absent, so a local `npm test`
on a fresh clone still needs zero setup.

## Design notes / what's reused from repoask vs. what's new

| Concern | repoask (browser) | repoask-mcp (this repo) |
|---|---|---|
| Chunking | `lib/chunk.ts` — 40-line windows, 6-line overlap, markdown-aware | **Ported line-for-line**, now published as [`@edgeorgie/retrieval-core`](https://github.com/edgeorgie/retrieval-core)'s `chunk.ts` |
| File selection/fetching | `lib/repo.ts` — GitHub REST + raw.githubusercontent.com, text-extension allowlist, skip vendored/lockfiles | **Ported** into `src/repo.ts`, using Node's global `fetch` instead of browser `fetch` |
| Embedding | `lib/embedder.ts` + `lib/embed.worker.ts` — in-browser transformer model via a Web Worker (`@xenova/transformers`) | **Replaced** with a local TF-IDF embedder, now in `@edgeorgie/retrieval-core`'s `embedder.ts` — a Web Worker + browser-only transformer model has no equivalent in a headless Node MCP server, and TF-IDF keeps the "no paid key for retrieval" guarantee with zero model download |
| Vector scoring | `lib/vector.ts` — dot product + diversify-by-file | **Ported line-for-line**, now `@edgeorgie/retrieval-core`'s `vector.ts` |
| Prompt building / citations | `lib/rag.ts` — numbered sources, `[n]` citation parsing | **Ported**, now `@edgeorgie/retrieval-core`'s `rag.ts` |
| Answer synthesis | `lib/llm.ts` — BYO browser key, Anthropic/OpenAI | **Re-implemented** server-side (`src/llm.ts`) reading the key from the server process's environment instead of a browser-stored key, with the same optional/fallback contract |
| Transport | Next.js app, human clicks a button | **New**: `@modelcontextprotocol/sdk` `McpServer` over stdio — an agent calls the tools directly |

**Shared with ask-edgeorgie-mcp:** a direct diff of this repo's `chunk.ts`,
`vector.ts`, `embedder.ts` and `rag.ts` against
[edgeorgie/ask-edgeorgie-mcp](https://github.com/edgeorgie/ask-edgeorgie-mcp)
showed they were byte-identical — both servers run the same local TF-IDF
chunking/scoring/prompt-building logic over different corpora (a fetched
GitHub repo here, a local resume/evidence corpus there). That shared slice
is now extracted into
[`@edgeorgie/retrieval-core`](https://github.com/edgeorgie/retrieval-core)
and consumed by both repos as a git dependency instead of being
copy-pasted. The parts that are genuinely different per server — indexing
orchestration, the retrieval entrypoint, tool/engine logic — stay local to
each repo; they weren't forced into the shared package.

## Remote deployment status

**LIVE on the public internet, no auth wall: https://repoask-mcp.vercel.app**

- `GET https://repoask-mcp.vercel.app/` → `200` **the human web UI**
  (`public/index.html`), not a bare JSON blob — a real visitor sees a styled
  page with an index form and an ask form, not an API response.
- `POST https://repoask-mcp.vercel.app/api/index-repo` and
  `POST https://repoask-mcp.vercel.app/api/ask-repo` are the REST routes the
  UI calls — verified live with `curl`, e.g.
  `curl -s -X POST https://repoask-mcp.vercel.app/api/ask-repo -H 'content-type: application/json' -d '{"owner":"octocat","repo":"git-consortium","question":"What is this repository about?"}'`
  returns a real `answerMode: "llm"` response (`model: "claude-haiku-4-5"`,
  since an `ANTHROPIC_API_KEY` is now configured on the deployment) with 4
  citations (`product-backlog.md`, `README.md` with exact line ranges).
  By design (`src/engine.ts` `doAskRepo` → `src/llm.ts` `synthesize`), if no
  LLM key is configured `synthesize` returns `null` and the same request
  takes the deterministic citation-only path instead, reporting
  `answerMode: "deterministic"` with no `model` field. That is a description
  of the code path, not a live observation — verifying it against *this*
  deployment would mean unsetting its env var, which nobody has done. What
  *is* verified is the behaviour itself, locally and in CI, by
  [`tests/zero-key-fallback.test.ts`](tests/zero-key-fallback.test.ts),
  which spawns the real server with both keys stripped and asserts
  `answerMode === "deterministic"`. The citation set is **not** claimed to be
  identical across the two paths — retrieval runs first and is shared, but
  nothing pins the top-`k` set to be invariant, and that was never checked.
- `GET https://repoask-mcp.vercel.app/mcp` → `200` MCP health check JSON:
  `{"name":"repoask-mcp","transport":"streamable-http","mcpEndpoint":"/mcp","status":"ok"}`
- `POST https://repoask-mcp.vercel.app/mcp` is the real Streamable HTTP MCP
  endpoint — reachable by any external MCP client, unauthenticated, from any
  network. Verified with a plain `curl` from a machine with zero Vercel
  session/cookie.
- Verified end-to-end against the **real deployed URL** (not localhost) with
  the official SDK's `Client` + `StreamableHTTPClientTransport`:
  `node --import tsx examples/run-http-session.ts https://repoask-mcp.vercel.app/mcp`
  connects, calls `list_tools`, `index_repo`, `ask_repo`, `list_indexed_repos`
  against the real public repo `octocat/git-consortium`, and gets back real
  results (`fileCount: 2, chunkCount: 8`, 4 real citations with
  path/line/score). Full transcript committed at
  [`examples/http-transcript.json`](examples/http-transcript.json) — its
  `serverUrl` field is `https://repoask-mcp.vercel.app/mcp`.
- `npm test` (stdio, the full suite across
  [`tests/server.test.ts`](tests/server.test.ts),
  [`tests/llm-prompt-injection.test.ts`](tests/llm-prompt-injection.test.ts),
  [`tests/rate-limit.test.ts`](tests/rate-limit.test.ts) and
  [`tests/zero-key-fallback.test.ts`](tests/zero-key-fallback.test.ts))
  still passes unmodified — the stdio transport was not touched, only added to.
  (Exact counts are stated once, under "Verification" above, and derived from
  the real suite by a test; they are deliberately not repeated here.)

### Cost and abuse posture of the public endpoints

Stated plainly, because an `ANTHROPIC_API_KEY` is configured on this
deployment and the exact working `curl` is published above: every anonymous
call to `/api/ask-repo` (and every `ask_repo` tool call over `/mcp`) can
spend the repo owner's own Anthropic credit. `owner`/`repo` are
caller-chosen, so a caller influences how much retrieved repository content
goes into each prompt — i.e. the per-call cost, not just the call count.

What is in place:

- **Rate limiting** ([`src/rate-limit.ts`](src/rate-limit.ts)) on every route
  that can reach `doAskRepo` or the indexer — `/api/ask-repo`,
  `/api/index-repo`, `/api/mcp` and the standalone Express `/mcp`. Two
  independent sliding windows: 10 requests/minute per caller IP, and a 60
  requests/minute per-instance ceiling. Over-limit requests get `429` with a
  `Retry-After` header. **Read the measured limits below before treating
  either number as a guarantee — neither holds under concurrency.** Ported
  from the sibling
  [ask-edgeorgie-mcp](https://github.com/edgeorgie/ask-edgeorgie-mcp)'s
  `src/rate-limit.ts` so the two servers behave identically.
- **A question-length cap** (2000 characters), enforced in the shared engine
  so the REST routes, the MCP tool handler and the stdio server are all
  covered by one check.
- **Scoped CORS.** `Access-Control-Allow-Origin` was `*`; it is now limited
  to this deployment's own origin plus `localhost`. The first-party UI uses a
  same-origin fetch, and CORS is browser-enforced, so this costs documented
  `curl`/agent/MCP usage nothing while stopping third-party pages from
  driving a billable endpoint via their visitors' browsers.

Measured limits, so this is not read as more than it is. The limiter is
in-memory, so its counters live in a single serverless instance's heap:

- **Concurrency defeats both windows, and this was measured, not theorised.**
  150 simultaneous POSTs from a single IP, with no header manipulation, all
  returned `200` — zero `429`s. Vercel allocates instances in response to
  parallelism, and each new instance starts with an empty counter `Map`, so
  parallel requests are each counted against a different, fresh bucket. The
  limits only bind a *sequential* caller: 14 requests in a loop correctly
  yields 10×`200` then 4×`429`.
- **An earlier version of this section blamed cold starts, and that was the
  wrong threat.** No timing games are needed; plain parallelism is enough.
- **An earlier version also claimed the ceiling survives a caller rotating or
  spoofing `X-Forwarded-For`. That claim was false and has been removed.**
  Forged `X-Forwarded-For` values were measured getting `429` anyway, because
  Vercel's edge sets that header and the platform value is the one observed
  here. Spoofing was never the live bypass; concurrency is.

So the "global" ceiling is really per-instance, and the per-caller window is
per-instance too. This raises the cost of a naive abuse loop; it is **not** a
spend cap and should not be cited as one. Closing the concurrency hole needs
cross-instance state — Upstash Redis / Vercel KV with `INCR` + TTL, the
upgrade path documented in `src/rate-limit.ts`. A genuine hard cap belongs at
the billing layer (an Anthropic spend limit on the key), which is account
configuration, not code. There is still no authentication on these endpoints
— being openly callable by any agent is the point of the artifact — so rate
limiting plus a billing cap, rather than auth, is the containment strategy.

### Root cause of the two prior deploy failures, and the fix

1. **`500 FUNCTION_INVOCATION_FAILED` / "No exports found in module
   `/var/task/server.js`"** — Vercel's zero-config framework detection was
   auto-picking `dist/server.js` (the stdio entrypoint from `package.json`'s
   `main`/`bin` fields — exports nothing callable as an HTTP handler) as the
   serverless function root, instead of `api/mcp.ts`. Adding `rewrites` in
   `vercel.json` alone did not change which file Vercel *builds as a
   function* — rewrites only affect routing after a function already exists.
   **Fix:** switched `vercel.json` to an explicit `builds` array
   (`{"src": "api/mcp.ts", "use": "@vercel/node"}`) so Vercel builds exactly
   one function from `api/mcp.ts` and nothing else, and added
   `.vercelignore` excluding `dist/` so the stdio build output is never even
   uploaded. Also removed the explicit `buildCommand` override (Vercel's
   `@vercel/node` builder compiles the TS function itself; the separate
   `npm run build` step was for the stdio `dist/server.js`, irrelevant to the
   serverless function).
2. **`rewrites` silently no-oping once `builds` was added** — after fixing
   (1), `GET /` and `GET /mcp` returned `404` even though the function built
   correctly (confirmed via `vercel inspect`, which showed
   `λ api/mcp.ts` as the only build output). Root cause: when a project
   defines `builds` in `vercel.json`, Vercel's legacy routing requires
   `routes` (not `rewrites`, which is the newer zero-config mechanism) to map
   paths to that build. **Fix:** replaced `rewrites` with `routes`
   (`{"src": "/mcp", "dest": "/api/mcp.ts"}`, same for `/` and the catch-all),
   pointing at the literal built file path.
3. **`deploymentProtection: ["vercel_authentication"]`** blocking all
   unauthenticated access (confirmed via `vercel inspect` and a `302` to a
   Vercel SSO page on a plain `curl`) — this was a per-project setting
   (`ssoProtection.deploymentType: "all_except_custom_domains"` on the
   Vercel project, visible via `GET
   https://api.vercel.com/v9/projects/<id>`), not a plan restriction.
   **Fix:** `PATCH https://api.vercel.com/v9/projects/<id>` with
   `{"ssoProtection": null}` using a Vercel personal access token. Re-deployed
   and re-checked: `deploymentProtection` is now `[]` on every subsequent
   deployment, and a bare `curl` (no cookies, no `vercel curl`, no bypass
   token) gets a real `200` JSON body.
4. **Minor:** `index_repo`'s on-disk cache write
   (`ENOENT: no such file or directory, mkdir '/var/task/.repoask-cache'`) —
   Vercel's function filesystem is read-only except `/tmp`. Fixed by setting
   the `REPOASK_CACHE_DIR=/tmp/.repoask-cache` environment variable on the
   Vercel project (the code already supported this override via
   `process.env.REPOASK_CACHE_DIR`, see `src/store.ts` — no code change
   needed, config only).

The two earlier `500`s are documented above as they happened, root-caused
before moving on.

## License

MIT — see [LICENSE](LICENSE).
