# costkey

> Sentry for AI costs. Track every LLM call's cost, tokens, and latency with one line of code.

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

// That's it. Every AI call is now tracked automatically.
```

## How It Works

CostKey patches `globalThis.fetch`. When your code calls any AI provider:

1. **Detects** the provider from the URL (15 providers supported)
2. **Extracts** token usage from the response (streaming + non-streaming)
3. **Captures** a stack trace for automatic code attribution
4. **Measures** streaming timing (TTFT, TPS) via SSE wrapping
5. **Ships** the event async to your CostKey dashboard — server calculates cost

**Zero overhead.** Non-AI fetch calls pass through untouched.
**Zero risk.** The SDK never throws into your code.

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

## Context

```typescript
await CostKey.withContext({ task: 'summarize', team: 'search' }, async () => {
  await openai.chat.completions.create({ ... })
})
```

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
| `maxBatchSize` | `50` | Events per batch |
| `flushInterval` | `5000` | Ms between flushes |
| `debug` | `false` | Enable debug logging |

## API

| Method | Description |
|---|---|
| `CostKey.init(options)` | Initialize. Call once at startup. |
| `CostKey.startTrace(opts, fn)` | Run fn inside a trace scope. |
| `CostKey.withContext(ctx, fn)` | Run fn with custom tags. |
| `CostKey.shutdown()` | Flush and restore original fetch. |
| `CostKey.registerExtractor(ext)` | Add custom AI provider. |

## Known Limitations

- **Async stack traces**: In heavily async environments (Cloudflare Workers, Next.js server components), stack traces may only show the async boundary rather than the full call chain. This is a runtime limitation — JavaScript engines discard stack frames across `await` points.

## License

MIT
