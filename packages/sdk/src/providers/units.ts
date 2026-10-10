import type { ExtractorCall, NormalizedUsage } from "./types.js";

/** Helpers for providers that bill in native units (characters, queries, credits) rather than tokens. */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** A finite, non-negative number, or null. */
export function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A numeric header value, trying each name in turn. */
export function headerCount(headers: Headers | null | undefined, ...names: string[]): number | null {
  if (!headers) return null;
  for (const name of names) {
    const raw = headers.get(name);
    if (raw == null || raw.trim() === "") continue;
    const value = asCount(Number(raw));
    if (value != null) return value;
  }
  return null;
}

/**
 * Characters as Unicode code points (`[...text].length`), the same count as
 * Python's `len()`, so both SDKs report identical units.
 */
export function countCharacters(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/**
 * Units read from the request only count once the provider accepted the
 * call; a rejected request is not billed.
 */
export function succeeded(call: ExtractorCall | undefined): call is ExtractorCall {
  return !!call && (call.statusCode == null || (call.statusCode >= 200 && call.statusCode < 300));
}

/** Usage for a call billed in native units, optionally with a provider-reported cost. */
export function unitUsage(
  units: Record<string, number>,
  costUsd: number | null = null,
): NormalizedUsage | null {
  const nativeUnits: Record<string, number> = {};
  for (const [unit, value] of Object.entries(units)) {
    if (asCount(value) != null) nativeUnits[unit] = value;
  }
  const hasUnits = Object.keys(nativeUnits).length > 0;
  if (!hasUnits && costUsd == null) return null;
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    ...(costUsd != null ? { costUsd } : {}),
    ...(hasUnits ? { nativeUnits } : {}),
  };
}
