import type { ServerExtractor } from "../types.js";
import { openaiExtractor } from "./openai.js";
import { anthropicExtractor, anthropicGatewayExtractor } from "./anthropic.js";
import { googleExtractor } from "./google.js";
import { bedrockExtractor } from "./bedrock.js";
import {
  ai21Extractor, alibabaExtractor, basetenExtractor, cerebrasExtractor, cloudflareExtractor,
  deepinfraExtractor, deepseekExtractor, featherlessExtractor, fireworksExtractor, friendliExtractor,
  groqExtractor, huggingfaceExtractor, hyperbolicExtractor, lambdaExtractor, minimaxExtractor,
  mistralExtractor, moonshotExtractor, nebiusExtractor, novitaExtractor, nvidiaExtractor,
  ollamaExtractor, openaiGatewayExtractor, openrouterExtractor, perplexityExtractor,
  sambanovaExtractor, sarvamExtractor, togetherExtractor, typesafeExtractor, upstageExtractor,
  vercelExtractor, xaiExtractor, zaiExtractor,
} from "./compatible.js";
import { cohereExtractor, jinaExtractor, voyageExtractor } from "./embeddings.js";
import {
  assemblyaiExtractor, cartesiaExtractor, deepgramExtractor, elevenlabsExtractor,
  exaExtractor, firecrawlExtractor, rumikExtractor, tavilyExtractor,
} from "./media.js";

/** Every built-in extractor, checked in order (the SDK 0.6 registry order). */
export const EXTRACTORS: readonly ServerExtractor[] = [
  openaiExtractor,
  anthropicExtractor,
  googleExtractor,
  openrouterExtractor,
  vercelExtractor,
  huggingfaceExtractor,
  openaiGatewayExtractor,
  anthropicGatewayExtractor,
  cloudflareExtractor,
  bedrockExtractor,
  groqExtractor,
  cerebrasExtractor,
  fireworksExtractor,
  togetherExtractor,
  deepinfraExtractor,
  nvidiaExtractor,
  sambanovaExtractor,
  novitaExtractor,
  hyperbolicExtractor,
  nebiusExtractor,
  basetenExtractor,
  lambdaExtractor,
  featherlessExtractor,
  friendliExtractor,
  xaiExtractor,
  mistralExtractor,
  deepseekExtractor,
  cohereExtractor,
  perplexityExtractor,
  typesafeExtractor,
  alibabaExtractor,
  moonshotExtractor,
  zaiExtractor,
  minimaxExtractor,
  ai21Extractor,
  upstageExtractor,
  sarvamExtractor,
  ollamaExtractor,
  voyageExtractor,
  jinaExtractor,
  elevenlabsExtractor,
  rumikExtractor,
  deepgramExtractor,
  assemblyaiExtractor,
  cartesiaExtractor,
  exaExtractor,
  firecrawlExtractor,
  tavilyExtractor,
];

/** The built-in extractor for a provider URL, or null for hosts no extractor knows. */
export function findExtractor(url: URL): ServerExtractor | null {
  for (const extractor of EXTRACTORS) {
    if (extractor.match(url)) return extractor;
  }
  return null;
}
