import type { NormalizedUsage } from "@costkey/shared";
import { count } from "./skeleton.js";

export type { NormalizedUsage };

export function emptyUsage(): NormalizedUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
  };
}

/** Usage for a call billed in native units, optionally with a provider-reported cost. */
export function unitUsage(units: Record<string, number | null | undefined>, costUsd: number | null = null): NormalizedUsage | null {
  const nativeUnits: Record<string, number> = {};
  for (const [unit, value] of Object.entries(units)) {
    const n = count(value);
    if (n != null) nativeUnits[unit] = n;
  }
  const hasUnits = Object.keys(nativeUnits).length > 0;
  if (!hasUnits && costUsd == null) return null;
  return {
    ...emptyUsage(),
    ...(costUsd != null ? { costUsd } : {}),
    ...(hasUnits ? { nativeUnits } : {}),
  };
}

/** Add native units to a usage (creating one), skipping null values. */
export function withUnits(usage: NormalizedUsage | null, units: Record<string, number | null | undefined>): NormalizedUsage | null {
  const kept: Record<string, number> = {};
  for (const [unit, value] of Object.entries(units)) {
    const n = count(value);
    if (n != null) kept[unit] = n;
  }
  if (Object.keys(kept).length === 0) return usage;
  const base = usage ?? emptyUsage();
  return { ...base, nativeUnits: { ...(base.nativeUnits ?? {}), ...kept } };
}

/**
 * Combine two reports of one call (stream records, body and headers): every
 * field keeps its largest value, which is right for every provider's stream
 * shape (OpenAI's final chunk, Anthropic's message_start + message_delta,
 * Gemini's cumulative chunks).
 */
export function mergeUsage(current: NormalizedUsage | null, next: NormalizedUsage): NormalizedUsage {
  if (!current) return { ...next, ...(next.nativeUnits ? { nativeUnits: { ...next.nativeUnits } } : {}) };
  const pick = (a: number | null | undefined, b: number | null | undefined): number | null =>
    a == null ? (b ?? null) : b == null ? a : Math.max(a, b);
  const merged: NormalizedUsage = {
    inputTokens: pick(current.inputTokens, next.inputTokens),
    outputTokens: pick(current.outputTokens, next.outputTokens),
    totalTokens: null,
    reasoningTokens: pick(current.reasoningTokens, next.reasoningTokens),
    cacheReadTokens: pick(current.cacheReadTokens, next.cacheReadTokens),
    cacheCreationTokens: pick(current.cacheCreationTokens, next.cacheCreationTokens),
  };
  const total = pick(current.totalTokens, next.totalTokens);
  merged.totalTokens = merged.inputTokens != null && merged.outputTokens != null
    ? Math.max(total ?? 0, merged.inputTokens + merged.outputTokens)
    : total;
  const cost = pick(current.costUsd, next.costUsd);
  if (cost != null) merged.costUsd = cost;
  const image = pick(current.imageOutputTokens, next.imageOutputTokens);
  if (image != null) merged.imageOutputTokens = image;
  if (current.nativeUnits || next.nativeUnits) {
    const units: Record<string, number> = { ...(current.nativeUnits ?? {}) };
    for (const [unit, value] of Object.entries(next.nativeUnits ?? {})) {
      units[unit] = pick(units[unit], value) ?? value;
    }
    merged.nativeUnits = units;
  }
  return merged;
}

/** Fill a missing total from its parts. */
export function withTotal(usage: NormalizedUsage | null): NormalizedUsage | null {
  if (usage && usage.totalTokens == null && usage.inputTokens != null && usage.outputTokens != null) {
    return { ...usage, totalTokens: usage.inputTokens + usage.outputTokens };
  }
  return usage;
}
