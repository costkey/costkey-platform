/**
 * SQL for token counts as the console reads them (see token-usage.ts). Kept
 * free of imports so the charges query can use it without an import cycle.
 */

/** SQL: the provider reports cache tokens beside the input count. Mirrors `cacheIncludedInInput`. */
export const CACHE_BESIDE_INPUT = (e: string) =>
  `(${e}.provider IN ('anthropic', 'bedrock') OR (${e}.provider = 'vertex' AND LOWER(COALESCE(${e}.model, '')) LIKE '%claude%'))`;

/** SQL: cache writes. DeepSeek never bills one; SDK 0.6 sent its cache misses there. */
export const CACHE_WRITE_SQL = (e: string) => `CASE WHEN ${e}.provider = 'deepseek' THEN NULL ELSE ${e}.cache_creation_tokens END`;

/** SQL: the whole prompt, cache included. Null when the call reported no input at all. */
export const PROMPT_TOKENS_SQL = (e: string) => `CASE
    WHEN ${e}.input_tokens IS NULL AND ${e}.cache_read_tokens IS NULL AND ${CACHE_WRITE_SQL(e)} IS NULL THEN NULL
    WHEN ${CACHE_BESIDE_INPUT(e)} THEN COALESCE(${e}.input_tokens, 0) + COALESCE(${e}.cache_read_tokens, 0) + COALESCE(${CACHE_WRITE_SQL(e)}, 0)
    ELSE COALESCE(${e}.input_tokens, 0) END`;

/** SQL: output with reasoning included. Mirrors `billableOutputTokens`. */
export const OUTPUT_TOKENS_SQL = (e: string) => `CASE
    WHEN (${e}.provider = 'google' OR LOWER(COALESCE(${e}.model, '')) LIKE '%gemini%') AND ${e}.reasoning_tokens > 0
      THEN COALESCE(${e}.output_tokens, 0) + ${e}.reasoning_tokens
    ELSE ${e}.output_tokens END`;

/** SQL: the call said something about caching. */
export const CACHE_REPORTED_SQL = (e: string) => `(${e}.cache_read_tokens IS NOT NULL OR ${CACHE_WRITE_SQL(e)} IS NOT NULL)`;
