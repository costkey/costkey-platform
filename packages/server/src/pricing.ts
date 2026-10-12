/**
 * Server-side pricing fallback: cost per 1M tokens in USD.
 * Provider-reported totals are preferred when a router supplies them; this
 * table covers direct APIs and historical events without a reported total.
 * Selected entries refreshed from provider pricing pages in 2026-09;
 * legacy entries remain estimates. These are standard API rates;
 * batch, priority, long-context, and provider-reseller rates may differ.
 */
import { filterFrames, findBusinessLogicFrame, findBusinessLogicFrameWithGraph, getFilterContext, callGraphCache } from "./ingest.js";
interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  imageOutput?: number;
  /** DeepSeek direct rates vary by UTC peak/off-peak schedule. */
  peak?: Pick<ModelPricing, "input" | "output" | "cacheRead">;
  offPeak?: Pick<ModelPricing, "input" | "output" | "cacheRead">;
}

/**
 * Pricing keyed by model family pattern.
 * Matching is fuzzy: "claude-sonnet-4-5-20250514" matches "claude-sonnet-4"
 * because the model string contains the key.
 *
 * Order matters — more specific patterns must come first so they match
 * before less specific ones (e.g. "gpt-4o-mini" before "gpt-4o").
 */
const PRICING: [string, ModelPricing][] = [
  // OpenAI — specific first
  // https://openai.com/index/introducing-gpt-4-1/
  ["gpt-4.1-nano", { input: 0.1, output: 0.4, cacheRead: 0.025 }],
  ["gpt-4.1-mini", { input: 0.4, output: 1.6, cacheRead: 0.1 }],
  ["gpt-4.1", { input: 2, output: 8, cacheRead: 0.5 }],
  // https://developers.openai.com/api/docs/models/text-embedding-3-small
  ["text-embedding-3-large", { input: 0.13, output: 0 }],
  ["text-embedding-3-small", { input: 0.02, output: 0 }],
  ["text-embedding-ada-002", { input: 0.1, output: 0 }],
  // OpenRouter's catalogue exposes image_output separately from text output.
  // https://openrouter.ai/docs/api/api-reference/models/get-models
  ["gpt-5.4-image-2", { input: 8, output: 15, imageOutput: 30 }],
  ["gpt-5-image", { input: 10, output: 10, imageOutput: 40 }],
  ["gpt-4o-mini", { input: 0.15, output: 0.6, cacheRead: 0.075 }],
  ["gpt-4o", { input: 2.5, output: 10, cacheRead: 1.25 }],
  ["gpt-4-turbo", { input: 10, output: 30 }],
  ["gpt-4", { input: 30, output: 60 }],
  ["gpt-3.5-turbo", { input: 0.5, output: 1.5 }],
  ["o1-mini", { input: 1.1, output: 4.4, cacheRead: 0.55 }],
  ["o1-pro", { input: 150, output: 600 }],
  ["o1", { input: 15, output: 60, cacheRead: 7.5 }],
  ["o3-mini", { input: 1.1, output: 4.4, cacheRead: 0.55 }],
  ["o3", { input: 2, output: 8, cacheRead: 0.5 }],
  ["o4-mini", { input: 1.1, output: 4.4, cacheRead: 0.275 }],

  // Anthropic — match family name regardless of version suffix
  // https://www-cdn.anthropic.com/files/4zrzovbb/website/3684c2faafb97418665782cea0001f439f74b1d2.pdf
  ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-opus-4.8", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-opus-4-8", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-opus-4.7", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-opus-4-7", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-opus-4.6", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-opus-4-6", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-opus-4.5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-opus-4-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  ["claude-sonnet-4.6", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["claude-sonnet-4-6", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["claude-sonnet-4.5", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["claude-sonnet-4-5", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["claude-haiku-4.5", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ["claude-opus-4", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ["claude-sonnet-4", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["claude-haiku-4", { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  ["claude-haiku-3-5", { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  // Claude Haiku 3 is materially cheaper than Haiku 3.5.
  ["claude-haiku-3", { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 }],
  ["claude-3-5-sonnet", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["claude-3-5-haiku", { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  ["claude-3-opus", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ["claude-3-sonnet", { input: 3, output: 15 }],
  ["claude-3-haiku", { input: 0.25, output: 1.25 }],

  // Google Gemini
  // https://ai.google.dev/gemini-api/docs/pricing
  ["gemini-3.1-flash-lite-image", { input: 0.25, output: 1.5, imageOutput: 30 }],
  ["gemini-3.1-flash-image", { input: 0.5, output: 3, imageOutput: 60 }],
  ["gemini-2.5-flash-image", { input: 0.3, output: 2.5, imageOutput: 30 }],
  ["gemini-3-pro-image-preview", { input: 2, output: 12, imageOutput: 120 }],
  ["gemini-3-pro-image", { input: 2, output: 12, imageOutput: 120 }],
  // OpenRouter's live catalogue can differ from the direct API rate card;
  // keep namespaced fallbacks ahead of unqualified direct-model entries.
  // https://openrouter.ai/api/v1/models
  // Gemini 3.6/3.7/3.8 promotional standard rates run through 2026-12-31.
  ["google/gemini-2.5-pro", { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0.375 }],
  ["google/gemini-2.5-flash-lite", { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.0833333333 }],
  ["google/gemini-2.5-flash", { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.0833333333 }],
  ["google/gemini-3.8-flash", { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.0416666667 }],
  ["google/gemini-3.7-flash", { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.0416666667 }],
  ["google/gemini-3.6-flash", { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.0416666667 }],
  ["google/gemini-3.1-pro-preview", { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0.375 }],
  ["google/gemini-3.5-flash-lite", { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.0833333333 }],
  ["gemini-3-flash-preview", { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.0833333333 }],
  ["gemini-3.8-flash", { input: 0.75, output: 3.75, cacheRead: 0.075 }],
  ["gemini-3.7-flash", { input: 0.75, output: 3.75, cacheRead: 0.075 }],
  ["gemini-3.6-flash", { input: 0.75, output: 3.75, cacheRead: 0.075 }],
  ["gemini-3.1-pro-preview", { input: 2, output: 12, cacheRead: 0.2 }],
  ["gemini-3.1-flash-lite", { input: 0.25, output: 1.5, cacheRead: 0.025 }],
  ["gemini-3.5-flash-lite", { input: 0.3, output: 2.5, cacheRead: 0.03 }],
  ["gemini-3.5-flash", { input: 1.5, output: 9, cacheRead: 0.15 }],
  ["gemini-2.5-pro", { input: 1.25, output: 10 }],
  ["gemini-2.5-flash-lite", { input: 0.1, output: 0.4, cacheRead: 0.01 }],
  ["gemini-2.5-flash", { input: 0.3, output: 2.5, cacheRead: 0.03 }],
  ["gemini-2.0-flash-lite", { input: 0.02, output: 0.1 }],
  ["gemini-2.0-flash", { input: 0.1, output: 0.4 }],
  ["gemini-1.5-pro", { input: 1.25, output: 5 }],
  ["gemini-1.5-flash", { input: 0.075, output: 0.3 }],

  // xAI (Grok)
  // https://docs.x.ai/developers/models
  ["grok-4.6", { input: 2, output: 6, cacheRead: 0.5 }],
  ["grok-4.5", { input: 2, output: 6, cacheRead: 0.3 }],
  ["grok-4.3", { input: 1.25, output: 2.5, cacheRead: 0.2 }],
  // xAI retired grok-3 and redirects it to grok-4.3.
  ["grok-3", { input: 1.25, output: 2.5, cacheRead: 0.2 }],
  ["grok-4", { input: 1.25, output: 2.5, cacheRead: 0.2 }],

  // Llama variants (Groq, Together, Fireworks, etc.)
  ["llama-3.3-70b", { input: 0.59, output: 0.79 }],
  ["llama-v3p3-70b", { input: 0.59, output: 0.79 }],
  ["llama-3.1-405b", { input: 3.5, output: 3.5 }],
  ["llama-v3p1-405b", { input: 3.5, output: 3.5 }],
  ["llama-3.1-70b", { input: 0.88, output: 0.88 }],
  ["llama-v3p1-70b", { input: 0.88, output: 0.88 }],
  ["llama-3.1-8b", { input: 0.05, output: 0.08 }],
  ["llama-v3p1-8b", { input: 0.05, output: 0.08 }],
  ["llama-3-70b", { input: 0.59, output: 0.79 }],
  ["llama-3-8b", { input: 0.05, output: 0.08 }],
  ["mixtral-8x7b", { input: 0.24, output: 0.24 }],
  ["gemma2-9b", { input: 0.2, output: 0.2 }],

  // Mistral
  ["mistral-large", { input: 2, output: 6 }],
  ["mistral-medium", { input: 2.7, output: 8.1 }],
  ["mistral-small", { input: 0.2, output: 0.6 }],
  ["codestral", { input: 0.3, output: 0.9 }],
  ["open-mistral-nemo", { input: 0.15, output: 0.15 }],

  // DeepSeek
  // https://api-docs.deepseek.com/quick_start/pricing
  ["deepseek/deepseek-v4-flash", { input: 0.08078, output: 0.16156, cacheRead: 0.016156 }],
  ["deepseek/deepseek-v4-pro", { input: 0.687648, output: 1.375296, cacheRead: 0.057304 }],
  ["deepseek-v4-flash", {
    input: 0.44, output: 1.32, cacheRead: 0.014,
    peak: { input: 0.44, output: 1.32, cacheRead: 0.014 },
    offPeak: { input: 0.22, output: 0.66, cacheRead: 0.007 },
  }],
  ["deepseek-v4-pro", {
    input: 1.32, output: 3.96, cacheRead: 0.044,
    peak: { input: 1.32, output: 3.96, cacheRead: 0.044 },
    offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022 },
  }],
  ["deepseek-reasoner", { input: 0.55, output: 2.19, cacheRead: 0.055 }],
  ["deepseek-chat", { input: 0.14, output: 0.28, cacheRead: 0.014 }],

  // Cohere
  ["command-r-plus", { input: 2.5, output: 10 }],
  ["command-r", { input: 0.15, output: 0.6 }],
  ["command-a", { input: 2.5, output: 10 }],

  // Together AI
  ["Meta-Llama-3.1-405B", { input: 3.5, output: 3.5 }],
  ["Meta-Llama-3.1-70B", { input: 0.88, output: 0.88 }],
  ["Meta-Llama-3.1-8B", { input: 0.18, output: 0.18 }],

  // Perplexity
  ["sonar-pro", { input: 3, output: 15 }],
  ["sonar", { input: 1, output: 1 }],
];

/**
 * Fixed image-token units documented by Google for legacy image responses.
 * Only these exact values are safe to infer when an old SDK recorded the
 * aggregate completion token count but lost completion_tokens_details.
 *
 * Sources:
 * - https://ai.google.dev/gemini-api/docs/pricing
 * - https://ai.google.dev/gemini-api/docs/image-generation
 */
const LEGACY_IMAGE_TOKEN_UNITS: Array<{ pattern: string; tokens: readonly number[] }> = [
  { pattern: "gemini-3.1-flash-image", tokens: [747, 1120, 1680, 2520] },
  { pattern: "gemini-2.5-flash-image", tokens: [1290] },
];

/**
 * Recover an image-only output token count from old telemetry when the value
 * is one of the provider's fixed image units. Mixed text/image completions
 * deliberately return null rather than silently overcharging them.
 */
export function inferImageOutputTokens(model: string | null, outputTokens: number | null): number | null {
  if (!model || outputTokens == null || !Number.isInteger(outputTokens) || outputTokens <= 0) return null;
  const lower = model.toLowerCase();
  const match = LEGACY_IMAGE_TOKEN_UNITS.find((entry) => lower.includes(entry.pattern));
  return match?.tokens.includes(outputTokens) ? outputTokens : null;
}

/**
 * Compute the estimated cost in USD for a given model + usage.
 * Returns null if the model is unknown.
 */
export function computeCost(
  model: string | null,
  inputTokens: number | null,
  outputTokens: number | null,
  cacheReadTokens?: number | null,
  cacheCreationTokens?: number | null,
  provider?: string | null,
  timestamp?: string | null,
  imageOutputTokens?: number | null,
  /** The part of cacheCreationTokens written with Anthropic's 1-hour TTL (billed at 2x input). */
  cacheCreation1hTokens?: number | null,
): number | null {
  if (!model) return null;
  for (const tokens of [inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, imageOutputTokens]) {
    if (tokens != null && (!Number.isFinite(tokens) || tokens < 0)) return null;
  }
  if (inputTokens == null && outputTokens == null) return null;

  const pricing = findPricing(model);
  if (!pricing) return null;
  // Mixed text/image output cannot be priced without a modality breakdown.
  if (pricing.imageOutput != null && imageOutputTokens == null) return null;
  if (imageOutputTokens != null && (outputTokens == null || imageOutputTokens > outputTokens)) return null;

  let effectivePricing = selectPricing(pricing, model, provider, timestamp);
  const lowerModel = model.toLowerCase();
  if (inputTokens != null && inputTokens > 200_000) {
    if (lowerModel.includes("gemini-2.5-pro")) {
      effectivePricing = { ...effectivePricing, input: 2.5, output: 15, cacheRead: 0.25 };
    } else if (lowerModel.includes("gemini-3.1-pro-preview")) {
      effectivePricing = { ...effectivePricing, input: 4, output: 18, cacheRead: 0.4 };
    } else if (/grok-4[.][356]/.test(lowerModel)) {
      effectivePricing = { ...effectivePricing, input: pricing.input * 2,
        output: pricing.output * 2, cacheRead: (pricing.cacheRead ?? 0) * 2 };
    }
  }
  const isDeepSeekDirect = isDeepSeekDirectCall(model, provider);
  let cost = 0;

  if (inputTokens != null) {
    const includedCacheTokens = tableCacheIncludedInInput(model, provider) && !isDeepSeekDirect
      ? (effectivePricing.cacheRead != null ? (cacheReadTokens ?? 0) : 0)
        + (provider === "openrouter" && effectivePricing.cacheWrite != null ? (cacheCreationTokens ?? 0) : 0)
      : isDeepSeekDirect
        ? (effectivePricing.cacheRead != null ? (cacheReadTokens ?? 0) : 0)
      : 0;
    const billableInputTokens = Math.max(0, inputTokens - includedCacheTokens);
    cost += (billableInputTokens / 1_000_000) * effectivePricing.input;
  }
  if (outputTokens != null) {
    cost += ((outputTokens - (imageOutputTokens ?? 0)) / 1_000_000) * effectivePricing.output;
    cost += ((imageOutputTokens ?? 0) / 1_000_000) * (effectivePricing.imageOutput ?? effectivePricing.output);
  }
  if (cacheReadTokens != null && effectivePricing.cacheRead != null) {
    cost += (cacheReadTokens / 1_000_000) * effectivePricing.cacheRead;
  }
  if (cacheCreationTokens != null && effectivePricing.cacheWrite != null && !isDeepSeekDirect) {
    const oneHour = Math.min(Math.max(cacheCreation1hTokens ?? 0, 0), cacheCreationTokens);
    cost += ((cacheCreationTokens - oneHour) / 1_000_000) * effectivePricing.cacheWrite;
    // Anthropic's 1-hour cache writes cost twice the base input rate.
    cost += (oneHour / 1_000_000) * effectivePricing.input * 2;
  }

  return Math.round(cost * 1_000_000_000_000) / 1_000_000_000_000;
}

/**
 * DeepSeek's direct API: prompt_tokens includes cache hits (billed at the
 * cache-hit rate) and misses (ordinary input). SDK 0.6 reported the misses
 * as cache creation; they are never a separate charge.
 */
function isDeepSeekDirectCall(model: string, provider?: string | null): boolean {
  const lowerModel = model.toLowerCase();
  return provider === "deepseek"
    || (!provider && !lowerModel.includes("/") && lowerModel.includes("deepseek-v4"));
}

/**
 * Whether the built-in table treats a call's input count as already holding
 * its cache reads. Google reports promptTokenCount as the full prompt, with
 * cached content included as a separately-priced subset; OpenAI, OpenRouter
 * and DeepSeek's direct API do the same. Anthropic's input_tokens excludes
 * cache reads.
 */
export function tableCacheIncludedInInput(model: string, provider?: string | null): boolean {
  return provider === "google"
    || provider === "openai"
    || provider === "openrouter"
    || model.toLowerCase().includes("gemini")
    || isDeepSeekDirectCall(model, provider);
}

export function findPricing(model: string): ModelPricing | null {
  const lower = model.toLowerCase();
  if (/:(free|batch|extended|nitro|floor)\b/.test(lower)) return null;
  for (const [pattern, pricing] of PRICING) {
    const offset = lower.indexOf(pattern.toLowerCase());
    if (offset < 0) continue;
    const before = lower.slice(0, offset);
    const suffix = lower.slice(offset + pattern.length);
    if (before && !/[/:.]$/.test(before)) continue;
    // Accept known snapshot/hosting suffixes, not arbitrary new model variants.
    if (suffix && !/^(:|-(?:[0-9]{4}|latest|instruct|0-))/.test(suffix)) continue;
    return pricing;
  }
  return null;
}

function selectPricing(
  pricing: ModelPricing,
  model: string,
  provider?: string | null,
  timestamp?: string | null,
): ModelPricing {
  if (!pricing.peak || !pricing.offPeak) return pricing;
  if (provider !== "deepseek" && !(provider == null && !model.includes("/") && model.toLowerCase().includes("deepseek"))) {
    return pricing;
  }

  const instant = timestamp ? new Date(timestamp) : null;
  if (!instant || Number.isNaN(instant.getTime())) return pricing;

  const day = instant.getUTCDay();
  const hour = instant.getUTCHours() + instant.getUTCMinutes() / 60;
  const isWeekday = day >= 1 && day <= 5;
  const isPeakWindow = (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
  return { ...pricing, ...(isWeekday && isPeakWindow ? pricing.peak : pricing.offPeak) };
}

/**
 * Backfill costs for events that have tokens but no cost.
 * Runs exactly once using the migrations table.
 */
export async function backfillCosts(pool: import("pg").Pool): Promise<void> {
  const { runOnce } = await import("./db.js");

  // Older SDKs captured OpenRouter's numeric usage.cost in response_body but
  // did not copy it into cost_usd. Repair every historical event, not only a
  // recent date window, so the dashboard warning reflects real unknowns.
  await runOnce(pool, "backfill_openrouter_reported_costs_v2", async () => {
    const result = await pool.query(
      `SELECT id, project_id, model, cost_usd, bl_function, bl_file, bl_line,
              response_body->'usage'->>'cost' AS reported_cost
       FROM events
       WHERE provider = 'openrouter'
         AND cost_usd IS NULL
         AND jsonb_typeof(response_body->'usage'->'cost') = 'number'`,
    );

    const changes: Array<{
      id: string; projectId: string; model: string | null;
        oldCost: number | null; newCost: number;
        blFunction: string | null; blFile: string | null; blLine: number | null;
        basis: "reported" | "estimated"; source: string;
    }> = [];
    for (const row of result.rows) {
      if (row.reported_cost == null || row.reported_cost === "") continue;
      const reported = Number(row.reported_cost);
      if (!Number.isFinite(reported) || reported < 0) continue;
      changes.push({
        id: row.id, projectId: row.project_id, model: row.model,
        oldCost: row.cost_usd, newCost: reported,
        blFunction: row.bl_function, blFile: row.bl_file, blLine: row.bl_line,
        basis: "reported", source: "provider",
      });
    }
    await applyCostChanges(pool, changes);
    console.log(`[costkey] Repaired ${changes.length} historical OpenRouter reported costs`);
  });

  // A few old OpenRouter image responses exposed only the aggregate
  // completion count. Price the rows whose count exactly matches Google's
  // fixed image units; leave mixed/unknown rows unpriced until the SDK sends
  // completion_tokens_details.image_tokens or the router supplies usage.cost.
  await runOnce(pool, "backfill_openrouter_image_costs_v2", async () => {
    const result = await pool.query(
      `SELECT id, project_id, model, timestamp, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, cost_usd,
              bl_function, bl_file, bl_line
       FROM events
       WHERE provider = 'openrouter'
         AND cost_usd IS NULL
         AND model IS NOT NULL
         AND output_tokens IS NOT NULL`,
    );
    const changes: Array<{
      id: string; projectId: string; model: string | null;
        oldCost: number | null; newCost: number;
        blFunction: string | null; blFile: string | null; blLine: number | null;
        basis: "reported" | "estimated"; source: string;
    }> = [];
    for (const row of result.rows) {
      const imageOutputTokens = inferImageOutputTokens(row.model, row.output_tokens);
      if (imageOutputTokens == null) continue;
      const cost = computeCost(
        row.model, row.input_tokens, row.output_tokens,
        row.cache_read_tokens, row.cache_creation_tokens,
        "openrouter", row.timestamp, imageOutputTokens,
      );
      if (cost == null || !Number.isFinite(cost) || cost < 0) continue;
      changes.push({
        id: row.id, projectId: row.project_id, model: row.model,
        oldCost: row.cost_usd, newCost: cost,
        blFunction: row.bl_function, blFile: row.bl_file, blLine: row.bl_line,
        basis: "estimated", source: "pricing_table",
      });
    }
    await applyCostChanges(pool, changes);
    console.log(`[costkey] Repaired ${changes.length} exact legacy OpenRouter image costs`);
  });

  await runOnce(pool, "backfill_costs_v1", async () => {
    const result = await pool.query(
        `SELECT id, project_id, provider, model, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
         FROM events
         WHERE (cost_usd IS NULL OR cost_usd = 0)
           AND model IS NOT NULL
           AND (input_tokens > 0 OR output_tokens > 0)`,
      );

      if (result.rows.length === 0) {
        console.log("[costkey] No events need cost backfill");
        return;
      }

      console.log(`[costkey] Backfilling costs for ${result.rows.length} events...`);

      let updated = 0;
      for (const row of result.rows) {
        const cost = computeCost(
          row.model,
          row.input_tokens,
          row.output_tokens,
          row.cache_read_tokens,
          row.cache_creation_tokens,
          row.provider,
          row.timestamp,
        );
        if (cost != null && cost > 0) {
          await pool.query(
            "UPDATE events SET cost_usd = $1, cost_basis = 'estimated', cost_source = 'pricing_table' WHERE project_id = $2 AND id = $3",
            [cost, row.project_id, row.id],
          );
          updated++;
        }
      }

      // Also update call_site_stats
      if (updated > 0) {
        await pool.query(`
          UPDATE call_site_stats SET total_cost_usd = sub.total_cost FROM (
            SELECT
              project_id,
              CONCAT(
                COALESCE((call_site_frames->0->>'fileName'), 'unknown'), ':',
                COALESCE((call_site_frames->0->>'functionName'), 'anonymous'), ':',
                COALESCE((call_site_frames->0->>'lineNumber')::text, '0')
              ) as cs_key,
              model,
              COALESCE(SUM(cost_usd), 0) as total_cost
            FROM events
            WHERE call_site_frames IS NOT NULL
            GROUP BY project_id, cs_key, model
          ) sub
          WHERE call_site_stats.project_id = sub.project_id
            AND call_site_stats.call_site_key = sub.cs_key
            AND call_site_stats.model = sub.model
        `);
      }

    console.log(`[costkey] Backfilled costs for ${updated} events`);
  });


  // Also clean up stack frames for existing events (also runs once)
  await backfillFrames(pool);
}

type CostBackfillChange = {
  id: string;
  projectId: string;
  model: string | null;
  oldCost: number | null;
  newCost: number;
  blFunction: string | null;
  blFile: string | null;
  blLine: number | null;
  basis?: "reported" | "estimated";
  source?: string;
};

async function applyCostChanges(pool: import("pg").Pool, changes: CostBackfillChange[]): Promise<void> {
  if (changes.length === 0) return;

  const deltas = new Map<string, { projectId: string; model: string; callSiteKey: string; delta: number }>();
  for (const row of changes) {
    await pool.query(
      "UPDATE events SET cost_usd = $1, cost_basis = COALESCE($4, cost_basis), cost_source = COALESCE($5, cost_source) WHERE project_id = $2 AND id = $3",
      [row.newCost, row.projectId, row.id, row.basis ?? "estimated", row.source ?? "pricing_table"],
    );
    if (!row.blFunction) continue;
    const model = row.model ?? "unknown";
    const callSiteKey = `${row.blFile ?? "unknown"}:${row.blFunction}:${row.blLine ?? 0}`;
    const key = `${row.projectId}\u0000${callSiteKey}\u0000${model}`;
    const current = deltas.get(key);
    const delta = row.newCost - (row.oldCost ?? 0);
    if (current) current.delta += delta;
    else deltas.set(key, { projectId: row.projectId, model, callSiteKey, delta });
  }

  for (const entry of deltas.values()) {
    await pool.query(
      `UPDATE call_site_stats
       SET total_cost_usd = total_cost_usd + $1
       WHERE project_id = $2 AND call_site_key = $3 AND model = $4`,
      [entry.delta, entry.projectId, entry.callSiteKey, entry.model],
    );
  }
}

const INTERNAL_FILE_PATTERNS = [
  "site-packages/anthropic/", "site-packages/openai/",
  "site-packages/google/", "site-packages/cohere/",
  "site-packages/mistralai/", "site-packages/groq/",
  "site-packages/together/", "site-packages/deepseek/",
  "site-packages/httpx/", "site-packages/httpcore/",
  "site-packages/requests/", "site-packages/urllib3/", "site-packages/aiohttp/",
  "/lib/python", "threading.py", "asyncio/", "concurrent/futures/",
  "_bootstrap", "importlib",
  "node_modules/openai/", "node_modules/@anthropic-ai/",
  "node_modules/@google/generative-ai/", "node_modules/@google/genai/", "node_modules/cohere-ai/",
  "node_modules/undici/", "node_modules/node-fetch/",
  "node:internal/", "node:async_hooks",
  "node_modules/next/", "node_modules/express/", "node_modules/fastify/",
  "node_modules/hono/", "node_modules/koa/", "node_modules/@vercel/",
  "node_modules/@opentelemetry/",
  "costkey/packages/sdk/", "node_modules/costkey/", "site-packages/costkey/",
];

const INTERNAL_FN_PATTERNS = [
  "self._client.send", "self._post", "self._request", "self.__request",
  "_base_client", "self._client._request", "_legacy_response", "APIRequestor",
  "._post(", "._get(", "._put(", "._patch(", "._delete(", "._request(",
  "_send_single_request", "_send_handling", "_send(",
  "wrapper return func(", "decorator",
  "generate_content", "_generate_content",
  "<module>", "run_until_complete", "_run_once",
];


async function backfillFrames(pool: import("pg").Pool): Promise<void> {
  const { runOnce } = await import("./db.js");

  await runOnce(pool, "backfill_frames_v3", async () => {
    const result = await pool.query(
        "SELECT id, project_id, call_site_frames FROM events WHERE call_site_frames IS NOT NULL",
      );

      let updated = 0;
      for (const row of result.rows) {
        const frames: Array<{ fileName?: string | null; functionName?: string | null }> =
          typeof row.call_site_frames === "string"
            ? JSON.parse(row.call_site_frames)
            : row.call_site_frames;

        const filtered = frames.filter((f: { fileName?: string | null; functionName?: string | null }) => {
          const file = f.fileName ?? "";
          const fn = f.functionName ?? "";
          if (!file && !fn) return false;
          if (INTERNAL_FILE_PATTERNS.some((p: string) => file.includes(p))) return false;
          if (INTERNAL_FN_PATTERNS.some((p: string) => fn.includes(p))) return false;
          return true;
        });

        if (filtered.length === 0) continue;

        const origJson = JSON.stringify(frames);
        const newJson = JSON.stringify(filtered);
        if (origJson !== newJson) {
          await pool.query(
            "UPDATE events SET call_site_frames = $1 WHERE project_id = $2 AND id = $3",
            [newJson, row.project_id, row.id],
          );
          updated++;
        }
      }

    console.log(`[costkey] Cleaned stack frames for ${updated} events`);
  });

  // Rebuild call_site_stats (also runs once)
  await runOnce(pool, "rebuild_callsite_stats_v12", async () => {
    await rebuildCallSiteStats(pool);
  });
}

/**
 * Find the business logic frame from in-app frames.
 * Same logic as findBusinessLogicFrame in ingest.ts:
 * second-to-last meaningful frame (skip entry points and wrappers).
 */
function pickBestFrame(frames: Array<{ fileName?: string | null; functionName?: string | null; lineNumber?: number | null }>): typeof frames[0] {
  if (frames.length === 0) return frames[0];

  const useless = new Set(["<module>", "<anonymous>", "anonymous", "main", "_run", ""]);
  const meaningful = frames.filter((f) => {
    const fn = (f.functionName ?? "").split("\n")[0].trim();
    return fn && !useless.has(fn);
  });

  const pool = meaningful.length > 0 ? meaningful : frames;
  if (pool.length <= 1) return pool[0];

  // First frame from a different file = business logic caller
  const innerFile = pool[0].fileName ?? "";
  for (let i = 1; i < pool.length; i++) {
    const file = pool[i].fileName ?? "";
    if (file && file !== innerFile) return pool[i];
  }
  // All same file — use frame[1] (caller of the wrapper)
  return pool.length >= 2 ? pool[1] : pool[0];
}

async function rebuildCallSiteStats(pool: import("pg").Pool): Promise<void> {
  await pool.query("DELETE FROM call_site_stats");

  // Re-backfill ALL bl_ fields using the canonical algorithm (with graph when available)
  const needBl = await pool.query(`
    SELECT id, project_id, call_site_frames FROM events
    WHERE call_site_frames IS NOT NULL
      AND call_site_frames != '[]'::jsonb
      AND jsonb_array_length(call_site_frames) > 0
  `);
  for (const row of needBl.rows) {
    const frames = typeof row.call_site_frames === "string"
      ? JSON.parse(row.call_site_frames) : row.call_site_frames;
    if (!frames || frames.length === 0) continue;
    const filtered = filterFrames(frames);
    const filterCtx = getFilterContext(frames, filtered);
    const graph = callGraphCache.get(row.project_id);
    const best = graph
      ? findBusinessLogicFrameWithGraph(filtered, graph, filterCtx)
      : findBusinessLogicFrame(filtered, filterCtx);
    if (best) {
      const fn = (best.functionName ?? "").split("\n")[0].trim() || null;
      await pool.query(
        "UPDATE events SET bl_function = $1, bl_file = $2, bl_line = $3 WHERE project_id = $4 AND id = $5",
        [fn, best.fileName ?? null, best.lineNumber ?? null, row.project_id, row.id],
      );
    }
  }
  if (needBl.rows.length > 0) {
    console.log(`[costkey] Backfilled bl_ fields on ${needBl.rows.length} events`);
  }

  // Now rebuild stats purely from bl_ fields — single source of truth
  const result = await pool.query(`
    SELECT id, project_id, provider, model, cost_usd, input_tokens, output_tokens,
      duration_ms, streaming, ttft, tps, timestamp,
      bl_function, bl_file, bl_line
    FROM events
    WHERE bl_function IS NOT NULL
  `);

  const stats = new Map<string, {
    projectId: string; key: string; fileName: string | null; functionName: string | null;
    lineNumber: number | null; provider: string; model: string;
    calls: number; cost: number; pricedCalls: number; unpricedCalls: number;
    inputTokens: number; outputTokens: number;
    durations: number[]; ttfts: number[]; tpss: number[];
    firstSeen: string; lastSeen: string;
  }>();

  for (const row of result.rows) {
    const fn = row.bl_function;
    const fileName = row.bl_file ?? "unknown";
    const lineNum = row.bl_line ?? null;
    const compositeKey = `${row.project_id}:${fileName}:${fn}:${lineNum}:${row.model}`;

    const existing = stats.get(compositeKey);
    if (existing) {
      existing.calls++;
      existing.cost += row.cost_usd ?? 0;
      if (row.cost_usd == null) existing.unpricedCalls++;
      else existing.pricedCalls++;
      existing.inputTokens += row.input_tokens ?? 0;
      existing.outputTokens += row.output_tokens ?? 0;
      existing.durations.push(row.duration_ms ?? 0);
      if (row.streaming && row.ttft != null) existing.ttfts.push(row.ttft);
      if (row.streaming && row.tps != null) existing.tpss.push(row.tps);
      if (row.timestamp < existing.firstSeen) existing.firstSeen = row.timestamp;
      if (row.timestamp > existing.lastSeen) existing.lastSeen = row.timestamp;
    } else {
      stats.set(compositeKey, {
        projectId: row.project_id, key: `${fileName}:${fn}:${lineNum ?? 0}`,
        fileName, functionName: fn, lineNumber: lineNum,
        provider: row.provider, model: row.model,
        calls: 1, cost: row.cost_usd ?? 0,
        pricedCalls: row.cost_usd == null ? 0 : 1,
        unpricedCalls: row.cost_usd == null ? 1 : 0,
        inputTokens: row.input_tokens ?? 0, outputTokens: row.output_tokens ?? 0,
        durations: [row.duration_ms ?? 0],
        ttfts: row.streaming && row.ttft != null ? [row.ttft] : [],
        tpss: row.streaming && row.tps != null ? [row.tps] : [],
        firstSeen: row.timestamp, lastSeen: row.timestamp,
      });
    }
  }

  // Insert aggregated stats
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  for (const s of stats.values()) {
    await pool.query(`
      INSERT INTO call_site_stats (
        project_id, call_site_key, file_name, function_name, line_number,
        provider, model, total_calls, total_cost_usd, total_input_tokens, total_output_tokens,
        avg_duration_ms, avg_ttft, avg_tps, first_seen, last_seen,
        priced_calls, unpriced_calls
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (project_id, call_site_key, model) DO NOTHING`,
      [
        s.projectId, s.key, s.fileName, s.functionName, s.lineNumber,
        s.provider, s.model, s.calls, s.cost, s.inputTokens, s.outputTokens,
        avg(s.durations), avg(s.ttfts), avg(s.tpss), s.firstSeen, s.lastSeen,
        s.pricedCalls, s.unpricedCalls,
      ],
    );
  }

  console.log(`[costkey] Rebuilt call_site_stats: ${stats.size} entries from ${result.rows.length} events`);
}
