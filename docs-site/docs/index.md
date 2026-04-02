---
slug: /
sidebar_position: 1
title: Getting Started
description: Start tracking AI costs in under 60 seconds with CostKey.
---

# Getting Started

CostKey is an open-source SDK that auto-tracks every AI API call's cost, tokens, and latency. One line of code, zero wrappers, zero proxies.

## Install

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
<TabItem value="python" label="Python">

```bash
pip install costkey
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```bash
npm install costkey
```

</TabItem>
</Tabs>

## Initialize

Get your DSN from the [CostKey dashboard](https://app.costkey.dev) or by running `costkey init my-project`.

<Tabs>
<TabItem value="python" label="Python">

```python
import costkey

costkey.init(dsn="https://ck_your_key@app.costkey.dev/your_project_id")
```

</TabItem>
<TabItem value="typescript" label="TypeScript">

```typescript
import { CostKey } from 'costkey'

CostKey.init({ dsn: 'https://ck_your_key@app.costkey.dev/your_project_id' })
```

</TabItem>
</Tabs>

## That's it

Every AI API call your app makes is now tracked automatically. No wrappers, no decorators, no code changes.

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
- [Self-Hosting](/self-hosting) — run CostKey on your own infrastructure
