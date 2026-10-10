import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage, ExtractorCall } from "./types.js";
import { asCount, asRecord, countCharacters, succeeded, unitUsage } from "./units.js";

const OPENAI_HOSTS = new Set([
  "api.openai.com",
]);

/** Matches Azure OpenAI endpoints like xxx.openai.azure.com */
function isAzureOpenAI(hostname: string): boolean {
  return hostname.endsWith(".openai.azure.com")
    || hostname.endsWith(".services.ai.azure.com")
    || hostname.endsWith(".cognitiveservices.azure.com");
}

/** /v1/audio/speech, and Azure's /openai/deployments/{d}/audio/speech */
const SPEECH_PATH = /\/audio\/speech\/?$/;
const TRANSCRIPTION_PATH = /\/audio\/(?:transcriptions|translations)\/?$/;

/**
 * Token usage in the OpenAI shape: Chat Completions (`prompt_tokens`,
 * `completion_tokens`) or the Responses API (`input_tokens`,
 * `output_tokens`), with cached prompt and reasoning token details. Shared by
 * every OpenAI-compatible host.
 */
export function openaiUsage(body: unknown): NormalizedUsage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  const usage = b["usage"] as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;

  const inputDetails = usage["input_tokens_details"] as Record<string, unknown> | undefined;
  const promptDetails = usage["prompt_tokens_details"] as Record<string, unknown> | undefined;

  const inputTokens =
    asNumber(usage["prompt_tokens"]) ?? asNumber(usage["input_tokens"]);
  const outputTokens =
    asNumber(usage["completion_tokens"]) ?? asNumber(usage["output_tokens"]);
  const totalTokens =
    asNumber(usage["total_tokens"]) ??
    (inputTokens != null && outputTokens != null
      ? inputTokens + outputTokens
      : null);

  // Reasoning tokens (o-series models)
  const details =
    (usage["completion_tokens_details"] as Record<string, unknown>) ??
    (usage["output_tokens_details"] as Record<string, unknown>);
  const reasoningTokens = details
    ? asNumber(details["reasoning_tokens"])
    : null;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cacheReadTokens: asNumber(inputDetails?.["cached_tokens"]) ?? asNumber(promptDetails?.["cached_tokens"]),
    cacheCreationTokens: null,
  };
}

/** The model the response reports (it may differ from the request), else the requested one. */
export function responseOrRequestModel(requestBody: unknown, responseBody: unknown): string | null {
  const resp = responseBody as Record<string, unknown> | null;
  if (resp && typeof resp["model"] === "string") return resp["model"];

  const req = requestBody as Record<string, unknown> | null;
  if (req && typeof req["model"] === "string") return req["model"];

  return null;
}

/**
 * Ask a streamed Chat/Completions request to report usage in its final chunk
 * (`stream_options.include_usage`), keeping any caller stream options.
 */
export function injectIncludeUsage(requestBody: unknown): unknown {
  if (!requestBody || typeof requestBody !== "object") return requestBody;
  const body = { ...(requestBody as Record<string, unknown>) };

  // Only inject for streaming requests
  if (!body["stream"]) return requestBody;
  // The Responses API (`input`) reports usage in response.completed and
  // rejects chat-only stream options; only Chat/Completions bodies need it.
  if (body["messages"] === undefined && body["prompt"] === undefined) return requestBody;

  // Merge with existing stream_options, don't overwrite
  const existing =
    (body["stream_options"] as Record<string, unknown>) ?? {};
  body["stream_options"] = {
    ...existing,
    include_usage: true,
  };

  return body;
}

/**
 * Text-to-speech bills characters of the request `input`; the audio body is
 * never read. Transcription reports `usage` as seconds (whisper) or tokens
 * (gpt-4o-transcribe), or a verbose_json `duration`.
 */
function audioUsage(body: unknown, call: ExtractorCall | undefined): NormalizedUsage | null | undefined {
  const path = call?.url.pathname ?? "";
  if (SPEECH_PATH.test(path)) {
    if (!succeeded(call)) return null;
    const input = asRecord(call.requestBody)?.["input"];
    return typeof input === "string" ? unitUsage({ characters: countCharacters(input) }) : null;
  }
  const response = asRecord(body);
  const usage = asRecord(response?.["usage"]);
  if (usage?.["type"] === "duration") {
    const seconds = asCount(usage["seconds"]);
    return seconds != null ? unitUsage({ audioSeconds: seconds }) : null;
  }
  if (TRANSCRIPTION_PATH.test(path) && !usage) {
    const duration = asCount(response?.["duration"]);
    return duration != null ? unitUsage({ audioSeconds: duration }) : null;
  }
  return undefined;
}

export const openaiExtractor: ProviderExtractor = {
  provider: Provider.OpenAI,

  match(url: URL): boolean {
    return OPENAI_HOSTS.has(url.hostname) || isAzureOpenAI(url.hostname);
  },

  readResponseBody(call: ExtractorCall): boolean {
    return !SPEECH_PATH.test(call.url.pathname);
  },

  extractUsage(body: unknown, call?: ExtractorCall): NormalizedUsage | null {
    const audio = audioUsage(body, call);
    return audio !== undefined ? audio : openaiUsage(body);
  },

  extractModel(requestBody: unknown, responseBody: unknown): string | null {
    return responseOrRequestModel(requestBody, responseBody);
  },

  injectStreamOptions: injectIncludeUsage,
};

function asNumber(val: unknown): number | null {
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  return null;
}
