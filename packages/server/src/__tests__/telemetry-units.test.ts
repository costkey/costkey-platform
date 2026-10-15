import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KEEP_STRING_KEYS, multipartSkeleton, sanitizeUrl, skeleton, telemetryFor } from "./helpers/skeleton.js";
import { extractCall } from "../telemetry/extract.js";
import { filterRawStack, normalizeRawCallSite, parseRawStack } from "../telemetry/callsite.js";
import { estimateUsageBounds } from "../telemetry/admission.js";
import { admissionRequestFields } from "../admission.js";
import { expandLiveKitEvent } from "../telemetry/livekit.js";
import { callGraphFromUpload, computeCallGraphScores, isAiCallExpression } from "../telemetry/callgraph.js";
import { classifyError } from "../telemetry/errors.js";
import { customExtractor } from "../telemetry/custom-providers.js";
import { applyCallTelemetry, telemetryForStorage } from "../telemetry/event.js";
import { isInternalFrame } from "../ingest.js";
import { normalizeAccountingEvent, InvalidAccountingEventError } from "../accounting.js";
import { computeCost } from "../pricing.js";
import { costFromRates } from "../price-catalog/compute.js";

describe("reference skeleton", () => {
  it("keeps allowlisted short strings and replaces the rest by code-point length", () => {
    const result = skeleton({ model: "gpt-4o", prompt: "héllo 👋", id: "x".repeat(201), tags: ["model"] }) as Record<string, unknown>;
    assert.equal(result["model"], "gpt-4o");
    assert.deepEqual(result["prompt"], { $s: 7 });
    assert.deepEqual(result["id"], { $s: 201 });
    // Strings in arrays have no key: always a length.
    assert.deepEqual(result["tags"], [{ $s: 5 }]);
    assert.ok(KEEP_STRING_KEYS.has("created_at"));
  });

  it("cuts long arrays to 8 items plus $more, truncates at depth 12, nulls NaN", () => {
    const result = skeleton({ data: Array.from({ length: 40 }, (_, i) => i), score: Number.NaN, inf: Infinity }) as Record<string, unknown>;
    assert.deepEqual(result["data"], [0, 1, 2, 3, 4, 5, 6, 7, { $more: 32 }]);
    assert.equal(result["score"], null);
    assert.equal(result["inf"], null);
    assert.deepEqual(skeleton(Array.from({ length: 32 }, () => 1)), Array.from({ length: 32 }, () => 1));
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 14; i++) deep = { next: deep };
    let node = skeleton(deep) as Record<string, unknown>;
    let depth = 0;
    while (node["next"] && !(node["next"] as Record<string, unknown>)["$trunc"]) {
      node = node["next"] as Record<string, unknown>;
      depth++;
    }
    assert.equal(depth, 11); // objects at depth 0..11 kept; the one at depth 12 is {$trunc}
    assert.deepEqual(node["next"], { $trunc: true });
  });

  it("caps a skeleton at 64 KB by truncating the deepest subtrees first", () => {
    const wide = { a: Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`key_${i}`, { nested: { values: Array.from({ length: 30 }, (_, j) => j) } }])) };
    assert.ok(Buffer.byteLength(JSON.stringify(wide)) > 64 * 1024);
    const result = skeleton(wide);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
    const sample = (result as Record<string, Record<string, unknown>>)["a"]!["key_0"];
    assert.deepEqual(sample, { nested: { values: { $trunc: true } } });
  });

  it("describes multipart forms and strips credentials from the query", () => {
    assert.deepEqual(multipartSkeleton([{ name: "file", filename: "a.wav", contentType: "audio/wav", bytes: 10 }, { name: "model", value: "whisper-1" }, { name: "prompt", value: "secret words" }]), {
      $multipart: [{ name: "file", filename: { $s: 5 }, contentType: "audio/wav", bytes: 10 }, { name: "model", value: "whisper-1" }, { name: "prompt", value: { $s: 12 } }],
    });
    assert.equal(
      sanitizeUrl("https://x.example/v1/listen?model=nova-3&key=abc&X-Amz-Signature=s&alt=sse&code=1&Authorization=t"),
      "https://x.example/v1/listen?model=nova-3&alt=sse",
    );
  });
});

