/**
 * Guards the analytics facade's promises (src/analytics.ts).
 *
 * 1. Inert without POSTHOG_KEY. The point of merging this before a key exists
 *    is that the deployment behaves exactly as before: no request, no log
 *    line, no thrown error. "No request" is asserted by replacing the global
 *    fetch posthog-node uses with one that records every call, and "no log
 *    line" by capturing console output, so a future edit that builds the
 *    client eagerly or logs a warning fails here rather than on the stdout of
 *    the stdio transport, which IS the MCP protocol stream.
 *
 * 2. Never fails a request when a key IS set. The send is exercised against a
 *    fetch that rejects, which is what a PostHog outage looks like from inside
 *    the function, with no egress and no real key. It must resolve after
 *    exactly one attempt: the capture is awaited before the response is
 *    written, so a retry schedule would be paid by the caller's latency.
 *
 * 3. The payloads are shapes only. The builders are handed a length and a
 *    citation list, never the question text, and the tests assert the exact
 *    key set, plus what actually goes over the wire, so an added property is a
 *    deliberate, README-visible change rather than drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import {
  capture,
  chunkBucket,
  indexBuiltProperties,
  lengthBucket,
  repoAskedProperties,
} from "../src/analytics.js";

interface Sent {
  url: string;
  body: { batch: { event: string; distinct_id: string; properties: Record<string, unknown> }[] };
}

/** posthog-node may gzip the body; accept either so the test does not depend on that default. */
function decodeBody(raw: unknown): Sent["body"] {
  const bytes = typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw as Uint8Array);
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return JSON.parse((gzipped ? gunzipSync(bytes) : bytes).toString("utf8"));
}

/**
 * Runs `fn` with POSTHOG_KEY set (or unset), a recording fetch and silenced
 * console, then restores all three whatever the outcome.
 */
async function withAnalyticsEnv<T>(
  key: string | undefined,
  fetchImpl: () => Promise<Response>,
  fn: (sent: Sent[], logs: string[]) => Promise<T>,
): Promise<T> {
  const savedKey = process.env.POSTHOG_KEY;
  const savedFetch = globalThis.fetch;
  const savedConsole = { log: console.log, warn: console.warn, error: console.error };
  const sent: Sent[] = [];
  const logs: string[] = [];
  if (key === undefined) delete process.env.POSTHOG_KEY;
  else process.env.POSTHOG_KEY = key;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: input instanceof Request ? input.url : String(input),
      body: init?.body ? decodeBody(init.body) : { batch: [] },
    });
    return fetchImpl();
  }) as typeof fetch;
  for (const level of ["log", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  }
  try {
    return await fn(sent, logs);
  } finally {
    if (savedKey === undefined) delete process.env.POSTHOG_KEY;
    else process.env.POSTHOG_KEY = savedKey;
    globalThis.fetch = savedFetch;
    Object.assign(console, savedConsole);
  }
}

const ok = () => Promise.resolve(new Response(JSON.stringify({ status: 1 }), { status: 200 }));

test("without POSTHOG_KEY, capture resolves, sends nothing and logs nothing", async () => {
  await withAnalyticsEnv(
    undefined,
    () => Promise.reject(new Error("fetch must not be called without a key")),
    async (sent, logs) => {
      await capture("repo_asked", {
        surface: "web",
        repo: "octocat/spoon-knife",
        question_length_bucket: "<40",
        latency_ms: 12,
        cited: true,
        citations: 6,
      });
      await capture("index_built", { surface: "mcp", repo: "octocat/spoon-knife", chunk_bucket: "<50", duration_ms: 9 });
      await capture("mcp_tool_called", { tool: "ask_repo" });
      await capture("rate_limited", { surface: "mcp", reason: "global" });
      assert.deepEqual(sent, [], "no request may leave the process without a key");
      assert.deepEqual(logs, [], "nothing may be written to the console without a key");
    },
  );
});

test("with a key and PostHog unreachable, capture still resolves after exactly one attempt", async () => {
  await withAnalyticsEnv(
    "phc_not_a_real_key",
    () => Promise.reject(new Error("connect ECONNREFUSED")),
    async (sent) => {
      await capture("mcp_tool_called", { tool: "ask_repo" });
      assert.equal(sent.length, 1, `expected exactly one send attempt, saw ${sent.length}`);
      assert.ok(sent[0].url.startsWith("https://us.i.posthog.com/"), `unexpected analytics host: ${sent[0].url}`);
    },
  );
});

