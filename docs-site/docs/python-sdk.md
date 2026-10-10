---
sidebar_position: 2
title: Python SDK
description: Full API reference for the CostKey Python SDK.
---

# Python SDK

The CostKey Python SDK instruments `httpx` and `requests` in-process for
supported provider hostnames. No provider-routing gateway is required. The
exact transport and response-shape coverage is listed in the [developer
capability matrix](/recipes#capability-matrix).

```bash
pipx run costkey setup
```

**Current version:** 0.6.0

`pipx run costkey setup` logs you in, creates a CostKey project, writes `COSTKEY_DSN`, detects FastAPI, Django, Flask, and plain Python apps, and writes `.costkey/setup.md`.

For no-code Python bootstrapping, setup writes `.costkey/sitecustomize.py`. Put that directory on `PYTHONPATH` when starting your app:

```bash
PYTHONPATH="$PWD/.costkey:$PYTHONPATH" uvicorn app:app
```

## How it works

When you call `costkey.init()`, the SDK monkey-patches `httpx.Client.send`, `httpx.AsyncClient.send`, and `requests.Session.send`. For each HTTP call, it checks the URL hostname against a list of known AI providers. Non-AI calls pass through untouched. Matched supported calls are observed for:

- Provider/model and response usage (when the endpoint exposes a recognized shape)
- Stack trace (for call site attribution)
- Timing (latency, TTFT for streams, tokens/sec)

The SDK passes requests and responses through while reading bounded copies for
usage extraction. Delivery is queued/best-effort, but capture and flush work
still have application cost; profile your own runtime rather than assuming
the work is free.

Request/response bodies are conditional. The SDK starts metadata-only until the
DSN-authenticated project configuration is known. The server project setting
remains authoritative: text is delivered only when text capture is explicitly
enabled, the SDK leaves body capture enabled, and the endpoint/response shape
supports it. Use `capture_body=False` to opt out locally; remote
metadata-only or a revoked/unavailable config keeps bodies off. Configuration
is fetched asynchronously so ordinary provider calls do not wait for it.

## Call graph analysis

When `costkey.init()` is called, the Python SDK scans your project's `.py` files in a background thread to build a call graph. It does not block application startup, but the scan and serialization still consume application resources, so profile your own runtime.

The call graph identifies which functions in your code are business logic vs. thin wrappers or utility functions. This graph is sent to the CostKey server, which uses it for intelligent frame attribution — so when a stack trace is captured, the dashboard highlights the meaningful function that triggered the AI call, not an intermediate helper.

**How it works:**

1. At `init()`, a background thread walks your project directory and parses `.py` files using the AST module
2. It builds a map of function definitions and their call relationships
3. The graph is sent to the server alongside your events
4. The server uses the graph to pick the most relevant frame from each stack trace

**Configuration:**

```python
# Default: scan is enabled, project root is auto-detected
costkey.init(dsn="https://ck_key@app.costkey.dev/proj_id")

# Disable call graph scanning
costkey.init(dsn="https://ck_key@app.costkey.dev/proj_id", scan_callgraph=False)

# Specify the project root explicitly
costkey.init(dsn="https://ck_key@app.costkey.dev/proj_id", project_root="/app/src")
```

The scan only reads `.py` files to extract function/method names and call relationships. It does not execute any code, and no source code content is sent to the server — only the structural call graph.

## Using with Sentry, New Relic, or other APM tools

CostKey coexists with other tools that patch HTTP clients (Sentry, New Relic, Datadog). Each tool wraps the previous one — calls flow through all layers.

**Initialize CostKey after your APM tool:**

```python
import sentry_sdk
sentry_sdk.init(dsn="...")  # Sentry patches httpx first

import costkey
costkey.init(dsn="...")      # CostKey wraps Sentry's patch
```

This way CostKey sees the raw call and Sentry captures error context. The order matters because the last patcher wraps the others.

**What to know:**
- The Python capture path does not rewrite provider requests or responses; it
  reads bounded data for observation
- CostKey's capture path catches its own processing failures; provider errors
  still belong to the provider client and remain application-visible
- Stack traces may be slightly deeper (extra frames from each wrapper — CostKey filters these automatically)
- Streaming responses flow through both tools while CostKey observes the
  stream; measure the overhead in your runtime

## API Reference

### `costkey.init()`

Initialize the SDK. Call once at app startup, before any AI calls.

```python
import costkey

costkey.init(
    dsn="https://ck_your_key@app.costkey.dev/your_project_id",
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
| `dsn` | `str \| None` | `COSTKEY_DSN` | DSN from the dashboard. Format: `https://<key>@app.costkey.dev/<project-id>`; omitting both values leaves the SDK in no-op/test mode. |
| `capture_body` | `bool \| None` | `None` | Local body-capture preference. Metadata-only remains active until remote project text capture is known; `False` is always strongest. |
| `before_send` | `Callable` | `None` | Hook called before each event is sent. Return `None` to drop the event. |
| `max_batch_size` | `int` | `50` | Maximum events to buffer before flushing. |
| `flush_interval` | `float` | `5.0` | Seconds between automatic flushes. |
| `debug` | `bool` | `False` | Enable debug logging to the `costkey` logger. |
| `default_context` | `dict` | `{}` | Default context applied to every event. |
| `release` | `str` | `None` | Release version string. Used for cost-per-deploy tracking and sourcemap translation. |
| `scan_callgraph` | `bool` | `True` | Scan your project's `.py` files at init to build a call graph for intelligent attribution. |
| `project_root` | `str` | `None` | Root directory to scan for call graph analysis. Auto-detected from your main module if not set. |
| `before_send_event` | `Callable` | `None` | Hook for lifecycle and explicit-usage events; return `None` to drop one. |
| `config_refresh_interval` | `float \| None` | `60.0` | Seconds between DSN project capture/provider config refreshes; `None` disables refresh after the initial asynchronous fetch. |

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

Context manager that groups observed provider calls within its scope into a single trace.

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
[Agents and tools](/agents) for the OpenAI Agents SDK and browser-use
integrations and for resuming a paused run.

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

The workspace source also exposes grouped execution, explicit usage, and an
allowlisted context carrier. Check the installed package version and the
[recipes release note](/recipes#status-at-a-glance) before using these helpers
in an application.

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
    charge_id="voice:tts:session-42",
    revision=1,
    aggregation="cumulative",
    provider="speech-provider",
    model="speech-model",
    usage={"audioSeconds": 2.1, "characters": 320},
    context=costkey.export_context(),
)
```

Attach `costkey.export_context()` only to a trusted service/queue request and
pass the decoded mapping to `costkey.with_context(...)` at the destination.
`record_usage` requires a caller-supplied event ID (the canonical explicit
envelope identity) and monotonic revision. A
`cumulative` snapshot is the full component value: the latest accepted revision
supersedes an earlier one, while a duplicate revision is idempotent rather than
added again. A missing amount or pricing identity remains unknown.
`start_execution` emits lifecycle records and keeps a stable group name
separate from its fresh execution ID. Supply `expected_items`,
`completed_items`, and `failed_items` from the runner when those counts are
known; the SDK carries the same values on the started and terminal lifecycle
records.

### `costkey.livekit.record_livekit_usage()`

The source SDK includes an explicit adapter for LiveKit's cumulative
`ev.usage.model_usage` callback. It records one component per provider/model,
preserves native units, and does not intercept LiveKit WebRTC/audio traffic.
Verify the installed package exports the adapter before using it:

```python
from costkey.livekit import record_livekit_usage

@session.on("session_usage_updated")
def on_usage(ev):
    record_livekit_usage(
        ev,
        session_id=session_id,
        revision=next_snapshot_revision(),
        execution_id=execution_id,
        expected_components=("stt", "llm", "tts"),
    )
```

LiveKit's Python durations are seconds. Supply an amount only when the
application has an explicit provider-reported amount or pricing identity;
otherwise the component remains unknown-priced.

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

### `costkey.register_extractor()`

Register a custom provider extractor for AI providers not in the built-in list.

```python
from costkey.types import Provider, NormalizedUsage

class MyProviderExtractor:
    provider = Provider.UNKNOWN

    def match(self, url: str) -> bool:
        from urllib.parse import urlparse
        return urlparse(url).hostname == "api.myprovider.com"

    def extract_usage(self, body: dict) -> NormalizedUsage | None:
        usage = body.get("usage")
        if not usage:
            return None
        return NormalizedUsage(
            input_tokens=usage.get("input_tokens"),
            output_tokens=usage.get("output_tokens"),
            total_tokens=usage.get("total_tokens"),
        )

    def extract_model(self, request_body, response_body) -> str | None:
        if isinstance(response_body, dict):
            return response_body.get("model")
        if isinstance(request_body, dict):
            return request_body.get("model")
        return None

costkey.register_extractor(MyProviderExtractor())
```

### `costkey.register_pricing()`

Register custom model pricing for models not in the built-in pricing table.

```python
costkey.register_pricing(
    model="my-custom-model",
    input_per_1m=1.50,    # $ per 1M input tokens
    output_per_1m=5.00,   # $ per 1M output tokens
)
```

## Streaming support

CostKey automatically detects streaming responses (`stream=True`) and captures streaming-specific metrics:

- **TTFT** (Time to First Token) — latency before the first chunk arrives
- **Tokens/sec** — output token throughput
- **Stream duration** — total time from request to last chunk
- **Chunk count** — number of SSE chunks received

The SDK wraps `iter_bytes()`, `iter_lines()`, `iter_text()`, `iter_raw()`,
`read()`, and their async variants (`aiter_bytes()`, `aiter_lines()`,
`aread()`) for HTTPX streams. Chunks are yielded as they are read while the
adapter observes timing; profile this work in the runtime where you deploy.

### Streaming with Anthropic

```python
import costkey
from anthropic import Anthropic

costkey.init(dsn="https://ck_key@app.costkey.dev/proj_id")

client = Anthropic()

with client.messages.stream(
    model="claude-sonnet-4-5-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Write a haiku about Python"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)

# CostKey captures timing and usage when the provider emits a supported final
# SSE usage message; body/content capture still follows project settings.
```

### Streaming with OpenAI

```python
import costkey
import openai

costkey.init(dsn="https://ck_key@app.costkey.dev/proj_id")

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

costkey.init(dsn="https://ck_key@app.costkey.dev/proj_id")

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

costkey.init(dsn="https://ck_key@app.costkey.dev/proj_id")

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
import google.generativeai as genai

costkey.init(dsn="https://ck_key@app.costkey.dev/proj_id")

model = genai.GenerativeModel("gemini-2.0-flash")
response = model.generate_content("What is the capital of France?")
print(response.text)
```

## FastAPI integration

```python
from fastapi import FastAPI, Request
import costkey

app = FastAPI()
costkey.init(dsn="https://ck_key@app.costkey.dev/proj_id")

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

The `before_send` hook lets you modify or drop events before they're sent.

```python
from costkey.types import CostKeyEvent

def my_hook(event: CostKeyEvent) -> CostKeyEvent | None:
    # Drop events from a specific model
    if event.model and "test" in event.model:
        return None

    # Scrub PII from request bodies
    if event.request_body and isinstance(event.request_body, dict):
        messages = event.request_body.get("messages", [])
        for msg in messages:
            if "email" in str(msg.get("content", "")):
                msg["content"] = "[REDACTED]"

    # Add custom metadata
    event.context["environment"] = "production"

    return event

costkey.init(
    dsn="https://ck_key@app.costkey.dev/proj_id",
    before_send=my_hook,
)
```
