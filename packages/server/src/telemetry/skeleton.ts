/**
 * Reading skeletons (RAW_TELEMETRY.md): bodies whose strings were replaced by
 * `{"$s": N}` unless allowlisted, long arrays cut to 8 items plus
 * `{"$more": n}`, deep subtrees replaced by `{"$trunc": true}`, binary bodies
 * as `{"$bytes": n}` and forms as `{"$multipart": [...]}`.
 */

export type Rec = Record<string, unknown>;

export function asRecord(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Rec : null;
}

function onlyKey(record: Rec, key: string): boolean {
  const keys = Object.keys(record);
  return keys.length === 1 && keys[0] === key;
}

/** `{"$s": N}`: a string the SDK replaced by its length. */
export function isSkeletonString(value: unknown): value is { $s: number } {
  const record = asRecord(value);
  return !!record && onlyKey(record, "$s") && typeof record["$s"] === "number";
}

export function isMore(value: unknown): value is { $more: number } {
  const record = asRecord(value);
  return !!record && onlyKey(record, "$more") && typeof record["$more"] === "number";
}

export function isTruncated(value: unknown): boolean {
  const record = asRecord(value);
  return !!record && onlyKey(record, "$trunc");
}

export function isBytes(value: unknown): value is { $bytes: number } {
  const record = asRecord(value);
  return !!record && onlyKey(record, "$bytes");
}

export function isMultipart(value: unknown): value is { $multipart: unknown[] } {
  const record = asRecord(value);
  return !!record && onlyKey(record, "$multipart") && Array.isArray(record["$multipart"]);
}

/** Any marker that stands in for a value rather than being one. */
export function isMarker(value: unknown): boolean {
  return isSkeletonString(value) || isMore(value) || isTruncated(value) || isBytes(value) || isMultipart(value);
}

/** An object body to read fields from: markers and arrays are not. */
export function asObject(value: unknown): Rec | null {
  const record = asRecord(value);
  return record && !isMarker(record) ? record : null;
}

/** A verbatim (allowlisted) string. A `$s` length is not a string we can read. */
export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A trimmed, non-empty verbatim string. */
export function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Characters (code points) of a string, verbatim or as a `$s` length. */
export function strLength(value: unknown): number | null {
  if (typeof value === "string") {
    let count = 0;
    for (const _ of value) count++;
    return count;
  }
  if (isSkeletonString(value) && Number.isFinite(value.$s) && value.$s >= 0) return value.$s;
  return null;
}

/** Whether a field held a string (verbatim or replaced by its length). */
export function isStringish(value: unknown): boolean {
  return typeof value === "string" || isSkeletonString(value);
}

/** JavaScript truthiness of the original value, as far as the skeleton tells. */
export function truthy(value: unknown): boolean {
  if (isSkeletonString(value)) return value.$s > 0;
  if (isMore(value)) return value.$more > 0;
  return Boolean(value);
}

/** A finite number (NaN and Infinity arrive as null), or null. */
export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A finite, non-negative number, or null. */
export function count(value: unknown): number | null {
  const n = num(value);
  return n != null && n >= 0 ? n : null;
}

/** The kept items of an array, without a trailing `$more` marker. */
export function items(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item) => !isMore(item));
}

/** The original length of an array: kept items plus any `$more` count. */
export function arrayLength(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  let length = 0;
  for (const item of value) length += isMore(item) ? Math.max(0, item.$more) : 1;
  return length;
}

/** Whether an array lost items to the 32-item cap. */
export function isCut(value: unknown): boolean {
  return Array.isArray(value) && value.some(isMore);
}

/**
 * A request body as extractors read it: JSON skeletons as is; a multipart
 * form as its text fields (what SDK 0.6 parsed from FormData); binary and
 * truncated bodies as null.
 */
export function requestFields(body: unknown): unknown {
  if (body == null) return null;
  if (isMultipart(body)) {
    const fields: Rec = {};
    for (const part of body.$multipart) {
      const record = asRecord(part);
      const name = record ? str(record["name"]) : null;
      if (!record || !name || !Object.prototype.hasOwnProperty.call(record, "value")) continue;
      fields[name] = record["value"];
    }
    return Object.keys(fields).length > 0 ? fields : null;
  }
  if (isMarker(body)) return null;
  return body;
}

/** A response body extractors can read: objects and arrays; markers are not bodies. */
export function responseBody(body: unknown): unknown {
  if (body == null || isMarker(body)) return null;
  return typeof body === "object" ? body : null;
}

/** Walk a dotted path through objects (custom provider config). */
export function readPath(value: unknown, path: string | null): unknown {
  if (!path) return undefined;
  let current: unknown = value;
  for (const segment of path.split(".").filter(Boolean)) {
    const record = asObject(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
}