describe("server extraction details", () => {
  it("counts characters from $s lengths and gates request units on success", () => {
    const ok = extractCall(telemetryFor({ url: "https://api.elevenlabs.io/v1/text-to-speech/v1", requestBody: { text: "naïve 😀" }, status: 200, responseBytes: 10 }))!;
    assert.deepEqual(ok.usage?.nativeUnits, { characters: 7 });
    assert.equal(ok.model, "eleven_multilingual_v2");
    const rejected = extractCall(telemetryFor({ url: "https://api.elevenlabs.io/v1/text-to-speech/v1", requestBody: { text: "naïve" }, status: 401, responseBody: { detail: { status: "invalid_api_key" } } }))!;
    assert.equal(rejected.usage, null);
  });

  it("reads Deepgram's model from the kept query string", () => {
    const derived = extractCall(telemetryFor({ url: "https://api.deepgram.com/v1/listen?model=nova-3-medical&key=secret", requestBytes: 100, status: 200, responseBody: { metadata: { duration: 3 } } }))!;
    assert.equal(derived.model, "nova-3-medical");
    assert.ok(!derived.url!.includes("secret"));
  });

  it("applies project custom providers after the built-ins", () => {
    const custom = customExtractor({ id: "cp_1", name: "acme-llm", hostname: "llm.acme.internal", usageInputPath: "meta.in", usageOutputPath: "meta.out", modelPath: "model" })!;
    const derived = extractCall(telemetryFor({ url: "https://llm.acme.internal/generate", requestBody: { model: "acme-7b" }, status: 200, responseBody: { meta: { in: 12, out: 4 } } }), { customExtractors: [custom] })!;
    assert.equal(derived.provider, "acme-llm");
    assert.equal(derived.model, "acme-7b");
    assert.deepEqual([derived.usage?.inputTokens, derived.usage?.outputTokens, derived.usage?.totalTokens], [12, 4, 16]);
    // A custom host can't take over a built-in provider.
    const builtin = customExtractor({ id: "cp_2", name: "evil", hostname: "api.openai.com", usageInputPath: null, usageOutputPath: null, modelPath: null })!;
    assert.equal(extractCall(telemetryFor({ url: "https://api.openai.com/v1/chat/completions", requestBody: { model: "gpt-4o" }, status: 200, responseBody: {} }), { customExtractors: [builtin] })!.provider, "openai");
  });

  it("reads Claude Agent SDK messages from the response skeleton", () => {
    const derived = extractCall({
      v: 1, source: "claude-agent-sdk", request: null, stream: null, error: null, startedAt: "2026-10-11T09:00:00.000Z", durationMs: 5000,
      response: { status: null, body: skeleton({ type: "result", subtype: "success", total_cost_usd: 0.42, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 }, modelUsage: { "claude-sonnet-4-5-20250929": { inputTokens: 10 } }, result: "done" }) },
    })!;
    assert.equal(derived.provider, "anthropic");
    assert.equal(derived.model, "claude-sonnet-4-5-20250929");
    assert.equal(derived.costUsd, 0.42);
    assert.deepEqual([derived.usage?.inputTokens, derived.usage?.cacheReadTokens, derived.usage?.cacheCreationTokens], [10, 300, 40]);
  });

  it("caps the stored envelope by dropping stream chunks first", () => {
    const big = { v: 1, stream: { format: "sse", chunks: Array.from({ length: 300 }, () => ({ pad: "x".repeat(1000) })), chunkCount: 300 } };
    const stored = telemetryForStorage(big)!;
    assert.deepEqual((stored["stream"] as Record<string, unknown>)["chunks"], [{ $trunc: true }]);
  });

  it("maps raw error names to cancelled or failed", () => {
    assert.deepEqual(classifyError("AbortError"), { outcome: "cancelled", errorType: null });
    assert.deepEqual(classifyError("CancelledError"), { outcome: "cancelled", errorType: null });
    // A Python stream the app closed or dropped before its end.
    assert.deepEqual(classifyError("GeneratorExit"), { outcome: "cancelled", errorType: null });
    assert.deepEqual(classifyError("asyncio.exceptions.CancelledError"), { outcome: "cancelled", errorType: null });
    assert.deepEqual(classifyError("Error", "ABORT_ERR"), { outcome: "cancelled", errorType: null });
    assert.deepEqual(classifyError("RateLimitError"), { outcome: "failed", errorType: "RateLimitError" });
    assert.deepEqual(classifyError(undefined), { outcome: "failed", errorType: "Error" });
  });

  it("maps lifecycle and span errorName on the server", () => {
    const base = { id: "lc_1", eventType: "lifecycle", entityType: "trace", entityId: "tr_1", timestamp: "2026-10-11T09:00:00.000Z" };
    const cancelled = normalizeAccountingEvent({ ...base, lifecycle: "failed", errorName: "AbortError" });
    assert.equal(cancelled.lifecycle, "cancelled");
    assert.equal(cancelled.errorType, null);
    const failed = normalizeAccountingEvent({ ...base, lifecycle: "ended", errorName: "ValueError" });
    assert.equal(failed.lifecycle, "failed");
    assert.equal(failed.errorType, "ValueError");
    assert.equal(normalizeAccountingEvent({ ...base, lifecycle: "ended" }).lifecycle, "completed");
    assert.equal(normalizeAccountingEvent({ ...base, lifecycle: "started", errorName: "AbortError" }).lifecycle, "started");
    // SDK 0.6 events are unchanged.
    const legacy = normalizeAccountingEvent({ ...base, lifecycle: "failed", errorType: "TimeoutError" });
    assert.deepEqual([legacy.lifecycle, legacy.errorType], ["failed", "TimeoutError"]);
    const span = { id: "sp_1", eventType: "span", name: "tool", traceId: "tr_1", timestamp: "2026-10-11T09:00:00.000Z" };
    assert.equal(normalizeAccountingEvent({ ...span, status: "ended", errorName: "CancelledError" }).spanStatus, "cancelled");
    const errored = normalizeAccountingEvent({ ...span, status: "error", errorName: "KeyError" });
    assert.deepEqual([errored.spanStatus, errored.errorType], ["error", "KeyError"]);
    assert.equal(normalizeAccountingEvent({ ...span, status: "running", errorName: "AbortError" }).spanStatus, "running");
  });
});

