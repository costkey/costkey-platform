import type { PriceRates, PricedUsage } from "./types.js";

/**
 * Providers whose reported input count already contains cached tokens
 * (OpenAI-compatible `prompt_tokens`, Gemini `promptTokenCount`). Anthropic
 * and Bedrock Converse report cache reads and writes beside the input count.
 */
export function cacheIncludedInInput(provider: string, model: string): boolean {
  const lower = model.toLowerCase();
  if (provider === "anthropic" || provider === "bedrock") return false;
  if (provider === "vertex") return !lower.includes("claude");
  return true;
}

const nonNegative = (value: number | null | undefined): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Units in `nativeUnits` that the catalog can price. */
export const PRICEABLE_NATIVE_UNITS = new Set([
  "characters", "audioSeconds", "searchQueries", "groundingRequests", "mapsGroundingRequests",
  "credits", "pages", "images", "requests", "webSearchRequests",
]);

/** One part of a call's cost: a quantity at a rate. */
export interface CostLine {
  /** input, cacheRead, cacheWrite, cacheWrite1h, output, imageOutput, or a native unit such as characters. */
  component: string;
  quantity: number;
  /** USD per token or per unit. */
  rate: number;
  cost: number;
}

/**
 * Price one call from catalog rates, line by line. Null when any billed
 * component has no rate, so a call is never silently priced for only part of
 * its usage. `tier` is the long-context threshold whose rates applied.
 */
