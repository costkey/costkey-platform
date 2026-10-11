import type { ExtractCall, ServerExtractor } from "../types.js";
import { arrayLength, asObject, isMore, items, num, str, truthy } from "../skeleton.js";
import { emptyUsage, type NormalizedUsage } from "../usage.js";
import { anthropicUsage } from "./anthropic.js";
import { openaiUsage } from "./openai.js";
import { responseOrRequestModel, safeDecode } from "./common.js";

function isVertexAI(hostname: string): boolean {
  return hostname === "aiplatform.googleapis.com" || hostname.endsWith("-aiplatform.googleapis.com");
}

/** Vertex Model Garden: /publishers/{publisher}/models/{model}[:method] */
const PUBLISHER_MODEL_PATH = /\/publishers\/([^/]+)\/models\/([^/:]+)/;

/**
 * The publisher and model of a partner (non-Google) model call on Vertex AI.
 * The model keeps its `@version` suffix.
 */
export function vertexPartnerModel(url: URL): { publisher: string; model: string } | null {
  const match = PUBLISHER_MODEL_PATH.exec(url.pathname);
  if (!match || match[1] === "google") return null;
  return { publisher: safeDecode(match[1]!), model: safeDecode(match[2]!) };
}

/**
 * Partner model bodies use their publisher's own usage shape: Anthropic's for
 * Claude, OpenAI's for the rest (and the OpenAI-compatible endpoint).
 */
function partnerUsage(body: Record<string, unknown>, call: ExtractCall): NormalizedUsage | null {
  const usage = asObject(body["usage"]);
  if (!usage) return null;
  const publisher = vertexPartnerModel(call.url)?.publisher;
  const openaiShape = publisher
    ? publisher !== "anthropic"
    : "prompt_tokens" in usage || "completion_tokens" in usage;
  return openaiShape ? openaiUsage(body) : anthropicUsage(body);
}

/** Non-empty search queries in one grounding metadata block. */
function queryCount(queries: unknown): number {
  let total = 0;
  for (const query of items(queries) ?? []) {
    if (truthy(query)) total += 1;
  }
  for (const item of Array.isArray(queries) ? queries : []) {
    if (isMore(item)) total += item.$more;
  }
  return total;
}

/**
 * Billable grounding units from `candidates[].groundingMetadata` of one body.
 * Gemini 3+ bills each executed search query; Gemini 2.x bills each grounded
 * prompt; Maps grounding is billed per grounded prompt.
 */
function groundingOf(body: unknown): { queries: number; web: boolean; maps: boolean } {
  let queries = 0;
  let web = false;
  let maps = false;
  for (const candidate of items(asObject(body)?.["candidates"]) ?? []) {
    const entry = asObject(candidate);
    const metadata = asObject(entry?.["groundingMetadata"] ?? entry?.["grounding_metadata"]);
    if (!metadata) continue;
    const searchQueries = metadata["webSearchQueries"] ?? metadata["web_search_queries"];
    if ((arrayLength(searchQueries) ?? 0) > 0) {
      web = true;
      queries += queryCount(searchQueries);
    }
    for (const chunk of items(metadata["groundingChunks"] ?? metadata["grounding_chunks"]) ?? []) {
      const source = asObject(chunk);
      if (truthy(source?.["web"])) web = true;
      if (truthy(source?.["maps"])) maps = true;
    }
    if (truthy(metadata["googleMapsWidgetContextToken"] ?? metadata["google_maps_widget_context_token"])) maps = true;
  }
  return { queries, web, maps };
}

/**
 * Grounding units over one or more bodies (a stream's records). Query text
 * never leaves the SDK, so a stream's queries are the largest per-record
 * count rather than a union of distinct strings.
 */
export function geminiGroundingUnits(bodies: readonly unknown[]): Record<string, number> | null {
  let queries = 0;
  let web = false;
  let maps = false;
  for (const body of bodies) {
    const found = groundingOf(body);
    queries = Math.max(queries, found.queries);
    web ||= found.web;
    maps ||= found.maps;
  }
  const units: Record<string, number> = {};
  if (queries > 0) units["searchQueries"] = queries;
  if (web) units["groundingRequests"] = 1;
  if (maps) units["mapsGroundingRequests"] = 1;
  return Object.keys(units).length > 0 ? units : null;
}

export const googleExtractor: ServerExtractor = {
  provider: "google",
  match(url) {
    return url.hostname === "generativelanguage.googleapis.com" || isVertexAI(url.hostname);
  },
  extractUsage(body, call) {
    const b = asObject(body);
    if (!b) return null;
    if (!("usageMetadata" in b) && "usage" in b) return partnerUsage(b, call);
    const nativeUnits = geminiGroundingUnits([b]);
    const metadata = asObject(b["usageMetadata"]);
    if (!metadata) {
      // A streamed chunk can carry grounding without token counts.
      return nativeUnits ? { ...emptyUsage(), nativeUnits } : null;
    }
    // Grounding and tool calls add prompt tokens billed as input.
    const promptTokens = num(metadata["promptTokenCount"]);
    const toolUseTokens = num(metadata["toolUsePromptTokenCount"]);
    const inputTokens = toolUseTokens ? (promptTokens ?? 0) + toolUseTokens : promptTokens;
    const outputTokens = num(metadata["candidatesTokenCount"]);
    return {
      inputTokens,
      outputTokens,
      totalTokens: num(metadata["totalTokenCount"])
        ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null),
      reasoningTokens: num(metadata["thoughtsTokenCount"]),
      cacheReadTokens: num(metadata["cachedContentTokenCount"]),
      cacheCreationTokens: null,
      ...(nativeUnits ? { nativeUnits } : {}),
    };
  },
  extractModel(requestBody, responseBody, call) {
    // Partner models are named by the URL; Model Garden's OpenAI-compatible
    // endpoint by the body.
    const partner = vertexPartnerModel(call.url);
    if (partner) return partner.model;
    if (/\/endpoints\/openapi\/chat\/completions\/?$/.test(call.url.pathname)) {
      return responseOrRequestModel(requestBody, responseBody);
    }
    // The URL's /models/{id}: is applied by the generic path fallback.
    return str(asObject(responseBody)?.["modelVersion"]);
  },
  extractStreamUnits: geminiGroundingUnits,
};
