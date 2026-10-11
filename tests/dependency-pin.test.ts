/**
 * Makes this repo's git-dependency pin self-enforcing.
 *
 * `@edgeorgie/retrieval-core` is consumed straight from GitHub rather than the
 * npm registry. A bare `github:owner/repo` spec means "whatever that branch's
 * HEAD happens to be at install time", and this repo shipped in exactly that
 * state until #14 pinned the spec by SHA. The drift is not theoretical and not
 * confined to the lockfile text: with the lockfile fully intact, plain
 * `npm install` was measured moving the installed package from `40f3c5a` to
 * `279fe9f` on 3/3 runs, and the EXECUTING code changed with it
 * (`tokenize("toString")` output changed). Nothing in this repo had a sensor
 * for that — the suite, `tsc`, `build`, `npm audit` and the deploy check were
 * all green in both states, which is why it survived every prior review.
 *
 * That matters more here than in most consumers: `retrieval-core` IS this
 * server's retrieval layer, so a silent dependency swap silently changes every
 * answer and every citation the product returns.
 *
 * #14 applied the pin by hand, so nothing stopped the next dependency edit (or
 * a well-meaning `npm install <pkg>` rewriting the manifest) from dropping the
 * fragment and restoring floating installs. This file is that guard, ported
 * from the sibling corpus server where it was hardened against two real holes
 * worth not reintroducing — see REGISTRY_SPEC below.
 *
 * The assertions are DERIVED, not hardcoded: the expected SHA is read out of
 * the lockfile's `resolved` URL at runtime, so a legitimate dependency bump
 * never requires editing this file. It fails only when the manifest and the
 * lockfile disagree, or when a pin disappears.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(repoRoot, relPath), "utf8"));
}

/** `github:owner/repo#<sha>` / `git+ssh://...#<sha>` — the fragment is the pin. */
const SHA_FRAGMENT = /#([0-9a-f]{40})$/;

/**
 * Specs that resolve to the npm REGISTRY. Everything else is treated as a git
 * dependency.
 *
 * Detection is by EXCLUSION so that an unrecognised form fails CLOSED. Three
 * earlier revisions each missed a real floating git spec and were measured
 * passing, which is why this is now structural rather than a pattern list:
 *
 *   1. Inclusion matching (`/^(github:|git\+|git:)/`) cannot see npm's
 *      shorthand `owner/repo#ref`, which has no scheme prefix at all.
 *   2. Excluding anything starting with a digit cannot see `0xowner/repo#main`
 *      — GitHub usernames may begin with a digit, and npm's own
 *      `npm-package-arg` classifies that spec as `type: "git"`.
 *   3. A hand-written list of semver-range shapes leaks wherever a range
 *      alternative is unanchored or over-broad. The previous revision excluded
 *      a bare `latest` and a hyphen range without pinning either to the whole
 *      string, so `latest/repo#main`, `latestowner/repo#main` and
 *      `1-2/repo#main` were all classified as registry ranges and silently
 *      dropped from the checked set — `npm-package-arg` calls all three
 *      `type: "git"`, committish `main`. Measured: 2 pass / 0 fail, against an
 *      `0xowner/` control that correctly went 0/2.
 *
 * Hole 3 is the reason this no longer tries to describe semver. Enumerating
 * valid range syntax to decide what is NOT a git spec is the wrong direction:
 * every omission is a silent skip. Instead it leans on the one structural fact
 * that separates the two families — **a git spec always contains a `/`**
 * (`owner/repo`, `git+https://host/path`, `gitlab:owner/repo`), and a semver
 * range never does, nor does it contain a `#` committish. So:
 *
 *   - an explicit non-git scheme (`npm:`, `file:`, `link:`, `workspace:`) is a
 *     registry/local spec, checked first because `file:../pkg` does contain a
 *     slash;
 *   - otherwise, a spec with no `/` and no `#` is a version range;
 *   - everything else is treated as git and REPORTED.
 *
 * That inverts the failure mode: a form this guard has never seen is now
 * reported rather than skipped, no matter how it is spelled.
 */
const NON_GIT_SCHEME = /^(npm|file|link|workspace):/;

function isRegistrySpec(spec: string): boolean {
  const trimmed = spec.trim();
  if (NON_GIT_SCHEME.test(trimmed)) return true;
  return !trimmed.includes("/") && !trimmed.includes("#");
}

