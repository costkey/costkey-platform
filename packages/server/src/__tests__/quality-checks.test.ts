import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRule, checkAppliesToRun, type RunFacts } from "../quality-checks/rules.js";
import { isSampled, sampleBucket } from "../quality-checks/sampling.js";
import { parseJudgeReply, callJudge, JudgeProviderError } from "../quality-checks/judge.js";
import { CheckInputError, parseCheckInput, publicCheck, rowToCheck, sealJudgeKey, openJudgeKey } from "../quality-checks/store.js";
import { backoffDelay, checkWantsRun, ProjectRateLimiter } from "../quality-checks/worker.js";
import { formatTranscript, requestMessages, responseText } from "../quality-checks/transcript.js";
import { JUDGE_TEMPLATES, RULES } from "../quality-checks/templates.js";

function facts(overrides: Partial<RunFacts> = {}): RunFacts {
  return {
    traceId: "tr_1", runName: "support-agent", names: ["support-agent"],
    calls: 4, failedCalls: 0, retries: 0, spans: 3, failedSpans: 0, failedSpanNames: [], runningSpans: 0,
    toolSpans: 2, failedToolSpans: 0, traceFailed: false, cost: 0.05, unpricedCalls: 0,
    durationMs: 12_000, startedAt: "2026-10-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:12.000Z",
    ...overrides,
  };
}

test("run succeeded passes clean runs and fails on failed spans, calls or a failed trace", () => {
  assert.deepEqual(evaluateRule("run_succeeded", facts(), null), { kind: "score", value: 1, label: "pass", reason: "No failed spans or calls across 4 calls." });
  const spans = evaluateRule("run_succeeded", facts({ failedSpans: 2, failedSpanNames: ["search", "agent"] }), null);
  assert.equal(spans.kind, "score");
  if (spans.kind === "score") {
    assert.equal(spans.value, 0);
    assert.equal(spans.label, "fail");
    assert.match(spans.reason, /2 failed spans \(search, agent\)/);
  }
  const calls = evaluateRule("run_succeeded", facts({ failedCalls: 1 }), null);
  assert.equal(calls.kind === "score" && calls.label, "fail");
  const trace = evaluateRule("run_succeeded", facts({ traceFailed: true }), null);
  assert.equal(trace.kind === "score" && trace.reason, "Run failed: the run reported a failure.");
});

test("tool errors score the share of tool spans that errored against the limit", () => {
  const none = evaluateRule("tool_errors", facts({ toolSpans: 0 }), 0);
  assert.equal(none.kind, "skip");
  const some = evaluateRule("tool_errors", facts({ toolSpans: 4, failedToolSpans: 1 }), 0);
  assert.deepEqual(some.kind === "score" && [some.value, some.label], [0.75, "fail"]);
  const allowed = evaluateRule("tool_errors", facts({ toolSpans: 4, failedToolSpans: 1 }), 0.25);
  assert.equal(allowed.kind === "score" && allowed.label, "pass");
  assert.equal(allowed.kind === "score" && allowed.reason, "1 of 4 tool calls errored (25%, limit 25%).");
});

test("retries count retried calls against the limit", () => {
  const clean = evaluateRule("retries", facts(), 0);
  assert.deepEqual(clean.kind === "score" && [clean.value, clean.label], [1, "pass"]);
  const retried = evaluateRule("retries", facts({ calls: 4, retries: 1 }), 0);
  assert.deepEqual(retried.kind === "score" && [retried.value, retried.label, retried.reason], [0.75, "fail", "1 retry across 4 calls (limit 0)."]);
  const allowed = evaluateRule("retries", facts({ calls: 4, retries: 2 }), 2);
  assert.equal(allowed.kind === "score" && allowed.label, "pass");
  assert.equal(evaluateRule("retries", facts({ calls: 0 }), 0).kind, "skip");
});

test("latency and cost compare against their targets with a graded score", () => {
  const fast = evaluateRule("latency", facts({ durationMs: 12_000 }), 30);
  assert.deepEqual(fast.kind === "score" && [fast.value, fast.label], [1, "pass"]);
  const slow = evaluateRule("latency", facts({ durationMs: 60_000 }), 30);
  assert.deepEqual(slow.kind === "score" && [slow.value, slow.label, slow.reason], [0.5, "fail", "Took 60s against a target of 30s."]);
  assert.equal(evaluateRule("latency", facts({ durationMs: null }), 30).kind, "skip");
  const cheap = evaluateRule("cost", facts({ cost: 0.05 }), 0.1);
  assert.deepEqual(cheap.kind === "score" && [cheap.value, cheap.label], [1, "pass"]);
  const pricey = evaluateRule("cost", facts({ cost: 0.4, unpricedCalls: 1 }), 0.1);
  assert.deepEqual(pricey.kind === "score" && [pricey.value, pricey.label], [0.25, "fail"]);
  assert.match(pricey.kind === "score" ? pricey.reason : "", /1 call not priced yet/);
  assert.equal(evaluateRule("cost", facts({ cost: null }), 0.1).kind, "skip");
  // No target falls back to the rule's default.
  const defaulted = evaluateRule("latency", facts({ durationMs: 31_000 }), null);
  assert.equal(defaulted.kind === "score" && defaulted.label, "fail");
});

