/**
 * Minimal local type declarations for Vercel's serverless request/response
 * objects, replacing the `@vercel/node` devDependency.
 *
 * WHY THIS FILE EXISTS: `@vercel/node` was the sole source of all 11 npm
 * audit advisories in this repo (10 high, 1 moderate — undici, path-to-regexp
 * ReDoS, braces, @fastify/busboy, ajv), yet it was used for nothing but
 * `import type { VercelRequest, VercelResponse }` — erased at compile time,
 * never present in any runtime path. npm's own `fixAvailable` pointed at
 * `@vercel/node@4.0.0`, but 4.0.0 is a *downgrade* from the installed
 * `^23.0.1` (23.0.1 is `latest`), and installing it measurably made things
 * worse rather than better: audit went from 11 vulnerabilities (1 moderate,
 * 10 high) to 14 (2 moderate, 11 high, 1 critical). So the advised bump was
 * not taken.
 *
 * Instead the dependency is dropped entirely. These are structural types, and
 * Vercel's runtime passes plain Node IncomingMessage/ServerResponse objects
 * augmented with `body`/`query`/`cookies` and the `status()/json()/send()`
 * helpers — exactly what is declared below and exactly what the three handlers
 * in api/ actually touch. The `@vercel/node` string in vercel.json's `builds`
 * is a *builder identifier* resolved by Vercel's platform at deploy time, not
 * an npm import, so it is unaffected by removing the local devDependency.
 *
 * Net effect: identical typechecking on the surface the handlers use, zero
 * audit advisories, and `npm ci` no longer installs 200+ packages of
 * build-tool transitive dependencies to satisfy two type aliases.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export type VercelRequestQuery = Record<string, string | string[]>;
export type VercelRequestCookies = Record<string, string>;
/** Vercel parses JSON/urlencoded bodies automatically; a raw string arrives when it can't. */
export type VercelRequestBody = unknown;

export interface VercelRequest extends IncomingMessage {
  query: VercelRequestQuery;
  cookies: VercelRequestCookies;
  body: VercelRequestBody;
}

export interface VercelResponse extends ServerResponse {
  send: (body: unknown) => VercelResponse;
  json: (jsonBody: unknown) => VercelResponse;
  status: (statusCode: number) => VercelResponse;
  redirect: (statusOrUrl: string | number, url?: string) => VercelResponse;
}
