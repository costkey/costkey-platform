---
sidebar_position: 4
title: Agents and tools
description: Trace agent runs, steps, tool calls and handoffs, and see what each one costs.
---

# Agents and tools

An agent run makes many model calls: planning, tool selection, sub-agents,
reviewers. CostKey records the run as a tree of **spans** and attributes every
model call to the innermost span it ran in. The run page shows the tree as a
timeline, with cost and latency rolled up at each level.

Requires SDK **0.6.0** or later.

## Span kinds

| Kind | Use it for |
| --- | --- |
| `agent` | One agent's run, including sub-agents it starts |
| `step` | One turn of an agent loop: a browser action, a plan stage |
| `tool` | A tool call |
| `handoff` | Control passing from one agent to another |
| `judge` | A reviewer or evaluator pass |
| `retrieval` | Search, rerank or vector lookup |
| `workflow`, `task`, `chain`, `guardrail`, `custom` | Anything else worth its own row |

Names should be stable and low-cardinality (`search_funds`, not
`search_funds:INF123`). Put per-call details in attributes.

## TypeScript

```typescript
import { CostKey } from 'costkey'

await CostKey.agent('dash', async (span) => {
  span.setAttribute('model', 'gpt-5.1')
  const plan = await planTurn(question)

  await CostKey.tool('get_holdings', () => holdings(userId))

  await CostKey.step('answer', async () => {
    await writeAnswer(plan)
  })
})
```

`CostKey.agent`, `CostKey.step` and `CostKey.tool` are shortcuts for
`CostKey.startSpan({ name, kind }, fn)`. Use `startSpan` for the other kinds:

```typescript
await CostKey.startSpan({ name: 'action review', kind: 'judge' }, () => review(action))
```

If no trace is active, the outermost span starts one, so a span is enough to
group a run.

### Vercel AI SDK and Mastra tools

`instrumentTools` wraps each tool's `execute` in a tool span. Other entries
pass through unchanged.

```typescript
const tools = CostKey.instrumentTools({
  getHoldings: tool({ description: 'Holdings for a user', inputSchema, execute: getHoldings }),
  searchFunds: tool({ description: 'Search funds', inputSchema, execute: searchFunds }),
})

await CostKey.agent('dash', () => generateText({ model, tools, prompt }))
```

## Python

Spans work as context managers, async context managers and decorators.

```python
import costkey

with costkey.agent("dash", user_id=user.id) as span:
    span.set_attribute("model", "gpt-5.1")
    plan = plan_turn(question)

    with costkey.tool("get_holdings"):
        holdings = get_holdings(user.id)

@costkey.tool("search_funds")
async def search_funds(query: str) -> list[dict]:
    ...
```

Keyword arguments that aren't span options (`user_id`, `conversation_id`,
`feature`) become context labels on every call inside the span. For other
kinds, use `costkey.span(name, kind="judge")`.

### OpenAI Agents SDK

```python
from agents import Runner
from costkey.integrations.openai_agents import CostKeyRunHooks

result = await Runner.run(agent, user_input, hooks=CostKeyRunHooks())
```

Agent runs, tool calls and handoffs become spans. The hooks run even with
`RunConfig(tracing_disabled=True)`, so they don't depend on the Agents SDK's
own tracing.

### browser-use

```python
from costkey.integrations.browser_use import step_hooks

on_step_start, on_step_end = step_hooks()
with costkey.agent("browser-agent", user_id=user.id):
    await browser_agent.run(on_step_start=on_step_start, on_step_end=on_step_end)
```

Each step becomes a span carrying its step number. Calls made during the step,
including any reviewer pass, are attributed to it.

## Runs that pause and resume

An agent that waits for a user, or moves to another worker, can carry its span
across the gap. Export the context inside the span and restore it on the other
side:

```typescript
// Before pausing
const carrier = await CostKey.agent('browser-agent', async () => CostKey.exportContext())
await saveCheckpoint({ carrier })

// In the worker that resumes
await CostKey.withContext(checkpoint.carrier, () => continueRun())
```

```python
with costkey.agent("browser-agent"):
    save_checkpoint(carrier=costkey.export_context())

# In the worker that resumes
with costkey.with_context(checkpoint.carrier):
    continue_run()
```

Calls made after the resume land in the same run and the same span. Only
export context to processes you trust.

## What you see in the console

- **Runs** list how many steps and tool calls each run made.
- **Run detail** shows the timeline tree. Select a span for its cost, calls,
  duration, attributes and error.
- **Costs** can be split by agent or by tool.
- **Budgets** can cover a single agent or tool.

## What is sent

A span sends its name, kind, parent, status, timing and attributes. It is
delivered twice: when it starts, so a running agent appears right away, and
when it ends.

Inputs and outputs (`input`, `setOutput` / `set_output`) are sent only when
the project captures content, and are truncated. With metadata-only capture,
the server also drops content-like attributes. Attributes are capped at 8 KB
per span.

Calls inside an agent or tool span carry `agent` and `tool` in their context,
which is what the cost splits and budgets use.
