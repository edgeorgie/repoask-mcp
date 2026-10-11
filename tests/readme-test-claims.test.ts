/**
 * Derived guard for the README's test-count claim.
 *
 * THE DRIFT THIS EXISTS TO PREVENT
 *
 * The README said "All four files together are 20 tests" and, separately,
 * "npm test (stdio, 20/20 tests across …)". By the time anyone noticed, the
 * real suite was 34 tests across 7 files. Nothing could have caught it: a
 * prose count is invisible to the compiler, to CI, and to every other test in
 * the repo — the one class of mirror drift this repo had already killed twice
 * in code (the `CORPUS_FILES` mirror, the hand-maintained tool arrays) while
 * leaving the prose copy of the same mistake live.
 *
 * (That "34 across 7" is itself a stated count in prose, and the first
 * revision of this comment got it wrong — it said 39 across 8, which a cold
 * review measured against the pre-change tree and refuted. A file whose
 * thesis is that unguarded prose counts go stale had a stale prose count in
 * its own header. Historical figures cannot be derived, so the only defence
 * is to state them once, measured, and keep them out of the live claims the
 * assertions below actually check.)
 *
 * It matters more here than a typo would: the README is this repo's evidence
 * surface. A reader checking the claim runs `npm test`, sees a different
 * number, and now reasonably distrusts every other number on the page —
 * including the measured ones that are true.
 *
 * WHY IT IS DERIVED THIS WAY
 *
 * The expected values are computed by discovering test files exactly the way
 * `package.json`'s `test` script does (`tests/*.test.ts`) and counting the
 * `test(` declarations inside them. Writing the numbers into a constant here
 * would just relocate the mirror one file over — the thing being asserted has
 * to be read from the real suite, so adding a test file or a single `test()`
 * case makes this assertion fail until the prose is updated.
 *
 * Deliberately NOT asserted: a pass/fail count (that is the test runner's job
 * and would make this file's result depend on the rest of the suite), and the
 * per-file counts (churn with no reader value). Only the two numbers the
 * README actually commits to.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

/**
 * Counts top-level `test("…")` declarations in a source file. Matches the
 * suite's own shape: every test in this repo is declared at column 0, so this
 * needs no parser and cannot be fooled by the word "test" in prose or by a
 * `test(` reference nested inside a comment block at indentation.
 */
function countTests(source: string): number {
  return source.split("\n").filter((line) => line.startsWith("test(")).length;
}

async function discoverSuite(): Promise<{ files: string[]; tests: number }> {
  // Mirrors package.json's `test` script glob: `tests/*.test.ts` — top level
  // only, which is why tests/helpers/ is not picked up.
  const entries = await fs.readdir(path.join(ROOT, "tests"), { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
    .map((e) => path.join("tests", e.name))
    .sort();

  let tests = 0;
  for (const file of files) {
    tests += countTests(await fs.readFile(path.join(ROOT, file), "utf8"));
  }
  return { files, tests };
}

test("the test-counting helper is not vacuous", async () => {
  // Positive control. Without this, a `countTests` that always returned 0
  // (wrong glob, renamed directory, changed declaration style) would make
  // every assertion below compare 0 against a README that also said 0 — or
  // fail for a reason that looks like drift when it is really a broken guard.
  assert.equal(countTests('test("a", () => {});\ntest("b", () => {});\n'), 2);
  assert.equal(countTests('  test("indented, not top-level", () => {});\n'), 0);
  assert.equal(countTests("// test(\"in a comment\")\n"), 0);

  const { files, tests } = await discoverSuite();
  assert.ok(files.length >= 5, `expected to discover the real suite, found ${files.length} files`);
  assert.ok(tests >= files.length, `expected at least one test per file, found ${tests}`);
});

test("the README's test-count sentence matches the real suite", async () => {
  const { files, tests } = await discoverSuite();
  const readme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");

  const claim = /The suite is \*\*(\d+) tests across (\d+) files\*\*\./.exec(readme);
  assert.ok(
    claim,
    'README.md must contain exactly the sentence "The suite is **N tests across M files**." ' +
      "so this guard can check it. If the wording changed, update the pattern here too — " +
      "do not delete the assertion.",
  );

  assert.equal(
    Number(claim[1]),
    tests,
    `README claims ${claim[1]} tests; the suite really has ${tests}. Update the README ` +
      `sentence (and do not add the number anywhere else — one stated count, derived here).`,
  );
  assert.equal(
    Number(claim[2]),
    files.length,
    `README claims ${claim[2]} test files; the suite really has ${files.length} ` +
      `(${files.join(", ")}).`,
  );
});

test("no other place in the README restates a test count", async () => {
  // One stated count, in one place, guarded. A second copy is a second thing
  // to forget — which is exactly how the original "20/20" survived: it
  // appeared twice, and both were wrong.
  const readme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");
  const GUARDED = /The suite is \*\*\d+ tests across \d+ files\*\*\./g;

  // Excise the one sanctioned sentence first, then scan what remains — so the
  // guarded claim cannot satisfy or trip its own exclusivity check.
  const rest = readme.replace(GUARDED, "");
  const stray = rest.match(/\b\d+\/\d+\s+tests?\b|\b\d+\s+tests?\s+(?:across|in)\b/gi) ?? [];

  assert.deepEqual(
    stray,
    [],
    `README restates a test count outside the one guarded sentence: ${stray.join(", ")}. ` +
      `Remove it or fold it into the guarded sentence.`,
  );

  // Positive control: the excision must be surgical, not a blanket wipe.
  assert.match(readme, GUARDED, "the guarded sentence itself must still be present");
});
