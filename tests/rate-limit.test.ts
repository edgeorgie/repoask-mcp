/**
 * Unit tests for the in-memory rate limiter and question-length cap
 * (src/rate-limit.ts), used by /mcp, /api/ask-repo and /api/index-repo.
 * No network/server needed — exercises the pure logic directly so it's fast
 * and deterministic.
 *
 * Mirrors edgeorgie/ask-edgeorgie-mcp's tests/rate-limit.test.ts, plus the
 * question-length cases that are specific to this repo (where an
 * ANTHROPIC_API_KEY is actually configured on the deployment, so prompt size
 * is a real cost lever).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkRateLimit,
  checkQuestionLength,
  getClientId,
  _resetForTests,
  RATE_LIMIT_CONFIG,
} from "../src/rate-limit.js";

test("allows requests under the per-caller limit", () => {
  _resetForTests();
  const now = Date.now();
  for (let i = 0; i < RATE_LIMIT_CONFIG.PER_CALLER_MAX_REQUESTS; i++) {
    const result = checkRateLimit("1.2.3.4", now + i);
    assert.equal(result.allowed, true, `request ${i} should be allowed`);
  }
});

test("blocks a caller once they exceed the per-caller limit, with Retry-After", () => {
  _resetForTests();
  const now = Date.now();
  for (let i = 0; i < RATE_LIMIT_CONFIG.PER_CALLER_MAX_REQUESTS; i++) {
    checkRateLimit("5.6.7.8", now + i);
  }
  const blocked = checkRateLimit("5.6.7.8", now + RATE_LIMIT_CONFIG.PER_CALLER_MAX_REQUESTS);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "per-caller");
  assert.ok(typeof blocked.retryAfterSeconds === "number" && blocked.retryAfterSeconds > 0);
});

test("a different caller is not blocked by another caller's usage", () => {
  _resetForTests();
  const now = Date.now();
  for (let i = 0; i < RATE_LIMIT_CONFIG.PER_CALLER_MAX_REQUESTS; i++) {
    checkRateLimit("9.9.9.9", now + i);
  }
  const otherCaller = checkRateLimit("1.1.1.1", now + RATE_LIMIT_CONFIG.PER_CALLER_MAX_REQUESTS);
  assert.equal(otherCaller.allowed, true, "different caller should not share the first caller's bucket");
});

test("the window resets once enough time has elapsed", () => {
  _resetForTests();
  const now = Date.now();
  for (let i = 0; i < RATE_LIMIT_CONFIG.PER_CALLER_MAX_REQUESTS; i++) {
    checkRateLimit("2.2.2.2", now + i);
  }
  const blocked = checkRateLimit("2.2.2.2", now + 1);
  assert.equal(blocked.allowed, false);
  const afterWindow = checkRateLimit("2.2.2.2", now + RATE_LIMIT_CONFIG.PER_CALLER_WINDOW_MS + 1000);
  assert.equal(afterWindow.allowed, true, "request after the window has fully elapsed should be allowed again");
});

test("the process-wide ceiling trips even across many distinct caller IDs", () => {
  _resetForTests();
  const now = Date.now();
  let lastResult;
  for (let i = 0; i < RATE_LIMIT_CONFIG.GLOBAL_MAX_REQUESTS + 5; i++) {
    // Every request uses a unique caller ID, so the per-caller limit never trips —
    // only the process-wide ceiling can block these.
    lastResult = checkRateLimit(`caller-${i}`, now + i);
  }
  assert.equal(lastResult!.allowed, false);
  assert.equal(lastResult!.reason, "global");
  // SCOPE OF THIS TEST, stated so it is not over-read: it proves the ceiling
  // works WITHIN one process. It cannot and does not prove a deployment-wide
  // limit — in production, 150 concurrent requests were measured getting 200
  // with zero 429s, because each serverless instance holds its own counters.
  // See the MEASURED LIMITATION block in src/rate-limit.ts. Closing that hole
  // needs cross-instance state and would need an integration test, not this
  // single-process unit test.
});

test("getClientId prefers x-forwarded-for, then x-real-ip, then the socket", () => {
  assert.equal(getClientId({ headers: { "x-forwarded-for": "203.0.113.7, 70.41.3.18" } }), "203.0.113.7");
  assert.equal(getClientId({ headers: { "x-real-ip": "198.51.100.4" } }), "198.51.100.4");
  assert.equal(getClientId({ headers: {}, socket: { remoteAddress: "192.0.2.9" } }), "192.0.2.9");
  assert.equal(getClientId({ headers: {} }), "unknown");
});

test("a question at the length cap is accepted", () => {
  const atLimit = "a".repeat(RATE_LIMIT_CONFIG.MAX_QUESTION_LENGTH);
  const result = checkQuestionLength(atLimit);
  assert.equal(result.ok, true, "a question exactly at the cap must be accepted");
});

test("an over-long question is rejected with a message naming the cap", () => {
  const tooLong = "a".repeat(RATE_LIMIT_CONFIG.MAX_QUESTION_LENGTH + 1);
  const result = checkQuestionLength(tooLong);
  assert.equal(result.ok, false, "a question over the cap must be rejected");
  assert.match(
    result.error ?? "",
    /Question too long/,
    "rejection must explain why, so a caller can fix the request",
  );
  assert.ok(
    (result.error ?? "").includes(String(RATE_LIMIT_CONFIG.MAX_QUESTION_LENGTH)),
    "rejection must state the actual maximum",
  );
});
