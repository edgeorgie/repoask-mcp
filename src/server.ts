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
 * For a remote/network-reachable client, see http-server.ts (Streamable HTTP transport,
 * same tool definitions via create-server.ts — nothing duplicated).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRepoaskServer } from "./create-server.js";

async function main() {
  const server = createRepoaskServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("repoask-mcp fatal error:", err);
  process.exit(1);
});
