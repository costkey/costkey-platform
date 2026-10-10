import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage, ExtractorCall } from "./types.js";
import { asRecord, countCharacters, succeeded, unitUsage } from "./units.js";

const DEFAULT_MODEL = "mulberry";

/**
 * Rumik Silk — *.rumik.ai (e.g. silk-api.rumik.ai/v1/tts). Bills characters
 * of the request text; the response is WAV audio and is never read.
 */
export const rumikExtractor: ProviderExtractor = {
  provider: Provider.Rumik,

  match(url: URL): boolean {
    return url.hostname.endsWith(".rumik.ai");
  },

  readResponseBody(): boolean {
    return false;
  },

  extractUsage(_body: unknown, call?: ExtractorCall): NormalizedUsage | null {
    if (!succeeded(call)) return null;
    const request = asRecord(call.requestBody);
    const text = typeof request?.["text"] === "string"
      ? request["text"]
      : typeof request?.["input"] === "string"
        ? request["input"]
        : null;
    return text != null ? unitUsage({ characters: countCharacters(text) }) : null;
  },

  extractModel(requestBody: unknown): string | null {
    const model = asRecord(requestBody)?.["model"];
    return typeof model === "string" && model.trim() ? model.trim() : DEFAULT_MODEL;
  },
};
