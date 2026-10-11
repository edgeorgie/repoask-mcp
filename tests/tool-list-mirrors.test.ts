/**
 * Derived guard for every hand-maintained mirror of this server's tool set.
 *
 * THE DRIFT THIS EXISTS TO PREVENT
 *
 * `createRepoaskServer()` in src/create-server.ts is the ONE place a tool is
 * registered. ELEVEN other places restate that set — and in four cases its
 * COUNT — in prose for humans, in doc comments for the next contributor, and
 * in executable scripts, and not one of them is updated by the compiler when a
 * tool is added or renamed:
 *
 *   1. src/create-server.ts's module header
 *   2. src/http-server.ts's module header ("the exact same tools ... —  X, Y, Z")
 *   3. api/mcp.ts's module header ("the identical tool set (X, Y, Z)")
 *   4. README §"How this differs from repoask"
 *   5. README §"Two usage modes, one engine" ("the same three tools — X, Y, Z")
 *   6. README §"Tool schemas (machine-readable contract)" — one `###` heading
 *      per tool, which IS the machine-readable contract a caller reads
 *   7. README §"Analytics events" — the `mcp_tool_called` row
 *   8. README §"Tests" — "`list_tools` returns exactly X, Y, Z"
 *   9. README §"Remote deployment status" — the example-session claim
 *  10. examples/run-session.ts — calls each tool by hardcoded string
 *  11. examples/run-http-session.ts — likewise
 *
 * 10 and 11 were MISSED by the first revision of this file, which enumerated
 * nine and said so in its own PR. They are the worst two to miss: both are
 * executable, `callTool`'s name is a plain string that `tsc` cannot check, and
 * neither runs in CI (real network) — so they rot silently, and they are the
 * generators of the transcripts this repo presents as evidence of real agent
 * usage.
 *
 * This repo has already killed this exact class twice in its sibling
 * (`ask-edgeorgie-mcp`'s `CORPUS_FILES` versus three mirrors, one of them a
 * tool DESCRIPTION that told every calling agent the corpus was smaller than
 * it was; and its tool-array mirrors in the health endpoints), and once in its
 * own prose (`tests/readme-test-claims.test.ts`, after the README claimed 28
 * tests across six files when it had 58 across 12). The remaining uncovered
 * surface was the thing this product actually sells: the tool set itself.
 *
 * It matters more here than a stale number elsewhere would. Mirror 6 is
 * published as the machine-readable contract, and mirror 8 is a claim about
 * what the test suite verifies. A fourth tool shipping with these untouched
 * would under-advertise a real capability to every agent that reads the README
 * instead of calling `tools/list`, and would leave a documented test claim
 * false — with `tsc`, `build`, the whole suite and the deploy check all green,
 * exactly as they were in all three prior instances of this bug.
 *
 * WHAT MAKES THIS NON-VACUOUS
 *
 * The expectation is DERIVED, not restated: the real server is built by the
 * real factory and asked over a real MCP client connection, so the expected
 * set is the SDK's own answer — `registerTool` calls, conditionals and all —
 * rather than a second literal this file would then have to keep in sync.
 * A guard that hardcoded ["ask_repo", "index_repo", "list_indexed_repos"]
 * would be a twelfth mirror pretending to be a test.
 *
 * Comparisons are bidirectional set EQUALITY over names detected by SHAPE, not
 * by matching the known tool names — see `claimedTools` for why that
 * distinction is what makes the over-advertising direction reachable at all.
 * A mirror naming a tool that does not exist fails as loudly as one missing a
 * tool that does, and over-advertising is the worse direction for an
 * agent-facing contract: a caller told a tool exists gets a `tools/call` error
 * at runtime.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createRepoaskServer } from "../src/create-server.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The real tool set, from the real factory over a real client connection.
 *
 * In-memory transport rather than a stdio subprocess on purpose: this file
 * asserts on SOURCE TEXT in the same checkout, so spawning `dist/server.js`
 * would compare today's prose against the last build's tool set. The in-memory
 * pair runs the TypeScript under test directly, so the two sides of every
 * assertion below come from the same tree. (tests/server.test.ts covers the
 * compiled binary end-to-end over stdio; that is a different question.)
 */
