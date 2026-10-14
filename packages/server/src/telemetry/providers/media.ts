/** Providers billed in native units: speech (characters, audio seconds), search and scraping. */
import type { ExtractCall, ServerExtractor } from "../types.js";
import { arrayLength, asObject, count, isCut, nonEmpty, num, str, strLength } from "../skeleton.js";
import { type NormalizedUsage, unitUsage } from "../usage.js";
import { headerCount, hostIn, lastSegment, succeeded } from "./common.js";

// ── ElevenLabs ──

/** /v1/text-to-speech/{voice} plus /stream, /with-timestamps and /stream/with-timestamps */
const ELEVENLABS_TTS_PATH = /^\/v\d+\/text-to-speech\/[^/]+(?:\/stream)?(?:\/with-timestamps)?\/?$/;
const ELEVENLABS_STT_PATH = /^\/v\d+\/speech-to-text\/?$/;
const TRANSCRIPT_DURATION_KEYS = ["audio_duration_secs", "audio_duration_seconds", "audio_duration", "duration_secs", "duration"];

/** A transcription's audio length: a reported duration, else the last word's end when every word was kept. */
function transcriptSeconds(body: unknown): number | null {
  const response = asObject(body);
  if (!response) return null;
  for (const key of TRANSCRIPT_DURATION_KEYS) {
    const value = count(response[key]);
    if (value != null) return value;
  }
  const transcripts = Array.isArray(response["transcripts"]) ? response["transcripts"] : [response];
  if (isCut(transcripts)) return null;
  let end: number | null = null;
  for (const transcript of transcripts) {
    const words = asObject(transcript)?.["words"];
    if (!Array.isArray(words) || isCut(words)) {
      if (Array.isArray(words)) return null;
      continue;
    }
    for (const word of words) {
      const value = num(asObject(word)?.["end"]);
      if (value != null) end = Math.max(end ?? value, value);
    }
  }
  return end;
}

/**
 * ElevenLabs (*.elevenlabs.io). Text-to-speech bills characters: the
 * `character-cost` response header when present, else the request text's
 * length. Speech-to-text bills audio seconds.
 */
export const elevenlabsExtractor: ServerExtractor = {
  provider: "elevenlabs",
  match: (url) => url.hostname.endsWith(".elevenlabs.io"),
  extractUsage(body, call) {
    if (!succeeded(call)) return null;
    const path = call.url.pathname;
    if (ELEVENLABS_TTS_PATH.test(path)) {
      const characters = headerCount(call.responseHeaders, "character-cost", "x-character-count")
        ?? strLength(asObject(call.requestBody)?.["text"]);
      return characters != null ? unitUsage({ characters }) : null;
    }
    if (ELEVENLABS_STT_PATH.test(path)) {
      const audioSeconds = transcriptSeconds(body);
      return audioSeconds != null ? unitUsage({ audioSeconds }) : null;
    }
    return null;
  },
  // Text-to-speech starts generating as soon as the request arrives, so a
  // request whose response timed out is still billed for its text.
  extractUnansweredUsage(call) {
    if (!ELEVENLABS_TTS_PATH.test(call.url.pathname)) return null;
    const characters = strLength(asObject(call.requestBody)?.["text"]);
    return characters != null ? unitUsage({ characters }) : null;
  },
  extractModel(requestBody, _responseBody, call) {
    const model = nonEmpty(asObject(requestBody)?.["model_id"]);
    if (model) return model;
    const path = call.url.pathname;
    if (ELEVENLABS_TTS_PATH.test(path)) return "eleven_multilingual_v2";
    if (ELEVENLABS_STT_PATH.test(path)) return "scribe_v1";
    return null;
  },
};

// ── Rumik ──

/** Rumik Silk (*.rumik.ai): bills characters of the request text. */
export const rumikExtractor: ServerExtractor = {
  provider: "rumik",
  match: (url) => url.hostname === "rumik.ai" || url.hostname.endsWith(".rumik.ai"),
  extractUsage(_body, call) {
    if (!succeeded(call)) return null;
    const request = asObject(call.requestBody);
    const characters = strLength(request?.["text"]) ?? strLength(request?.["input"]);
    return characters != null ? unitUsage({ characters }) : null;
  },
  extractModel(requestBody) {
    return nonEmpty(asObject(requestBody)?.["model"]) ?? "mulberry";
  },
};

