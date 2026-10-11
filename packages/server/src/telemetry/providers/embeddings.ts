import type { ServerExtractor } from "../types.js";
import { asObject, count, num } from "../skeleton.js";
import type { NormalizedUsage } from "../usage.js";
import { hostIn, requestOrResponseModel, responseOrRequestModel } from "./common.js";

/** Embedding and rerank APIs bill `usage.total_tokens` as input tokens. */
function totalTokensAsInput(body: unknown): NormalizedUsage | null {
  const total = count(asObject(asObject(body)?.["usage"])?.["total_tokens"]);
  if (total == null) return null;
  return {
    inputTokens: total,
    outputTokens: null,
    totalTokens: total,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
  };
}

/** Voyage AI: embeddings, multimodal embeddings and rerank. */
export const voyageExtractor: ServerExtractor = {
  provider: "voyage",
  match: hostIn("api.voyageai.com"),
  extractUsage: (body) => totalTokensAsInput(body),
  extractModel: (requestBody, responseBody) => requestOrResponseModel(requestBody, responseBody),
};

/** Jina AI: embeddings and rerank. */
export const jinaExtractor: ServerExtractor = {
  provider: "jina",
  match: hostIn("api.jina.ai"),
  extractUsage: (body) => totalTokensAsInput(body),
  extractModel: (requestBody, responseBody) => requestOrResponseModel(requestBody, responseBody),
};

/** OpenAI-shaped fallback for Cohere's compatibility routes. */
function plainOpenAIUsage(body: unknown): NormalizedUsage | null {
  const usage = asObject(asObject(body)?.["usage"]);
  if (!usage) return null;
  const costUsd = num(usage["cost"]);
  return {
    inputTokens: num(usage["prompt_tokens"]) ?? num(usage["input_tokens"]),
    outputTokens: num(usage["completion_tokens"]) ?? num(usage["output_tokens"]),
    totalTokens: num(usage["total_tokens"]),
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    ...(costUsd != null ? { costUsd } : {}),
  };
}

/**
 * Cohere: v1 bodies carry `meta`, v2 bodies `usage`, a v2 stream's
 * message-end event `delta.usage`; each holds `billed_units` (what is
 * charged, preferred) and `tokens`. Rerank bills search units, embed images.
 */
function cohereUsage(body: unknown): NormalizedUsage | null {
  const b = asObject(body);
  if (!b) return null;
  const meta = asObject(b["meta"]) ?? asObject(b["usage"]) ?? asObject(asObject(b["delta"])?.["usage"]);
  const billed = asObject(meta?.["billed_units"]);
  const tokens = asObject(meta?.["tokens"]);
  if (!billed && !tokens) return plainOpenAIUsage(body);
  const inputTokens = count(billed?.["input_tokens"]) ?? count(tokens?.["input_tokens"]);
  const outputTokens = count(billed?.["output_tokens"]) ?? count(tokens?.["output_tokens"]);
  const searchUnits = count(billed?.["search_units"]);
  const images = count(billed?.["images"]);
  const nativeUnits: Record<string, number> = {};
  if (searchUnits != null && searchUnits > 0) nativeUnits["searchQueries"] = searchUnits;
  if (images != null && images > 0) nativeUnits["images"] = images;
  if (inputTokens == null && outputTokens == null && Object.keys(nativeUnits).length === 0) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    ...(Object.keys(nativeUnits).length > 0 ? { nativeUnits } : {}),
  };
}

/** Cohere: api.cohere.com (and the legacy api.cohere.ai). */
export const cohereExtractor: ServerExtractor = {
  provider: "cohere",
  match: hostIn("api.cohere.com", "api.cohere.ai"),
  extractUsage: (body) => cohereUsage(body),
  extractModel: (requestBody, responseBody) => responseOrRequestModel(requestBody, responseBody),
};
