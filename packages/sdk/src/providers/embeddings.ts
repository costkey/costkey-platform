import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage } from "./types.js";
import { responseOrRequestModel } from "./openai.js";
import { asCount, asRecord } from "./units.js";

/** Embedding and rerank APIs bill `usage.total_tokens` as input tokens. */
function totalTokensAsInput(body: unknown): NormalizedUsage | null {
  const total = asCount(asRecord(asRecord(body)?.["usage"])?.["total_tokens"]);
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

/** The requested model names the priced model; responses may echo a resolved alias. */
function requestOrResponseModel(requestBody: unknown, responseBody: unknown): string | null {
  const model = asRecord(requestBody)?.["model"];
  if (typeof model === "string" && model.trim()) return model.trim();
  return responseOrRequestModel(null, responseBody);
}

/** Voyage AI — api.voyageai.com embeddings, multimodal embeddings and rerank. */
export const voyageExtractor: ProviderExtractor = {
  provider: Provider.Voyage,
  match(url: URL) { return url.hostname === "api.voyageai.com"; },
  extractUsage: totalTokensAsInput,
  extractModel: requestOrResponseModel,
};

/** Jina AI — api.jina.ai embeddings and rerank. */
export const jinaExtractor: ProviderExtractor = {
  provider: Provider.Jina,
  match(url: URL) { return url.hostname === "api.jina.ai"; },
  extractUsage: totalTokensAsInput,
  extractModel: requestOrResponseModel,
};