async function realToolNames(): Promise<string[]> {
  const server = createRepoaskServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-list-mirror-guard", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

const expectedNames = await realToolNames();
const expectedCount = expectedNames.length;

/** Spelled-out numerals a prose mirror might use instead of a digit. */
const NUMBER_WORDS: Record<number, string> = {
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
};

async function read(...parts: string[]): Promise<string> {
  return fs.readFile(path.join(repoRoot, ...parts), "utf8");
}

/**
 * Snake_case identifiers in the same prose that are deliberately NOT tools.
 *
 * `claimedTools` below works by SHAPE — any `snake_case` identifier in a
 * mirror is read as a claim about the tool set — because that is the only way
 * to catch the over-advertising direction. A scan driven by the real tool
 * names can only ever find names that already exist, so a mirror naming a
 * fourth tool that was never registered reads as a perfect match. That hole
 * was measured, not reasoned about: an earlier revision of this file
 * documented both directions as covered, and a mutation adding `purge_index`
 * to the README's `list_tools` claim left it 11/11 green.
 *
 * The cost of shape detection is this list. It is short, closed, and the test
 * below asserts it stays disjoint from the real tool set — so if one of these
 * names ever becomes a tool, the allowlist cannot silently swallow it.
 */
const NON_TOOL_IDENTIFIERS = new Set([
  // PostHog event names (src/analytics.ts's AnalyticsEvent union).
  "repo_asked",
  "index_built",
  "mcp_tool_called",
  "rate_limited",
  // The MCP protocol method, not a tool this server registers.
  "list_tools",
]);

/**
 * Every tool the text CLAIMS exists, by shape: snake_case identifiers minus
 * the known non-tool vocabulary above.
 *
 * Bidirectional by construction. A mirror missing a real tool and a mirror
 * advertising one that was never registered both produce a set that is not
 * equal to the derived one. Over-advertising is the worse direction for an
 * agent-facing contract — a caller told a tool exists gets a `tools/call`
 * error at runtime — and it is the direction a name-driven scan cannot see.
 */
function claimedTools(text: string): string[] {
  const found = text.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g) ?? [];
  return [...new Set(found.filter((name) => !NON_TOOL_IDENTIFIERS.has(name)))].sort();
}

/**
 * Asserts a mirror names exactly the real tool set.
 */
function assertNamesExactly(text: string, label: string): void {
  const found = claimedTools(flatten(text));
  assert.deepEqual(
    found,
    expectedNames,
    `${label} names [${found.join(", ")}] but the server registers [${expectedNames.join(", ")}] — ` +
      `a reader or calling agent is being told the wrong tool set`,
  );
}

/**
 * Collapses a chunk of source or prose to one line of single-spaced words,
 * stripping JSDoc leading `*` and markdown emphasis.
 *
 * Needed because every mirror here is WRAPPED. `src/create-server.ts`'s header
 * genuinely says "all three repoask-mcp tools registered", but across a line
 * break with a `*` in between, so a window-based match that stopped at `\n`
 * reported a correct mirror as stale. Normalising first means the assertions
 * are about what the text SAYS, not how it happens to be wrapped — otherwise
 * reflowing a comment to 80 columns could break the build.
 *
 * `_` is deliberately NOT stripped, even though markdown uses it for emphasis:
 * every tool name contains one, and an earlier revision that stripped it
 * turned `index_repo` into `indexrepo` so no name matched anything and the
 * whole file would have passed vacuously on an empty set.
 */
