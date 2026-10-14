import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PriceCatalog, modelVendor, providerChain } from "../price-catalog/catalog.js";
import { costFromRates, maxTokenRates } from "../price-catalog/compute.js";
import { curatedPrices } from "../price-catalog/curated.js";
import { modelCandidates, normalizeLiteLlm, normalizeModelsDev, normalizeOpenRouter, normalizeVercelGateway, stripModelVersion } from "../price-catalog/normalize.js";
import type { CatalogEntry, CatalogPrice } from "../price-catalog/types.js";

const EPOCH = "1970-01-01T00:00:00.000Z";
const M = 1 / 1_000_000;

function catalog(entries: CatalogEntry[], extra: CatalogPrice[] = []): PriceCatalog {
  return new PriceCatalog([...extra, ...entries.map((entry, index) => ({ ...entry, id: `p${index}`, effectiveFrom: EPOCH, effectiveTo: null }))]);
}

const litellm = normalizeLiteLlm({
  sample_spec: { input_cost_per_token: 1 },
  "gpt-6-sol": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 2e-7, input_cost_per_token_above_272k_tokens: 4e-6, output_cost_per_token_above_272k_tokens: 1.5e-5, input_cost_per_token_priority: 4e-6 },
  "azure/gpt-6-sol-2026-09-22": { litellm_provider: "azure", input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 },
  "azure/us/gpt-6-sol": { litellm_provider: "azure", input_cost_per_token: 2.2e-6, output_cost_per_token: 1.1e-5 },
  "claude-sonnet-5": { litellm_provider: "anthropic", input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 2.5e-6 },
  "us.anthropic.claude-sonnet-5": { litellm_provider: "bedrock_converse", input_cost_per_token: 2.2e-6, output_cost_per_token: 1.1e-5 },
  "gemini/gemini-3.7-flash": { litellm_provider: "gemini", input_cost_per_token: 7.5e-7, output_cost_per_token: 3.75e-6, search_context_cost_per_query: { search_context_size_medium: 0.014 }, web_search_billing_unit: "per_query", google_maps_grounding_cost_per_query: 0.025 },
  "gemini/gemini-2.5-flash": { litellm_provider: "gemini", input_cost_per_token: 3e-7, output_cost_per_token: 2.5e-6, search_context_cost_per_query: { search_context_size_medium: 0.035 } },
  "elevenlabs/eleven_multilingual_v2": { litellm_provider: "elevenlabs", mode: "audio_speech", input_cost_per_character: 0.00018 },
  "firecrawl/search": { litellm_provider: "firecrawl", tiered_pricing: [{ input_cost_per_query: 0.00166, max_results_range: [1, 10] }, { input_cost_per_query: 0.00332, max_results_range: [11, 20] }] },
  "command-a-plus": { litellm_provider: "cohere_chat", input_cost_per_token: 0, output_cost_per_token: 0 },
  "perplexity/sonar": { litellm_provider: "perplexity", input_cost_per_token: 2.5e-7, output_cost_per_token: 2.5e-6 },
  "some-reseller/model": { litellm_provider: "resellerx", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
  "broken/model": { litellm_provider: "openai", input_cost_per_token: 5 },
});

const modelsDev = normalizeModelsDev({
  cohere: { models: { "command-a-plus": { cost: { input: 2.5, output: 10 } } } },
  perplexity: { models: { sonar: { cost: { input: 1, output: 1 } } } },
  groq: { models: { "llama-4-scout": { cost: { input: 0.11, output: 0.34, cache_read: 0.05, tiers: [{ input: 0.2, output: 0.6, tier: { type: "context", size: 128000 } }] } } } },
  someone: { models: { x: { cost: { input: 1, output: 1 } } } },
});