/**
 * EVERY dependency field npm installs from, not just the two obvious ones.
 *
 * The previous revision read `dependencies` and `devDependencies` only, so a
 * floating `github:evil/pkg` in any other field sat alongside the intact pin
 * with the suite green (measured: 2 pass / 0 fail for all five). `overrides`
 * is the sharpest of these — it re-floats a transitive dependency tree-wide,
 * which can un-pin the very package this guard exists to pin while
 * `dependencies` still shows a perfect SHA.
 */
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "overrides",
  "resolutions",
] as const;
/**
 * A git-dependency spec found in the manifest, with enough context to name
 * exactly where it lives in a failure message.
 *
 * `where` is the full manifest path (`overrides.foo`), `pkg` is the package
 * name alone — the two differ for everything outside `dependencies`, and the
 * lockfile is keyed by `pkg`, not by `where`.
 */
interface GitDep {
  where: string;
  pkg: string;
  spec: string;
}

/** Fields whose entries npm installs as a direct `node_modules/<pkg>` entry. */
const DIRECT_INSTALL_FIELDS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
]);

function gitDependencies(manifest: Record<string, unknown>): GitDep[] {
  const found: GitDep[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const section = manifest[field];
    if (!section || typeof section !== "object") continue;
    for (const [name, spec] of Object.entries(section as Record<string, unknown>)) {
      // `overrides` and `resolutions` permit a nested object form
      // (`{"pkg": {"sub": "spec"}}`). Only the leaf string is a spec; a nested
      // object is descended into so a floating spec one level down is still
      // seen rather than skipped as "not a string".
      if (typeof spec === "string") {
        found.push({ where: `${field}.${name}`, pkg: name, spec });
      } else if (spec && typeof spec === "object") {
        for (const [sub, subSpec] of Object.entries(spec as Record<string, unknown>)) {
          if (typeof subSpec === "string") {
            found.push({ where: `${field}.${name}.${sub}`, pkg: sub, spec: subSpec });
          }
        }
      }
    }
  }
  return found.filter(({ spec }) => !isRegistrySpec(spec));
}

test("every git dependency is pinned to a full 40-hex commit SHA, not a floating ref", async () => {
  const manifest = await readJson("package.json");
  const gitDeps = gitDependencies(manifest);

  // Guards the guard: if this repo ever stops consuming a git dependency, the
  // loop below would iterate zero times and assert nothing about anything.
  //
  // The remedy named here is deliberately NOT "delete this file". The most
  // likely way to reach an empty set is not that the dependency was removed on
  // purpose — it is that a manifest edit changed its spec into a form
  // `gitDependencies()` no longer recognises, which is the exact regression
  // this guard exists to catch. Telling the next maintainer to delete the
  // guard on that signal hands them the loaded gun.
  assert.ok(
    gitDeps.length > 0,
    "gitDependencies() matched NOTHING in package.json. Do not delete this file on this " +
      "signal. Either (a) the git dependency was genuinely removed — confirm by hand that " +
      "package.json's dependencies are all registry ranges, and only then retire this guard, " +
      "or (b) its spec changed into a form this guard cannot see, which is the exact " +
      "regression it exists to catch. Check case (b) first.",
  );

  for (const { where, spec } of gitDeps) {
    assert.match(
      spec,
      SHA_FRAGMENT,
      `"${where}" is declared as "${spec}", which floats to whatever the ref resolves to at install time. Append "#<40-hex-sha>" to pin it.`,
    );
  }
});

test("the declared pin is the commit the lockfile actually installs", async () => {
  const [manifest, lockfile] = await Promise.all([
    readJson("package.json"),
    readJson("package-lock.json"),
  ]);
  const packages = (lockfile.packages ?? {}) as Record<string, { resolved?: string }>;

  // Scoped to the fields that produce a direct `node_modules/<pkg>` entry.
  // `overrides`/`resolutions`/`peerDependencies` legitimately name packages
  // this repo does not install directly, so requiring a lockfile entry for
  // them would fail on correct manifests. Their SHA pinning is still enforced
  // by the test above — this one only checks that a declared pin is not
  // cosmetic, which is only meaningful where npm installs from it.
  const direct = gitDependencies(manifest).filter(({ where }) =>
    DIRECT_INSTALL_FIELDS.has(where.split(".")[0]),
  );

  for (const { where, pkg, spec } of direct) {
    const declared = spec.match(SHA_FRAGMENT)?.[1];
    assert.ok(declared, `"${where}" is not SHA-pinned (covered by the test above)`);

    const entry = packages[`node_modules/${pkg}`];
    assert.ok(entry, `"${where}" is declared in package.json but absent from package-lock.json`);

    const locked = entry.resolved?.match(SHA_FRAGMENT)?.[1];
    assert.ok(
      locked,
      `"${where}" has no SHA in its lockfile "resolved" URL (${entry.resolved ?? "missing"})`,
    );
    assert.equal(
      locked,
      declared,
      `"${where}" manifest/lockfile disagree: package.json pins ${declared}, the lockfile installs ${locked}. The manifest pin is cosmetic in this state — the lockfile is what npm ci obeys.`,
    );
  }
});
