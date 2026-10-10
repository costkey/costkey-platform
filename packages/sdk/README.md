# costkey

> Sentry for AI costs. Observe supported AI calls' cost, tokens, and latency with one line of code.

## Install

```bash
npm install costkey
```

## Quick Start

```typescript
import { CostKey } from 'costkey'

CostKey.init({
  dsn: 'https://ck_your_key@app.costkey.dev/your-project'
})

// Supported provider calls made through fetch are tracked automatically.
```

## How It Works

CostKey patches `globalThis.fetch`. When your code calls a supported provider
endpoint through a supported transport:

1. **Detects** the provider from the URL (see the supported-provider list below)
2. **Extracts** token usage from the response (streaming + non-streaming)
3. **Captures** a stack trace for automatic code attribution
4. **Measures** streaming timing (TTFT, TPS) via SSE wrapping
5. **Ships** the event async to your CostKey dashboard — server calculates cost

Non-AI fetch calls and unsupported provider transports pass through untouched.
Coverage depends on the provider/transport capability matrix; CostKey does not
replace your provider client or route requests through a gateway. Capture and
delivery failures stay inside the SDK; provider errors remain visible to your
application.

## Sourcemaps

For minified production builds, set `release` and upload sourcemaps:

```typescript
CostKey.init({
  dsn: '...',
  release: process.env.GIT_SHA  // matches uploaded sourcemaps
})
```

```bash
# In CI/CD
npx costkey sourcemaps upload \
  --release $GIT_SHA \
  --auth-key $COSTKEY_AUTH_KEY \
  ./dist/*.map
```

## Tracing

```typescript
app.use((req, res, next) => {
  CostKey.startTrace({ name: `${req.method} ${req.path}` }, next)
})
```

`startTrace` emits explicit started/completed/failed lifecycle records. Trace
IDs are generated per invocation, so concurrent requests and nested boundaries
cannot be merged by their stack frames. If a trusted upstream carrier is
already in context, `startTrace()` joins that trace; pass `traceId` explicitly
when a nested boundary is intentionally part of an existing trace.

## Context

```typescript
await CostKey.withContext({ task: 'summarize', team: 'search' }, async () => {
  await openai.chat.completions.create({ ... })
})
```

## Grouped work and explicit usage

Use a stable group name with a fresh execution identity for batches,
experiments, or evals:

```ts
await CostKey.startExecution(
  {
    name: "nightly-document-import",
    kind: "batch",
    expectedItems: 100,
    completedItems: 98,
    failedItems: 2,
  },
  () => importDocuments(),
)
```

`expectedItems`, `completedItems` and `failedItems` are runner-supplied
counts copied onto both execution lifecycle events. CostKey does not infer
completion from inactivity or HTTP status. A nested `startExecution` receives
a fresh execution ID by default; pass `executionId` only when explicitly
resuming or joining an invocation.

For components not observed through supported HTTP integrations, report a
caller-owned component, charge, unique event ID, and revision. `delta` events
are increments; `cumulative` events replace the latest snapshot and are not
summed:

```ts
await CostKey.recordUsage({
  id: "voice-session-42:stt:r7",
  componentId: "voice-session-42:stt",
  provider: "deepgram",
  usage: { audioSeconds: 12.4 },
  aggregation: "cumulative",
  revision: 7,
})
```

For LiveKit Agents, subscribe to the documented
`SessionUsageUpdated` callback and pass its cumulative `usage.modelUsage` list
to the structural `recordLiveKitUsage` adapter. It keeps STT/LLM/TTS provider
and model components separate, converts LiveKit millisecond durations to
`audioSeconds`/`sessionSeconds`, and preserves missing components as partial
coverage. Duplicate rows for the same component/provider/model are aggregated
before identity is assigned, so row order cannot change a charge ID. Use
`components` or `excludeComponents` to make the source of charge explicit; for
example, pass `excludeComponents: ["llm"]` when automatic HTTP capture owns the
LLM calls and the session snapshot owns STT/TTS. It does not intercept LiveKit
audio or WebRTC traffic. If a session snapshot is the verified source of charge
for a provider request that would otherwise be auto-captured, wrap that request
in `CostKey.withContext({ costkeyCapture: "manual" }, fn)` to avoid two charge
records. The adapter emits a `billingUnits` map plus a primary `unitKind` /
`unitValue` where a component has a natural billable unit.

Duplicate `(chargeId, revision)` updates are idempotent. Conflicting revisions
or switching aggregation mode are rejected. Missing usage or amount remains
unknown; it is never treated as zero.

Known retry/fallback relationships are explicit. A provider response exposes
its `providerRequestId` and the SDK gives every attempt a distinct `attemptId`.
When the application knows that one attempt replaces another, scope that
attempt with `CostKey.withContext({ attemptId, parentEventId }, fn)` or supply
the same fields to `recordUsage`. The SDK never links two calls merely because
they share a trace, model, function, or timestamp.

## Explicit enforcement

Installing or initializing CostKey does not block provider calls. To opt into
the DSN-authenticated admission endpoint, configure an explicit enforced policy
with a verified integration proof and honest upper bounds:

