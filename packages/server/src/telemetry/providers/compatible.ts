import type { ExtractCall, ServerExtractor } from "../types.js";
import { asObject, count, items, num, str, strLength } from "../skeleton.js";
import { type NormalizedUsage, unitUsage, withUnits } from "../usage.js";
import { openaiUsage } from "./openai.js";
import { hostIn, requestString, responseOrRequestModel, safeDecode, succeeded } from "./common.js";

/**
 * OpenAI-shaped usage, also accepting the variants compatible hosts emit:
 * usage on the first choice of a stream chunk (Moonshot) and a top-level
 * `cached_tokens` count.
 */
export function compatibleUsage(body: unknown): NormalizedUsage | null {
  const response = asObject(body);
  if (!response) return null;
  let source: Record<string, unknown> = response;
  if (!asObject(response["usage"]) && Array.isArray(response["choices"])) {
    const choice = asObject(items(response["choices"])?.[0]);
    if (asObject(choice?.["usage"])) source = choice!;
  }
  const usage = openaiUsage(source);
  if (usage && usage.cacheReadTokens == null) {
    const cached = count(asObject(source["usage"])?.["cached_tokens"]);
    if (cached != null) usage.cacheReadTokens = cached;
  }
  return usage;
}

/** `usage.cost` when a host reports what it billed (stored, never trusted over server pricing). */
function reportedCost(usage: NormalizedUsage | null, body: unknown): NormalizedUsage | null {
  const cost = count(asObject(asObject(body)?.["usage"])?.["cost"]);
  return usage && cost != null ? { ...usage, costUsd: cost } : usage;
}

function compatible(provider: string, match: (url: URL) => boolean): ServerExtractor {
  return {
    provider,
    match,
    extractUsage: (body) => compatibleUsage(body),
    extractModel: (requestBody, responseBody) => responseOrRequestModel(requestBody, responseBody),
  };
}

// ── Hosts that serve the OpenAI shape as is ──

export const deepinfraExtractor = compatible("deepinfra", hostIn("api.deepinfra.com"));
export const nvidiaExtractor = compatible("nvidia", hostIn("integrate.api.nvidia.com"));
export const sambanovaExtractor = compatible("sambanova", hostIn("api.sambanova.ai"));
export const novitaExtractor = compatible("novita", hostIn("api.novita.ai"));
export const hyperbolicExtractor = compatible("hyperbolic", hostIn("api.hyperbolic.xyz"));
export const nebiusExtractor = compatible("nebius", hostIn("api.studio.nebius.com", "api.studio.nebius.ai", "api.tokenfactory.nebius.com"));
export const alibabaExtractor = compatible("alibaba", hostIn("dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"));
export const moonshotExtractor = compatible("moonshot", hostIn("api.moonshot.ai", "api.moonshot.cn"));
export const zaiExtractor = compatible("zai", hostIn("api.z.ai", "open.bigmodel.cn"));
export const basetenExtractor = compatible("baseten", hostIn("inference.baseten.co"));
export const lambdaExtractor = compatible("lambda", hostIn("api.lambda.ai"));
export const featherlessExtractor = compatible("featherless", hostIn("api.featherless.ai"));
export const friendliExtractor = compatible("friendli", hostIn("api.friendli.ai"));
export const ai21Extractor = compatible("ai21", hostIn("api.ai21.com"));
export const vercelExtractor = compatible("vercel", hostIn("ai-gateway.vercel.sh"));
/** Portkey and Helicone's OpenAI gateways return OpenAI-shaped bodies. */
export const openaiGatewayExtractor = compatible("openai", hostIn("api.portkey.ai", "oai.helicone.ai", "gateway.helicone.ai"));

// ── Model providers on the OpenAI shape ──

