# CostKey

> Sentry for AI costs. Open-source SDK + dashboard that auto-tracks every AI API call.

## What is CostKey?

CostKey is a proxy-less AI cost observability platform. One line of code gives you:

- **Cost tracking** — per-call, per-function, per-feature cost attribution
- **Stack trace attribution** — automatically shows which business logic function made each AI call
- **Streaming metrics** — TTFT, tokens/sec, stream duration
- **Request tracing** — group related AI calls into traces
- **Anomaly detection** — alerts on cost spikes, latency spikes, token spikes
- **15 providers** — OpenAI, Anthropic, Google, Groq, xAI, Mistral, DeepSeek, Cohere, Together, Fireworks, Perplexity, Cerebras, OpenRouter, Bedrock, Azure OpenAI
- **Sourcemap support** — translate minified JS/TS stack traces to original source

## Quick Start

### Python

```bash
pip install costkey
```

```python
import costkey

costkey.init(dsn="https://ck_key@app.costkey.dev/proj_id")

# Every AI call is now tracked. No wrapping needed.
response = client.messages.create(model="claude-sonnet-4-5", ...)
```

### TypeScript / Node.js

```bash
npm install costkey
```

```typescript
import { CostKey } from 'costkey'

CostKey.init({ dsn: 'https://ck_key@app.costkey.dev/proj_id' })

// Every fetch to AI providers is now tracked.
const response = await openai.chat.completions.create({ ... })
```

## Architecture

```
Your App                    CostKey Server              Dashboard
┌──────────┐    events     ┌──────────────┐           ┌──────────┐
│ SDK      │ ──────────>   │ Ingest API   │           │ React    │
│ (patches │               │ - Cost calc  │           │ SPA      │
│  fetch/  │               │ - Frame      │ <──────── │          │
│  httpx)  │               │   filtering  │    API    │          │
└──────────┘               │ - Sourcemaps │           └──────────┘
                           └──────────────┘
```

**SDK** patches `fetch` (Node) or `httpx`/`requests` (Python). Detects AI provider calls by URL hostname, extracts usage from responses, captures stack traces. Sends raw events to server.

**Server** calculates costs (server-side pricing table), filters library frames from stack traces, detects business logic functions, translates sourcemaps, stores in PostgreSQL.

**Dashboard** shows cost trends, call sites, traces, events. Click any event for full details (input/output, tokens, stack trace).

## Monorepo Structure

```
packages/
  sdk/          TypeScript SDK (patches globalThis.fetch)
  server/       Express.js API server + PostgreSQL
  dashboard/    React SPA (Vite, Tailwind, Recharts)
  shared/       Shared types between SDK and server
  cli/          CLI tools (costkey sourcemaps upload)
  landing/      Landing page (costkey.dev)
```

## Development

```bash
npm install
npm run dev        # Starts server (4100) + dashboard (5180)
npm run build      # Builds shared → server → dashboard
npm test           # Runs all tests
```

### Server Tests
```bash
npx tsx --test packages/server/src/__tests__/server.test.ts
```

### SDK Tests
```bash
npx vitest run packages/sdk/src/__tests__/
```

## Key Features

### Server-Side Cost Calculation

The SDK sends raw usage data. The server calculates costs using a fuzzy model matching system — `claude-sonnet-4-5-20250514` matches `claude-sonnet-4`, `ft:gpt-4o:my-org:abc` matches `gpt-4o`. No SDK update needed when prices change.

### Smart Stack Trace Attribution

Library frames (AI SDK internals, HTTP clients, threading) are stripped server-side. The "business logic frame" is detected by finding the first frame from a **different file** than the direct API caller — skipping wrapper/client utility functions automatically.

### Sourcemap Translation

For minified JS/TS builds:

```bash
# In your CI/CD pipeline
costkey sourcemaps upload \
  --release $GIT_SHA \
  --auth-key $COSTKEY_AUTH_KEY \
  ./dist/*.map
```

```typescript
CostKey.init({
  dsn: '...',
  release: process.env.GIT_SHA
})
```

The server translates `bundle.js:1:43829` → `UserProfile.tsx:47:handleClick` on ingest.

## Deployment

**Server**: Dockerfile included, deploy on Railway/Fly/Render. Needs PostgreSQL.

```bash
docker build -t costkey .
docker run -p 4100:4100 -e DATABASE_URL=postgres://... costkey
```

**Dashboard**: Built into the server binary, served as static files.

## License

MIT