test("a send carries app and no person profile, a fresh id per event, and nothing from the caller's text", async () => {
  const question = "How does the TF-IDF index decide which chunks are relevant to a question?";
  const excerpt = "export function fitTfidf(docs) { /* retrieved file content */ }";
  const result = {
    citations: [{ rank: 1, path: "src/secret/internal-file.ts", startLine: 1, endLine: 3, score: 0.2, excerpt }],
  };
  await withAnalyticsEnv("phc_not_a_real_key", ok, async (sent) => {
    const props = repoAskedProperties("web", "Octocat", "Spoon-Knife", question.length, result, 812);
    await capture("repo_asked", props);
    await capture("repo_asked", props);
    assert.equal(sent.length, 2);

    const [first, second] = sent.map((s) => s.body.batch[0]);
    assert.equal(first.event, "repo_asked");
    assert.equal(first.properties.app, "repoask-mcp");
    assert.equal(first.properties.$process_person_profile, false);
    assert.match(first.distinct_id, /^[0-9a-f-]{36}$/, "the id must be a random UUID, not a caller identity");
    assert.notEqual(first.distinct_id, second.distinct_id, "no two events may share an id");

    const wire = JSON.stringify(sent.map((s) => s.body));
    for (const secret of [question, excerpt, result.citations[0].path]) {
      assert.ok(!wire.includes(secret), `request content must never be on the wire: ${secret}`);
    }
  });
});

test("lengthBucket uses the plan's four buckets with exact boundaries", () => {
  assert.equal(lengthBucket(0), "<40");
  assert.equal(lengthBucket(39), "<40");
  assert.equal(lengthBucket(40), "40-120");
  assert.equal(lengthBucket(119), "40-120");
  assert.equal(lengthBucket(120), "120-300");
  assert.equal(lengthBucket(299), "120-300");
  assert.equal(lengthBucket(300), "300+");
  assert.equal(lengthBucket(2000), "300+");
});

test("chunkBucket reduces an index size to a coarse band with exact boundaries", () => {
  assert.equal(chunkBucket(0), "<50");
  assert.equal(chunkBucket(49), "<50");
  assert.equal(chunkBucket(50), "50-200");
  assert.equal(chunkBucket(199), "50-200");
  assert.equal(chunkBucket(200), "200-500");
  assert.equal(chunkBucket(499), "200-500");
  assert.equal(chunkBucket(500), "500-1500");
  assert.equal(chunkBucket(1499), "500-1500");
  assert.equal(chunkBucket(1500), "1500+");
});

test("repo_asked carries shapes only: a fixed key set, a lowercased public repo, no text, no long strings", () => {
  const question = "How does the TF-IDF index decide which chunks are relevant to a question?";
  const result = {
    citations: [{ rank: 1, path: "src/retrieval.ts", startLine: 1, endLine: 3, score: 0.2, excerpt: "export function retrieve() {}" }],
  };
  const props = repoAskedProperties("mcp", "Octocat", "Spoon-Knife", question.length, result, 812);
  assert.deepEqual(props, {
    surface: "mcp",
    repo: "octocat/spoon-knife",
    question_length_bucket: "40-120",
    latency_ms: 812,
    cited: true,
    citations: 1,
  });
  const serialized = JSON.stringify(props);
  assert.ok(!serialized.includes(question), "the question text must never be in the payload");
  assert.ok(!serialized.includes(result.citations[0].excerpt), "citation text must never be in the payload");
  for (const value of Object.values(props)) {
    if (typeof value === "string") {
      assert.ok(value.length <= 64, `a property value this long is content, not a shape: ${value}`);
    }
  }
  assert.equal(repoAskedProperties("web", "a", "b", 1, { citations: [] }, 1).cited, false);
});

test("index_built carries shapes only: a fixed key set and a bucket, never an exact chunk count", () => {
  assert.deepEqual(indexBuiltProperties("web", "Octocat", "Spoon-Knife", 8, 431), {
    surface: "web",
    repo: "octocat/spoon-knife",
    chunk_bucket: "<50",
    duration_ms: 431,
  });
});
