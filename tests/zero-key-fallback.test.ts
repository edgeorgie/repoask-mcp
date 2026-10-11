/**
 * Tests that genuinely PIN the zero-key deterministic fallback.
 *
 * WHY THIS FILE EXISTS: the README claims CI receiving no secrets "is also
 * the proof that ask_repo's zero-key deterministic fallback really works."
 * The only assertion that previously touched it was
 * `assert.ok(["llm", "deterministic"].includes(structured.answerMode))` in
 * tests/server.test.ts, which passes whichever path runs — so it proved
 * nothing, and in CI it could not fail for the interesting reason. These
 * tests force the no-key path EXPLICITLY instead of relying on ambient
 * configuration, so they would still fail if the fallback broke even on a
 * machine (or a future CI job) where an LLM key happens to be set.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { synthesize, deterministicAnswer } from "../src/llm.js";
import { serverEnv } from "./helpers/server-env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "dist", "server.js");

const SAMPLE_CHUNKS = [
  { path: "README.md", start: 1, end: 4, text: "This project does a thing.\nIt has docs." },
  { path: "src/index.ts", start: 10, end: 14, text: "export function go() { return 1; }" },
];

test("synthesize returns null when NEITHER LLM key is set, which is what triggers the fallback", async () => {
  // Explicitly force the no-key condition rather than assuming the ambient
  // environment lacks keys. Saved and restored so this cannot leak into
  // other tests in the same process.
  const savedAnthropic = process.env.ANTHROPIC_API_KEY;
  const savedOpenai = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const result = await synthesize("What does this do?", "owner/repo", SAMPLE_CHUNKS);
    assert.equal(result, null, "with no key configured, synthesize must return null (no network call, no spend)");
  } finally {
    if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedOpenai !== undefined) process.env.OPENAI_API_KEY = savedOpenai;
  }
});

test("deterministicAnswer produces a citation-only answer with no invented prose", () => {
  const answer = deterministicAnswer(SAMPLE_CHUNKS);
  assert.match(answer, /No LLM key configured/, "must say plainly that no key is configured");
  // Every chunk must be surfaced with its real path and line range — the
  // whole point of the fallback is citations instead of generated prose.
  for (const [i, chunk] of SAMPLE_CHUNKS.entries()) {
    assert.ok(answer.includes(`[${i + 1}] ${chunk.path}`), `citation ${i + 1} must name ${chunk.path}`);
    assert.ok(answer.includes(`lines ${chunk.start}-${chunk.end}`), `citation ${i + 1} must give its line range`);
  }
});

test("deterministicAnswer degrades honestly when retrieval found nothing", () => {
  assert.match(deterministicAnswer([]), /No sufficiently similar chunks/);
});

test("ask_repo returns answerMode exactly 'deterministic' when the server has no LLM key", async () => {
  // End-to-end through the real stdio server, with the child process's
  // environment explicitly stripped of both LLM keys. This is the assertion
  // the README's claim actually needs: a STRICT equality on "deterministic",
  // forced by configuration we control here, not by whatever the ambient
  // environment happens to be.
  const childEnv = serverEnv({ without: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] });

  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_PATH],
    env: childEnv,
  });
  const client = new Client({ name: "repoask-mcp-nokey-test-client", version: "1.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "ask_repo",
      arguments: { owner: "octocat", repo: "Spoon-Knife", question: "What does this repository say?" },
    });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      answer: string;
      answerMode: "llm" | "deterministic";
      model?: string;
      citations: { path: string }[];
    };
    assert.equal(
      structured.answerMode,
      "deterministic",
      "with no LLM key in the server process env, ask_repo MUST take the deterministic path",
    );
    assert.equal(structured.model, undefined, "no model should be reported when nothing was synthesized");
    assert.match(structured.answer, /No LLM key configured/);
    assert.ok(structured.citations.length >= 1, "the deterministic path must still return real citations");
  } finally {
    await client.close();
  }
});

test("ask_repo rejects an over-long question before indexing or any LLM call", async () => {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_PATH],
    env: serverEnv(),
  });
  const client = new Client({ name: "repoask-mcp-length-test-client", version: "1.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "ask_repo",
      arguments: { owner: "octocat", repo: "Spoon-Knife", question: "a".repeat(5000) },
    });
    // The tool surfaces the thrown engine error as an MCP tool error.
    const text = JSON.stringify(result);
    assert.match(text, /Question too long/, `expected a length rejection, got: ${text.slice(0, 400)}`);
  } finally {
    await client.close();
  }
});
