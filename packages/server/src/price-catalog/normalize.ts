import type { CatalogEntry, MatchKind, PriceRates } from "./types.js";

/**
 * Source provider ids mapped to CostKey's canonical provider ids. Anything not
 * listed is a reseller or gateway CostKey can't observe directly, so it is
 * left out of the catalog rather than risk pricing the wrong vendor.
 */
const LITELLM_PROVIDERS: Record<string, string> = {
  openai: "openai", "text-completion-openai": "openai",
  azure: "azure", azure_ai: "azure", azure_text: "azure",
  anthropic: "anthropic",
  gemini: "google",
  bedrock: "bedrock", bedrock_converse: "bedrock",
  openrouter: "openrouter",
  groq: "groq", together_ai: "together", fireworks_ai: "fireworks", "fireworks_ai-embedding-models": "fireworks",
  mistral: "mistral", codestral: "mistral", "text-completion-codestral": "mistral",
  deepseek: "deepseek", xai: "xai", cohere: "cohere", cohere_chat: "cohere",
  perplexity: "perplexity", cerebras: "cerebras", deepinfra: "deepinfra", sambanova: "sambanova",
  elevenlabs: "elevenlabs", deepgram: "deepgram", assemblyai: "assemblyai", soniox: "soniox",
  exa_ai: "exa", firecrawl: "firecrawl", tavily: "tavily", serper: "serper", linkup: "linkup",
  parallel_ai: "parallel", you_com: "you", typesafe: "typesafe", sarvam: "sarvam",
  voyage: "voyage", jina_ai: "jina", nvidia_nim: "nvidia", novita: "novita", hyperbolic: "hyperbolic",
  nebius: "nebius", dashscope: "alibaba", moonshot: "moonshot", minimax: "minimax", zai: "zai",
  replicate: "replicate", ai21: "ai21", cloudflare: "cloudflare", baseten: "baseten",
  lambda_ai: "lambda", friendliai: "friendli", featherless_ai: "featherless", watsonx: "watsonx",
  databricks: "databricks", snowflake: "snowflake", oci: "oci", stability: "stability", fal_ai: "fal",
  recraft: "recraft", black_forest_labs: "bfl", aws_polly: "polly", transcribe: "aws-transcribe",
};

const MODELS_DEV_PROVIDERS: Record<string, string> = {
  openai: "openai", anthropic: "anthropic", google: "google",
  "google-vertex": "vertex", "google-vertex-anthropic": "vertex",
  "amazon-bedrock": "bedrock", azure: "azure", "azure-cognitive-services": "azure",
  groq: "groq", togetherai: "together", "fireworks-ai": "fireworks", mistral: "mistral",
  deepseek: "deepseek", xai: "xai", cohere: "cohere", perplexity: "perplexity", cerebras: "cerebras",
  deepinfra: "deepinfra", openrouter: "openrouter", sarvam: "sarvam", nvidia: "nvidia",
  "novita-ai": "novita", nebius: "nebius", alibaba: "alibaba", moonshotai: "moonshot",
  minimax: "minimax", zai: "zai", huggingface: "huggingface", "cloudflare-workers-ai": "cloudflare",
  baseten: "baseten", friendli: "friendli", databricks: "databricks", "snowflake-cortex": "snowflake",
  watsonx: "watsonx", oci: "oci", ai21: "ai21", llama: "meta",
};

/** OpenRouter id prefixes that name the first-party vendor. */
const OPENROUTER_VENDORS: Record<string, string> = {
  openai: "openai", anthropic: "anthropic", google: "google", "x-ai": "xai", deepseek: "deepseek",
  mistralai: "mistral", cohere: "cohere", perplexity: "perplexity",
};

const LITELLM_ROUTES = new Set([
  ...Object.keys(LITELLM_PROVIDERS), "vertex_ai", "openai", "anthropic",
]);
const REGION_SEGMENT = /^(us|eu|apac|global|[a-z]{2}(-gov)?-[a-z]+-\d)$/;
const BEDROCK_REGION_PREFIX = /^(us|eu|apac|global|in|jp|au|ca|us-gov)\./;

function rate(value: unknown, scale = 1): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed * scale;
}

