import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage, ExtractorCall } from "./types.js";
import { anthropicUsage } from "./anthropic.js";
import { openaiUsage, responseOrRequestModel } from "./openai.js";
import { asRecord } from "./units.js";

const GOOGLE_HOSTS = new Set([
  "generativelanguage.googleapis.com",
]);

/** Matches Vertex AI endpoints: the global aiplatform.googleapis.com and regional xxx-aiplatform.googleapis.com */
function isVertexAI(hostname: string): boolean {
  return hostname === "aiplatform.googleapis.com" || hostname.endsWith("-aiplatform.googleapis.com");
}

/** Vertex Model Garden: /publishers/{publisher}/models/{model}[:method] */
const PUBLISHER_MODEL_PATH = /\/publishers\/([^/]+)\/models\/([^/:]+)/;

/**
 * The publisher and model of a partner (non-Google) model call on Vertex AI:
 * Claude via :rawPredict/:streamRawPredict, Mistral, Llama, DeepSeek, Qwen
 * and AI21 via :rawPredict or /chat/completions. The model keeps its
 * `@version` suffix.
 */
export function vertexPartnerModel(url: URL): { publisher: string; model: string } | null {
  const match = PUBLISHER_MODEL_PATH.exec(url.pathname);
  if (!match || match[1] === "google") return null;
  return { publisher: safeDecode(match[1]!), model: safeDecode(match[2]!) };
}

/**
 * Partner model bodies use their publisher's own usage shape instead of
 * `usageMetadata`: Anthropic's (input/output plus cache read and write) for
 * Claude, OpenAI's (`prompt_tokens`/`completion_tokens`) for the rest,
 * including the OpenAI-compatible /endpoints/openapi/chat/completions route.
 */
function partnerUsage(body: Record<string, unknown>, call: ExtractorCall | undefined): NormalizedUsage | null {
  const usage = asRecord(body["usage"]);
  if (!usage) return null;
  const publisher = call ? vertexPartnerModel(call.url)?.publisher : undefined;
  const openaiShape = publisher
    ? publisher !== "anthropic"
    : "prompt_tokens" in usage || "completion_tokens" in usage;
  return openaiShape ? openaiUsage(body) : anthropicUsage(body);
}

/**
 * Billable grounding units from `candidates[].groundingMetadata` across one
 * or more response bodies (a stream's chunks). Gemini 3+ bills each distinct
 * executed search query; Gemini 2.x bills each grounded prompt; Maps
 * grounding is billed per grounded prompt.
 */
export function geminiGroundingUnits(bodies: readonly unknown[]): Record<string, number> | null {
  const queries = new Set<string>();
  let web = false;
  let maps = false;
  for (const body of bodies) {
    const candidates = asRecord(body)?.["candidates"];
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates) {
      const entry = asRecord(candidate);
      const metadata = asRecord(entry?.["groundingMetadata"] ?? entry?.["grounding_metadata"]);
      if (!metadata) continue;
      const searchQueries = metadata["webSearchQueries"] ?? metadata["web_search_queries"];
      if (Array.isArray(searchQueries) && searchQueries.length > 0) {
        web = true;
        for (const query of searchQueries) {
          if (typeof query === "string" && query) queries.add(query);
        }
      }
      const chunks = metadata["groundingChunks"] ?? metadata["grounding_chunks"];
      if (Array.isArray(chunks)) {
        for (const chunk of chunks) {
          const source = asRecord(chunk);
          if (source?.["web"]) web = true;
          if (source?.["maps"]) maps = true;
        }
      }
      if (metadata["googleMapsWidgetContextToken"] ?? metadata["google_maps_widget_context_token"]) maps = true;
    }
  }
  const units: Record<string, number> = {};
  if (queries.size > 0) units["searchQueries"] = queries.size;
  if (web) units["groundingRequests"] = 1;
  if (maps) units["mapsGroundingRequests"] = 1;
  return Object.keys(units).length > 0 ? units : null;
}

export const googleExtractor: ProviderExtractor = {
  provider: Provider.Google,

  match(url: URL): boolean {
    return GOOGLE_HOSTS.has(url.hostname) || isVertexAI(url.hostname);
  },

  extractUsage(body: unknown, call?: ExtractorCall): NormalizedUsage | null {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;
    if (!("usageMetadata" in b) && "usage" in b) return partnerUsage(b, call);
    const nativeUnits = geminiGroundingUnits([body]);

    const metadata = b["usageMetadata"] as Record<string, unknown> | undefined;
    if (!metadata) {
      // A streamed chunk can carry grounding without token counts.
      return nativeUnits
        ? {
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            reasoningTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            nativeUnits,
          }
        : null;
    }

    // Grounding and tool calls add prompt tokens billed as input.
    const promptTokens = asNumber(metadata["promptTokenCount"]);
    const toolUseTokens = asNumber(metadata["toolUsePromptTokenCount"]);
    const inputTokens = toolUseTokens ? (promptTokens ?? 0) + toolUseTokens : promptTokens;
    const outputTokens = asNumber(metadata["candidatesTokenCount"]);
    const totalTokens =
      asNumber(metadata["totalTokenCount"]) ??
      (inputTokens != null && outputTokens != null
        ? inputTokens + outputTokens
        : null);

    const thoughtsTokens = asNumber(metadata["thoughtsTokenCount"]);

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      reasoningTokens: thoughtsTokens,
      cacheReadTokens: asNumber(metadata["cachedContentTokenCount"]),
      cacheCreationTokens: null,
      ...(nativeUnits ? { nativeUnits } : {}),
    };
  },

  extractModel(requestBody: unknown, responseBody: unknown, call?: ExtractorCall): string | null {
    // Partner models are named by the URL; Model Garden's OpenAI-compatible
    // endpoint by the body.
    if (call) {
      const partner = vertexPartnerModel(call.url);
      if (partner) return partner.model;
      if (/\/endpoints\/openapi\/chat\/completions\/?$/.test(call.url.pathname)) {
        return responseOrRequestModel(requestBody, responseBody);
      }
    }

    // Google returns modelVersion in response
    const resp = responseBody as Record<string, unknown> | null;
    if (resp && typeof resp["modelVersion"] === "string")
      return resp["modelVersion"];

    // Try to extract from the URL path (models/gemini-pro:generateContent)
    // This is handled at the fetch-patch level instead
    return null;
  },

  // Distinct queries are a union over all chunks, not the largest chunk.
  extractStreamUnits(records: unknown[]): Record<string, number> | null {
    return geminiGroundingUnits(records);
  },

  // Google includes usageMetadata in streaming by default — no injection needed
};

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function asNumber(val: unknown): number | null {
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  return null;
}
