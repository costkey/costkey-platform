---
sidebar_position: 2
title: Python SDK
description: Full API reference for the CostKey Python SDK.
---

# Python SDK

The CostKey Python SDK instruments `httpx`, `httpx2`, `requests`, `aiohttp`
and boto3 Bedrock clients in-process and records calls to supported provider
hosts. No provider-routing gateway is required. The exact transport and
response-shape coverage is listed in the [developer capability
matrix](/recipes#capability-matrix).

```bash
pipx run costkey setup
```

**Current version:** 0.7.0. SDK 0.7 needs CostKey server 0.7 or later. Older
SDKs keep working with the new server.

`pipx run costkey setup` logs you in, creates a CostKey project, writes `COSTKEY_DSN`, detects FastAPI, Django, Flask, and plain Python apps, and writes `.costkey/setup.md`.

For no-code Python bootstrapping, setup writes `.costkey/sitecustomize.py`. Put that directory on `PYTHONPATH` when starting your app:

```bash
PYTHONPATH="$PWD/.costkey:$PYTHONPATH" uvicorn app:app
```

## How it works

When you call `costkey.init()`, the SDK patches the send path of these
clients:

- `httpx` and `httpx2` (`Client.send` and `AsyncClient.send`). openai 3.x,
  anthropic 1.x and mistralai 3.x use `httpx2`, so their clients are captured.
- `requests` (`Session.send`).
- `aiohttp`, which google-genai uses when it is installed.
- boto3 and botocore `bedrock-runtime` clients.

For each HTTP call, the SDK checks the URL hostname against the capture list.
Non-AI calls pass through untouched. For a matched call, it records the
request and response, the stream chunks if the response is streamed, the
timing and the stack, and queues the event for background delivery. Capture
and flush work still have an application cost, so profile your own runtime.

Request and response bodies are conditional. The SDK starts metadata-only
until the DSN-authenticated project configuration is known. The server project
setting decides: text is sent only when text capture is explicitly enabled
and the SDK leaves body capture on. Use `capture_body=False` to opt out
locally; remote metadata-only or a revoked or unavailable config keeps bodies
off. Configuration is fetched asynchronously so provider calls do not wait for
it.

## What the SDK sends

The SDK only sends telemetry. All processing happens on the server: provider
and model detection, token and character counts, usage extraction, stream
timing, pricing, deduplication, error classification, stack frame filtering
and call graph scoring. Pricing and provider fixes ship with the server,
without an SDK upgrade.

Every captured call carries a `telemetry` field with the request and response
as a **skeleton**: the shape of each body and its numbers are kept, and text
is replaced by its length. `{"role": "user", "content": "hello"}` becomes
`{"role": {"$s": 4}, "content": {"$s": 5}}`. Strings are kept only under
identifier keys such as `model`, `id`, `type`, `status` and `finish_reason`.
In a metadata-only project, that skeleton is all that is sent, so prompt and
response text never leave your process. When the project captures text, the
scrubbed, size-limited request and response bodies are sent as well.

Credentials are removed first: credential query parameters are dropped, only a
short allowlist of request headers is sent, and cookie, authorization and API
key response headers are dropped. Arrays over 32 items keep the first 8, so
embedding vectors never ship. Calls that raise are sent too, with the raw
exception class name in `telemetry.error` and never the message.

## Agent frameworks

Integrations for the OpenAI Agents SDK, LangChain and LangGraph, CrewAI,
LlamaIndex, Pydantic AI, Google ADK, the Claude Agent SDK, smolagents,
AutoGen, AG2, DSPy, Strands, browser-use and OpenTelemetry live in
`costkey.integrations.*`. Each is an optional extra:

```bash
pip install "costkey[langchain]"
```

```python
from costkey.integrations.langchain import CostKeyCallbackHandler

result = graph.invoke(inputs, config={"callbacks": [CostKeyCallbackHandler()]})
```

See [Agents and frameworks](/agents) for every integration and how calls are
attributed to spans.

## Call graph

When `costkey.init()` is called, the SDK scans your project's `.py` files in a
background thread. It does not block application startup, but the scan and
upload still use application resources.

The scan uses the AST module and does not execute any code. It sends only
structure: each function's file and line, the functions it calls, and the
expressions it calls through (such as `client.chat.completions.create`). No
source code is sent. The server scores the graph and uses it to pick the
meaningful function in each stack trace, rather than an intermediate helper.

```python
# Default: scan is enabled, project root is auto-detected
costkey.init(dsn="http://ck_key@localhost:4100/proj_id")

# Disable call graph scanning
costkey.init(dsn="http://ck_key@localhost:4100/proj_id", scan_callgraph=False)

# Specify the project root explicitly
costkey.init(dsn="http://ck_key@localhost:4100/proj_id", project_root="/app/src")
```

## Using with Sentry, New Relic, or other APM tools

CostKey coexists with other tools that patch HTTP clients (Sentry, New Relic, Datadog). Each tool wraps the previous one, and calls flow through all layers.

**Initialize CostKey after your APM tool:**

```python
import sentry_sdk
sentry_sdk.init(dsn="...")  # Sentry patches httpx first

import costkey
costkey.init(dsn="...")      # CostKey wraps Sentry's patch
```

This way CostKey sees the raw call and Sentry captures error context. The order matters because the last patcher wraps the others.

**What to know:**
- The Python capture path does not rewrite provider requests or responses.
- CostKey catches its own capture failures. Provider errors still belong to
  the provider client and reach your application.
- Stack traces may be deeper because of the wrappers. The SDK sends every
  frame and the server picks the call site.
- Streaming responses flow through both tools while CostKey records the
  stream. Measure the overhead in your runtime.

## API Reference

### `costkey.init()`

Initialize the SDK. Call once at app startup, before any AI calls.

```python
import costkey

costkey.init(
    dsn="http://ck_your_key@localhost:4100/your_project_id",
    capture_body=None,  # project capture mode controls text; False is always off
    debug=False,
    release="v1.2.3",
    max_batch_size=50,
    flush_interval=5.0,
    default_context={"environment": "production"},
    before_send=my_hook,
)
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dsn` | `str \| None` | `COSTKEY_DSN` | DSN from the dashboard. Format: `http(s)://<key>@<your CostKey host>/<project-id>`. Omitting both values leaves the SDK in no-op/test mode. |
| `capture_body` | `bool \| None` | `None` | Local body capture preference. Metadata-only stays on until the project's text capture setting is known. `False` always wins. |
| `before_send` | `Callable` | `None` | Hook called before each call event is sent. Return `None` to drop the event. |
| `max_batch_size` | `int` | `50` | Maximum events to buffer before flushing. |
| `flush_interval` | `float` | `5.0` | Seconds between automatic flushes. |
| `debug` | `bool` | `False` | Enable debug logging to the `costkey` logger. |
| `default_context` | `dict` | `{}` | Default context applied to every event. |
| `release` | `str` | `None` | Release version string. Used for cost-per-deploy tracking and sourcemap translation. |
| `scan_callgraph` | `bool` | `True` | Scan your project's `.py` files at init and send the [call graph](#call-graph). |
| `project_root` | `str` | `None` | Root directory to scan. Auto-detected from your main module if not set. |
| `before_send_event` | `Callable` | `None` | Hook for lifecycle, span and explicit usage events. Return `None` to drop one. |
| `config_refresh_interval` | `float \| None` | `60.0` | Seconds between DSN project config refreshes (capture mode and custom provider hosts). `None` disables refresh after the first asynchronous fetch. |

### `costkey.with_context()`

Context manager that tags supported provider calls within its scope with custom metadata.

```python
with costkey.with_context(task="summarize", team="search"):
    # Supported provider calls in here get task="summarize", team="search"
    response = client.messages.create(...)
```

Contexts nest. Inner contexts merge with (and override) outer contexts:

```python
with costkey.with_context(team="search"):
    with costkey.with_context(task="classify"):
        # AI calls here have team="search", task="classify"
        classify_intent(query)

    with costkey.with_context(task="summarize"):
        # AI calls here have team="search", task="summarize"
        summarize(results)
```

You can pass any string, number, or boolean value as context:

```python
with costkey.with_context(
    task="summarize",
    team="search",
    user_id="u_123",
    is_premium=True,
    retry_count=2,
):
    response = client.messages.create(...)
```

### `costkey.start_trace()`

Context manager that groups provider calls within its scope into a single trace.

```python
with costkey.start_trace(name="POST /api/search"):
    intent = classify_intent(query)
    results = search(query, intent)
    summary = summarize(results)
```

Parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `str \| None` | `None` | Human-readable name for the trace (shown in dashboard). |
| `trace_id` | `str \| None` | `None` | Custom trace ID. Auto-generated if not provided. |

### Agent spans

`costkey.agent()`, `costkey.step()`, `costkey.tool()` and `costkey.span()`
record an agent run as a tree. Each works as a context manager, an async
context manager or a decorator. Calls inside a span are attributed to it. See
[Agents and frameworks](/agents) for framework integrations and for resuming a
paused run.

```python
with costkey.agent("dash", user_id=user.id) as span:
    span.set_attribute("model", "gpt-5.1")
    with costkey.tool("get_holdings"):
        holdings = get_holdings(user.id)
```

| Function | Description |
|----------|-------------|
| `agent(name, **options)` | An agent run. |
| `step(name, **options)` | One turn of an agent loop. |
| `tool(name, **options)` | A tool call. |
| `span(name, kind="custom", **options)` | Any span kind. |

Options are `attributes`, `input`, `span_id`, `parent_span_id` and `context`.
Other keyword arguments become context labels. The handle has `id`,
`trace_id`, `set_attribute(key, value)` and `set_output(value)`.

### Grouped executions and explicit usage

```python
with costkey.start_execution(
    name="nightly-document-import",
    kind="batch",
    expected_items=len(item_ids),
    configuration={"parser": "v2"},
):
    run_items()

costkey.record_usage(
    event_id="voice:tts:session-42:r1",
    component_id="voice:tts:session-42",
    revision=1,
    aggregation="cumulative",
    provider="speech-provider",
    model="speech-model",
    usage={"audioSeconds": 2.1, "characters": 320},
)
```

`start_execution` emits lifecycle records and keeps a stable group name
separate from its fresh execution ID. Supply `expected_items`,
`completed_items` and `failed_items` from the runner when those counts are
known; the SDK carries the same values on the started and finished lifecycle
records.

`record_usage` sends exactly what you pass. It fills in no defaults and
derives nothing. The server needs an `event_id`, a `component_id` and a
non-negative integer `revision`; it dedupes repeated IDs and ignores stale
revisions. A `cumulative` snapshot replaces the previous one for its component
and is not summed. A missing amount or price stays unknown.

To cross a trusted service or queue boundary, attach the carrier from
`costkey.export_context()` (or `costkey.export_context_headers()`) and pass it
to `costkey.with_context(...)` at the destination.

### `costkey.livekit.record_livekit_usage()`

Send each `session_usage_updated` snapshot as it is. The SDK sends the raw
update as a skeleton (numbers, `provider`, `model` and `type` kept); the
server classifies the STT, LLM and TTS rows and sums them. It does not
intercept LiveKit WebRTC or audio traffic.

```python
from costkey.livekit import record_livekit_usage

@session.on("session_usage_updated")
def on_usage(ev):
    record_livekit_usage(
        ev,
        session_id=session.room.name,
        revision=next_revision(),  # monotonic, supplied by the application
        exclude_components=("llm",),  # when HTTP capture already records the LLM calls
    )
```

`expected_components`, `exclude_components`, `declared_amounts`,
`declared_pricing_ids` and `declared_billing_units` are forwarded as they are
for the server to apply.

### `costkey.flush()`

Flush all pending events without shutting down. Use this when you need to ensure events are sent at a specific point.

```python
costkey.flush()
```

### `costkey.shutdown()`

Flush all pending events and restore the original HTTP clients. Call this before process exit.

```python
costkey.shutdown()
```

## Custom providers

Hosts that aren't built in are configured on the server, per project. The SDK
picks the hostnames up from the DSN runtime config and captures them like any
other provider. See [Providers](/providers#custom-providers).

## Streaming support

The SDK records the bytes your code reads from `httpx`, `httpx2`, `requests`
and `aiohttp` streams, and the events of boto3 Bedrock streams, without
reading ahead of you. Each stream is sent as chunk skeletons (`sse`, `ndjson`,
`json-array` or decoded `aws-eventstream` frames) with the real chunk count
and the times of the first and last reads. The server works out time to first
token, tokens per second and usage from them.

A stream your code stops reading early is reported when the response is
closed or released.

### Streaming with Anthropic

```python
import costkey
from anthropic import Anthropic

costkey.init(dsn="http://ck_key@localhost:4100/proj_id")

client = Anthropic()

with client.messages.stream(
    model="claude-sonnet-4-5-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Write a haiku about Python"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

### Streaming with OpenAI

```python
import costkey
import openai

costkey.init(dsn="http://ck_key@localhost:4100/proj_id")

client = openai.OpenAI()

stream = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Write a haiku about Python"}],
    stream=True,
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

## Provider examples

### Anthropic

```python
import costkey
from anthropic import Anthropic

costkey.init(dsn="http://ck_key@localhost:4100/proj_id")

client = Anthropic()

response = client.messages.create(
    model="claude-sonnet-4-5-20250514",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "What is the capital of France?"}
    ],
)
print(response.content[0].text)
```

### OpenAI

```python
import costkey
import openai

costkey.init(dsn="http://ck_key@localhost:4100/proj_id")

client = openai.OpenAI()

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[
        {"role": "user", "content": "What is the capital of France?"}
    ],
)
print(response.choices[0].message.content)
```

### Google Gemini

```python
import costkey
from google import genai

costkey.init(dsn="http://ck_key@localhost:4100/proj_id")

client = genai.Client()
response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents="What is the capital of France?",
)
print(response.text)
```

## FastAPI integration

```python
from fastapi import FastAPI, Request
import costkey

app = FastAPI()
costkey.init(dsn="http://ck_key@localhost:4100/proj_id")

@app.middleware("http")
async def costkey_trace(request: Request, call_next):
    with costkey.start_trace(name=f"{request.method} {request.url.path}"):
        response = await call_next(request)
    return response

@app.post("/api/search")
async def search(query: str):
    with costkey.with_context(task="search"):
        intent = await classify_intent(query)
        results = await run_search(query, intent)
        summary = await summarize(results)
    return {"summary": summary}
```

## Django integration

```python
# middleware.py
import costkey

class CostKeyMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        with costkey.start_trace(name=f"{request.method} {request.path}"):
            response = self.get_response(request)
        return response

# settings.py
MIDDLEWARE = [
    "myapp.middleware.CostKeyMiddleware",
    # ... other middleware
]
```

## `before_send` hook

The `before_send` hook lets you modify or drop call events before they're
sent. Provider, model and usage are worked out on the server, so use the
event's `url`, `context`, `request_body`, `response_body` and raw `telemetry`,
not a model or a cost.

```python
from costkey.types import CostKeyEvent

def my_hook(event: CostKeyEvent) -> CostKeyEvent | None:
    # Drop events from a test environment
    if event.context.get("environment") == "test":
        return None

    # Scrub PII from request bodies
    if event.request_body and isinstance(event.request_body, dict):
        messages = event.request_body.get("messages", [])
        for msg in messages:
            if "email" in str(msg.get("content", "")):
                msg["content"] = "[REDACTED]"

    return event

costkey.init(
    dsn="http://ck_key@localhost:4100/proj_id",
    before_send=my_hook,
)
```

## Upgrading from 0.6

0.7.0 makes the SDK telemetry-only. It needs CostKey server 0.7.0 or later;
the server keeps accepting events from 0.6 SDKs.

- `costkey.score()` is removed. Use [quality checks](/quality-checks), which
  run on the server.
- `costkey.register_pricing()` and `costkey.pricing` are removed. Pricing is
  done on the server; set custom rates in **Settings, Prices & credits**.
- `costkey.register_extractor()`, the provider extractor classes,
  `NormalizedUsage` and `StreamTiming` are removed. Custom providers are
  [server configuration](/providers#custom-providers).
- Call events no longer carry SDK-computed `model`, `usage`, `costUsd`,
  `streamTiming`, `requestModel`, `providerRequestId`, `chargeId`,
  `systemPrompt` or `metadata`. They carry `telemetry` instead.
- Call events are now also sent when the provider call raises
  (`telemetry.error` is set and `response` is null).
- `record_usage` no longer dedupes, fences revisions, rejects negative or
  non-numeric units, or fills in `chargeId`, `currency`, `amountKind`,
  `unitKind` or `costUsd`.
- `record_livekit_usage` sends one raw event per snapshot instead of
  per-component usage events.
- Stack frames are sent unfiltered. The call graph upload sends raw functions,
  callees and call expressions instead of scores.
- Span and lifecycle errors send the raw exception class name (`errorName`,
  plus `errorType`). `CancelledError` is no longer mapped to `cancelled` in
  the SDK; the server does that.
- Admission (`/admit`) receives the request skeleton as `request` instead of
  `model` and `usageBounds`. Settlement always reports `outcome: "unknown"`
  with the call's `eventId`.
- Framework integration span attributes move under `attributes.<framework>`.
- `httpx2` is now patched, so openai 3.x, anthropic 1.x and mistralai 3.x
  clients are captured.
