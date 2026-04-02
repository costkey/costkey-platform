---
sidebar_position: 2
title: Python SDK
description: Full API reference for the CostKey Python SDK.
---

# Python SDK

The CostKey Python SDK auto-instruments `httpx` and `requests` to capture every AI API call. No wrappers, no decorators.

```bash
pip install costkey
```

**Current version:** 0.3.0

## How it works

When you call `costkey.init()`, the SDK monkey-patches `httpx.Client.send`, `httpx.AsyncClient.send`, and `requests.Session.send`. On every HTTP call, it checks the URL hostname against a list of known AI providers. Non-AI calls pass through untouched. AI calls are intercepted to capture:

- Request/response bodies (for token extraction)
- Stack trace (for call site attribution)
- Timing (latency, TTFT for streams, tokens/sec)

The SDK never modifies your request or response. It reads from cloned data and sends events to CostKey asynchronously in the background.

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
- CostKey never modifies requests or responses — it only reads
- CostKey never throws — it can't break your APM's error handling
- Stack traces may be slightly deeper (extra frames from each wrapper — CostKey filters these automatically)
- Streaming responses flow through both tools with minimal overhead

## API Reference

### `costkey.init()`

Initialize the SDK. Call once at app startup, before any AI calls.

```python
import costkey

costkey.init(
    dsn="https://ck_your_key@app.costkey.dev/your_project_id",
    capture_body=True,
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
| `dsn` | `str` | **required** | DSN from the dashboard. Format: `https://<key>@app.costkey.dev/<project-id>` |
| `capture_body` | `bool` | `True` | Capture request/response bodies. Disable to reduce payload size. |
| `before_send` | `Callable` | `None` | Hook called before each event is sent. Return `None` to drop the event. |
| `max_batch_size` | `int` | `50` | Maximum events to buffer before flushing. |
| `flush_interval` | `float` | `5.0` | Seconds between automatic flushes. |
| `debug` | `bool` | `False` | Enable debug logging to the `costkey` logger. |
| `default_context` | `dict` | `{}` | Default context applied to every event. |
| `release` | `str` | `None` | Release version string. Used for sourcemap translation on the server. |

### `costkey.with_context()`

Context manager that tags all AI calls within its scope with custom metadata.

```python
with costkey.with_context(task="summarize", team="search"):
    # All AI calls in here get task="summarize", team="search"
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

Context manager that groups all AI calls within its scope into a single trace.

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

The SDK wraps `iter_bytes()`, `iter_lines()`, `iter_text()`, `iter_raw()`, `read()`, and their async variants (`aiter_bytes()`, `aiter_lines()`, `aread()`). Chunks pass through with zero buffering delay.

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

# CostKey captures TTFT, tokens/sec, total duration, and token usage
# from the final SSE message automatically
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