function flatten(text: string): string {
  return text
    .replace(/^[ \t]*\*[ \t]?/gm, " ")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds a regex matching a count that QUALIFIES the word "tool(s)" — "three
 * tools", "all three repoask-mcp tools", "the same three tools" — in digit or
 * spelled-out form. Expects `flatten`ed input.
 *
 * The qualifier scope is the point. A bare scan for the numeral is unusable
 * here, and it was measured so rather than assumed: this repo's own prose
 * truthfully contains "Two usage modes", "behind two transports", "the two
 * numbers in the sentence below" and "the two prior deploy failures", so the
 * first version of this guard failed on two mirrors that were entirely
 * correct. A guard that cries wolf gets deleted, so it has to assert the thing
 * it means: not "this file mentions the number three" but "this file says
 * there are three TOOLS".
 *
 * The 0-40 char window between the count and "tool" covers the real mirrors'
 * intervening words while stopping at a sentence boundary, so a count in one
 * sentence cannot be paired with the word "tools" in the next.
 */
function toolCountRe(count: number, form: "digit" | "word"): RegExp {
  const numeral = form === "digit" ? `(?<![\\w.])${count}(?![\\w.])` : `\\b${NUMBER_WORDS[count]}\\b`;
  return new RegExp(`${numeral}[^.]{0,40}?\\btools?\\b`, "i");
}

/**
 * Asserts a mirror states the real tool COUNT, accepting a digit or the
 * spelled-out word, and rejecting every OTHER count — so "the same three
 * tools" fails the moment a fourth exists, in whichever form the prose happens
 * to use.
 *
 * SCOPED TO THE ENUMERATING SENTENCE, and that scoping is load-bearing rather
 * than a convenience. A wrong-count scan over a whole file is unsound, because
 * prose legitimately counts SUBSETS of the tool set: `create-server.ts`'s
 * header truthfully says "the two tools that do work also report their
 * outcome" (`list_indexed_repos` builds nothing, so it emits no outcome
 * event), and an earlier revision of this guard failed on that correct
 * sentence. Measured, not predicted — the whole-file version is what surfaced
 * it. So the count is asserted only where the mirror is enumerating the set:
 * the one sentence that names every registered tool. Any other count in the
 * file is about something else and is none of this guard's business.
 */
function assertStatesCount(raw: string, label: string): void {
  const flat = flatten(raw);
  const word = NUMBER_WORDS[expectedCount];

  // The enumerating sentence: the one that names every registered tool. Split
  // on sentence-ish boundaries only, since a mirror may enumerate across
  // commas and parentheses.
  const sentences = flat.split(/(?<=[.!?])\s+/);
  const enumerating = sentences.filter((s) => claimedTools(s).length === expectedCount);
  assert.ok(
    enumerating.length > 0,
    `${label} has no single sentence enumerating all ${expectedCount} registered tools ` +
      `([${expectedNames.join(", ")}]) — the count claim cannot be located, so it cannot be trusted`,
  );
  const text = enumerating.join(" ");

  assert.ok(
    toolCountRe(expectedCount, "digit").test(text) || (word ? toolCountRe(expectedCount, "word").test(text) : false),
    `${label}'s enumerating sentence does not state the real tool count ` +
      `(${expectedCount}${word ? `/"${word}"` : ""}): ${JSON.stringify(text)}. ` +
      `The server registers [${expectedNames.join(", ")}].`,
  );

  for (const n of Object.keys(NUMBER_WORDS).map(Number)) {
    if (n === expectedCount) continue;
    for (const form of ["digit", "word"] as const) {
      const match = text.match(toolCountRe(n, form));
      assert.equal(
        match,
        null,
        `${label}'s enumerating sentence still claims ${n} tools (${JSON.stringify(match?.[0])}) while the ` +
          `server registers ${expectedCount} ([${expectedNames.join(", ")}]). A stale count in prose is ` +
          `exactly the defect this guard exists for.`,
      );
    }
  }
}

/**
 * Slices the span of `text` between two markers, failing with a useful message
 * rather than silently returning "" (which would make every assertion over the
 * slice pass vacuously — the failure mode that made two earlier guards in this
 * ecosystem decorative).
 */
function span(text: string, from: string, to: string, label: string): string {
  const start = text.indexOf(from);
  assert.notEqual(start, -1, `could not locate ${label}: missing marker ${JSON.stringify(from)}`);
  const end = text.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `could not locate the end of ${label}: missing marker ${JSON.stringify(to)}`);
  const slice = text.slice(start, end);
  assert.ok(slice.trim().length > 0, `${label} resolved to an empty span`);
  return slice;
}

test("the non-tool allowlist does not shadow a real tool", async () => {
  // Guards the guard. `claimedTools` subtracts NON_TOOL_IDENTIFIERS by name,
  // so the day one of those strings becomes a registered tool, every mirror
  // would be free to omit it with the suite still green. Fail here instead.
  const shadowed = expectedNames.filter((name) => NON_TOOL_IDENTIFIERS.has(name));
  assert.deepEqual(
    shadowed,
    [],
    `NON_TOOL_IDENTIFIERS lists [${shadowed.join(", ")}], which createRepoaskServer() now registers as ` +
      `real tool(s) — remove them from the allowlist or this guard stops seeing them in every mirror`,
  );
});

test("the derived tool set is non-empty and unique", async () => {
  // Guards the guard: every assertion in this file derives from this list, so
  // an empty or duplicate-ridden one would make the whole file pass vacuously.
  assert.ok(expectedCount > 0, "createRepoaskServer() registered no tools");
  assert.equal(
    new Set(expectedNames).size,
    expectedCount,
    `duplicate tool names from createRepoaskServer(): [${expectedNames.join(", ")}]`,
  );
});

test("the runnable example scripts call exactly the registered tool set", async () => {
  // THE GAP THIS CLOSES, found by a cold re-read of the PR that added this file.
  //
  // That PR enumerated nine mirrors and missed two — these scripts — which is
  // the same incompleteness the guard exists to prevent, one level up. They
  // matter more than a doc mirror, for two reasons:
  //
  //   1. They are EXECUTABLE. Each calls `callTool({ name: "..." })` with a
  //      hardcoded literal, so a renamed tool makes them fail at runtime, not
  //      at compile time — `callTool`'s name is a plain string and `tsc` has
  //      nothing to check it against.
  //   2. They run OUTSIDE CI (real network, real GitHub), so nothing else in
  //      this repo executes them. They would rot silently.
  //
  // And they are the generators of `examples/transcript.json` and
  // `examples/http-transcript.json`, which the README presents as this repo's
  // evidence of real agent usage. A broken generator means the next transcript
  // regeneration fails or, worse, quietly records a shorter session.
  //
  // Asserted as EQUALITY, so a script that stops exercising a tool fails too:
  // a transcript covering two of three tools is weaker evidence than it looks.
  for (const script of ["run-session.ts", "run-http-session.ts"]) {
    const source = await read("examples", script);
    const called = [
      ...new Set([...source.matchAll(/name:\s*"([a-z][a-z0-9_]*)"/g)].map((m) => m[1])),
    ]
      .filter((name) => !NON_TOOL_IDENTIFIERS.has(name))
      .sort();

    assert.deepEqual(
      called,
      expectedNames,
      `examples/${script} calls [${called.join(", ")}] but the server registers ` +
        `[${expectedNames.join(", ")}] — this script is executable and runs outside CI, so a ` +
        `mismatch is a runtime failure in the generator of the repo's own evidence transcripts`,
    );
  }
});

