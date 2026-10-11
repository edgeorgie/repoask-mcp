/**
 * Server-side product analytics: the only place this repo talks to PostHog.
 * The cross-project plan is docs/POSTHOG_PLAN.md in edgeorgie/edgeorgie-portfolio,
 * and this file deliberately matches the facade in edgeorgie/ask-edgeorgie-mcp so
 * both MCP servers report with one grammar.
 *
 * WHY THIS SHAPE. The two public surfaces (the web UI's REST routes and the MCP
 * tools) share one engine, and the question this module exists to answer is
 * "which repos get asked about, through which surface, and does it stay fast",
 * never "who asked what". So every event carries shapes of use only: enums,
 * booleans, counts, durations in milliseconds, length buckets, and the public
 * owner/name of a public GitHub repository. The question text, the answer,
 * retrieved excerpts and file contents, caller IPs, emails and names are never
 * passed in here, and the payload builders below take the question's LENGTH
 * and a citation COUNT rather than the question or the citations, so the text
 * cannot reach this module by accident.
 *
 * OFF BY DEFAULT. Without POSTHOG_KEY nothing happens: no client is built, no
 * request leaves the process, nothing is logged, and importing this module
 * starts nothing. That matters doubly for the stdio transport, whose stdout IS
 * the MCP protocol stream.
 *
 * NEVER FAILS A REQUEST. `capture` resolves either way: the send is wrapped in
 * try/catch, retries are off and the request timeout is short. Callers still
 * await it, before the response is written, because a Vercel function may be
 * frozen as soon as its response ends, which is exactly when a batched,
 * fire-and-forget capture would be in flight. That is why `captureImmediate`
 * is used instead of `capture` plus a periodic flush.
 */

import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import type { AskRepoResult } from "./engine.js";

/** The whole allowlist. Adding an event means adding it here and to the README. */
export type AnalyticsEvent = "repo_asked" | "index_built" | "mcp_tool_called" | "rate_limited";

/** Where a request came from: the static web UI (via the REST routes) or an MCP client. */
export type Surface = "web" | "mcp";

/** Primitives only, so no object or array of user content can be passed by mistake. */
export type AnalyticsProperties = Record<string, string | number | boolean>;

export type LengthBucket = "<40" | "40-120" | "120-300" | "300+";
export type ChunkBucket = "<50" | "50-200" | "200-500" | "500-1500" | "1500+";

const APP = "repoask-mcp";
const HOST = "https://us.i.posthog.com";
/**
 * Bounds what an analytics outage can cost a request, since the send is
 * awaited before the response is written: one attempt, then the event is
 * dropped. posthog-node's defaults (3 retries, 3 s apart, 10 s timeout) would
 * otherwise hold an answer for most of a minute while PostHog is down.
 */
const REQUEST_TIMEOUT_MS = 3000;

let client: PostHog | undefined;

function getClient(): PostHog | null {
  const key = process.env.POSTHOG_KEY;
  if (!key) return null;
  // flushAt 1 / flushInterval 0 keep the client from ever holding a queue or
  // a timer; captureImmediate below bypasses the queue regardless.
  client ??= new PostHog(key, {
    host: HOST,
    flushAt: 1,
    flushInterval: 0,
    fetchRetryCount: 0,
    requestTimeout: REQUEST_TIMEOUT_MS,
  });
  return client;
}

/** Buckets, not raw lengths: a raw length is a small fingerprint, a bucket is not. */
export function lengthBucket(length: number): LengthBucket {
  if (length < 40) return "<40";
  if (length < 120) return "40-120";
  if (length < 300) return "120-300";
  return "300+";
}

/**
 * Coarse size of a built index. The indexer caps a repository at 80 files of
 * up to 80 KB, so these bands separate "a README and little else" from "hit
 * the cap" without reporting an exact count.
 */
export function chunkBucket(chunkCount: number): ChunkBucket {
  if (chunkCount < 50) return "<50";
  if (chunkCount < 200) return "50-200";
  if (chunkCount < 500) return "200-500";
  if (chunkCount < 1500) return "500-1500";
  return "1500+";
}

/**
 * GitHub owner and repo names are case-insensitive, so lowercase them: one
 * repository is one series however a caller typed it. Only ever called after
 * the engine has fetched the repository from GitHub, so the value is a real
 * public repository, not arbitrary caller text.
 */
function repoLabel(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

/**
 * The `repo_asked` payload, built in one place so the web and MCP surfaces
 * cannot drift apart: the point of sharing the event name is one chart with
 * both surfaces on it. Reads nothing from `result` but the citation count.
 */
export function repoAskedProperties(
  surface: Surface,
  owner: string,
  repo: string,
  questionLength: number,
  result: Pick<AskRepoResult, "citations">,
  latencyMs: number,
): AnalyticsProperties {
  return {
    surface,
    repo: repoLabel(owner, repo),
    question_length_bucket: lengthBucket(questionLength),
    latency_ms: latencyMs,
    cited: result.citations.length > 0,
    citations: result.citations.length,
  };
}

/** The `index_built` payload: the repository and the size and cost of the index, nothing from inside it. */
export function indexBuiltProperties(
  surface: Surface,
  owner: string,
  repo: string,
  chunkCount: number,
  durationMs: number,
): AnalyticsProperties {
  return {
    surface,
    repo: repoLabel(owner, repo),
    chunk_bucket: chunkBucket(chunkCount),
    duration_ms: durationMs,
  };
}

/**
 * Records one event. A no-op without POSTHOG_KEY; otherwise one awaited send
 * that resolves even if PostHog is unreachable.
 */
export async function capture(event: AnalyticsEvent, properties: AnalyticsProperties): Promise<void> {
  const posthog = getClient();
  if (!posthog) return;
  try {
    await posthog.captureImmediate({
      // A fresh id per event: nothing links two requests, and no person
      // profile is created ($process_person_profile: false), matching the
      // cookieless browser side of the owner's portfolio.
      distinctId: randomUUID(),
      event,
      properties: { app: APP, ...properties, $process_person_profile: false },
    });
  } catch {
    // Analytics is observability, not the product: a failed send is dropped
    // and the caller's response is unaffected.
  }
}
