---
sidebar_position: 3
title: TypeScript SDK
description: Full API reference for the CostKey TypeScript/Node.js SDK.
---

# TypeScript SDK

The CostKey TypeScript SDK patches `globalThis.fetch` in Node.js to observe
supported provider endpoints. SDKs that use this fetch path can work when their
endpoint and response shape are covered; see the [developer capability
matrix](/recipes#capability-matrix). No provider-routing gateway is required.

```bash
npx costkey setup
```

**Current version:** 0.6.0

`npx costkey setup` logs you in, creates a CostKey project, writes `COSTKEY_DSN`, detects frameworks like Next.js, Vite, Express, Fastify, Hono, Koa, NestJS, Remix, Astro, and SvelteKit, and writes `.costkey/setup.md`.

For no-code server preloading, use:

```bash
NODE_OPTIONS=--import costkey/register npm start
```

Bundled apps such as Next.js, Vite, Remix, Astro, and SvelteKit should also configure [sourcemaps](/sourcemaps) so production stack traces resolve to original source.

## How it works

When you call `CostKey.init()`, the SDK replaces `globalThis.fetch` with a
wrapper. It checks the URL hostname against known provider endpoints. Other
requests pass through; matched AI requests are observed for timing, usage, and
stack traces. The wrapper and response inspection add work, so benchmark your
runtime instead of assuming the work is free.

The SDK leaves provider response data available to your application. For
supported OpenAI-compatible streaming requests it may add the usage-inclusion
option needed to observe a final usage chunk, and it removes explicit CostKey
carrier headers before the provider request. Events are batched and sent in the
background.

Capture mode is negotiated from the DSN-authenticated project configuration.
The SDK starts metadata-only until that response is known; a remote
metadata-only setting, revoked configuration, or failed config request keeps
prompt/response content off without blocking the provider call. A local
`captureBody: false` is always an opt-out. Existing projects retain text
capture only when the server explicitly reports text capture enabled.

## Using with Sentry, New Relic, or other APM tools

CostKey coexists with other tools that patch `fetch` (Sentry, New Relic, Datadog). Each tool wraps the previous one.

**Initialize CostKey after your APM tool:**

```typescript
import * as Sentry from '@sentry/node'
Sentry.init({ dsn: '...' })  // Sentry patches fetch first

import { CostKey } from 'costkey'
CostKey.init({ dsn: '...' })  // CostKey wraps Sentry's patch
```

**What to know:**
- CostKey does not replace provider credentials or route the call through a
  gateway; supported stream/carrier bookkeeping can adjust the outgoing
  request as described above
- CostKey catches its own capture/delivery failures; provider errors still
  remain visible to your application
- Stack traces may be slightly deeper (CostKey filters its own frames automatically)
- Streaming responses flow through both tools while CostKey observes the
  stream; measure the overhead in your runtime

## API Reference

### `CostKey.init()`

Initialize the SDK. Call once at app startup, before any AI calls.

```typescript
import { CostKey } from 'costkey'

CostKey.init({
  dsn: 'https://ck_your_key@app.costkey.dev/your_project_id',
  captureBody: true, // local permission; project capture mode still controls text
  debug: false,
  release: 'v1.2.3',
  maxBatchSize: 50,
  flushInterval: 5000,
  defaultContext: { environment: 'production' },
  beforeSend: myHook,
})
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dsn` | `string \| undefined` | `COSTKEY_DSN` | DSN from the dashboard. Format: `https://<key>@app.costkey.dev/<project-id>`; omitting both values leaves the SDK in no-op/test mode. |
| `captureBody` | `boolean` | `true` | Local permission for request/response body capture; the project config must explicitly enable text capture. `false` is always strongest. |
| `beforeSend` | `BeforeSendHook` | `null` | Hook called before each event is sent. Return `null` to drop the event. |
| `maxBatchSize` | `number` | `50` | Maximum events to buffer before flushing. |
| `flushInterval` | `number` | `5000` | Milliseconds between automatic flushes. |
| `debug` | `boolean` | `false` | Enable debug logging to console. |
| `defaultContext` | `EventContext` | `{}` | Default context applied to every event. |
| `release` | `string` | `undefined` | Release version. Used for [sourcemap translation](/sourcemaps). |
| `beforeSendEvent` | `BeforeSendEventHook` | `null` | Hook for lifecycle and explicit-usage events; return `null` to drop one. |
| `configRefreshInterval` | `number` | `60000` | Milliseconds between DSN project capture/provider config refreshes; runtime config is fetched asynchronously. |
| `policy` | `PolicyOptions` | `undefined` | Optional explicit monitor/enforce admission integration; omitted means observation only. |

### `CostKey.withContext()`

Run a function with CostKey context. Supported provider calls inside are tagged
with the provided metadata. Uses Node.js `AsyncLocalStorage` so it works across
async boundaries.

```typescript
await CostKey.withContext({ task: 'summarize', team: 'search' }, async () => {
  await openai.chat.completions.create({ ... })
})
```

Keys the console groups by include `feature`, `task`, `service`, `customer`,
`userId` and `conversationId`. Agent spans set `agent`, `tool` and `spanId` for
you.

Contexts nest. Inner contexts merge with (and override) outer contexts:

```typescript
await CostKey.withContext({ team: 'search' }, async () => {
  await CostKey.withContext({ task: 'classify' }, async () => {
    // AI calls here have team="search", task="classify"
    await classifyIntent(query)
  })

  await CostKey.withContext({ task: 'summarize' }, async () => {
    // AI calls here have team="search", task="summarize"
    await summarize(results)
  })
})
```

### `CostKey.startTrace()`

Group observed provider calls within a function under one trace ID. Traces
appear in the dashboard's Traces tab.

```typescript
await CostKey.startTrace({ name: 'POST /api/search' }, async () => {
  const intent = await classifyIntent(query)
  const results = await search(query, intent)
  const summary = await summarize(results)
  // Supported calls grouped as one trace
})
```

Parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `string` | `undefined` | Human-readable trace name shown in dashboard. |
| `traceId` | `string` | `undefined` | Custom trace ID. Auto-generated if not provided. |

### Agent spans

`CostKey.agent()`, `CostKey.step()`, `CostKey.tool()` and `CostKey.startSpan()`
record an agent run as a tree. Calls inside a span are attributed to it. See
[Agents and tools](/agents) for kinds, framework integrations and resuming a
paused run.

```typescript
await CostKey.agent('dash', async (span) => {
  span.setAttribute('model', 'gpt-5.1')
  await CostKey.tool('get_holdings', () => holdings(userId))
})
```

| Method | Description |
|--------|-------------|
| `agent(name, fn, options?)` | An agent run. |
| `step(name, fn, options?)` | One turn of an agent loop. |
| `tool(name, fn, options?)` | A tool call. |
| `startSpan({ name, kind, attributes, input }, fn)` | Any span kind. |
| `instrumentTools(tools)` | Wrap each tool's `execute` in a tool span (AI SDK, Mastra). |

The callback receives a handle with `id`, `traceId`, `setAttribute(key, value)`
and `setOutput(value)`.

### Grouped executions and explicit usage

The workspace source also exposes grouped execution, explicit usage, and
allowlisted context-carrier helpers. Check the installed package version and
the [recipes release note](/recipes#status-at-a-glance) before using these
helpers in an application.

```typescript
await CostKey.startExecution(
  {
    name: 'nightly-document-import',
    kind: 'batch',
    expectedItems: itemIds.length,
    configuration: { parser: 'v2' },
  },
  () => runItems(),
)

await CostKey.recordUsage({
  id: 'voice:tts:session-42:r1',
  componentId: 'voice:tts:session-42',
  chargeId: 'voice:tts:session-42',
  revision: 1,
  aggregation: 'cumulative',
  provider: 'speech-provider',
  model: 'speech-model',
  usage: { audioSeconds: 2.1, characters: 320 },
  context: CostKey.getCurrentContext(),
})

// Attach only to a trusted service/queue request. It is not automatic.
const carrierHeaders = CostKey.exportContextHeaders()
```

`recordUsage` requires a caller-supplied event ID (preserved as the explicit
event/caller identity) and monotonic revision. A
`cumulative` snapshot is the full component value: the latest accepted revision
supersedes an earlier one, while a duplicate revision is idempotent rather than
added again. A missing amount or pricing identity remains unknown.
`startExecution` emits lifecycle records and keeps a stable group name separate
from its fresh execution ID.

### `recordLiveKitUsage()`

The source SDK includes an explicit adapter for LiveKit's cumulative
`ev.usage.modelUsage` callback. It records one component per provider/model and
preserves native units; it does not intercept LiveKit WebRTC/audio traffic.
Verify the installed package exports this adapter before using it:

```typescript
import { recordLiveKitUsage } from 'costkey'

session.on(voice.AgentSessionEventTypes.SessionUsageUpdated, async (ev) => {
  await recordLiveKitUsage(ev, {
    sessionId,
    revision: nextSnapshotRevision(),
    executionId,
    expectedComponents: ['stt', 'llm', 'tts'],
  })
})
```

LiveKit's Node durations are milliseconds; map amounts only when the
application has an explicit provider-reported amount or pricing identity.
Missing components and missing prices remain visible as partial/unknown.

### `CostKey.flush()`

Flush all pending events without shutting down.

```typescript
await CostKey.flush()
```

### `CostKey.shutdown()`

Flush all pending events, stop the background timer, and restore the original `fetch`. Call before process exit.

```typescript
await CostKey.shutdown()
```

### `CostKey.getCurrentContext()`

Get the current context from the nearest `withContext` or `startTrace` scope.

```typescript
const ctx = CostKey.getCurrentContext()
console.log(ctx.traceId) // current trace ID, if any
```

### `CostKey.getCurrentTraceId()`

Get the current trace ID if inside a `startTrace` scope.

```typescript
const traceId = CostKey.getCurrentTraceId()
```

### `CostKey.registerExtractor()`

Register a custom provider extractor for AI providers not in the built-in list.

```typescript
import { CostKey, Provider } from 'costkey'
import type { ProviderExtractor, NormalizedUsage } from 'costkey'

const myExtractor: ProviderExtractor = {
  provider: Provider.Unknown,

  match(url: URL): boolean {
    return url.hostname === 'api.myprovider.com'
  },

  extractUsage(body: unknown): NormalizedUsage | null {
    const b = body as Record<string, any>
    const usage = b?.usage
    if (!usage) return null
    return {
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      totalTokens: usage.total_tokens ?? null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    }
  },

  extractModel(requestBody: unknown, responseBody: unknown): string | null {
    const resp = responseBody as Record<string, any>
    if (resp?.model) return resp.model
    const req = requestBody as Record<string, any>
    if (req?.model) return req.model
    return null
  },
}

CostKey.registerExtractor(myExtractor)
```

## Streaming support

For supported provider endpoints, CostKey detects streaming responses
(`stream: true` in the request body) and wraps the response's `ReadableStream`
to capture metrics while yielding chunks as they are read. This does not extend
coverage to arbitrary voice, WebSocket, or other non-HTTP transports.

Captured streaming metrics:

- **TTFT** (Time to First Token) — ms before the first chunk
- **Tokens/sec** — output token throughput
- **Stream duration** — total ms from request to last chunk
- **Chunk count** — number of SSE chunks

Usage data is extracted from the final SSE chunk (where providers include the `usage` field).

### OpenAI streaming

```typescript
import { CostKey } from 'costkey'
import OpenAI from 'openai'

CostKey.init({ dsn: 'https://ck_key@app.costkey.dev/proj_id' })

const openai = new OpenAI()

const stream = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Write a haiku about TypeScript' }],
  stream: true,
})

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content
  if (content) process.stdout.write(content)
}
```

### Anthropic streaming

```typescript
import { CostKey } from 'costkey'
import Anthropic from '@anthropic-ai/sdk'

CostKey.init({ dsn: 'https://ck_key@app.costkey.dev/proj_id' })

const anthropic = new Anthropic()

const stream = anthropic.messages.stream({
  model: 'claude-sonnet-4-5-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Write a haiku about TypeScript' }],
})

for await (const event of stream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    process.stdout.write(event.delta.text)
  }
}
```

## Express middleware

Auto-trace every HTTP request so supported provider calls within a request
handler are grouped.

```typescript
import express from 'express'
import { CostKey } from 'costkey'
import OpenAI from 'openai'

const app = express()
const openai = new OpenAI()

CostKey.init({ dsn: 'https://ck_key@app.costkey.dev/proj_id' })

// Trace middleware — groups supported provider calls per request
app.use((req, res, next) => {
  CostKey.startTrace({ name: `${req.method} ${req.path}` }, () => {
    next()
  })
})

app.post('/api/search', async (req, res) => {
  const { query } = req.body

  // Supported provider calls here are grouped under one trace
  const intent = await classifyIntent(query)
  const results = await search(query, intent)
  const summary = await summarize(results)

  res.json({ summary })
})

// Flush on shutdown
process.on('SIGTERM', async () => {
  await CostKey.shutdown()
  process.exit(0)
})

app.listen(3000)
```

## Explicit trace propagation

CostKey does not add context headers to arbitrary outbound requests. For a
trusted service or queue, explicitly attach the allowlisted carrier:

```typescript
const headers = CostKey.exportContextHeaders()
await fetch("https://internal-worker.example/run", { headers })
```

At the destination, pass the serialized `x-costkey-context` value to
`CostKey.withContext(...)` (or the equivalent Python mapping). CostKey removes
its carrier headers before making a provider request. This explicit handoff is
not a guarantee of complete distributed propagation.

## `beforeSend` hook

Modify or drop events before they are sent.

```typescript
import { CostKey } from 'costkey'
import type { CostKeyEvent } from 'costkey'

CostKey.init({
  dsn: 'https://ck_key@app.costkey.dev/proj_id',
  beforeSend: (event: CostKeyEvent): CostKeyEvent | null => {
    // Drop test events
    if (event.model?.includes('test')) return null

    // Add environment tag
    event.context.environment = 'production'

    // Remove request body to save bandwidth
    event.requestBody = null

    return event
  },
})
```

## Sourcemaps

For production builds with minified/bundled JavaScript, CostKey can translate stack traces back to original source. See the [Sourcemaps guide](/sourcemaps) for setup.

```typescript
CostKey.init({
  dsn: 'https://ck_key@app.costkey.dev/proj_id',
  release: process.env.GIT_SHA,  // Must match the release used during upload
})
```

## Type exports

The SDK exports all relevant types:

```typescript
import type {
  CostKeyOptions,
  CostKeyEvent,
  EventContext,
  BeforeSendHook,
  ProviderExtractor,
  NormalizedUsage,
  CallSite,
  StreamTiming,
} from 'costkey'

import { Provider } from 'costkey'
```
