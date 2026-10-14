---
sidebar_position: 3
title: TypeScript SDK
description: Full API reference for the CostKey TypeScript/Node.js SDK.
---

# TypeScript SDK

The CostKey TypeScript SDK patches `globalThis.fetch` in Node.js and records
calls to supported provider hosts. SDKs that use this fetch path are covered;
see the [developer capability matrix](/recipes#capability-matrix). No
provider-routing gateway is required.

```bash
npx costkey setup
```

**Current version:** 0.7.0. SDK 0.7 needs CostKey server 0.7 or later. Older
SDKs keep working with the new server.

`npx costkey setup` logs you in, creates a CostKey project, writes `COSTKEY_DSN`, detects frameworks like Next.js, Vite, Express, Fastify, Hono, Koa, NestJS, Remix, Astro, and SvelteKit, and writes `.costkey/setup.md`.

For no-code server preloading, use:

```bash
NODE_OPTIONS=--import costkey/register npm start
```

Bundled apps such as Next.js, Vite, Remix, Astro, and SvelteKit should also configure [sourcemaps](/sourcemaps) so production stack traces resolve to original source.

## How it works

When you call `CostKey.init()`, the SDK replaces `globalThis.fetch` with a
wrapper. It checks the URL hostname against the capture list. Other requests
pass through untouched. For a matched request, the SDK records the request and
response, passes streams through while recording their chunks, captures the
stack, and sends the event in the background. The wrapper adds work, so
benchmark your runtime instead of assuming the work is free.

The SDK leaves provider response data available to your application. On
streamed Chat Completions calls to hosts that need it, it adds
`stream_options.include_usage` so the final chunk reports usage. It also
removes explicit CostKey carrier headers before the provider request.

Capture mode is negotiated from the DSN-authenticated project configuration.
The SDK starts metadata-only until that response is known; a remote
metadata-only setting, revoked configuration, or failed config request keeps
prompt and response text off without blocking the provider call. A local
`captureBody: false` is always an opt-out. Existing projects keep text
capture only when the server explicitly reports text capture enabled.

## What the SDK sends

The SDK only sends telemetry. All processing happens on the server: provider
and model detection, token and character counts, usage extraction, stream
timing, pricing, deduplication, error classification and stack frame
filtering. Pricing and provider fixes ship with the server, without an SDK
upgrade.

Every captured call carries a `telemetry` field with the request and response
as a **skeleton**: every key and number is kept, and every string is replaced
by its length (`{"$s": 42}`) unless it is an identifier such as `model` or
`id`. In a metadata-only project, that skeleton is all that is sent, so prompt
and response text never leave your process. When the project captures text,
the scrubbed, size-limited `requestBody` and `responseBody` are sent as well.

Credentials are removed first: credential query parameters are dropped, only a
short allowlist of request headers is sent, and cookie, authorization and API
key response headers are dropped. Arrays over 32 items keep the first 8, so
embedding vectors don't ship. The full contract is
`packages/shared/RAW_TELEMETRY.md` in the CostKey repository.

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
  gateway. The only change it makes to a request is the stream usage option
  described above.
- CostKey catches its own capture and delivery failures. Provider errors still
  reach your application.
- Stack traces may be deeper because of the wrappers. The SDK sends every
  frame and the server picks the call site.
- Streaming responses flow through both tools while CostKey records the
  stream. Measure the overhead in your runtime.

## Agent frameworks

Integrations for the OpenAI Agents SDK, Vercel AI SDK, Mastra, LangChain.js
and LangGraph.js, the Claude Agent SDK and OpenTelemetry are subpath exports
under `costkey/integrations/*`:

```typescript
import { CostKeyCallbackHandler } from 'costkey/integrations/langchain'

await graph.invoke(input, { callbacks: [new CostKeyCallbackHandler()] })
```

See [Agents and frameworks](/agents) for every integration and how calls are
attributed to spans.

## API Reference

### `CostKey.init()`

Initialize the SDK. Call once at app startup, before any AI calls.

```typescript
import { CostKey } from 'costkey'

CostKey.init({
  dsn: 'http://ck_your_key@localhost:4100/your_project_id',
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
| `dsn` | `string \| undefined` | `COSTKEY_DSN` | DSN from the dashboard. Format: `http(s)://<key>@<your CostKey host>/<project-id>`. Omitting both values leaves the SDK in no-op/test mode. |
| `captureBody` | `boolean` | `true` | Local permission for request/response body capture. The project config must also enable text capture. `false` always wins. |
| `beforeSend` | `BeforeSendHook` | `null` | Hook called before each call event is sent. Return `null` to drop the event. |
| `maxBatchSize` | `number` | `50` | Maximum events to buffer before flushing. |
| `flushInterval` | `number` | `5000` | Milliseconds between automatic flushes. |
| `debug` | `boolean` | `false` | Enable debug logging to console. |
| `defaultContext` | `EventContext` | `{}` | Default context applied to every event. |
| `release` | `string` | `COSTKEY_RELEASE`, then the commit | Release version. Compares deploys in the console, and is used for [sourcemap translation](/sourcemaps). |
| `commit` | `string` | detected | Commit SHA of the running code: `COSTKEY_COMMIT`, then CI variables such as `GITHUB_SHA`, then `.git`. |
| `repository` | `string` | detected | Repository URL, so releases link to their commits: `COSTKEY_REPOSITORY`, then CI variables, then `.git`. |
| `beforeSendEvent` | `BeforeSendEventHook` | `null` | Hook for lifecycle, span and explicit usage events. Return `null` to drop one. |
| `configRefreshInterval` | `number` | `60000` | Milliseconds between DSN project config refreshes (capture mode and custom provider hosts). |
| `policy` | `PolicyOptions` | `undefined` | Optional explicit monitor/enforce admission. Omitted means observation only. |

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

Group provider calls within a function under one trace ID. Traces appear on
the dashboard's Runs page.

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
[Agents and frameworks](/agents) for kinds, framework integrations and resuming
a paused run.

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
  revision: 1,
  aggregation: 'cumulative',
  provider: 'speech-provider',
  model: 'speech-model',
  usage: { audioSeconds: 2.1, characters: 320 },
})

