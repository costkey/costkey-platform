import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage, ExtractorCall } from "./types.js";
import { asRecord, countCharacters, succeeded, unitUsage } from "./units.js";

const TTS_PATH = /^\/tts\/(?:bytes|sse)\/?$/;

/**
 * Cartesia — api.cartesia.ai. Text-to-speech (/tts/bytes, /tts/sse) bills
 * characters of the request `transcript`. Its bodies are audio (raw bytes, or
 * base64 chunks in SSE) and are never read.
 */
export const cartesiaExtractor: ProviderExtractor = {
  provider: Provider.Cartesia,

  match(url: URL): boolean {
    return url.hostname === "api.cartesia.ai";
  },

  readResponseBody(call: ExtractorCall): boolean {
    return !TTS_PATH.test(call.url.pathname);
  },

  extractUsage(_body: unknown, call?: ExtractorCall): NormalizedUsage | null {
    if (!succeeded(call) || !TTS_PATH.test(call.url.pathname)) return null;
    const transcript = asRecord(call.requestBody)?.["transcript"];
    return typeof transcript === "string" ? unitUsage({ characters: countCharacters(transcript) }) : null;
  },

  extractModel(requestBody: unknown): string | null {
    const model = asRecord(requestBody)?.["model_id"];
    return typeof model === "string" && model.trim() ? model.trim() : null;
  },
};
