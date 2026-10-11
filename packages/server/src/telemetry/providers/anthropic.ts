import type { ServerExtractor } from "../types.js";
import { asObject, num } from "../skeleton.js";
import { type NormalizedUsage, withUnits } from "../usage.js";
import { responseOrRequestModel } from "./common.js";

/**
 * Anthropic Messages usage, including prompt-cache reads and writes. Also used
 * for Claude on Vertex AI and Helicone's Anthropic proxy, which return the
 * same body and stream events.
 *
 * Beyond SDK 0.6: the cache-write split by TTL (`cache_creation`
 * ephemeral_5m/1h, the 1-hour tier is billed at a higher rate) and server
 * tool use (web search and web fetch requests, billed per request) are kept
 * as native units.
 */
export function anthropicUsage(body: unknown): NormalizedUsage | null {
  const usage = asObject(asObject(body)?.["usage"]);
  if (!usage) return null;
  const inputTokens = num(usage["input_tokens"]);
  const outputTokens = num(usage["output_tokens"]);
  const base: NormalizedUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null,
    reasoningTokens: null,
    cacheReadTokens: num(usage["cache_read_input_tokens"]),
    cacheCreationTokens: num(usage["cache_creation_input_tokens"]),
  };
  const cacheCreation = asObject(usage["cache_creation"]);
  const serverTools = asObject(usage["server_tool_use"]);
  const positive = (value: unknown): number | null => {
    const n = num(value);
    return n != null && n > 0 ? n : null;
  };
  return withUnits(base, {
    cacheCreation5mTokens: positive(cacheCreation?.["ephemeral_5m_input_tokens"]),
    cacheCreation1hTokens: positive(cacheCreation?.["ephemeral_1h_input_tokens"]),
    webSearchRequests: positive(serverTools?.["web_search_requests"]),
    webFetchRequests: positive(serverTools?.["web_fetch_requests"]),
  });
}

export const anthropicExtractor: ServerExtractor = {
  provider: "anthropic",
  match(url) {
    return url.hostname === "api.anthropic.com";
  },
  extractUsage: (body) => anthropicUsage(body),
  extractModel: (requestBody, responseBody) => responseOrRequestModel(requestBody, responseBody),
};

/** Helicone's Anthropic proxy returns Anthropic bodies. */
export const anthropicGatewayExtractor: ServerExtractor = {
  ...anthropicExtractor,
  match(url) {
    return url.hostname === "anthropic.helicone.ai";
  },
};
