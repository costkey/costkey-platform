/**
 * Reference implementation of the RAW_TELEMETRY.md v1 skeleton rules, used to
 * turn raw provider responses into the `telemetry` an SDK would send. It must
 * stay identical to the SDKs' implementations:
 *
 * - Objects keep every key; objects and arrays at depth 12 become {"$trunc": true}
 *   (scalars at that depth are kept).
 * - Strings are kept only for KEEP_STRING_KEYS and at most 200 characters,
 *   else {"$s": N} with N in Unicode code points. Strings inside arrays have
 *   no key and always become {"$s": N}.
 * - Numbers, booleans and null verbatim; NaN and Infinity become null.
 * - Arrays: up to 32 items all kept; over 32, the first 8 then {"$more": rest}.
 * - Multipart bodies: {"$multipart": [...]}; binary bodies: {"$bytes": n}.
 * - A serialized skeleton over 64 KB has its deepest subtrees truncated first.
 */

export const KEEP_STRING_KEYS = new Set([
  "model", "model_id", "modelId", "modelVersion", "id", "object", "type", "status", "finish_reason", "stop_reason",
  "finishReason", "service_tier", "system_fingerprint", "responseId", "request_id", "requestId", "search_depth",
  "topic", "output_format", "response_format", "encoding", "language", "language_code", "voice_id", "size", "quality",
  "style", "mode", "operation", "event", "provider", "modality", "tier", "currency", "unit", "job_id", "jobId",
  "trafficType", "created", "created_at", "speech_model", "response_id",
]);

export const MAX_DEPTH = 12;
export const MAX_STRING = 200;
export const MAX_ARRAY = 32;
export const ARRAY_HEAD = 8;
export const MAX_SKELETON_BYTES = 64 * 1024;

export type Skeleton = null | boolean | number | string | Skeleton[] | { [key: string]: Skeleton };

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function stringValue(value: string, key: string | null): Skeleton {
  if (key !== null && KEEP_STRING_KEYS.has(key) && codePoints(value) <= MAX_STRING) return value;
  return { $s: codePoints(value) };
}

function walk(value: unknown, key: string | null, depth: number): Skeleton {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return stringValue(value, key);
  if (typeof value !== "object") return null;
  if (depth >= MAX_DEPTH) return { $trunc: true };
  if (Array.isArray(value)) {
    if (value.length <= MAX_ARRAY) return value.map((item) => walk(item, null, depth + 1));
    return [
      ...value.slice(0, ARRAY_HEAD).map((item) => walk(item, null, depth + 1)),
      { $more: value.length - ARRAY_HEAD },
    ];
  }
  const result: Record<string, Skeleton> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    result[childKey] = walk(child, childKey, depth + 1);
  }
  return result;
}

function byteSize(value: Skeleton): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function containerDepth(value: Skeleton, depth = 0): number {
  if (value === null || typeof value !== "object" || isMarkerObject(value)) return -1;
  const children = Array.isArray(value) ? value : Object.values(value);
  let deepest = depth;
  for (const child of children) deepest = Math.max(deepest, containerDepth(child, depth + 1));
  return deepest;
}

function isMarkerObject(value: Skeleton): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0]!.startsWith("$");
}

/** Replace every non-marker container at `target` depth with {"$trunc": true}. */
function truncateAt(value: Skeleton, target: number, depth = 0): Skeleton {
  if (value === null || typeof value !== "object" || isMarkerObject(value)) return value;
  if (depth === target) return { $trunc: true };
  if (Array.isArray(value)) return value.map((item) => truncateAt(item, target, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, truncateAt(child, target, depth + 1)]));
}

/** The skeleton of a JSON body (request, response or one stream record). */
export function skeleton(value: unknown): Skeleton {
  let result = walk(value, null, 0);
  while (byteSize(result) > MAX_SKELETON_BYTES) {
    const deepest = containerDepth(result);
    if (deepest <= 0) return { $trunc: true };
    result = truncateAt(result, deepest);
  }
  return result;
}

export interface MultipartPart {
  name: string;
  /** A file part. */
  filename?: string;
  contentType?: string;
  bytes?: number;
  /** A text part. */
  value?: string;
}

