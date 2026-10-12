import { billableOutputTokens } from "./billing.js";
import { getPriceCatalog, providerChain } from "./price-catalog/catalog.js";
import { costFromRates } from "./price-catalog/compute.js";
import type { PriceRates, PricedUsage } from "./price-catalog/types.js";
import { computeCost, inferImageOutputTokens, tableCacheIncludedInInput } from "./pricing.js";

/**
 * Token usage the way people read it, whatever the provider reported:
 *
 * - input is the whole prompt, cache reads and writes included. Anthropic and
 *   Bedrock (and Claude on Vertex) report cache reads and writes beside the
 *   input count; every other provider's input count already holds them.
 * - output includes reasoning. Gemini reports thinking tokens beside its
 *   output count; other providers include them.
 * - a cache hit rate exists only when a call reported a cache field. A call
 *   that never mentions caching has an unknown rate, not 0%.
 */

/** SQL: the provider reports cache tokens beside the input count. Mirrors `cacheIncludedInInput`. */
const CACHE_BESIDE_INPUT = (e: string) =>
  `(${e}.provider IN ('anthropic', 'bedrock') OR (${e}.provider = 'vertex' AND LOWER(COALESCE(${e}.model, '')) LIKE '%claude%'))`;

/** SQL: cache writes. DeepSeek never bills one; SDK 0.6 sent its cache misses there. */
export const CACHE_WRITE_SQL = (e: string) => `CASE WHEN ${e}.provider = 'deepseek' THEN NULL ELSE ${e}.cache_creation_tokens END`;

/** SQL: the whole prompt, cache included. Null when the call reported no input at all. */
export const PROMPT_TOKENS_SQL = (e: string) => `CASE
    WHEN ${e}.input_tokens IS NULL AND ${e}.cache_read_tokens IS NULL AND ${CACHE_WRITE_SQL(e)} IS NULL THEN NULL
    WHEN ${CACHE_BESIDE_INPUT(e)} THEN COALESCE(${e}.input_tokens, 0) + COALESCE(${e}.cache_read_tokens, 0) + COALESCE(${CACHE_WRITE_SQL(e)}, 0)
    ELSE COALESCE(${e}.input_tokens, 0) END`;

/** SQL: output with reasoning included. Mirrors `billableOutputTokens`. */
export const OUTPUT_TOKENS_SQL = (e: string) => `CASE
    WHEN (${e}.provider = 'google' OR LOWER(COALESCE(${e}.model, '')) LIKE '%gemini%') AND ${e}.reasoning_tokens > 0
      THEN COALESCE(${e}.output_tokens, 0) + ${e}.reasoning_tokens
    ELSE ${e}.output_tokens END`;

/** SQL: the call said something about caching. */
export const CACHE_REPORTED_SQL = (e: string) => `(${e}.cache_read_tokens IS NOT NULL OR ${CACHE_WRITE_SQL(e)} IS NOT NULL)`;

/**
 * Sums over rows carrying prompt_tokens, cache_read_tokens, cache_write_tokens,
 * completion_tokens, reasoning_tokens and cache_reported.
 */
export const USAGE_SUM_COLUMNS = (prefix = "") => `
  SUM(${prefix}prompt_tokens)::bigint AS input_tokens,
  SUM(${prefix}cache_read_tokens)::bigint AS cache_read_tokens,
  SUM(${prefix}cache_write_tokens)::bigint AS cache_write_tokens,
  SUM(${prefix}completion_tokens)::bigint AS output_tokens,
  SUM(${prefix}reasoning_tokens)::bigint AS reasoning_tokens,
  COALESCE(BOOL_OR(${prefix}cache_reported), FALSE) AS cache_reported`;

export interface TokenUsage {
  /** Whole prompt, cache reads and writes included. */
  inputTokens: number | null;
  /** Null when no call reported a cache field. */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Cache reads over the whole prompt; null when no call reported a cache field. */
  cacheHitRate: number | null;
  /** Output, reasoning included. */
  outputTokens: number | null;
  reasoningTokens: number | null;
  /**
   * What cache hits saved against the uncached input price, in USD. Only set
   * when every call with a cache hit was priced from a list rate we can
   * check against its stored cost; null otherwise.
   */
  cacheSavings?: number | null;
}

