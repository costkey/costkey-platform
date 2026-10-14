/** Where a catalog price came from. */
export type PriceSource = "litellm" | "models_dev" | "openrouter" | "vercel" | "costkey";

/**
 * USD per unit. Token rates are per single token. Every field is optional:
 * a component the model doesn't bill for is simply absent.
 */
export interface PriceRates {
  input?: number;
  output?: number;
  cacheRead?: number;
  /** 5-minute (default) cache write. */
  cacheWrite?: number;
  cacheWrite1h?: number;
  /** Only when a provider bills reasoning differently from output. */
  reasoning?: number;
  inputAudio?: number;
  outputAudio?: number;
  inputImage?: number;
  outputImage?: number;
  perInputImage?: number;
  perOutputImage?: number;
  perCharacter?: number;
  perSecond?: number;
  perQuery?: number;
  perRequest?: number;
  perPage?: number;
  perCredit?: number;
  /** Search grounding / web search, per query or per grounded request. */
  searchPerQuery?: number;
  /** Whether `searchPerQuery` is charged per executed query or per grounded request. */
  searchBilling?: "query" | "request";
  /** Google Maps grounding, per grounded request. */
  mapsPerQuery?: number;
  /** Search results included in `perQuery`; each one beyond costs `perExtraResult`. */
  includedResults?: number;
  perExtraResult?: number;
  /** Rates that replace the base rates once the prompt exceeds `threshold` tokens. */
  longContext?: Array<{ threshold: number } & Pick<PriceRates, "input" | "output" | "cacheRead" | "cacheWrite">>;
  /** Per-query price that depends on the number of results requested. */
  queryTiers?: Array<{ maxResults: number; perQuery: number }>;
}

export interface CatalogEntry {
  source: PriceSource;
  /** CostKey's canonical provider id (openai, azure, bedrock, google, vertex...). */
  provider: string;
  /** Normalized model id used for matching. */
  model: string;
  /** The key exactly as the source publishes it. */
  sourceKey: string;
  mode: string | null;
  rates: PriceRates;
}

/** A versioned catalog row as stored and served. */
export interface CatalogPrice extends CatalogEntry {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Usage for one call, in the units the server stores. */
export interface PricedUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  imageOutputTokens?: number | null;
  nativeUnits?: Record<string, number> | null;
}

export type MatchKind = "exact" | "normalized" | "undated" | "first_party" | "inferred";

export interface CatalogMatch {
  price: CatalogPrice;
  match: MatchKind;
}

export interface CatalogCost {
  cost: number;
  priceId: string;
  source: PriceSource;
  match: MatchKind;
  effectiveFrom: string;
}
