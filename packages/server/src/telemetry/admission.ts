/**
 * Usage bounds for /admit, estimated on the server from the request
 * skeleton (SDK 0.7 sends the request; it no longer estimates). The rules
 * are SDK 0.6's: input is bounded by the request body's size in bytes (a
 * token is never smaller than one byte of request text), output by the
 * request's own max-token setting.
 */
import {
  asObject, asRecord, isBytes, isMarker, isMultipart, isSkeletonString, num, requestFields, type Rec,
} from "./skeleton.js";
import { findExtractor } from "./providers/registry.js";

export interface EstimatedBounds {
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

const OUTPUT_LIMIT_PATHS: ReadonlyArray<readonly string[]> = [
  ["max_tokens"],
  ["max_completion_tokens"],
  ["max_output_tokens"],
  ["generationConfig", "maxOutputTokens"],
  ["inferenceConfig", "maxTokens"],
];

/**
 * An upper bound on the UTF-8 size of the JSON a skeleton stands for, used
 * only when the SDK didn't report `bytes`: a `$s` string of N code points
 * is at most 4N bytes plus quotes.
 */
function skeletonByteBound(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === "string") return Buffer.byteLength(JSON.stringify(value), "utf8");
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (isSkeletonString(value)) return value.$s * 4 + 2;
  if (Array.isArray(value)) {
    return 2 + value.reduce<number>((sum, item) => sum + skeletonByteBound(item) + 1, 0);
  }
  const record = asRecord(value);
  if (!record) return 4;
  return 2 + Object.entries(record).reduce<number>(
    (sum, [key, item]) => sum + Buffer.byteLength(JSON.stringify(key), "utf8") + 1 + skeletonByteBound(item) + 1,
    0,
  );
}

function hasMarkerLoss(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasMarkerLoss(item) || (isMarker(item) && !isSkeletonString(item)));
  const record = asRecord(value);
  if (!record) return false;
  if (isMarker(record)) return !isSkeletonString(record);
  return Object.values(record).some(hasMarkerLoss);
}

/** Bounds from a telemetry request: `{ body, bytes }`. */
export function estimateUsageBounds(request: unknown): EstimatedBounds | undefined {
  const record = asRecord(request);
  if (!record) return undefined;
  const body = record["body"];
  // Form fields exclude the uploaded file and binary bodies hold no text:
  // they bound nothing (as in SDK 0.6).
  if (isMultipart(body) || isBytes(body)) return undefined;
  const bounds: EstimatedBounds = {};
  const bytes = num(record["bytes"]);
  if (bytes != null && bytes >= 0) {
    bounds.maxInputTokens = bytes;
  } else if (body != null && !hasMarkerLoss(body)) {
    bounds.maxInputTokens = skeletonByteBound(body);
  }
  const fields = asObject(body);
  if (fields) {
    for (const path of OUTPUT_LIMIT_PATHS) {
      let current: unknown = fields;
      for (const key of path) current = asObject(current)?.[key];
      const value = num(current);
      if (value != null && value >= 0) {
        bounds.maxOutputTokens = value;
        break;
      }
    }
  }
  return Object.keys(bounds).length > 0 ? bounds : undefined;
}

/** Whether an /admit body's `request` is a telemetry request rather than legacy bounds. */
export function isTelemetryRequest(value: unknown): value is Rec {
  const record = asRecord(value);
  return !!record && ("body" in record || "url" in record || "bytes" in record || "method" in record);
}

/** Provider and model for an /admit call that sent only the request. */
export function admissionIdentity(request: Rec): { provider: string | null; model: string | null } {
  let url: URL | null = null;
  try {
    url = typeof request["url"] === "string" ? new URL(request["url"]) : null;
  } catch {
    url = null;
  }
  const extractor = url ? findExtractor(url) : null;
  if (!extractor || !url) return { provider: null, model: null };
  const requestBody = requestFields(request["body"]);
  let model: string | null = null;
  try {
    model = extractor.extractModel(requestBody, null, {
      url,
      method: typeof request["method"] === "string" ? request["method"].toUpperCase() : "POST",
      requestBody,
      statusCode: null,
      responseHeaders: null,
    });
  } catch {
    model = null;
  }
  return { provider: extractor.provider, model };
}