describe("raw call sites", () => {
  const v8 = [
    "Error",
    "    at captureCallSite (/app/node_modules/costkey/dist/stack.js:10:5)",
    "    at costKeyFetchWrapper (/app/node_modules/costkey/dist/fetch-patch.js:80:20)",
    "    at OpenAI.makeRequest (/app/node_modules/openai/core.js:300:10)",
    "    at async summarize (/app/src/summarize.ts:12:3)",
    "    at async handler (/app/src/routes.ts:40:9)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
  ].join("\n");

  it("parses a V8 stack innermost first and filters its raw text like the frames", () => {
    const frames = parseRawStack(v8);
    assert.equal(frames.length, 6);
    assert.equal(frames[3]!.functionName, "summarize");
    const callSite = normalizeRawCallSite({ raw: v8 }, isInternalFrame)!;
    assert.equal(callSite.frames.length, 6, "frames are filtered later by filterFrames");
    assert.equal(callSite.raw, ["Error", "    at async summarize (/app/src/summarize.ts:12:3)", "    at async handler (/app/src/routes.ts:40:9)"].join("\n"));
  });

  it("parses a Python stack (outermost first) and drops internal frames with their source lines", () => {
    const raw = [
      '  File "/app/main.py", line 10, in <module>\n    run()\n',
      '  File "/app/pipeline.py", line 22, in run\n    summarize(doc)\n',
      '  File "/venv/lib/python3.12/site-packages/openai/_base_client.py", line 900, in request\n    return self._request(...)\n',
      '  File "/venv/lib/python3.12/site-packages/costkey/patch.py", line 40, in send\n    capture_call_site()\n',
    ].join("");
    const frames = parseRawStack(raw);
    assert.deepEqual(frames.map((frame) => frame.functionName), ["send", "request", "run", "<module>"]);
    const filtered = filterRawStack(raw, isInternalFrame);
    assert.ok(!filtered.includes("site-packages"));
    assert.ok(!filtered.includes("self._request"));
    assert.ok(filtered.includes("summarize(doc)"));
  });

  it("keeps structured frames when sent and filters with the server's extended patterns", () => {
    const callSite = normalizeRawCallSite({ raw: null, frames: [{ functionName: "send", fileName: "/app/node_modules/@aws-sdk/client/x.js", lineNumber: 1, columnNumber: 1 }, { function_name: "main", file_name: "/app/a.py", line_number: 3 }] }, isInternalFrame)!;
    assert.equal(callSite.frames.length, 2);
    assert.equal(callSite.frames[1]!.functionName, "main");
    assert.equal(isInternalFrame(callSite.frames[0]!), true);
    assert.equal(isInternalFrame({ functionName: "_make_api_call", fileName: "/venv/lib/python3.12/site-packages/botocore/client.py", lineNumber: 1, columnNumber: null }), true);
    // Frameworks stay: the server keeps them as attribution context.
    assert.equal(isInternalFrame({ functionName: "view", fileName: "/venv/lib/python3.12/site-packages/django/core/handlers/base.py", lineNumber: 1, columnNumber: null }), false);
  });

  it("normalizes the call site when telemetry is applied to an event", () => {
    const event: Record<string, unknown> = {
      id: "e1", callSite: { raw: v8 },
      telemetry: telemetryFor({ url: "https://api.openai.com/v1/chat/completions", requestBody: { model: "gpt-4o" }, status: 200, responseBody: { id: "c1", model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1 } } }),
    };
    const applied = applyCallTelemetry(event, { isInternalFrame })!;
    assert.equal(applied.derived.provider, "openai");
    assert.equal(event["chargeId"], "c1");
    assert.ok(!String((event["callSite"] as Record<string, unknown>)["raw"]).includes("node_modules"));
  });
});