export function costLinesFromRates(rates: PriceRates, usage: PricedUsage, provider: string, model: string): { lines: CostLine[]; tier: number | null } | null {
  const input = nonNegative(usage.inputTokens);
  const output = nonNegative(usage.outputTokens);
  const cacheRead = nonNegative(usage.cacheReadTokens);
  const cacheWrite = nonNegative(usage.cacheCreationTokens);
  const imageOutput = Math.min(nonNegative(usage.imageOutputTokens), output);
  const units = usage.nativeUnits ?? {};
  const included = cacheIncludedInInput(provider, model);
  const promptTokens = included ? input : input + cacheRead + cacheWrite;

  let active: PriceRates = rates;
  let tier: number | null = null;
  for (const longContext of rates.longContext ?? []) {
    if (promptTokens > longContext.threshold) {
      active = { ...active, ...Object.fromEntries(Object.entries(longContext).filter(([key, value]) => key !== "threshold" && value !== undefined)) };
      tier = longContext.threshold;
    }
  }

  const lines: CostLine[] = [];
  const add = (component: string, quantity: number, rate: number) => {
    if (quantity > 0) lines.push({ component, quantity, rate, cost: quantity * rate });
  };
  const hasTokens = input + output + cacheRead + cacheWrite > 0;
  if (hasTokens) {
    if (active.input === undefined && input > 0) return null;
    if (active.output === undefined && output - imageOutput > 0) return null;
    const cacheReadRate = active.cacheRead ?? active.input ?? 0;
    const cacheWriteRate = active.cacheWrite ?? active.input ?? 0;
    // Anthropic's 1-hour cache writes (a part of cacheCreationTokens) have their own rate.
    const cacheWrite1h = Math.min(nonNegative(units["cacheCreation1hTokens"]), cacheWrite);
    const cacheWrite1hRate = rates.cacheWrite1h ?? cacheWriteRate;
    // Where the input count includes cache tokens, they're carved out of it
    // (DeepSeek's cache misses land on the input rate this way).
    const billableInput = included ? Math.max(0, input - cacheRead - cacheWrite) : input;
    add("input", billableInput, active.input ?? 0);
    add("cacheRead", cacheRead, cacheReadRate);
    add("cacheWrite", cacheWrite - cacheWrite1h, cacheWriteRate);
    add("cacheWrite1h", cacheWrite1h, cacheWrite1hRate);
    add("output", output - imageOutput, active.output ?? 0);
    if (imageOutput > 0) {
      const imageRate = active.outputImage ?? active.output;
      if (imageRate === undefined) return null;
      add("imageOutput", imageOutput, imageRate);
    }
  }

  // Credits a provider reports are what it bills; a search is only priced
  // from its query count when no credits were reported.
  const creditsBilled = nonNegative(units["credits"]) > 0 && rates.perCredit !== undefined;
  for (const [unit, rawValue] of Object.entries(units)) {
    const value = nonNegative(rawValue);
    if (value === 0 || !PRICEABLE_NATIVE_UNITS.has(unit)) continue;
    if (creditsBilled && unit === "searchQueries") continue;
    let unitRate: number | undefined;
    switch (unit) {
      case "characters": unitRate = rates.perCharacter; break;
      case "audioSeconds": unitRate = rates.perSecond; break;
      case "credits": unitRate = rates.perCredit; break;
      case "pages": unitRate = rates.perPage; break;
      case "images": unitRate = rates.perOutputImage; break;
      case "requests": unitRate = rates.perRequest; break;
      case "searchQueries": {
        // Search APIs price per query, sometimes by result count; model
        // grounding prices per executed search query.
        const results = nonNegative(units["searchResults"]);
        const queryTier = results > 0 ? rates.queryTiers?.find((candidate) => results <= candidate.maxResults) : undefined;
        // Model grounding billed per grounded request is charged below.
        if (!queryTier && rates.perQuery === undefined && rates.searchBilling === "request") continue;
        unitRate = queryTier?.perQuery ?? rates.perQuery ?? rates.searchPerQuery;
        if (unitRate !== undefined && rates.includedResults !== undefined && rates.perExtraResult !== undefined) {
          unitRate += Math.max(0, results - rates.includedResults) * rates.perExtraResult;
        }
        break;
      }
      case "groundingRequests":
        // Gemini 3+ bills per search query (a request without a query count
        // is billed as one); Gemini 2.x bills per grounded prompt.
        if (rates.searchBilling !== "request" && nonNegative(units["searchQueries"]) > 0) continue;
        unitRate = rates.searchPerQuery;
        break;
      case "mapsGroundingRequests": unitRate = rates.mapsPerQuery; break;
      // Anthropic server-side web search, billed per search.
      case "webSearchRequests": unitRate = rates.searchPerQuery ?? rates.perQuery; break;
    }
    if (unitRate === undefined) return null;
    add(unit, value, unitRate);
  }
  if (rates.perRequest !== undefined && units["requests"] === undefined) add("requests", 1, rates.perRequest);
  return { lines, tier };
}

/**
 * Price one call from catalog rates. Returns null when any billed component
 * has no rate, so a call is never silently priced for only part of its usage.
 */
export function costFromRates(rates: PriceRates, usage: PricedUsage, provider: string, model: string): number | null {
  const priced = costLinesFromRates(rates, usage, provider, model);
  if (!priced) return null;
  const cost = priced.lines.reduce((sum, line) => sum + line.cost, 0);
  return Math.round(cost * 1e12) / 1e12;
}

/** The highest per-token rates a call could be charged, for budget reservations. */
export function maxTokenRates(rates: PriceRates): { input: number; output: number; cacheRead?: number; cacheWrite?: number; outputImage?: number } {
  const pick = (key: "input" | "output" | "cacheRead" | "cacheWrite"): number | undefined => {
    const values = [rates[key], ...(rates.longContext ?? []).map((tier) => tier[key])].filter((value): value is number => value !== undefined);
    return values.length ? Math.max(...values) : undefined;
  };
  return {
    input: pick("input") ?? 0,
    output: pick("output") ?? 0,
    ...(pick("cacheRead") === undefined ? {} : { cacheRead: pick("cacheRead") }),
    ...(pick("cacheWrite") === undefined ? {} : { cacheWrite: pick("cacheWrite") }),
    ...(rates.outputImage === undefined ? {} : { outputImage: rates.outputImage }),
  };
}
