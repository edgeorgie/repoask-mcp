/**
 * Builds the environment for a spawned stdio MCP server child process.
 *
 * WHY THIS EXISTS (and why every spawn site must use it):
 *
 * `StdioClientTransport` does NOT give the child the parent's environment.
 * When its `env` option is omitted it passes only the SDK's own
 * `getDefaultEnvironment()` allow-list, which on POSIX is exactly
 * `HOME, LOGNAME, PATH, SHELL, TERM, USER` — a list "inspired by the default
 * env inheritance of sudo", per the SDK's own comment. `GITHUB_TOKEN` is not
 * on it, so a spawn that omits `env` runs the server UNAUTHENTICATED against
 * api.github.com no matter what the test runner's own environment holds.
 *
 * That is not a theoretical hazard: it made CI's `GITHUB_TOKEN` passthrough
 * inert. The job received the token, the test process saw it, and the server
 * process — the only one that actually calls GitHub — never did. The suite
 * was pinned to the unauthenticated 60 req/hour/IP limit the workflow
 * believed it had lifted to 1000, and failed with the product's own
 * "GitHub rate limit reached" message on a shared egress IP.
 *
 * `tests/stdio-env-passthrough.test.ts` derives that allow-list from the
 * installed SDK rather than restating it, so this comment cannot quietly
 * become wrong if the SDK changes which vars it inherits.
 *
 * @param options.without Variable names to withhold from the child, for tests
 *   that need to force a missing-configuration path (e.g. stripping the LLM
 *   keys to pin the deterministic fallback). Everything else is forwarded.
 */
export function serverEnv(options: { without?: readonly string[] } = {}): Record<string, string> {
  const withheld = new Set(options.without ?? []);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || withheld.has(key)) continue;
    env[key] = value;
  }
  return env;
}
