#!/usr/bin/env node
/**
 * REAL external MCP client test against a deployed (or local) Streamable HTTP
 * repoask-mcp server. This is the network-reachability evidence: a genuine
 * @modelcontextprotocol/sdk Client, connecting over HTTP (StreamableHTTPClientTransport)
 * to a URL — not a stdio subprocess — calling list_tools, index_repo, and ask_repo
 * against a real public GitHub repo, with the literal request/response transcript
 * captured to examples/http-transcript.json.
 *
 * Usage:
 *   node dist/examples/run-http-session.js <server-url> [outfile]
 *
 * Example (against a deployed server):
 *   node dist/examples/run-http-session.js https://repoask-mcp.example.app/mcp
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const serverUrl = process.argv[2];
  const outFile = process.argv[3] ?? path.join(__dirname, "..", "..", "examples", "http-transcript.json");
  if (!serverUrl) {
    console.error("Usage: node dist/examples/run-http-session.js <server-url> [outfile]");
    process.exit(1);
  }

  const transcript: Array<{ step: string; request?: unknown; response?: unknown; error?: string; timestamp: string }> = [];

  console.log(`Connecting to ${serverUrl} over Streamable HTTP...`);
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  const client = new Client({ name: "repoask-mcp-http-test-client", version: "1.0.0" });

  const t0 = Date.now();
  await client.connect(transport);
  console.log(`Connected in ${Date.now() - t0}ms.`);

  // 1) list_tools
  const toolsResult = await client.listTools();
  transcript.push({
    step: "list_tools",
    request: { method: "tools/list" },
    response: toolsResult,
    timestamp: new Date().toISOString(),
  });
  console.log(`list_tools -> ${toolsResult.tools.map((t) => t.name).join(", ")}`);

  // 2) index_repo against a real public repo
  const indexArgs = { owner: "octocat", repo: "git-consortium" };
  const indexResult = await client.callTool({ name: "index_repo", arguments: indexArgs });
  transcript.push({
    step: "index_repo",
    request: { method: "tools/call", params: { name: "index_repo", arguments: indexArgs } },
    response: indexResult,
    timestamp: new Date().toISOString(),
  });
  console.log(`index_repo -> ${JSON.stringify(indexResult.structuredContent)}`);

  // 3) ask_repo against the same repo
  const askArgs = {
    owner: "octocat",
    repo: "git-consortium",
    question: "What is the git-consortium project and what does the README say about it?",
  };
  const askResult = await client.callTool({ name: "ask_repo", arguments: askArgs });
  transcript.push({
    step: "ask_repo",
    request: { method: "tools/call", params: { name: "ask_repo", arguments: askArgs } },
    response: askResult,
    timestamp: new Date().toISOString(),
  });
  console.log(`ask_repo -> answerMode=${(askResult.structuredContent as any)?.answerMode}, citations=${(askResult.structuredContent as any)?.citations?.length}`);

  // 4) list_indexed_repos
  const listResult = await client.callTool({ name: "list_indexed_repos", arguments: {} });
  transcript.push({
    step: "list_indexed_repos",
    request: { method: "tools/call", params: { name: "list_indexed_repos", arguments: {} } },
    response: listResult,
    timestamp: new Date().toISOString(),
  });
  console.log(`list_indexed_repos -> ${JSON.stringify(listResult.structuredContent)}`);

  await client.close();

  await writeFile(
    outFile,
    JSON.stringify(
      {
        serverUrl,
        transport: "streamable-http",
        testedAt: new Date().toISOString(),
        steps: transcript,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nTranscript written to ${outFile}`);
}

main().catch((err) => {
  console.error("HTTP client test failed:", err);
  process.exit(1);
});