/** The skeleton of a multipart form: file parts by size, text parts by the string rule. */
export function multipartSkeleton(parts: MultipartPart[]): Skeleton {
  return {
    $multipart: parts.map((part) => {
      if (part.value !== undefined) return { name: part.name, value: stringValue(part.value, part.name) };
      const file: Record<string, Skeleton> = { name: part.name };
      if (part.filename !== undefined) file["filename"] = { $s: codePoints(part.filename) };
      if (part.contentType !== undefined) file["contentType"] = part.contentType;
      if (part.bytes !== undefined) file["bytes"] = part.bytes;
      return file;
    }),
  };
}

/** The skeleton of a binary body. */
export function bytesSkeleton(size: number): Skeleton {
  return { $bytes: size };
}

/** Stream chunk cap: every record up to 200, else the first 20 and the last 50. */
export function capChunks<T>(records: T[]): T[] {
  if (records.length <= 200) return records;
  return [...records.slice(0, 20), ...records.slice(-50)];
}

const REQUEST_HEADERS = new Set(["content-type", "anthropic-version", "anthropic-beta", "openai-beta", "x-goog-api-client", "x-stainless-lang"]);
const RESPONSE_HEADER_DENY = new Set(["set-cookie", "cookie", "authorization", "proxy-authorization", "x-api-key", "api-key"]);

export function requestHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .filter(([key]) => REQUEST_HEADERS.has(key)));
}

export function responseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .filter(([key]) => !RESPONSE_HEADER_DENY.has(key) && !(key.includes("token") && !key.includes("count"))));
}

const SECRET_QUERY = /^(key|api_key|apikey|api-key|token|access_token|auth.*|sig|signature|x-amz-.*|code)$/i;

/** Drop credential query parameters, keep the rest (Deepgram's model=, Gemini's alt=sse). */
export function sanitizeUrl(raw: string): string {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_QUERY.test(name)) url.searchParams.delete(name);
  }
  return url.toString();
}

export interface RawCall {
  url: string;
  method?: string;
  requestHeaders?: Record<string, string>;
  /** JSON request body, a multipart form, or a binary size. */
  requestBody?: unknown;
  multipart?: MultipartPart[];
  requestBytes?: number;
  status?: number | null;
  responseHeaders?: Record<string, string>;
  /** JSON response body (non-streamed). */
  responseBody?: unknown;
  /** A binary response body's size (audio). */
  responseBytes?: number;
  /** Parsed stream records. */
  stream?: { format: "sse" | "ndjson" | "json-array" | "aws-eventstream"; records: unknown[]; firstChunkMs?: number; lastChunkMs?: number };
  error?: { name: string; code?: string } | null;
  startedAt?: string;
  durationMs?: number;
}

/** The `telemetry` envelope an SDK sends for one observed call. */
export function telemetryFor(call: RawCall): Record<string, unknown> {
  const body = call.multipart
    ? multipartSkeleton(call.multipart)
    : call.requestBytes !== undefined && call.requestBody === undefined
      ? bytesSkeleton(call.requestBytes)
      : call.requestBody === undefined ? null : skeleton(call.requestBody);
  const requestText = call.requestBody !== undefined && !call.multipart ? JSON.stringify(call.requestBody) : null;
  const hasResponse = call.status !== null && !call.error;
  return {
    v: 1,
    request: {
      method: call.method ?? (body === null ? "GET" : "POST"),
      url: sanitizeUrl(call.url),
      headers: requestHeaders(call.requestHeaders ?? { "content-type": "application/json" }),
      body,
      bytes: requestText !== null ? Buffer.byteLength(requestText, "utf8") : call.requestBytes ?? null,
    },
    response: hasResponse || call.status != null
      ? {
          status: call.status ?? 200,
          headers: responseHeaders(call.responseHeaders ?? {}),
          body: call.stream ? null : call.responseBytes !== undefined ? bytesSkeleton(call.responseBytes) : call.responseBody === undefined ? null : skeleton(call.responseBody),
          bytes: call.responseBody !== undefined ? Buffer.byteLength(JSON.stringify(call.responseBody), "utf8") : call.responseBytes ?? null,
        }
      : null,
    stream: call.stream
      ? {
          format: call.stream.format,
          chunks: capChunks(call.stream.records.map((record) => skeleton(record))),
          chunkCount: call.stream.records.length,
          firstChunkMs: call.stream.firstChunkMs ?? 100,
          lastChunkMs: call.stream.lastChunkMs ?? (call.durationMs ?? 1_000) - 1,
        }
      : null,
    error: call.error ?? null,
    startedAt: call.startedAt ?? "2026-10-11T09:00:00.000Z",
    durationMs: call.durationMs ?? 1_000,
  };
}
