import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractUsageFromSSE, flushPendingCaptures, patchFetch, unpatchFetch } from "../fetch-patch.js";
import { findExtractor } from "../providers/registry.js";
import { openaiExtractor } from "../providers/openai.js";
import { googleExtractor } from "../providers/google.js";
import { cohereExtractor } from "../providers/more.js";
import { deepgramExtractor } from "../providers/deepgram.js";
import { assemblyaiExtractor } from "../providers/assemblyai.js";
import { cartesiaExtractor } from "../providers/cartesia.js";
import { voyageExtractor, jinaExtractor } from "../providers/embeddings.js";
import { tavilyExtractor } from "../providers/tavily.js";
import {
  cloudflareExtractor,
  huggingfaceExtractor,
  minimaxExtractor,
  moonshotExtractor,
  nebiusExtractor,
  ollamaExtractor,
  sarvamExtractor,
  upstageExtractor,
  zaiExtractor,
} from "../providers/compatible.js";
import type { Transport } from "../transport.js";
import type { ExtractorCall, ProviderExtractor } from "../types.js";

type Event = Record<string, unknown>;

function call(
  url: string,
  requestBody: unknown,
  init: { status?: number; method?: string; headers?: Record<string, string> } = {},
): ExtractorCall {
  return {
    url: new URL(url),
    method: init.method ?? "POST",
    requestBody,
    statusCode: init.status ?? 200,
    responseHeaders: new Headers(init.headers ?? {}),
  };
}

