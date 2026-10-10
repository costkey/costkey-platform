import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage } from "./types.js";
import { asCount, asRecord } from "./units.js";

function asNumber(val: unknown): number | null {
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  return null;
}

/** Standard OpenAI-compatible usage extraction — works for many providers */
function extractOpenAIUsage(body: unknown): NormalizedUsage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const usage = b["usage"] as Record<string, unknown> | undefined;
  if (!usage) return null;

  const costUsd = asNumber(usage["cost"]);

  return {
    inputTokens: asNumber(usage["prompt_tokens"]) ?? asNumber(usage["input_tokens"]),
    outputTokens: asNumber(usage["completion_tokens"]) ?? asNumber(usage["output_tokens"]),
    totalTokens: asNumber(usage["total_tokens"]),
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    ...(costUsd != null ? { costUsd } : {}),
  };
}

function extractModel(requestBody: unknown, responseBody: unknown): string | null {
  const resp = responseBody as Record<string, unknown> | null;
  if (resp && typeof resp["model"] === "string") return resp["model"];
  const req = requestBody as Record<string, unknown> | null;
  if (req && typeof req["model"] === "string") return req["model"];
  return null;
}

/**
 * Cohere usage. v1 bodies carry `meta`, v2 bodies `usage`, and a v2 stream's
 * message-end event `delta.usage`; each holds `billed_units` (what is
 * charged) and `tokens`. Embed bills input tokens (and images), rerank bills
 * search units.
 */
function cohereUsage(body: unknown): NormalizedUsage | null {
  const b = asRecord(body);
  if (!b) return null;
  const meta =
    asRecord(b["meta"]) ??
    asRecord(b["usage"]) ??
    asRecord(asRecord(b["delta"])?.["usage"]);
  const billed = asRecord(meta?.["billed_units"]);
  const tokens = asRecord(meta?.["tokens"]);
  if (!billed && !tokens) return extractOpenAIUsage(body);

  const inputTokens = asCount(billed?.["input_tokens"]) ?? asCount(tokens?.["input_tokens"]);
  const outputTokens = asCount(billed?.["output_tokens"]) ?? asCount(tokens?.["output_tokens"]);
  const searchUnits = asCount(billed?.["search_units"]);
  const images = asCount(billed?.["images"]);
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

/** Cohere — api.cohere.com (and the legacy api.cohere.ai) */
export const cohereExtractor: ProviderExtractor = {
  provider: Provider.Cohere,
  match(url: URL) { return url.hostname === "api.cohere.com" || url.hostname === "api.cohere.ai"; },
  extractUsage: cohereUsage,
  extractModel,
};

/** Mistral — api.mistral.ai */
export const mistralExtractor: ProviderExtractor = {
  provider: Provider.Mistral,
  match(url: URL) { return url.hostname === "api.mistral.ai"; },
  extractUsage: extractOpenAIUsage,
  extractModel,
};

/** Together AI — api.together.xyz */
export const togetherExtractor: ProviderExtractor = {
  provider: Provider.Together,
  match(url: URL) { return url.hostname === "api.together.xyz"; },
  extractUsage: extractOpenAIUsage,
  extractModel,
};

/** DeepSeek — api.deepseek.com */
export const deepseekExtractor: ProviderExtractor = {
  provider: Provider.DeepSeek,
  match(url: URL) { return url.hostname === "api.deepseek.com"; },
  extractUsage(body: unknown): NormalizedUsage | null {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;
    const usage = b["usage"] as Record<string, unknown> | undefined;
    if (!usage) return null;

    const details = usage["completion_tokens_details"] as Record<string, unknown> | undefined;

    return {
      inputTokens: asNumber(usage["prompt_tokens"]),
      outputTokens: asNumber(usage["completion_tokens"]),
      totalTokens: asNumber(usage["total_tokens"]),
      reasoningTokens: details ? asNumber(details["reasoning_tokens"]) : null,
      cacheReadTokens: asNumber(usage["prompt_cache_hit_tokens"]),
      cacheCreationTokens: asNumber(usage["prompt_cache_miss_tokens"]),
    };
  },
  extractModel,
};

/** Fireworks AI — api.fireworks.ai */
export const fireworksExtractor: ProviderExtractor = {
  provider: Provider.Fireworks,
  match(url: URL) { return url.hostname === "api.fireworks.ai"; },
  extractUsage: extractOpenAIUsage,
  extractModel,
};

/** Perplexity — api.perplexity.ai */
export const perplexityExtractor: ProviderExtractor = {
  provider: Provider.Perplexity,
  match(url: URL) { return url.hostname === "api.perplexity.ai"; },
  extractUsage: extractOpenAIUsage,
  extractModel,
};

/** Cerebras — api.cerebras.ai */
export const cerebrasExtractor: ProviderExtractor = {
  provider: Provider.Cerebras,
  match(url: URL) { return url.hostname === "api.cerebras.ai"; },
  extractUsage: extractOpenAIUsage,
  extractModel,
};

/** Typesafe (Jev) — api.typesafe.ai, OpenAI-style usage */
export const typesafeExtractor: ProviderExtractor = {
  provider: Provider.Typesafe,
  match(url: URL) { return url.hostname === "api.typesafe.ai"; },
  extractUsage(body: unknown): NormalizedUsage | null {
    const usage = extractOpenAIUsage(body);
    if (usage && usage.totalTokens == null && usage.inputTokens != null && usage.outputTokens != null) {
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
    }
    return usage;
  },
  extractModel(requestBody: unknown, responseBody: unknown): string | null {
    const req = requestBody as Record<string, unknown> | null;
    if (req && typeof req["model"] === "string") return req["model"];
    const resp = responseBody as Record<string, unknown> | null;
    if (resp && typeof resp["model"] === "string") return resp["model"];
    return "jev-latest";
  },
};