function compact(rates: PriceRates): PriceRates {
  const out: PriceRates = {};
  for (const [key, value] of Object.entries(rates) as Array<[keyof PriceRates, unknown]>) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** True when a price is plausible: finite, non-negative, below $1,000 per 1M tokens. */
export function plausibleRates(rates: PriceRates): boolean {
  const tokenRates = [rates.input, rates.output, rates.cacheRead, rates.cacheWrite, rates.cacheWrite1h,
    rates.inputAudio, rates.outputAudio, rates.inputImage, rates.outputImage];
  if (tokenRates.some((value) => value !== undefined && value > 0.001)) return false;
  const unitRates = [rates.perCharacter, rates.perSecond, rates.perQuery, rates.perRequest, rates.perPage,
    rates.perCredit, rates.searchPerQuery, rates.mapsPerQuery, rates.perExtraResult, rates.perInputImage, rates.perOutputImage];
  if (unitRates.some((value) => value !== undefined && value > 100)) return false;
  return Object.keys(rates).length > 0;
}

/** Lowercase, drop `models/` and Bedrock ARN wrappers. */
export function normalizeModelId(raw: string): string {
  let model = raw.trim().toLowerCase();
  try { model = decodeURIComponent(model); } catch { /* keep as is */ }
  model = model.replace(/^models\//, "");
  const arn = model.match(/^arn:aws[^:]*:bedrock:[^:]*:[^:]*:(?:inference-profile|foundation-model|application-inference-profile|provisioned-model)\/(.+)$/);
  if (arn?.[1]) model = arn[1];
  return model;
}

/** Drop version/date suffixes: `-2026-09-22`, `-20250514`, `@20251001`, `-v1:0`, `:0`. */
export function stripModelVersion(model: string): string {
  let current = model;
  for (;;) {
    const next = current
      .replace(/@(\d{8}|default|latest)$/, "")
      .replace(/-v\d+(:\d+)?$/, "")
      .replace(/:\d+$/, "")
      .replace(/-\d{4}-\d{2}-\d{2}$/, "")
      .replace(/-\d{8}$/, "");
    if (next === current) return current;
    current = next;
  }
}

/**
 * The model names to try for one call, most specific first. A fine-tuned
 * OpenAI model is tried as its `ft:` base before falling back to the base.
 */
export function modelCandidates(raw: string): Array<{ model: string; match: MatchKind }> {
  const out: Array<{ model: string; match: MatchKind }> = [];
  const seen = new Set<string>();
  const add = (model: string, match: MatchKind) => {
    if (!model || seen.has(model)) return;
    seen.add(model);
    out.push({ model, match });
  };
  const exact = raw.trim().toLowerCase();
  add(exact, "exact");
  const normalized = normalizeModelId(raw);
  add(normalized, "normalized");
  const fineTune = normalized.match(/^ft:([^:]+)/);
  if (fineTune?.[1]) add(`ft:${fineTune[1]}`, "normalized");
  const undated = stripModelVersion(fineTune?.[1] ?? normalized);
  add(undated, "undated");
  const regionless = normalized.replace(BEDROCK_REGION_PREFIX, "");
  add(regionless, "undated");
  add(stripModelVersion(regionless), "undated");
  return out;
}

/** Strip a source's own routing prefixes from a key. Returns null for region-specific keys. */
function litellmModel(key: string): string | null {
  const parts = key.split("/");
  while (parts.length > 1 && LITELLM_ROUTES.has(parts[0]!)) parts.shift();
  // `azure/us/gpt-5.4`, `bedrock/us-east-1/...`: regional surcharges CostKey
  // can't attribute from a call, so only the global rate is used.
  if (parts.length > 1 && REGION_SEGMENT.test(parts[0]!)) return null;
  return normalizeModelId(parts.join("/"));
}

function litellmRates(value: Record<string, unknown>): PriceRates {
  const longContext = new Map<number, NonNullable<PriceRates["longContext"]>[number]>();
  for (const [key, raw] of Object.entries(value)) {
    const match = key.match(/^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens$/);
    if (!match) continue;
    const threshold = Number(match[2]) * 1000;
    const tier = longContext.get(threshold) ?? { threshold };
    const field = ({ input_cost_per_token: "input", output_cost_per_token: "output", cache_read_input_token_cost: "cacheRead", cache_creation_input_token_cost: "cacheWrite" } as const)[match[1] as "input_cost_per_token"];
    const parsed = rate(raw);
    if (parsed !== undefined) tier[field] = parsed;
    longContext.set(threshold, tier);
  }
  const search = value["search_context_cost_per_query"];
  const searchRate = search && typeof search === "object"
    ? rate((search as Record<string, unknown>)["search_context_size_medium"] ?? (search as Record<string, unknown>)["search_context_size_low"])
    : rate(search);
  const tiers = Array.isArray(value["tiered_pricing"]) ? value["tiered_pricing"] as Array<Record<string, unknown>> : [];
  const queryTiers = tiers
    .map((tier) => {
      const range = Array.isArray(tier["max_results_range"]) ? tier["max_results_range"] as unknown[] : [];
      const maxResults = rate(range[1]);
      const perQuery = rate(tier["input_cost_per_query"]);
      return maxResults === undefined || perQuery === undefined ? null : { maxResults, perQuery };
    })
    .filter((tier): tier is { maxResults: number; perQuery: number } => tier !== null)
    .sort((a, b) => a.maxResults - b.maxResults);
  return compact({
    input: rate(value["input_cost_per_token"]),
    output: rate(value["output_cost_per_token"]),
    cacheRead: rate(value["cache_read_input_token_cost"]),
    cacheWrite: rate(value["cache_creation_input_token_cost"]),
    cacheWrite1h: rate(value["cache_creation_input_token_cost_above_1hr"]),
    reasoning: rate(value["output_cost_per_reasoning_token"]),
    inputAudio: rate(value["input_cost_per_audio_token"]),
    outputAudio: rate(value["output_cost_per_audio_token"]),
    inputImage: rate(value["input_cost_per_image_token"]),
    outputImage: rate(value["output_cost_per_image_token"]),
    perInputImage: rate(value["input_cost_per_image"]),
    perOutputImage: rate(value["output_cost_per_image"]),
    perCharacter: rate(value["input_cost_per_character"]),
    perSecond: rate(value["input_cost_per_second"]),
    perQuery: rate(value["input_cost_per_query"]) ?? queryTiers[0]?.perQuery,
    perPage: rate(value["ocr_cost_per_page"]),
    searchPerQuery: searchRate,
    mapsPerQuery: rate(value["google_maps_grounding_cost_per_query"]),
    searchBilling: searchRate === undefined ? undefined : value["web_search_billing_unit"] === "per_query" ? "query" : "request",
    longContext: [...longContext.values()].filter((tier) => tier.input !== undefined || tier.output !== undefined).sort((a, b) => a.threshold - b.threshold),
    queryTiers,
  });
}

export function normalizeLiteLlm(json: unknown): CatalogEntry[] {
  if (!json || typeof json !== "object") return [];
  const out: CatalogEntry[] = [];
  for (const [key, raw] of Object.entries(json as Record<string, unknown>)) {
    if (key === "sample_spec" || !raw || typeof raw !== "object") continue;
    const value = raw as Record<string, unknown>;
    const sourceProvider = String(value["litellm_provider"] ?? "");
    const provider = sourceProvider.startsWith("vertex_ai") ? "vertex" : LITELLM_PROVIDERS[sourceProvider];
    if (!provider) continue;
    const model = litellmModel(key);
    if (!model) continue;
    const rates = litellmRates(value);
    if (!plausibleRates(rates)) continue;
    out.push({ source: "litellm", provider, model, sourceKey: key, mode: typeof value["mode"] === "string" ? value["mode"] : null, rates });
  }
  return out;
}

function perMillion(value: unknown): number | undefined {
  return rate(value, 1 / 1_000_000);
}

export function normalizeModelsDev(json: unknown): CatalogEntry[] {
  if (!json || typeof json !== "object") return [];
  const out: CatalogEntry[] = [];
  for (const [sourceProvider, rawProvider] of Object.entries(json as Record<string, unknown>)) {
    const provider = MODELS_DEV_PROVIDERS[sourceProvider];
    if (!provider || !rawProvider || typeof rawProvider !== "object") continue;
    const models = (rawProvider as Record<string, unknown>)["models"];
    if (!models || typeof models !== "object") continue;
    for (const [key, rawModel] of Object.entries(models as Record<string, unknown>)) {
      const cost = rawModel && typeof rawModel === "object" ? (rawModel as Record<string, unknown>)["cost"] as Record<string, unknown> | undefined : undefined;
      if (!cost) continue;
      const tiers = Array.isArray(cost["tiers"]) ? cost["tiers"] as Array<Record<string, unknown>> : [];
      const longContext = tiers
        .map((tier) => {
          const spec = tier["tier"] as Record<string, unknown> | undefined;
          const threshold = spec?.["type"] === "context" ? rate(spec["size"]) : undefined;
          if (threshold === undefined) return null;
          return { threshold, ...compact({ input: perMillion(tier["input"]), output: perMillion(tier["output"]), cacheRead: perMillion(tier["cache_read"]), cacheWrite: perMillion(tier["cache_write"]) }) };
        })
        .filter((tier): tier is NonNullable<typeof tier> => tier !== null);
      const over200k = cost["context_over_200k"] as Record<string, unknown> | undefined;
      if (longContext.length === 0 && over200k) {
        longContext.push({ threshold: 200_000, ...compact({ input: perMillion(over200k["input"]), output: perMillion(over200k["output"]), cacheRead: perMillion(over200k["cache_read"]), cacheWrite: perMillion(over200k["cache_write"]) }) });
      }
      const rates = compact({
        input: perMillion(cost["input"]),
        output: perMillion(cost["output"]),
        cacheRead: perMillion(cost["cache_read"]),
        cacheWrite: perMillion(cost["cache_write"]),
        reasoning: perMillion(cost["reasoning"]),
        inputAudio: perMillion(cost["input_audio"]),
        outputAudio: perMillion(cost["output_audio"]),
        longContext: longContext.sort((a, b) => a.threshold - b.threshold),
      });
      if (!plausibleRates(rates)) continue;
      out.push({ source: "models_dev", provider, model: normalizeModelId(key), sourceKey: `${sourceProvider}/${key}`, mode: null, rates });
    }
  }
  return out;
}

export function normalizeOpenRouter(json: unknown): CatalogEntry[] {
  const data = json && typeof json === "object" ? (json as Record<string, unknown>)["data"] : null;
  if (!Array.isArray(data)) return [];
  const out: CatalogEntry[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const id = String((raw as Record<string, unknown>)["id"] ?? "");
    const pricing = (raw as Record<string, unknown>)["pricing"] as Record<string, unknown> | undefined;
    if (!id || !pricing) continue;
    // Router pseudo-models publish -1 for "depends on the routed model".
    if (Number(pricing["prompt"]) < 0 || Number(pricing["completion"]) < 0) continue;
    const overrides = Array.isArray(pricing["overrides"]) ? pricing["overrides"] as Array<Record<string, unknown>> : [];
    const rates = compact({
      input: rate(pricing["prompt"]),
      output: rate(pricing["completion"]),
      cacheRead: rate(pricing["input_cache_read"]),
      cacheWrite: rate(pricing["input_cache_write"]),
      cacheWrite1h: rate(pricing["input_cache_write_1h"]),
      inputAudio: rate(pricing["audio"]),
      outputAudio: rate(pricing["audio_output"]),
      outputImage: rate(pricing["image_output"]),
      perRequest: rate(pricing["request"]) || undefined,
      searchPerQuery: rate(pricing["web_search"]),
      longContext: overrides
        .map((override) => {
          const threshold = rate(override["min_prompt_tokens"]);
          if (threshold === undefined) return null;
          return { threshold, ...compact({ input: rate(override["prompt"]), output: rate(override["completion"]), cacheRead: rate(override["input_cache_read"]), cacheWrite: rate(override["input_cache_write"]) }) };
        })
        .filter((tier): tier is NonNullable<typeof tier> => tier !== null)
        .sort((a, b) => a.threshold - b.threshold),
    });
    if (!plausibleRates(rates)) continue;
    out.push({ source: "openrouter", provider: "openrouter", model: normalizeModelId(id), sourceKey: id, mode: null, rates });
    // The same price is the vendor's list price; keep it as the last fallback
    // for direct calls when the other sources don't list the model yet.
    const [vendor, ...rest] = id.split("/");
    const firstParty = vendor ? OPENROUTER_VENDORS[vendor] : undefined;
    if (firstParty && rest.length > 0 && !id.includes(":")) {
      out.push({ source: "openrouter", provider: firstParty, model: normalizeModelId(rest.join("/")), sourceKey: id, mode: null, rates });
    }
  }
  return out;
}
