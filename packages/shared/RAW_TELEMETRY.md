# Raw telemetry contract (v1)

**Rule: SDKs only send telemetry. The server does all processing.**

An SDK patches transports and framework hooks, captures what happened, and
sends it. It never prices, normalizes usage, counts tokens or characters,
infers models or providers, picks defaults, dedupes, aggregates, scores,
classifies errors or filters stack frames. All of that happens on the server,
which also keeps accepting the older normalized fields from SDK 0.6.x.

The only transformations an SDK may apply are:

1. **Content removal** (the skeleton below), so metadata-only projects never
   ship prompt or response text.
2. **Secret removal**: credentials are scrubbed from URLs and headers.
3. **Size caps**, so a payload can't grow without bound.

## Call events: the `telemetry` field

Every captured provider call carries `telemetry`, in every capture mode. It is
never content: strings are replaced by their length unless the key is
allowlisted.

```jsonc
"telemetry": {
  "v": 1,
  "request": {
    "method": "POST",
    "url": "https://api.openai.com/v1/chat/completions", // secrets stripped from the query, as sanitizeTelemetryUrl does today
    "headers": { "content-type": "application/json", "anthropic-version": "2023-06-01" }, // allowlist below
    "body": { /* skeleton */ },     // or null, {"$bytes": n} for binary, {"$multipart": [...]} for forms
    "bytes": 1840
  },
  "response": {
    "status": 200,
    "headers": { "x-request-id": "req_..", "x-amzn-bedrock-input-token-count": "120" }, // all response headers except the denylist
    "body": { /* skeleton */ },     // null when streamed
    "bytes": 912
  },
  "stream": {                       // null when not streamed
    "format": "sse",                // "sse" | "ndjson" | "json-array" | "aws-eventstream"
    "chunks": [ { /* skeleton */ } ],
    "chunkCount": 214,
    "firstChunkMs": 412.5,          // ms from request start to the first chunk
    "lastChunkMs": 3120.2
  },
  "error": null,                    // or { "name": "AbortError", "code": "ECONNRESET" } (never the message)
  "startedAt": "2026-10-11T09:00:00.000Z",
  "durationMs": 3121.4
}
```

### Skeleton rules (identical in TypeScript and Python)

Apply recursively to the request body, the response body and each stream chunk:

- **Objects**: keep every key and skeletonize the values. At depth 12, replace
  the value with `{"$trunc": true}`.
- **Strings**: keep the value verbatim only if its key is in `KEEP_STRING_KEYS`
  and it is at most 200 characters. Otherwise replace it with `{"$s": N}`, where
  N is its length in Unicode code points. This lets the server count characters
  without the text ever leaving the process.
- **Numbers, booleans and null**: verbatim.
- **Arrays**: up to 32 items, skeletonize every item. Over 32, keep the first 8
  items skeletonized, then append `{"$more": <remaining count>}`. This means
  embedding vectors don't ship.
- **Multipart bodies**: `{"$multipart": [{ "name": "file", "filename": {"$s": 12}, "contentType": "audio/wav", "bytes": 88211 }, { "name": "model", "value": "whisper-1" }]}`.
  A text field's value follows the string rule above, using its field name as
  the key.
- **Binary bodies** (audio, images, octet-stream): `{"$bytes": n}`.
- **Size cap**: if a serialized skeleton exceeds 64 KB, truncate the deepest
  subtrees first (`{"$trunc": true}`) until it fits.

`KEEP_STRING_KEYS` (exact key match):

```
model, model_id, modelId, modelVersion, id, object, type, status, finish_reason, stop_reason,
finishReason, service_tier, system_fingerprint, responseId, request_id, requestId, search_depth,
topic, output_format, response_format, encoding, language, language_code, voice_id, size, quality,
style, mode, operation, event, provider, modality, tier, currency, unit, job_id, jobId,
trafficType, created, created_at, speech_model, response_id
```

### Stream chunk caps