test("sampling is deterministic by run id, nested across rates and close to the rate", () => {
  const ids = Array.from({ length: 4_000 }, (_, index) => `trace_${index}`);
  for (const id of ids.slice(0, 50)) {
    assert.equal(sampleBucket(id), sampleBucket(id));
    assert.ok(sampleBucket(id) >= 0 && sampleBucket(id) < 100);
    if (isSampled(id, 10)) assert.ok(isSampled(id, 50), "a run sampled at 10% is also sampled at 50%");
  }
  const share = ids.filter((id) => isSampled(id, 25)).length / ids.length;
  assert.ok(share > 0.22 && share < 0.28, `share ${share}`);
  assert.equal(ids.every((id) => isSampled(id, 100)), true);
  assert.equal(ids.some((id) => isSampled(id, 0)), false);
});

test("applies-to matches agent or workflow names, and wants-run combines it with sampling", () => {
  assert.equal(checkAppliesToRun("all", [], { names: [] }), true);
  assert.equal(checkAppliesToRun("named", ["support-agent"], { names: ["support-agent", "triage"] }), true);
  assert.equal(checkAppliesToRun("named", ["research-agent"], { names: ["support-agent"] }), false);
  assert.equal(checkWantsRun({ sampleRate: 0, appliesTo: "all", appliesToNames: [] }, facts()), "not_sampled");
  assert.equal(checkWantsRun({ sampleRate: 100, appliesTo: "named", appliesToNames: ["x"] }, facts()), "not_applicable");
  assert.equal(checkWantsRun({ sampleRate: 100, appliesTo: "all", appliesToNames: [] }, facts()), "yes");
});

test("judge replies parse into a score, label and reason", () => {
  assert.deepEqual(parseJudgeReply('{"score": 0.8, "label": "Pass", "reason": "Answers   the question."}'), { score: 0.8, label: "pass", reason: "Answers the question." });
  assert.deepEqual(parseJudgeReply("```json\n{\"score\": 7, \"reason\": \"ok\"}\n```"), { score: 0.7, label: "pass", reason: "ok" });
  assert.equal(parseJudgeReply('Sure. {"value": 0.2, "explanation": "missed it"}').label, "fail");
  assert.throws(() => parseJudgeReply("no json here"));
  assert.throws(() => parseJudgeReply('{"score": "high"}'));
  assert.throws(() => parseJudgeReply('{"score": 500}'));
});

