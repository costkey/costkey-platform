import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostKey } from "../index.js";
import { extractUsageFromSSE, flushPendingCaptures, patchFetch, unpatchFetch } from "../fetch-patch.js";
import { findExtractor } from "../providers/registry.js";
import { googleExtractor } from "../providers/google.js";
import { elevenlabsExtractor } from "../providers/elevenlabs.js";
import { rumikExtractor } from "../providers/rumik.js";
import { exaExtractor } from "../providers/exa.js";
import { firecrawlExtractor } from "../providers/firecrawl.js";
import { typesafeExtractor } from "../providers/more.js";
import type { Transport } from "../transport.js";
import type { ExtractorCall } from "../types.js";

type Event = Record<string, unknown>;

function call(url: string, requestBody: unknown, init: { status?: number; headers?: Record<string, string> } = {}): ExtractorCall {
  return {
    url: new URL(url),
    method: "POST",
    requestBody,
    statusCode: init.status ?? 200,
    responseHeaders: new Headers(init.headers ?? {}),
  };
}

const sse = (...events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

describe("provider registry for native-unit providers", () => {
  it.each([
    ["https://api.elevenlabs.io/v1/text-to-speech/voice", "elevenlabs"],
    ["https://api.us.elevenlabs.io/v1/text-to-speech/voice", "elevenlabs"],
    ["https://api.eu.residency.elevenlabs.io/v1/speech-to-text", "elevenlabs"],
    ["https://silk-api.rumik.ai/v1/tts", "rumik"],
    ["https://api.exa.ai/search", "exa"],
    ["https://api.firecrawl.dev/v2/scrape", "firecrawl"],
    ["https://api.typesafe.ai/v1/chat/completions", "typesafe"],
  ])("matches %s", (url, provider) => {
    expect(findExtractor(new URL(url))?.provider).toBe(provider);
  });

  it("does not match lookalike hosts", () => {
    expect(findExtractor(new URL("https://elevenlabs.io.example.com/v1/text-to-speech/x"))).toBeNull();
    expect(findExtractor(new URL("https://notrumik.ai/v1/tts"))).toBeNull();
  });
});

describe("Gemini grounding units", () => {
  const grounded = {
    candidates: [{
      groundingMetadata: {
        webSearchQueries: ["weather in Pune", "pune forecast", "weather in Pune"],
        groundingChunks: [{ web: { uri: "https://example.com" } }],
      },
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };

  it("counts distinct web search queries and one grounded request", () => {
    expect(googleExtractor.extractUsage(grounded)?.nativeUnits).toEqual({
      searchQueries: 2,
      groundingRequests: 1,
    });
  });

  it("detects Maps grounding from chunks or the widget token", () => {
    const maps = { candidates: [{ groundingMetadata: { groundingChunks: [{ maps: { title: "Cafe" } }] } }] };
    expect(googleExtractor.extractUsage(maps)?.nativeUnits).toEqual({ mapsGroundingRequests: 1 });
    const widget = { candidates: [{ groundingMetadata: { googleMapsWidgetContextToken: "tok" } }] };
    expect(googleExtractor.extractUsage(widget)?.nativeUnits).toEqual({ mapsGroundingRequests: 1 });
  });

  it("counts grounding from search chunks without query strings", () => {
    const body = { candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: "https://a" } }] } }] };
    expect(googleExtractor.extractUsage(body)?.nativeUnits).toEqual({ groundingRequests: 1 });
  });

  it("leaves ungrounded responses without native units", () => {
    expect(googleExtractor.extractUsage({ usageMetadata: { promptTokenCount: 1 } })).not.toHaveProperty("nativeUnits");
  });

  it("unions queries across stream chunks and keeps the final token counts", () => {
    const text = sse(
      { candidates: [{ groundingMetadata: { webSearchQueries: ["a", "b"] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1 } },
      { candidates: [{ groundingMetadata: { webSearchQueries: ["b", "c"] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 30 } },
    );
    expect(extractUsageFromSSE(text, googleExtractor)).toMatchObject({
      inputTokens: 8,
      outputTokens: 30,
      totalTokens: 38,
      nativeUnits: { searchQueries: 3, groundingRequests: 1 },
    });
  });

  it("reads a streamGenerateContent JSON array (no alt=sse)", () => {
    const text = JSON.stringify([
      { candidates: [{ groundingMetadata: { webSearchQueries: ["q1"] } }] },
      { usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 } },
    ]);
    expect(extractUsageFromSSE(text, googleExtractor)).toMatchObject({
      inputTokens: 4,
      outputTokens: 6,
      nativeUnits: { searchQueries: 1, groundingRequests: 1 },
    });
  });
});

describe("ElevenLabs extractor", () => {
  const tts = "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=mp3_44100_128";

  it("counts request characters as code points with the documented default model", () => {
    const body = { text: "héllo 👋" };
    const c = call(tts, body);
    expect(elevenlabsExtractor.extractUsage(null, c)?.nativeUnits).toEqual({ characters: 7 });
    expect(elevenlabsExtractor.extractModel(body, null, c)).toBe("eleven_multilingual_v2");
    expect(elevenlabsExtractor.extractModel({ ...body, model_id: "eleven_flash_v2_5" }, null, c)).toBe("eleven_flash_v2_5");
  });

  it("prefers the character-cost response header", () => {
    const c = call(tts, { text: "hello" }, { headers: { "character-cost": "42" } });
    expect(elevenlabsExtractor.extractUsage(null, c)?.nativeUnits).toEqual({ characters: 42 });
    const alt = call(tts, { text: "hello" }, { headers: { "x-character-count": "9" } });
    expect(elevenlabsExtractor.extractUsage(null, alt)?.nativeUnits).toEqual({ characters: 9 });
  });

  it("covers every TTS path variant and never reads TTS bodies", () => {
    for (const suffix of ["", "/stream", "/with-timestamps", "/stream/with-timestamps"]) {
      const c = call(`https://api.elevenlabs.io/v1/text-to-speech/voice${suffix}`, { text: "abc" });
      expect(elevenlabsExtractor.extractUsage(null, c)?.nativeUnits).toEqual({ characters: 3 });
      expect(elevenlabsExtractor.readResponseBody!(c)).toBe(false);
    }
  });

  it("does not bill a rejected request", () => {
    expect(elevenlabsExtractor.extractUsage(null, call(tts, { text: "abc" }, { status: 401 }))).toBeNull();
  });

  it("reads speech-to-text duration and model", () => {
    const c = call("https://api.elevenlabs.io/v1/speech-to-text", { model_id: "scribe_v2" });
    expect(elevenlabsExtractor.extractUsage({ text: "hi", audio_duration_secs: 12.5 }, c)?.nativeUnits).toEqual({ audioSeconds: 12.5 });
    expect(elevenlabsExtractor.extractModel(null, null, c)).toBe("scribe_v1");
    expect(elevenlabsExtractor.extractModel({ model_id: "scribe_v2" }, null, c)).toBe("scribe_v2");
    expect(elevenlabsExtractor.readResponseBody!(c)).toBe(true);
  });
});

describe("Rumik extractor", () => {
  it("bills request characters with the default model and never reads audio", () => {
    const c = call("https://silk-api.rumik.ai/v1/tts", { text: "नमस्ते" });
    expect(rumikExtractor.extractUsage(null, c)?.nativeUnits).toEqual({ characters: [..."नमस्ते"].length });
    expect(rumikExtractor.extractModel({ text: "x" }, null)).toBe("mulberry");
    expect(rumikExtractor.extractModel({ model: "mulberry-1.6" }, null)).toBe("mulberry-1.6");
    expect(rumikExtractor.readResponseBody!(c)).toBe(false);
    const input = call("https://silk-api.rumik.ai/v1/tts", { input: "hello" });
    expect(rumikExtractor.extractUsage(null, input)?.nativeUnits).toEqual({ characters: 5 });
  });
});

describe("Exa extractor", () => {
  it("prices searches by type, query and requested results", () => {
    const c = call("https://api.exa.ai/search", { query: "x", type: "deep", numResults: 25 });
    expect(exaExtractor.extractModel(c.requestBody, null, c)).toBe("search-deep");
    expect(exaExtractor.extractUsage({ results: [], costDollars: { total: 0.027 } }, c)).toMatchObject({
      costUsd: 0.027,
      nativeUnits: { searchQueries: 1, searchResults: 25 },
    });
    const instant = call("https://api.exa.ai/search", { query: "x", type: "instant" });
    expect(exaExtractor.extractModel(instant.requestBody, null, instant)).toBe("search-instant");
    expect(exaExtractor.extractUsage({}, instant)?.nativeUnits).toEqual({ searchQueries: 1, searchResults: 10 });
    const reasoning = call("https://api.exa.ai/search", { type: "deep-reasoning" });
    expect(exaExtractor.extractModel(reasoning.requestBody, null, reasoning)).toBe("search-deep-reasoning");
    const auto = call("https://api.exa.ai/search", { type: "auto" });
    expect(exaExtractor.extractModel(auto.requestBody, null, auto)).toBe("search");
  });

  it("maps findSimilar, contents and answer", () => {
    const similar = call("https://api.exa.ai/findSimilar", { url: "https://a", numResults: 5 });
    expect(exaExtractor.extractModel(null, null, similar)).toBe("find-similar");
    expect(exaExtractor.extractUsage({}, similar)?.nativeUnits).toEqual({ searchQueries: 1, searchResults: 5 });

    const contents = call("https://api.exa.ai/contents", { urls: ["a", "b", "c"] });
    expect(exaExtractor.extractModel(null, null, contents)).toBe("contents");
    expect(exaExtractor.extractUsage({ results: [{}, {}, {}] }, contents)?.nativeUnits).toEqual({ pages: 3 });

    const answer = call("https://api.exa.ai/answer", { query: "q" });
    expect(exaExtractor.extractModel(null, null, answer)).toBe("answer");
    expect(exaExtractor.extractUsage({ answer: "a", costDollars: { total: 0.005 } }, answer)).toMatchObject({ costUsd: 0.005 });
    expect(exaExtractor.extractUsage({ answer: "a", costDollars: { total: 0.005 } }, answer)).not.toHaveProperty("nativeUnits");
  });
});

describe("Firecrawl extractor", () => {
  it("names the endpoint after the version segment", () => {
    for (const [path, model] of [
      ["/v2/scrape", "scrape"],
      ["/v2/batch/scrape", "batch-scrape"],
      ["/v2/batch/scrape/abc-123", "batch-scrape"],
      ["/v2/crawl", "crawl"],
      ["/v2/crawl/abc-123", "crawl"],
      ["/v1/map", "map"],
      ["/v2/search", "search"],
      ["/v2/extract", "extract"],
    ]) {
      expect(firecrawlExtractor.extractModel(null, null, call(`https://api.firecrawl.dev${path}`, {}))).toBe(model);
    }
  });

  it("uses reported credits and defaults scrape and map to one", () => {
    const scrape = call("https://api.firecrawl.dev/v2/scrape", { url: "https://a" });
    expect(firecrawlExtractor.extractUsage({ success: true, data: { metadata: { creditsUsed: 5 } } }, scrape)?.nativeUnits).toEqual({ credits: 5 });
    expect(firecrawlExtractor.extractUsage({ success: true, data: { markdown: "x" } }, scrape)?.nativeUnits).toEqual({ credits: 1 });
    const map = call("https://api.firecrawl.dev/v2/map", { url: "https://a" });
    expect(firecrawlExtractor.extractUsage({ success: true, links: [] }, map)?.nativeUnits).toEqual({ credits: 1 });
    expect(firecrawlExtractor.extractUsage({ success: false, error: "bad" }, scrape)).toBeNull();
  });

  it("prices search by query and requested limit", () => {
    const search = call("https://api.firecrawl.dev/v2/search", { query: "q" });
    expect(firecrawlExtractor.extractUsage({ success: true, data: { web: [] } }, search)?.nativeUnits).toEqual({
      searchQueries: 1,
      searchResults: 5,
    });
    const limited = call("https://api.firecrawl.dev/v2/search", { query: "q", limit: 20 });
    expect(firecrawlExtractor.extractUsage({ success: true, creditsUsed: 4 }, limited)?.nativeUnits).toEqual({
      credits: 4,
      searchQueries: 1,
      searchResults: 20,
    });
  });

  it("counts an async job's credits once, on the completed status", () => {
    const start = call("https://api.firecrawl.dev/v2/crawl", { url: "https://a" });
    expect(firecrawlExtractor.extractUsage({ success: true, id: "job" }, start)).toBeNull();
    const poll = call("https://api.firecrawl.dev/v2/crawl/job", null);
    expect(firecrawlExtractor.extractUsage({ status: "scraping", creditsUsed: 3 }, poll)).toBeNull();
    expect(firecrawlExtractor.extractUsage({ status: "completed", creditsUsed: 12 }, poll)?.nativeUnits).toEqual({ credits: 12 });
    const page = call("https://api.firecrawl.dev/v2/crawl/job?skip=10", null);
    expect(firecrawlExtractor.extractUsage({ status: "completed", creditsUsed: 12 }, page)).toBeNull();
  });
});

describe("Typesafe extractor", () => {
  it("reads either token naming and defaults the model", () => {
    expect(typesafeExtractor.extractUsage({ usage: { input_tokens: 30, output_tokens: 12 } })).toMatchObject({
      inputTokens: 30, outputTokens: 12, totalTokens: 42,
    });
    expect(typesafeExtractor.extractUsage({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })).toMatchObject({
      inputTokens: 3, outputTokens: 2, totalTokens: 5,
    });
    expect(typesafeExtractor.extractModel({}, {})).toBe("jev-latest");
    expect(typesafeExtractor.extractModel({ model: "jev-2" }, { model: "other" })).toBe("jev-2");
  });
});

function createMockTransport() {
  const events: Event[] = [];
  return {
    transport: {
      enqueue: (event: Event) => events.push(event),
      start: () => {},
      stop: () => {},
      flush: async () => {},
    } as unknown as Transport,
    events,
  };
}

describe("native-unit calls through the fetch patch", () => {
  let originalFetch: typeof globalThis.fetch;
  let events: Event[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    unpatchFetch();
    globalThis.fetch = originalFetch;
  });

  function patchWith(respond: (url: string, init?: RequestInit) => Response) {
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      respond(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init));
    const mock = createMockTransport();
    events = mock.events;
    patchFetch({
      transport: mock.transport,
      projectId: "units",
      captureBody: false,
      beforeSend: null,
      defaultContext: {},
      debug: false,
    });
  }

  it("records streamed TTS from the request without touching the audio stream", async () => {
    let cancelled = false;
    // Live audio that never ends on its own: reading it would hang capture.
    const audio = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff, 0xfb, 0x90, 0x44]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const providerResponse = new Response(audio, {
      status: 200,
      headers: { "content-type": "audio/mpeg", "character-cost": "11" },
    });
    const clone = vi.spyOn(providerResponse, "clone");
    patchWith(() => providerResponse);

    const response = await globalThis.fetch(
      "https://api.elevenlabs.io/v1/text-to-speech/voice/stream",
      { method: "POST", body: JSON.stringify({ text: "hello world", model_id: "eleven_flash_v2_5" }) },
    );
    await flushPendingCaptures();

    expect(response).toBe(providerResponse);
    expect(clone).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "elevenlabs",
      model: "eleven_flash_v2_5",
      statusCode: 200,
      usage: { nativeUnits: { characters: 11 } },
    });

    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([0xff, 0xfb, 0x90, 0x44]));
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  it("never parses a WAV body even without a content type", async () => {
    const providerResponse = new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), { status: 200 });
    providerResponse.headers.delete("content-type");
    const clone = vi.spyOn(providerResponse, "clone");
    patchWith(() => providerResponse);

    await globalThis.fetch("https://silk-api.rumik.ai/v1/tts", {
      method: "POST",
      body: JSON.stringify({ text: "Namaste", model: "mulberry-1.6" }),
    });
    await flushPendingCaptures();

    expect(clone).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ provider: "rumik", model: "mulberry-1.6", usage: { nativeUnits: { characters: 7 } } });
  });

  it("does not clone binary responses from JSON providers", async () => {
    const providerResponse = new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
    const clone = vi.spyOn(providerResponse, "clone");
    patchWith(() => providerResponse);
    await globalThis.fetch("https://api.firecrawl.dev/v2/scrape", { method: "POST", body: "{}" });
    await flushPendingCaptures();
    expect(clone).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ provider: "firecrawl", model: "scrape", usage: { nativeUnits: { credits: 1 } } });
  });

  it("reads the speech-to-text model from a multipart form", async () => {
    patchWith(() => new Response(JSON.stringify({ text: "hi", audio_duration_secs: 3.2 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const form = new FormData();
    form.append("model_id", "scribe_v1_experimental");
    form.append("file", new Blob([new Uint8Array([1, 2, 3])]), "audio.wav");
    await globalThis.fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", body: form });
    await flushPendingCaptures();
    expect(events[0]).toMatchObject({
      provider: "elevenlabs",
      model: "scribe_v1_experimental",
      usage: { nativeUnits: { audioSeconds: 3.2 } },
    });
  });

  it("does not bill characters for a rejected TTS request", async () => {
    patchWith(() => new Response(JSON.stringify({ detail: "quota" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));
    await globalThis.fetch("https://api.elevenlabs.io/v1/text-to-speech/voice", {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    });
    await flushPendingCaptures();
    expect(events[0]).toMatchObject({ provider: "elevenlabs", statusCode: 401, usage: null });
  });

  it("keeps Gemini grounding units from a streamed response", async () => {
    const body = sse(
      { candidates: [{ groundingMetadata: { webSearchQueries: ["a"] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 }, modelVersion: "gemini-3-pro" },
      { candidates: [{ groundingMetadata: { webSearchQueries: ["b"], groundingChunks: [{ web: {} }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9 } },
    );
    patchWith(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const response = await globalThis.fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse",
      { method: "POST", body: JSON.stringify({ contents: [] }) },
    );
    expect(await response.text()).toBe(body);
    await flushPendingCaptures();
    expect(events[0]).toMatchObject({
      provider: "google",
      model: "gemini-3-pro",
      streaming: true,
      usage: { inputTokens: 5, outputTokens: 9, nativeUnits: { searchQueries: 2, groundingRequests: 1 } },
    });
  });

  it("treats an event-stream response as a stream even without stream:true", async () => {
    const body = sse({ answer: "Par" }, { answer: "is" }, { citations: [], costDollars: { total: 0.005 } });
    const providerResponse = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    const clone = vi.spyOn(providerResponse, "clone");
    patchWith(() => providerResponse);
    const response = await globalThis.fetch("https://api.exa.ai/answer", {
      method: "POST",
      body: JSON.stringify({ query: "capital of France" }),
    });
    expect(await response.text()).toBe(body);
    await flushPendingCaptures();
    expect(clone).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ provider: "exa", model: "answer", streaming: true, costUsd: 0.005 });
  });

  it("records a cancelled stream with the usage seen so far", async () => {
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse({ type: "message_start", message: { model: "claude-x", usage: { input_tokens: 40, output_tokens: 1 } } })));
      },
    });
    patchWith(() => new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const response = await globalThis.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-x", stream: true, messages: [] }),
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await flushPendingCaptures();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: "anthropic", streaming: true, usage: { inputTokens: 40 } });
  });
});

describe("native units on the wire", () => {
  let originalFetch: typeof globalThis.fetch;
  let payloads: Array<{ events: Event[] }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    payloads = [];
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://costkey.dev/api/v1/events") {
        payloads.push(JSON.parse(String(init?.body)) as { events: Event[] });
        return new Response("{}", { status: 202 });
      }
      if (url.startsWith("https://api.exa.ai/")) {
        return new Response(JSON.stringify({ requestId: "exa-req", results: [], costDollars: { total: 0.012 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    };
  });

  afterEach(async () => {
    await CostKey.shutdown();
    globalThis.fetch = originalFetch;
  });

  it("sends usage.nativeUnits and the provider-reported cost", async () => {
    CostKey.init({ dsn: "https://ck_test@costkey.dev/units-wire", captureBody: false });
    await CostKey.withContext({ task: "research" }, () =>
      fetch("https://api.exa.ai/search", {
        method: "POST",
        body: JSON.stringify({ query: "llm pricing", type: "deep", numResults: 15 }),
      }));
    await CostKey.flush();

    const sent = payloads.flatMap((payload) => payload.events).find((event) => event["eventType"] === "call");
    expect(sent).toMatchObject({
      provider: "exa",
      model: "search-deep",
      costUsd: 0.012,
      context: { task: "research" },
      usage: { costUsd: 0.012, nativeUnits: { searchQueries: 1, searchResults: 15 } },
    });
  });
});