const sse = (...events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

describe("provider registry coverage", () => {
  it.each([
    ["https://api.deepinfra.com/v1/openai/chat/completions", "deepinfra"],
    ["https://integrate.api.nvidia.com/v1/chat/completions", "nvidia"],
    ["https://api.sambanova.ai/v1/chat/completions", "sambanova"],
    ["https://api.novita.ai/v3/openai/chat/completions", "novita"],
    ["https://api.hyperbolic.xyz/v1/chat/completions", "hyperbolic"],
    ["https://api.studio.nebius.com/v1/chat/completions", "nebius"],
    ["https://api.studio.nebius.ai/v1/chat/completions", "nebius"],
    ["https://api.tokenfactory.nebius.com/v1/chat/completions", "nebius"],
    ["https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", "alibaba"],
    ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", "alibaba"],
    ["https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions", "alibaba"],
    ["https://api.moonshot.ai/v1/chat/completions", "moonshot"],
    ["https://api.moonshot.cn/v1/chat/completions", "moonshot"],
    ["https://api.z.ai/api/paas/v4/chat/completions", "zai"],
    ["https://open.bigmodel.cn/api/paas/v4/chat/completions", "zai"],
    ["https://api.minimax.io/v1/text/chatcompletion_v2", "minimax"],
    ["https://api.minimaxi.com/v1/t2a_v2", "minimax"],
    ["https://api.minimax.chat/v1/text/chatcompletion_v2", "minimax"],
    ["https://router.huggingface.co/v1/chat/completions", "huggingface"],
    ["https://api-inference.huggingface.co/models/BAAI/bge-small-en-v1.5", "huggingface"],
    ["https://inference.baseten.co/v1/chat/completions", "baseten"],
    ["https://api.lambda.ai/v1/chat/completions", "lambda"],
    ["https://api.featherless.ai/v1/chat/completions", "featherless"],
    ["https://api.friendli.ai/serverless/v1/chat/completions", "friendli"],
    ["https://api.ai21.com/studio/v1/chat/completions", "ai21"],
    ["https://api.upstage.ai/v1/chat/completions", "upstage"],
    ["https://api.sarvam.ai/v1/chat/completions", "sarvam"],
    ["https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/chat/completions", "cloudflare"],
    ["https://api.cloudflare.com/client/v4/accounts/abc/ai/run/@cf/meta/llama-3.1-8b-instruct", "cloudflare"],
    ["https://ai-gateway.vercel.sh/v1/chat/completions", "vercel"],
    ["http://localhost:11434/api/chat", "ollama"],
    ["http://127.0.0.1:11434/api/generate", "ollama"],
    ["http://localhost:11434/v1/chat/completions", "ollama"],
    ["https://api.portkey.ai/v1/chat/completions", "openai"],
    ["https://oai.helicone.ai/v1/chat/completions", "openai"],
    ["https://gateway.helicone.ai/v1/chat/completions", "openai"],
    ["https://anthropic.helicone.ai/v1/messages", "anthropic"],
    ["https://api.deepgram.com/v1/listen", "deepgram"],
    ["https://api.assemblyai.com/v2/transcript", "assemblyai"],
    ["https://api.cartesia.ai/tts/bytes", "cartesia"],
    ["https://api.voyageai.com/v1/embeddings", "voyage"],
    ["https://api.jina.ai/v1/embeddings", "jina"],
    ["https://api.tavily.com/search", "tavily"],
    ["https://api.cohere.com/v2/embed", "cohere"],
    ["https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-sonnet-4@20250514:rawPredict", "google"],
  ])("matches %s", (url, provider) => {
    expect(findExtractor(new URL(url))?.provider).toBe(provider);
  });

  it("only matches Cloudflare AI routes and Ollama inference routes on its port", () => {
    expect(findExtractor(new URL("https://api.cloudflare.com/client/v4/zones/abc/dns_records"))).toBeNull();
    expect(findExtractor(new URL("http://localhost:3000/api/chat"))).toBeNull();
    expect(findExtractor(new URL("http://localhost:11434/api/tags"))).toBeNull();
    expect(findExtractor(new URL("https://api.deepinfra.com.example.com/v1/chat/completions"))).toBeNull();
  });
});

describe("OpenAI-compatible hosts", () => {
  const body = {
    id: "chatcmpl-1",
    model: "deepseek-ai/DeepSeek-V3",
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 100 },
      completion_tokens_details: { reasoning_tokens: 12 },
    },
  };

  it("reuses OpenAI usage, cache and reasoning details", () => {
    expect(nebiusExtractor.extractUsage(body)).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      reasoningTokens: 12,
      cacheReadTokens: 100,
      cacheCreationTokens: null,
    });
    expect(nebiusExtractor.extractModel({ model: "requested" }, body)).toBe("deepseek-ai/DeepSeek-V3");
    expect(nebiusExtractor.extractModel({ model: "requested" }, null)).toBe("requested");
  });

  it("reads Moonshot usage on a stream chunk's choice and top-level cached tokens", () => {
    const text = sse(
      { model: "kimi-k2", choices: [{ delta: { content: "hi" } }] },
      { model: "kimi-k2", choices: [{ delta: {}, finish_reason: "stop", usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48, cached_tokens: 32 } }] },
    );
    expect(extractUsageFromSSE(text, moonshotExtractor)).toMatchObject({
      inputTokens: 40,
      outputTokens: 8,
      totalTokens: 48,
      cacheReadTokens: 32,
    });
  });

  it("merges a streamed final usage chunk", () => {
    const text = sse(
      { model: "glm-4.6", choices: [{ delta: { content: "a" } }] },
      { model: "glm-4.6", choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } },
    );
    expect(extractUsageFromSSE(text, zaiExtractor)).toMatchObject({ inputTokens: 9, outputTokens: 4, totalTokens: 13 });
  });

  it("injects include_usage only on hosts known to accept it", () => {
    const request = { model: "m", stream: true, messages: [] };
    expect(nebiusExtractor.injectStreamOptions!(request)).toMatchObject({ stream_options: { include_usage: true } });
    expect(findExtractor(new URL("https://api.portkey.ai/v1/chat/completions"))!.injectStreamOptions!(request))
      .toMatchObject({ stream_options: { include_usage: true } });
    expect(moonshotExtractor.injectStreamOptions).toBeUndefined();
    expect(zaiExtractor.injectStreamOptions).toBeUndefined();
  });

  it("reads Anthropic usage through Helicone's Anthropic gateway", () => {
    const helicone = findExtractor(new URL("https://anthropic.helicone.ai/v1/messages"))!;
    expect(helicone.extractUsage({ usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 } }))
      .toMatchObject({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 });
  });

  it("names Hugging Face models from the inference path", () => {
    const c = call("https://router.huggingface.co/hf-inference/models/BAAI/bge-small-en-v1.5/pipeline/feature-extraction", { inputs: "x" });
    expect(huggingfaceExtractor.extractModel({ inputs: "x" }, [[0.1]], c)).toBe("BAAI/bge-small-en-v1.5");
    const legacy = call("https://api-inference.huggingface.co/models/meta-llama/Llama-3.1-8B-Instruct", { inputs: "x" });
    expect(huggingfaceExtractor.extractModel({ inputs: "x" }, null, legacy)).toBe("meta-llama/Llama-3.1-8B-Instruct");
  });

  it("reports Upstage document pages", () => {
    expect(upstageExtractor.extractUsage({ model: "document-parse-250618", usage: { pages: 3 } })?.nativeUnits).toEqual({ pages: 3 });
    expect(upstageExtractor.extractUsage({ usage: { prompt_tokens: 3, completion_tokens: 1 } })).toMatchObject({ inputTokens: 3, outputTokens: 1 });
  });
});

