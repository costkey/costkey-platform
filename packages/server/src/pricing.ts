/**
 * Server-side pricing table: cost per 1M tokens in USD.
 * This is the authoritative pricing source — the SDK no longer calculates costs.
 * Source: provider pricing pages as of 2026-04.
 */
interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
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
  ["gpt-4o-mini", { input: 0.15, output: 0.6 }],
  ["gpt-4o", { input: 2.5, output: 10 }],
  ["gpt-4-turbo", { input: 10, output: 30 }],
  ["gpt-4", { input: 30, output: 60 }],
  ["gpt-3.5-turbo", { input: 0.5, output: 1.5 }],
  ["o1-mini", { input: 3, output: 12 }],
  ["o1-pro", { input: 150, output: 600 }],
  ["o1", { input: 15, output: 60 }],
  ["o3-mini", { input: 1.1, output: 4.4 }],
  ["o3", { input: 10, output: 40 }],
  ["o4-mini", { input: 1.1, output: 4.4 }],

  // Anthropic — match family name regardless of version suffix
  ["claude-opus-4", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ["claude-sonnet-4", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["claude-haiku-3", { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  ["claude-3-5-sonnet", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["claude-3-5-haiku", { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  ["claude-3-opus", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ["claude-3-sonnet", { input: 3, output: 15 }],
  ["claude-3-haiku", { input: 0.25, output: 1.25 }],

  // Google Gemini
  ["gemini-2.5-pro", { input: 1.25, output: 10 }],
  ["gemini-2.5-flash", { input: 0.15, output: 0.6 }],
  ["gemini-2.0-flash-lite", { input: 0.02, output: 0.1 }],
  ["gemini-2.0-flash", { input: 0.1, output: 0.4 }],
  ["gemini-1.5-pro", { input: 1.25, output: 5 }],
  ["gemini-1.5-flash", { input: 0.075, output: 0.3 }],

  // xAI (Grok)
  ["grok-3-mini", { input: 0.3, output: 0.5 }],
  ["grok-3", { input: 3, output: 15 }],
  ["grok-4", { input: 3, output: 15 }],

  // Groq
  ["llama-3.3-70b", { input: 0.59, output: 0.79 }],
  ["llama-3.1-8b", { input: 0.05, output: 0.08 }],
  ["llama-3-70b", { input: 0.59, output: 0.79 }],
  ["mixtral-8x7b", { input: 0.24, output: 0.24 }],
  ["gemma2-9b", { input: 0.2, output: 0.2 }],

  // Mistral
  ["mistral-large", { input: 2, output: 6 }],
  ["mistral-medium", { input: 2.7, output: 8.1 }],
  ["mistral-small", { input: 0.2, output: 0.6 }],
  ["codestral", { input: 0.3, output: 0.9 }],
  ["open-mistral-nemo", { input: 0.15, output: 0.15 }],

  // DeepSeek
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
 * Compute the estimated cost in USD for a given model + usage.
 * Returns null if the model is unknown.
 */
export function computeCost(
  model: string | null,
  inputTokens: number | null,
  outputTokens: number | null,
  cacheReadTokens?: number | null,
  cacheCreationTokens?: number | null,
): number | null {
  if (!model) return null;

  const pricing = findPricing(model);
  if (!pricing) return null;

  let cost = 0;

  if (inputTokens != null) {
    cost += (inputTokens / 1_000_000) * pricing.input;
  }
  if (outputTokens != null) {
    cost += (outputTokens / 1_000_000) * pricing.output;
  }
  if (cacheReadTokens != null && pricing.cacheRead != null) {
    cost += (cacheReadTokens / 1_000_000) * pricing.cacheRead;
  }
  if (cacheCreationTokens != null && pricing.cacheWrite != null) {
    cost += (cacheCreationTokens / 1_000_000) * pricing.cacheWrite;
  }

  return Math.round(cost * 1_000_000) / 1_000_000;
}

function findPricing(model: string): ModelPricing | null {
  const lower = model.toLowerCase();
  for (const [pattern, pricing] of PRICING) {
    if (lower.includes(pattern.toLowerCase())) return pricing;
  }
  return null;
}

/**
 * Backfill costs for events that have tokens but no cost.
 * Runs once on server startup to fix historical data.
 */
export async function backfillCosts(pool: import("pg").Pool): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
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
      );
      if (cost != null && cost > 0) {
        await pool.query(
          "UPDATE events SET cost_usd = $1 WHERE id = $2",
          [cost, row.id],
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
  } catch (err) {
    console.error("[costkey] Cost backfill error:", err);
  }
}
