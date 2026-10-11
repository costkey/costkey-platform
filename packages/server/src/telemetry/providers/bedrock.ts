import type { ServerExtractor } from "../types.js";
import { arrayLength, asObject, items, num, str } from "../skeleton.js";
import { mergeUsage, type NormalizedUsage, withUnits } from "../usage.js";
import { headerCount, safeDecode } from "./common.js";

/** /model/{modelId}/converse, converse-stream, invoke, invoke-with-response-stream */
const MODEL_PATH = /\/model\/([^/]+)\/(?:converse|converse-stream|invoke|invoke-with-response-stream)\/?$/;
const ANY_MODEL_PATH = /\/model\/([^/]+)\//;

/**
 * Bedrock model IDs may arrive URL-encoded or as ARNs; price by the
 * foundation model or inference profile ID inside an ARN.
 */
export function bedrockModelId(raw: string): string {
  const id = safeDecode(raw);
  const arn = id.match(/^arn:[^/]*:(?:foundation-model|inference-profile)\/(.+)$/);
  return arn ? arn[1]! : id;
}

function tokens(
  inputTokens: number | null,
  outputTokens: number | null,
  extra: { totalTokens?: number | null; cacheReadTokens?: number | null; cacheCreationTokens?: number | null } = {},
): NormalizedUsage | null {
  const cacheReadTokens = extra.cacheReadTokens ?? null;
  const cacheCreationTokens = extra.cacheCreationTokens ?? null;
  if (inputTokens == null && outputTokens == null && cacheReadTokens == null && cacheCreationTokens == null) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: extra.totalTokens ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null),
    reasoningTokens: null,
    cacheReadTokens,
    cacheCreationTokens,
  };
}

const first = (record: Record<string, unknown> | null, ...keys: string[]): number | null => {
  for (const key of keys) {
    const value = num(record?.[key]);
    if (value != null) return value;
  }
  return null;
};

/**
 * Body usage: Converse `usage` (camelCase), Anthropic-on-Bedrock `usage`
 * (snake_case), `amazon-bedrock-invocationMetrics` (InvokeModel streams),
 * and Llama / Titan InvokeModel bodies; plus images generated (Titan,
 * Stability).
 */
function bodyUsage(body: unknown): NormalizedUsage | null {
  const b = asObject(body);
  if (!b) return null;
  let found: NormalizedUsage | null = null;
  const usage = asObject(b["usage"]);
  if (usage) {
    const reported = tokens(
      first(usage, "inputTokens", "input_tokens"),
      first(usage, "outputTokens", "output_tokens"),
      {
        totalTokens: first(usage, "totalTokens"),
        cacheReadTokens: first(usage, "cacheReadInputTokens", "cache_read_input_tokens"),
        cacheCreationTokens: first(usage, "cacheWriteInputTokens", "cache_creation_input_tokens"),
      },
    );
    if (reported) found = mergeUsage(found, reported);
  }
  const metrics = asObject(b["amazon-bedrock-invocationMetrics"]);
  if (metrics) {
    const reported = tokens(first(metrics, "inputTokenCount"), first(metrics, "outputTokenCount"), {
      cacheReadTokens: first(metrics, "cacheReadInputTokenCount"),
      cacheCreationTokens: first(metrics, "cacheWriteInputTokenCount"),
    });
    if (reported) found = mergeUsage(found, reported);
  }
  if (!found) {
    // InvokeModel bodies for Llama and Titan text models.
    const results = items(b["results"]);
    found = tokens(
      first(b, "prompt_token_count", "inputTextTokenCount"),
      first(b, "generation_token_count") ?? first(asObject(results?.[0]), "tokenCount"),
    );
  }
  const images = arrayLength(b["images"]);
  return images != null && images > 0 ? withUnits(found, { images }) : found;
}

/**
 * InvokeModel reports the billed token counts for every model family in
 * response headers; they win over whatever the body carried.
 */
function applyHeaders(usage: NormalizedUsage | null, headers: Record<string, string> | null): NormalizedUsage | null {
  const counted = {
    inputTokens: headerCount(headers, "x-amzn-bedrock-input-token-count"),
    outputTokens: headerCount(headers, "x-amzn-bedrock-output-token-count"),
    cacheReadTokens: headerCount(headers, "x-amzn-bedrock-cache-read-input-token-count"),
    cacheCreationTokens: headerCount(headers, "x-amzn-bedrock-cache-write-input-token-count"),
  };
  if (counted.inputTokens == null && counted.outputTokens == null) return usage;
  const result: NormalizedUsage = usage ? { ...usage } : {
    inputTokens: null, outputTokens: null, totalTokens: null,
    reasoningTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
  };
  for (const [key, value] of Object.entries(counted)) {
    if (value != null) (result as unknown as Record<string, number>)[key] = value;
  }
  if (result.inputTokens != null && result.outputTokens != null) {
    result.totalTokens = result.inputTokens + result.outputTokens;
  }
  return result;
}

/** AWS Bedrock: bedrock-runtime.{region}.amazonaws.com. */
export const bedrockExtractor: ServerExtractor = {
  provider: "bedrock",
  match(url) {
    return url.hostname.includes("bedrock-runtime") && url.hostname.endsWith(".amazonaws.com");
  },
  extractUsage(body, call) {
    return applyHeaders(bodyUsage(body), call.responseHeaders);
  },
  extractModel(requestBody, _responseBody, call) {
    // AWS SDK command input carries modelId; over HTTP it is only in the path.
    const modelId = str(asObject(requestBody)?.["modelId"]);
    if (modelId) return bedrockModelId(modelId);
    const match = call.url.pathname.match(MODEL_PATH) ?? call.url.pathname.match(ANY_MODEL_PATH);
    return match ? bedrockModelId(match[1]!) : null;
  },
  streamCandidates(record) {
    // Event-stream chunks are `{"<event-type>": payload}`; an InvokeModel
    // chunk's decoded `bytes` holds the model's own JSON.
    const keys = Object.keys(record);
    if (keys.length !== 1) return [];
    const payload = asObject(record[keys[0]!]);
    if (!payload) return [];
    const decoded = asObject(payload["bytes"]);
    return decoded ? [payload, decoded, asObject(decoded["message"])] : [payload];
  },
};
