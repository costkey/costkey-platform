/**
 * Raw provider calls for the golden parity tests. Each is turned into the
 * `telemetry` an SDK 0.7 sends (helpers/skeleton.ts) and extracted on the
 * server; telemetry-golden.json holds what the SDK 0.6.1 extractors produced
 * from the same raw call (TypeScript, and Python where it runs).
 */
import type { RawCall } from "../helpers/skeleton.js";

export interface GoldenCase {
  name: string;
  call: RawCall;
}

const embedding = (n: number) => Array.from({ length: n }, (_, i) => Math.round(Math.sin(i) * 1e4) / 1e4);
const sse = (records: unknown[]) => ({ format: "sse" as const, records });

export const CASES: GoldenCase[] = [
  // ── OpenAI ──
  {
    name: "openai-chat",
    call: {
      url: "https://api.openai.com/v1/chat/completions",
      requestBody: { model: "gpt-4o", messages: [{ role: "system", content: "Be terse." }, { role: "user", content: "Say hi" }], max_tokens: 50 },
      status: 200,
      responseHeaders: { "content-type": "application/json", "x-request-id": "req_abc123", "openai-processing-ms": "312" },
      responseBody: {
        id: "chatcmpl-AbC123", object: "chat.completion", created: 1760000000, model: "gpt-4o-2024-08-06",
        choices: [{ index: 0, message: { role: "assistant", content: "Hi." }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280,
          prompt_tokens_details: { cached_tokens: 1024, audio_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
        },
        system_fingerprint: "fp_abc",
      },
    },
  },
  {
    name: "openai-chat-stream",
    call: {
      url: "https://api.openai.com/v1/chat/completions",
      requestBody: { model: "gpt-4o-mini", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Count to three" }] },
      status: 200,
      responseHeaders: { "content-type": "text/event-stream", "x-request-id": "req_stream1" },
      stream: sse([
        { id: "chatcmpl-S1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini-2024-07-18", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
        { id: "chatcmpl-S1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini-2024-07-18", choices: [{ index: 0, delta: { content: "One, two, three." }, finish_reason: null }] },
        { id: "chatcmpl-S1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini-2024-07-18", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: "chatcmpl-S1", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini-2024-07-18", choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } },
      ]),
      durationMs: 900,
    },
  },
  {
    name: "openai-responses",
    call: {
      url: "https://api.openai.com/v1/responses",
      requestBody: { model: "gpt-5", input: "Explain caching", reasoning: { effort: "medium" }, max_output_tokens: 2000 },
      status: 200,
      responseBody: {
        id: "resp_123", object: "response", created_at: 1760000000, status: "completed", model: "gpt-5-2025-08-07",
        output: [{ type: "reasoning", id: "rs_1", summary: [] }, { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Caching is...", annotations: [] }] }],
        usage: { input_tokens: 300, input_tokens_details: { cached_tokens: 128 }, output_tokens: 900, output_tokens_details: { reasoning_tokens: 640 }, total_tokens: 1200 },
      },
    },
  },
  {
    name: "openai-responses-stream",
    call: {
      url: "https://api.openai.com/v1/responses",
      requestBody: { model: "gpt-5", input: "Hi", stream: true },
      status: 200,
      responseHeaders: { "content-type": "text/event-stream" },
      stream: sse([
        { type: "response.created", sequence_number: 0, response: { id: "resp_s1", object: "response", status: "in_progress", model: "gpt-5-2025-08-07", usage: null } },
        { type: "response.output_text.delta", sequence_number: 1, item_id: "msg_1", delta: "Hello" },
        { type: "response.completed", sequence_number: 2, response: { id: "resp_s1", object: "response", status: "completed", model: "gpt-5-2025-08-07", usage: { input_tokens: 9, input_tokens_details: { cached_tokens: 0 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 16 }, total_tokens: 39 } } },
      ]),
    },
  },
  {
    name: "openai-embeddings",
    call: {
      url: "https://api.openai.com/v1/embeddings",
      requestBody: { model: "text-embedding-3-small", input: ["alpha", "beta"] },
      status: 200,
      responseBody: {
        object: "list", model: "text-embedding-3-small",
        data: [{ object: "embedding", index: 0, embedding: embedding(1536) }, { object: "embedding", index: 1, embedding: embedding(1536) }],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      },
    },
  },
  {
    name: "openai-tts",
    call: {
      url: "https://api.openai.com/v1/audio/speech",
      requestBody: { model: "gpt-4o-mini-tts", input: "Héllo wörld — 👋 testing speech!", voice: "alloy", response_format: "mp3" },
      status: 200,
      responseHeaders: { "content-type": "audio/mpeg", "x-request-id": "req_tts" },
      responseBytes: 48211,
    },
  },
  {
    name: "openai-tts-rejected",
    call: {
      url: "https://api.openai.com/v1/audio/speech",
      requestBody: { model: "tts-1", input: "This request is rejected", voice: "nova" },
      status: 400,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { error: { message: "Invalid voice", type: "invalid_request_error", param: "voice", code: null } },
    },
  },
  {
    name: "openai-stt-whisper",
    call: {
      url: "https://api.openai.com/v1/audio/transcriptions",
      multipart: [{ name: "file", filename: "meeting.wav", contentType: "audio/wav", bytes: 882110 }, { name: "model", value: "whisper-1" }],
      status: 200,
      responseBody: { text: "Hello everyone and welcome.", usage: { type: "duration", seconds: 12 } },
    },
  },
  {
    name: "openai-stt-verbose",
    call: {
      url: "https://api.openai.com/v1/audio/transcriptions",
      multipart: [{ name: "file", filename: "a.mp3", contentType: "audio/mpeg", bytes: 120000 }, { name: "model", value: "whisper-1" }, { name: "response_format", value: "verbose_json" }],
      status: 200,
      responseBody: { task: "transcribe", language: "english", duration: 8.5, text: "Short clip.", segments: [{ id: 0, start: 0, end: 8.5, text: "Short clip." }] },
    },
  },
  {
    name: "openai-stt-gpt4o",
    call: {
      url: "https://api.openai.com/v1/audio/transcriptions",
      multipart: [{ name: "file", filename: "a.mp3", contentType: "audio/mpeg", bytes: 120000 }, { name: "model", value: "gpt-4o-transcribe" }],
      status: 200,
      responseBody: { text: "Hi.", usage: { type: "tokens", input_tokens: 140, input_token_details: { text_tokens: 0, audio_tokens: 140 }, output_tokens: 3, total_tokens: 143 } },
    },
  },
  {
    name: "openai-images-gpt-image",
    call: {
      url: "https://api.openai.com/v1/images/generations",
      requestBody: { model: "gpt-image-1", prompt: "A red fox in snow", size: "1024x1024", quality: "high" },
      status: 200,
      responseBody: {
        created: 1760000000, data: [{ b64_json: "iVBORw0KGgo".repeat(400) }],
        usage: { total_tokens: 4210, input_tokens: 50, output_tokens: 4160, input_tokens_details: { text_tokens: 50, image_tokens: 0 } },
      },
    },
  },
  {
    name: "openai-images-dalle",
    call: {
      url: "https://api.openai.com/v1/images/generations",
      requestBody: { prompt: "A lighthouse at dusk", n: 2, size: "512x512" },
      status: 200,
      responseBody: { created: 1760000000, data: [{ url: "https://oaidalleapiprodscus.blob.core.windows.net/a.png" }, { url: "https://oaidalleapiprodscus.blob.core.windows.net/b.png" }] },
    },
  },
  {
    name: "azure-openai-chat",
    call: {
      url: "https://contoso.openai.azure.com/openai/deployments/gpt4o-prod/chat/completions?api-version=2024-10-21&api-key=SECRET",
      requestBody: { messages: [{ role: "user", content: "hi" }] },
      status: 200,
      responseBody: { id: "chatcmpl-az1", object: "chat.completion", model: "gpt-4o-2024-11-20", choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
    },
  },
  {
    name: "openai-network-error",
    call: {
      url: "https://api.openai.com/v1/chat/completions",
      requestBody: { model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] },
      status: null,
      error: { name: "TypeError", code: "ECONNRESET" },
    },
  },
  {
    name: "openai-aborted-stream",
    call: {
      url: "https://api.openai.com/v1/chat/completions",
      requestBody: { model: "gpt-4.1-mini", stream: true, messages: [{ role: "user", content: "long essay" }] },
      status: 200,
      responseHeaders: { "content-type": "text/event-stream" },
      stream: sse([
        { id: "chatcmpl-A1", object: "chat.completion.chunk", model: "gpt-4.1-mini-2025-04-14", choices: [{ index: 0, delta: { role: "assistant", content: "Once" } }] },
        { id: "chatcmpl-A1", object: "chat.completion.chunk", model: "gpt-4.1-mini-2025-04-14", choices: [{ index: 0, delta: { content: " upon" } }] },
      ]),
      error: { name: "AbortError" },
    },
  },

  // ── Anthropic ──
  {
    name: "anthropic-messages",
    call: {
      url: "https://api.anthropic.com/v1/messages",
      requestHeaders: { "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "extended-cache-ttl-2025-04-11", "x-api-key": "sk-ant-secret" },
      requestBody: { model: "claude-sonnet-4-5", max_tokens: 1024, tools: [{ type: "web_search_20250305", name: "web_search" }], messages: [{ role: "user", content: "What's new?" }] },
      status: 200,
      responseHeaders: { "request-id": "req_011abc", "anthropic-ratelimit-input-tokens-remaining": "1000" },
      responseBody: {
        id: "msg_01ABC", type: "message", role: "assistant", model: "claude-sonnet-4-5-20250929",
        content: [{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "news" } }, { type: "text", text: "Here is the news." }],
        stop_reason: "end_turn", stop_sequence: null,
        usage: {
          input_tokens: 2100, cache_creation_input_tokens: 5000, cache_read_input_tokens: 12000, output_tokens: 410,
          cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 4000 },
          server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 }, service_tier: "standard",
        },
      },
    },
  },
  {
    name: "anthropic-stream",
    call: {
      url: "https://api.anthropic.com/v1/messages",
      requestBody: { model: "claude-haiku-4-5", max_tokens: 512, stream: true, messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseHeaders: { "content-type": "text/event-stream", "request-id": "req_stream_a" },
      stream: sse([
        { type: "message_start", message: { id: "msg_S1", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001", content: [], stop_reason: null, usage: { input_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 2048, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello there" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 120 } },
        { type: "message_stop" },
      ]),
      durationMs: 1500,
    },
  },
  {
    name: "anthropic-helicone",
    call: {
      url: "https://anthropic.helicone.ai/v1/messages",
      requestBody: { model: "claude-opus-4-1", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "msg_H1", type: "message", model: "claude-opus-4-1-20250805", content: [], usage: { input_tokens: 10, output_tokens: 5 } },
    },
  },

  // ── Google Gemini and Vertex ──
  {
    name: "gemini-grounded",
    call: {
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaSECRET",
      requestBody: { contents: [{ role: "user", parts: [{ text: "Who won?" }] }], tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: 800 } },
      status: 200,
      responseBody: {
        candidates: [{
          content: { role: "model", parts: [{ text: "Team A won." }] }, finishReason: "STOP",
          groundingMetadata: { webSearchQueries: ["who won the final", "final score"], groundingChunks: [{ web: { uri: "https://x.example", title: "x" } }], searchEntryPoint: { renderedContent: "<div/>" } },
        }],
        usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 30, totalTokenCount: 170, thoughtsTokenCount: 60, toolUsePromptTokenCount: 40, cachedContentTokenCount: 8 },
        modelVersion: "gemini-2.5-flash", responseId: "resp-gem-1",
      },
    },
  },
  {
    name: "gemini-stream-sse",
    call: {
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse&key=AIzaSECRET",
      requestBody: { contents: [{ role: "user", parts: [{ text: "Search and summarize" }] }], tools: [{ google_search: {} }] },
      status: 200,
      responseHeaders: { "content-type": "text/event-stream" },
      stream: sse([
        { candidates: [{ content: { role: "model", parts: [{ text: "Sum" }] } }], usageMetadata: { promptTokenCount: 20, totalTokenCount: 20 }, modelVersion: "gemini-3-flash-preview", responseId: "rg-2" },
        { candidates: [{ content: { role: "model", parts: [{ text: "mary" }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 }, modelVersion: "gemini-3-flash-preview", responseId: "rg-2" },
        { candidates: [{ content: { role: "model", parts: [{ text: "." }] }, finishReason: "STOP", groundingMetadata: { webSearchQueries: ["topic one", "topic two", "topic three"], groundingChunks: [{ web: { uri: "https://a.example" } }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 55, totalTokenCount: 95, thoughtsTokenCount: 20, toolUsePromptTokenCount: 0 }, modelVersion: "gemini-3-flash-preview", responseId: "rg-2" },
      ]),
    },
  },
  {
    name: "gemini-stream-json-array",
    call: {
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent",
      requestBody: { contents: [{ role: "user", parts: [{ text: "Hi" }] }] },
      status: 200,
      responseHeaders: { "content-type": "application/json" },
      stream: {
        format: "json-array",
        records: [
          { candidates: [{ content: { parts: [{ text: "Hel" }] } }], usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 }, modelVersion: "gemini-2.5-pro" },
          { candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }, modelVersion: "gemini-2.5-pro" },
        ],
      },
    },
  },
  {
    name: "gemini-rate-limited",
    call: {
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      requestBody: { contents: [{ parts: [{ text: "Hi" }] }] },
      status: 429,
      responseBody: { error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } },
    },
  },
  {
    name: "gemini-maps-grounding",
    call: {
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      requestBody: { contents: [{ parts: [{ text: "Cafes near me" }] }], tools: [{ googleMaps: {} }] },
      status: 200,
      responseBody: {
        candidates: [{ content: { parts: [{ text: "Try these." }] }, groundingMetadata: { groundingChunks: [{ maps: { uri: "https://maps.google.com/?cid=1", title: "Cafe" } }], googleMapsWidgetContextToken: "widgetcontent/abc" } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 20, totalTokenCount: 32 }, modelVersion: "gemini-2.5-flash",
      },
    },
  },
  {
    name: "vertex-gemini",
    call: {
      url: "https://us-central1-aiplatform.googleapis.com/v1/projects/acme/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent",
      requestBody: { contents: [{ role: "user", parts: [{ text: "Hi" }] }] },
      status: 200,
      responseBody: { candidates: [{ content: { parts: [{ text: "Hello" }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5, trafficType: "ON_DEMAND" }, modelVersion: "gemini-2.5-pro", createTime: "2026-10-11T09:00:00Z", responseId: "vx-1" },
    },
  },
  {
    name: "vertex-claude",
    call: {
      url: "https://us-east5-aiplatform.googleapis.com/v1/projects/acme/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict",
      requestBody: { anthropic_version: "vertex-2023-10-16", max_tokens: 256, messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "msg_vrtx_1", type: "message", model: "claude-sonnet-4-5-20250929", content: [{ type: "text", text: "Hello" }], usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 12 } },
    },
  },
  {
    name: "vertex-claude-stream",
    call: {
      url: "https://aiplatform.googleapis.com/v1/projects/acme/locations/global/publishers/anthropic/models/claude-opus-4-1@20250805:streamRawPredict",
      requestBody: { anthropic_version: "vertex-2023-10-16", max_tokens: 256, stream: true, messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseHeaders: { "content-type": "text/event-stream" },
      stream: sse([
        { type: "message_start", message: { id: "msg_vrtx_s", type: "message", model: "claude-opus-4-1-20250805", usage: { input_tokens: 15, output_tokens: 1 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 33 } },
        { type: "message_stop" },
      ]),
    },
  },
  {
    name: "vertex-openapi-llama",
    call: {
      url: "https://us-central1-aiplatform.googleapis.com/v1/projects/acme/locations/us-central1/endpoints/openapi/chat/completions",
      requestBody: { model: "meta/llama-4-maverick-17b-128e-instruct-maas", messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "chat-vx", object: "chat.completion", model: "meta/llama-4-maverick-17b-128e-instruct-maas", choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } },
    },
  },

  // ── Bedrock ──
  {
    name: "bedrock-converse",
    call: {
      url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20240620-v1%3A0/converse",
      requestBody: { messages: [{ role: "user", content: [{ text: "Hi" }] }], inferenceConfig: { maxTokens: 300 } },
      status: 200,
      responseHeaders: { "x-amzn-requestid": "7f1c-req" },
      responseBody: { output: { message: { role: "assistant", content: [{ text: "Hello" }] } }, stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 8, totalTokens: 1528, cacheReadInputTokens: 1000, cacheWriteInputTokens: 500 }, metrics: { latencyMs: 400 } },
    },
  },
  {
    name: "bedrock-invoke-anthropic-arn",
    call: {
      url: "https://bedrock-runtime.us-west-2.amazonaws.com/model/arn%3Aaws%3Abedrock%3Aus-west-2%3A111122223333%3Ainference-profile%2Fus.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke",
      requestBody: { anthropic_version: "bedrock-2023-05-31", max_tokens: 200, messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseHeaders: {
        "x-amzn-requestid": "a1b2-req", "x-amzn-bedrock-input-token-count": "31", "x-amzn-bedrock-output-token-count": "17",
        "x-amzn-bedrock-cache-read-input-token-count": "0", "x-amzn-bedrock-cache-write-input-token-count": "0", "x-amzn-bedrock-invocation-latency": "811",
      },
      responseBody: { id: "msg_bdrk_01", type: "message", role: "assistant", model: "claude-sonnet-4-5-20250929", content: [{ type: "text", text: "Hello" }], usage: { input_tokens: 31, output_tokens: 17, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  },
  {
    name: "bedrock-invoke-llama-headers",
    call: {
      url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/meta.llama3-1-70b-instruct-v1%3A0/invoke",
      requestBody: { prompt: "Hi", max_gen_len: 128 },
      status: 200,
      responseHeaders: { "x-amzn-requestid": "llama-req", "x-amzn-bedrock-input-token-count": "5", "x-amzn-bedrock-output-token-count": "11" },
      responseBody: { generation: "Hello!", prompt_token_count: 5, generation_token_count: 11, stop_reason: "stop" },
    },
  },
  {
    name: "bedrock-invoke-titan-no-headers",
    call: {
      url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.titan-text-express-v1/invoke",
      requestBody: { inputText: "Hi", textGenerationConfig: { maxTokenCount: 100 } },
      status: 200,
      responseBody: { inputTextTokenCount: 3, results: [{ tokenCount: 9, outputText: "Hello there", completionReason: "FINISH" }] },
    },
  },
  {
    name: "bedrock-converse-stream",
    call: {
      url: "https://bedrock-runtime.eu-west-1.amazonaws.com/model/amazon.nova-pro-v1%3A0/converse-stream",
      requestBody: { messages: [{ role: "user", content: [{ text: "Hi" }] }] },
      status: 200,
      responseHeaders: { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": "nova-stream-req" },
      stream: {
        format: "aws-eventstream",
        records: [
          { messageStart: { role: "assistant" } },
          { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } },
          { messageStop: { stopReason: "end_turn" } },
          { metadata: { usage: { inputTokens: 14, outputTokens: 6, totalTokens: 20 }, metrics: { latencyMs: 300 } } },
        ],
      },
    },
  },
  {
    name: "bedrock-invoke-stream",
    call: {
      url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-haiku-20240307-v1%3A0/invoke-with-response-stream",
      requestBody: { anthropic_version: "bedrock-2023-05-31", max_tokens: 100, messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseHeaders: { "content-type": "application/vnd.amazon.eventstream" },
      stream: {
        format: "aws-eventstream",
        records: [
          { chunk: { bytes: { type: "message_start", message: { id: "msg_bdrk_s", model: "claude-3-haiku-20240307", usage: { input_tokens: 12, output_tokens: 1 } } } } },
          { chunk: { bytes: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } } },
          { chunk: { bytes: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } } } },
          { chunk: { bytes: { type: "message_stop", "amazon-bedrock-invocationMetrics": { inputTokenCount: 12, outputTokenCount: 9, invocationLatency: 500, firstByteLatency: 200 } } } },
        ],
      },
    },
  },

  // ── Routers and model providers on the OpenAI shape ──
  {
    name: "openrouter-chat",
    call: {
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBody: { model: "google/gemini-2.5-flash-image", messages: [{ role: "user", content: "Draw a cat" }], usage: { include: true } },
      status: 200,
      responseBody: {
        id: "gen-123", model: "google/gemini-2.5-flash-image", provider: "Google", object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 1300, total_tokens: 1310, cost: 0.0387, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, image_tokens: 1290 } },
      },
    },
  },
  {
    name: "openrouter-stream",
    call: {
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBody: { model: "anthropic/claude-sonnet-4.5", stream: true, messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseHeaders: { "content-type": "text/event-stream" },
      stream: sse([
        { id: "gen-s1", model: "anthropic/claude-sonnet-4.5", choices: [{ delta: { content: "Hey" } }] },
        { id: "gen-s1", model: "anthropic/claude-sonnet-4.5", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, cost: 0.000105, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } },
      ]),
    },
  },
  {
    name: "xai-chat-live-search",
    call: {
      url: "https://api.x.ai/v1/chat/completions",
      requestBody: { model: "grok-4", messages: [{ role: "user", content: "Latest news" }], search_parameters: { mode: "auto" } },
      status: 200,
      responseBody: {
        id: "xai-1", object: "chat.completion", model: "grok-4-0709", choices: [], citations: ["https://a.example", "https://b.example"],
        usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1700, prompt_tokens_details: { text_tokens: 900, cached_tokens: 640 }, completion_tokens_details: { reasoning_tokens: 500 }, num_sources_used: 3 },
      },
    },
  },
  {
    name: "groq-chat",
    call: {
      url: "https://api.groq.com/openai/v1/chat/completions",
      requestBody: { model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: {
        id: "chatcmpl-groq1", object: "chat.completion", model: "llama-3.3-70b-versatile", choices: [],
        usage: { queue_time: 0.02, prompt_tokens: 40, prompt_time: 0.004, completion_tokens: 10, completion_time: 0.01, total_tokens: 50, total_time: 0.014, prompt_tokens_details: { cached_tokens: 32 } },
        x_groq: { id: "req_groq1" },
      },
    },
  },
  {
    name: "groq-stream-x-groq",
    call: {
      url: "https://api.groq.com/openai/v1/chat/completions",
      requestBody: { model: "openai/gpt-oss-120b", stream: true, messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseHeaders: { "content-type": "text/event-stream" },
      stream: sse([
        { id: "chatcmpl-gs", object: "chat.completion.chunk", model: "openai/gpt-oss-120b", choices: [{ index: 0, delta: { role: "assistant", content: "" } }], x_groq: { id: "req_gs" } },
        { id: "chatcmpl-gs", object: "chat.completion.chunk", model: "openai/gpt-oss-120b", choices: [{ index: 0, delta: { content: "Hello" } }] },
        { id: "chatcmpl-gs", object: "chat.completion.chunk", model: "openai/gpt-oss-120b", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], x_groq: { id: "req_gs", usage: { queue_time: 0.01, prompt_tokens: 75, completion_tokens: 22, total_tokens: 97 } } },
      ]),
    },
  },
  {
    name: "deepseek-chat-cache",
    call: {
      url: "https://api.deepseek.com/chat/completions",
      requestBody: { model: "deepseek-chat", messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: {
        id: "ds-1", object: "chat.completion", model: "deepseek-chat", choices: [],
        usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 768 }, prompt_cache_hit_tokens: 768, prompt_cache_miss_tokens: 232 },
      },
    },
  },
  {
    name: "deepseek-reasoner",
    call: {
      url: "https://api.deepseek.com/v1/chat/completions",
      requestBody: { model: "deepseek-reasoner", messages: [{ role: "user", content: "Prove it" }] },
      status: 200,
      responseBody: {
        id: "ds-2", object: "chat.completion", model: "deepseek-reasoner", choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 600, total_tokens: 620, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20, completion_tokens_details: { reasoning_tokens: 450 } },
      },
    },
  },
  {
    name: "mistral-chat",
    call: {
      url: "https://api.mistral.ai/v1/chat/completions",
      requestBody: { model: "mistral-large-latest", messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "mis-1", object: "chat.completion", model: "mistral-large-latest", choices: [], usage: { prompt_tokens: 9, completion_tokens: 11, total_tokens: 20 } },
    },
  },
  {
    name: "mistral-ocr",
    call: {
      url: "https://api.mistral.ai/v1/ocr",
      requestBody: { model: "mistral-ocr-latest", document: { type: "document_url", document_url: "https://arxiv.org/pdf/2201.04234" } },
      status: 200,
      responseBody: { pages: [{ index: 0, markdown: "# Title" }, { index: 1, markdown: "Body" }, { index: 2, markdown: "End" }], model: "mistral-ocr-2505-completion", usage_info: { pages_processed: 3, doc_size_bytes: 3002783 } },
    },
  },
  {
    name: "together-chat",
    call: {
      url: "https://api.together.xyz/v1/chat/completions",
      requestBody: { model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "tg-1", object: "chat.completion", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", choices: [], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42, cached_tokens: 0 } },
    },
  },
  {
    name: "fireworks-chat-cached",
    call: {
      url: "https://api.fireworks.ai/inference/v1/chat/completions",
      requestBody: { model: "accounts/fireworks/models/llama-v3p1-70b-instruct", messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "fw-1", object: "chat.completion", model: "accounts/fireworks/models/llama-v3p1-70b-instruct", choices: [], usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520, prompt_tokens_details: { cached_tokens: 448 } } },
    },
  },
  {
    name: "perplexity-sonar",
    call: {
      url: "https://api.perplexity.ai/chat/completions",
      requestBody: { model: "sonar-pro", messages: [{ role: "user", content: "Latest AI news" }], web_search_options: { search_context_size: "low" } },
      status: 200,
      responseBody: {
        id: "pplx-1", model: "sonar-pro", object: "chat.completion", created: 1760000000, citations: ["https://a.example"], search_results: [{ title: "A", url: "https://a.example" }], choices: [],
        usage: { prompt_tokens: 8, completion_tokens: 300, total_tokens: 308, search_context_size: "low", citation_tokens: 2400, num_search_queries: 2, reasoning_tokens: 0, cost: { input_tokens_cost: 0.000024, output_tokens_cost: 0.0045, request_cost: 0.006, total_cost: 0.010524 } },
      },
    },
  },
  {
    name: "cerebras-chat",
    call: {
      url: "https://api.cerebras.ai/v1/chat/completions",
      requestBody: { model: "llama3.1-8b", messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "cb-1", object: "chat.completion", model: "llama3.1-8b", choices: [], usage: { prompt_tokens: 64, completion_tokens: 8, total_tokens: 72, prompt_tokens_details: { cached_tokens: 0 } }, time_info: { queue_time: 0.0001, total_time: 0.01 } },
    },
  },
  {
    name: "moonshot-stream-choice-usage",
    call: {
      url: "https://api.moonshot.ai/v1/chat/completions",
      requestBody: { model: "kimi-k2-0905-preview", stream: true, messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseHeaders: { "content-type": "text/event-stream" },
      stream: sse([
        { id: "ms-1", object: "chat.completion.chunk", model: "kimi-k2-0905-preview", choices: [{ index: 0, delta: { content: "Hi" } }] },
        { id: "ms-1", object: "chat.completion.chunk", model: "kimi-k2-0905-preview", choices: [{ index: 0, delta: {}, finish_reason: "stop", usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13, cached_tokens: 0 } }] },
      ]),
    },
  },
  {
    name: "huggingface-feature-extraction",
    call: {
      url: "https://router.huggingface.co/hf-inference/models/BAAI/bge-small-en-v1.5/pipeline/feature-extraction",
      requestBody: { inputs: "hello" },
      status: 200,
      responseBody: [embedding(40)],
    },
  },
  {
    name: "portkey-chat",
    call: {
      url: "https://api.portkey.ai/v1/chat/completions",
      requestBody: { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "chatcmpl-pk", object: "chat.completion", model: "gpt-4o-2024-08-06", provider: "openai", choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } },
    },
  },
  {
    name: "helicone-openai",
    call: {
      url: "https://oai.helicone.ai/v1/chat/completions",
      requestBody: { model: "gpt-4.1-nano", messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "chatcmpl-hc", object: "chat.completion", model: "gpt-4.1-nano-2025-04-14", choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } },
    },
  },
  {
    name: "typesafe-chat",
    call: {
      url: "https://api.typesafe.ai/v1/chat/completions",
      requestBody: { messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "ts-1", model: "jev-1-2026", choices: [], usage: { prompt_tokens: 12, completion_tokens: 30 } },
    },
  },

  // ── Embeddings and rerank ──
  {
    name: "cohere-chat-v2",
    call: {
      url: "https://api.cohere.com/v2/chat",
      requestBody: { model: "command-a-03-2025", messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "co-1", finish_reason: "COMPLETE", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] }, usage: { billed_units: { input_tokens: 5, output_tokens: 9 }, tokens: { input_tokens: 71, output_tokens: 9 } } },
    },
  },
  {
    name: "cohere-rerank",
    call: {
      url: "https://api.cohere.com/v2/rerank",
      requestBody: { model: "rerank-v3.5", query: "q", documents: ["a", "b", "c"] },
      status: 200,
      responseBody: { id: "co-rr", results: [{ index: 1, relevance_score: 0.9 }], meta: { api_version: { version: "2" }, billed_units: { search_units: 1 } } },
    },
  },
  {
    name: "cohere-embed-images",
    call: {
      url: "https://api.cohere.com/v2/embed",
      requestBody: { model: "embed-v4.0", input_type: "image", embedding_types: ["float"], images: ["data:image/png;base64,AAAA"] },
      status: 200,
      responseBody: { id: "co-em", embeddings: { float: [embedding(64)] }, texts: [], meta: { billed_units: { images: 1 } } },
    },
  },
  {
    name: "voyage-embed",
    call: {
      url: "https://api.voyageai.com/v1/embeddings",
      requestBody: { model: "voyage-3.5", input: ["a", "b"] },
      status: 200,
      responseBody: { object: "list", data: [{ object: "embedding", embedding: embedding(1024), index: 0 }], model: "voyage-3.5", usage: { total_tokens: 12 } },
    },
  },
  {
    name: "jina-rerank",
    call: {
      url: "https://api.jina.ai/v1/rerank",
      requestBody: { model: "jina-reranker-v2-base-multilingual", query: "q", documents: ["a", "b"] },
      status: 200,
      responseBody: { model: "jina-reranker-v2-base-multilingual", usage: { total_tokens: 30 }, results: [{ index: 0, relevance_score: 0.8 }] },
    },
  },

  // ── Voice ──
  {
    name: "elevenlabs-tts-header",
    call: {
      url: "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream?output_format=mp3_44100_128",
      requestBody: { text: "This text costs characters.", model_id: "eleven_flash_v2_5" },
      status: 200,
      responseHeaders: { "content-type": "audio/mpeg", "character-cost": "27", "request-id": "el-req-1", "xi-api-key": "nope" },
      responseBytes: 33000,
    },
  },
  {
    name: "elevenlabs-tts-unicode",
    call: {
      url: "https://api.us.elevenlabs.io/v1/text-to-speech/voice123",
      requestBody: { text: "नमस्ते दुनिया 👋🏽 café" },
      status: 200,
      responseHeaders: { "content-type": "audio/mpeg" },
      responseBytes: 12000,
    },
  },
  {
    name: "elevenlabs-stt-words",
    call: {
      url: "https://api.elevenlabs.io/v1/speech-to-text",
      multipart: [{ name: "file", filename: "call.mp3", contentType: "audio/mpeg", bytes: 200000 }, { name: "model_id", value: "scribe_v1" }],
      status: 200,
      responseBody: { language_code: "en", language_probability: 0.98, text: "Hello there friend", words: [{ text: "Hello", start: 0.1, end: 0.5, type: "word" }, { text: "there", start: 0.6, end: 0.9, type: "word" }, { text: "friend", start: 1.0, end: 1.42, type: "word" }] },
    },
  },
  {
    name: "deepgram-listen",
    call: {
      url: "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true",
      requestBytes: 412000,
      method: "POST",
      requestHeaders: { "content-type": "audio/wav" },
      status: 200,
      responseHeaders: { "dg-request-id": "dg-1" },
      responseBody: { metadata: { transaction_key: "deprecated", request_id: "dg-1", sha256: "abc", created: "2026-10-11T09:00:00Z", duration: 25.93, channels: 1, models: ["30089e05"] }, results: { channels: [{ alternatives: [{ transcript: "hello", confidence: 0.99 }] }] } },
    },
  },
  {
    name: "deepgram-listen-default-model",
    call: {
      url: "https://api.deepgram.com/v1/listen",
      requestBody: { url: "https://dpgr.am/spacewalk.wav" },
      status: 200,
      responseBody: { metadata: { duration: 6.2 }, results: { channels: [] } },
    },
  },
  {
    name: "deepgram-speak",
    call: {
      url: "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16",
      requestBody: { text: "Welcome to the show." },
      status: 200,
      responseHeaders: { "content-type": "audio/wav" },
      responseBytes: 90000,
    },
  },
  {
    name: "assemblyai-create",
    call: {
      url: "https://api.assemblyai.com/v2/transcript",
      requestBody: { audio_url: "https://assembly.ai/wildfires.mp3", speech_model: "universal" },
      status: 200,
      responseBody: { id: "tr_1", status: "queued", audio_url: "https://assembly.ai/wildfires.mp3", speech_model: "universal" },
    },
  },
  {
    name: "assemblyai-completed",
    call: {
      url: "https://api.assemblyai.com/v2/transcript/tr_1",
      method: "GET",
      status: 200,
      responseBody: { id: "tr_1", status: "completed", text: "Smoke from wildfires...", audio_duration: 281, speech_model: "universal", words: [] },
    },
  },
  {
    name: "assemblyai-processing",
    call: {
      url: "https://api.eu.assemblyai.com/v2/transcript/tr_2",
      method: "GET",
      status: 200,
      responseBody: { id: "tr_2", status: "processing", audio_duration: null },
    },
  },
  {
    name: "cartesia-tts",
    call: {
      url: "https://api.cartesia.ai/tts/bytes",
      requestHeaders: { "content-type": "application/json", "cartesia-version": "2025-04-16" },
      requestBody: { model_id: "sonic-2", transcript: "Hello from Cartesia.", voice: { mode: "id", id: "a0e99841" }, output_format: { container: "wav", encoding: "pcm_f32le", sample_rate: 44100 } },
      status: 200,
      responseHeaders: { "content-type": "audio/wav" },
      responseBytes: 70000,
    },
  },
  {
    name: "rumik-tts",
    call: {
      url: "https://silk-api.rumik.ai/v1/tts",
      requestBody: { text: "Namaste! Kaise ho?", voice: "aria" },
      status: 200,
      responseHeaders: { "content-type": "audio/wav" },
      responseBytes: 50000,
    },
  },
  {
    name: "sarvam-tts",
    call: {
      url: "https://api.sarvam.ai/text-to-speech",
      requestBody: { inputs: ["नमस्ते, आप कैसे हैं?"], target_language_code: "hi-IN", speaker: "anushka" },
      status: 200,
      responseBody: { request_id: "sv-1", audios: ["UklGRiQAAABXQVZF".repeat(50)] },
    },
  },
  {
    name: "sarvam-stt",
    call: {
      url: "https://api.sarvam.ai/speech-to-text",
      multipart: [{ name: "file", filename: "a.wav", contentType: "audio/wav", bytes: 64000 }, { name: "model", value: "saarika:v2.5" }, { name: "language_code", value: "hi-IN" }],
      status: 200,
      responseBody: { request_id: "sv-2", transcript: "नमस्ते", language_code: "hi-IN", duration: 4.2 },
    },
  },
  {
    name: "sarvam-chat",
    call: {
      url: "https://api.sarvam.ai/v1/chat/completions",
      requestBody: { model: "sarvam-m", messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "sv-c", object: "chat.completion", model: "sarvam-m", choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 } },
    },
  },
  {
    name: "minimax-t2a",
    call: {
      url: "https://api.minimax.io/v1/t2a_v2?GroupId=1234",
      requestBody: { model: "speech-02-hd", text: "Hello from MiniMax speech.", voice_setting: { voice_id: "male-qn-qingse" } },
      status: 200,
      responseBody: { data: { audio: "fffb".repeat(200), status: 2 }, trace_id: "mm-trace", base_resp: { status_code: 0, status_msg: "success" } },
    },
  },
  {
    name: "minimax-chat",
    call: {
      url: "https://api.minimax.io/v1/text/chatcompletion_v2",
      requestBody: { model: "MiniMax-M1", messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "mm-c1", model: "MiniMax-M1", choices: [], usage: { prompt_tokens: 7, completion_tokens: 30, total_tokens: 37 } },
    },
  },

  // ── Search and scraping ──
  {
    name: "exa-search-deep",
    call: {
      url: "https://api.exa.ai/search",
      requestBody: { query: "best vector databases", type: "deep", numResults: 25, contents: { text: true } },
      status: 200,
      responseBody: { requestId: "exa-req-1", resolvedSearchType: "deep", results: [{ id: "https://a.example", url: "https://a.example", title: "A" }], costDollars: { total: 0.027, search: { deep: 0.012 } } },
    },
  },
  {
    name: "exa-contents",
    call: {
      url: "https://api.exa.ai/contents",
      requestBody: { ids: ["https://a.example", "https://b.example", "https://c.example"], text: true },
      status: 200,
      responseBody: { requestId: "exa-req-2", results: [{ id: "a" }, { id: "b" }, { id: "c" }], costDollars: { total: 0.003 } },
    },
  },
  {
    name: "exa-answer",
    call: {
      url: "https://api.exa.ai/answer",
      requestBody: { query: "What is CostKey?" },
      status: 200,
      responseBody: { answer: "A cost tool.", citations: [], requestId: "exa-req-3", costDollars: { total: 0.005 } },
    },
  },
  {
    name: "firecrawl-scrape",
    call: {
      url: "https://api.firecrawl.dev/v2/scrape",
      requestBody: { url: "https://firecrawl.dev", formats: ["markdown"] },
      status: 200,
      responseBody: { success: true, data: { markdown: "# Firecrawl", metadata: { title: "Firecrawl", sourceURL: "https://firecrawl.dev", statusCode: 200, creditsUsed: 1 } } },
    },
  },
  {
    name: "firecrawl-crawl-completed",
    call: {
      url: "https://api.firecrawl.dev/v2/crawl/123-abc",
      method: "GET",
      status: 200,
      responseBody: { status: "completed", total: 50, completed: 50, creditsUsed: 50, expiresAt: "2026-10-12T00:00:00Z", next: null, data: [{ markdown: "p1" }] },
    },
  },
  {
    name: "firecrawl-crawl-next-page",
    call: {
      url: "https://api.firecrawl.dev/v2/crawl/123-abc?skip=10",
      method: "GET",
      status: 200,
      responseBody: { status: "completed", total: 50, completed: 50, creditsUsed: 50, data: [{ markdown: "p11" }] },
    },
  },
  {
    name: "firecrawl-crawl-scraping",
    call: {
      url: "https://api.firecrawl.dev/v2/crawl/123-abc",
      method: "GET",
      status: 200,
      responseBody: { status: "scraping", total: 50, completed: 10, creditsUsed: 10, data: [] },
    },
  },
  {
    name: "firecrawl-search",
    call: {
      url: "https://api.firecrawl.dev/v2/search",
      requestBody: { query: "firecrawl", limit: 7 },
      status: 200,
      responseBody: { success: true, data: { web: [{ url: "https://a.example", title: "A" }] }, creditsUsed: 2 },
    },
  },
  {
    name: "tavily-search-advanced",
    call: {
      url: "https://api.tavily.com/search",
      requestBody: { query: "who is Leo Messi?", search_depth: "advanced", include_usage: true },
      status: 200,
      responseBody: { query: "who is Leo Messi?", results: [{ title: "Messi", url: "https://a.example", score: 0.9 }], response_time: 1.2, usage: { credits: 2 }, request_id: "tv-1" },
    },
  },
  {
    name: "tavily-extract",
    call: {
      url: "https://api.tavily.com/extract",
      requestBody: { urls: ["https://a.example"], include_usage: true },
      status: 200,
      responseBody: { results: [{ url: "https://a.example", raw_content: "..." }], failed_results: [], usage: { credits: 1 }, request_id: "tv-2" },
    },
  },

  // ── Cloudflare, Ollama, Upstage ──
  {
    name: "cloudflare-run",
    call: {
      url: "https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/@cf/meta/llama-3.1-8b-instruct",
      requestBody: { messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { result: { response: "Hello!", usage: { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 } }, success: true, errors: [], messages: [] },
    },
  },
  {
    name: "cloudflare-openai-compatible",
    call: {
      url: "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1/chat/completions",
      requestBody: { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "cf-1", object: "chat.completion", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
    },
  },
  {
    name: "ollama-chat",
    call: {
      url: "http://localhost:11434/api/chat",
      requestBody: { model: "llama3.2", messages: [{ role: "user", content: "Hi" }], stream: false },
      status: 200,
      responseBody: { model: "llama3.2", created_at: "2026-10-11T09:00:00Z", message: { role: "assistant", content: "Hello" }, done: true, total_duration: 500000000, prompt_eval_count: 26, eval_count: 9 },
    },
  },
  {
    name: "ollama-stream-ndjson",
    call: {
      url: "http://127.0.0.1:11434/api/generate",
      requestBody: { model: "qwen3:8b", prompt: "Hi" },
      status: 200,
      responseHeaders: { "content-type": "application/x-ndjson" },
      stream: {
        format: "ndjson",
        records: [
          { model: "qwen3:8b", created_at: "2026-10-11T09:00:00Z", response: "Hel", done: false },
          { model: "qwen3:8b", created_at: "2026-10-11T09:00:01Z", response: "lo", done: false },
          { model: "qwen3:8b", created_at: "2026-10-11T09:00:02Z", response: "", done: true, prompt_eval_count: 11, eval_count: 40 },
        ],
      },
    },
  },
  {
    name: "upstage-document-parse",
    call: {
      url: "https://api.upstage.ai/v1/document-digitization",
      multipart: [{ name: "document", filename: "invoice.pdf", contentType: "application/pdf", bytes: 300000 }, { name: "model", value: "document-parse" }],
      status: 200,
      responseBody: { api: "2.0", content: { html: "<p>..</p>" }, model: "document-parse-250618", usage: { pages: 4 } },
    },
  },
  {
    name: "upstage-chat",
    call: {
      url: "https://api.upstage.ai/v1/chat/completions",
      requestBody: { model: "solar-pro2", messages: [{ role: "user", content: "Hi" }] },
      status: 200,
      responseBody: { id: "up-1", object: "chat.completion", model: "solar-pro2-250710", choices: [], usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } },
    },
  },

  // ── Edge cases of the skeleton itself ──
  {
    name: "long-model-name-truncated",
    call: {
      url: "https://api.openai.com/v1/chat/completions",
      requestBody: { model: "ft:gpt-4o-mini:acme::" + "x".repeat(220), messages: [] },
      status: 200,
      responseBody: { id: "chatcmpl-long", model: "ft:gpt-4o-mini:acme::" + "x".repeat(220), choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    },
  },
];