// ── Deepgram ──

const DEEPGRAM_LISTEN_PATH = /^\/v\d+\/listen\/?$/;
const DEEPGRAM_SPEAK_PATH = /^\/v\d+\/speak\/?$/;

/**
 * Deepgram: pre-recorded speech-to-text bills `metadata.duration` seconds;
 * text-to-speech bills characters of the request `text`. The model is the
 * `model` query parameter.
 */
export const deepgramExtractor: ServerExtractor = {
  provider: "deepgram",
  match: hostIn("api.deepgram.com"),
  extractUsage(body, call) {
    if (!succeeded(call)) return null;
    const path = call.url.pathname;
    if (DEEPGRAM_SPEAK_PATH.test(path)) {
      const characters = strLength(asObject(call.requestBody)?.["text"]);
      return characters != null ? unitUsage({ characters }) : null;
    }
    if (DEEPGRAM_LISTEN_PATH.test(path)) {
      const audioSeconds = count(asObject(asObject(body)?.["metadata"])?.["duration"]);
      return audioSeconds != null ? unitUsage({ audioSeconds }) : null;
    }
    return null;
  },
  extractModel(_requestBody, _responseBody, call) {
    const model = call.url.searchParams.get("model")?.trim();
    if (model) return model;
    const path = call.url.pathname;
    if (DEEPGRAM_LISTEN_PATH.test(path)) return "nova-3";
    if (DEEPGRAM_SPEAK_PATH.test(path)) return "aura-asteria-en";
    return null;
  },
};

// ── AssemblyAI ──

/** GET /v2/transcript/{id}; sub-resources (/sentences, /srt) are excluded. */
const ASSEMBLYAI_TRANSCRIPT_PATH = /^\/v2\/transcript\/[^/]+\/?$/;

/**
 * AssemblyAI: transcription is asynchronous, so audio seconds count once,
 * on the GET that returns the transcript `completed`.
 */
export const assemblyaiExtractor: ServerExtractor = {
  provider: "assemblyai",
  match: hostIn("api.assemblyai.com", "api.eu.assemblyai.com"),
  extractUsage(body, call) {
    const completed = succeeded(call)
      && call.method.toUpperCase() === "GET"
      && ASSEMBLYAI_TRANSCRIPT_PATH.test(call.url.pathname)
      && asObject(body)?.["status"] === "completed";
    if (!completed) return null;
    const audioSeconds = count(asObject(body)?.["audio_duration"]);
    return audioSeconds != null ? unitUsage({ audioSeconds }) : null;
  },
  extractModel(requestBody, responseBody, call) {
    if (!call.url.pathname.startsWith("/v2/transcript")) return null;
    // `speech_model` arrives only when the skeleton allowlist keeps it.
    for (const source of [responseBody, requestBody]) {
      const model = nonEmpty(asObject(source)?.["speech_model"]);
      if (model) return model;
    }
    return "best";
  },
};

// ── Cartesia ──

const CARTESIA_TTS_PATH = /^\/tts\/(?:bytes|sse)\/?$/;

/** Cartesia: text-to-speech bills characters of the request `transcript`. */
export const cartesiaExtractor: ServerExtractor = {
  provider: "cartesia",
  match: hostIn("api.cartesia.ai"),
  extractUsage(_body, call) {
    if (!succeeded(call) || !CARTESIA_TTS_PATH.test(call.url.pathname)) return null;
    const characters = strLength(asObject(call.requestBody)?.["transcript"]);
    return characters != null ? unitUsage({ characters }) : null;
  },
  extractModel(requestBody) {
    return nonEmpty(asObject(requestBody)?.["model_id"]);
  },
};

// ── Exa ──

const EXA_SEARCH_TYPE_MODELS = new Map([
  ["instant", "search-instant"],
  ["deep", "search-deep"],
  ["deep-lite", "search-deep"],
  ["deep-reasoning", "search-deep-reasoning"],
]);

