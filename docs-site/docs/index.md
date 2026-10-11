---
slug: /
sidebar_position: 1
title: Getting started
description: Start self-hosted CostKey, connect your app with a project DSN, and inspect AI usage.
---

# Getting started

CostKey is an SDK that observes supported AI-provider calls in your existing
application and records cost, usage, latency, stack, and context when the
endpoint and transport are covered. Prompt/response and tool content is
captured only when the project explicitly enables text capture, the SDK allows
body capture, and the endpoint exposes a supported response shape. One CLI
command gets you started; no provider-routing gateway is required.

## Start CostKey

CostKey runs on your own machines. One command starts it with Docker:

```bash
curl -fsSL https://costkey.dev/install.sh | sh
```

Open `http://localhost:4100`, sign up and create your workspace. See [Self-hosting](./self-hosting) for settings, HTTPS and upgrades.

## Connect your app

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

The setup command signs in to your CostKey (`http://localhost:4100` by default; pass `--host` for another address), creates a
project, writes `COSTKEY_DSN` to `.env`, detects your framework, and writes
`.costkey/setup.md` with the exact snippet and no-code preload option. New
projects start in metadata-only mode. Enable text capture deliberately in the
project settings; existing projects retain their configured mode.

Supported detections include Next.js, Vite, Express, Fastify, Hono, Koa, NestJS, Remix, Astro, SvelteKit, Node/TypeScript, FastAPI, Django, Flask, and plain Python. Bundled JavaScript apps get a sourcemap warning with a link to [sourcemap setup](/sourcemaps).

## Initialize manually

Prefer the setup command above. If you need to wire CostKey manually, copy your DSN from **Settings, Projects** in your CostKey console and initialize before your first AI call.

<Tabs>
<TabItem value="python" label="Python">

```python
import costkey

costkey.init(
    dsn="http://ck_your_key@localhost:4100/your_project_id",
    release="v1.0.0",  # Track cost per deploy
)
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```typescript
import { CostKey } from 'costkey'

CostKey.init({
  dsn: 'http://ck_your_key@localhost:4100/your_project_id',
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

Supported provider calls made through the instrumented transport are now
observed automatically for metadata, usage, timing, and attribution. Coverage
depends on the endpoint, transport, response shape, capture mode, and whether
the process flushes its telemetry; see the [developer recipes and capability
matrix](/recipes).

Using an agent framework such as the OpenAI Agents SDK, LangGraph, CrewAI or the Vercel AI SDK? Add its integration to see each step and tool call; see [Agents and frameworks](/agents).

<Tabs>
<TabItem value="python" label="Python">

```python
import costkey
from anthropic import Anthropic

costkey.init(dsn="http://ck_your_key@localhost:4100/your_project_id")

client = Anthropic()

# Metadata, usage, latency, and stack are observed when this endpoint is covered.
# Prompt/response content requires explicit text capture in project settings.
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

CostKey.init({ dsn: 'http://ck_your_key@localhost:4100/your_project_id' })

const openai = new OpenAI()

// Metadata, usage, latency, and stack are observed when this endpoint is covered.
// Prompt/response content requires explicit text capture in project settings.
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Explain quantum computing in one paragraph' }],
})
console.log(response.choices[0].message.content)
```

</TabItem>
</Tabs>

Open your CostKey console and you'll see:

- **Known cost** per priced observed call; missing prices remain unknown
- **Token usage** (input, output, cache, and reasoning tokens when reported)
- **Latency** and streaming metrics (TTFT, tokens/sec) when the transport exposes them
- **Stack trace** showing the captured source frame when available
- **Call site grouping** so you can see which observed code paths cost the most
- **Captured content**: inspect prompts/completions only for calls allowed by
  project text-capture, SDK body-capture, endpoint, permission, and retention
  settings
- **System prompts and tool calls**: inspect these only when content capture is
  enabled and the provider response shape exposes them
- **Agent runs**: group model calls, tool calls, retries, and errors when the
  application supplies an explicit trace/execution boundary
- **Cost per deploy**: set `release` to see how costs change across deployments
- **Executive summary**: a plain-English summary of your AI spend for stakeholders

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
    # Supported calls appear as one trace in the dashboard
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```typescript
await CostKey.startTrace({ name: 'POST /api/search' }, async () => {
  const intent = await classifyIntent(query)   // AI call 1
  const results = await search(query, intent)  // AI call 2
  const summary = await summarize(results)     // AI call 3
  // Supported calls appear as one trace in the dashboard
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

- [Python SDK](/python-sdk): full API reference, all options, streaming details
- [TypeScript SDK](/typescript-sdk): full API reference, Express middleware, sourcemaps
- [Developer recipes & diagnostics](/recipes): HTTP, workers, mixed-language handoff, grouped work, evals, and voice boundaries
- [Providers](/providers): built-in provider endpoints and transport coverage
- [Agents and frameworks](/agents): framework integrations and agent spans
- [Dashboard](/dashboard): what each tab shows
- [Quality checks](/quality-checks): score every run with rules and LLM judges
- [Privacy & security](/privacy-security): what data is captured, credential scrubbing, data retention
