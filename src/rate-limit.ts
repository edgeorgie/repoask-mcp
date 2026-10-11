/**
 * In-memory rate limiting for the public, unauthenticated HTTP endpoints
 * (/mcp, /api/ask-repo, /api/index-repo — anything that can reach
 * doAskRepo's LLM synthesis path in src/llm.ts or the GitHub-fetching
 * indexer in src/indexer.ts).
 *
 * Ported from edgeorgie/ask-edgeorgie-mcp's src/rate-limit.ts deliberately
 * unchanged in approach, config shape and 429 response format, so the two
 * sibling MCP servers stay consistent for anyone reading both.
 *
 * WHY THIS EXISTS, AND WHY IT IS MORE URGENT HERE THAN IN THE SIBLING:
 * an ANTHROPIC_API_KEY *is* configured on this deployment today, so
 * POST /api/ask-repo already returns answerMode: "llm" (model
 * claude-haiku-4-5) and every anonymous request bills the repo owner's own
 * Anthropic account. The README publishes the exact working curl. Worse,
 * `owner`/`repo` are caller-chosen, so a caller also controls how much
 * indexed repository content gets stuffed into each prompt — i.e. they
 * control the per-call token cost, not just the call count. Unmetered, that
 * is an open-ended spend primitive pointed at someone else's wallet.
 *
 * Two independent limits are enforced:
 *   1. Per-caller sliding window — keyed by client IP (best-effort; see
 *      getClientId below). Generous enough for normal MCP client usage
 *      (tools/list + a couple of real questions) but caps any single caller.
 *   2. Global hard ceiling — a cap on TOTAL requests/minute across every
 *      caller, independent of the per-IP key. This is the "cost ceiling
 *      regardless of auth" backstop: IP-based limiting can be defeated by
 *      spoofing X-Forwarded-For or rotating source IPs, but the global
 *      ceiling still bounds worst-case request volume (and therefore
 *      worst-case LLM spend) hitting this process no matter how callers are
 *      identified.
 *
 * IMPLEMENTATION NOTE / KNOWN LIMITATION: this is a plain in-memory sliding
 * window (a Map of timestamps), which is the right level of effort for a
 * low-traffic portfolio demo, but it does NOT survive serverless reality on
 * Vercel:
 *   - Each cold start gets a fresh, empty Map, resetting all counters.
 *   - Concurrent requests landing on different warm instances each see their
 *     own independent Map, so the "global" ceiling is actually per-instance,
 *     not truly global across the deployment.
 * It therefore raises the cost of abuse substantially without being a hard
 * spend cap. The real hard ceiling belongs at the billing layer (an Anthropic
 * spend limit on the key). Before this endpoint is put under real load,
 * replace this with a distributed store shared across instances — e.g.
 * Upstash Redis or Vercel KV with INCR + TTL / a sliding-window Lua script —
 * so limits hold across cold starts and horizontal scaling.
 */

interface CallerState {
  timestamps: number[];
}

const PER_CALLER_WINDOW_MS = 60_000;
const PER_CALLER_MAX_REQUESTS = 10;

const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX_REQUESTS = 60;

/**
 * Maximum accepted question length, in characters.
 *
 * The question is concatenated verbatim into the LLM prompt alongside
 * retrieved repository chunks, so an unbounded question is an unbounded
 * input-token bill per call. 2000 characters is far longer than any real
 * question a human or agent asks about a repo (the README's own examples are
 * under 60), while being short enough that it cannot dominate prompt cost.
 * Enforced on every route that reaches doAskRepo.
 */
const MAX_QUESTION_LENGTH = 2000;

const callerState = new Map<string, CallerState>();
let globalTimestamps: number[] = [];

/** Drop timestamps older than `windowMs` from an array (returns a new filtered array). */
function pruneOld(timestamps: number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs;
  return timestamps.filter((t) => t > cutoff);
}

/** Opportunistic cleanup so callerState doesn't grow unboundedly across a long-lived warm instance. */
function pruneStaleCallers(now: number): void {
  for (const [key, state] of callerState) {
    const kept = pruneOld(state.timestamps, now, PER_CALLER_WINDOW_MS);
    if (kept.length === 0) {
      callerState.delete(key);
    } else {
      state.timestamps = kept;
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds the caller should wait before retrying, set whenever allowed is false. */
  retryAfterSeconds?: number;
  /** Which limit tripped, for logging/debugging. */
  reason?: "per-caller" | "global";
}

/**
 * Checks and records one request attempt for `callerId`. Call this exactly
 * once per inbound request, before doing any real work.
 */
export function checkRateLimit(callerId: string, now: number = Date.now()): RateLimitResult {
  // Global hard ceiling first: this is the no-key-required cost ceiling that
  // protects the deployment even if per-caller identity is spoofed/rotated.
  globalTimestamps = pruneOld(globalTimestamps, now, GLOBAL_WINDOW_MS);
  if (globalTimestamps.length >= GLOBAL_MAX_REQUESTS) {
    const oldestInWindow = globalTimestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + GLOBAL_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSeconds, reason: "global" };
  }

  // Per-caller sliding window.
  if (callerState.size > 10_000) {
    pruneStaleCallers(now);
  }
  const existing = callerState.get(callerId);
  const priorTimestamps = existing ? pruneOld(existing.timestamps, now, PER_CALLER_WINDOW_MS) : [];
  if (priorTimestamps.length >= PER_CALLER_MAX_REQUESTS) {
    const oldestInWindow = priorTimestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + PER_CALLER_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSeconds, reason: "per-caller" };
  }

  // Record the attempt in both counters.
  priorTimestamps.push(now);
  callerState.set(callerId, { timestamps: priorTimestamps });
  globalTimestamps.push(now);

  return { allowed: true };
}

/**
 * Best-effort caller identity from a Node-style request's headers/socket.
 * X-Forwarded-For is attacker-controllable (hence the global ceiling above
 * as a backstop), but it's the only per-caller signal available behind
 * Vercel's edge network, which terminates the real client IP there.
 */
export function getClientId(req: {
  headers: Record<string, unknown> | { [key: string]: string | string[] | undefined };
  socket?: { remoteAddress?: string };
}): string {
  const xff = (req.headers as Record<string, string | string[] | undefined>)["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return xff[0];
  }
  const realIp = (req.headers as Record<string, string | string[] | undefined>)["x-real-ip"];
  if (typeof realIp === "string" && realIp.length > 0) {
    return realIp;
  }
  if (req.socket?.remoteAddress) {
    return req.socket.remoteAddress;
  }
  return "unknown";
}

export interface QuestionLengthResult {
  ok: boolean;
  /** Human-readable rejection reason, set whenever ok is false. */
  error?: string;
}

/**
 * Rejects questions long enough to be a cost-amplification vector. Returns a
 * result rather than throwing so each route can map it to its own error shape
 * (REST JSON vs JSON-RPC).
 */
export function checkQuestionLength(question: string): QuestionLengthResult {
  if (question.length > MAX_QUESTION_LENGTH) {
    return {
      ok: false,
      error: `Question too long: ${question.length} characters (maximum ${MAX_QUESTION_LENGTH}).`,
    };
  }
  return { ok: true };
}

/** Test-only: resets all in-memory counters so tests don't bleed into each other. */
export function _resetForTests(): void {
  callerState.clear();
  globalTimestamps = [];
}

export const RATE_LIMIT_CONFIG = {
  PER_CALLER_WINDOW_MS,
  PER_CALLER_MAX_REQUESTS,
  GLOBAL_WINDOW_MS,
  GLOBAL_MAX_REQUESTS,
  MAX_QUESTION_LENGTH,
};
