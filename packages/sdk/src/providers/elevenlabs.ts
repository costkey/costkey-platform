import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage, ExtractorCall } from "./types.js";
import { asCount, asRecord, countCharacters, headerCount, succeeded, unitUsage } from "./units.js";

/** /v1/text-to-speech/{voice} plus /stream, /with-timestamps and /stream/with-timestamps */
const TTS_PATH = /^\/v\d+\/text-to-speech\/[^/]+(?:\/stream)?(?:\/with-timestamps)?\/?$/;
const STT_PATH = /^\/v\d+\/speech-to-text\/?$/;

const DEFAULT_TTS_MODEL = "eleven_multilingual_v2";
const DEFAULT_STT_MODEL = "scribe_v1";

/**
 * ElevenLabs — api.elevenlabs.io, api.us.elevenlabs.io and other regional
 * *.elevenlabs.io hosts. Text-to-speech bills characters: the
 * `character-cost` response header when present, else the request text. TTS
 * responses are audio (or audio inside timestamped JSON) and are never read.
 */
export const elevenlabsExtractor: ProviderExtractor = {
  provider: Provider.ElevenLabs,

  match(url: URL): boolean {
    return url.hostname.endsWith(".elevenlabs.io");
  },

  readResponseBody(call: ExtractorCall): boolean {
    return !TTS_PATH.test(call.url.pathname);
  },

  extractUsage(body: unknown, call?: ExtractorCall): NormalizedUsage | null {
    if (!succeeded(call)) return null;
    const path = call.url.pathname;

    if (TTS_PATH.test(path)) {
      const text = asRecord(call.requestBody)?.["text"];
      const characters =
        headerCount(call.responseHeaders, "character-cost", "x-character-count") ??
        (typeof text === "string" ? countCharacters(text) : null);
      return characters != null ? unitUsage({ characters }) : null;
    }

    if (STT_PATH.test(path)) {
      const audioSeconds = asCount(asRecord(body)?.["audio_duration_secs"]);
      return audioSeconds != null ? unitUsage({ audioSeconds }) : null;
    }

    return null;
  },

  extractModel(requestBody: unknown, _responseBody: unknown, call?: ExtractorCall): string | null {
    const model = asRecord(requestBody)?.["model_id"];
    if (typeof model === "string" && model.trim()) return model.trim();
    const path = call?.url.pathname ?? "";
    if (TTS_PATH.test(path)) return DEFAULT_TTS_MODEL;
    if (STT_PATH.test(path)) return DEFAULT_STT_MODEL;
    return null;
  },
};