/** OpenRouter: cache reads and writes, reasoning, image output tokens and the billed `usage.cost`. */
export const openrouterExtractor: ServerExtractor = {
  provider: "openrouter",
  match: hostIn("openrouter.ai"),
  extractUsage(body) {
    const usage = asObject(asObject(body)?.["usage"]);
    if (!usage) return null;
    const promptDetails = asObject(usage["prompt_tokens_details"]);
    const inputDetails = asObject(usage["input_tokens_details"]);
    const completionDetails = asObject(usage["completion_tokens_details"]);
    const inputTokens = num(usage["prompt_tokens"]) ?? num(usage["input_tokens"]);
    const outputTokens = num(usage["completion_tokens"]) ?? num(usage["output_tokens"]);
    const costUsd = num(usage["cost"]);
    let imageOutputTokens: number | null = null;
    for (const value of [
      completionDetails?.["image_tokens"], completionDetails?.["image_output_tokens"],
      usage["image_tokens"], usage["image_output_tokens"], usage["native_tokens_completion_images"],
    ]) {
      const n = num(value);
      if (n != null && Number.isInteger(n) && n >= 0) { imageOutputTokens = n; break; }
    }
    return {
      inputTokens,
      outputTokens,
      totalTokens: num(usage["total_tokens"]) ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null),
      reasoningTokens: num(usage["reasoning_tokens"]) ?? num(completionDetails?.["reasoning_tokens"]),
      cacheReadTokens: num(usage["cached_tokens"]) ?? num(promptDetails?.["cached_tokens"]) ?? num(inputDetails?.["cached_tokens"]),
      cacheCreationTokens: num(usage["cache_write_tokens"]) ?? num(promptDetails?.["cache_write_tokens"])
        ?? num(inputDetails?.["cache_write_tokens"]) ?? num(inputDetails?.["cache_creation_tokens"]),
      ...(costUsd != null ? { costUsd } : {}),
      ...(imageOutputTokens != null ? { imageOutputTokens } : {}),
    };
  },
  extractModel: (requestBody, responseBody) => responseOrRequestModel(requestBody, responseBody),
};

/**
 * xAI (Grok): OpenAI usage with cached prompt tokens (SDK 0.6 TypeScript
 * dropped them) and the live-search sources it bills per source.
 */
export const xaiExtractor: ServerExtractor = {
  provider: "xai",
  match: hostIn("api.x.ai", "api.grok.xai.com"),
  extractUsage(body) {
    const usage = openaiUsage(body);
    if (!usage) return null;
    const sources = num(asObject(asObject(body)?.["usage"])?.["num_sources_used"]);
    return withUnits(usage, { searchSources: sources != null && sources > 0 ? sources : null });
  },
  extractModel: (requestBody, responseBody) => responseOrRequestModel(requestBody, responseBody),
};

/** Groq: input/output or prompt/completion counts; streams put usage under `x_groq`. */
export const groqExtractor: ServerExtractor = {
  provider: "groq",
  match: hostIn("api.groq.com"),
  extractUsage(body) {
    const usage = asObject(asObject(body)?.["usage"]);
    if (!usage) return null;
    const inputTokens = num(usage["input_tokens"]) ?? num(usage["prompt_tokens"]);
    const outputTokens = num(usage["output_tokens"]) ?? num(usage["completion_tokens"]);
    const inputDetails = asObject(usage["input_tokens_details"]) ?? asObject(usage["prompt_tokens_details"]);
    const outputDetails = asObject(usage["output_tokens_details"]) ?? asObject(usage["completion_tokens_details"]);
    return {
      inputTokens,
      outputTokens,
      totalTokens: num(usage["total_tokens"]) ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null),
      reasoningTokens: outputDetails ? num(outputDetails["reasoning_tokens"]) : null,
      cacheReadTokens: inputDetails ? num(inputDetails["cached_tokens"]) : null,
      cacheCreationTokens: null,
    };
  },
  extractModel: (requestBody, responseBody) => responseOrRequestModel(requestBody, responseBody),
  streamCandidates: (record) => [record["x_groq"]],
};

/**
 * DeepSeek: `prompt_cache_hit_tokens` are cache reads.
 * `prompt_cache_miss_tokens` are ordinary (uncached) input already counted in
 * `prompt_tokens`, not a cache write; SDK 0.6 reported them as cache creation.
 */
export const deepseekExtractor: ServerExtractor = {
  provider: "deepseek",
  match: hostIn("api.deepseek.com"),
  extractUsage(body) {
    const usage = asObject(asObject(body)?.["usage"]);
    if (!usage) return null;
    const details = asObject(usage["completion_tokens_details"]);
    const promptDetails = asObject(usage["prompt_tokens_details"]);
    return {
      inputTokens: num(usage["prompt_tokens"]),
      outputTokens: num(usage["completion_tokens"]),
      totalTokens: num(usage["total_tokens"]),
      reasoningTokens: details ? num(details["reasoning_tokens"]) : null,
      cacheReadTokens: num(usage["prompt_cache_hit_tokens"]) ?? num(promptDetails?.["cached_tokens"]),
      cacheCreationTokens: null,
    };
  },
  extractModel: (requestBody, responseBody) => responseOrRequestModel(requestBody, responseBody),
};

