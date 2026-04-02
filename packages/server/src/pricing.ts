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

const PRICING: Record<string, ModelPricing> = {
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-2024-11-20": { input: 2.5, output: 10 },
  "gpt-4o-2024-08-06": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o-mini-2024-07-18": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-4": { input: 30, output: 60 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "o1": { input: 15, output: 60 },
  "o1-mini": { input: 3, output: 12 },
  "o1-pro": { input: 150, output: 600 },
  "o3": { input: 10, output: 40 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o4-mini": { input: 1.1, output: 4.4 },

  // Anthropic
  "claude-opus-4-0-20250514": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-0-20250514": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5-20250514": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-3-5-20241022": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  "claude-3-opus-20240229": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },

  // Google Gemini
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-lite": { input: 0.02, output: 0.1 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },

  // xAI (Grok)
  "grok-3": { input: 3, output: 15 },
  "grok-3-mini": { input: 0.3, output: 0.5 },
  "grok-4": { input: 3, output: 15 },

  // Groq
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
  "llama-3-70b": { input: 0.59, output: 0.79 },
  "mixtral-8x7b-32768": { input: 0.24, output: 0.24 },
  "gemma2-9b-it": { input: 0.2, output: 0.2 },

  // Mistral
  "mistral-large-latest": { input: 2, output: 6 },
  "mistral-medium-latest": { input: 2.7, output: 8.1 },
  "mistral-small-latest": { input: 0.2, output: 0.6 },
  "codestral-latest": { input: 0.3, output: 0.9 },
  "open-mistral-nemo": { input: 0.15, output: 0.15 },

  // DeepSeek
  "deepseek-chat": { input: 0.14, output: 0.28, cacheRead: 0.014 },
  "deepseek-reasoner": { input: 0.55, output: 2.19, cacheRead: 0.055 },

  // Cohere
  "command-r-plus": { input: 2.5, output: 10 },
  "command-r": { input: 0.15, output: 0.6 },
  "command-a": { input: 2.5, output: 10 },

  // Together AI
  "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo": { input: 3.5, output: 3.5 },
  "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo": { input: 0.88, output: 0.88 },
  "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo": { input: 0.18, output: 0.18 },

  // Perplexity
  "sonar-pro": { input: 3, output: 15 },
  "sonar": { input: 1, output: 1 },
};

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
  if (model in PRICING) return PRICING[model];

  const parts = model.split("-");
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join("-");
    if (prefix in PRICING) return PRICING[prefix];
  }

  return null;
}
