/**
 * Golden parity: raw provider call → reference skeleton (what SDK 0.7 sends)
 * → server extraction must equal what the SDK 0.6.1 TypeScript extractors
 * produced from the same raw call. The only differences are the intentional
 * ones listed in INTENTIONAL, each with its reason.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CASES } from "./fixtures/telemetry-cases.js";
import { telemetryFor } from "./helpers/skeleton.js";
import { extractCall } from "../telemetry/extract.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/telemetry-golden.json", import.meta.url), "utf8")) as {
  cases: Record<string, { typescript: Record<string, unknown>; python: Record<string, unknown> }>;
};

const FIELDS = ["provider", "model", "requestModel", "usage", "providerRequestId", "streaming"] as const;

const EMPTY = { inputTokens: null, outputTokens: null, totalTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheCreationTokens: null };

/** Fields where the server deliberately differs from SDK 0.6.1 TypeScript, and why. */
const INTENTIONAL: Record<string, { fields: Partial<Record<(typeof FIELDS)[number], unknown>>; reason: string }> = {
  "openai-responses-stream": {
    fields: { model: "gpt-5-2025-08-07", requestModel: "gpt-5", providerRequestId: "resp_s1" },
    reason: "stream model and request id are read from the record's nested response/message too (0.6 only looked at the top level and fell back to the requested alias)",
  },
  "anthropic-stream": {
    fields: { model: "claude-haiku-4-5-20251001", requestModel: "claude-haiku-4-5", providerRequestId: "msg_S1" },
    reason: "message_start.message carries the billed model and message id; non-streamed calls already reported both",
  },
  "vertex-claude-stream": {
    fields: { providerRequestId: "msg_vrtx_s" },
    reason: "message id read from message_start.message",
  },
  "bedrock-invoke-stream": {
    fields: { providerRequestId: "msg_bdrk_s" },
    reason: "message id read from the decoded chunk's message",
  },
  "openai-tts": {
    fields: { providerRequestId: "req_tts" },
    reason: "request id falls back to the x-request-id / request-id / x-amzn-requestid response header when the body has none",
  },
  "elevenlabs-tts-header": { fields: { providerRequestId: "el-req-1" }, reason: "request-id header fallback" },
  "bedrock-converse": { fields: { providerRequestId: "7f1c-req" }, reason: "x-amzn-requestid, as the 0.6 AWS SDK middleware already did" },
  "bedrock-invoke-llama-headers": { fields: { providerRequestId: "llama-req" }, reason: "x-amzn-requestid header fallback" },
  "bedrock-converse-stream": { fields: { providerRequestId: "nova-stream-req" }, reason: "x-amzn-requestid header fallback" },
  "sarvam-tts": {
    fields: { providerRequestId: "sv-1" },
    reason: "the TTS JSON body's request_id is readable in its skeleton (0.6 never read the audio body)",
  },
  "openai-images-gpt-image": {
    fields: { usage: { inputTokens: 50, outputTokens: 4160, totalTokens: 4210, reasoningTokens: null, cacheReadTokens: null, cacheCreationTokens: null, imageOutputTokens: 4160 } },
    reason: "Images API output tokens are image tokens",
  },
  "openai-images-dalle": {
    fields: { model: "dall-e-2", usage: { ...EMPTY, nativeUnits: { images: 2 } } },
    reason: "DALL-E bills per image; the Images API defaults to dall-e-2",
  },
  "anthropic-messages": {
    fields: { usage: { inputTokens: 2100, outputTokens: 410, totalTokens: 2510, reasoningTokens: null, cacheReadTokens: 12000, cacheCreationTokens: 5000, nativeUnits: { cacheCreation5mTokens: 1000, cacheCreation1hTokens: 4000, webSearchRequests: 2 } } },
    reason: "cache writes split by TTL (1h is billed higher) and server-tool web searches (billed per search)",
  },
  "bedrock-invoke-titan-no-headers": {
    fields: { usage: { inputTokens: 3, outputTokens: 9, totalTokens: 12, reasoningTokens: null, cacheReadTokens: null, cacheCreationTokens: null } },
    reason: "Titan/Llama InvokeModel bodies (Python 0.6 behaviour)",
  },
  "xai-chat-live-search": {
    fields: { usage: { inputTokens: 900, outputTokens: 300, totalTokens: 1700, reasoningTokens: 500, cacheReadTokens: 640, cacheCreationTokens: null, nativeUnits: { searchSources: 3 } } },
    reason: "cached prompt tokens (Python 0.6 behaviour) and live-search sources",
  },
  "groq-chat": {
    fields: { usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50, reasoningTokens: null, cacheReadTokens: 32, cacheCreationTokens: null } },
    reason: "prompt_tokens_details.cached_tokens (Python 0.6 behaviour)",
  },
  "groq-stream-x-groq": {
    fields: { usage: { inputTokens: 75, outputTokens: 22, totalTokens: 97, reasoningTokens: null, cacheReadTokens: null, cacheCreationTokens: null } },
    reason: "Groq streams report usage under x_groq",
  },
  "deepseek-chat-cache": {
    fields: { usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050, reasoningTokens: null, cacheReadTokens: 768, cacheCreationTokens: null } },
    reason: "prompt_cache_miss_tokens are uncached input, not cache creation",
  },
  "deepseek-reasoner": {
    fields: { usage: { inputTokens: 20, outputTokens: 600, totalTokens: 620, reasoningTokens: 450, cacheReadTokens: 0, cacheCreationTokens: null } },
    reason: "prompt_cache_miss_tokens are uncached input, not cache creation",
  },
  "mistral-ocr": { fields: { usage: { ...EMPTY, nativeUnits: { pages: 3 } } }, reason: "Mistral OCR pages processed" },
  "together-chat": {
    fields: { usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42, reasoningTokens: null, cacheReadTokens: 0, cacheCreationTokens: null } },
    reason: "full OpenAI-compatible usage incl. cached tokens (Python 0.6 behaviour)",
  },
  "fireworks-chat-cached": {
    fields: { usage: { inputTokens: 500, outputTokens: 20, totalTokens: 520, reasoningTokens: null, cacheReadTokens: 448, cacheCreationTokens: null } },
    reason: "cached prompt tokens (Python 0.6 behaviour)",
  },
  "cerebras-chat": {
    fields: { usage: { inputTokens: 64, outputTokens: 8, totalTokens: 72, reasoningTokens: null, cacheReadTokens: 0, cacheCreationTokens: null } },
    reason: "cached prompt tokens (Python 0.6 behaviour)",
  },
  "perplexity-sonar": {
    fields: { usage: { inputTokens: 8, outputTokens: 300, totalTokens: 308, reasoningTokens: 0, cacheReadTokens: null, cacheCreationTokens: null, costUsd: 0.010524, nativeUnits: { searchQueries: 2, citationTokens: 2400 } } },
    reason: "search queries, citation tokens and the reported total cost the SDKs dropped",
  },
  "elevenlabs-stt-words": {
    fields: { usage: { ...EMPTY, nativeUnits: { audioSeconds: 1.42 } } },
    reason: "audio length from the last word when no duration is reported (Python 0.6 behaviour)",
  },
  "long-model-name-truncated": {
    fields: { model: null },
    reason: "contract: strings over 200 characters become {$s: N} even for allowlisted keys",
  },
};