/** Exa: searches priced per query and result count, contents per page; every response reports `costDollars.total`. */
export const exaExtractor: ServerExtractor = {
  provider: "exa",
  match: hostIn("api.exa.ai"),
  extractUsage(body, call) {
    const response = asObject(body);
    const costUsd = count(asObject(response?.["costDollars"])?.["total"]);
    const units: Record<string, number> = {};
    if (succeeded(call)) {
      const op = lastSegment(call.url);
      if (op === "search" || op === "findSimilar") {
        const requested = count(asObject(call.requestBody)?.["numResults"]);
        units["searchQueries"] = 1;
        units["searchResults"] = requested != null && requested > 0 ? requested : 10;
      } else if (op === "contents" && Array.isArray(response?.["results"])) {
        units["pages"] = arrayLength(response["results"]) ?? 0;
      }
    }
    return unitUsage(units, costUsd);
  },
  extractModel(requestBody, _responseBody, call) {
    const op = lastSegment(call.url);
    if (op === "search") {
      const type = str(asObject(requestBody)?.["type"]);
      return (type ? EXA_SEARCH_TYPE_MODELS.get(type) : undefined) ?? "search";
    }
    if (op === "findSimilar") return "find-similar";
    return op || null;
  },
};

// ── Firecrawl ──

/**
 * The endpoint after the version segment: /v2/scrape → scrape,
 * /v2/batch/scrape → batch-scrape. Anything after it (a job id) marks a
 * status request for an async job.
 */
function firecrawlEndpoint(url: URL): { model: string | null; job: boolean } {
  const segments = url.pathname.split("/").filter(Boolean);
  const version = segments.findIndex((segment) => /^v\d+$/.test(segment));
  const rest = version >= 0 ? segments.slice(version + 1) : segments;
  if (rest.length === 0) return { model: null, job: false };
  const width = rest[0] === "batch" && rest.length > 1 ? 2 : 1;
  return { model: rest.slice(0, width).join("-"), job: rest.length > width };
}

/**
 * Firecrawl: bills credits, reported as `creditsUsed`. A job status poll
 * reports the job's running total, so it counts once: on the completed
 * status, and not on later result pages (`skip`).
 */
export const firecrawlExtractor: ServerExtractor = {
  provider: "firecrawl",
  match: hostIn("api.firecrawl.dev"),
  extractUsage(body, call) {
    if (!succeeded(call)) return null;
    const response = asObject(body);
    if (response?.["success"] === false) return null;
    const { model, job } = firecrawlEndpoint(call.url);
    const data = asObject(response?.["data"]);
    const reported = count(response?.["creditsUsed"])
      ?? count(asObject(data?.["metadata"])?.["creditsUsed"])
      ?? count(data?.["creditsUsed"]);
    const units: Record<string, number> = {};
    if (job) {
      if (reported != null && response?.["status"] === "completed" && !call.url.searchParams.has("skip")) {
        units["credits"] = reported;
      }
    } else {
      const credits = reported ?? (model === "scrape" || model === "map" ? 1 : null);
      if (credits != null) units["credits"] = credits;
      if (model === "search") {
        const limit = count(asObject(call.requestBody)?.["limit"]);
        units["searchQueries"] = 1;
        units["searchResults"] = limit != null && limit > 0 ? limit : 5;
      }
    }
    return unitUsage(units);
  },
  extractModel: (_requestBody, _responseBody, call: ExtractCall) => firecrawlEndpoint(call.url).model,
};

// ── Tavily ──

/** Tavily: searches priced per query by depth; `usage.credits` when the request asks for usage. */
export const tavilyExtractor: ServerExtractor = {
  provider: "tavily",
  match: hostIn("api.tavily.com"),
  extractUsage(body, call): NormalizedUsage | null {
    if (!succeeded(call)) return null;
    const units: Record<string, number> = {};
    if (lastSegment(call.url) === "search") units["searchQueries"] = 1;
    const credits = count(asObject(asObject(body)?.["usage"])?.["credits"]);
    if (credits != null) units["credits"] = credits;
    return unitUsage(units);
  },
  extractModel(requestBody, _responseBody, call) {
    const op = lastSegment(call.url);
    if (op === "search") return asObject(requestBody)?.["search_depth"] === "advanced" ? "search-advanced" : "search";
    return op || null;
  },
};

