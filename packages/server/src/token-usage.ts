import { billableOutputTokens } from "./billing.js";
import { getPriceCatalog, providerChain } from "./price-catalog/catalog.js";
import { costFromRates, costLinesFromRates, type CostLine } from "./price-catalog/compute.js";
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

export { CACHE_REPORTED_SQL, CACHE_WRITE_SQL, OUTPUT_TOKENS_SQL, PROMPT_TOKENS_SQL } from "./token-sql.js";
import { CACHE_BESIDE_INPUT, CACHE_REPORTED_SQL, CACHE_WRITE_SQL, OUTPUT_TOKENS_SQL, PROMPT_TOKENS_SQL } from "./token-sql.js";

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

/** How one stored call got its cost. */
export type CallCostBreakdown =
  | { kind: "catalog"; priceId: string; catalogSource: string; lines: CostLine[]; tier: number | null }
  | { kind: "other"; basis: string; source: string | null; cost: number };

/**
 * A stored call's cost line by line, from the price it was charged at. Null
 * when the call has no cost or the lines don't add up to what it was charged
 * (a price edited since), so a breakdown never contradicts the stored cost.
 */
export function callCostBreakdown(row: Record<string, unknown>): CallCostBreakdown | null {
  const stored = count(row["cost_usd"]);
  if (stored == null) return null;
  const source = String(row["cost_source"] ?? "");
  // The price it was charged at; a call priced before the source was recorded
  // is explained by the catalog price for it, when that gives the same cost.
  const catalog = getPriceCatalog();
  const charged = source.startsWith("catalog:") && typeof row["pricing_id"] === "string" ? catalog.byId(row["pricing_id"]) : null;
  const fallback = !charged && !source ? catalogPriceFor(row) : null;
  for (const price of [charged ?? fallback].filter(Boolean)) {
    if (price) {
      const provider = String(row["provider"] ?? "");
      const model = typeof row["model"] === "string" && row["model"] ? row["model"] : null;
      const requestModel = typeof row["request_model"] === "string" && row["request_model"] ? row["request_model"] : null;
      const rawOutput = count(row["output_tokens"]);
      const reasoning = count(row["reasoning_tokens"]);
      const usage: PricedUsage = {
        inputTokens: count(row["input_tokens"]),
        outputTokens: billableOutputTokens({ provider, model, usage: { outputTokens: rawOutput, reasoningTokens: reasoning } }),
        reasoningTokens: reasoning,
        cacheReadTokens: count(row["cache_read_tokens"]),
        cacheCreationTokens: provider === "deepseek" ? null : count(row["cache_creation_tokens"]),
        imageOutputTokens: count(row["image_output_tokens"]) ?? inferImageOutputTokens(model, rawOutput),
        nativeUnits: nativeUnitsOf(row["native_units"]),
      };
      const usageProvider = providerChain(provider, typeof row["url"] === "string" ? row["url"] : null)[0] ?? provider;
      const priced = costLinesFromRates(price.rates, usage, usageProvider, model ?? requestModel ?? price.model);
      if (priced && sameCost(priced.lines.reduce((sum, line) => sum + line.cost, 0), stored)) {
        return { kind: "catalog", priceId: price.id, catalogSource: price.source, lines: priced.lines, tier: priced.tier };
      }
    }
  }
  return { kind: "other", basis: String(row["cost_basis"] ?? "unknown"), source: source || null, cost: stored };
}

/** A period's cost by line: each component at each rate, then cost priced another way. */
export interface CostBreakdown {
  lines: Array<{ component: string; rate: number; quantity: number; cost: number; calls: number; tier: number | null }>;
  other: Array<{ basis: string; source: string | null; calls: number; cost: number }>;
  total: number;
  /** Calls left out because the period has more than the row limit. */
  partial: boolean;
}

export function sumCostBreakdown(rows: Array<Record<string, unknown>>, limit = SAVINGS_ROW_LIMIT): CostBreakdown {
  const lines = new Map<string, CostBreakdown["lines"][number]>();
  const other = new Map<string, CostBreakdown["other"][number]>();
  let total = 0;
  for (const row of rows.slice(0, limit)) {
    const breakdown = callCostBreakdown(row);
    if (!breakdown) continue;
    if (breakdown.kind === "catalog") {
      for (const line of breakdown.lines) {
        const key = `${line.component}\u0000${line.rate}\u0000${breakdown.tier ?? ""}`;
        const entry = lines.get(key) ?? { component: line.component, rate: line.rate, quantity: 0, cost: 0, calls: 0, tier: breakdown.tier };
        entry.quantity += line.quantity;
        entry.cost += line.cost;
        entry.calls += 1;
        lines.set(key, entry);
        total += line.cost;
      }
    } else {
      const key = `${breakdown.basis}\u0000${breakdown.source ?? ""}`;
      const entry = other.get(key) ?? { basis: breakdown.basis, source: breakdown.source, calls: 0, cost: 0 };
      entry.calls += 1;
      entry.cost += breakdown.cost;
      other.set(key, entry);
      total += breakdown.cost;
    }
  }
  const order = ["input", "cacheRead", "cacheWrite", "cacheWrite1h", "output", "imageOutput"];
  const rank = (component: string) => { const index = order.indexOf(component); return index < 0 ? order.length : index; };
  return {
    lines: [...lines.values()].sort((a, b) => rank(a.component) - rank(b.component) || (a.tier ?? 0) - (b.tier ?? 0) || b.cost - a.cost),
    other: [...other.values()].sort((a, b) => b.cost - a.cost),
    total,
    partial: rows.length > limit,
  };
}

/** The catalog price a call would be charged at now, for calls stored without a price source. */
function catalogPriceFor(row: Record<string, unknown>): ReturnType<ReturnType<typeof getPriceCatalog>["byId"]> {
  const provider = String(row["provider"] ?? "");
  const model = typeof row["model"] === "string" && row["model"] ? row["model"] : null;
  if (!provider || !model) return null;
  const timestamp = row["timestamp"] instanceof Date ? row["timestamp"] : row["timestamp"] == null ? null : String(row["timestamp"]);
  const priced = getPriceCatalog().price({
    provider, model, url: typeof row["url"] === "string" ? row["url"] : null,
    requestModel: typeof row["request_model"] === "string" ? row["request_model"] : null, at: timestamp,
    usage: { inputTokens: count(row["input_tokens"]), outputTokens: count(row["output_tokens"]), cacheReadTokens: count(row["cache_read_tokens"]) },
  });
  return priced ? getPriceCatalog().byId(priced.priceId) : null;
}
