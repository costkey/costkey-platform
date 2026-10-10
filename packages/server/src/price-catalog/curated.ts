import type { CatalogPrice, PriceRates } from "./types.js";

/**
 * Prices the public catalogs don't carry or carry stale. These win over
 * synced prices, so each one cites the vendor's own page and should be
 * rechecked when that page changes. Plan-dependent rates (credits, character
 * bundles) use the published pay-as-you-go or mid-tier rate; a project price
 * overrides them for a team on another plan.
 */
const CURATED: Array<{ provider: string; models: string[]; rates: PriceRates; source: string }> = [
  // https://exa.ai/docs/reference/pricing — $7/1k searches (10 results), +$1/1k results beyond 10.
  { provider: "exa", models: ["search", "find-similar"], rates: { perQuery: 0.007, includedResults: 10, perExtraResult: 0.001 }, source: "https://exa.ai/docs/reference/pricing" },
  { provider: "exa", models: ["search-instant"], rates: { perQuery: 0.004, includedResults: 10, perExtraResult: 0.001 }, source: "https://exa.ai/docs/reference/pricing" },
  { provider: "exa", models: ["search-deep"], rates: { perQuery: 0.012, includedResults: 10, perExtraResult: 0.001 }, source: "https://exa.ai/docs/reference/pricing" },
  { provider: "exa", models: ["search-deep-reasoning"], rates: { perQuery: 0.015, includedResults: 10, perExtraResult: 0.001 }, source: "https://exa.ai/docs/reference/pricing" },
  { provider: "exa", models: ["answer"], rates: { perRequest: 0.005 }, source: "https://exa.ai/docs/reference/pricing" },
  { provider: "exa", models: ["contents"], rates: { perPage: 0.001 }, source: "https://exa.ai/docs/reference/pricing" },
  // https://www.firecrawl.dev/pricing — Standard: $83 for 100k credits; scrape, crawl and map use 1 credit per page.
  { provider: "firecrawl", models: ["scrape", "batch-scrape", "crawl", "map", "extract"], rates: { perCredit: 0.00083 }, source: "https://www.firecrawl.dev/pricing" },
  // Search: 2 credits per 10 results.
  { provider: "firecrawl", models: ["search"], rates: { perCredit: 0.00083, perQuery: 0.00166, includedResults: 10, perExtraResult: 0.000166 }, source: "https://www.firecrawl.dev/pricing" },
  // https://rumik.ai/silk-api — Silk Mulberry from $0.005 per 1k characters.
  { provider: "rumik", models: ["mulberry", "mulberry-1.5", "mulberry-1.6"], rates: { perCharacter: 0.000005 }, source: "https://rumik.ai/silk-api" },
  // https://elevenlabs.io/pricing/api — Flash and Turbo use half a credit per character.
  { provider: "elevenlabs", models: ["eleven_flash_v2_5", "eleven_flash_v2", "eleven_turbo_v2_5", "eleven_turbo_v2"], rates: { perCharacter: 0.00009 }, source: "https://elevenlabs.io/pricing/api" },
  { provider: "elevenlabs", models: ["eleven_monolingual_v1", "eleven_multilingual_v1", "eleven_english_sts_v2", "eleven_multilingual_sts_v2", "eleven_ttv_v3"], rates: { perCharacter: 0.00018 }, source: "https://elevenlabs.io/pricing/api" },
];

export function curatedPrices(): CatalogPrice[] {
  return CURATED.flatMap((entry) => entry.models.map((model) => ({
    id: `ck_${entry.provider}_${model}`,
    source: "costkey" as const,
    provider: entry.provider,
    model,
    sourceKey: entry.source,
    mode: null,
    rates: entry.rates,
    effectiveFrom: "1970-01-01T00:00:00.000Z",
    effectiveTo: null,
  })));
}
