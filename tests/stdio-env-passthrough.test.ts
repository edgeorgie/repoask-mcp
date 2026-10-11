/**
 * Regression guard for a silent, CI-invisible defect: a stdio MCP server
 * spawned WITHOUT an explicit `env` does not receive `GITHUB_TOKEN`.
 *
 * THE BUG THIS EXISTS TO PREVENT
 *
 * `.github/workflows/ci.yml` passes `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`
 * to the Test step, with a comment explaining it lifts GitHub's limit from 60
 * requests/hour/IP (shared across Actions' egress) to 1000. That reasoning is
 * correct and the token really does reach the test runner — but the process
 * that calls api.github.com is the SERVER CHILD, and the SDK's
 * `StdioClientTransport` gives the child only `getDefaultEnvironment()` when
 * `env` is omitted. The token never crossed the process boundary, so the suite
 * stayed pinned to the unauthenticated limit the workflow believed it had
 * lifted, and failed with the product's own "GitHub rate limit reached"
 * message — a failure that looks like a product bug and is a test-harness bug.
 *
 * It is invisible to every other signal in this repo: typecheck, build and
 * audit never spawn a server, and the suite goes green whenever the shared
 * runner IP happens to have budget left, so the defect surfaces as flakiness
 * attributable to GitHub rather than to this code.
 *
 * WHY THESE ASSERTIONS AND NOT A SIMPLER ONE
 *
 * 1. The allow-list is DERIVED from the installed SDK (`getDefaultEnvironment`),
 *    never restated. A hardcoded copy would be exactly the hand-maintained
 *    mirror this repo has already been bitten by: if a future SDK starts
 *    inheriting `GITHUB_TOKEN` the first assertion becomes vacuous, and we want
 *    that to show up as a RED test rather than a guard quietly protecting
 *    nothing.
 * 2. The source-level assertion scans every spawn site by AST-free but
 *    structural means (each `new StdioClientTransport({...})` literal must
 *    contain an `env:` key). A behavioural test can only prove the sites it
 *    itself exercises; the guard has to fail for a NEW spawn site added later
 *    by someone unaware of this trap, which is the realistic reintroduction
 *    path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serverEnv } from "./helpers/server-env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

/** Files that spawn a stdio server and therefore must pass an explicit `env`. */
const SPAWN_SITE_FILES = [
  "tests/server.test.ts",
  "tests/zero-key-fallback.test.ts",
  "examples/run-session.ts",
];

test("the SDK's default child environment really does omit GITHUB_TOKEN", () => {
  // Derived from the installed SDK, not copied from its docs: this is the
  // premise the whole guard rests on, so it must be measured, not assumed.
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "sentinel-value-for-this-assertion";
  try {
    const inherited = getDefaultEnvironment();
    assert.equal(
      inherited.GITHUB_TOKEN,
      undefined,
      "The installed MCP SDK now forwards GITHUB_TOKEN to spawned servers by default. " +
        "That is good news and makes the explicit `env` passthrough redundant, but this " +
        "guard's premise no longer holds — re-read tests/helpers/server-env.ts and this " +
        "file's header before relaxing anything.",
    );
    // Paired positive control: proves getDefaultEnvironment() is actually
    // reading this process's environment at all. Without this, a stubbed or
    // broken implementation returning `{}` would satisfy the assertion above
    // for entirely the wrong reason.
    assert.equal(
      inherited.PATH,
      process.env.PATH,
      "getDefaultEnvironment() should forward PATH; if it forwards nothing, the " +
        "GITHUB_TOKEN assertion above is vacuous.",
    );
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test("serverEnv() forwards GITHUB_TOKEN, which is the whole point of it existing", () => {
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "sentinel-value-for-this-assertion";
  try {
    assert.equal(serverEnv().GITHUB_TOKEN, "sentinel-value-for-this-assertion");
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test("serverEnv({ without }) withholds exactly the named variables and nothing else", () => {
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "sentinel-value-for-this-assertion";
  try {
    const env = serverEnv({ without: ["GITHUB_TOKEN"] });
    assert.equal(env.GITHUB_TOKEN, undefined, "the named variable must be withheld");
    assert.equal(env.PATH, process.env.PATH, "unnamed variables must still be forwarded");
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test("every StdioClientTransport spawn site passes an explicit env", async () => {
  // Scans source text rather than behaviour on purpose: the reintroduction
  // path is a NEW spawn site added by someone who has not read this file, and
  // no behavioural test can cover a call site that does not exist yet.
  let sitesChecked = 0;

  for (const relative of SPAWN_SITE_FILES) {
    const source = await fs.readFile(path.join(ROOT, relative), "utf8");
    const marker = "new StdioClientTransport(";
    let from = 0;

    for (;;) {
      const start = source.indexOf(marker, from);
      if (start === -1) break;
      from = start + marker.length;

      // Walk the balanced parens of this one constructor call so a later
      // spawn site in the same file cannot satisfy an earlier one's check.
      let depth = 0;
      let end = start + marker.length - 1;
      for (let i = end; i < source.length; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }

      const call = source.slice(start, end + 1);
      sitesChecked++;
      assert.match(
        call,
        /\benv\s*:/,
        `${relative} spawns a stdio server without an explicit \`env\`. The SDK then ` +
          `forwards only its own allow-list, which excludes GITHUB_TOKEN, so the server ` +
          `child calls api.github.com unauthenticated (60 req/hour/IP) no matter what the ` +
          `parent process holds. Pass \`env: serverEnv()\` — see tests/helpers/server-env.ts. ` +
          `Offending call:\n${call}`,
      );
    }
  }

  // Guards against the silent-skip failure mode this repo has already shipped
  // twice: a scan that matches nothing passes for the wrong reason.
  assert.ok(
    sitesChecked >= SPAWN_SITE_FILES.length,
    `expected at least one spawn site per listed file, found ${sitesChecked} across ` +
      `${SPAWN_SITE_FILES.length} files — did a file move or get renamed?`,
  );
});

test("the spawn-site file list covers every file in the repo that spawns a server", async () => {
  // The list above is itself a hand-maintained mirror, so derive the real set
  // and assert the mirror equals it — otherwise a new spawning file simply
  // goes unchecked and the guard above still passes.
  const roots = ["tests", "examples", "src", "api"];
  // This guard file contains the literal marker in its own scanning logic and
  // error messages while never spawning anything, so it would match itself.
  // Excluded by exact path rather than by a looser pattern, so a genuine spawn
  // site added to any OTHER file is still caught.
  const SELF = path.relative(ROOT, fileURLToPath(import.meta.url));
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(path.join(ROOT, dir), { withFileTypes: true });
    } catch {
      return; // directory is optional
    }
    for (const entry of entries) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(relative);
        continue;
      }
      if (!/\.(ts|mts|mjs|js)$/.test(entry.name)) continue;
      if (relative === SELF) continue;
      const source = await fs.readFile(path.join(ROOT, relative), "utf8");
      if (source.includes("new StdioClientTransport(")) found.push(relative);
    }
  }

  for (const root of roots) await walk(root);

  assert.deepEqual(
    found.sort(),
    [...SPAWN_SITE_FILES].sort(),
    "A file spawns a stdio MCP server but is not in SPAWN_SITE_FILES (or vice versa), so " +
      "the explicit-env guard above does not cover it. Update the list in this file.",
  );
});
