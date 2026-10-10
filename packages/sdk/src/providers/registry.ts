import type { ProviderExtractor } from "./types.js";
import { openaiExtractor } from "./openai.js";
import { anthropicExtractor } from "./anthropic.js";
import { googleExtractor } from "./google.js";
import { openrouterExtractor } from "./openrouter.js";
import { xaiExtractor } from "./xai.js";
import { groqExtractor } from "./groq.js";
import { bedrockExtractor } from "./bedrock.js";
import { elevenlabsExtractor } from "./elevenlabs.js";
import { rumikExtractor } from "./rumik.js";
import { exaExtractor } from "./exa.js";
import { firecrawlExtractor } from "./firecrawl.js";
import { deepgramExtractor } from "./deepgram.js";
import { assemblyaiExtractor } from "./assemblyai.js";
import { cartesiaExtractor } from "./cartesia.js";
import { voyageExtractor, jinaExtractor } from "./embeddings.js";
import { tavilyExtractor } from "./tavily.js";
import {
  deepinfraExtractor,
  nvidiaExtractor,
  sambanovaExtractor,
  novitaExtractor,
  hyperbolicExtractor,
  nebiusExtractor,
  alibabaExtractor,
  moonshotExtractor,
  zaiExtractor,
  minimaxExtractor,
  huggingfaceExtractor,
  basetenExtractor,
  lambdaExtractor,
  featherlessExtractor,
  friendliExtractor,
  ai21Extractor,
  upstageExtractor,
  sarvamExtractor,
  cloudflareExtractor,
  vercelExtractor,
  ollamaExtractor,
  openaiGatewayExtractor,
  anthropicGatewayExtractor,
} from "./compatible.js";
import {
  cohereExtractor,
  mistralExtractor,
  togetherExtractor,
  deepseekExtractor,
  fireworksExtractor,
  perplexityExtractor,
  cerebrasExtractor,
  typesafeExtractor,
} from "./more.js";

/** All registered provider extractors — checked in order */
const extractors: ProviderExtractor[] = [
  // Major providers
  openaiExtractor,       // api.openai.com, *.openai.azure.com
  anthropicExtractor,    // api.anthropic.com
  googleExtractor,       // generativelanguage.googleapis.com, *-aiplatform.googleapis.com

  // Aggregators / routers / gateways
  openrouterExtractor,   // openrouter.ai
  vercelExtractor,       // ai-gateway.vercel.sh
  huggingfaceExtractor,  // router.huggingface.co, api-inference.huggingface.co
  openaiGatewayExtractor,    // api.portkey.ai, oai.helicone.ai, gateway.helicone.ai (as openai)
  anthropicGatewayExtractor, // anthropic.helicone.ai (as anthropic)
  cloudflareExtractor,   // api.cloudflare.com /ai/ routes (Workers AI)

  // Cloud providers
  bedrockExtractor,      // bedrock-runtime.*.amazonaws.com

  // Fast inference
  groqExtractor,         // api.groq.com
  cerebrasExtractor,     // api.cerebras.ai
  fireworksExtractor,    // api.fireworks.ai
  togetherExtractor,     // api.together.xyz
  deepinfraExtractor,    // api.deepinfra.com
  nvidiaExtractor,       // integrate.api.nvidia.com
  sambanovaExtractor,    // api.sambanova.ai
  novitaExtractor,       // api.novita.ai
  hyperbolicExtractor,   // api.hyperbolic.xyz
  nebiusExtractor,       // api.studio.nebius.com/.ai, api.tokenfactory.nebius.com
  basetenExtractor,      // inference.baseten.co
  lambdaExtractor,       // api.lambda.ai
  featherlessExtractor,  // api.featherless.ai
  friendliExtractor,     // api.friendli.ai

  // Model providers
  xaiExtractor,          // api.x.ai, api.grok.xai.com
  mistralExtractor,      // api.mistral.ai
  deepseekExtractor,     // api.deepseek.com
  cohereExtractor,       // api.cohere.com
  perplexityExtractor,   // api.perplexity.ai
  typesafeExtractor,     // api.typesafe.ai
  alibabaExtractor,      // dashscope(-intl|-us).aliyuncs.com
  moonshotExtractor,     // api.moonshot.ai, api.moonshot.cn
  zaiExtractor,          // api.z.ai, open.bigmodel.cn
  minimaxExtractor,      // api.minimax.io, api.minimaxi.com, api.minimax.chat (+ T2A characters)
  ai21Extractor,         // api.ai21.com
  upstageExtractor,      // api.upstage.ai
  sarvamExtractor,       // api.sarvam.ai (chat, TTS characters, STT seconds)

  // Local
  ollamaExtractor,       // localhost:11434, 127.0.0.1:11434

  // Embeddings and rerank (billed per token)
  voyageExtractor,       // api.voyageai.com
  jinaExtractor,         // api.jina.ai

  // Voice (billed per character / audio second)
  elevenlabsExtractor,   // *.elevenlabs.io
  rumikExtractor,        // *.rumik.ai
  deepgramExtractor,     // api.deepgram.com
  assemblyaiExtractor,   // api.assemblyai.com, api.eu.assemblyai.com
  cartesiaExtractor,     // api.cartesia.ai

  // Search and scraping (billed per query, page or credit)
  exaExtractor,          // api.exa.ai
  firecrawlExtractor,    // api.firecrawl.dev
  tavilyExtractor,       // api.tavily.com
];

/**
 * Find the provider extractor that matches a URL.
 * Returns null for non-AI URLs (the fast path — most fetch calls hit this).
 */
export function findExtractor(url: URL): ProviderExtractor | null {
  for (const extractor of extractors) {
    if (extractor.match(url)) return extractor;
  }
  return null;
}

/** Register a custom provider extractor */
export function registerExtractor(extractor: ProviderExtractor): void {
  if (!extractors.includes(extractor)) extractors.push(extractor);
}

/** Remove a runtime provider extractor without touching built-ins. */
export function unregisterExtractor(extractor: ProviderExtractor): void {
  const index = extractors.indexOf(extractor);
  if (index >= 0) extractors.splice(index, 1);
}
