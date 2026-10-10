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
  // https://deepgram.com/pricing — Aura-2 $0.030 and Aura $0.015 per 1k characters.
  { provider: "deepgram", models: ["aura-2-*"], rates: { perCharacter: 0.00003 }, source: "https://deepgram.com/pricing" },
  { provider: "deepgram", models: ["aura-*"], rates: { perCharacter: 0.000015 }, source: "https://deepgram.com/pricing" },
  // https://www.assemblyai.com/pricing — Universal $0.15/hr; Universal-3 Pro (formerly Slam-1) $0.21/hr.
  { provider: "assemblyai", models: ["best", "universal", "universal-2"], rates: { perSecond: 0.15 / 3600 }, source: "https://www.assemblyai.com/pricing" },
  { provider: "assemblyai", models: ["universal-3-pro", "universal-3", "slam-1"], rates: { perSecond: 0.21 / 3600 }, source: "https://www.assemblyai.com/pricing" },
  // https://www.tavily.com/pricing — $0.008 per credit; basic search 1 credit, advanced 2.
  { provider: "tavily", models: ["search"], rates: { perQuery: 0.008, perCredit: 0.008 }, source: "https://www.tavily.com/pricing" },
  { provider: "tavily", models: ["search-advanced"], rates: { perQuery: 0.016, perCredit: 0.008 }, source: "https://www.tavily.com/pricing" },
  { provider: "tavily", models: ["extract", "crawl", "map"], rates: { perCredit: 0.008 }, source: "https://www.tavily.com/pricing" },
  // https://platform.openai.com/docs/pricing — gpt-4o-mini-tts is about $0.015 a minute, as tts-1 ($15 per 1M characters).
  { provider: "openai", models: ["gpt-4o-mini-tts"], rates: { perCharacter: 0.000015 }, source: "https://platform.openai.com/docs/pricing" },
  // https://www.cartesia.ai/pricing — 1 credit per character; Scale: $299 for 8M credits.
  { provider: "cartesia", models: ["*"], rates: { perCharacter: 0.0000374 }, source: "https://www.cartesia.ai/pricing" },
  // https://jina.ai/api-dashboard — token packs at $0.05 per 1M tokens.
  { provider: "jina", models: ["*"], rates: { input: 0.00000005, output: 0 }, source: "https://jina.ai/api-dashboard" },
  // https://docs.sarvam.ai/api-reference-docs/getting-started/pricing — INR rates at ₹88/$:
  // Bulbul v3 ₹30 and v2 ₹15 per 10k characters; speech to text ₹30 per hour.
  { provider: "sarvam", models: ["bulbul:v3"], rates: { perCharacter: 30 / 10_000 / 88 }, source: "https://docs.sarvam.ai/api-reference-docs/getting-started/pricing" },
  { provider: "sarvam", models: ["bulbul:v2", "bulbul:v1"], rates: { perCharacter: 15 / 10_000 / 88 }, source: "https://docs.sarvam.ai/api-reference-docs/getting-started/pricing" },
  { provider: "sarvam", models: ["saarika:v2.5", "saarika:v2", "saaras:v3", "saaras:v2.5", "saaras:v2"], rates: { perSecond: 30 / 3600 / 88 }, source: "https://docs.sarvam.ai/api-reference-docs/getting-started/pricing" },
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
