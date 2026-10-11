import type { ExtractCall, ServerExtractor } from "../types.js";
import { arrayLength, asObject, count, num, strLength } from "../skeleton.js";
import { type NormalizedUsage, unitUsage } from "../usage.js";
import { responseOrRequestModel, succeeded } from "./common.js";

/** /v1/audio/speech, and Azure's /openai/deployments/{d}/audio/speech */
export const SPEECH_PATH = /\/audio\/speech\/?$/;
const TRANSCRIPTION_PATH = /\/audio\/(?:transcriptions|translations)\/?$/;
const IMAGES_PATH = /\/images\/(?:generations|edits|variations)\/?$/;
/** The Images API's documented default model. */
const DEFAULT_IMAGE_MODEL = "dall-e-2";

function isAzureOpenAI(hostname: string): boolean {
  return hostname.endsWith(".openai.azure.com")
    || hostname.endsWith(".services.ai.azure.com")
    || hostname.endsWith(".cognitiveservices.azure.com");
}

/**
 * Token usage in the OpenAI shape: Chat Completions (`prompt_tokens`,
 * `completion_tokens`) or the Responses API (`input_tokens`,
 * `output_tokens`), with cached prompt and reasoning token details.
 */
export function openaiUsage(body: unknown): NormalizedUsage | null {
  const usage = asObject(asObject(body)?.["usage"]);
  if (!usage) return null;
  const inputDetails = asObject(usage["input_tokens_details"]);
  const promptDetails = asObject(usage["prompt_tokens_details"]);
  const inputTokens = num(usage["prompt_tokens"]) ?? num(usage["input_tokens"]);
  const outputTokens = num(usage["completion_tokens"]) ?? num(usage["output_tokens"]);
  const totalTokens = num(usage["total_tokens"])
    ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null);
  const details = asObject(usage["completion_tokens_details"]) ?? asObject(usage["output_tokens_details"]);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens: details ? num(details["reasoning_tokens"]) : null,
    cacheReadTokens: num(inputDetails?.["cached_tokens"]) ?? num(promptDetails?.["cached_tokens"]),
    cacheCreationTokens: null,
  };
}

/**
 * Text-to-speech bills characters of the request `input` (its `$s` length);
 * the audio is never read. Transcription reports `usage` as seconds
 * (whisper) or tokens (gpt-4o-transcribe), or a verbose_json `duration`.
 * Returns undefined for other routes.
 */
function audioUsage(body: unknown, call: ExtractCall): NormalizedUsage | null | undefined {
  const path = call.url.pathname;
  if (SPEECH_PATH.test(path)) {
    if (!succeeded(call)) return null;
    const characters = strLength(asObject(call.requestBody)?.["input"]);
    return characters != null ? unitUsage({ characters }) : null;
  }
  const response = asObject(body);
  const usage = asObject(response?.["usage"]);
  if (usage?.["type"] === "duration") {
    const seconds = count(usage["seconds"]);
    return seconds != null ? unitUsage({ audioSeconds: seconds }) : null;
  }
  if (TRANSCRIPTION_PATH.test(path) && !usage) {
    const duration = count(response?.["duration"]);
    return duration != null ? unitUsage({ audioSeconds: duration }) : null;
  }
  return undefined;
}

/**
 * Images API: gpt-image models report token usage whose output is image
 * tokens; DALL-E reports none and bills per generated image.
 */
function imagesUsage(body: unknown, call: ExtractCall): NormalizedUsage | null {
  const usage = openaiUsage(body);
  if (usage) {
    return usage.outputTokens != null ? { ...usage, imageOutputTokens: usage.outputTokens } : usage;
  }
  if (!succeeded(call)) return null;
  const images = arrayLength(asObject(body)?.["data"]);
  return images != null && images > 0 ? unitUsage({ images }) : null;
}

export const openaiExtractor: ServerExtractor = {
  provider: "openai",
  match(url) {
    return url.hostname === "api.openai.com" || isAzureOpenAI(url.hostname);
  },
  extractUsage(body, call) {
    if (IMAGES_PATH.test(call.url.pathname)) return imagesUsage(body, call);
    const audio = audioUsage(body, call);
    return audio !== undefined ? audio : openaiUsage(body);
  },
  extractModel(requestBody, responseBody, call) {
    const model = responseOrRequestModel(requestBody, responseBody);
    // Azure names the deployment in the path, not the model.
    if (model == null && call.url.hostname === "api.openai.com" && IMAGES_PATH.test(call.url.pathname)) {
      return DEFAULT_IMAGE_MODEL;
    }
    return model;
  },
};
