import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage, ExtractorCall } from "./types.js";
import { asRecord, headerCount } from "./units.js";

/** /model/{modelId}/converse, converse-stream, invoke, invoke-with-response-stream */
const MODEL_PATH = /\/model\/([^/]+)\/(?:converse|converse-stream|invoke|invoke-with-response-stream)\/?$/;

/**
 * Bedrock model IDs may arrive URL-encoded or as ARNs; price by the
 * foundation model or inference profile ID inside an ARN.
 */
export function bedrockModelId(raw: string): string {
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // Keep the raw ID when it isn't valid percent-encoding.
  }
  const arn = id.match(/^arn:[^/]*:(?:foundation-model|inference-profile)\/(.+)$/);
  return arn ? arn[1] : id;
}

/**
 * Converse `usage` (camelCase), Anthropic-on-Bedrock `usage` (snake_case) and
 * `amazon-bedrock-invocationMetrics` (InvokeModel streams).
 */
function bodyUsage(body: unknown): NormalizedUsage | null {
  const b = asRecord(body);
  if (!b) return null;
  const usage = asRecord(b["usage"]);
  const metrics = asRecord(b["amazon-bedrock-invocationMetrics"]);
  if (!usage && !metrics) return null;

  const inputTokens = asNumber(usage?.["inputTokens"]) ?? asNumber(usage?.["input_tokens"]) ?? asNumber(metrics?.["inputTokenCount"]);
  const outputTokens = asNumber(usage?.["outputTokens"]) ?? asNumber(usage?.["output_tokens"]) ?? asNumber(metrics?.["outputTokenCount"]);
  const cacheReadTokens = asNumber(usage?.["cacheReadInputTokens"]) ?? asNumber(usage?.["cache_read_input_tokens"]) ?? asNumber(metrics?.["cacheReadInputTokenCount"]);
  const cacheCreationTokens = asNumber(usage?.["cacheWriteInputTokens"]) ?? asNumber(usage?.["cache_creation_input_tokens"]) ?? asNumber(metrics?.["cacheWriteInputTokenCount"]);
  if (inputTokens == null && outputTokens == null && cacheReadTokens == null && cacheCreationTokens == null) return null;

  return {
    inputTokens,
    outputTokens,
    totalTokens: asNumber(usage?.["totalTokens"]) ??
      (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null),
    reasoningTokens: null,
    cacheReadTokens,
    cacheCreationTokens,
  };
}

/** InvokeModel reports token counts for every model family in response headers. */
function headerUsage(headers: Headers | null | undefined): NormalizedUsage | null {
  const inputTokens = headerCount(headers, "x-amzn-bedrock-input-token-count");
  const outputTokens = headerCount(headers, "x-amzn-bedrock-output-token-count");
  const cacheReadTokens = headerCount(headers, "x-amzn-bedrock-cache-read-input-token-count");
  const cacheCreationTokens = headerCount(headers, "x-amzn-bedrock-cache-write-input-token-count");
  if (inputTokens == null && outputTokens == null) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null,
    reasoningTokens: null,
    cacheReadTokens,
    cacheCreationTokens,
  };
}

/**
 * AWS Bedrock — Amazon's AI service
 * Endpoint: bedrock-runtime.{region}.amazonaws.com
 * Converse returns `usage`; InvokeModel bodies vary by model family, so the
 * token-count headers fill what the body lacks. The model is in the URL path.
 */
export const bedrockExtractor: ProviderExtractor = {
  provider: Provider.Bedrock,

  match(url: URL): boolean {
    return url.hostname.includes("bedrock-runtime") && url.hostname.endsWith(".amazonaws.com");
  },

  extractUsage(body: unknown, call?: ExtractorCall): NormalizedUsage | null {
    const fromBody = bodyUsage(body);
    const fromHeaders = headerUsage(call?.responseHeaders);
    if (!fromBody || !fromHeaders) return fromBody ?? fromHeaders;
    const inputTokens = fromBody.inputTokens ?? fromHeaders.inputTokens;
    const outputTokens = fromBody.outputTokens ?? fromHeaders.outputTokens;
    return {
      inputTokens,
      outputTokens,
      totalTokens: fromBody.totalTokens ??
        (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null),
      reasoningTokens: null,
      cacheReadTokens: fromBody.cacheReadTokens ?? fromHeaders.cacheReadTokens,
      cacheCreationTokens: fromBody.cacheCreationTokens ?? fromHeaders.cacheCreationTokens,
    };
  },

  extractModel(requestBody: unknown, _responseBody: unknown, call?: ExtractorCall): string | null {
    // AWS SDK command input carries modelId; over HTTP it is only in the path.
    const modelId = asRecord(requestBody)?.["modelId"];
    if (typeof modelId === "string" && modelId) return bedrockModelId(modelId);
    const match = call?.url.pathname.match(MODEL_PATH);
    return match ? bedrockModelId(match[1]) : null;
  },
};

function asNumber(val: unknown): number | null {
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  return null;
}