/**
 * Mistral, Together, Fireworks and Cerebras: full OpenAI usage (cached and
 * reasoning tokens, which SDK 0.6 TypeScript dropped) plus a billed
 * `usage.cost` when reported. Mistral OCR reports pages processed.
 */
function openaiPlus(provider: string, hosts: string[]): ServerExtractor {
  return {
    provider,
    match: hostIn(...hosts),
    extractUsage(body) {
      const usage = reportedCost(compatibleUsage(body), body);
      const ocrPages = count(asObject(asObject(body)?.["usage_info"])?.["pages_processed"]);
      return ocrPages != null ? withUnits(usage, { pages: ocrPages }) : usage;
    },
    extractModel: (requestBody, responseBody) => responseOrRequestModel(requestBody, responseBody),
  };
}

export const mistralExtractor = openaiPlus("mistral", ["api.mistral.ai"]);
export const togetherExtractor = openaiPlus("together", ["api.together.xyz"]);
export const fireworksExtractor = openaiPlus("fireworks", ["api.fireworks.ai"]);
export const cerebrasExtractor = openaiPlus("cerebras", ["api.cerebras.ai"]);

/**
 * Perplexity: OpenAI usage plus the search units SDK 0.6 dropped: search
 * queries run, citation tokens and reasoning tokens; `usage.cost.total_cost`
 * is the reported amount.
 */
export const perplexityExtractor: ServerExtractor = {
  provider: "perplexity",
  match: hostIn("api.perplexity.ai"),
  extractUsage(body) {
    const raw = asObject(asObject(body)?.["usage"]);
    let usage = compatibleUsage(body);
    if (!usage || !raw) return usage;
    if (usage.reasoningTokens == null) usage.reasoningTokens = num(raw["reasoning_tokens"]);
    const cost = num(raw["cost"]) ?? num(asObject(raw["cost"])?.["total_cost"]);
    if (cost != null && cost >= 0) usage = { ...usage, costUsd: cost };
    return withUnits(usage, {
      searchQueries: num(raw["num_search_queries"]),
      citationTokens: num(raw["citation_tokens"]),
    });
  },
  extractModel: (requestBody, responseBody) => responseOrRequestModel(requestBody, responseBody),
};

/** Typesafe (Jev): OpenAI-style usage; the requested model names the call. */
export const typesafeExtractor: ServerExtractor = {
  provider: "typesafe",
  match: hostIn("api.typesafe.ai"),
  extractUsage(body) {
    const usage = asObject(asObject(body)?.["usage"]);
    if (!usage) return null;
    const inputTokens = num(usage["prompt_tokens"]) ?? num(usage["input_tokens"]);
    const outputTokens = num(usage["completion_tokens"]) ?? num(usage["output_tokens"]);
    const costUsd = num(usage["cost"]);
    return {
      inputTokens,
      outputTokens,
      totalTokens: num(usage["total_tokens"]) ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null),
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      ...(costUsd != null ? { costUsd } : {}),
    };
  },
  extractModel(requestBody, responseBody) {
    return str(asObject(requestBody)?.["model"]) ?? str(asObject(responseBody)?.["model"]) ?? "jev-latest";
  },
};

// ── Hosts with extra routes ──

/** Upstage chat, plus Document AI responses that report `usage.pages`. */
export const upstageExtractor: ServerExtractor = {
  ...compatible("upstage", hostIn("api.upstage.ai")),
  extractUsage(body) {
    const pages = count(asObject(asObject(body)?.["usage"])?.["pages"]);
    const usage = compatibleUsage(body);
    if (pages == null) return usage;
    if (usage && (usage.inputTokens != null || usage.outputTokens != null)) return { ...usage, nativeUnits: { pages } };
    return unitUsage({ pages });
  },
};

/** /hf-inference/models/{org}/{model}/..., api-inference's /models/{org}/{model} */
const HF_MODEL_PATH = /\/models\/([^/]+\/[^/]+?)(?:\/pipeline\/.*)?\/?$/;

/** Hugging Face Inference Providers router and the legacy Inference API. */
export const huggingfaceExtractor: ServerExtractor = {
  ...compatible("huggingface", hostIn("router.huggingface.co", "api-inference.huggingface.co")),
  extractModel(requestBody, responseBody, call) {
    const model = responseOrRequestModel(requestBody, responseBody);
    if (model) return model;
    const match = HF_MODEL_PATH.exec(call.url.pathname);
    return match ? safeDecode(match[1]!) : null;
  },
};

