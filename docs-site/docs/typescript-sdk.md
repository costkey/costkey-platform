---
sidebar_position: 3
title: TypeScript SDK
description: Full API reference for the CostKey TypeScript/Node.js SDK.
---

# TypeScript SDK

The CostKey TypeScript SDK patches `globalThis.fetch` to capture every AI API call. Works with any AI SDK that uses `fetch` under the hood (OpenAI, Anthropic, Google, Vercel AI SDK, etc.).

```bash
npm install costkey
```

**Current version:** 0.2.1

## How it works

When you call `CostKey.init()`, the SDK replaces `globalThis.fetch` with a wrapper. On every fetch call, it checks the URL hostname against known AI providers. Non-AI calls pass through with zero overhead beyond a hostname check. AI calls are intercepted to capture timing, usage, and stack traces.

The SDK never modifies your request or response. Events are batched and sent asynchronously in the background.

## API Reference

### `CostKey.init()`

Initialize the SDK. Call once at app startup, before any AI calls.

```typescript
import { CostKey } from 'costkey'

CostKey.init({
  dsn: 'https://ck_your_key@app.costkey.dev/your_project_id',
  captureBody: true,
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
| `dsn` | `string` | **required** | DSN from the dashboard. Format: `https://<key>@app.costkey.dev/<project-id>` |
| `captureBody` | `boolean` | `true` | Capture request/response bodies. Disable to reduce payload size. |
| `beforeSend` | `BeforeSendHook` | `null` | Hook called before each event is sent. Return `null` to drop the event. |
| `maxBatchSize` | `number` | `50` | Maximum events to buffer before flushing. |
| `flushInterval` | `number` | `5000` | Milliseconds between automatic flushes. |
| `debug` | `boolean` | `false` | Enable debug logging to console. |
| `defaultContext` | `EventContext` | `{}` | Default context applied to every event. |
| `release` | `string` | `undefined` | Release version. Used for [sourcemap translation](/sourcemaps). |

### `CostKey.withContext()`

Run a function with CostKey context. All AI calls inside are tagged with the provided metadata. Uses Node.js `AsyncLocalStorage` so it works across async boundaries.

```typescript
await CostKey.withContext({ task: 'summarize', team: 'search' }, async () => {
  await openai.chat.completions.create({ ... })
})
```

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

Group all AI calls within a function under one trace ID. Traces appear in the dashboard's Traces tab.

```typescript
await CostKey.startTrace({ name: 'POST /api/search' }, async () => {
  const intent = await classifyIntent(query)
  const results = await search(query, intent)
  const summary = await summarize(results)
  // All 3 calls grouped as one trace
})
```

Parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `string` | `undefined` | Human-readable trace name shown in dashboard. |
| `traceId` | `string` | `undefined` | Custom trace ID. Auto-generated if not provided. |

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

CostKey automatically detects streaming responses (`stream: true` in the request body) and wraps the response's `ReadableStream` to capture metrics without any buffering delay. Chunks pass through to your code immediately.

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

Auto-trace every HTTP request so all AI calls within a request handler are grouped.

```typescript
import express from 'express'
import { CostKey } from 'costkey'
import OpenAI from 'openai'

const app = express()
const openai = new OpenAI()

CostKey.init({ dsn: 'https://ck_key@app.costkey.dev/proj_id' })

// Trace middleware — groups all AI calls per request
app.use((req, res, next) => {
  CostKey.startTrace({ name: `${req.method} ${req.path}` }, () => {
    next()
  })
})

app.post('/api/search', async (req, res) => {
  const { query } = req.body

  // All AI calls here are grouped under one trace
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

## Trace propagation

CostKey automatically propagates trace IDs across microservices via HTTP headers (`x-costkey-trace-id`). If Service A calls Service B and both have CostKey initialized, AI calls in both services are grouped under the same trace.

Non-AI fetch calls from within a trace scope automatically include the trace header, so downstream services can join the trace.

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
