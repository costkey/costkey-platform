import type { StreamTiming } from "@costkey/shared";
import type { ExtractCall, ServerExtractor } from "./types.js";
import {
  asObject, asRecord, count, items, nonEmpty, num, requestFields, responseBody, str, type Rec,
} from "./skeleton.js";
import { emptyUsage, mergeUsage, type NormalizedUsage, withTotal } from "./usage.js";
import { findExtractor } from "./providers/registry.js";
import { anthropicUsage } from "./providers/anthropic.js";
import { compatibleUsage } from "./providers/compatible.js";
import { header, responseOrRequestModel } from "./providers/common.js";
import { classifyError } from "./errors.js";

/** The normalized call fields the server derives from a `telemetry` envelope. */
export interface DerivedCall {
  provider: string;
  model: string | null;
  /** The requested model when it differs from the billed one, else null. */
  requestModel: string | null;
  /** The request URL as sent (query secrets already stripped by the SDK). */
  url: string | null;
  method: string;
  statusCode: number | null;
  usage: NormalizedUsage | null;
  /** A provider-reported amount, stored as reported; server pricing wins. */
  costUsd: number | null;
  durationMs: number | null;
  streaming: boolean;
  streamTiming: StreamTiming | null;
  providerRequestId: string | null;
  startedAt: string | null;
  /** Set for a call that failed or was cancelled. */
  outcome: { lifecycle: "failed" | "cancelled"; errorType: string | null } | null;
}

export interface ExtractOptions {
  /** Project-configured custom providers; they apply after every built-in. */
  customExtractors?: readonly ServerExtractor[];
}

/** Hosts no extractor knows still get OpenAI-shaped usage and a body model. */
const unknownExtractor: ServerExtractor = {
  provider: "unknown",
  match: () => true,
  extractUsage: (body) => compatibleUsage(body),
  extractModel: (requestBody, responseBody) => responseOrRequestModel(requestBody, responseBody),
};

const REQUEST_ID_KEYS = ["id", "request_id", "requestId", "response_id", "responseId"];
const REQUEST_ID_HEADERS = ["x-amzn-requestid", "request-id", "x-request-id"];

/** Whether `value` is a usable v1 envelope. */
export function isCallTelemetry(value: unknown): value is Rec {
  const record = asRecord(value);
  return !!record && (record["v"] === 1 || record["v"] === "1");
}

function lowerHeaders(value: unknown): Record<string, string> | null {
  const record = asRecord(value);
  if (!record) return null;
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string") headers[key.toLowerCase()] = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) headers[key.toLowerCase()] = String(raw);
    else if (Array.isArray(raw) && typeof raw[0] === "string") headers[key.toLowerCase()] = raw.join(", ");
  }
  return headers;
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Whether a call with no response got as far as the provider: a read timeout or a cut-off read. */
function reachedProvider(error: Record<string, unknown> | null): boolean {
  const name = typeof error?.["name"] === "string" ? error["name"] : "";
  if (/connect|dns|resolve|refused|ssl|tls|certificate/i.test(name)) return false;
  return /readtimeout|read_timeout|timeouterror|timeout|remoteprotocol|incompleteread|chunkedencoding|abort|cancel/i.test(name);
}

function safeUsage(extractor: ServerExtractor, body: unknown, call: ExtractCall): NormalizedUsage | null {
  try {
    return extractor.extractUsage(body, call) ?? null;
  } catch {
    return null;
  }
}

function safeModel(extractor: ServerExtractor, requestBody: unknown, body: unknown, call: ExtractCall): string | null {
  try {
    return extractor.extractModel(requestBody, body, call) ?? null;
  } catch {
    return null;
  }
}

/** A provider request id from a body (or stream record). */
function bodyRequestId(body: unknown): string | null {
  const record = asObject(body);
  if (!record) return null;
  for (const key of REQUEST_ID_KEYS) {
    const value = str(record[key]);
    if (value && value.trim()) return value;
  }
  return null;
}

function headerRequestId(headers: Record<string, string> | null): string | null {
  for (const name of REQUEST_ID_HEADERS) {
    const value = header(headers, name);
    if (value) return value.slice(0, 200);
  }
  return null;
}