describe("admission from the request skeleton", () => {
  it("bounds input by request bytes and output by max-token fields", () => {
    const telemetry = telemetryFor({ url: "https://api.anthropic.com/v1/messages", requestBody: { model: "claude-sonnet-4-5", max_tokens: 1024, messages: [{ role: "user", content: "hello" }] }, status: 200 });
    const request = telemetry["request"] as Record<string, unknown>;
    assert.deepEqual(estimateUsageBounds(request), { maxInputTokens: request["bytes"], maxOutputTokens: 1024 });
    assert.deepEqual(estimateUsageBounds({ body: skeleton({ generationConfig: { maxOutputTokens: 77 } }), bytes: 50 }), { maxInputTokens: 50, maxOutputTokens: 77 });
    assert.deepEqual(estimateUsageBounds({ body: skeleton({ inferenceConfig: { maxTokens: 5 } }), bytes: 9 }), { maxInputTokens: 9, maxOutputTokens: 5 });
    assert.equal(estimateUsageBounds({ body: multipartSkeleton([{ name: "file", bytes: 9 }]), bytes: 900 }), undefined);
    assert.equal(estimateUsageBounds({ body: { $bytes: 900 }, bytes: 900 }), undefined);
  });

  it("falls back to a conservative byte bound when bytes are missing", () => {
    const bounds = estimateUsageBounds({ body: { prompt: { $s: 10 }, max_tokens: 3 } })!;
    assert.ok(bounds.maxInputTokens! >= 40);
    // A skeleton that lost content can't bound the request.
    assert.equal(estimateUsageBounds({ body: { messages: [{ $s: 1 }, { $more: 50 }] } })?.maxInputTokens, undefined);
  });

  it("derives provider and model and keeps accepting legacy usageBounds", () => {
    const telemetry = telemetryFor({ url: "https://api.openai.com/v1/chat/completions", requestBody: { model: "gpt-4.1", max_completion_tokens: 200, messages: [] }, status: 200 });
    const fromSkeleton = admissionRequestFields({ provider: "ignored", request: telemetry["request"] });
    assert.equal(fromSkeleton.provider, "openai");
    assert.equal(fromSkeleton.model, "gpt-4.1");
    assert.equal(fromSkeleton.usageBounds["maxOutputTokens"], 200);
    const viaEnvelope = admissionRequestFields({ telemetry: { request: telemetry["request"] } });
    assert.equal(viaEnvelope.provider, "openai");
    const legacy = admissionRequestFields({ provider: "openai", usageBounds: { maxInputTokens: 10, maxOutputTokens: 20 } });
    assert.deepEqual([legacy.provider, legacy.usageBounds], [null, { maxInputTokens: 10, maxOutputTokens: 20 }]);
    const legacyAlias = admissionRequestFields({ request: { maxInputTokens: 3 } });
    assert.deepEqual(legacyAlias.usageBounds, { maxInputTokens: 3 });
  });
});

