/**
 * Standalone MCP client harness: connects to the compiled repoask-mcp server over
 * stdio exactly like a real agent/client would, calls listTools, then index_repo and
 * ask_repo against a real small public repo, and writes the full request/response
 * transcript (including the raw structuredContent) to docs/example-session.md and
 * examples/transcript.json. Run with: node --import tsx examples/run-session.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "dist", "server.js");

interface TranscriptEntry {
  step: string;
  request: unknown;
  response: unknown;
  timestamp: string;
}

async function main() {
  const transcript: TranscriptEntry[] = [];
  const transport = new StdioClientTransport({ command: "node", args: [SERVER_PATH] });
  const client = new Client({ name: "repoask-mcp-example-session", version: "1.0.0" });
  await client.connect(transport);

  const serverVersion = client.getServerVersion();
  transcript.push({
    step: "initialize",
    request: { protocol: "MCP stdio initialize handshake" },
    response: serverVersion,
    timestamp: new Date().toISOString(),
  });

  const listToolsReq = { method: "tools/list" };
  const listToolsRes = await client.listTools();
  transcript.push({ step: "list_tools", request: listToolsReq, response: listToolsRes, timestamp: new Date().toISOString() });

  const indexReq = { name: "index_repo", arguments: { owner: "octocat", repo: "git-consortium" } };
  const indexRes = await client.callTool(indexReq);
  transcript.push({ step: "call_tool:index_repo", request: indexReq, response: indexRes, timestamp: new Date().toISOString() });

  const askReq = {
    name: "ask_repo",
    arguments: { owner: "octocat", repo: "git-consortium", question: "What is the git-consortium project and what does the README say about it?" },
  };
  const askRes = await client.callTool(askReq);
  transcript.push({ step: "call_tool:ask_repo", request: askReq, response: askRes, timestamp: new Date().toISOString() });

  const listIndexedReq = { name: "list_indexed_repos", arguments: {} };
  const listIndexedRes = await client.callTool(listIndexedReq);
  transcript.push({ step: "call_tool:list_indexed_repos", request: listIndexedReq, response: listIndexedRes, timestamp: new Date().toISOString() });

  await client.close();

  await fs.mkdir(path.join(ROOT, "examples"), { recursive: true });
  await fs.writeFile(path.join(ROOT, "examples", "transcript.json"), JSON.stringify(transcript, null, 2), "utf8");

  const md = renderMarkdown(transcript, serverVersion);
  await fs.mkdir(path.join(ROOT, "docs"), { recursive: true });
  await fs.writeFile(path.join(ROOT, "docs", "example-session.md"), md, "utf8");

  console.log("Wrote examples/transcript.json and docs/example-session.md");
}

function renderMarkdown(transcript: TranscriptEntry[], serverVersion: unknown): string {
  const lines: string[] = [];
  lines.push("# repoask-mcp — real MCP client session transcript");
  lines.push("");
  lines.push(
    "This is a REAL transcript captured by running a standalone MCP client " +
      "(`examples/run-session.ts`) against the compiled `dist/server.js` over stdio — the " +
      "exact same transport an MCP-capable agent (e.g. Claude Desktop, Claude Code) uses. " +
      "No tool output below is hand-written or fabricated; it is the literal JSON returned " +
      "by the running server for a real public GitHub repository, captured on " +
      new Date().toISOString() +
      ".",
  );
  lines.push("");
  lines.push("Reproduce it yourself: `npm run build && node --import tsx examples/run-session.ts`");
  lines.push("");
  lines.push(`Server info reported at MCP initialize: \`${JSON.stringify(serverVersion)}\``);
  lines.push("");
  for (const entry of transcript) {
    lines.push(`## ${entry.step}`);
    lines.push(`_captured at ${entry.timestamp}_`);
    lines.push("");
    lines.push("**Request:**");
    lines.push("```json");
    lines.push(JSON.stringify(entry.request, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("**Response:**");
    lines.push("```json");
    lines.push(JSON.stringify(entry.response, null, 2));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
