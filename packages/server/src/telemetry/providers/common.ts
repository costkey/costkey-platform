import type { ExtractCall } from "../types.js";
import { asObject, count, nonEmpty, str } from "../skeleton.js";

/** A numeric response header value, trying each name in turn. */
export function headerCount(headers: Record<string, string> | null | undefined, ...names: string[]): number | null {
  if (!headers) return null;
  for (const name of names) {
    const raw = headers[name.toLowerCase()];
    if (raw == null || String(raw).trim() === "") continue;
    const value = count(Number(raw));
    if (value != null) return value;
  }
  return null;
}

export function header(headers: Record<string, string> | null | undefined, name: string): string | null {
  const value = headers?.[name.toLowerCase()];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Units read from the request only count once the provider accepted the
 * call; a rejected request is not billed.
 */
export function succeeded(call: ExtractCall): boolean {
  return call.statusCode == null || (call.statusCode >= 200 && call.statusCode < 300);
}

/** The model the response reports (it may differ from the request), else the requested one. */
export function responseOrRequestModel(requestBody: unknown, responseBody: unknown): string | null {
  const response = str(asObject(responseBody)?.["model"]);
  if (response != null) return response;
  return str(asObject(requestBody)?.["model"]);
}

/** The requested model names the priced model; responses may echo a resolved alias. */
export function requestOrResponseModel(requestBody: unknown, responseBody: unknown): string | null {
  return nonEmpty(asObject(requestBody)?.["model"]) ?? responseOrRequestModel(null, responseBody);
}

export function requestString(call: ExtractCall, ...keys: string[]): string | null {
  const request = asObject(call.requestBody);
  for (const key of keys) {
    const value = nonEmpty(request?.[key]);
    if (value) return value;
  }
  return null;
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The last path segment: /search → search. */
export function lastSegment(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

export function hostIn(...hosts: string[]): (url: URL) => boolean {
  const set = new Set(hosts);
  return (url) => set.has(url.hostname);
}