const openRouter = normalizeOpenRouter({
  data: [
    { id: "openai/gpt-6-sol", pricing: { prompt: "0.000002", completion: "0.00001", web_search: "0.01", overrides: [{ min_prompt_tokens: 272000, prompt: "0.000004", completion: "0.000015" }] } },
    { id: "perplexity/sonar", pricing: { prompt: "0.000001", completion: "0.000001" } },
    { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
    { id: "meta-llama/llama-4:free", pricing: { prompt: "0", completion: "0" } },
  ],
});

describe("price catalog normalization", () => {
  it("maps source providers, strips routing prefixes and skips regional, reseller and implausible rows", () => {
    const keys = litellm.map((entry) => `${entry.provider}:${entry.model}`);
    assert.ok(keys.includes("openai:gpt-6-sol"));
    assert.ok(keys.includes("azure:gpt-6-sol-2026-09-22"));
    assert.ok(keys.includes("bedrock:us.anthropic.claude-sonnet-5"));
    assert.ok(keys.includes("google:gemini-3.7-flash"));
    assert.ok(!keys.some((key) => key.includes("us/gpt-6-sol")), "regional surcharge rows are skipped");
    assert.ok(!keys.some((key) => key.includes("some-reseller")));
    assert.ok(!keys.some((key) => key.includes("broken")), "a $5M-per-token price is rejected");
    const sol = litellm.find((entry) => entry.sourceKey === "gpt-6-sol")!;
    assert.deepEqual(sol.rates.longContext, [{ threshold: 272_000, input: 4e-6, output: 1.5e-5 }]);
    const gemini = litellm.find((entry) => entry.model === "gemini-3.7-flash")!;
    assert.equal(gemini.rates.searchPerQuery, 0.014);
    assert.equal(gemini.rates.mapsPerQuery, 0.025);
    assert.deepEqual(litellm.find((entry) => entry.provider === "firecrawl")!.rates.queryTiers, [{ maxResults: 10, perQuery: 0.00166 }, { maxResults: 20, perQuery: 0.00332 }]);
  });

  it("reads models.dev per-million prices and context tiers", () => {
    const scout = modelsDev.find((entry) => entry.model === "llama-4-scout")!;
    assert.equal(scout.provider, "groq");
    assert.ok(Math.abs(scout.rates.input! - 0.11 * M) < 1e-15);
    assert.equal(scout.rates.longContext?.[0]?.threshold, 128_000);
    assert.ok(!modelsDev.some((entry) => entry.sourceKey.startsWith("someone/")));
  });

  it("keeps OpenRouter ids, adds a vendor fallback and drops router pseudo-models", () => {
    assert.ok(openRouter.some((entry) => entry.provider === "openrouter" && entry.model === "openai/gpt-6-sol"));
    assert.ok(openRouter.some((entry) => entry.provider === "openai" && entry.model === "gpt-6-sol"));
    assert.ok(!openRouter.some((entry) => entry.model.includes("auto")));
    assert.ok(openRouter.some((entry) => entry.model === "meta-llama/llama-4:free"), "free models are real $0 prices");
    assert.ok(!openRouter.some((entry) => entry.provider !== "openrouter" && entry.model.includes(":free")));
  });

  it("generates model candidates from most to least specific", () => {
    assert.equal(stripModelVersion("anthropic.claude-3-5-sonnet-20241022-v2:0"), "anthropic.claude-3-5-sonnet");
    assert.equal(stripModelVersion("claude-haiku-4-5@20251001"), "claude-haiku-4-5");
    assert.equal(stripModelVersion("gpt-6-sol-2026-09-22"), "gpt-6-sol");
    const names = modelCandidates("arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-sonnet-5-v1:0").map((candidate) => candidate.model);
    assert.deepEqual(names.slice(1), ["us.anthropic.claude-sonnet-5-v1:0", "us.anthropic.claude-sonnet-5", "anthropic.claude-sonnet-5-v1:0", "anthropic.claude-sonnet-5"]);
    assert.ok(modelCandidates("ft:gpt-4o-mini-2024-07-18:acme::abc").some((candidate) => candidate.model === "ft:gpt-4o-mini-2024-07-18"));
  });
});

describe("price catalog cost math", () => {
  const sol = litellm.find((entry) => entry.sourceKey === "gpt-6-sol")!.rates;

  it("carves cached tokens out of OpenAI-style input and prices them at the cache rate", () => {
    const cost = costFromRates(sol, { inputTokens: 5000, outputTokens: 600, cacheReadTokens: 2500 }, "azure", "gpt-6-sol");
    assert.equal(cost, 2500 * 2e-6 + 2500 * 2e-7 + 600 * 1e-5);
  });

  it("adds Anthropic cache tokens beside the input count", () => {
    const rates = litellm.find((entry) => entry.sourceKey === "claude-sonnet-5")!.rates;
    const cost = costFromRates(rates, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 5000, cacheCreationTokens: 500 }, "anthropic", "claude-sonnet-5");
    assert.equal(cost, 1000 * 2e-6 + 5000 * 2e-7 + 500 * 2.5e-6 + 100 * 1e-5);
  });

  it("switches to long-context rates past the threshold", () => {
    const cost = costFromRates(sol, { inputTokens: 300_000, outputTokens: 1000 }, "openai", "gpt-6-sol");
    assert.ok(Math.abs(cost! - (300_000 * 4e-6 + 1000 * 1.5e-5)) < 1e-9);
  });

  it("prices grounding per search query, Maps per grounded request, and refuses units without a rate", () => {
    const rates = litellm.find((entry) => entry.model === "gemini-3.7-flash")!.rates;
    const tokens = 1000 * 7.5e-7 + 100 * 3.75e-6;
    assert.equal(costFromRates(rates, { inputTokens: 1000, outputTokens: 100, nativeUnits: { groundingRequests: 1, searchQueries: 3 } }, "vertex", "gemini-3.7-flash"), Math.round((tokens + 3 * 0.014) * 1e12) / 1e12);
    assert.equal(costFromRates(rates, { inputTokens: 1000, outputTokens: 100, nativeUnits: { groundingRequests: 1 } }, "google", "gemini-3.7-flash"), Math.round((tokens + 0.014) * 1e12) / 1e12);
    assert.equal(costFromRates(rates, { inputTokens: 1000, outputTokens: 100, nativeUnits: { mapsGroundingRequests: 1 } }, "google", "gemini-3.7-flash"), Math.round((tokens + 0.025) * 1e12) / 1e12);
    assert.equal(costFromRates(rates, { inputTokens: 1000, nativeUnits: { characters: 10 } }, "google", "gemini-3.7-flash"), null);
    const older = litellm.find((entry) => entry.model === "gemini-2.5-flash")!.rates;
    assert.equal(older.searchBilling, "request");
    assert.equal(costFromRates(older, { inputTokens: 1000, outputTokens: 100, nativeUnits: { groundingRequests: 1, searchQueries: 4 } }, "google", "gemini-2.5-flash"), Math.round((1000 * 3e-7 + 100 * 2.5e-6 + 0.035) * 1e12) / 1e12, "2.x is billed per grounded prompt, not per query");
    assert.equal(costFromRates({ output: 1e-6 }, { inputTokens: 10, outputTokens: 10 }, "openai", "x"), null, "input with no input rate");
  });

  it("prices characters, result tiers and included results", () => {
    assert.equal(costFromRates({ perCharacter: 0.00018 }, { nativeUnits: { characters: 1000 } }, "elevenlabs", "eleven_multilingual_v2"), 0.18);
    const firecrawl = litellm.find((entry) => entry.provider === "firecrawl")!.rates;
    assert.equal(costFromRates(firecrawl, { nativeUnits: { searchQueries: 1, searchResults: 15 } }, "firecrawl", "search"), 0.00332);
    assert.equal(costFromRates({ perQuery: 0.007, includedResults: 10, perExtraResult: 0.001 }, { nativeUnits: { searchQueries: 1, searchResults: 20 } }, "exa", "search"), 0.017);
    assert.equal(costFromRates({ perRequest: 0.005 }, {}, "exa", "answer"), 0.005);
    const search = { perCredit: 0.00083, perQuery: 0.00166, includedResults: 10, perExtraResult: 0.000166 };
    assert.equal(costFromRates(search, { nativeUnits: { credits: 4, searchQueries: 1, searchResults: 20 } }, "firecrawl", "search"), 0.00332, "reported credits win");
    assert.equal(costFromRates(search, { nativeUnits: { searchQueries: 1, searchResults: 5 } }, "firecrawl", "search"), 0.00166);
  });

  it("reserves budgets at the highest rate a call could pay", () => {
    assert.deepEqual(maxTokenRates(sol), { input: 4e-6, output: 1.5e-5, cacheRead: 2e-7 });
  });
});