function count(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Read the columns of `USAGE_SUM_COLUMNS` (or a run's own columns) into a TokenUsage. */
export function usageFrom(row: Record<string, unknown>): TokenUsage {
  const reported = row["cache_reported"] === true;
  const input = count(row["input_tokens"] ?? row["prompt_tokens"]);
  const cacheRead = reported ? count(row["cache_read_tokens"]) ?? 0 : null;
  return {
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: count(row["cache_write_tokens"]),
    cacheHitRate: cacheRead != null && input != null && input > 0 ? Math.min(1, cacheRead / input) : null,
    outputTokens: count(row["output_tokens"] ?? row["completion_tokens"]),
    reasoningTokens: count(row["reasoning_tokens"]),
  };
}

/** Same total within floating-point noise. */
function sameCost(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 + Math.abs(b) * 1e-6;
}

/** The rates with every cache read charged as ordinary input. */
function withoutCacheDiscount(rates: PriceRates): PriceRates | null {
  if (rates.input === undefined) return null;
  return {
    ...rates,
    cacheRead: rates.input,
    ...(rates.longContext ? { longContext: rates.longContext.map((tier) => ({ ...tier, cacheRead: tier.input ?? rates.input })) } : {}),
  };
}

function nativeUnitsOf(value: unknown): Record<string, number> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, number> : null;
}

/**
 * What one stored call saved through cache hits, in USD: its cost with cache
 * reads at the full input price, minus what it was charged. 0 when it had no
 * cache hits. Null unless the call was priced from a list price we can
 * reproduce exactly (the catalog version it names, or the built-in table): a
 * provider-reported, negotiated or project price has no honest counterfactual.
 */
export function callCacheSavings(row: Record<string, unknown>): number | null {
  const cacheRead = count(row["cache_read_tokens"]);
  if (cacheRead == null || cacheRead <= 0) return 0;
  const stored = count(row["cost_usd"]);
  if (stored == null || row["cost_basis"] !== "estimated") return null;
  const provider = String(row["provider"] ?? "");
  const model = typeof row["model"] === "string" && row["model"] ? row["model"] : null;
  const requestModel = typeof row["request_model"] === "string" && row["request_model"] ? row["request_model"] : null;
  const input = count(row["input_tokens"]);
  const rawOutput = count(row["output_tokens"]);
  const reasoning = count(row["reasoning_tokens"]);
  const output = billableOutputTokens({ provider, model, usage: { outputTokens: rawOutput, reasoningTokens: reasoning } });
  const cacheWrite = provider === "deepseek" ? null : count(row["cache_creation_tokens"]);
  const nativeUnits = nativeUnitsOf(row["native_units"]);
  const imageOutput = count(row["image_output_tokens"]) ?? inferImageOutputTokens(model, rawOutput);
  const source = String(row["cost_source"] ?? "");

  if (source.startsWith("catalog:") && typeof row["pricing_id"] === "string") {
    const price = getPriceCatalog().byId(row["pricing_id"]);
    if (!price) return null;
    const usage: PricedUsage = {
      inputTokens: input, outputTokens: output, reasoningTokens: reasoning, cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheWrite, imageOutputTokens: imageOutput, nativeUnits,
    };
    const usageProvider = providerChain(provider, typeof row["url"] === "string" ? row["url"] : null)[0] ?? provider;
    const name = model ?? requestModel ?? price.model;
    const charged = costFromRates(price.rates, usage, usageProvider, name);
    const fullRates = withoutCacheDiscount(price.rates);
    if (charged == null || !fullRates || !sameCost(charged, stored)) return null;
    const full = costFromRates(fullRates, usage, usageProvider, name);
    return full == null ? null : Math.max(0, full - charged);
  }

  if (source === "pricing_table") {
    const timestamp = row["timestamp"] instanceof Date ? row["timestamp"].toISOString() : row["timestamp"] == null ? null : String(row["timestamp"]);
    const cacheWrite1h = nativeUnits?.["cacheCreation1hTokens"] ?? null;
    for (const name of [model, requestModel]) {
      if (!name) continue;
      const charged = computeCost(name, input, output, cacheRead, cacheWrite, provider, timestamp, imageOutput, cacheWrite1h);
      if (charged == null || !sameCost(charged, stored)) continue;
      const included = tableCacheIncludedInInput(name, provider);
      // Moving cache reads into the input count would cross a long-context
      // price tier; that call has no clean counterfactual.
      if (!included && (input ?? 0) + cacheRead > 200_000) return null;
      const full = computeCost(name, included ? input : (input ?? 0) + cacheRead, output, 0, cacheWrite, provider, timestamp, imageOutput, cacheWrite1h);
      return full == null ? null : Math.max(0, full - charged);
    }
    return null;
  }
  return null;
}

/** Calls with a cache hit we read for savings; past this the total is not shown. */
export const SAVINGS_ROW_LIMIT = 20_000;

/**
 * Total cache savings over calls with a cache hit, overall and per key. A
 * total is null as soon as one of its calls can't be checked, or when there
 * were no cache hits at all.
 */
export function sumCacheSavings(rows: Array<Record<string, unknown>>, keyOf: (row: Record<string, unknown>) => string = () => ""): { total: number | null; byKey: Map<string, number | null> } {
  const byKey = new Map<string, number | null>();
  if (rows.length > SAVINGS_ROW_LIMIT) return { total: null, byKey };
  let total: number | null = rows.length > 0 ? 0 : null;
  for (const row of rows) {
    const key = keyOf(row);
    const saved = callCacheSavings(row);
    const current = byKey.has(key) ? byKey.get(key)! : 0;
    byKey.set(key, saved == null || current == null ? null : current + saved);
    total = saved == null || total == null ? null : total + saved;
  }
  return { total, byKey };
}

/** Columns a savings query selects from `calls` (see RUNS_CTE). */
export const SAVINGS_COLUMNS = (e: string) => `${e}.provider, ${e}.model, ${e}.request_model, ${e}.url, ${e}.timestamp,
  ${e}.cost_usd, ${e}.cost_basis, ${e}.cost_source, ${e}.pricing_id, ${e}.input_tokens, ${e}.output_tokens,
  ${e}.reasoning_tokens, ${e}.cache_read_tokens, ${e}.cache_creation_tokens, ${e}.image_output_tokens, ${e}.native_units`;