// Attach only to a trusted service/queue request. It is not automatic.
const carrierHeaders = CostKey.exportContextHeaders()
```

`startExecution` emits lifecycle records and keeps a stable group name
separate from its fresh execution ID. `expectedItems`, `completedItems` and
`failedItems` are copied onto both lifecycle events.

`recordUsage` sends the event exactly as you pass it. The server dedupes
repeated IDs and ignores stale revisions. `delta` events are increments;
a `cumulative` event replaces the latest snapshot for its component and is
not summed. A missing amount or price stays unknown.

### `recordLiveKitUsage()`

Send each cumulative LiveKit `SessionUsageUpdated` snapshot as it is. The SDK
sends the snapshot's rows as a skeleton (provider, model, type and every
number) with your options. The server separates the STT, LLM and TTS
components, sums duplicate rows and converts LiveKit's milliseconds. It does
not intercept LiveKit audio or WebRTC traffic.

```typescript
import { recordLiveKitUsage } from 'costkey'

session.on(voice.AgentSessionEventTypes.SessionUsageUpdated, async (ev) => {
  await recordLiveKitUsage(ev, {
    sessionId,
    revision: nextSnapshotRevision(),
    executionId,
    excludeComponents: ['llm'], // when HTTP capture already records the LLM calls
  })
})
```

### `CostKey.instrumentBedrockClient()`

`@aws-sdk/client-bedrock-runtime` sends requests through Node's `http` module,
not `fetch`, so instrument the client once:

```typescript
const bedrock = CostKey.instrumentBedrockClient(new BedrockRuntimeClient({ region: 'us-east-1' }))
```

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

## Custom providers

Hosts that aren't built in are configured on the server, per project. The SDK
picks the hostnames up from the DSN runtime config and captures them like any
other provider. See [Providers](/providers#custom-providers).

## Streaming support

For supported provider endpoints, CostKey wraps the response's
`ReadableStream` and records each chunk as a skeleton while yielding chunks as
they are read. It sends the chunks (up to 200; past that, the first 20 and the
last 50), the real chunk count, and the times of the first and last chunk. The
server works out time to first token, tokens per second and usage from them.
This does not cover WebSocket or other non-HTTP transports.

### OpenAI streaming

```typescript
import { CostKey } from 'costkey'
import OpenAI from 'openai'