describe("price catalog resolution", () => {
  const all = catalog([...litellm, ...modelsDev, ...openRouter], curatedPrices());

  it("prices Azure deployments, Vertex, Bedrock ARNs and dated snapshots", () => {
    assert.deepEqual(providerChain("openai", "https://acme.openai.azure.com/openai/v1/responses"), ["azure", "openai"]);
    assert.deepEqual(providerChain("google", "https://aiplatform.googleapis.com/v1/x"), ["vertex", "google"]);
    assert.equal(all.resolve({ provider: "openai", url: "https://acme.services.ai.azure.com/openai/v1/responses", model: "gpt-6-sol-2026-09-22" })?.price.provider, "azure");
    const azureUndated = all.resolve({ provider: "openai", url: "https://acme.openai.azure.com/x", model: "gpt-6-sol" });
    assert.equal(azureUndated?.price.provider, "openai");
    assert.equal(azureUndated?.match, "first_party");
    assert.equal(all.resolve({ provider: "google", url: "https://aiplatform.googleapis.com/v1/x", model: "gemini-3.7-flash" })?.match, "first_party");
    const bedrock = all.resolve({ provider: "bedrock", model: "arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-sonnet-5-v1:0" });
    assert.equal(bedrock?.price.sourceKey, "us.anthropic.claude-sonnet-5");
    assert.equal(all.resolve({ provider: "anthropic", model: "claude-sonnet-5-20260101" })?.match, "undated");
  });

  it("falls back to the vendor's list price for proxies and to the request model", () => {
    const proxied = all.resolve({ provider: "unknown", url: "https://llm-proxy.internal/v1/chat", model: "gpt-6-sol" });
    assert.equal(proxied?.match, "inferred");
    assert.equal(modelVendor("openai.gpt-6-sol")?.vendor, "openai");
    assert.equal(all.resolve({ provider: "openai", model: "my-prod-deployment", requestModel: "gpt-6-sol" })?.price.model, "gpt-6-sol");
    assert.equal(all.resolve({ provider: "openai", model: "totally-unknown" }), null);
  });

  it("prefers a real price over a $0 placeholder and the price most sources agree on", () => {
    const cohere = all.resolve({ provider: "cohere", model: "command-a-plus" });
    assert.equal(cohere?.price.source, "models_dev");
    const sonar = all.resolve({ provider: "perplexity", model: "sonar" });
    assert.equal(sonar?.price.rates.input, 1e-6, "models.dev and OpenRouter outvote LiteLLM");
    assert.equal(all.resolve({ provider: "openrouter", model: "meta-llama/llama-4:free" })?.price.rates.input, 0);
  });

  it("prices model families, whole providers, gateway suffixes and open-weight vendors", () => {
    assert.equal(all.price({ provider: "deepgram", model: "aura-2-thalia-en", usage: { nativeUnits: { characters: 1000 } } })?.cost, 0.03);
    assert.equal(all.price({ provider: "deepgram", model: "aura-asteria-en", usage: { nativeUnits: { characters: 1000 } } })?.cost, 0.015);
    assert.ok(all.price({ provider: "cartesia", model: "sonic-9", usage: { nativeUnits: { characters: 1000 } } }));
    assert.equal(all.resolve({ provider: "openrouter", model: "perplexity/sonar:nitro" })?.price.model, "perplexity/sonar");
    const qwen = new PriceCatalog([{ source: "litellm", provider: "alibaba", model: "qwen3-max", sourceKey: "dashscope/qwen3-max", mode: null, rates: { input: 1e-6, output: 5e-6 }, id: "q", effectiveFrom: EPOCH, effectiveTo: null }]);
    assert.equal(qwen.resolve({ provider: "vercel", model: "alibaba/qwen3-max" })?.match, "inferred");
  });

  it("lets curated prices win and keeps history on the version in force", () => {
    assert.equal(all.resolve({ provider: "exa", model: "search" })?.price.source, "costkey");
    assert.equal(all.price({ provider: "rumik", model: "mulberry", usage: { nativeUnits: { characters: 2000 } } })?.cost, 0.01);
    const versions = new PriceCatalog([
      { ...litellm.find((entry) => entry.sourceKey === "claude-sonnet-5")!, id: "v1", effectiveFrom: EPOCH, effectiveTo: "2026-10-01T00:00:00.000Z" },
      { ...litellm.find((entry) => entry.sourceKey === "claude-sonnet-5")!, id: "v2", rates: { input: 1e-6, output: 5e-6 }, effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveTo: null },
    ]);
    assert.equal(versions.resolve({ provider: "anthropic", model: "claude-sonnet-5", at: "2026-09-15T00:00:00Z" })?.price.id, "v1");
    assert.equal(versions.resolve({ provider: "anthropic", model: "claude-sonnet-5", at: "2026-10-05T00:00:00Z" })?.price.id, "v2");
  });
});