describe("golden parity with the SDK 0.6.1 extractors", () => {
  for (const { name, call } of CASES) {
    it(name, () => {
      const reference = golden.cases[name];
      assert.ok(reference, `no golden output for ${name}; regenerate telemetry-golden.json`);
      const derived = JSON.parse(JSON.stringify(extractCall(telemetryFor(call)))) as Record<string, unknown>;
      const expected = { ...reference.typescript, ...(INTENTIONAL[name]?.fields ?? {}) };
      for (const field of FIELDS) {
        assert.deepEqual(derived[field] ?? null, expected[field] ?? null, `${name}.${field}`);
      }
    });
  }

  it("lists only intentional differences that still differ", () => {
    for (const [name, { fields }] of Object.entries(INTENTIONAL)) {
      const reference = golden.cases[name]!.typescript;
      for (const [field, value] of Object.entries(fields)) {
        assert.notDeepEqual(reference[field] ?? null, value, `${name}.${field} matches 0.6.1 and is not a difference`);
      }
    }
  });

  it("derives failure outcomes and stream timing", () => {
    const aborted = extractCall(telemetryFor(CASES.find((item) => item.name === "openai-aborted-stream")!.call))!;
    assert.deepEqual(aborted.outcome, { lifecycle: "cancelled", errorType: null });
    const network = extractCall(telemetryFor(CASES.find((item) => item.name === "openai-network-error")!.call))!;
    assert.deepEqual(network.outcome, { lifecycle: "failed", errorType: "TypeError" });
    assert.equal(network.usage, null);
    const rejected = extractCall(telemetryFor(CASES.find((item) => item.name === "openai-tts-rejected")!.call))!;
    assert.deepEqual(rejected.outcome, { lifecycle: "failed", errorType: "http_400" });
    const stream = extractCall(telemetryFor(CASES.find((item) => item.name === "anthropic-stream")!.call))!;
    // ttft = firstChunkMs (100); tps = 120 output tokens over (1500 - 100) ms.
    assert.deepEqual(stream.streamTiming, { ttft: 100, tps: 85.71, streamDuration: 1500, chunkCount: 6 });
  });
});