CostKey.init({ dsn: 'http://ck_key@localhost:4100/proj_id' })

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

CostKey.init({ dsn: 'http://ck_key@localhost:4100/proj_id' })

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

Trace every HTTP request so supported provider calls within a request
handler are grouped.

```typescript
import express from 'express'
import { CostKey } from 'costkey'
import OpenAI from 'openai'

const app = express()
const openai = new OpenAI()

CostKey.init({ dsn: 'http://ck_key@localhost:4100/proj_id' })

// Trace middleware: groups supported provider calls per request
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

Modify or drop call events before they are sent. Provider, model and usage are
worked out on the server, so the event carries `url`, `context`,
`requestBody`, `responseBody` and the raw `telemetry`, not a model or a cost.

```typescript
import { CostKey } from 'costkey'
import type { CostKeyEvent } from 'costkey'

CostKey.init({
  dsn: 'http://ck_key@localhost:4100/proj_id',
  beforeSend: (event: CostKeyEvent): CostKeyEvent | null => {
    // Drop events from a test environment
    if (event.context.environment === 'test') return null

    // Remove request body content
    event.requestBody = null

    return event
  },
})
```

## Sourcemaps

For production builds with minified/bundled JavaScript, CostKey can translate stack traces back to original source. See the [Sourcemaps guide](/sourcemaps) for setup.

```typescript
CostKey.init({
  dsn: 'http://ck_key@localhost:4100/proj_id',
  release: process.env.GIT_SHA,  // Must match the release used during upload
})
```

## Type exports

```typescript
import type {
  CostKeyOptions,
  CostKeyEvent,
  CallTelemetry,
  EventContext,
  BeforeSendHook,
  BeforeSendEventHook,
  CallSite,
  SpanOptions,
  SpanHandle,
} from 'costkey'
```

## Upgrading from 0.6

0.7.0 makes the SDK telemetry-only. It needs CostKey server 0.7.0 or later;
the server keeps accepting events from 0.6 SDKs.

- Call events carry `telemetry` and no longer have `provider`, `model`,
  `usage`, `costUsd`, `streamTiming`, `requestModel`, `providerRequestId`,
  `chargeId`, `metadata` or `systemPrompt`. A `beforeSend` hook that read them
  should read `event.telemetry` instead.
- `CostKey.score()` and its types are removed. Use
  [quality checks](/quality-checks), which run on the server.
- `CostKey.registerExtractor()`, `ProviderExtractor` and `ExtractorCall` are
  removed. Custom providers are [server configuration](/providers#custom-providers).
- `policy.usageBounds` and `policy.claimedCostUsd` are removed. `/admit`
  receives the request skeleton and the server estimates the bounds.
  Settlement no longer carries `actualUsage` or `actualCostUsd`.
- `recordUsage` no longer dedupes, fences revisions, infers `unitValue` or
  derives `costUsd` from `amount`. `UsageConflictError` is removed.
- `recordLiveKitUsage` sends one raw event per snapshot (it returns one ID)
  instead of classified, summed per-component events.
- Errors carry the raw `errorName` (`AbortError`, `TypeError`). A thrown
  `AbortError` ends a trace as `failed` with `errorName: "AbortError"` and a
  span with status `error`; the server maps it to cancelled.
- `callSite.frames` holds every frame, unfiltered.
- The legacy `Provider` enum is still exported but no longer used.
