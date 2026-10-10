import { Provider } from "../types.js";
import type { ProviderExtractor, NormalizedUsage, ExtractorCall } from "./types.js";
import { asCount, asRecord, succeeded, unitUsage } from "./units.js";

/** GET /v2/transcript/{id}; sub-resources (/sentences, /srt) are excluded. */
const TRANSCRIPT_PATH = /^\/v2\/transcript\/[^/]+\/?$/;
const DEFAULT_MODEL = "best";

function isCompletedTranscript(body: unknown, call: ExtractorCall | undefined): boolean {
  return succeeded(call)
    && call.method.toUpperCase() === "GET"
    && TRANSCRIPT_PATH.test(call.url.pathname)
    && asRecord(body)?.["status"] === "completed";
}

/**
 * AssemblyAI — api.assemblyai.com (and api.eu.assemblyai.com). Transcription
 * is asynchronous: the create call returns `queued`, so audio seconds are
 * counted once the transcript is fetched as `completed`. Other calls are
 * recorded without units.
 */
export const assemblyaiExtractor: ProviderExtractor = {
  provider: Provider.AssemblyAI,

  match(url: URL): boolean {
    return url.hostname === "api.assemblyai.com" || url.hostname === "api.eu.assemblyai.com";
  },

  extractUsage(body: unknown, call?: ExtractorCall): NormalizedUsage | null {
    if (!isCompletedTranscript(body, call)) return null;
    const audioSeconds = asCount(asRecord(body)?.["audio_duration"]);
    return audioSeconds != null ? unitUsage({ audioSeconds }) : null;
  },

  extractModel(requestBody: unknown, responseBody: unknown, call?: ExtractorCall): string | null {
    const path = call?.url.pathname ?? "";
    if (!path.startsWith("/v2/transcript")) return null;
    for (const source of [responseBody, requestBody]) {
      const model = asRecord(source)?.["speech_model"];
      if (typeof model === "string" && model.trim()) return model.trim();
    }
    return DEFAULT_MODEL;
  },
};
