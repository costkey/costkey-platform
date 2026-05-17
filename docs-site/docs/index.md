---
slug: /
sidebar_position: 1
title: Getting Started
description: Start tracking AI costs in under 60 seconds with CostKey.
---

# Getting Started

CostKey is an SDK that auto-tracks every AI API call's cost, tokens, latency, prompts, tool calls, and agent metadata. One CLI command, zero wrappers, zero proxies.

## Setup

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
<TabItem value="python" label="Python">

```bash
pipx run costkey setup
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```bash
npx costkey setup
```

</TabItem>
</Tabs>

The setup command authenticates with CostKey in your browser, creates a project, writes `COSTKEY_DSN` to `.env`, detects your framework, and writes `.costkey/setup.md` with the exact snippet and no-code preload option.

Supported detections include Next.js, Vite, Express, Fastify, Hono, Koa, NestJS, Remix, Astro, SvelteKit, Node/TypeScript, FastAPI, Django, Flask, and plain Python. Bundled JavaScript apps get a sourcemap warning with a link to [sourcemap setup](/sourcemaps).

## Initialize Manually

Prefer the setup command above. If you need to wire CostKey manually, get your DSN from the [CostKey dashboard](https://app.costkey.dev) and initialize before your first AI call.

<Tabs>
<TabItem value="python" label="Python">

```python
import costkey

costkey.init(
    dsn="https://ck_your_key@app.costkey.dev/your_project_id",
    release="v1.0.0",  # Track cost per deploy
)
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```typescript
import { CostKey } from 'costkey'

CostKey.init({
  dsn: 'https://ck_your_key@app.costkey.dev/your_project_id',
  release: 'v1.0.0',  // Track cost per deploy
})
```

</TabItem>
</Tabs>

## No-code preload

For Node servers, setup writes `.costkey/node-options.env`:

```bash
NODE_OPTIONS=--import costkey/register npm start
```

For Python servers, setup writes `.costkey/sitecustomize.py`:

```bash
PYTHONPATH="$PWD/.costkey:$PYTHONPATH" uvicorn app:app
```

## That's it

Every AI API call your app makes is now tracked automatically. No wrappers, no decorators, no proxy migration.

<Tabs>
<TabItem value="python" label="Python">

```python
import costkey
from anthropic import Anthropic

costkey.init(dsn="https://ck_your_key@app.costkey.dev/your_project_id")

client = Anthropic()

# This call is automatically tracked — cost, tokens, latency, stack trace
response = client.messages.create(
    model="claude-sonnet-4-5-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Explain quantum computing in one paragraph"}],
)
print(response.content[0].text)
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```typescript
import { CostKey } from 'costkey'
import OpenAI from 'openai'

CostKey.init({ dsn: 'https://ck_your_key@app.costkey.dev/your_project_id' })

const openai = new OpenAI()

// This call is automatically tracked — cost, tokens, latency, stack trace
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Explain quantum computing in one paragraph' }],
})
console.log(response.choices[0].message.content)
```

</TabItem>
</Tabs>

Open the [dashboard](https://app.costkey.dev) and you'll see:

- **Cost** per call, calculated server-side from the model and token count
- **Token usage** (input, output, cache, reasoning tokens)
- **Latency** and streaming metrics (TTFT, tokens/sec)
- **Stack trace** showing which function in your code made the call
- **Call site grouping** so you can see which parts of your code cost the most
- **Body capture** — inspect the exact prompt and completion for any call
- **System prompts and tool calls** — inspect prompt roles, tool/function calls, errors, and provider metadata
- **Agent runs** — group model calls, tool calls, retries, and errors into one trace
- **Cost per deploy** — set `release` to see how costs change across deployments
- **Executive summary** — a plain-English summary of your AI spend for stakeholders

## Add context

Tag calls with metadata to slice costs by feature, team, or user.

<Tabs>
<TabItem value="python" label="Python">

```python
with costkey.with_context(task="summarize", team="search", user_id="u_123"):
    response = client.messages.create(
        model="claude-sonnet-4-5-20250514",
        max_tokens=1024,
        messages=[{"role": "user", "content": f"Summarize: {document}"}],
    )
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```typescript
await CostKey.withContext({ task: 'summarize', team: 'search', userId: 'u_123' }, async () => {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: `Summarize: ${document}` }],
  })
})
```

</TabItem>
</Tabs>

## Group calls into traces

When a single user action triggers multiple AI calls, group them with `start_trace`.

<Tabs>
<TabItem value="python" label="Python">

```python
with costkey.start_trace(name="POST /api/search"):
    intent = classify_intent(query)       # AI call 1
    results = search(query, intent)       # AI call 2
    summary = summarize(results)          # AI call 3
    # All 3 calls appear as one trace in the dashboard
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```typescript
await CostKey.startTrace({ name: 'POST /api/search' }, async () => {
  const intent = await classifyIntent(query)   // AI call 1
  const results = await search(query, intent)  // AI call 2
  const summary = await summarize(results)     // AI call 3
  // All 3 calls appear as one trace in the dashboard
})
```

</TabItem>
</Tabs>

## Shut down cleanly

Before your process exits, flush any pending events.

<Tabs>
<TabItem value="python" label="Python">

```python
costkey.shutdown()
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```typescript
await CostKey.shutdown()
```

</TabItem>
</Tabs>

## Next steps

- [Python SDK](/python-sdk) — full API reference, all options, streaming details
- [TypeScript SDK](/typescript-sdk) — full API reference, Express middleware, sourcemaps
- [Providers](/providers) — all 15 supported AI providers
- [Dashboard](/dashboard) — what each tab shows
- [Privacy & Security](/privacy-security) — what data is captured, credential scrubbing, data retention
