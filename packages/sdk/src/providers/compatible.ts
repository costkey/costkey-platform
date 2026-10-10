import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage, ExtractorCall } from "./types.js";
import { anthropicExtractor } from "./anthropic.js";
import { injectIncludeUsage, openaiUsage, responseOrRequestModel } from "./openai.js";
import { asCount, asRecord, countCharacters, succeeded, unitUsage } from "./units.js";

export interface OpenAICompatibleOptions {
  provider: Provider;
  /** Exact hostnames served by this provider. */
  hosts?: readonly string[];
  /** A custom URL test, used instead of `hosts`. */
  match?: (url: URL) => boolean;
  /**
   * Inject `stream_options.include_usage` into streamed Chat/Completions
   * requests. Only for hosts known to accept it: a strict host would reject
   * the call. Hosts that report stream usage by default don't need it.
   */
  injectStreamUsage?: boolean;
}

/**
 * OpenAI-shaped usage, also accepting the variants compatible hosts emit:
 * usage on the first choice of a stream chunk (Moonshot) and a top-level
 * `cached_tokens` count.
 */
export function compatibleUsage(body: unknown): NormalizedUsage | null {
  const response = asRecord(body);
  if (!response) return null;
  let source: Record<string, unknown> = response;
  if (!asRecord(response["usage"]) && Array.isArray(response["choices"])) {
    const choice = asRecord(response["choices"][0]);
    if (asRecord(choice?.["usage"])) source = choice!;
  }
  const usage = openaiUsage(source);
  if (usage && usage.cacheReadTokens == null) {
    const cached = asCount(asRecord(source["usage"])?.["cached_tokens"]);
    if (cached != null) usage.cacheReadTokens = cached;
  }
  return usage;
}

/**
 * An extractor for a host that serves the OpenAI API shape (chat/completions,
 * completions, embeddings, responses; JSON and SSE), reusing OpenAI's usage
 * and model logic.
 */
export function openaiCompatibleExtractor(options: OpenAICompatibleOptions): ProviderExtractor {
  const hosts = new Set(options.hosts ?? []);
  return {
    provider: options.provider,
    match: options.match ?? ((url: URL) => hosts.has(url.hostname)),
    extractUsage: compatibleUsage,
    extractModel: responseOrRequestModel,
    ...(options.injectStreamUsage ? { injectStreamOptions: injectIncludeUsage } : {}),
  };
}

