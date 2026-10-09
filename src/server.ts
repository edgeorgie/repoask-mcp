#!/usr/bin/env node
/**
 * repoask-mcp — an MCP server that lets an agent ask a public GitHub repository
 * questions and get answers with exact file+line citations.
 *
 * Retrieval is 100% local (TF-IDF over the repo's own chunked text, no network calls
 * beyond fetching the repo itself, no paid API key). An LLM key (ANTHROPIC_API_KEY or
 * OPENAI_API_KEY) is OPTIONAL and used only to turn the retrieved chunks into prose;
 * without one, ask_repo deterministically returns the top-matching chunks with their
 * citations, same "works with zero keys" contract as github.com/edgeorgie/repoask.
 *
 * Transport: stdio (the standard transport for local MCP clients like Claude Desktop).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { indexRepo } from "./indexer.js";
import { retrieve } from "./retrieval.js";
import { saveIndex, loadIndex, keyOf, listIndexed } from "./store.js";
import { synthesize, deterministicAnswer } from "./llm.js";

const server = new McpServer({
  name: "repoask-mcp",
  version: "1.0.0",
});

server.registerTool(
  "index_repo",
  {
    title: "Index a public GitHub repository",
    description:
      "Fetches a public GitHub repository's text files (source, docs, config — skips binaries, " +
      "lockfiles, node_modules/dist/build/vendor), splits them into overlapping line-range chunks, " +
      "and builds a local TF-IDF embedding index entirely in-process (no external embedding API, " +
      "no paid key required). Must be called once before ask_repo for a given owner/repo. Re-calling " +
      "re-indexes from the current default branch (or a specific ref if given). Large repos are " +
      "capped at 80 files / 80KB per file to keep indexing fast and free.",
    inputSchema: {
      owner: z.string().min(1).describe("GitHub organization or user, e.g. 'octocat'"),
      repo: z.string().min(1).describe("Repository name, e.g. 'Hello-World'"),
      ref: z
        .string()
        .optional()
        .describe("Optional branch, tag, or commit SHA. Defaults to the repo's default branch."),
    },
    outputSchema: {
      owner: z.string(),
      repo: z.string(),
      branch: z.string(),
      fileCount: z.number().int(),
      chunkCount: z.number().int(),
      truncated: z.boolean().describe("True if GitHub's tree API truncated the file listing (very large repo)."),
      indexedAt: z.string().describe("ISO-8601 timestamp of indexing."),
    },
  },
  async ({ owner, repo, ref }) => {
    const index = await indexRepo({ owner, repo, ref });
    const key = keyOf(owner, repo);
    await saveIndex(key, index);
    const structured = {
      owner,
      repo,
      branch: index.branch,
      fileCount: index.fileCount,
      chunkCount: index.chunkCount,
      truncated: index.truncated,
      indexedAt: index.indexedAt,
    };
    return {
      content: [
        {
          type: "text",
          text:
            `Indexed ${owner}/${repo}@${index.branch}: ${index.fileCount} files -> ${index.chunkCount} chunks. ` +
            (index.truncated ? "(GitHub truncated the file tree; only a subset of the repo was seen.) " : "") +
            `Call ask_repo({ owner: "${owner}", repo: "${repo}", question: ... }) next.`,
        },
      ],
      structuredContent: structured,
    };
  },
);

server.registerTool(
  "ask_repo",
  {
    title: "Ask a question about an indexed GitHub repository",
    description:
      "Answers a natural-language question about a GitHub repository that was previously indexed with " +
      "index_repo (auto-indexes on first use if not yet indexed). Retrieves the most relevant chunks via " +
      "local TF-IDF cosine similarity and returns them as citations with exact path + start/end line " +
      "numbers. If ANTHROPIC_API_KEY or OPENAI_API_KEY is set in the server environment, also returns a " +
      "synthesized prose answer with inline [n] citation markers referencing the citations array. If no " +
      "LLM key is configured, 'answer' is a deterministic citation dump (no generation) and " +
      "'answerMode' is 'deterministic' — callers should treat the citations array as the ground truth " +
      "either way.",
    inputSchema: {
      owner: z.string().min(1).describe("GitHub organization or user."),
      repo: z.string().min(1).describe("Repository name."),
      question: z.string().min(3).describe("Natural-language question about the repo's code or docs."),
      topK: z.number().int().min(1).max(20).optional().describe("Number of citations to return. Default 6."),
    },
    outputSchema: {
      owner: z.string(),
      repo: z.string(),
      question: z.string(),
      answer: z.string(),
      answerMode: z.enum(["llm", "deterministic"]),
      model: z.string().optional(),
      citations: z.array(
        z.object({
          rank: z.number().int(),
          path: z.string(),
          startLine: z.number().int(),
          endLine: z.number().int(),
          score: z.number(),
          excerpt: z.string(),
        }),
      ),
    },
  },
  async ({ owner, repo, question, topK }) => {
    const key = keyOf(owner, repo);
    let index = await loadIndex(key);
    if (!index) {
      index = await indexRepo({ owner, repo });
      await saveIndex(key, index);
    }
    const citations = retrieve(index, question, topK ?? 6);
    const repoLabel = `${owner}/${repo}`;
    const chunksForPrompt = citations.map((c) => ({ path: c.path, start: c.startLine, end: c.endLine, text: c.excerpt }));

    let answer: string;
    let answerMode: "llm" | "deterministic";
    let model: string | undefined;
    try {
      const synth = await synthesize(question, repoLabel, chunksForPrompt);
      if (synth) {
        answer = synth.answer;
        answerMode = "llm";
        model = synth.model;
      } else {
        answer = deterministicAnswer(chunksForPrompt);
        answerMode = "deterministic";
      }
    } catch (err) {
      answer = `LLM synthesis failed (${(err as Error).message}); falling back to citations.\n\n${deterministicAnswer(chunksForPrompt)}`;
      answerMode = "deterministic";
    }

    const structured = { owner, repo, question, answer, answerMode, model, citations };
    return {
      content: [{ type: "text", text: answer }],
      structuredContent: structured,
    };
  },
);

server.registerTool(
  "list_indexed_repos",
  {
    title: "List repositories currently indexed in this server's memory",
    description: "Returns the owner/repo keys currently held in this server process's in-memory index cache. Useful for debugging or to check whether index_repo needs to be called before ask_repo.",
    inputSchema: {},
    outputSchema: {
      repos: z.array(z.string()),
    },
  },
  async () => {
    const repos = listIndexed();
    return {
      content: [{ type: "text", text: repos.length ? repos.join(", ") : "(no repos indexed yet in this process)" }],
      structuredContent: { repos },
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("repoask-mcp fatal error:", err);
  process.exit(1);
});