Up to 200 chunks, send them all. Over 200, send the first 20 and the last 50,
and `chunkCount` carries the real total. Bedrock event-stream frames are decoded
to their JSON payload (framing only) before the skeleton is taken.

### Header allowlist and denylist

- **Request headers**: send only `content-type`, `anthropic-version`,
  `anthropic-beta`, `openai-beta`, `x-goog-api-client` and `x-stainless-lang`.
- **Response headers**: send everything except `set-cookie`, `cookie`,
  `authorization`, `proxy-authorization`, `x-api-key`, `api-key`, and any header
  whose name contains `token` unless it is a count header (contains `count`).
  Keys are lowercased.

## What moves to the server

| Was in the SDK | Server owns it now |
|---|---|
| Provider detection beyond "is this a host we capture" | From `request.url` |
| Model, request model, default model names | From the skeletons and the URL |
| Usage: tokens, totals, cache, reasoning, native units, character counts (from `$s` lengths), search and grounding counts, page and credit counts | Per-provider extractors over the skeletons and headers |
| Stream usage merging, ttft, tps | From `stream` |
| Job-poll and completed-GET dedup (Firecrawl, AssemblyAI) | Server rules |
| Error classification (AbortError → cancelled, non-2xx usage) | From `error` and `response.status` |
| Request ids, charge ids | From headers and skeletons |
| Stack frame filtering | The SDK sends every frame raw; the server filters |
| Usage-bound estimates for admission | The SDK sends the request skeleton to `/admit`; the server estimates |
| `recordUsage` dedup and revision fences | Server only (already exists) |
| LiveKit row classification and aggregation | The SDK sends raw rows (skeleton); the server classifies and sums |
| Python call-graph scores | The SDK sends raw functions and edges; the server scores |
| Quality scores (`score()`) | Removed from the SDKs. Quality checks run on the server |
| Pricing (`register_pricing`), client extractors (`registerExtractor`, runtime extractors) | Removed from the SDKs. Custom extractors are server config |

## Settled details

1. **URL query strings**: keep the query, but drop any parameter whose name
   matches, case-insensitively, `key`, `api_key`, `apikey`, `api-key`, `token`,
   `access_token`, `auth*`, `sig`, `signature`, `x-amz-*` or `code`. Keeping
   the rest matters because Deepgram's `model=` and Gemini's `alt=sse` live in
   the query.
2. **Depth 12** applies to objects and arrays. Scalars at that depth are kept.
3. **Strings inside arrays** have no key, so they always become `{"$s": N}`.
4. **Bedrock event streams**: each chunk is `{"<event-type>": payload}`. A
   base64 `bytes` field is decoded to its JSON before the skeleton is taken.
   That decoding is framing, not processing.
5. **NaN and Infinity** are sent as `null`.
6. **Python call graph** upload: `functions` is keyed `"path:function"`, and
   each value is `{ "line": n, "callees": ["path:function", ...], "callExpressions": ["client.chat.completions.create", ...] }`.
   The server computes fan-in, distances and scores, and decides which
   expressions are AI calls. The old scored payload is still accepted.
7. **Errors**: `error.name` is the raw exception class or JS error name, such
   as `AbortError` or `CancelledError`. Spans and lifecycle events carry the
   same raw `errorName`. The server maps it to failed or cancelled.
8. **Claude Agent SDK** usage events set `telemetry.source = "claude-agent-sdk"`
   and put the skeleton of the raw message, usage block included, in
   `telemetry.response.body`, with `request` null.
9. **OpenTelemetry bridge**: spans carry `attributes.otel` with the raw OTel
   attributes, plus `otelKind`, `otelName` and the scope name. The server maps
   GenAI semantic conventions.

## Compatibility

When an event has no `telemetry`, the server falls back to the legacy
normalized fields (`usage`, `model`, `costUsd`, `streamTiming`, …) exactly as
it does today. When both are present, `telemetry` wins.
