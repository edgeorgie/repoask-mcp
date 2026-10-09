/**
 * Automated test: spins up the actual MCP server (over stdio, as a real client would),
 * calls list_tools, then index_repo and ask_repo against a small well-known public repo,
 * and asserts the real shapes/content of the responses. This exercises the compiled
 * server binary end-to-end — no internals are imported or mocked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "dist", "server.js");

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_PATH],
  });
  const client = new Client({ name: "repoask-mcp-test-client", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("list_tools exposes index_repo, ask_repo, list_indexed_repos", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["ask_repo", "index_repo", "list_indexed_repos"]);
    const indexRepoTool = tools.find((t) => t.name === "index_repo")!;
    assert.ok(indexRepoTool.inputSchema, "index_repo must declare an input schema");
    assert.ok(indexRepoTool.description && indexRepoTool.description.length > 20);
  });
});

test("index_repo + ask_repo against a real small public repo returns real citations", async () => {
  await withClient(async (client) => {
    const indexResult = await client.callTool({
      name: "index_repo",
      arguments: { owner: "octocat", repo: "Spoon-Knife" },
    });
    assert.equal(indexResult.isError, undefined);
    const indexed = indexResult.structuredContent as { fileCount: number; chunkCount: number; branch: string };
    assert.ok(indexed.fileCount >= 1, "expected at least 1 file indexed");
    assert.ok(indexed.chunkCount >= 1, "expected at least 1 chunk");
    assert.ok(indexed.branch.length > 0);

    const askResult = await client.callTool({
      name: "ask_repo",
      arguments: { owner: "octocat", repo: "Spoon-Knife", question: "What does this repository say?" },
    });
    assert.equal(askResult.isError, undefined);
    const structured = askResult.structuredContent as {
      answer: string;
      answerMode: "llm" | "deterministic";
      citations: { path: string; startLine: number; endLine: number; score: number }[];
    };
    assert.ok(structured.answer.length > 0, "answer text must be non-empty");
    assert.ok(["llm", "deterministic"].includes(structured.answerMode));
    assert.ok(Array.isArray(structured.citations));
    assert.ok(structured.citations.length >= 1, "expected at least one citation");
    for (const c of structured.citations) {
      assert.ok(c.path.length > 0);
      assert.ok(c.startLine >= 1);
      assert.ok(c.endLine >= c.startLine);
      assert.ok(typeof c.score === "number");
    }
  });
});

test("ask_repo auto-indexes a never-before-seen repo on first call", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "ask_repo",
      arguments: { owner: "octocat", repo: "git-consortium", question: "What is this project for?" },
    });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as { citations: unknown[] };
    assert.ok(structured.citations.length >= 1);
  });
});
