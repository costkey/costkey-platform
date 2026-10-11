---
sidebar_position: 4
title: Agents and frameworks
description: Trace agent runs from your framework, or with spans in your own code, and see what each step and tool costs.
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Agents and frameworks

An agent run makes many model calls: planning, tool selection, sub-agents,
reviewers. CostKey records the run as a tree of **spans** and attributes every
model call to the innermost span it ran in. The run page shows the tree as a
timeline, with cost and latency rolled up at each level.

Framework integrations need SDK **0.7.0** and CostKey server **0.7.0** or
later. The manual span API has been available since SDK 0.6.0.

## Pick your framework

| Framework | TypeScript | Python |
| --- | --- | --- |
| [OpenAI Agents SDK](#openai-agents-sdk) | `costkey/integrations/openai-agents` | `costkey.integrations.openai_agents` |
| [LangChain and LangGraph](#langchain-and-langgraph) | `costkey/integrations/langchain` | `costkey.integrations.langchain` |
| [Claude Agent SDK](#claude-agent-sdk) | `costkey/integrations/claude-agent-sdk` | `costkey.integrations.claude_agent_sdk` |
| [Vercel AI SDK](#vercel-ai-sdk) | `costkey/integrations/ai-sdk` | |
| [Mastra](#mastra) | `costkey/integrations/mastra` | |
| [CrewAI](#crewai) | | `costkey.integrations.crewai` |
| [LlamaIndex](#llamaindex) | | `costkey.integrations.llama_index` |
| [Pydantic AI](#pydantic-ai) | | `costkey.integrations.pydantic_ai` |
| [Google ADK](#google-adk) | | `costkey.integrations.google_adk` |
| [smolagents](#smolagents) | | `costkey.integrations.smolagents` |
| [AutoGen AgentChat](#autogen-agentchat) | | `costkey.integrations.autogen` |
| [AG2](#ag2) | | `costkey.integrations.ag2` |
| [DSPy](#dspy) | | `costkey.integrations.dspy` |
| [Strands Agents](#strands-agents) | | `costkey.integrations.strands` |
| [browser-use](#browser-use) | | `costkey.integrations.browser_use` |
| [OpenTelemetry](#opentelemetry) (anything else) | `costkey/integrations/opentelemetry` | `costkey.integrations.opentelemetry` |

**TypeScript.** Each integration is a subpath export with an optional peer
dependency on the framework, so nothing is imported unless you use it.

**Python.** Each integration is an optional extra, imported only from
`costkey.integrations.<name>`. `import costkey` never imports a framework.

```bash
pip install "costkey[langchain]"
```

| Framework | Extra |
| --- | --- |
| OpenAI Agents SDK | `openai-agents` |
| LangChain, LangGraph | `langchain`, `langgraph` |
| CrewAI | `crewai` |
| LlamaIndex | `llama-index` |
| Pydantic AI | `pydantic-ai` |
| Google ADK | `google-adk` |
| Claude Agent SDK | `claude-agent-sdk` |
| smolagents | `smolagents` |
| AutoGen AgentChat | `autogen` |
| AG2 | `ag2` |
| DSPy | `dspy` |
| Strands Agents | `strands` |
| OpenTelemetry | `opentelemetry` |

browser-use needs no extra.

Call `CostKey.init()` or `costkey.init()` first, as usual. The snippets below
only show the integration.

### OpenAI Agents SDK

Agents, function tools, handoffs, guardrails and turns become spans.

<Tabs>
<TabItem value="typescript" label="TypeScript">

```typescript
import { addTraceProcessor } from '@openai/agents'
import { CostKeyAgentsProcessor } from 'costkey/integrations/openai-agents'

addTraceProcessor(new CostKeyAgentsProcessor())
```

The Agents SDK disables tracing when `NODE_ENV=test`. Call
`setTracingDisabled(false)` in tests.

</TabItem>
<TabItem value="python" label="Python">

```python
from costkey.integrations.openai_agents import instrument

instrument()
result = await Runner.run(agent, "What's the weather in SF?")
```

`instrument()` adds a tracing processor, which needs the Agents SDK's tracing
on. With tracing disabled, pass `hooks=CostKeyRunHooks()` to `Runner.run`
instead. Use one or the other, not both. With hooks, the span tree is recorded
but model calls attach to the span around `Runner.run`, because the Agents SDK
runs hooks in child tasks.

</TabItem>
</Tabs>

### LangChain and LangGraph

Chains, graphs, graph nodes, agents, tools and retrievers become spans.

<Tabs>
<TabItem value="typescript" label="TypeScript">

```typescript
import { CostKeyCallbackHandler } from 'costkey/integrations/langchain'

const costkey = new CostKeyCallbackHandler()
await graph.invoke(input, { callbacks: [costkey] })
```

</TabItem>
<TabItem value="python" label="Python">

```python
from costkey.integrations.langchain import CostKeyCallbackHandler

result = graph.invoke(inputs, config={"callbacks": [CostKeyCallbackHandler()]})
```

</TabItem>
</Tabs>

### Claude Agent SDK

The Claude Agent SDK runs its model calls in a separate Claude Code process,
so CostKey's HTTP capture in your process never sees them. That is why it has
its own integration. The run, tool uses and subagents become spans, and every
message that carries usage is sent as a call event with
`telemetry.source = "claude-agent-sdk"` and the raw message skeleton. The
server prices it like any other call.

<Tabs>
<TabItem value="typescript" label="TypeScript">

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk'
import { instrumentClaudeAgentQuery } from 'costkey/integrations/claude-agent-sdk'

const tracedQuery = instrumentClaudeAgentQuery(query, { name: 'triage' })
for await (const message of tracedQuery({ prompt, options })) { /* ... */ }
```

Your own `options.hooks` still run.

</TabItem>
<TabItem value="python" label="Python">

```python
from costkey.integrations.claude_agent_sdk import instrument

claude = instrument()
options = claude.with_hooks(ClaudeAgentOptions(model="claude-sonnet-4-5"))
async for message in query(prompt="Fix the failing test", options=options):
    ...
```

</TabItem>
</Tabs>

### Vercel AI SDK

`generateText` and `streamText` runs (and `ToolLoopAgent`), their steps and
tool executions become spans, with no wrapping. Needs `ai` 7 or later.

```typescript
import { registerTelemetry } from 'ai'
import { costkeyTelemetry } from 'costkey/integrations/ai-sdk'

registerTelemetry(costkeyTelemetry())
// Runs are named by `telemetry: { functionId }` when you set it.
```

AI SDK 4 to 6 have no telemetry integration API. Turn on their
`experimental_telemetry` OpenTelemetry spans and use the
[OpenTelemetry bridge](#opentelemetry).

### Mastra

Agent runs, workflows, workflow steps and tool calls become spans. Needs
`@mastra/core` 1.x with `@mastra/observability`.

```typescript
import { Observability } from '@mastra/observability'
import { CostKeyMastraBridge } from 'costkey/integrations/mastra'

new Mastra({
  agents, workflows,
  observability: new Observability({
    configs: { default: { serviceName: 'api', bridge: new CostKeyMastraBridge() } },
  }),
})
```

If you already use another Mastra bridge, add `new CostKeyMastraExporter()` to
`exporters` instead. Pass it Mastra's `getCurrentSpan` to keep call
attribution.

### CrewAI

Crews, flows, agents, tasks, tools, and memory and knowledge queries become
spans.

```python
from costkey.integrations.crewai import CostKeyCrewAIListener

listener = CostKeyCrewAIListener()  # registers on crewai_event_bus
crew.kickoff()
```

### LlamaIndex

Agents, workflows and steps, retrievers, tools, and query and chat engines
become spans.

```python
from costkey.integrations.llama_index import instrument

instrument()  # adds a span handler to the root dispatcher
response = index.as_query_engine().query("What changed?")
```

### Pydantic AI

Agent runs and tool executions become spans.

```python
from costkey.integrations.pydantic_ai import CostKeyCapability

agent = Agent("openai:gpt-5", capabilities=[CostKeyCapability()])
result = await agent.run("Summarize the incident")
```

### Google ADK

Runner invocations, agents and tools become spans.

```python
from costkey.integrations.google_adk import CostKeyPlugin

runner = InMemoryRunner(agent=root_agent, app_name="app", plugins=[CostKeyPlugin()])
```

### smolagents

Agent runs, action steps and planning steps become spans.

```python
from costkey.integrations.smolagents import instrument

agent = instrument(CodeAgent(tools=[...], model=model))
agent.run("task")
```

smolagents reports a step only after it finishes, so steps arrive as completed
spans with their own timing. Model calls sit under the agent span, and the
server places them in steps by time.

### AutoGen AgentChat

`invoke_agent`, `execute_tool` and `create_agent` become spans, through
OpenTelemetry.

```python
from costkey.integrations.autogen import instrument

instrument()
result = await AssistantAgent("assistant", model_client=client).run(task="...")
```

### AG2

Agent turns and tool executions become spans.

```python
from costkey.integrations.ag2 import costkey_middleware

agent = Agent("researcher", config=config, middleware=[costkey_middleware("researcher")])
```

### DSPy

Modules, ReAct agents, tools, evaluations and compiles become spans.

```python
from costkey.integrations.dspy import CostKeyCallback

dspy.configure(lm=dspy.LM("openai/gpt-4o-mini"), callbacks=[CostKeyCallback()])
```

DSPy 3.4 sends model requests through its own `lm15` HTTP client.
`CostKeyCallback` also patches that client, so those calls are captured too.

### Strands Agents

Invocations, tools and multi-agent nodes become spans.

```python
from costkey.integrations.strands import CostKeyHooks

agent = Agent(model=model, tools=[...], hooks=[CostKeyHooks()])
```

### browser-use

Each step becomes a span carrying its step number. Calls made during the step,
including any reviewer pass, are attributed to it.

```python
from costkey.integrations.browser_use import step_hooks

on_step_start, on_step_end = step_hooks()
with costkey.agent("browser-agent"):
    await browser_agent.run(on_step_start=on_step_start, on_step_end=on_step_end)
```

### OpenTelemetry

The bridge covers any framework not listed here, and any tracer you already
run (OpenLLMetry, OpenInference, your own spans). Every OTel span, GenAI
semantic convention spans included, becomes a CostKey span with the raw OTel
attributes under `attributes.otel`, plus `otelKind`, `otelName` and the scope
name. The server maps the GenAI conventions. Provider calls made while an OTel
span is active are attributed to it.

<Tabs>
<TabItem value="typescript" label="TypeScript">

```typescript
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { CostKeySpanProcessor } from 'costkey/integrations/opentelemetry'

const provider = new BasicTracerProvider({ spanProcessors: [new CostKeySpanProcessor()] })
```

</TabItem>
<TabItem value="python" label="Python">

```python
from costkey.integrations.opentelemetry import instrument

instrument()  # adds CostKeySpanProcessor to the global SDK TracerProvider
```

</TabItem>
</Tabs>

## How attribution works

- **Model calls come from HTTP capture.** The SDK records every provider call
  your process makes, framework or not. Each call is attributed to the
  innermost span that was active when it ran.
- **Integrations only send spans.** They open and close spans and attach the
  framework's raw data. They never send a second call event for a model call
  the HTTP capture already recorded, so nothing is counted twice.
- **The Claude Agent SDK is the exception.** Its model calls run in another
  process, so the integration sends their usage as call events.
- **Everything else goes through OpenTelemetry.** If your framework emits OTel
  spans, the bridge turns them into CostKey spans and calls inside them are
  attributed the same way.

Calls inside an agent or tool span carry `agent` and `tool` in their context,
which is what the cost splits and budgets use.

## Spans in your own code

For a custom agent loop, or to add structure around a framework, use the span
API directly.

### Span kinds

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

### TypeScript

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

`instrumentTools` wraps each tool's `execute` in a tool span, for any framework
whose tools expose `execute`. Other entries pass through unchanged.

```typescript
const tools = CostKey.instrumentTools({
  getHoldings: tool({ description: 'Holdings for a user', inputSchema, execute: getHoldings }),
  searchFunds: tool({ description: 'Search funds', inputSchema, execute: searchFunds }),
})

await CostKey.agent('dash', () => generateText({ model, tools, prompt }))
```

### Python

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
  duration, attributes and error. The **Checks** tab shows
  [quality check](./quality-checks) results for the run.
- **Costs** can be split by agent or by tool.
- **Budgets** can cover a single agent or tool.

## What is sent

A span sends its name, kind, parent, status, timing and attributes. It is
delivered twice: when it starts, so a running agent appears right away, and
when it ends. Errors are sent as the raw error name (such as `AbortError` or
`CancelledError`), and the server decides whether that means failed or
cancelled.

Integrations put the framework's raw data under one attribute named for the
framework (`attributes.otel` for OpenTelemetry). In a metadata-only project
that data is a skeleton: keys and numbers are kept, and text is replaced by
its length.

Inputs and outputs (`input`, `setOutput` / `set_output`) are sent only when
the project captures text. With metadata-only capture, the server also drops
content-like attributes. Attributes are capped at 8 KB per span.
