import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage, ExtractorCall } from "./types.js";
import { asCount, asRecord, countCharacters, succeeded, unitUsage } from "./units.js";

const LISTEN_PATH = /^\/v\d+\/listen\/?$/;
const SPEAK_PATH = /^\/v\d+\/speak\/?$/;

const DEFAULT_LISTEN_MODEL = "nova-3";
const DEFAULT_SPEAK_MODEL = "aura-asteria-en";

/**
 * Deepgram — api.deepgram.com. Pre-recorded speech-to-text (/v1/listen)
 * bills audio seconds from `metadata.duration`; text-to-speech (/v1/speak)
 * bills characters of the request `text` and its audio is never read. The
 * model is the `model` query parameter.
 */
export const deepgramExtractor: ProviderExtractor = {
  provider: Provider.Deepgram,

  match(url: URL): boolean {
    return url.hostname === "api.deepgram.com";
  },

  readResponseBody(call: ExtractorCall): boolean {
    return !SPEAK_PATH.test(call.url.pathname);
  },

  extractUsage(body: unknown, call?: ExtractorCall): NormalizedUsage | null {
    if (!succeeded(call)) return null;
    const path = call.url.pathname;
    if (SPEAK_PATH.test(path)) {
      const text = asRecord(call.requestBody)?.["text"];
      return typeof text === "string" ? unitUsage({ characters: countCharacters(text) }) : null;
    }
    if (LISTEN_PATH.test(path)) {
      const audioSeconds = asCount(asRecord(asRecord(body)?.["metadata"])?.["duration"]);
      return audioSeconds != null ? unitUsage({ audioSeconds }) : null;
    }
    return null;
  },

  extractModel(_requestBody: unknown, _responseBody: unknown, call?: ExtractorCall): string | null {
    if (!call) return null;
    const model = call.url.searchParams.get("model")?.trim();
    if (model) return model;
    const path = call.url.pathname;
    if (LISTEN_PATH.test(path)) return DEFAULT_LISTEN_MODEL;
    if (SPEAK_PATH.test(path)) return DEFAULT_SPEAK_MODEL;
    return null;
  },
};