describe("Vercel AI Gateway prices", () => {
  const vercel = normalizeVercelGateway({ data: [
    { id: "typesafe-ai/jev", type: "evaluation", pricing: { input: "0.000000042", output: "0" } },
    { id: "alibaba/qwen3-max-thinking", pricing: {
      input: "0.0000012", output: "0.000006", input_cache_read: "0.00000024", web_search: "10",
      input_tiers: [{ cost: "0.0000012", min: 0, max: 32001 }, { cost: "0.0000024", min: 32001 }],
      output_tiers: [{ cost: "0.000006", min: 0, max: 32001 }, { cost: "0.000012", min: 32001 }],
      service_tiers: { priority: { input: "0.0000024" } },
    } },
    { id: "bfl/flux-kontext-pro", type: "image", pricing: { image: "0.04" } },
    { id: "openai/gpt-video", type: "video", pricing: { video_duration_pricing: [{ cost: "0.1" }] } },
    { id: "broken/model", pricing: { input: "5" } },
  ] });

  it("prices calls through the gateway by its vendor/model id, base rates only", () => {
    assert.deepEqual(vercel.map((entry) => entry.sourceKey), ["typesafe-ai/jev", "alibaba/qwen3-max-thinking", "bfl/flux-kontext-pro"]);
    assert.deepEqual(vercel[0], { source: "vercel", provider: "vercel", model: "typesafe-ai/jev", sourceKey: "typesafe-ai/jev", mode: null, rates: { input: 4.2e-8, output: 0 } });
    assert.deepEqual(vercel[1]!.rates, { input: 1.2e-6, output: 6e-6, cacheRead: 2.4e-7, searchPerQuery: 0.01, longContext: [{ threshold: 32000, input: 2.4e-6, output: 1.2e-5 }] });
    assert.deepEqual(vercel[2]!.rates, { perOutputImage: 0.04 });
  });

  it("prices a Jev call made through Vercel", () => {
    const priced = catalog(vercel).price({ provider: "vercel", model: "typesafe-ai/jev", usage: { inputTokens: 18_600, outputTokens: 1_001 } });
    assert.ok(priced, "a Vercel call to Jev has a price");
    assert.ok(Math.abs(priced.cost - 18_600 * 4.2e-8) < 1e-12);
    assert.equal(priced.source, "vercel");
  });
});