describe("Cloudflare Workers AI", () => {
  const run = "https://api.cloudflare.com/client/v4/accounts/abc/ai/run/@cf/meta/llama-3.1-8b-instruct";

  it("names native runs by the @cf path and reads result.usage", () => {
    const response = { success: true, result: { response: "hi", usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } };
    const c = call(run, { prompt: "hi" });
    expect(cloudflareExtractor.extractModel({ prompt: "hi" }, response, c)).toBe("@cf/meta/llama-3.1-8b-instruct");
    expect(cloudflareExtractor.extractUsage(response, c)).toMatchObject({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
  });

  it("reads usage from a native stream's final event", () => {
    const text = sse({ response: "h" }, { response: "", usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
    expect(extractUsageFromSSE(text, cloudflareExtractor, call(run, { stream: true }))).toMatchObject({ inputTokens: 5, outputTokens: 2 });
  });

  it("uses the body model on OpenAI-compatible routes", () => {
    const c = call("https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/chat/completions", { model: "@cf/qwen/qwq-32b" });
    expect(cloudflareExtractor.extractModel({ model: "@cf/qwen/qwq-32b" }, {}, c)).toBe("@cf/qwen/qwq-32b");
  });
});

describe("Ollama", () => {
  it("reads native eval counts", () => {
    expect(ollamaExtractor.extractUsage({ model: "llama3.2", done: true, prompt_eval_count: 26, eval_count: 290 })).toEqual({
      inputTokens: 26,
      outputTokens: 290,
      totalTokens: 316,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
    expect(ollamaExtractor.extractUsage({ usage: { prompt_tokens: 3, completion_tokens: 1 } })).toMatchObject({ inputTokens: 3, outputTokens: 1 });
    expect(ollamaExtractor.extractUsage({ model: "llama3.2", message: { content: "a" }, done: false })).toBeNull();
  });
});

describe("MiniMax", () => {
  it("bills T2A characters from the request without reading audio", () => {
    const c = call("https://api.minimax.io/v1/t2a_v2", { model: "speech-02-hd", text: "你好, world" });
    expect(minimaxExtractor.readResponseBody!(c)).toBe(false);
    expect(minimaxExtractor.extractUsage(null, c)?.nativeUnits).toEqual({ characters: 9 });
    expect(minimaxExtractor.extractModel(c.requestBody, null, c)).toBe("speech-02-hd");
    expect(minimaxExtractor.extractUsage(null, call(c.url.href, c.requestBody, { status: 400 }))).toBeNull();
  });

  it("reads chat usage", () => {
    const c = call("https://api.minimax.io/v1/text/chatcompletion_v2", { model: "MiniMax-M2" });
    expect(minimaxExtractor.readResponseBody!(c)).toBe(true);
    expect(minimaxExtractor.extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, c))
      .toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });
});

describe("Vertex AI partner models", () => {
  const base = "https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers";

  it("reads Claude rawPredict usage with cache reads and writes, model from the URL", () => {
    const c = call(`${base}/anthropic/models/claude-sonnet-4@20250514:rawPredict`, { anthropic_version: "vertex-2023-10-16", messages: [] });
    const response = {
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 400, cache_creation_input_tokens: 100 },
    };
    expect(googleExtractor.extractUsage(response, c)).toEqual({
      inputTokens: 50,
      outputTokens: 20,
      totalTokens: 70,
      reasoningTokens: null,
      cacheReadTokens: 400,
      cacheCreationTokens: 100,
    });
    expect(googleExtractor.extractModel(c.requestBody, response, c)).toBe("claude-sonnet-4@20250514");
  });

  it("reads a Claude streamRawPredict SSE stream", () => {
    const c = call(`${base}/anthropic/models/claude-opus-4-1@20250805:streamRawPredict`, { stream: true, messages: [] });
    const text = sse(
      { type: "message_start", message: { model: "claude-opus-4-1-20250805", usage: { input_tokens: 30, output_tokens: 1, cache_read_input_tokens: 7 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 44 } },
    );
    expect(extractUsageFromSSE(text, googleExtractor, c)).toMatchObject({
      inputTokens: 30,
      outputTokens: 44,
      totalTokens: 74,
      cacheReadTokens: 7,
    });
  });

  it("reads OpenAI-style usage from other publishers", () => {
    const c = call(`${base}/mistralai/models/mistral-medium-3:rawPredict`, { model: "mistral-medium-3", messages: [] });
    expect(googleExtractor.extractUsage({ usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 } }, c))
      .toMatchObject({ inputTokens: 11, outputTokens: 6, totalTokens: 17 });
    expect(googleExtractor.extractModel(c.requestBody, { model: "x" }, c)).toBe("mistral-medium-3");
  });

  it("names Model Garden's OpenAI-compatible endpoint by the body model", () => {
    const c = call("https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/endpoints/openapi/chat/completions", { model: "meta/llama-4-maverick-17b-128e-instruct-maas" });
    expect(googleExtractor.extractModel(c.requestBody, null, c)).toBe("meta/llama-4-maverick-17b-128e-instruct-maas");
    expect(googleExtractor.extractUsage({ usage: { prompt_tokens: 2, completion_tokens: 3 } }, c)).toMatchObject({ inputTokens: 2, outputTokens: 3 });
  });

  it("keeps Gemini usageMetadata unchanged", () => {
    const c = call(`${base}/google/models/gemini-2.5-pro:generateContent`, {});
    expect(googleExtractor.extractUsage({ usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } }, c))
      .toMatchObject({ inputTokens: 4, outputTokens: 2, totalTokens: 6 });
    expect(googleExtractor.extractModel({}, { modelVersion: "gemini-2.5-pro" }, c)).toBe("gemini-2.5-pro");
  });
});

describe("OpenAI audio", () => {
  it("bills speech characters from the request input and never reads audio", () => {
    for (const url of [
      "https://api.openai.com/v1/audio/speech",
      "https://acme.openai.azure.com/openai/deployments/tts/audio/speech?api-version=2025-03-01-preview",
    ]) {
      const c = call(url, { model: "gpt-4o-mini-tts", input: "héllo 👋", voice: "alloy" });
      expect(openaiExtractor.readResponseBody!(c)).toBe(false);
      expect(openaiExtractor.extractUsage(null, c)).toMatchObject({ nativeUnits: { characters: 7 } });
      expect(openaiExtractor.extractModel(c.requestBody, null)).toBe("gpt-4o-mini-tts");
    }
    expect(openaiExtractor.extractUsage(null, call("https://api.openai.com/v1/audio/speech", { input: "x" }, { status: 429 }))).toBeNull();
  });

  it("reads transcription seconds, tokens or verbose_json duration", () => {
    const c = call("https://api.openai.com/v1/audio/transcriptions", { model: "whisper-1" });
    expect(openaiExtractor.extractUsage({ text: "hi", usage: { type: "duration", seconds: 9 } }, c)?.nativeUnits).toEqual({ audioSeconds: 9 });
    expect(openaiExtractor.extractUsage({ text: "hi", usage: { type: "tokens", input_tokens: 14, output_tokens: 45, total_tokens: 59 } }, c))
      .toMatchObject({ inputTokens: 14, outputTokens: 45, totalTokens: 59 });
    const translation = call("https://api.openai.com/v1/audio/translations", { model: "whisper-1" });
    expect(openaiExtractor.extractUsage({ task: "translate", duration: 8.47, text: "hi" }, translation)?.nativeUnits).toEqual({ audioSeconds: 8.47 });
    expect(openaiExtractor.readResponseBody!(c)).toBe(true);
  });
});

describe("speech providers", () => {
  it("Deepgram listen bills metadata.duration with the query model", () => {
    const c = call("https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true", { url: "https://x/a.wav" });
    expect(deepgramExtractor.extractUsage({ metadata: { duration: 25.93 }, results: {} }, c)?.nativeUnits).toEqual({ audioSeconds: 25.93 });
    expect(deepgramExtractor.extractModel(c.requestBody, null, c)).toBe("nova-2");
    expect(deepgramExtractor.extractModel(null, null, call("https://api.deepgram.com/v1/listen", null))).toBe("nova-3");
  });

  it("Deepgram speak bills request text and never reads audio", () => {
    const c = call("https://api.deepgram.com/v1/speak?model=aura-2-thalia-en", { text: "Hello there" });
    expect(deepgramExtractor.readResponseBody!(c)).toBe(false);
    expect(deepgramExtractor.extractUsage(null, c)?.nativeUnits).toEqual({ characters: 11 });
    expect(deepgramExtractor.extractModel(c.requestBody, null, c)).toBe("aura-2-thalia-en");
  });

  it("AssemblyAI counts only a completed transcript fetched by GET", () => {
    const completed = { id: "t1", status: "completed", audio_duration: 281, speech_model: null };
    const get = call("https://api.assemblyai.com/v2/transcript/t1", null, { method: "GET" });
    expect(assemblyaiExtractor.extractUsage(completed, get)?.nativeUnits).toEqual({ audioSeconds: 281 });
    expect(assemblyaiExtractor.extractModel(null, completed, get)).toBe("best");
    expect(assemblyaiExtractor.extractModel(null, { ...completed, speech_model: "universal" }, get)).toBe("universal");

    const create = call("https://api.assemblyai.com/v2/transcript", { audio_url: "https://x", speech_model: "slam-1" });
    expect(assemblyaiExtractor.extractUsage({ id: "t1", status: "queued", audio_duration: null }, create)).toBeNull();
    expect(assemblyaiExtractor.extractModel(create.requestBody, { status: "queued", speech_model: null }, create)).toBe("slam-1");
    expect(assemblyaiExtractor.extractUsage({ ...completed, status: "processing" }, get)).toBeNull();
    expect(assemblyaiExtractor.extractUsage(completed, call(get.url.href, null, { method: "DELETE" }))).toBeNull();
    expect(assemblyaiExtractor.extractUsage(completed, call("https://api.assemblyai.com/v2/transcript/t1/sentences", null, { method: "GET" }))).toBeNull();
  });

  it("Cartesia bills the transcript for bytes and SSE without reading either", () => {
    for (const path of ["/tts/bytes", "/tts/sse"]) {
      const c = call(`https://api.cartesia.ai${path}`, { model_id: "sonic-2", transcript: "Namaste!" });
      expect(cartesiaExtractor.readResponseBody!(c)).toBe(false);
      expect(cartesiaExtractor.extractUsage(null, c)?.nativeUnits).toEqual({ characters: 8 });
      expect(cartesiaExtractor.extractModel(c.requestBody, null, c)).toBe("sonic-2");
    }
  });

  it("Sarvam TTS sums inputs, STT defaults and reads a duration", () => {
    const tts = call("https://api.sarvam.ai/text-to-speech", { inputs: ["नमस्ते", "hi"], target_language_code: "hi-IN" });
    expect(sarvamExtractor.readResponseBody!(tts)).toBe(false);
    expect(sarvamExtractor.extractUsage(null, tts)?.nativeUnits).toEqual({ characters: 8 });
    expect(sarvamExtractor.extractModel(tts.requestBody, null, tts)).toBe("bulbul:v2");
    const text = call("https://api.sarvam.ai/text-to-speech", { text: "hello", model: "bulbul:v3" });
    expect(sarvamExtractor.extractUsage(null, text)?.nativeUnits).toEqual({ characters: 5 });
    expect(sarvamExtractor.extractModel(text.requestBody, null, text)).toBe("bulbul:v3");

    const stt = call("https://api.sarvam.ai/speech-to-text", { language_code: "hi-IN" });
    expect(sarvamExtractor.extractModel(stt.requestBody, {}, stt)).toBe("saarika:v2.5");
    expect(sarvamExtractor.extractUsage({ transcript: "x" }, stt)).toBeNull();
    expect(sarvamExtractor.extractUsage({ transcript: "x", duration: 4.2 }, stt)?.nativeUnits).toEqual({ audioSeconds: 4.2 });
    const translate = call("https://api.sarvam.ai/speech-to-text-translate", { model: "saaras:v2.5" });
    expect(sarvamExtractor.extractModel(translate.requestBody, {}, translate)).toBe("saaras:v2.5");
  });
});

describe("embeddings, rerank and search", () => {
  it.each([
    [voyageExtractor, "https://api.voyageai.com/v1/embeddings", "voyage-3.5"],
    [voyageExtractor, "https://api.voyageai.com/v1/rerank", "rerank-2.5"],
    [voyageExtractor, "https://api.voyageai.com/v1/multimodalembeddings", "voyage-multimodal-3"],
    [jinaExtractor, "https://api.jina.ai/v1/embeddings", "jina-embeddings-v4"],
    [jinaExtractor, "https://api.jina.ai/v1/rerank", "jina-reranker-m0"],
  ] as Array<[ProviderExtractor, string, string]>)("%#: total tokens as input for %s", (extractor, url, model) => {
    const c = call(url, { model, input: ["a"] });
    expect(extractor.extractUsage({ model: "resolved", usage: { total_tokens: 42 } }, c)).toMatchObject({
      inputTokens: 42,
      outputTokens: null,
      totalTokens: 42,
    });
    expect(extractor.extractModel(c.requestBody, { model: "resolved" }, c)).toBe(model);
  });

  it("reads Cohere billed units for embed, rerank and v2 chat", () => {
    expect(cohereExtractor.extractUsage({ meta: { billed_units: { input_tokens: 18 } } })).toMatchObject({ inputTokens: 18, outputTokens: null });
    expect(cohereExtractor.extractUsage({ meta: { billed_units: { images: 2 } } })?.nativeUnits).toEqual({ images: 2 });
    expect(cohereExtractor.extractUsage({ results: [], meta: { billed_units: { search_units: 1 } } })?.nativeUnits).toEqual({ searchQueries: 1 });
    expect(cohereExtractor.extractUsage({
      usage: { billed_units: { input_tokens: 5, output_tokens: 7 }, tokens: { input_tokens: 70, output_tokens: 7 } },
    })).toMatchObject({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
    expect(cohereExtractor.extractUsage({ meta: { tokens: { input_tokens: 9, output_tokens: 1 } } })).toMatchObject({ inputTokens: 9, outputTokens: 1 });
  });

  it("reads Cohere v2 stream usage from message-end", () => {
    const text = sse(
      { type: "content-delta", delta: { message: { content: { text: "hi" } } } },
      { type: "message-end", delta: { finish_reason: "COMPLETE", usage: { billed_units: { input_tokens: 3, output_tokens: 2 } } } },
    );
    expect(extractUsageFromSSE(text, cohereExtractor)).toMatchObject({ inputTokens: 3, outputTokens: 2 });
  });

  it("prices Tavily searches by depth and records reported credits", () => {
    const basic = call("https://api.tavily.com/search", { query: "q" });
    expect(tavilyExtractor.extractUsage({ results: [] }, basic)?.nativeUnits).toEqual({ searchQueries: 1 });
    expect(tavilyExtractor.extractModel(basic.requestBody, null, basic)).toBe("search");
    const advanced = call("https://api.tavily.com/search", { query: "q", search_depth: "advanced", include_usage: true });
    expect(tavilyExtractor.extractUsage({ results: [], usage: { credits: 2 } }, advanced)?.nativeUnits).toEqual({ searchQueries: 1, credits: 2 });
    expect(tavilyExtractor.extractModel(advanced.requestBody, null, advanced)).toBe("search-advanced");
    const extract = call("https://api.tavily.com/extract", { urls: ["https://a"] });
    expect(tavilyExtractor.extractModel(extract.requestBody, null, extract)).toBe("extract");
    expect(tavilyExtractor.extractUsage({ results: [], usage: { credits: 1 } }, extract)?.nativeUnits).toEqual({ credits: 1 });
    expect(tavilyExtractor.extractUsage({ results: [] }, extract)).toBeNull();
    expect(tavilyExtractor.extractUsage({ detail: "bad key" }, call("https://api.tavily.com/search", {}, { status: 401 }))).toBeNull();
  });
});

function createMockTransport() {
  const events: Event[] = [];
  return {
    transport: {
      enqueue: (event: Event) => events.push(event),
      start: () => {},
      stop: () => {},
      flush: async () => {},
    } as unknown as Transport,
    events,
  };
}

describe("new providers through the fetch patch", () => {
  let originalFetch: typeof globalThis.fetch;
  let events: Event[];
  let sent: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    unpatchFetch();
    globalThis.fetch = originalFetch;
  });

  function patchWith(respond: (url: string, init?: RequestInit) => Response) {
    sent = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      sent.push({ url, init });
      return respond(url, init);
    });
    const mock = createMockTransport();
    events = mock.events;
    patchFetch({
      transport: mock.transport,
      projectId: "coverage",
      captureBody: false,
      beforeSend: null,
      defaultContext: {},
      debug: false,
    });
  }

  it("records OpenAI speech without cloning the audio", async () => {
    const providerResponse = new Response(new Uint8Array([0xff, 0xfb]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    const clone = vi.spyOn(providerResponse, "clone");
    patchWith(() => providerResponse);
    await globalThis.fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      body: JSON.stringify({ model: "tts-1-hd", input: "Hello world", voice: "nova" }),
    });
    await flushPendingCaptures();
    expect(clone).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ provider: "openai", model: "tts-1-hd", usage: { nativeUnits: { characters: 11 } } });
  });

  it("records a multipart transcription with the form model", async () => {
    patchWith(() => new Response(JSON.stringify({ text: "hi", usage: { type: "duration", seconds: 12 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", new Blob([new Uint8Array([1, 2])]), "a.wav");
    await globalThis.fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", body: form });
    await flushPendingCaptures();
    expect(events[0]).toMatchObject({ provider: "openai", model: "whisper-1", usage: { nativeUnits: { audioSeconds: 12 } } });
  });

  it("records a Cartesia SSE stream from the request without reading it", async () => {
    const providerResponse = new Response(sse({ type: "chunk", data: "AAAA" }), { status: 200, headers: { "content-type": "text/event-stream" } });
    const clone = vi.spyOn(providerResponse, "clone");
    patchWith(() => providerResponse);
    const response = await globalThis.fetch("https://api.cartesia.ai/tts/sse", {
      method: "POST",
      body: JSON.stringify({ model_id: "sonic-2", transcript: "Hello" }),
    });
    await flushPendingCaptures();
    expect(response).toBe(providerResponse);
    expect(clone).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ provider: "cartesia", model: "sonic-2", usage: { nativeUnits: { characters: 5 } } });
  });

  it("treats a fetch without init as a GET (AssemblyAI polling)", async () => {
    patchWith(() => new Response(JSON.stringify({ id: "t9", status: "completed", audio_duration: 61, speech_model: "universal" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await globalThis.fetch("https://api.assemblyai.com/v2/transcript/t9");
    await flushPendingCaptures();
    expect(events[0]).toMatchObject({
      provider: "assemblyai",
      method: "GET",
      model: "universal",
      usage: { nativeUnits: { audioSeconds: 61 } },
    });
  });

  it("reads an Ollama NDJSON stream and passes it through unchanged", async () => {
    const body = [
      { model: "llama3.2", message: { content: "Hel" }, done: false },
      { model: "llama3.2", message: { content: "lo" }, done: false },
      { model: "llama3.2", done: true, prompt_eval_count: 26, eval_count: 2 },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n";
    patchWith(() => new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }));
    const response = await globalThis.fetch("http://localhost:11434/api/chat", {
      method: "POST",
      body: JSON.stringify({ model: "llama3.2", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(await response.text()).toBe(body);
    await flushPendingCaptures();
    expect(events[0]).toMatchObject({
      provider: "ollama",
      model: "llama3.2",
      streaming: true,
      usage: { inputTokens: 26, outputTokens: 2, totalTokens: 28 },
    });
  });

  it("injects include_usage for a streamed DeepInfra request", async () => {
    patchWith(() => new Response(sse(
      { model: "meta-llama/Llama-3.3-70B-Instruct", choices: [{ delta: { content: "a" } }] },
      { model: "meta-llama/Llama-3.3-70B-Instruct", choices: [], usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 } },
    ), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const response = await globalThis.fetch("https://api.deepinfra.com/v1/openai/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "meta-llama/Llama-3.3-70B-Instruct", stream: true, messages: [] }),
    });
    await response.text();
    await flushPendingCaptures();
    expect(JSON.parse(String(sent[0]!.init?.body))).toMatchObject({ stream_options: { include_usage: true } });
    expect(events[0]).toMatchObject({ provider: "deepinfra", usage: { inputTokens: 7, outputTokens: 1 } });
  });

  it("records a Claude stream on Vertex with the URL model", async () => {
    patchWith(() => new Response(sse(
      { type: "message_start", message: { model: "claude-sonnet-4-5-20250929", usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 2048 } } },
      { type: "message_delta", usage: { output_tokens: 30 } },
    ), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const response = await globalThis.fetch(
      "https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20250929:streamRawPredict",
      { method: "POST", body: JSON.stringify({ anthropic_version: "vertex-2023-10-16", stream: true, messages: [] }) },
    );
    await response.text();
    await flushPendingCaptures();
    expect(events[0]).toMatchObject({
      provider: "google",
      model: "claude-sonnet-4-5@20250929",
      streaming: true,
      usage: { inputTokens: 12, outputTokens: 30, cacheCreationTokens: 2048 },
    });
  });
});