const MINIMAX_TTS_PATH = /\/t2a_v2\/?$/;

/** MiniMax chat is OpenAI-shaped; T2A text-to-speech bills characters of the request `text`. */
export const minimaxExtractor: ServerExtractor = {
  ...compatible("minimax", hostIn("api.minimax.io", "api.minimaxi.com", "api.minimax.chat")),
  extractUsage(body, call) {
    if (MINIMAX_TTS_PATH.test(call.url.pathname)) {
      if (!succeeded(call)) return null;
      const characters = strLength(asObject(call.requestBody)?.["text"]);
      return characters != null ? unitUsage({ characters }) : null;
    }
    return compatibleUsage(body);
  },
};

const SARVAM_TTS_PATH = /^\/text-to-speech(?:\/stream)?\/?$/;
const SARVAM_STT_PATH = /^\/speech-to-text(-translate)?\/?$/;
const SARVAM_DURATION_KEYS = [
  "duration", "audio_duration", "duration_seconds", "audio_duration_seconds", "audio_duration_secs", "duration_secs",
];

/**
 * Sarvam: chat is OpenAI-shaped. Text-to-speech bills characters of the
 * request `inputs` (or `text`); speech-to-text reports audio seconds.
 */
export const sarvamExtractor: ServerExtractor = {
  ...compatible("sarvam", hostIn("api.sarvam.ai")),
  extractUsage(body, call) {
    const path = call.url.pathname;
    if (SARVAM_TTS_PATH.test(path)) {
      if (!succeeded(call)) return null;
      const request = asObject(call.requestBody);
      const inputs = request?.["inputs"];
      let characters: number | null = null;
      if (Array.isArray(inputs)) {
        characters = (items(inputs) ?? []).reduce<number>((sum, input) => sum + (strLength(input) ?? 0), 0);
      } else {
        characters = strLength(request?.["text"]);
      }
      return characters != null ? unitUsage({ characters }) : null;
    }
    if (SARVAM_STT_PATH.test(path)) {
      if (!succeeded(call)) return null;
      const response = asObject(body);
      const seconds = SARVAM_DURATION_KEYS.map((key) => count(response?.[key])).find((value) => value != null);
      return seconds != null ? unitUsage({ audioSeconds: seconds }) : null;
    }
    return compatibleUsage(body);
  },
  extractModel(requestBody, responseBody, call) {
    const path = call.url.pathname;
    if (SARVAM_TTS_PATH.test(path)) return requestString(call, "model") ?? "bulbul:v2";
    if (SARVAM_STT_PATH.test(path)) return requestString(call, "model") ?? "saarika:v2.5";
    return responseOrRequestModel(requestBody, responseBody);
  },
};

/** Workers AI native route: /client/v4/accounts/{id}/ai/run/@cf/{org}/{model} */
const CLOUDFLARE_RUN_PATH = /\/ai\/run\/(@[^/]+\/.+?)\/?$/;

/** Cloudflare Workers AI (only /ai/ routes on api.cloudflare.com). */
export const cloudflareExtractor: ServerExtractor = {
  ...compatible("cloudflare", (url) => url.hostname === "api.cloudflare.com" && url.pathname.includes("/ai/")),
  extractUsage(body) {
    const result = asObject(asObject(body)?.["result"]);
    if (result && asObject(result["usage"])) return compatibleUsage(result);
    return compatibleUsage(body);
  },
  extractModel(requestBody, responseBody, call: ExtractCall) {
    const match = CLOUDFLARE_RUN_PATH.exec(call.url.pathname);
    if (match) return safeDecode(match[1]!);
    return responseOrRequestModel(requestBody, responseBody);
  },
};

const OLLAMA_HOSTS = new Set(["localhost", "127.0.0.1"]);
const OLLAMA_PATH = /^\/(?:api\/(?:chat|generate|embed|embeddings)|v1\/.+)\/?$/;

/** Ollama on its default local port: native `prompt_eval_count`/`eval_count`, or /v1 OpenAI usage. */
export const ollamaExtractor: ServerExtractor = {
  ...compatible("ollama", (url) => OLLAMA_HOSTS.has(url.hostname) && url.port === "11434" && OLLAMA_PATH.test(url.pathname)),
  extractUsage(body) {
    const response = asObject(body);
    if (!response) return null;
    const inputTokens = count(response["prompt_eval_count"]);
    const outputTokens = count(response["eval_count"]);
    if (inputTokens == null && outputTokens == null) return compatibleUsage(body);
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    };
  },
};