function requestString(call: ExtractorCall | undefined, ...keys: string[]): string | null {
  const request = asRecord(call?.requestBody);
  for (const key of keys) {
    const value = request?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// ── Hosts that serve the OpenAI shape as is ──

export const deepinfraExtractor = openaiCompatibleExtractor({
  provider: Provider.DeepInfra, hosts: ["api.deepinfra.com"], injectStreamUsage: true,
});
export const nvidiaExtractor = openaiCompatibleExtractor({
  provider: Provider.Nvidia, hosts: ["integrate.api.nvidia.com"], injectStreamUsage: true,
});
export const sambanovaExtractor = openaiCompatibleExtractor({
  provider: Provider.SambaNova, hosts: ["api.sambanova.ai"], injectStreamUsage: true,
});
export const novitaExtractor = openaiCompatibleExtractor({
  provider: Provider.Novita, hosts: ["api.novita.ai"], injectStreamUsage: true,
});
export const hyperbolicExtractor = openaiCompatibleExtractor({
  provider: Provider.Hyperbolic, hosts: ["api.hyperbolic.xyz"], injectStreamUsage: true,
});
export const nebiusExtractor = openaiCompatibleExtractor({
  provider: Provider.Nebius,
  hosts: ["api.studio.nebius.com", "api.studio.nebius.ai", "api.tokenfactory.nebius.com"],
  injectStreamUsage: true,
});
/** DashScope: compatible-mode routes, plus native routes that report `usage.input_tokens`. */
export const alibabaExtractor = openaiCompatibleExtractor({
  provider: Provider.Alibaba,
  hosts: ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"],
  injectStreamUsage: true,
});
/** Moonshot reports stream usage on the final chunk's choice by default. */
export const moonshotExtractor = openaiCompatibleExtractor({
  provider: Provider.Moonshot, hosts: ["api.moonshot.ai", "api.moonshot.cn"],
});
/** Z.ai / Zhipu GLM reports stream usage in the final chunk by default. */
export const zaiExtractor = openaiCompatibleExtractor({
  provider: Provider.ZAI, hosts: ["api.z.ai", "open.bigmodel.cn"],
});
export const basetenExtractor = openaiCompatibleExtractor({
  provider: Provider.Baseten, hosts: ["inference.baseten.co"], injectStreamUsage: true,
});
export const lambdaExtractor = openaiCompatibleExtractor({
  provider: Provider.Lambda, hosts: ["api.lambda.ai"], injectStreamUsage: true,
});
export const featherlessExtractor = openaiCompatibleExtractor({
  provider: Provider.Featherless, hosts: ["api.featherless.ai"], injectStreamUsage: true,
});
export const friendliExtractor = openaiCompatibleExtractor({
  provider: Provider.Friendli, hosts: ["api.friendli.ai"], injectStreamUsage: true,
});
export const ai21Extractor = openaiCompatibleExtractor({
  provider: Provider.AI21, hosts: ["api.ai21.com"],
});
export const vercelExtractor = openaiCompatibleExtractor({
  provider: Provider.Vercel, hosts: ["ai-gateway.vercel.sh"], injectStreamUsage: true,
});

// ── Gateways (same labelling as the Python SDK) ──

/** Portkey and Helicone's OpenAI gateways return OpenAI-shaped bodies. */
export const openaiGatewayExtractor = openaiCompatibleExtractor({
  provider: Provider.OpenAI,
  hosts: ["api.portkey.ai", "oai.helicone.ai", "gateway.helicone.ai"],
  injectStreamUsage: true,
});

/** Helicone's Anthropic proxy returns Anthropic bodies. */
export const anthropicGatewayExtractor: ProviderExtractor = {
  ...anthropicExtractor,
  match(url: URL): boolean {
    return url.hostname === "anthropic.helicone.ai";
  },
};

// ── Hosts with extra routes ──

/** Upstage chat, plus Document AI responses that report `usage.pages`. */
export const upstageExtractor: ProviderExtractor = {
  ...openaiCompatibleExtractor({ provider: Provider.Upstage, hosts: ["api.upstage.ai"] }),
  extractUsage(body: unknown): NormalizedUsage | null {
    const pages = asCount(asRecord(asRecord(body)?.["usage"])?.["pages"]);
    const usage = compatibleUsage(body);
    if (pages == null) return usage;
    if (usage && (usage.inputTokens != null || usage.outputTokens != null)) {
      return { ...usage, nativeUnits: { pages } };
    }
    return unitUsage({ pages });
  },
};

/** /hf-inference/models/{org}/{model}/..., api-inference's /models/{org}/{model} */
const HF_MODEL_PATH = /\/models\/([^/]+\/[^/]+?)(?:\/pipeline\/.*)?\/?$/;

/** Hugging Face Inference Providers router and the legacy Inference API. */
export const huggingfaceExtractor: ProviderExtractor = {
  ...openaiCompatibleExtractor({
    provider: Provider.HuggingFace,
    hosts: ["router.huggingface.co", "api-inference.huggingface.co"],
    injectStreamUsage: true,
  }),
  extractModel(requestBody: unknown, responseBody: unknown, call?: ExtractorCall): string | null {
    const model = responseOrRequestModel(requestBody, responseBody);
    if (model) return model;
    const match = call ? HF_MODEL_PATH.exec(call.url.pathname) : null;
    return match ? safeDecode(match[1]!) : null;
  },
};

const MINIMAX_TTS_PATH = /\/t2a_v2\/?$/;

/**
 * MiniMax — chat (/v1/text/chatcompletion_v2, /v1/chat/completions) reports
 * OpenAI usage. T2A text-to-speech bills characters of the request `text`;
 * its body carries the audio and is never read.
 */
export const minimaxExtractor: ProviderExtractor = {
  ...openaiCompatibleExtractor({
    provider: Provider.MiniMax,
    hosts: ["api.minimax.io", "api.minimaxi.com", "api.minimax.chat"],
  }),
  readResponseBody(call: ExtractorCall): boolean {
    return !MINIMAX_TTS_PATH.test(call.url.pathname);
  },
  extractUsage(body: unknown, call?: ExtractorCall): NormalizedUsage | null {
    if (call && MINIMAX_TTS_PATH.test(call.url.pathname)) {
      if (!succeeded(call)) return null;
      const text = asRecord(call.requestBody)?.["text"];
      return typeof text === "string" ? unitUsage({ characters: countCharacters(text) }) : null;
    }
    return compatibleUsage(body);
  },
};

const SARVAM_TTS_PATH = /^\/text-to-speech(?:\/stream)?\/?$/;
const SARVAM_STT_PATH = /^\/speech-to-text(-translate)?\/?$/;
const SARVAM_DEFAULT_TTS_MODEL = "bulbul:v2";
const SARVAM_DEFAULT_STT_MODEL = "saarika:v2.5";

/**
 * Sarvam — chat is OpenAI-shaped. Text-to-speech bills characters of the
 * request `inputs` (or `text`); its body is base64 audio and is never read.
 * Speech-to-text reports audio seconds when the response carries a duration.
 */
export const sarvamExtractor: ProviderExtractor = {
  ...openaiCompatibleExtractor({ provider: Provider.Sarvam, hosts: ["api.sarvam.ai"] }),
  readResponseBody(call: ExtractorCall): boolean {
    return !SARVAM_TTS_PATH.test(call.url.pathname);
  },
  extractUsage(body: unknown, call?: ExtractorCall): NormalizedUsage | null {
    const path = call?.url.pathname ?? "";
    if (SARVAM_TTS_PATH.test(path)) {
      if (!succeeded(call)) return null;
      const request = asRecord(call.requestBody);
      const inputs = request?.["inputs"];
      let characters: number | null = null;
      if (Array.isArray(inputs)) {
        characters = inputs.reduce<number>(
          (sum, input) => sum + (typeof input === "string" ? countCharacters(input) : 0),
          0,
        );
      } else if (typeof request?.["text"] === "string") {
        characters = countCharacters(request["text"]);
      }
      return characters != null ? unitUsage({ characters }) : null;
    }
    if (SARVAM_STT_PATH.test(path)) {
      if (!succeeded(call)) return null;
      const response = asRecord(body);
      const seconds = [
        "duration", "audio_duration", "duration_seconds", "audio_duration_seconds", "audio_duration_secs",
      ].map((key) => asCount(response?.[key])).find((value) => value != null);
      return seconds != null ? unitUsage({ audioSeconds: seconds }) : null;
    }
    return compatibleUsage(body);
  },
  extractModel(requestBody: unknown, responseBody: unknown, call?: ExtractorCall): string | null {
    const path = call?.url.pathname ?? "";
    if (SARVAM_TTS_PATH.test(path)) {
      return requestString(call, "model") ?? SARVAM_DEFAULT_TTS_MODEL;
    }
    if (SARVAM_STT_PATH.test(path)) {
      return requestString(call, "model") ?? SARVAM_DEFAULT_STT_MODEL;
    }
    return responseOrRequestModel(requestBody, responseBody);
  },
};

/** Workers AI native route: /client/v4/accounts/{id}/ai/run/@cf/{org}/{model} */
const CLOUDFLARE_RUN_PATH = /\/ai\/run\/(@[^/]+\/.+?)\/?$/;

/**
 * Cloudflare Workers AI on api.cloudflare.com (only /ai/ routes). The
 * OpenAI-compatible /ai/v1/... routes report OpenAI usage; native /ai/run
 * responses wrap it in `result.usage` (a stream's final event carries
 * `usage`), and the model is the `@cf/...` path suffix.
 */
export const cloudflareExtractor: ProviderExtractor = {
  ...openaiCompatibleExtractor({
    provider: Provider.Cloudflare,
    match: (url) => url.hostname === "api.cloudflare.com" && url.pathname.includes("/ai/"),
  }),
  extractUsage(body: unknown): NormalizedUsage | null {
    const result = asRecord(asRecord(body)?.["result"]);
    if (result && asRecord(result["usage"])) return compatibleUsage(result);
    return compatibleUsage(body);
  },
  extractModel(requestBody: unknown, responseBody: unknown, call?: ExtractorCall): string | null {
    const match = call ? CLOUDFLARE_RUN_PATH.exec(call.url.pathname) : null;
    if (match) return safeDecode(match[1]!);
    return responseOrRequestModel(requestBody, responseBody);
  },
};

const OLLAMA_HOSTS = new Set(["localhost", "127.0.0.1"]);
const OLLAMA_PATH = /^\/(?:api\/(?:chat|generate|embed|embeddings)|v1\/.+)\/?$/;

/**
 * Ollama on its default local port. Native /api/chat, /api/generate and
 * /api/embed report `prompt_eval_count`/`eval_count` (on the final `done`
 * record of an NDJSON stream); its /v1 routes are OpenAI-compatible. Other
 * routes (model listing, pulls, health checks) are not AI calls.
 */
export const ollamaExtractor: ProviderExtractor = {
  ...openaiCompatibleExtractor({
    provider: Provider.Ollama,
    match: (url) => OLLAMA_HOSTS.has(url.hostname) && url.port === "11434" && OLLAMA_PATH.test(url.pathname),
    injectStreamUsage: true,
  }),
  extractUsage(body: unknown): NormalizedUsage | null {
    const response = asRecord(body);
    if (!response) return null;
    const inputTokens = asCount(response["prompt_eval_count"]);
    const outputTokens = asCount(response["eval_count"]);
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

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