test("every registered tool declares a schema and a real description", async () => {
  // A tool an agent cannot understand is not a usable surface, whatever the
  // mirrors say about it.
  const server = createRepoaskServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-list-mirror-guard-schemas", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.inputSchema, `tool "${tool.name}" declares no input schema`);
      assert.ok(
        (tool.description ?? "").trim().length > 20,
        `tool "${tool.name}" has no meaningful description — a calling agent has nothing to decide on`,
      );
    }
  } finally {
    await client.close();
  }
});

test("src/create-server.ts's module header names exactly the tools it registers", async () => {
  const source = await read("src", "create-server.ts");
  const header = span(source, "/**", "*/", "src/create-server.ts's module header");
  assertNamesExactly(header, "src/create-server.ts's module header");
  assertStatesCount(header, "src/create-server.ts's module header");
});

test("src/http-server.ts's module header names exactly the shared tool set", async () => {
  const source = await read("src", "http-server.ts");
  const header = span(source, "/**", "*/", "src/http-server.ts's module header");
  assertNamesExactly(header, "src/http-server.ts's module header");
});

test("api/mcp.ts's module header names exactly the tool set it serves", async () => {
  const source = await read("api", "mcp.ts");
  const header = span(source, "/**", "*/", "api/mcp.ts's module header");
  assertNamesExactly(header, "api/mcp.ts's module header");
});

test("README's 'How this differs from repoask' names exactly the tool set", async () => {
  const readme = await read("README.md");
  const section = span(readme, "## How this differs from repoask", "## Two usage modes", "that README section");
  assertNamesExactly(section, "README §'How this differs from repoask'");
});

test("README's 'Two usage modes' section names and counts the tool set", async () => {
  const readme = await read("README.md");
  const section = span(readme, "## Two usage modes", "## What it does", "that README section");
  assertNamesExactly(section, "README §'Two usage modes, one engine'");
  assertStatesCount(section, "README §'Two usage modes, one engine'");
});

test("README's machine-readable contract has one heading per registered tool", async () => {
  // This section IS the published contract: a caller that reads it instead of
  // calling tools/list sees exactly these tools and no others.
  const readme = await read("README.md");
  const section = span(
    readme,
    "## Tool schemas (machine-readable contract)",
    "## Running it",
    "README §'Tool schemas'",
  );
  const headed = section
    .split("\n")
    .filter((line) => line.startsWith("### "))
    .map((line) => line.replace(/^###\s*/, "").replace(/`/g, "").trim())
    .sort();

  assert.deepEqual(
    headed,
    expectedNames,
    `README §'Tool schemas (machine-readable contract)' documents [${headed.join(", ")}] but the ` +
      `server registers [${expectedNames.join(", ")}] — the published contract and the real surface disagree`,
  );
});

test("README's mcp_tool_called analytics row names exactly the tools that emit it", async () => {
  const readme = await read("README.md");
  const rows = readme
    .split("\n")
    .filter((line) => line.includes("mcp_tool_called") && claimedTools(line).length > 0);
  assert.equal(
    rows.length,
    1,
    `expected exactly one README row documenting mcp_tool_called's per-tool coverage, found ${rows.length}`,
  );
  assertNamesExactly(rows[0], "README's mcp_tool_called analytics row");
});

test("README's 'list_tools returns exactly' test claim matches the real tool set", async () => {
  const readme = await read("README.md");
  const claims = readme.split("\n").filter((line) => line.includes("`list_tools` returns exactly"));
  assert.equal(
    claims.length,
    1,
    `expected exactly one README claim about what list_tools returns, found ${claims.length}`,
  );
  assertNamesExactly(claims[0], "README's \"`list_tools` returns exactly …\" claim");
});

test("README's example-session claim lists exactly the tools the session calls", async () => {
  const readme = await read("README.md");
  const claims = readme.split("\n").filter((line) => line.includes("connects, calls"));
  assert.equal(claims.length, 1, `expected exactly one README example-session claim, found ${claims.length}`);
  assertNamesExactly(claims[0], "README's example-session claim");
});