```ts
CostKey.init({
  dsn: process.env.COSTKEY_DSN,
  policy: {
    mode: "enforce",
    integration: {
      supported: true,
      admissionSupported: true,
      verified: true,
    },
    usageBounds: { maxInputTokens: 4_000, maxOutputTokens: 1_000 },
  },
})
```

An unavailable decision, unknown required price, unsupported integration, or
exhausted allowance fails closed as `CostKeyPolicyRefused` in enforce mode.
The error carries the policy reason, allowance/window, and retry metadata when
the server provides them. The application owns its fallback; refusal is not
automatically retried as a provider failure. Monitor mode remains
observation-only and fails open on admission transport errors.

## Explicit context handoff

Context never leaks into unrelated outbound requests. For a trusted service or
queue, explicitly attach the allowlisted carrier:

```ts
const headers = CostKey.exportContextHeaders()
await fetch("https://internal-worker.example/run", { headers })
```

The destination can pass the serialized `x-costkey-context` value to
`CostKey.withContext(...)`. CostKey removes its carrier headers before a
provider request. Conversation and voice-session identities are included in
the explicit carrier allowlist; arbitrary context remains process-local.

Capture settings are negotiated asynchronously from the DSN project config.
The SDK starts metadata-only until that response is known, so startup never
adds provider latency. A remote metadata-only/off setting overrides local
`captureBody:true`; an explicit local `captureBody:false` remains an opt-out
even when remote text capture is enabled. Missing or revoked config fails
closed to metadata-only without blocking provider calls. Existing projects
that historically captured text keep that behavior only after the server
explicitly reports text capture enabled.
Metadata-only events may include bounded structural counts (such as message or
choice counts), but never prompt, tool-definition, tool-call, or system
instruction content.

## Supported Providers

| Provider | Hostname | Streaming |
|---|---|---|
| OpenAI | `api.openai.com` | Yes (auto-injects `include_usage`) |
| Anthropic | `api.anthropic.com` | Yes |
| Google Gemini | `generativelanguage.googleapis.com` | Yes |
| Azure OpenAI | `*.openai.azure.com` | Yes |
| Google Vertex AI | `*-aiplatform.googleapis.com` | Yes |
| Groq | `api.groq.com` | Yes |
| xAI (Grok) | `api.x.ai` | Yes |
| Mistral | `api.mistral.ai` | Yes |
| DeepSeek | `api.deepseek.com` | Yes |
| Cohere | `api.cohere.com` | Yes |
| Together AI | `api.together.xyz` | Yes |
| Fireworks | `api.fireworks.ai` | Yes |
| Perplexity | `api.perplexity.ai` | Yes |
| Cerebras | `api.cerebras.ai` | Yes |
| OpenRouter | `openrouter.ai` | Yes |
| AWS Bedrock | `bedrock-runtime.*.amazonaws.com` | No |

Custom providers: `CostKey.registerExtractor(extractor)`

## Options

| Option | Default | Description |
|---|---|---|
| `dsn` | required | `https://ck_key@app.costkey.dev/project` |
| `captureBody` | `true` | Capture request/response bodies |
| `release` | — | Release version for sourcemap translation |
| `beforeSend` | — | Hook to modify/filter events |
| `beforeSendEvent` | — | Hook to modify/filter lifecycle and usage events |
| `policy` | — | Explicit monitor/enforce admission configuration |
| `configRefreshInterval` | `60000` | Milliseconds between DSN capture-config refreshes |
| `maxBatchSize` | `50` | Events per batch |
| `flushInterval` | `5000` | Ms between flushes |
| `debug` | `false` | Enable debug logging |

## API

| Method | Description |
|---|---|
| `CostKey.init(options)` | Initialize. Call once at startup. |
| `CostKey.startTrace(opts, fn)` | Run fn inside a trace scope. |
| `CostKey.startExecution(opts, fn)` | Group repeatable work with a fresh execution ID. |
| `CostKey.recordUsage(event)` | Report deduplicated external/native usage. |
| `CostKey.recordLiveKitUsage(event, opts)` | Map selected LiveKit cumulative STT/LLM/TTS usage; use `components` or `excludeComponents` when another source owns a component. |
| `CostKey.withContext(ctx, fn)` | Run fn with custom tags. |
| `CostKey.exportContext()` / `exportContextHeaders()` | Explicit allowlisted cross-process carrier. |
| `CostKey.shutdown()` | Flush and restore original fetch. |
| `CostKey.registerExtractor(ext)` | Add custom AI provider. |

## Measuring overhead

The repository includes a reproducible loopback-only benchmark for the
application-visible fetch path and the optional policy admission hop:

```bash
npm run build --workspace=costkey
node packages/sdk/benchmarks/sdk-overhead.mjs --iterations=500 --warmup=100
```

It reports p50/p95 timings and environment details. Results are
machine-specific synthetic evidence, not a provider-latency or production
overhead guarantee; see [`sdk-overhead.local.md`](../../docs/implementation/sdk-overhead.local.md)
for the recorded local run.

## Known Limitations

- **Async stack traces**: In heavily async environments (Cloudflare Workers, Next.js server components), stack traces may only show the async boundary rather than the full call chain. This is a runtime limitation — JavaScript engines discard stack frames across `await` points.

## License

MIT