/**
 * Streaming is declared in the body for OpenAI-style APIs and in the URL for
 * Gemini (:streamGenerateContent, alt=sse) and Bedrock (*-stream).
 */
export function isStreamingRequest(url: URL | null, requestBody: unknown): boolean {
  if (asObject(requestBody)?.["stream"] === true) return true;
  if (!url) return false;
  const path = url.pathname;
  if (/:(streamGenerateContent|streamRawPredict)$/.test(path) || url.searchParams.get("alt") === "sse") return true;
  return /\/(invoke-with-response-stream|converse-stream)$/.test(path);
}

/** Places a stream record carries usage: itself, `response`, `message`, plus provider extras. */
function candidatesOf(extractor: ServerExtractor, record: Rec): unknown[] {
  const extra = extractor.streamCandidates ? extractor.streamCandidates(record) : [];
  return [record, record["response"], record["message"], ...extra].filter((candidate) => asObject(candidate) !== null);
}

/** Usage, model source and request id over a stream's records. */
export function streamSummary(
  extractor: ServerExtractor,
  records: readonly unknown[],
  call: ExtractCall,
): { usage: NormalizedUsage | null; modelSource: Rec | null; requestId: string | null } {
  let usage: NormalizedUsage | null = null;
  let modelSource: Rec | null = null;
  let requestId: string | null = null;
  const objects: Rec[] = [];
  for (const raw of records) {
    const record = asObject(raw);
    if (!record) continue;
    objects.push(record);
    for (const candidate of candidatesOf(extractor, record)) {
      const found = safeUsage(extractor, candidate, call);
      if (found) usage = mergeUsage(usage, found);
      const object = candidate as Rec;
      if (!modelSource && (typeof object["model"] === "string" || typeof object["modelVersion"] === "string")) {
        modelSource = object;
      }
      requestId ??= bodyRequestId(object);
    }
  }
  // Units read from the request or headers (characters, search results)
  // don't depend on any one record.
  const base = safeUsage(extractor, null, call);
  if (base) usage = mergeUsage(usage, base);
  if (extractor.extractStreamUnits) {
    let units: Record<string, number> | null = null;
    try {
      units = extractor.extractStreamUnits(objects);
    } catch {
      units = null;
    }
    if (units) {
      usage = { ...(usage ?? emptyUsage()), nativeUnits: { ...(usage?.nativeUnits ?? {}), ...units } };
    }
  }
  return { usage: withTotal(usage), modelSource, requestId };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Claude Agent SDK messages: no HTTP request, the raw message (with its usage block) as the response. */
function agentSdkCall(telemetry: Rec): DerivedCall {
  const body = responseBody(asRecord(telemetry["response"])?.["body"]);
  const record = asObject(body);
  const message = asObject(record?.["message"]);
  const usage = anthropicUsage(record) ?? anthropicUsage(message);
  const modelUsage = asObject(record?.["modelUsage"]);
  const model = str(record?.["model"]) ?? str(message?.["model"])
    ?? (modelUsage ? Object.keys(modelUsage)[0] ?? null : null);
  const cost = count(record?.["total_cost_usd"]) ?? count(record?.["costUsd"]);
  const duration = num(telemetry["durationMs"]);
  return {
    provider: "anthropic",
    model,
    requestModel: null,
    url: null,
    method: "POST",
    statusCode: null,
    usage: usage && cost != null ? { ...usage, costUsd: cost } : usage,
    costUsd: cost,
    durationMs: duration != null ? round2(duration) : null,
    streaming: false,
    streamTiming: null,
    providerRequestId: bodyRequestId(message) ?? bodyRequestId(record),
    startedAt: str(telemetry["startedAt"]),
    outcome: null,
  };
}

/**
 * Derive every normalized call field from a raw telemetry envelope: the
 * provider from the URL host, model and request model, usage (tokens, cache,
 * reasoning, native units, characters from `$s` lengths), stream merging and
 * timing, request ids, the reported cost and the error outcome.
 */
export function extractCall(telemetry: unknown, options: ExtractOptions = {}): DerivedCall | null {
  if (!isCallTelemetry(telemetry)) return null;
  if (telemetry["source"] === "claude-agent-sdk") return agentSdkCall(telemetry);

  const request = asRecord(telemetry["request"]);
  const response = asRecord(telemetry["response"]);
  const stream = asRecord(telemetry["stream"]);
  const error = asRecord(telemetry["error"]);
  const url = parseUrl(request?.["url"]);
  const requestBody = requestFields(request?.["body"]);
  const extractor = (url && (findExtractor(url) ?? options.customExtractors?.find((candidate) => {
    try {
      return candidate.match(url);
    } catch {
      return false;
    }
  }))) || unknownExtractor;

  const hasBody = request?.["body"] != null;
  const method = (nonEmpty(request?.["method"]) ?? (hasBody ? "POST" : "GET")).toUpperCase();
  const statusCode = response ? num(response["status"]) : null;
  const responseHeaders = response ? lowerHeaders(response["headers"]) : null;
  const callUrl = url ?? new URL("https://unknown.invalid/");
  const requestCall: ExtractCall = { url: callUrl, method, requestBody, statusCode: null, responseHeaders: null };
  const call: ExtractCall = { ...requestCall, statusCode, responseHeaders };

  const durationRaw = num(telemetry["durationMs"]);
  const durationMs = durationRaw != null && durationRaw >= 0 ? round2(durationRaw) : null;
  const streaming = stream != null || isStreamingRequest(url, requestBody);

  let usage: NormalizedUsage | null = null;
  let model: string | null;
  let providerRequestId: string | null = null;
  let streamTiming: StreamTiming | null = null;

  if (!response) {
    // The request never got a response (network error, abort before headers).
    model = safeModel(extractor, requestBody, null, requestCall);
    // A read timeout means the provider had the request and was working on it;
    // providers that bill on the request still charge. A refused or failed
    // connection never reached them.
    if (reachedProvider(error) && extractor.extractUnansweredUsage) {
      try {
        usage = withTotal(extractor.extractUnansweredUsage(requestCall));
      } catch {
        usage = null;
      }
    }
  } else if (stream) {
    const records = items(stream["chunks"]) ?? [];
    const summary = streamSummary(extractor, records, call);
    usage = summary.usage;
    model = safeModel(extractor, requestBody, summary.modelSource, call);
    providerRequestId = summary.requestId;
    const firstChunkMs = num(stream["firstChunkMs"]);
    const ttft = firstChunkMs != null && firstChunkMs >= 0 ? firstChunkMs : null;
    const span = durationMs != null && ttft != null ? (durationMs - ttft) / 1000 : null;
    streamTiming = {
      ttft: ttft != null ? round2(ttft) : null,
      tps: usage?.outputTokens && span != null && span > 0 ? round2(usage.outputTokens / span) : null,
      streamDuration: durationMs,
      chunkCount: count(stream["chunkCount"]) ?? records.length,
    };
  } else {
    const body = responseBody(response["body"]);
    usage = withTotal(safeUsage(extractor, body, call));
    model = safeModel(extractor, requestBody, body, call);
    providerRequestId = bodyRequestId(body);
  }
  providerRequestId ??= headerRequestId(responseHeaders);

  const requestModel = safeModel(extractor, requestBody, null, requestCall);

  let outcome: DerivedCall["outcome"] = null;
  if (error) {
    const classified = classifyError(error["name"], error["code"]);
    outcome = { lifecycle: classified.outcome, errorType: classified.errorType };
  } else if (statusCode != null && statusCode >= 400) {
    outcome = { lifecycle: "failed", errorType: `http_${statusCode}` };
  }

  return {
    provider: extractor.provider,
    model,
    requestModel: requestModel !== model ? requestModel : null,
    url: url ? url.toString() : null,
    method,
    statusCode,
    usage,
    costUsd: usage?.costUsd ?? null,
    durationMs,
    streaming,
    streamTiming,
    providerRequestId,
    startedAt: str(telemetry["startedAt"]),
    outcome,
  };
}