describe("LiveKit raw rows", () => {
  const golden = JSON.parse(readFileSync(new URL("./fixtures/livekit-golden.json", import.meta.url), "utf8")) as { records: Array<Record<string, unknown>> };
  const rows = [
    { type: "llm_usage", provider: "openai", model: "gpt-4o-mini", inputTokens: 100, outputTokens: 20, inputCachedTokens: 10 },
    { type: "llm_usage", provider: "openai", model: "gpt-4o-mini", inputTokens: 50, outputTokens: 5 },
    { type: "stt_usage", provider: "deepgram", model: "nova-3", audioDurationMs: 12000 },
    { type: "tts_usage", provider: "cartesia", model: "sonic-2", charactersCount: 300, audioDurationMs: 9000 },
    { type: "interruption_usage", provider: "livekit", numRequests: 3 },
  ];
  const event = {
    id: "lk_raw_7", timestamp: "2026-10-11T09:00:00.000Z",
    telemetry: {
      v: 1, source: "livekit",
      livekit: {
        sessionId: "room-42", revision: 7, conversationId: "conv-1", expectedComponents: ["llm", "stt", "tts"], excludeComponents: [],
        createdAt: 1760173200000,
        update: skeleton({ type: "session_usage_updated", usage: { modelUsage: rows } }),
      },
    },
  };

  it("classifies, sums and converts units exactly as SDK 0.6.1 recordLiveKitUsage did", () => {
    const expanded = expandLiveKitEvent(event);
    assert.equal(expanded.length, golden.records.length);
    for (const [index, expected] of golden.records.entries()) {
      const actual = expanded[index]!;
      for (const field of ["id", "componentId", "chargeId", "provider", "usage", "billingUnits", "unitKind", "unitValue", "unit", "aggregation", "revision", "context", "timestamp", "metadata"]) {
        assert.deepEqual(actual[field], expected[field], `${String(expected["id"])}.${field}`);
      }
      assert.equal(actual["model"] ?? undefined, expected["model"]);
      assert.equal(actual["eventType"], "usage");
      // Every expansion is a valid usage envelope.
      normalizeAccountingEvent(actual);
    }
  });

  it("handles Python snake_case rows (durations already in seconds) and component selection", () => {
    const expanded = expandLiveKitEvent({
      id: "x", telemetry: { v: 1, source: "livekit", livekit: {
        sessionId: "s", revision: 1, excludeComponents: ["llm"],
        update: skeleton({ usage: { model_usage: [
          { type: "tts_usage", provider: "elevenlabs", model: "eleven_flash_v2_5", characters_count: 120, audio_duration: 4.5 },
          { type: "llm_usage", provider: "openai", model: "gpt-4o", input_tokens: 5, output_tokens: 6 },
          { provider: "deepgram", model: "nova-3", audio_duration: 7 },
        ] } }),
      } },
    });
    assert.deepEqual(expanded.map((item) => item["componentId"]), ["livekit:s:stt:deepgram:nova-3", "livekit:s:tts:elevenlabs:eleven_flash_v2_5"]);
    assert.deepEqual(expanded[0]!["usage"], { audioSeconds: 7 });
    assert.deepEqual(expanded[1]!["usage"], { characters: 120, audioSeconds: 4.5 });
    assert.equal(expanded[1]!["unitKind"], "characters");
  });

  it("flags mixed unit families instead of guessing a billable unit", () => {
    const [llm] = expandLiveKitEvent({ id: "x", telemetry: { v: 1, source: "livekit", livekit: { sessionId: "s", revision: 2, rows: skeleton([{ type: "llm_usage", provider: "openai", model: "gpt-realtime", inputTokens: 5, sessionDurationMs: 60000 }]) } } });
    assert.equal(llm!["billingUnits"], undefined);
    assert.deepEqual((llm!["context"] as Record<string, unknown>)["voiceBilling"], { status: "selection_required", componentId: "livekit:s:llm:openai:gpt-realtime", reason: "mixed_native_unit_families" });
  });

  it("rejects a payload without a session or revision", () => {
    assert.throws(() => expandLiveKitEvent({ id: "x", telemetry: { v: 1, source: "livekit", livekit: { revision: 1 } } }), InvalidAccountingEventError);
    assert.throws(() => expandLiveKitEvent({ id: "x", telemetry: { v: 1, source: "livekit", livekit: { sessionId: "s", revision: -1 } } }), InvalidAccountingEventError);
  });
});

