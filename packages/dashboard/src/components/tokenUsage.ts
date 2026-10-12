import type { TokenUsage, TraceEvent } from "../api";
import { formatTokens } from "../utils";
import { formatPercent } from "./consoleFormatters";

/**
 * Token usage read the same way the server reads it (packages/server/src/token-usage.ts):
 *
 * - input is the whole prompt. Anthropic and Bedrock (and Claude on Vertex)
 *   report cache reads and writes beside the input count; every other
 *   provider's input count already holds them.
 * - output includes reasoning. Gemini reports thinking beside its output.
 * - a call that reports no cache field has no hit rate: "—", never 0%.
 */

type UsageEvent = Pick<TraceEvent, "provider" | "model" | "input_tokens" | "output_tokens" | "reasoning_tokens" | "cache_read_tokens" | "cache_creation_tokens" | "cache_saved_usd" | "native_units">;

function count(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cacheBesideInput(provider: string, model: string): boolean {
  const id = provider.toLowerCase();
  return id === "anthropic" || id === "bedrock" || (id === "vertex" && model.toLowerCase().includes("claude"));
}

function reasoningBesideOutput(provider: string, model: string): boolean {
  return provider.toLowerCase() === "google" || model.toLowerCase().includes("gemini");
}

export interface CallUsage extends TokenUsage {
  /** Anthropic 5-minute and 1-hour cache writes, when the provider split them. */
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
}

/** One call's usage. */
export function callUsage(event: UsageEvent): CallUsage {
  const provider = String(event.provider ?? "");
  const model = String(event.model ?? "");
  const input = count(event.input_tokens);
  const cacheRead = count(event.cache_read_tokens);
  // DeepSeek never bills a cache write; old SDKs sent its cache misses there.
  const cacheWrite = provider.toLowerCase() === "deepseek" ? null : count(event.cache_creation_tokens);
  const reported = cacheRead != null || cacheWrite != null;
  const prompt = input == null && cacheRead == null && cacheWrite == null
    ? null
    : cacheBesideInput(provider, model) ? (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) : input ?? 0;
  const output = count(event.output_tokens);
  const reasoning = count(event.reasoning_tokens);
  const units = event.native_units ?? {};
  const fullOutput = reasoningBesideOutput(provider, model) && reasoning != null && reasoning > 0 ? (output ?? 0) + reasoning : output;
  return {
    inputTokens: prompt,
    cacheReadTokens: reported ? cacheRead ?? 0 : null,
    cacheWriteTokens: cacheWrite,
    cacheHitRate: reported && prompt != null && prompt > 0 ? Math.min(1, (cacheRead ?? 0) / prompt) : null,
    outputTokens: fullOutput,
    reasoningTokens: reasoning,
    cacheSavings: (cacheRead ?? 0) > 0 ? count(event.cache_saved_usd) : null,
    cacheWrite5mTokens: count(units["cacheCreation5mTokens"]),
    cacheWrite1hTokens: count(units["cacheCreation1hTokens"]),
  };
}

const add = (a: number | null, b: number | null): number | null => a == null ? b : b == null ? a : a + b;

/**
 * A run's usage: the sum of its calls. Savings show only when every call with
 * a cache hit has a checked saving.
 */
export function sumUsage(calls: CallUsage[]): CallUsage {
  let total: CallUsage = { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cacheHitRate: null, outputTokens: null, reasoningTokens: null, cacheSavings: null, cacheWrite5mTokens: null, cacheWrite1hTokens: null };
  let hits = 0;
  let savings: number | null = 0;
  for (const call of calls) {
    total = {
      ...total,
      inputTokens: add(total.inputTokens, call.inputTokens),
      cacheReadTokens: add(total.cacheReadTokens, call.cacheReadTokens),
      cacheWriteTokens: add(total.cacheWriteTokens, call.cacheWriteTokens),
      outputTokens: add(total.outputTokens, call.outputTokens),
      reasoningTokens: add(total.reasoningTokens, call.reasoningTokens),
      cacheWrite5mTokens: add(total.cacheWrite5mTokens, call.cacheWrite5mTokens),
      cacheWrite1hTokens: add(total.cacheWrite1hTokens, call.cacheWrite1hTokens),
    };
    if ((call.cacheReadTokens ?? 0) > 0) {
      hits += 1;
      savings = savings == null || call.cacheSavings == null ? null : savings + call.cacheSavings;
    }
  }
  total.cacheHitRate = total.cacheReadTokens != null && total.inputTokens != null && total.inputTokens > 0 ? Math.min(1, total.cacheReadTokens / total.inputTokens) : null;
  total.cacheSavings = hits > 0 ? savings : null;
  return total;
}

/** A token count, or "—" when the provider didn't report it. */
export function formatTokenCount(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : formatTokens(value);
}

/** A cache hit rate (0..1), or "—" when no call reported a cache field. */
export function formatHitRate(rate: number | null | undefined): string {
  return rate == null || !Number.isFinite(rate) ? "—" : formatPercent(rate * 100);
}

/** "4,000 cached" under an input count; empty when caching wasn't reported. */
export function cachedNote(usage: TokenUsage | null | undefined): string {
  if (!usage || usage.cacheReadTokens == null) return "";
  return `${formatTokens(usage.cacheReadTokens)} cached`;
}

/** "1,024 reasoning" under an output count; empty when not reported. */
export function reasoningNote(usage: TokenUsage | null | undefined): string {
  if (!usage || usage.reasoningTokens == null || usage.reasoningTokens <= 0) return "";
  return `${formatTokens(usage.reasoningTokens)} reasoning`;
}

/** "2,400 written" with the 5 minute and 1 hour split when the provider gave one. */
export function cacheWriteText(usage: CallUsage | TokenUsage | null | undefined): string {
  if (!usage || usage.cacheWriteTokens == null) return "—";
  const split = usage as Partial<CallUsage>;
  const parts = [split.cacheWrite5mTokens ? `${formatTokens(split.cacheWrite5mTokens)} for 5 min` : null, split.cacheWrite1hTokens ? `${formatTokens(split.cacheWrite1hTokens)} for 1 hour` : null].filter(Boolean);
  return parts.length > 0 ? `${formatTokens(usage.cacheWriteTokens)} (${parts.join(", ")})` : formatTokens(usage.cacheWriteTokens);
}

/** The compact line a waterfall row shows: "5,230 in · 410 out · 62.0% cached". */
export function callUsageLine(usage: CallUsage): string {
  if (usage.inputTokens == null && usage.outputTokens == null) return "";
  const parts = [
    usage.inputTokens != null ? `${formatTokens(usage.inputTokens)} in` : null,
    usage.outputTokens != null ? `${formatTokens(usage.outputTokens)} out` : null,
    usage.cacheHitRate != null && (usage.cacheReadTokens ?? 0) > 0 ? `${formatHitRate(usage.cacheHitRate)} cached` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

const UNIT_WORDS: Array<[string, (value: string, raw: number) => string]> = [
  ["characters", (value) => `${value} characters`],
  ["audioSeconds", (value) => `${value} s audio`],
  ["searchQueries", (value, raw) => `${value} ${raw === 1 ? "search" : "searches"}`],
  ["webSearchRequests", (value, raw) => `${value} web ${raw === 1 ? "search" : "searches"}`],
  ["pages", (value, raw) => `${value} ${raw === 1 ? "page" : "pages"}`],
  ["images", (value, raw) => `${value} ${raw === 1 ? "image" : "images"}`],
  ["credits", (value, raw) => `${value} ${raw === 1 ? "credit" : "credits"}`],
  ["requests", (value, raw) => `${value} ${raw === 1 ? "request" : "requests"}`],
];

/** What a non-token call was billed for, in its own units: "1,791 characters", "312 s audio". Empty for token calls. */
export function billedUnitsText(units: Record<string, number> | null | undefined): string {
  if (!units) return "";
  const parts: string[] = [];
  for (const [key, words] of UNIT_WORDS) {
    const raw = Number(units[key]);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    parts.push(words(Math.round(raw).toLocaleString(), raw));
  }
  return parts.join(" · ");
}

/** Billed units summed over calls. */
export function sumUnits(list: Array<Record<string, number> | null | undefined>): Record<string, number> {
  const total: Record<string, number> = {};
  for (const units of list) {
    for (const [key, value] of Object.entries(units ?? {})) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) total[key] = (total[key] ?? 0) + parsed;
    }
  }
  return total;
}

/** A call reported token counts. */
export function hasTokens(usage: TokenUsage): boolean {
  return (usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0;
}