test("judge calls use each provider's shape and classify errors for backoff", async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fake = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    if (url.includes("anthropic")) return reply(200, { model: "claude-haiku-4-5", content: [{ type: "text", text: '{"score":1,"label":"pass","reason":"fine"}' }], usage: { input_tokens: 11, output_tokens: 7 } });
    if (url.includes("google")) return reply(200, { candidates: [{ content: { parts: [{ text: '{"score":0,"label":"fail","reason":"bad"}' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } });
    return reply(429, { error: { message: "slow down" } }, { "retry-after": "7" });
  }) as typeof fetch;

  const anthropic = await callJudge({ provider: "anthropic", model: "claude-haiku-4-5", apiKey: "sk-ant-test", rubric: "r", transcript: "t", fetchImpl: fake, endpoints: { anthropic: "https://anthropic.mock" } });
  assert.deepEqual(anthropic.result, { score: 1, label: "pass", reason: "fine" });
  assert.deepEqual(anthropic.usage, { inputTokens: 11, outputTokens: 7 });
  assert.equal(anthropic.url, "https://api.anthropic.com/v1/messages", "usage is recorded against the public endpoint");
  assert.equal(seen[0].headers["x-api-key"], "sk-ant-test");
  assert.equal(seen[0].url, "https://anthropic.mock/v1/messages");

  const google = await callJudge({ provider: "google", model: "gemini-2.5-flash", apiKey: "g-key", rubric: "r", transcript: "t", fetchImpl: fake, endpoints: { google: "https://google.mock" } });
  assert.equal(google.result?.label, "fail");
  assert.equal(seen[1].url, "https://google.mock/v1beta/models/gemini-2.5-flash:generateContent");
  assert.equal(seen[1].headers["x-goog-api-key"], "g-key");

  await assert.rejects(
    callJudge({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test", rubric: "r", transcript: "t", fetchImpl: fake, endpoints: { openai: "https://openai.mock" } }),
    (error: unknown) => error instanceof JudgeProviderError && error.retryable && error.status === 429 && error.retryAfterMs === 7_000,
  );
  const unauthorized = (async () => reply(401, { error: "bad key" })) as typeof fetch;
  await assert.rejects(
    callJudge({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test", rubric: "r", transcript: "t", fetchImpl: unauthorized }),
    (error: unknown) => error instanceof JudgeProviderError && !error.retryable && error.status === 401,
  );
  const offline = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(
    callJudge({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test", rubric: "r", transcript: "t", fetchImpl: offline }),
    (error: unknown) => error instanceof JudgeProviderError && error.retryable && error.status === null,
  );
});

test("backoff doubles to a cap and the rate limiter holds a sliding minute", () => {
  assert.deepEqual([1, 2, 3, 4].map((attempt) => backoffDelay(attempt, 30_000, 100_000)), [30_000, 60_000, 100_000, 100_000]);
  const limiter = new ProjectRateLimiter(2);
  assert.equal(limiter.take("p", 0), 0);
  assert.equal(limiter.take("p", 1_000), 0);
  assert.equal(limiter.take("p", 2_000), 58_000);
  assert.equal(limiter.take("other", 2_000), 0, "limits are per project");
  assert.equal(limiter.take("p", 60_001), 0);
});

test("provider keys round-trip through encryption and never appear in the API shape", () => {
  const sealed = sealJudgeKey("sk-live-abcdef123456");
  assert.notEqual(sealed.encrypted, "sk-live-abcdef123456");
  assert.ok(!sealed.encrypted.includes("abcdef123456"));
  assert.equal(sealed.hint, "3456");
  const check = rowToCheck({
    id: "qc_1", project_id: "p", name: "Judge", kind: "judge", template: "answered", rubric: "r",
    judge_provider: "openai", judge_model: "gpt-4o-mini", judge_key_encrypted: sealed.encrypted, judge_key_hint: sealed.hint,
    applies_to: "all", applies_to_names: [], sample_rate: 100, enabled: true, created_at: new Date(), updated_at: new Date(),
  });
  assert.equal(openJudgeKey(check), "sk-live-abcdef123456");
  const shown = JSON.stringify(publicCheck(check));
  assert.ok(!shown.includes("sk-live") && !shown.includes(sealed.encrypted));
  assert.match(shown, /"hasKey":true/);
  assert.match(shown, /"keyHint":"3456"/);
  assert.equal(openJudgeKey({ judgeKeyEncrypted: `${sealed.encrypted.slice(0, -2)}xx` }), null, "a tampered key fails closed");
});

test("check input validation fills template defaults and rejects bad values", () => {
  const judge = parseCheckInput({ kind: "judge", template: "faithfulness", judgeProvider: "google", apiKey: "  AIzaTestKey12345  " });
  assert.equal(judge.name, "Faithfulness");
  assert.equal(judge.rubric, JUDGE_TEMPLATES.find((item) => item.id === "faithfulness")?.rubric);
  assert.equal(judge.judgeModel, "gemini-2.5-flash");
  assert.equal(judge.apiKey, "AIzaTestKey12345");
  const rule = parseCheckInput({ kind: "rule", rule: "latency" });
  assert.equal(rule.name, "Latency");
  assert.equal(rule.target, RULES.find((item) => item.id === "latency")?.target?.default);
  for (const bad of [
    { kind: "nope" },
    { kind: "rule", rule: "made_up" },
    { kind: "rule", rule: "latency", target: -1 },
    { kind: "judge", rubric: "" },
    { kind: "judge", template: "answered", judgeProvider: "mistral" },
    { kind: "judge", template: "answered", apiKey: "short" },
    { kind: "rule", rule: "cost", sampleRate: 101 },
    { kind: "rule", rule: "cost", appliesTo: "named", appliesToNames: [] },
  ]) assert.throws(() => parseCheckInput(bad), CheckInputError, JSON.stringify(bad));
  const existing = rowToCheck({ id: "qc_2", project_id: "p", name: "Cost", kind: "rule", rule: "cost", target: 0.1, applies_to: "all", applies_to_names: [], sample_rate: 100, enabled: true });
  assert.deepEqual(parseCheckInput({ enabled: false }, existing), { kind: "rule", rule: "cost", enabled: false });
  assert.throws(() => parseCheckInput({ kind: "judge" }, existing), CheckInputError);
});

test("transcripts read OpenAI, Anthropic and Gemini bodies", () => {
  const openai = requestMessages({ messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Where is my order?" }] });
  assert.equal(openai.system, "Be brief.");
  assert.deepEqual(openai.messages, [{ role: "user", text: "Where is my order?" }]);
  const anthropic = requestMessages(JSON.stringify({ system: [{ type: "text", text: "Sys" }], messages: [{ role: "user", content: [{ type: "tool_result", content: "Order 42 shipped" }] }] }));
  assert.equal(anthropic.system, "Sys");
  assert.equal(anthropic.messages[0].text, "[tool result] Order 42 shipped");
  assert.equal(requestMessages({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }).messages[0].text, "hi");
  assert.equal(responseText({ choices: [{ message: { content: "It shipped." } }] }), "It shipped.");
  assert.equal(responseText({ content: [{ type: "text", text: "Done" }] }), "Done");
  assert.equal(responseText({ candidates: [{ content: { parts: [{ text: "Yes" }] } }] }), "Yes");
  const text = formatTranscript({ system: null, question: "Q?", steps: ["Tool result: x"], answer: "A." });
  assert.match(text, /## User request\nQ\?/);
  assert.match(text, /1\. Tool result: x/);
  assert.match(text, /## Final answer\nA\./);
});