describe("Python call graph scoring", () => {
  it("matches costkey-python 0.6.1 compute_scores for the raw format", () => {
    const raw = {
      "app/llm.py:call_model": { line: 10, callees: [], callExpressions: ["self.client.chat.completions.create"] },
      "app/llm.py:call_with_retry": { line: 20, callees: ["app/llm.py:call_model", "app/llm.py:call_model"], callExpressions: ["call_model", "time.sleep"] },
      "app/pipeline.py:summarize": { line: 5, callees: ["app/llm.py:call_with_retry"], callExpressions: ["call_with_retry"] },
      "app/pipeline.py:classify": { line: 30, callees: ["app/llm.py:call_with_retry"], callExpressions: ["call_with_retry"] },
      "app/main.py:run": { line: 3, callees: ["app/pipeline.py:summarize", "app/pipeline.py:classify"], callExpressions: [] },
      "app/main.py:cli": { line: 50, callees: ["app/main.py:run"], callExpressions: [] },
      "app/util.py:fmt": { line: 1, callees: [], callExpressions: ["str.format"] },
      "app/agent.py:Agent.step": { line: 12, callees: ["app/util.py:fmt"], callExpressions: ["genai_model.generate_content", "fmt"] },
    };
    // Expected values computed by costkey-python 0.6.1 `compute_scores` on the same graph.
    assert.deepEqual(computeCallGraphScores(raw), {
      "app/agent.py:Agent.step": { line: 12, score: 5, fan_in: 0, calls_ai: true },
      "app/llm.py:call_model": { line: 10, score: 25, fan_in: 2, calls_ai: true },
      "app/llm.py:call_with_retry": { line: 20, score: 5, fan_in: 2, calls_ai: false },
      "app/main.py:run": { line: 3, score: 10, fan_in: 1, calls_ai: false },
      "app/pipeline.py:classify": { line: 30, score: 0, fan_in: 1, calls_ai: false },
      "app/pipeline.py:summarize": { line: 5, score: 0, fan_in: 1, calls_ai: false },
      "app/util.py:fmt": { line: 1, score: -5, fan_in: 1, calls_ai: false },
    });
  });

  it("accepts bare-name callees and keeps a pre-scored upload as sent", () => {
    const scored = callGraphFromUpload({ "a.py:f": { line: 1, callees: ["g"], callExpressions: [] }, "a.py:g": { line: 2, callees: [], callExpressions: ["client.messages.create"] } });
    assert.deepEqual(scored["a.py:f"], { line: 1, score: -15, fan_in: 0, calls_ai: false });
    const legacy = { "a.py:f": { line: 1, score: 3, fan_in: 0, calls_ai: true } };
    assert.equal(callGraphFromUpload(legacy), legacy);
    assert.equal(isAiCallExpression("client.responses.create"), true);
    assert.equal(isAiCallExpression("client.create"), false);
  });
});

describe("pricing consistency", () => {
  it("prices DeepSeek cache misses as ordinary input, from both SDK generations", () => {
    // deepseek-chat built-in: $0.14/M input, $0.014/M cache hit, $0.28/M output.
    const fixed = computeCost("deepseek-chat", 1000, 50, 768, null, "deepseek");
    const legacy = computeCost("deepseek-chat", 1000, 50, 768, 232, "deepseek");
    const expected = (232 * 0.14 + 768 * 0.014 + 50 * 0.28) / 1_000_000;
    assert.ok(Math.abs(fixed! - expected) < 1e-12);
    assert.equal(legacy, fixed);
  });

  it("prices Anthropic 1-hour cache writes at their own rate", () => {
    const fiveMinuteOnly = computeCost("claude-sonnet-4-5", 0, 0, 0, 5000, "anthropic");
    const withOneHour = computeCost("claude-sonnet-4-5", 0, 0, 0, 5000, "anthropic", null, null, 4000);
    assert.ok(Math.abs(fiveMinuteOnly! - 5000 * 3.75 / 1e6) < 1e-12);
    assert.ok(Math.abs(withOneHour! - (1000 * 3.75 + 4000 * 6) / 1e6) < 1e-12);
    const catalog = costFromRates({ input: 3e-6, output: 15e-6, cacheWrite: 3.75e-6, cacheWrite1h: 6e-6, searchPerQuery: 0.01, searchBilling: "request" }, {
      inputTokens: 0, outputTokens: 0, cacheCreationTokens: 5000, nativeUnits: { cacheCreation1hTokens: 4000, cacheCreation5mTokens: 1000, webSearchRequests: 2 },
    }, "anthropic", "claude-sonnet-4-5");
    assert.ok(Math.abs(catalog! - (1000 * 3.75e-6 + 4000 * 6e-6 + 2 * 0.01)) < 1e-12);
  });
});

describe("OpenAI Agents trace exports", () => {
  it("are not model calls", async () => {
    const { isAgentsTraceExport } = await import("../ingest.js");
    assert.equal(isAgentsTraceExport({ telemetry: { v: 1, request: { url: "https://api.openai.com/v1/traces/ingest" } } }), true);
    assert.equal(isAgentsTraceExport({ url: "https://api.openai.com/v1/traces/ingest" }), true);
    assert.equal(isAgentsTraceExport({ telemetry: { v: 1, request: { url: "https://api.openai.com/v1/chat/completions" } } }), false);
  });
});

describe("calls that got no response", () => {
  const tts = (error: { name: string }) => extractCall(telemetryFor({
    url: "https://api.elevenlabs.io/v1/text-to-speech/tvK7HkPwv1Xe3WDiVGCz/with-timestamps",
    requestBody: { text: "a".repeat(907), model_id: "eleven_multilingual_v2" },
    status: null,
    error,
    durationMs: 10083,
  }))!;

  it("bills ElevenLabs text-to-speech for its text when the response timed out", () => {
    const call = tts({ name: "ReadTimeout" });
    assert.deepEqual(call.usage?.nativeUnits, { characters: 907 });
    assert.equal(call.model, "eleven_multilingual_v2");
    assert.deepEqual(call.outcome, { lifecycle: "failed", errorType: "ReadTimeout" });
  });

  it("does not bill a request that never reached the provider", () => {
    assert.equal(tts({ name: "ConnectError" }).usage, null);
  });

  it("leaves token-billed providers without usage when nothing came back", () => {
    const call = extractCall(telemetryFor({
      url: "https://api.openai.com/v1/chat/completions",
      requestBody: { model: "gpt-5", messages: [{ role: "user", content: "hi" }] },
      status: null,
      error: { name: "ReadTimeout" },
    }))!;
    assert.equal(call.usage, null);
  });
});
